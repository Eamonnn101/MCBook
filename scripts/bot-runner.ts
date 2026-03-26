/**
 * Bot Runner - 单 Bot 分布式认知循环
 *
 * 每个终端运行一个 Bot Runner，连接到 Coordinator 获取共享状态。
 * 内嵌 LLM 调用逻辑（从 heartbeat-client 合并），不需要额外进程。
 *
 * 用法:
 *   npx tsx scripts/bot-runner.ts --name Bot_1 --agent survivor \
 *     [--mc-name MCBook_Bot_1] [--coordinator ws://localhost:3849] \
 *     [--mc-host localhost] [--mc-port 25565]
 */
import { readFile, readdir, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { processPendingDeathIfAny } from '../src/mcp/deathReflection.js';
import { MemoryStream } from '../src/cognitive/memoryStream.js';
import { PlanExecutor } from '../src/cognitive/planExecutor.js';
import type { ObservationCategory } from '../src/cognitive/memoryStream.js';
import { writeDebug } from '../src/observer/logWriter.js';
import { CoordinatorClient } from '../src/multi/coordinatorClient.js';
import type { AgentEvent } from '../src/multi/eventBus.js';
import { getSocialMemory } from '../src/social/socialMemory.js';
import { skillLibrary } from '../src/skills/skillLibrary.js';
import { findRelevantSkills } from '../src/skills/skillRetrieval.js';
import { maybeGenerateSkill, tryPromoteSkills } from '../src/skills/skillGenerator.js';
import { executeSkill } from '../src/skills/skillExecutor.js';
import { evaluate as criticEvaluate, summarizeForPrompt as criticSummary, type WorldSnapshot } from '../src/cognitive/critic.js';
import { tryMatchHabit, executeHabit } from '../src/cognitive/habitTier.js';
import { loadProfile, traitPromptModifier } from '../src/agents/personalityProfile.js';
import { buildWorldState, compressForPrompt, type BotStatusData } from '../src/cognitive/worldState.js';

// ─── CLI 参数解析 ───

function getArg(name: string, defaultValue: string): string {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return defaultValue;
}

const botName = getArg('--name', 'Bot_1');
const agentType = getArg('--agent', 'survivor');
const mcBotName = getArg('--mc-name', `MCBook_${botName}`);
const coordinatorUrl = getArg('--coordinator', 'ws://localhost:3849');
const mcHost = getArg('--mc-host', process.env.MC_BOT_HOST ?? 'localhost');
const mcPort = getArg('--mc-port', process.env.MC_BOT_PORT ?? '25565');
const mcVersion = process.env.MC_BOT_VERSION ?? undefined;

// ─── Config ───
const CONFIG_PATH = join(process.cwd(), 'config', 'game-master.json');

interface GameMasterConfig {
  memoryDir?: string;
  cognitiveCycleMs?: number;
  observeIntervalMs?: number;
  urgentHealthThreshold?: number;
}

async function loadConfig(): Promise<GameMasterConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as GameMasterConfig;
}

function getMemoryDir(config: GameMasterConfig): string {
  const base = config.memoryDir
    ? join(process.cwd(), config.memoryDir)
    : join(process.env.OPENCLAW_WORKSPACE || process.cwd(), 'memory');
  return process.env.MCBOOK_MEMORY_DIR || base;
}

// ─── MCP Client ───

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let mcpLastDisconnect = 0;
let mcpFailCount = 0;
const MCP_RECONNECT_COOLDOWN_MS = 15000;

function getMcpServerConfig(): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  // Check mcporter config first
  const workspace = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');
  const mcporterPath = join(workspace, 'config', 'mcporter.json');
  if (existsSync(mcporterPath)) {
    try {
      const raw = readFileSync(mcporterPath, 'utf-8');
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }> };
      const srv = cfg.mcpServers?.['minecraft-mcp'];
      if (srv) {
        const env: Record<string, string> = {
          ...srv.env,
          MC_BOT_USERNAME: mcBotName,
          MC_BOT_HOST: mcHost,
          MC_BOT_PORT: mcPort,
        };
        if (mcVersion) env.MC_BOT_VERSION = mcVersion;
        return { command: srv.command, args: srv.args ?? [], env, cwd: srv.cwd ?? process.cwd() };
      }
    } catch { /* fallback */ }
  }
  const serverPath = join(process.cwd(), 'src', 'mcp', 'server.ts');
  const env: Record<string, string> = {
    MC_BOT_HOST: mcHost,
    MC_BOT_PORT: mcPort,
    MC_BOT_USERNAME: mcBotName,
  };
  if (mcVersion) env.MC_BOT_VERSION = mcVersion;
  return { command: 'npx', args: ['tsx', serverPath], env, cwd: process.cwd() };
}

async function getOrCreateMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  const cooldown = MCP_RECONNECT_COOLDOWN_MS * Math.min(Math.pow(2, mcpFailCount), 8);
  const elapsed = Date.now() - mcpLastDisconnect;
  if (mcpLastDisconnect > 0 && elapsed < cooldown) {
    const waitSec = Math.round((cooldown - elapsed) / 1000);
    throw new Error(`MCP 重连冷却中，${waitSec}s 后重试`);
  }

  const cfg = getMcpServerConfig();
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
  });
  const client = new Client({ name: 'bot-runner', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    mcpLastDisconnect = Date.now();
    mcpFailCount++;
    throw err;
  }
  mcpClient = client;
  mcpTransport = transport;
  mcpFailCount = 0;
  console.log(`[BotRunner] MCP 连接已建立: ${mcBotName}`);
  return client;
}

function extractToolText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const c = result.content?.find((x) => x.type === 'text');
  return (c && 'text' in c ? c.text : '') ?? '';
}

// ─── 状态查询 ───

interface BotStatus {
  isBusy?: boolean;
  currentAction?: string;
  health?: number;
  food?: number;
  position?: { x: number; y: number; z: number };
  inventory?: string;
  timeOfDay?: number;
  isDay?: boolean;
}

async function getStatus(client: Client): Promise<BotStatus> {
  const result = await client.callTool({ name: 'get_status', arguments: {} });
  const text = extractToolText(result);
  try { return JSON.parse(text) as BotStatus; } catch { return {}; }
}

async function getEvents(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'get_pending_events', arguments: {} });
  return extractToolText(result);
}

async function getScan(client: Client, radius = 32): Promise<string> {
  const result = await client.callTool({ name: 'get_scan', arguments: { radius, include_blocks: true } });
  return extractToolText(result);
}

async function readMemoryFile(memoryDir: string): Promise<string> {
  const path = join(memoryDir, `${mcBotName}_memory.txt`);
  if (!existsSync(path)) return '';
  try { return await readFile(path, 'utf-8'); } catch { return ''; }
}

// ─── 认知状态 ───

interface CognitiveState {
  memoryStream: MemoryStream;
  planExecutor: PlanExecutor;
  lastHealth: number;
  lastFood: number;
  lastScan: string;
  lastInventory: string;
  lastPosition: string;
  thinkScheduled: boolean;
  consecutiveIdleObserves: number;
  preExecutionSnapshot: WorldSnapshot | null;
  lastCriticSummary: string;
}

const cogState: CognitiveState = {
  memoryStream: new MemoryStream(),
  planExecutor: new PlanExecutor(),
  lastHealth: 20,
  lastFood: 20,
  lastScan: '',
  lastInventory: '',
  lastPosition: '',
  thinkScheduled: false,
  consecutiveIdleObserves: 0,
  preExecutionSnapshot: null,
  lastCriticSummary: '',
};

// ─── LLM 调用（从 heartbeat-client 合并）───

const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL;

async function sendViaOllamaApi(model: string, text: string): Promise<string | null> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: 'You are a Minecraft survival bot. You MUST respond with ONLY a valid JSON object. Format: {"reflection":"...","plan":[{"tool":"mine","args":{"block_type":"oak_log"},"note":"reason"}]}. The only valid tool names are: mine, craft, move_to, equip, attack, eat, chat, place, find_blocks, follow_player, stop_follow, send_chat, query_agent_status, request_trade, accept_trade, reject_trade, form_team, share_skill, set_waypoint. Never output anything except JSON.',
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[BotRunner] Ollama API HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content ?? null;
  } catch (err) {
    console.warn('[BotRunner] Ollama API 错误:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function sendViaHttp(agent: string, text: string): Promise<string> {
  if (!OPENCLAW_API_URL) throw new Error('OPENCLAW_API_URL not set');
  const res = await fetch(OPENCLAW_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, message: text }),
  });
  if (!res.ok) throw new Error(`OpenClaw API HTTP ${res.status}`);
  return await res.text();
}

async function sendViaCli(agent: string, text: string): Promise<string> {
  const workspace = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');
  return new Promise((resolve, reject) => {
    const sessionId = `mc-${Date.now()}`;
    const child = spawn('npx', ['openclaw', 'agent', '--agent', agent, '--session-id', sessionId, '--message', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: workspace,
      env: process.env,
    });
    let stdout = '';
    child.stderr?.on('data', (d) => { process.stderr.write(d); });
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stdin.write(text, 'utf-8', (err) => {
      if (err) return reject(err);
      child.stdin.end();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`openclaw exit ${code}`));
    });
  });
}

async function callLLM(prompt: string): Promise<string> {
  // 1. Try Ollama API
  const ollamaModel = process.env.OLLAMA_MODEL ?? 'minimax-m2.5:cloud';
  const ollamaResult = await sendViaOllamaApi(ollamaModel, prompt);
  if (ollamaResult) {
    const trimmed = ollamaResult.trim();
    let jsonStr = trimmed;
    if (!trimmed.startsWith('{')) {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
    }
    if (jsonStr.startsWith('{')) {
      console.log(`[BotRunner] Ollama 响应 (${jsonStr.length} 字符)`);
      return jsonStr;
    }
    console.warn('[BotRunner] Ollama 返回非 JSON，尝试其他方式...');
  }

  // 2. Try OpenClaw HTTP API
  if (OPENCLAW_API_URL) {
    try { return await sendViaHttp(agentType, prompt); } catch { /* fallback */ }
  }

  // 3. Fallback to OpenClaw CLI
  return await sendViaCli(agentType, prompt);
}

// ─── 事件解析 ───

function parseAndRecordEvents(
  events: string, status: BotStatus, scanResult: string,
  coordinator: CoordinatorClient,
): void {
  const ms = cogState.memoryStream;

  if (events && events !== '无待处理事件' && events.trim().length > 0) {
    for (const line of events.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        switch (ev.type) {
          case 'death':
            ms.add({ category: 'death', importance: 10, content: '你死亡了' });
            break;
          case 'entityHurt':
            ms.add({ category: 'combat', importance: 9, content: `受到伤害，当前血量 ${ev.health}` });
            break;
          case 'health':
            ms.add({ category: 'health_change', importance: ev.health < 8 ? 8 : 3, content: `血量 ${ev.health}/20 饥饿 ${ev.food}/20` });
            break;
          case 'chat':
            ms.add({ category: 'chat', importance: 7, content: `[${ev.username}] ${ev.message}` });
            // Publish to coordinator event bus if from known agent
            coordinator.publish({
              type: 'agent:chat',
              from: ev.username,
              target: null,
              message: ev.message,
              ts: Date.now(),
            }).catch(() => {});
            break;
          case 'time':
            ms.add({ category: 'environment', importance: 2, content: ev.isDay ? '天亮了' : '天黑了' });
            break;
          case 'spawn':
            ms.add({ category: 'spawn', importance: 6, content: '已重生' });
            break;
          default:
            ms.add({ category: 'environment', importance: 3, content: trimmed });
        }
      } catch {
        ms.add({ category: 'environment', importance: 2, content: trimmed });
      }
    }
  }

  // 状态变化检测
  const healthChanged = status.health !== cogState.lastHealth || status.food !== cogState.lastFood;
  const scanChanged = scanResult !== cogState.lastScan;
  const invStr = status.inventory ?? '';
  const invChanged = invStr !== cogState.lastInventory;
  const posStr = status.position ? `${status.position.x},${status.position.y},${status.position.z}` : '';
  const posChanged = posStr !== cogState.lastPosition;

  if (healthChanged && status.health !== undefined && status.health < cogState.lastHealth) {
    ms.add({ category: 'combat', importance: 9, content: `受伤: 血量 ${cogState.lastHealth} → ${status.health}` });
  }

  if (scanChanged && scanResult.includes('敌对生物') && !cogState.lastScan.includes('敌对生物')) {
    ms.add({ category: 'combat', importance: 7, content: '发现敌对生物' });
  }

  if (scanChanged && !scanResult.includes('敌对生物')) {
    cogState.consecutiveIdleObserves = 0;
  }

  cogState.lastHealth = status.health ?? 20;
  cogState.lastFood = status.food ?? 20;
  cogState.lastScan = scanResult;
  cogState.lastInventory = invStr;
  cogState.lastPosition = posStr;

  if (!healthChanged && !scanChanged && !invChanged && !posChanged && events === '无待处理事件') {
    cogState.consecutiveIdleObserves++;
  } else {
    cogState.consecutiveIdleObserves = 0;
  }
}

// ─── Urgent interrupt ───

let urgentHealthThreshold = 6;

function needsUrgentInterrupt(status: BotStatus): { urgent: boolean; reason: string } {
  const recentObs = cogState.memoryStream.getSinceLastThink();

  if (recentObs.some(o => o.category === 'death')) {
    return { urgent: true, reason: '死亡重生' };
  }
  if (status.health !== undefined && status.health < urgentHealthThreshold) {
    return { urgent: true, reason: `低血量(${status.health})` };
  }
  const recentCombat = recentObs.filter(o => o.category === 'combat');
  if (recentCombat.length > 0) {
    return { urgent: true, reason: `受到攻击(${recentCombat[recentCombat.length - 1].content})` };
  }
  if (recentObs.some(o => o.category === 'chat')) {
    return { urgent: true, reason: '收到聊天消息' };
  }
  return { urgent: false, reason: '' };
}

// ─── System 0 Reflex ───

const WEAPON_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
  'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe',
];

async function executeReflex(client: Client, status: BotStatus, reason: string): Promise<string | null> {
  if (!reason.includes('受到攻击') && !reason.includes('受到伤害')) return null;
  const inv = status.inventory ?? '';
  writeDebug('REFLEX', `${botName} ⚡反射: ${reason}`);
  console.log(`[BotRunner] ${botName} ⚡System 0 反射: ${reason}`);

  let equippedWeapon = '空手';
  for (const weapon of WEAPON_PRIORITY) {
    if (inv.includes(weapon)) {
      try {
        await client.callTool({ name: 'equip', arguments: { item_name: weapon } });
        equippedWeapon = weapon;
      } catch { /* ignore */ }
      break;
    }
  }

  let attacker: string | null = null;
  try {
    const scanResult = await client.callTool({ name: 'get_scan', arguments: { radius: 16, include_blocks: false } });
    const scanText = extractToolText(scanResult);
    const mobMatch = scanText.match(/发现敌对生物「([^」]+)」/);
    if (mobMatch) attacker = mobMatch[1];
    if (!attacker) {
      const playerMatch = scanText.match(/发现玩家「([^」]+)」/);
      if (playerMatch) attacker = playerMatch[1];
    }
  } catch { /* ignore */ }

  cogState.memoryStream.add({
    category: 'action_result',
    importance: 5,
    content: `⚡反射: 已装备${equippedWeapon}${attacker ? `，发现攻击者「${attacker}」` : '，未发现攻击者'}。等待AI决策`,
  });

  return attacker;
}

// ─── Agent Skills ───

const agentSkillsCache = new Map<string, string>();
let personalityPrompt = '';
let activeGoals: string[] = [];

async function loadAgentSkills(): Promise<string> {
  const cached = agentSkillsCache.get(agentType);
  if (cached !== undefined) return cached;

  const skillsDir = join(process.cwd(), 'agents', agentType, 'skills');
  try {
    const files = await readdir(skillsDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();
    const parts: string[] = [];
    for (const file of mdFiles) {
      const content = await readFile(join(skillsDir, file), 'utf-8');
      parts.push(content);
    }
    const result = parts.join('\n\n---\n\n');
    agentSkillsCache.set(agentType, result);
    return result;
  } catch {
    agentSkillsCache.set(agentType, '');
    return '';
  }
}

// ─── Prompt 构建 ───

function getBuildMaterialNote(inv: string): string {
  const logMatch = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_log x(\d+)/);
  const logCount = logMatch ? parseInt(logMatch[1]) : 0;
  const planksMatch = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_planks x(\d+)/);
  const planksCount = planksMatch ? parseInt(planksMatch[1]) : 0;
  const dirtMatch = inv.match(/dirt x(\d+)/);
  const dirtCount = dirtMatch ? parseInt(dirtMatch[1]) : 0;
  const cobbleMatch = inv.match(/cobblestone x(\d+)/);
  const cobbleCount = cobbleMatch ? parseInt(cobbleMatch[1]) : 0;
  const total = logCount + planksCount + dirtCount + cobbleCount;
  if (total < 10) return '';
  const parts = [
    logCount > 0 ? `${logCount}原木` : '',
    planksCount > 0 ? `${planksCount}木板` : '',
    dirtCount > 0 ? `${dirtCount}泥土` : '',
    cobbleCount > 0 ? `${cobbleCount}圆石` : '',
  ].filter(Boolean).join(' ');
  return `\n!! 你有${total}个建材(${parts}) — 停止采集，用 place 建房子 !!`;
}

function buildFastPrompt(status: BotStatus, scanResult: string, urgentReason: string): string {
  const health = status.health ?? 20;
  const food = status.food ?? 20;
  const pos = status.position ? `(${status.position.x},${status.position.y},${status.position.z})` : '?';
  const inv = status.inventory ?? '空';

  const recentObs = cogState.memoryStream.getSinceLastThink();
  const recentUrgent = recentObs.filter(o => o.importance >= 5 && o.category !== 'chat').slice(-5).map(o => o.content).join('; ');
  const recentChat = recentObs.filter(o => o.category === 'chat').slice(-5).map(o => o.content).join('; ');

  let prompt = `!! 快速反应 !! 原因: ${urgentReason}
HP:${health}/20 饥饿:${food}/20 坐标:${pos} ${status.isDay ? '白天' : '夜晚'}
背包: ${inv}
事件: ${recentUrgent || '无'}`;

  if (recentChat) prompt += `\n聊天: ${recentChat}`;
  prompt += `\n视野: ${scanResult || '无'}`;

  const isCombat = urgentReason.includes('受到攻击') || urgentReason.includes('受到伤害');
  let combatGuide = '';
  if (isCombat) {
    const hasWeapon = inv.match(/(netherite|diamond|iron|stone|wooden)_sword/);
    const hasFood = inv.match(/(cooked_|bread|apple|stew|golden_apple)/);
    const isLowHp = health <= 8;
    const isCriticalHp = health <= 4;
    combatGuide = `
!! 你正在被攻击！已自动装备武器，请决定策略 !!
【策略A：反击】→ attack 攻击者
【策略B：逃跑】→ move_to 远离敌人方向
【策略C：求饶/外交】→ chat 发消息 → move_to 后退
当前态势：${isCriticalHp ? '!! 危急 !! 血量' + health : isLowHp ? '血量较低(' + health + ')' : '血量充足(' + health + ')'}
${hasWeapon ? '有武器可战斗' : '!! 没有武器 !! 建议逃跑'}
${hasFood ? '有食物可回血' : '没有食物'}`;
  }

  prompt += `\n${personalityPrompt ? `\n${personalityPrompt}\n` : ''}
你是 Minecraft Bot，有自己的性格和判断力。只输出 JSON。
工具: move_to({x,y,z}), mine({block_type}), attack({target_name}), eat({}), equip({item_name}), chat({message}), craft({item_name,count}), place({block_name,x,y,z}), find_blocks({block_type}), follow_player({player_name,duration?}), stop_follow({})
{"reflection":"一句话判断","plan":[{"tool":"..","args":{..},"note":".."}]}
规则: 最多3步。${combatGuide}`;

  return prompt;
}

function buildSlowPrompt(
  status: BotStatus, scanResult: string, memory: string,
  skills: string, socialContext: string,
): string {
  const timeStr = status.isDay ? '白天' : '夜晚';
  const health = status.health ?? 20;
  const food = status.food ?? 20;
  const pos = status.position ? `(${status.position.x}, ${status.position.y}, ${status.position.z})` : '(?, ?, ?)';
  const hungerNote = food < 8 ? '（你很饿！）' : food < 14 ? '（建议补充食物）' : '';
  const inv = status.inventory ?? '空';
  const buildNote = getBuildMaterialNote(inv);
  const observations = cogState.memoryStream.summarizeForPrompt();
  const planSummary = cogState.planExecutor.getExecutionSummary();
  const skillsSection = skills ? `\n\n【Survival Skills Reference】\n${skills}` : '';

  const hasAxe = inv.match(/(netherite|diamond|iron|stone|wooden)_axe/);
  const hasPickaxe = inv.match(/(netherite|diamond|iron|stone|wooden)_pickaxe/);
  const hasSword = inv.match(/(netherite|diamond|iron|stone|wooden)_sword/);
  const hasLogs = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_log/);
  const hasPlanks = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_planks/);

  let toolAdvice = '';
  if (!hasAxe && !hasPickaxe && !hasSword) {
    if (hasPlanks || hasLogs) {
      toolAdvice = `\n!! 你没有任何工具！立即 craft 工具 !!`;
    } else {
      toolAdvice = `\n!! 你没有工具也没有木头！最优先砍树(mine oak_log)获取木头 !!`;
    }
  }

  const dayPriorities = `**白天优先级**：
1. 应对威胁
2. !! 制作工具 !! — 有木头就先做工具${toolAdvice}
3. !! 收集资源 !!
4. !! 建造庇护所 !!
5. 补充食物
6. 升级工具/采矿`;

  const nightPriorities = `**夜晚优先级**：
1. !! 生存第一 !!
2. 有庇护所 → 待在室内
3. 有床 → 睡觉跳过夜晚
4. 没庇护所 → 就地围建3x3x3密封空间
5. 装备武器准备战斗`;

  const priorities = status.isDay ? dayPriorities : nightPriorities;

  return `【慢思考 - 深度规划】
${personalityPrompt ? `\n${personalityPrompt}\n` : ''}
【生存准则】${memory || '（暂无）'}${skillsSection}

【当前状态】
  ${timeStr} | 血量 ${health}/20 | 饥饿 ${food}/20${hungerNote} | 坐标 ${pos}
  背包: ${inv}${buildNote}

【观察记录】
${observations}

【上周期执行情况】
${planSummary}
${cogState.lastCriticSummary ? `\n【Critic 评估】\n${cogState.lastCriticSummary}` : ''}

【当前视野】
${scanResult}
${socialContext ? `\n【其他 Agent】\n${socialContext}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你是 Minecraft 生存 Bot，每分钟思考一次。当前是【${timeStr}】。
!! 只输出纯 JSON !!

━━ 可用工具（17个）━━
move_to({x,y,z}) mine({block_type}) craft({item_name,count}) chat({message})
equip({item_name}) attack({target_name}) eat({food_name}) find_blocks({block_type,count})
place({block_name,x,y,z}) follow_player({player_name,duration?,distance?}) stop_follow({})
━━ 社交工具 ━━
send_chat({target?,message}) query_agent_status({agent_name}) request_trade({target,offer_items,want_items})
accept_trade({trade_id}) reject_trade({trade_id}) form_team({team_name,members[]})
share_skill({skill_name,target}) set_waypoint({name,x,y,z})

━━ 输出格式 ━━
{"reflection":"1-2句话","plan":[{"tool":"..","args":{..},"note":".."},..]}

${priorities}
- 计划 5-8 步
- 只输出 JSON`;
}

// ─── Social Tool Executor (via Coordinator) ───

function createSocialToolExecutor(coordinator: CoordinatorClient) {
  return async (tool: string, args: Record<string, unknown>): Promise<string> => {
    switch (tool) {
      case 'send_chat': {
        const target = args.target as string | undefined;
        const message = args.message as string;
        await coordinator.publish({
          type: 'agent:chat',
          from: botName,
          target: target ?? null,
          message,
          ts: Date.now(),
        });
        return target ? `已向 ${target} 发送消息: "${message}"` : `已广播消息: "${message}"`;
      }

      case 'query_agent_status': {
        const profile = await coordinator.getPublicProfile(args.agent_name as string);
        if (!profile) return `未找到 Agent: ${args.agent_name}`;
        return JSON.stringify(profile);
      }

      case 'request_trade': {
        const targetAgent = await coordinator.get(args.target as string);
        if (!targetAgent) return `未找到 Agent: ${args.target}`;
        const proposal = await coordinator.createTradeProposal(
          botName, args.target as string,
          args.offer_items as Array<{ name: string; count: number }>,
          args.want_items as Array<{ name: string; count: number }>,
        );
        return `交易提案已发送给 ${args.target} (ID: ${proposal.id})`;
      }

      case 'accept_trade': {
        const trade = await coordinator.acceptTrade(args.trade_id as string, botName);
        if (!trade) return `无法接受交易 ${args.trade_id}`;
        return `已接受交易 ${args.trade_id}`;
      }

      case 'reject_trade': {
        const ok = await coordinator.rejectTrade(args.trade_id as string, botName);
        return ok ? `已拒绝交易 ${args.trade_id}` : `无法拒绝交易 ${args.trade_id}`;
      }

      case 'get_pending_trades': {
        const trades = await coordinator.getPendingTradesFor(botName);
        if (trades.length === 0) return '无待处理交易';
        return trades.map(t =>
          `[${t.id}] ${t.from}发起: 给出${t.offerItems.map(i => `${i.name}x${i.count}`).join(',')} 换取${t.wantItems.map(i => `${i.name}x${i.count}`).join(',')}`
        ).join('\n');
      }

      case 'form_team': {
        const members = args.members as string[] ?? [];
        await coordinator.formTeam(args.team_name as string, [botName, ...members], botName);
        return `团队 "${args.team_name}" 已创建，成员: ${[botName, ...members].join(', ')}`;
      }

      case 'leave_team': {
        const ok = await coordinator.leaveTeam(args.team_name as string, botName);
        return ok ? `已离开团队 "${args.team_name}"` : `未找到团队 "${args.team_name}"`;
      }

      case 'set_waypoint': {
        await coordinator.setWaypoint(args.name as string, { x: args.x as number, y: args.y as number, z: args.z as number }, botName);
        return `路标 "${args.name}" 已设置: (${args.x}, ${args.y}, ${args.z})`;
      }

      case 'get_waypoints': {
        const wps = await coordinator.getAllWaypoints();
        if (wps.length === 0) return '无共享路标';
        return wps.map(w => `${w.name}: (${w.position.x}, ${w.position.y}, ${w.position.z}) by ${w.createdBy}`).join('\n');
      }

      case 'share_skill': {
        const skillName = args.skill_name as string;
        const target = args.target as string;
        const targetAgent = await coordinator.get(target);
        if (!targetAgent) return `未找到 Agent: ${target}`;
        const meta = await skillLibrary.getMeta(botName, skillName);
        if (!meta) return `你没有名为 "${skillName}" 的技能`;
        const code = await skillLibrary.getCode(botName, skillName);
        if (!code) return `技能 "${skillName}" 的代码不存在`;
        const existing = await skillLibrary.getMeta(target, skillName);
        if (existing) return `${target} 已有名为 "${skillName}" 的技能`;
        const sharedMeta = { ...meta, author: `${meta.author}→${target}`, shared: false };
        await skillLibrary.saveSkill(target, skillName, code, sharedMeta);
        return `已将技能 "${skillName}" 分享给 ${target}`;
      }

      default:
        return `未知社交工具: ${tool}`;
    }
  };
}

// ─── 主循环 ───

async function run(): Promise<void> {
  const config = await loadConfig();
  const observeIntervalMs = config.observeIntervalMs ?? 8000;
  const cognitiveCycleMs = config.cognitiveCycleMs ?? 60000;
  urgentHealthThreshold = config.urgentHealthThreshold ?? 6;
  const memoryDir = getMemoryDir(config);
  process.env.MCBOOK_MEMORY_DIR = memoryDir;

  if (!existsSync(memoryDir)) {
    await mkdir(memoryDir, { recursive: true });
  }

  console.log(`[BotRunner] 启动: ${botName} [${agentType}] → ${mcBotName}`);
  console.log(`[BotRunner] Coordinator: ${coordinatorUrl}`);
  console.log(`[BotRunner] MC Server: ${mcHost}:${mcPort}`);

  // 连接 Coordinator
  const coordinator = new CoordinatorClient(coordinatorUrl);
  await coordinator.connect();
  await coordinator.register(botName, mcBotName, agentType);
  console.log(`[BotRunner] 已注册到 Coordinator`);

  // 加载人格特质
  try {
    const profile = await loadProfile(agentType);
    const traitStr = traitPromptModifier(profile.traits);
    const bgStr = profile.background ? `【背景】${profile.background}` : '';
    const goalsStr = profile.initialGoals.length > 0 ? `【初始目标】${profile.initialGoals.join('；')}` : '';
    const parts = [traitStr, bgStr, goalsStr].filter(Boolean);
    if (parts.length > 0) personalityPrompt = parts.join('\n');
    if (profile.initialGoals.length > 0) activeGoals = [...profile.initialGoals];
    console.log(`[BotRunner] 人格加载: ${traitStr.slice(0, 60)}...`);
  } catch (err) {
    console.warn(`[BotRunner] 人格加载失败:`, err);
  }

  // 加载社交记忆
  const socialMem = getSocialMemory(memoryDir, botName);
  await socialMem.load().catch(() => {});

  // 定期保存社交记忆
  setInterval(() => { socialMem.save().catch(() => {}); }, 60000);

  // 实时事件推送回调
  coordinator.onEvent((event: AgentEvent) => {
    const ms = cogState.memoryStream;
    switch (event.type) {
      case 'agent:chat':
        if (event.from !== botName) {
          ms.add({ category: 'chat', importance: 7, content: `[Agent ${event.from}] ${event.message}` });
        }
        break;
      case 'agent:trade_request':
        ms.add({ category: 'chat', importance: 8, content: `${event.from} 向你发起交易提案(${event.tradeId})` });
        break;
      case 'agent:trade_response':
        ms.add({ category: 'chat', importance: 6, content: `${event.from} ${event.accepted ? '接受' : '拒绝'}了你的交易` });
        break;
      case 'agent:join':
        ms.add({ category: 'environment', importance: 4, content: `Agent ${event.agentName} 上线了` });
        break;
      case 'agent:leave':
        ms.add({ category: 'environment', importance: 3, content: `Agent ${event.agentName} 离线了` });
        break;
      case 'agent:team':
        ms.add({ category: 'chat', importance: 5, content: `团队 "${event.teamName}": ${event.agentName} ${event.action === 'form' ? '创建' : '离开'}了团队` });
        break;
    }
  });

  const socialToolExecutor = createSocialToolExecutor(coordinator);

  // ─── 执行 AI 计划 ───

  async function executePlan(client: Client): Promise<void> {
    const pe = cogState.planExecutor;
    if (!pe.currentStep) return;

    const planStartTime = Date.now();
    try {
      const preStatus = await getStatus(client);
      cogState.preExecutionSnapshot = {
        health: preStatus.health ?? 20,
        food: preStatus.food ?? 20,
        position: preStatus.position ?? null,
        inventory: preStatus.inventory ?? '',
        isDay: preStatus.isDay ?? true,
      };

      const results = await pe.execute(
        client,
        (result) => {
          const icon = result.success ? '+' : 'x';
          cogState.memoryStream.add({
            category: 'action_result',
            importance: result.success ? 2 : 5,
            content: `[${icon}] ${result.step.tool}: ${result.result.slice(0, 100)}`,
          });
          writeDebug('EXEC', `${botName} [${icon}] ${result.step.tool} → ${result.result.slice(0, 150)}`);
          console.log(`[BotRunner] [${icon}] ${result.step.tool}: ${result.result.slice(0, 80)}`);
        },
        () => {
          return cogState.memoryStream.getSinceLastThink()
            .filter(o => o.ts > planStartTime && o.importance >= 8).length > 0;
        },
        socialToolExecutor,
      );

      console.log(`[BotRunner] 计划执行完毕: ${results.length} 步，状态: ${pe.status}`);

      // 技能生成
      if (pe.status === 'completed' && results.length >= 3) {
        maybeGenerateSkill(results.map(r => r.step), results, pe.lastReflection, botName).catch(() => {});
        tryPromoteSkills(botName).catch(() => {});
      }

      // Critic 评估
      if (cogState.preExecutionSnapshot && results.length > 0) {
        try {
          const postStatus = await getStatus(client);
          const postSnapshot: WorldSnapshot = {
            health: postStatus.health ?? 20,
            food: postStatus.food ?? 20,
            position: postStatus.position ?? null,
            inventory: postStatus.inventory ?? '',
            isDay: postStatus.isDay ?? true,
          };
          const evaluation = criticEvaluate(cogState.preExecutionSnapshot, postSnapshot, results, results.map(r => r.step));
          cogState.lastCriticSummary = criticSummary(evaluation);
          cogState.memoryStream.add({ category: 'action_result', importance: 3, content: `反思评估: ${cogState.lastCriticSummary}` });
        } catch { /* ignore */ }
        cogState.preExecutionSnapshot = null;
      }
    } catch (err) {
      console.error(`[BotRunner] 计划执行异常:`, err);
    }
  }

  // ─── 思考阶段 ───

  async function triggerThink(client: Client, isUrgent: boolean, urgentReason: string): Promise<void> {
    const tier = isUrgent ? 'fast' : 'slow';

    // Habit Tier
    if (!isUrgent) {
      try {
        const recentObs = cogState.memoryStream.getSinceLastThink();
        const habitMatch = await tryMatchHabit(botName, recentObs);
        if (habitMatch.matched && habitMatch.skillName) {
          console.log(`[BotRunner] 🔄 Habit: 执行技能 "${habitMatch.skillName}" (跳过 LLM)`);
          const habitResult = await executeHabit(botName, habitMatch.skillName, client);
          cogState.memoryStream.add({
            category: 'action_result', importance: 3,
            content: `[习惯] "${habitMatch.skillName}": ${habitResult.success ? '成功' : '失败'}`,
          });
          cogState.memoryStream.markThinkDone();
          cogState.memoryStream.compact(30);
          cogState.planExecutor.reset();
          return;
        }
      } catch { /* continue to LLM */ }
    }

    // 处理死亡反思
    await processPendingDeathIfAny(mcBotName).catch(() => {});

    // 获取状态
    const status = await getStatus(client);
    const scanResult = await getScan(client, isUrgent ? 16 : 32);

    console.log(`[BotRunner] ${tier === 'fast' ? '⚡快思考' : '🧠慢思考'} (${urgentReason || '定期'})`);

    let prompt: string;

    if (tier === 'fast') {
      prompt = buildFastPrompt(status, scanResult, urgentReason);
    } else {
      const memory = await readMemoryFile(memoryDir);
      const skills = await loadAgentSkills();
      // Build world state via coordinator
      const botStatusData: BotStatusData = {
        health: status.health ?? 20, food: status.food ?? 20,
        position: status.position ?? null, inventory: status.inventory ?? '',
        timeOfDay: status.timeOfDay ?? 0, isDay: status.isDay ?? true,
        isBusy: status.isBusy ?? false, currentAction: status.currentAction ?? null,
      };
      // For worldState we need a local registry-like interface — use coordinator
      const socialCtx = await coordinator.summarizeForPrompt(botName);
      const socialMemSummary = socialMem.summarizeForPrompt();
      const fullSocialCtx = [socialCtx, socialMemSummary].filter(Boolean).join('\n');
      prompt = buildSlowPrompt(status, scanResult, memory, skills, fullSocialCtx);
    }

    // 调用 LLM
    console.log(`[BotRunner] 发送 prompt (${prompt.length} 字符) 到 LLM...`);
    const response = await callLLM(prompt);
    console.log(`[BotRunner] LLM 响应 (${response.length} 字符)`);

    // 解析计划
    const pe = cogState.planExecutor;
    if (!pe.loadPlan(response)) {
      console.warn(`[BotRunner] AI 返回无法解析的计划: ${response.slice(0, 200)}`);
    } else {
      if (pe.lastReflection) {
        cogState.memoryStream.add({ category: 'action_result', importance: 3, content: `AI 反思: ${pe.lastReflection}` });
      }
      console.log(`[BotRunner] 计划已加载 (${pe.progress})，开始执行...`);
      await executePlan(client);
    }

    cogState.memoryStream.markThinkDone();
    cogState.memoryStream.compact(30);
    cogState.planExecutor.reset();
  }

  // ─── 观察 Tick ───

  const observeTick = async () => {
    try {
      const client = await getOrCreateMcpClient();
      const status = await getStatus(client);

      // 更新 Coordinator registry
      await coordinator.update(botName, {
        status: 'online',
        position: status.position ?? null,
        health: status.health ?? 20,
        food: status.food ?? 20,
        inventory: status.inventory ?? '',
        isBusy: status.isBusy ?? false,
        currentAction: status.currentAction ?? null,
        isDay: status.isDay ?? true,
      });

      if (status.isBusy) {
        const busyEvents = await getEvents(client);
        parseAndRecordEvents(busyEvents, status, cogState.lastScan, coordinator);
        const { urgent, reason } = needsUrgentInterrupt(status);
        if (urgent && !cogState.thinkScheduled && reason.includes('受到攻击')) {
          cogState.planExecutor.interrupt(reason);
          await executeReflex(client, status, reason);
        }
        return;
      }

      const events = await getEvents(client);
      let scanResult = cogState.lastScan;
      if (cogState.consecutiveIdleObserves < 5) {
        scanResult = await getScan(client, 32);
      }
      parseAndRecordEvents(events, status, scanResult, coordinator);

      // Process coordinator events (drain queued events)
      const busEvents = await coordinator.drain(botName);
      for (const be of busEvents) {
        switch (be.type) {
          case 'agent:chat':
            cogState.memoryStream.add({ category: 'chat', importance: 7, content: `[Agent ${(be as any).from}] ${(be as any).message}` });
            break;
          case 'agent:trade_request':
            cogState.memoryStream.add({ category: 'chat', importance: 8, content: `${(be as any).from} 向你发起交易` });
            break;
          case 'agent:trade_response':
            cogState.memoryStream.add({ category: 'chat', importance: 6, content: `${(be as any).from} ${(be as any).accepted ? '接受' : '拒绝'}了交易` });
            break;
          case 'agent:join':
            cogState.memoryStream.add({ category: 'environment', importance: 4, content: `Agent ${(be as any).agentName} 上线了` });
            break;
          case 'agent:leave':
            cogState.memoryStream.add({ category: 'environment', importance: 3, content: `Agent ${(be as any).agentName} 离线了` });
            break;
        }
      }

      // 紧急中断
      const { urgent, reason } = needsUrgentInterrupt(status);
      if (urgent && !cogState.thinkScheduled) {
        console.log(`[BotRunner] 紧急中断: ${reason}`);
        cogState.thinkScheduled = true;
        cogState.planExecutor.interrupt(reason);
        const attacker = await executeReflex(client, status, reason);
        const combatReason = attacker
          ? `${reason}，攻击者是「${attacker}」，已自动装备武器`
          : reason;
        await triggerThink(client, true, combatReason);
        cogState.thinkScheduled = false;
        return;
      }

      // 定期思考
      const elapsed = Date.now() - cogState.memoryStream.lastThinkTime;
      if (elapsed >= cognitiveCycleMs && !cogState.thinkScheduled) {
        if (cogState.consecutiveIdleObserves > 15 && elapsed < cognitiveCycleMs * 2) {
          console.log(`[BotRunner] 持续空闲，延长认知周期`);
          return;
        }
        cogState.thinkScheduled = true;
        await triggerThink(client, false, '');
        cogState.thinkScheduled = false;
      } else {
        const nextThink = Math.max(0, Math.round((cognitiveCycleMs - elapsed) / 1000));
        const streamSize = cogState.memoryStream.stats.sinceLastThink;
        if (cogState.consecutiveIdleObserves < 3 || cogState.consecutiveIdleObserves % 5 === 0) {
          console.log(`[BotRunner] 观察 | 记忆+${streamSize} | 下次思考: ${nextThink}s | HP:${status.health ?? '?'}/${status.food ?? '?'}`);
        }
      }

      // Report cognitive state to coordinator for dashboard
      coordinator.updateCogState(botName, {
        memoryStreamSize: cogState.memoryStream.stats.sinceLastThink,
        planStatus: cogState.planExecutor.status,
        planProgress: cogState.planExecutor.progress,
        lastThinkTime: cogState.memoryStream.lastThinkTime,
        nextThinkIn: Math.max(0, cognitiveCycleMs - (Date.now() - cogState.memoryStream.lastThinkTime)),
        consecutiveIdle: cogState.consecutiveIdleObserves,
      }).catch(() => {});

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('重连冷却中')) {
        if (mcpFailCount <= 1) console.log(`[BotRunner] ${msg}`);
      } else if (msg.includes('Connection closed') || msg.includes('ECONNREFUSED') || msg.includes('EPIPE')) {
        console.warn(`[BotRunner] MCP 连接断开，等待冷却后重连...`);
        await coordinator.markOffline(botName).catch(() => {});
        mcpLastDisconnect = Date.now();
        mcpFailCount++;
        mcpClient = null;
        mcpTransport = null;
      } else {
        console.error(`[BotRunner] 观察错误:`, msg);
      }
    }
  };

  // 首次观察 + 思考
  await observeTick();
  try {
    const client = await getOrCreateMcpClient();
    await triggerThink(client, false, '初始启动');
  } catch (err) {
    console.error(`[BotRunner] 初始思考失败:`, err);
  }

  // 观察循环
  const scheduleObserve = () => {
    setTimeout(async () => {
      await observeTick();
      scheduleObserve();
    }, observeIntervalMs);
  };
  scheduleObserve();
}

run().catch((err) => {
  console.error('[BotRunner]', err);
  process.exit(1);
});
