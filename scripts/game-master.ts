/**
 * Game Master - 斯坦福 Generative Agents 式认知循环
 *
 * 核心理念：Think → Plan → Execute → Observe
 *
 * 1. 观察阶段（每 8s，零 token）：查询 Bot 状态，累积到记忆流
 * 2. 思考阶段（每 3 分钟，1 次 AI 调用）：
 *    - 将累积的观察压缩为摘要
 *    - 发送给 AI，AI 输出反思 + 行动计划（JSON）
 * 3. 执行阶段（零 token）：Plan Executor 逐步执行计划
 * 4. 紧急中断：死亡/低血量/被攻击 → 立即打断计划，触发思考
 *
 * 对比旧版：
 * - 旧: 每 8 秒 1 次 AI 调用 → 3 分钟 = 22 次 AI 调用
 * - 新: 每 3 分钟 1 次 AI 调用 → 3 分钟 = 1 次 AI 调用
 * - Token 节省: ~95%
 */
import { createServer } from 'http';
import { readFile, readdir, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { processPendingDeathIfAny } from '../src/mcp/deathReflection.js';
import { MemoryStream } from '../src/cognitive/memoryStream.js';
import { PlanExecutor } from '../src/cognitive/planExecutor.js';
import type { ObservationCategory } from '../src/cognitive/memoryStream.js';
import { writeDebug } from '../src/observer/logWriter.js';
import { agentRegistry } from '../src/multi/agentRegistry.js';
import { agentEventBus } from '../src/multi/eventBus.js';
import type { AgentEvent } from '../src/multi/eventBus.js';
import { executeSocialTool } from '../src/mcp/tools/social.js';
import { getSocialMemory } from '../src/social/socialMemory.js';
import { cleanupExpiredTrades } from '../src/social/tradeEngine.js';
import { skillLibrary } from '../src/skills/skillLibrary.js';
import { findRelevantSkills } from '../src/skills/skillRetrieval.js';
import { maybeGenerateSkill, tryPromoteSkills } from '../src/skills/skillGenerator.js';
import { executeSkill } from '../src/skills/skillExecutor.js';
import { evaluate as criticEvaluate, summarizeForPrompt as criticSummary, type WorldSnapshot } from '../src/cognitive/critic.js';
import { tryMatchHabit, executeHabit, type HabitExecResult } from '../src/cognitive/habitTier.js';
import { loadProfile, traitPromptModifier } from '../src/agents/personalityProfile.js';
import { buildWorldState, compressForPrompt, type BotStatusData } from '../src/cognitive/worldState.js';

const CONFIG_PATH = join(process.cwd(), 'config', 'game-master.json');

function getMemoryDir(config: GameMasterConfig): string {
  const base = config.memoryDir
    ? join(process.cwd(), config.memoryDir)
    : join(process.env.OPENCLAW_WORKSPACE || process.cwd(), 'memory');
  return process.env.MCBOOK_MEMORY_DIR || base;
}

interface BotConfig {
  name: string;
  mcBotName?: string;
  mcporterServer: string;
  openclawAgent: string;
  agentType?: string;
}

interface GameMasterConfig {
  intervalMs?: number;
  idleIntervalMs?: number;
  httpPort?: number;
  memoryDir?: string;
  allowInterruptOnThreat?: boolean;
  bots?: BotConfig[];
  /** 认知周期间隔（毫秒），默认 180000 (3分钟) */
  cognitiveCycleMs?: number;
  /** 观察轮询间隔（毫秒），默认 8000 */
  observeIntervalMs?: number;
  /** 紧急中断：血量低于此值立即思考 */
  urgentHealthThreshold?: number;
}

// ─── Prompt 优先级（Thinking, Fast and Slow）───
// reflex = System 0：无 AI 即时反射，<100ms 响应（受攻击→立即反击）
// fast   = System 1：本能反应，极短 prompt，2-3 步计划
// slow   = System 2：深度规划，完整 prompt，5-8 步计划
type PromptTier = 'fast' | 'slow';

/** 待拉取的 prompt */
const pendingPrompts = new Map<string, { prompt: string; tier: PromptTier }>();

async function loadConfig(): Promise<GameMasterConfig> {
  if (!existsSync(CONFIG_PATH)) {
    console.error('[GameMaster] 未找到 config/game-master.json');
    process.exit(1);
  }
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as GameMasterConfig;
}

// ─── MCP Client 管理 ───

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const mcpClients = new Map<string, Client>();
const mcpTransports = new Map<string, StdioClientTransport>();
/** 记录每个 Bot 上次 MCP 客户端被销毁的时间，防止快速重连循环 */
const mcpLastDisconnect = new Map<string, number>();
/** 连续失败计数，用于指数退避 */
const mcpFailCount = new Map<string, number>();
const MCP_RECONNECT_COOLDOWN_MS = 15000; // 最短 15 秒重连间隔

function getMcpServerConfig(serverName: string, mcBotName: string): McpServerConfig {
  const workspace = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');
  const mcporterPath = join(workspace, 'config', 'mcporter.json');
  if (existsSync(mcporterPath)) {
    try {
      const raw = readFileSync(mcporterPath, 'utf-8');
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
      const srv = cfg.mcpServers?.[serverName];
      if (srv) {
        const env = { ...srv.env, MC_BOT_USERNAME: mcBotName };
        return { ...srv, env, cwd: srv.cwd ?? process.cwd() };
      }
    } catch {
      /* fallback to default */
    }
  }
  const serverPath = join(process.cwd(), 'src', 'mcp', 'server.ts');
  return {
    command: 'npx',
    args: ['tsx', serverPath],
    env: {
      MC_BOT_HOST: process.env.MC_BOT_HOST ?? 'localhost',
      MC_BOT_PORT: process.env.MC_BOT_PORT ?? '25565',
      MC_BOT_USERNAME: mcBotName,
    },
    cwd: process.cwd(),
  };
}

async function getOrCreateMcpClient(bot: BotConfig): Promise<Client> {
  const key = bot.mcBotName ?? bot.name;
  let client = mcpClients.get(key);
  if (client) return client;

  // 重连冷却：防止快速循环创建/销毁 Bot
  const lastDisconnect = mcpLastDisconnect.get(key) ?? 0;
  const fails = mcpFailCount.get(key) ?? 0;
  const cooldown = MCP_RECONNECT_COOLDOWN_MS * Math.min(Math.pow(2, fails), 8); // 指数退避，最大 2 分钟
  const elapsed = Date.now() - lastDisconnect;
  if (lastDisconnect > 0 && elapsed < cooldown) {
    const waitSec = Math.round((cooldown - elapsed) / 1000);
    throw new Error(`MCP 重连冷却中，${waitSec}s 后重试`);
  }

  const srvConfig = getMcpServerConfig(bot.mcporterServer, bot.mcBotName ?? bot.name);
  const transport = new StdioClientTransport({
    command: srvConfig.command,
    args: srvConfig.args ?? [],
    env: srvConfig.env,
    cwd: srvConfig.cwd,
  });
  client = new Client({ name: 'game-master', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    mcpLastDisconnect.set(key, Date.now());
    mcpFailCount.set(key, fails + 1);
    throw err;
  }
  mcpClients.set(key, client);
  mcpTransports.set(key, transport);
  mcpFailCount.set(key, 0); // 连接成功，重置失败计数
  console.log(`[GameMaster] MCP 长连接已建立: ${bot.name} (${key})`);
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

async function readMemory(memoryDir: string, botName: string, mcBotName?: string): Promise<string> {
  const path = join(memoryDir, `${mcBotName ?? botName}_memory.txt`);
  if (!existsSync(path)) return '';
  try { return await readFile(path, 'utf-8'); } catch { return ''; }
}

// ─── 每个 Bot 的认知状态 ───

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
  /** 计划执行前的状态快照（供 Critic 使用） */
  preExecutionSnapshot: WorldSnapshot | null;
  /** 上次 Critic 评估摘要（注入到下次 prompt） */
  lastCriticSummary: string;
}

const cognitiveStates = new Map<string, CognitiveState>();

function getCogState(botName: string): CognitiveState {
  if (!cognitiveStates.has(botName)) {
    cognitiveStates.set(botName, {
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
    });
  }
  return cognitiveStates.get(botName)!;
}

// ─── 事件解析 & 记忆流填充 ───

function parseAndRecordEvents(botName: string, events: string, status: BotStatus, scanResult: string): void {
  const state = getCogState(botName);
  const ms = state.memoryStream;

  // 解析事件文本
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
            // 如果是来自其他已知 Agent 的消息，发布到事件总线
            if (agentRegistry.getByMcName(ev.username)) {
              agentEventBus.publish({
                type: 'agent:chat',
                from: ev.username,
                target: null,
                message: ev.message,
                ts: Date.now(),
              });
            }
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
  const healthChanged = status.health !== state.lastHealth || status.food !== state.lastFood;
  const scanChanged = scanResult !== state.lastScan;
  const invStr = status.inventory ?? '';
  const invChanged = invStr !== state.lastInventory;
  const posStr = status.position ? `${status.position.x},${status.position.y},${status.position.z}` : '';
  const posChanged = posStr !== state.lastPosition;

  if (healthChanged && status.health !== undefined) {
    // 血量下降 → 高重要性
    if (status.health < state.lastHealth) {
      ms.add({ category: 'combat', importance: 9, content: `受伤: 血量 ${state.lastHealth} → ${status.health}` });
    }
  }

  // 发现新敌对生物（玩家不算敌对生物）
  if (scanChanged && scanResult.includes('敌对生物') && !state.lastScan.includes('敌对生物')) {
    ms.add({ category: 'combat', importance: 7, content: '发现敌对生物' });
  }

  // 环境有变化但不是特别重要
  if (scanChanged && !scanResult.includes('敌对生物')) {
    state.consecutiveIdleObserves = 0;
  }

  // 更新缓存
  state.lastHealth = status.health ?? 20;
  state.lastFood = status.food ?? 20;
  state.lastScan = scanResult;
  state.lastInventory = invStr;
  state.lastPosition = posStr;

  // 判断是否有变化
  if (!healthChanged && !scanChanged && !invChanged && !posChanged &&
      events === '无待处理事件') {
    state.consecutiveIdleObserves++;
  } else {
    state.consecutiveIdleObserves = 0;
  }
}

/** 判断是否需要紧急中断（触发快思考 System 1） */
function needsUrgentInterrupt(botName: string, status: BotStatus): { urgent: boolean; reason: string } {
  const state = getCogState(botName);
  const recentObs = state.memoryStream.getSinceLastThink();

  // 死亡 → 快思考
  if (recentObs.some(o => o.category === 'death')) {
    return { urgent: true, reason: '死亡重生' };
  }

  // 低血量 → 快思考
  if (status.health !== undefined && status.health < urgentHealthThreshold) {
    return { urgent: true, reason: `低血量(${status.health})` };
  }

  // 受到伤害 → 快思考（AI 决定战斗/逃跑/其他）
  // 注意: parseAndRecordEvents 已把 lastHealth 更新为当前值，
  // 所以这里通过记忆流中的 combat 事件来检测受伤
  const recentCombat = recentObs.filter(o => o.category === 'combat');
  if (recentCombat.length > 0) {
    const lastCombat = recentCombat[recentCombat.length - 1];
    return { urgent: true, reason: `受到攻击(${lastCombat.content})` };
  }

  // 玩家聊天 → 快思考（需要回复）
  if (recentObs.some(o => o.category === 'chat')) {
    return { urgent: true, reason: '收到聊天消息' };
  }

  return { urgent: false, reason: '' };
}

let urgentHealthThreshold = 6;

// ─── System 0：即时反射（零 AI、零延迟） ───

/** 武器优先级（高→低） */
const WEAPON_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
  'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe',
];

/**
 * 即时反射：受到攻击时，立即装备武器
 * 不经过 AI，直接通过 MCP 工具执行
 * 注意：反射只做「装备武器」，不做攻击 — 攻击/逃跑/求饶由 AI 快思考决定
 * 返回攻击者名称（供快思考使用），null 表示未检测到攻击者
 */
async function executeReflex(
  client: Client,
  botName: string,
  status: BotStatus,
  reason: string,
): Promise<string | null> {
  // 只对战斗类事件触发反射
  if (!reason.includes('受到攻击') && !reason.includes('受到伤害')) return null;

  const state = getCogState(botName);
  const inv = status.inventory ?? '';

  writeDebug('REFLEX', `${botName} ⚡反射: ${reason}`);
  console.log(`[GameMaster] ${botName} ⚡System 0 反射: ${reason}`);

  // 1) 装备最好的武器（<100ms，不阻塞）
  let equippedWeapon = '空手';
  for (const weapon of WEAPON_PRIORITY) {
    if (inv.includes(weapon)) {
      try {
        await client.callTool({ name: 'equip', arguments: { item_name: weapon } });
        equippedWeapon = weapon;
        writeDebug('REFLEX', `${botName} 装备武器: ${weapon}`);
      } catch { /* ignore */ }
      break;
    }
  }

  // 2) 扫描找到攻击者（<200ms，不阻塞）
  let attacker: string | null = null;
  try {
    const scanResult = await client.callTool({ name: 'get_scan', arguments: { radius: 16, include_blocks: false } });
    const scanText = extractToolText(scanResult);

    // 优先找敌对生物
    const mobMatch = scanText.match(/发现敌对生物「([^」]+)」/);
    if (mobMatch) {
      attacker = mobMatch[1];
    }

    // 如果没有敌对生物，可能是玩家攻击
    if (!attacker) {
      const playerMatch = scanText.match(/发现玩家「([^」]+)」/);
      if (playerMatch) {
        attacker = playerMatch[1];
      }
    }
  } catch (err) {
    console.warn(`[GameMaster] ${botName} 反射扫描失败:`, err instanceof Error ? err.message : err);
  }

  // 记录到记忆流（供 AI 快思考参考）
  state.memoryStream.add({
    category: 'action_result',
    importance: 5,
    content: `⚡反射: 已装备${equippedWeapon}${attacker ? `，发现攻击者「${attacker}」` : '，未发现攻击者'}。等待AI决策：反击/逃跑/求饶`,
  });

  console.log(`[GameMaster] ${botName} ⚡反射完成: 装备${equippedWeapon}，攻击者=${attacker ?? '未知'}，等待AI决策...`);
  return attacker;
}

// ─── Agent Skills 加载 ───

const agentSkillsCache = new Map<string, string>();
/** 每个 Agent 的人格 prompt 缓存 */
const personalityPromptCache = new Map<string, string>();
/** 每个 Agent 的活跃目标缓存 */
const activeGoalsCache = new Map<string, string[]>();

async function loadAgentSkills(agentType?: string): Promise<string> {
  if (!agentType) return '';
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
    console.log(`[GameMaster] Loaded ${mdFiles.length} skill files for agent type: ${agentType}`);
    return result;
  } catch {
    agentSkillsCache.set(agentType, '');
    return '';
  }
}

// ─── Prompt 构建：快思考 vs 慢思考 ───

/** 获取背包建材统计 */
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

/**
 * 快思考 Prompt（System 1）
 * 极短，~800字符，专注当前威胁，2-3步反应
 * 不包含 skills/memory/详细工具说明
 */
function buildFastPrompt(
  botName: string,
  status: BotStatus,
  scanResult: string,
  urgentReason: string,
): string {
  const state = getCogState(botName);
  const health = status.health ?? 20;
  const food = status.food ?? 20;
  const pos = status.position ? `(${status.position.x},${status.position.y},${status.position.z})` : '?';
  const inv = status.inventory ?? '空';

  // 最近的重要观察（排除 chat，chat 单独列出）
  const recentObs = state.memoryStream.getSinceLastThink();
  const recentUrgent = recentObs
    .filter(o => o.importance >= 5 && o.category !== 'chat')
    .slice(-5)
    .map(o => o.content)
    .join('; ');

  // 提取最近的聊天消息（让 AI 决定是否回复）
  const recentChat = recentObs
    .filter(o => o.category === 'chat')
    .slice(-5)
    .map(o => o.content)
    .join('; ');

  const personality = personalityPromptCache.get(botName) ?? '';

  let prompt = `!! 快速反应 !! 原因: ${urgentReason}
HP:${health}/20 饥饿:${food}/20 坐标:${pos} ${status.isDay ? '白天' : '夜晚'}
背包: ${inv}
事件: ${recentUrgent || '无'}`;

  if (recentChat) {
    prompt += `\n聊天: ${recentChat}`;
  }

  // 扫描视野（快速版，小范围）
  prompt += `\n视野: ${scanResult || '无'}`;

  // 根据紧急原因构建针对性指引
  const isCombat = urgentReason.includes('受到攻击') || urgentReason.includes('受到伤害');

  let combatGuide = '';
  if (isCombat) {
    // 分析战斗态势
    const hasWeapon = inv.match(/(netherite|diamond|iron|stone|wooden)_sword/);
    const hasFood = inv.match(/(cooked_|bread|apple|stew|golden_apple)/);
    const isLowHp = health <= 8;
    const isCriticalHp = health <= 4;

    combatGuide = `
!! 你正在被攻击！系统已自动反击，但你需要决定真正的策略 !!
根据当前情况选择以下策略之一：

【策略A：反击】适用于：你有武器、血量充足、对手较弱
  → equip 最好的武器 → attack 攻击者

【策略B：逃跑】适用于：血量低、没武器、对手太强
  → move_to 远离敌人方向跑（当前坐标${pos}，往反方向跑20-30格）

【策略C：求饶/外交】适用于：对手是玩家、打不过、想谈判
  → chat 发消息求饶（例如"别打了！我只是个和平的Bot！"、"大哥饶命！"、"我们能和平共处吗？"）
  → 然后 move_to 后退几步表示诚意

你可以组合使用，例如：先 chat 喊话 → 边跑边说 → 如果追上来再 attack

当前态势：${isCriticalHp ? '!! 危急 !! 血量只有' + health + '，优先逃跑或求饶' : isLowHp ? '血量较低(' + health + ')，谨慎战斗' : '血量充足(' + health + ')'}
${hasWeapon ? '有武器可战斗' : '!! 没有武器 !! 建议逃跑或求饶'}
${hasFood ? '有食物可回血' : '没有食物'}`;
  }

  prompt += `\n${personality ? `\n${personality}\n` : ''}
你是 Minecraft Bot，有自己的性格和判断力。只输出 JSON。
工具: move_to({x,y,z}), mine({block_type}), attack({target_name}), eat({}), equip({item_name}), chat({message}), craft({item_name,count}), place({block_name,x,y,z}), find_blocks({block_type})
{"reflection":"一句话判断（说明你选了什么策略、为什么）","plan":[{"tool":"..","args":{..},"note":".."}]}
规则: 最多3步。${combatGuide}
${!isCombat ? `- 低血量：先 eat 回血，没食物就逃跑 move_to 远离敌人
- 聊天：用 chat 回复，展现你的个性` : ''}`;

  return prompt;
}

/**
 * 慢思考 Prompt（System 2）
 * 完整版，~3000字符 + skills，5-8步深度规划
 */
function buildSlowPrompt(
  botName: string,
  status: BotStatus,
  scanResult: string,
  memory: string,
  skills: string = '',
  socialContext: string = '',
): string {
  const state = getCogState(botName);
  const timeStr = status.isDay ? '白天' : '夜晚';
  const health = status.health ?? 20;
  const food = status.food ?? 20;
  const pos = status.position ? `(${status.position.x}, ${status.position.y}, ${status.position.z})` : '(?, ?, ?)';
  const hungerNote = food < 8 ? '（你很饿！）' : food < 14 ? '（建议补充食物）' : '';
  const inv = status.inventory ?? '空';
  const buildNote = getBuildMaterialNote(inv);
  const observations = state.memoryStream.summarizeForPrompt();
  const planSummary = state.planExecutor.getExecutionSummary();
  const skillsSection = skills ? `\n\n【Survival Skills Reference】\n${skills}` : '';

  // 根据背包内容生成工具提示
  const hasAxe = inv.match(/(netherite|diamond|iron|stone|wooden)_axe/);
  const hasPickaxe = inv.match(/(netherite|diamond|iron|stone|wooden)_pickaxe/);
  const hasSword = inv.match(/(netherite|diamond|iron|stone|wooden)_sword/);
  const hasCraftingTable = inv.includes('crafting_table');
  const hasLogs = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_log/);
  const hasPlanks = inv.match(/(?:oak|birch|spruce|jungle|acacia|dark_oak)_planks/);

  let toolAdvice = '';
  if (!hasAxe && !hasPickaxe && !hasSword) {
    if (hasPlanks || hasLogs) {
      toolAdvice = `\n!! 你没有任何工具！立即 craft 工具 !!
  - 需要 crafting_table（4木板）→ 先 place 工作台 → 再 craft
  - 优先做 wooden_axe（砍树快2倍）、wooden_pickaxe（挖石头）、wooden_sword（防身）`;
    } else {
      toolAdvice = `\n!! 你没有工具也没有木头！最优先砍树(mine oak_log)获取木头 !!`;
    }
  } else {
    const missing: string[] = [];
    if (!hasAxe) missing.push('axe(砍树)');
    if (!hasPickaxe) missing.push('pickaxe(挖矿)');
    if (!hasSword) missing.push('sword(防身)');
    if (missing.length > 0) {
      toolAdvice = `\n提示: 你缺少 ${missing.join('、')}，有材料时优先 craft`;
    }
  }

  // 白天/夜晚差异化优先级
  const dayPriorities = `**白天优先级**：
1. 应对威胁（怪物、低血量）
2. !! 制作工具 !! — 有木头就先做工具(axe/pickaxe/sword)，工具大幅提升效率${toolAdvice}
3. !! 收集资源 !! — 砍树、挖矿，为建造储备材料
4. !! 建造庇护所 !! — 有10+建材就立即 place 建房，天黑前必须有庇护所
5. 补充食物（狩猎动物、采集）
6. 房子建好后升级工具/采矿
!! 白天是收集和建造的黄金时间，不要浪费 !!
- 工具链: 砍树 → craft crafting_table → place 工作台 → craft axe+pickaxe+sword → 再砍树/挖矿
- 建造时基于当前坐标规划，用 place 逐个放置`;

  const nightPriorities = `**夜晚优先级**：
1. !! 生存第一 !! — 夜晚怪物会刷新，非常危险
2. 如果有庇护所 → 待在室内，不要外出冒险
3. 如果有床(bed) → 使用床睡觉跳过夜晚（最安全的选择）
4. 如果没有庇护所 → 立即就地用任何材料(dirt/cobblestone/planks)围一个3x3x3的密封空间
5. 应对威胁 — 装备武器，准备战斗或逃跑
6. 室内活动 — 在庇护所内合成工具、整理背包
7. 不要在夜晚外出采矿或砍树（除非紧急需要材料建庇护所）
!! 夜晚极其危险，活下来比什么都重要 !!
- 如果被怪物追击，跑向庇护所或挖洞躲避
- 保持警惕，随时准备战斗`;

  const priorities = status.isDay ? dayPriorities : nightPriorities;

  const personality = personalityPromptCache.get(botName) ?? '';

  return `【慢思考 - 深度规划】
${personality ? `\n${personality}\n` : ''}
【生存准则】${memory || '（暂无）'}${skillsSection}

【当前状态】
  ${timeStr} | 血量 ${health}/20 | 饥饿 ${food}/20${hungerNote} | 坐标 ${pos}
  背包: ${inv}${buildNote}

【观察记录】
${observations}

【上周期执行情况】
${planSummary}
${state.lastCriticSummary ? `\n【Critic 评估】\n${state.lastCriticSummary}` : ''}

【当前视野】
${scanResult}
${socialContext ? `\n【其他 Agent】\n${socialContext}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你是 Minecraft 生存 Bot，每分钟思考一次，规划下一步行动。
当前是【${timeStr}】。

!! 只输出纯 JSON，不要调用工具/tool_call !!

━━ 可用工具（15个）━━
move_to({x,y,z}) — 移动到坐标
mine({block_type}) — 挖掘（自动搜索64格范围）。也可 mine({x,y,z}) 挖指定坐标
craft({item_name,count}) — 合成
chat({message}) — 聊天
equip({item_name}) — 装备
attack({target_name}) — 攻击
eat({food_name}) — 进食（留空=自动选）
find_blocks({block_type,count}) — 搜索方块坐标（64格）
place({block_name,x,y,z}) — 放置方块（建造用）
━━ 社交工具 ━━
send_chat({target?,message}) — 向指定Agent发消息（留空target=广播）
query_agent_status({agent_name}) — 查询其他Agent状态
request_trade({target,offer_items,want_items}) — 发起交易
accept_trade({trade_id}) / reject_trade({trade_id}) — 接受/拒绝交易
form_team({team_name,members[]}) — 创建团队
share_skill({skill_name,target}) — 将你的技能分享给另一个Agent
set_waypoint({name,x,y,z}) — 设置共享路标

━━ 输出格式 ━━
{"reflection":"1-2句话","plan":[{"tool":"..","args":{..},"note":".."},..]}

${priorities}
- 计划 5-8 步
- 只输出 JSON`;
}

// ─── 主循环 ───

async function runLoop(config: GameMasterConfig): Promise<void> {
  const observeIntervalMs = config.observeIntervalMs ?? config.intervalMs ?? 8000;
  const cognitiveCycleMs = config.cognitiveCycleMs ?? 180000; // 默认 3 分钟
  const httpPort = config.httpPort ?? 3848;
  const bots = config.bots ?? [];
  const memoryDir = getMemoryDir(config);
  process.env.MCBOOK_MEMORY_DIR = memoryDir;
  urgentHealthThreshold = config.urgentHealthThreshold ?? 6;

  if (!existsSync(memoryDir)) {
    await mkdir(memoryDir, { recursive: true });
  }

  // ─── HTTP 服务 ───
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/heartbeat')) {
      const url = new URL(req.url, 'http://x');
      const botName = url.searchParams.get('bot') ?? bots[0]?.name ?? 'Bot_1';
      const entry = pendingPrompts.get(botName);
      if (entry) {
        pendingPrompts.delete(botName);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Prompt-Tier': entry.tier,
        });
        res.end(entry.prompt);
        console.log(`[GameMaster] ${botName} prompt (${entry.tier}) 已被拉取`);
      } else {
        res.writeHead(204);
        res.end();
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      const statusMap: Record<string, unknown> = {};
      for (const bot of bots) {
        const state = cognitiveStates.get(bot.name);
        const ms = state?.memoryStream;
        const pe = state?.planExecutor;
        const regInfo = agentRegistry.get(bot.name);
        statusMap[bot.name] = {
          hasPendingPrompt: pendingPrompts.has(bot.name),
          pendingTier: pendingPrompts.get(bot.name)?.tier,
          memoryStreamSize: ms?.stats.sinceLastThink ?? 0,
          planStatus: pe?.status ?? 'idle',
          planProgress: pe?.progress ?? '0/0',
          lastThinkTime: ms?.lastThinkTime ?? 0,
          nextThinkIn: ms ? Math.max(0, cognitiveCycleMs - (Date.now() - ms.lastThinkTime)) : 0,
          consecutiveIdle: state?.consecutiveIdleObserves ?? 0,
          agentStatus: regInfo?.status ?? 'unknown',
          pendingBusEvents: agentEventBus.peek(bot.name).length,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusMap, null, 2));
      return;
    }
    // ─── POST /plan — 接收 AI 的 JSON 计划并执行 ───
    if (req.method === 'POST' && req.url === '/plan') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body) as { bot?: string; plan?: string };
          const botName = data.bot ?? bots[0]?.name ?? 'Bot_1';
          const planText = data.plan ?? '';

          if (!planText.trim()) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Empty plan');
            return;
          }

          const botCfg = bots.find(b => b.name === botName);
          if (!botCfg) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(`Bot not found: ${botName}`);
            return;
          }

          const state = getCogState(botName);
          const pe = state.planExecutor;

          writeDebug('AI_RESPONSE', `${botName} AI 原始输出`, planText);

          // 解析计划
          if (!pe.loadPlan(planText)) {
            writeDebug('PLAN_ERROR', `${botName} AI 返回了无法解析的计划`, planText.slice(0, 500));
            console.warn(`[GameMaster] ${botName} AI 返回了无法解析的计划: ${planText.slice(0, 200)}`);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Failed to parse plan JSON');
            return;
          }

          // 保存反思到记忆
          if (pe.lastReflection) {
            writeDebug('REFLECTION', `${botName} AI 反思: ${pe.lastReflection}`);
            state.memoryStream.add({
              category: 'action_result',
              importance: 3,
              content: `AI 反思: ${pe.lastReflection}`,
            });
          }

          // 记录完整计划
          const planSteps = pe.executionResults.length === 0 ? pe.progress : pe.progress;
          writeDebug('PLAN', `${botName} 计划已加载 (${pe.progress} 步)`, planText);

          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`Plan loaded: ${pe.progress} steps`);

          console.log(`[GameMaster] ${botName} 收到 AI 计划，${pe.progress}，开始执行...`);

          // 异步执行计划（不阻塞 HTTP 响应）
          executePlanForBot(botCfg).catch(err => {
            console.error(`[GameMaster] ${botName} 计划执行错误:`, err);
          });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`Invalid request: ${err instanceof Error ? err.message : err}`);
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end([
        'MCBook Game Master (认知循环版 - Generative Agents)',
        '',
        `认知周期: ${cognitiveCycleMs / 1000}s | 观察间隔: ${observeIntervalMs / 1000}s`,
        '',
        'GET  /heartbeat?bot=Bot_1  拉取 prompt',
        'GET  /status               各 Bot 认知状态',
        'POST /plan                 提交 AI 计划 { "bot": "Bot_1", "plan": "JSON..." }',
      ].join('\n'));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // 端口错误处理（必须在 listen 之前注册）
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[GameMaster] 端口 ${httpPort} 被占用，请先关闭旧的 Game Master 进程，或修改 config/game-master.json 中的 httpPort`);
      process.exit(1);
    }
    console.error(`[GameMaster] HTTP 服务器错误:`, err);
  });

  // ─── WebSocket 推送 ───
  const wss = new WebSocketServer({ noServer: true });
  const wsSubscriptions = new Map<string, Set<WebSocket>>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const botName = url.searchParams.get('bot') ?? bots[0]?.name ?? 'Bot_1';
    if (!wsSubscriptions.has(botName)) wsSubscriptions.set(botName, new Set());
    wsSubscriptions.get(botName)!.add(ws);
    console.log(`[GameMaster] WebSocket 客户端已连接，订阅 ${botName}`);
    ws.on('close', () => { wsSubscriptions.get(botName)?.delete(ws); });
  });

  // HTTP upgrade → WebSocket（noServer 模式避免端口冲突时 WSS 也崩溃）
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  function wsPushPrompt(botName: string, prompt: string, tier: PromptTier): boolean {
    const subs = wsSubscriptions.get(botName);
    if (!subs || subs.size === 0) return false;
    const msg = JSON.stringify({ botName, tier, prompt });
    let sent = false;
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent = true; }
    }
    return sent;
  }

  server.listen(httpPort, () => {
    console.log(`[GameMaster] HTTP + WebSocket 服务已启动 http://localhost:${httpPort}`);
  });

  console.log(`[GameMaster] 认知循环模式启动`);
  console.log(`  观察间隔: ${observeIntervalMs}ms`);
  console.log(`  认知周期: ${cognitiveCycleMs}ms (${cognitiveCycleMs / 1000}s)`);
  console.log(`  紧急中断血量阈值: ${urgentHealthThreshold}`);
  console.log(`  Bot 数量: ${bots.length}`);

  if (bots.length === 0) {
    console.warn('[GameMaster] 未配置 bots');
  }

  // ─── 初始化 Agent Registry & Event Bus & Social Memory & Personality ───
  for (const bot of bots) {
    agentRegistry.register(bot.name, bot.mcBotName ?? bot.name, bot.agentType ?? 'survivor');
    agentEventBus.registerAgent(bot.name);
    const sm = getSocialMemory(memoryDir, bot.name);
    sm.load().catch(err => console.warn(`[GameMaster] ${bot.name} 社交记忆加载失败:`, err));
    // 加载人格特质
    const agentType = bot.agentType ?? 'survivor';
    loadProfile(agentType).then(profile => {
      const traitStr = traitPromptModifier(profile.traits);
      const bgStr = profile.background ? `【背景】${profile.background}` : '';
      const goalsStr = profile.initialGoals.length > 0 ? `【初始目标】${profile.initialGoals.join('；')}` : '';
      const parts = [traitStr, bgStr, goalsStr].filter(Boolean);
      if (parts.length > 0) {
        personalityPromptCache.set(bot.name, parts.join('\n'));
        console.log(`[GameMaster] ${bot.name} 人格特质已加载 (${agentType}): ${traitStr.slice(0, 60)}...`);
      }
      if (profile.initialGoals.length > 0) {
        activeGoalsCache.set(bot.name, [...profile.initialGoals]);
      }
    }).catch(err => console.warn(`[GameMaster] ${bot.name} 人格加载失败:`, err));
  }
  console.log(`[GameMaster] Agent Registry 已初始化: ${bots.map(b => b.name).join(', ')}`);

  // 定期清理过期交易 & 保存社交记忆
  setInterval(() => {
    cleanupExpiredTrades();
    for (const bot of bots) {
      getSocialMemory(memoryDir, bot.name).save().catch(() => {});
    }
  }, 60000);

  // ─── 执行 AI 计划 ───

  async function executePlanForBot(bot: BotConfig): Promise<void> {
    const state = getCogState(bot.name);
    const pe = state.planExecutor;
    if (!pe.currentStep) return;

    // 记录计划开始时间，只有在此之后的新紧急事件才中断
    const planStartTime = Date.now();

    try {
      const client = await getOrCreateMcpClient(bot);

      // 捕获执行前状态快照（供 Critic 使用）
      const preStatus = await getStatus(client);
      state.preExecutionSnapshot = {
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
          state.memoryStream.add({
            category: 'action_result',
            importance: result.success ? 2 : 5,
            content: `[${icon}] ${result.step.tool}${result.step.note ? `(${result.step.note})` : ''}: ${result.result.slice(0, 100)}`,
          });
          writeDebug('EXEC', `${bot.name} [${icon}] ${result.step.tool}(${JSON.stringify(result.step.args)}) → ${result.result.slice(0, 150)} (${result.durationMs}ms)`);
          console.log(`[PlanExec] ${bot.name} [${icon}] ${result.step.tool}: ${result.result.slice(0, 80)}`);
        },
        // 中断检查：只有计划执行期间新产生的紧急事件才中断
        () => {
          const recentUrgent = state.memoryStream.getSinceLastThink()
            .filter(o => o.ts > planStartTime && o.importance >= 8);
          return recentUrgent.length > 0;
        },
        // 社交工具处理器：在 Game Master 进程中本地执行
        (tool, args) => executeSocialTool(bot.name, tool, args),
      );

      writeDebug('EXEC_DONE', `${bot.name} 计划执行完毕: ${results.length} 步，状态: ${pe.status}`);
      console.log(`[PlanExec] ${bot.name} 计划执行完毕: ${results.length} 步，状态: ${pe.status}`);

      // 从成功计划中生成可复用技能
      if (pe.status === 'completed' && results.length >= 3) {
        const steps = results.map(r => r.step);
        maybeGenerateSkill(steps, results, pe.lastReflection, bot.name).catch(err => {
          console.warn(`[SkillGen] ${bot.name} 技能生成失败:`, err);
        });
        // 尝试提升技能到共享库
        tryPromoteSkills(bot.name).catch(() => {});
      }

      // Critic 评估：比较执行前后状态
      if (state.preExecutionSnapshot && results.length > 0) {
        try {
          const postStatus = await getStatus(client);
          const postSnapshot: WorldSnapshot = {
            health: postStatus.health ?? 20,
            food: postStatus.food ?? 20,
            position: postStatus.position ?? null,
            inventory: postStatus.inventory ?? '',
            isDay: postStatus.isDay ?? true,
          };
          const steps = results.map(r => r.step);
          const evaluation = criticEvaluate(state.preExecutionSnapshot, postSnapshot, results, steps);
          state.lastCriticSummary = criticSummary(evaluation);
          writeDebug('CRITIC', `${bot.name} 评估: ${state.lastCriticSummary}`);

          state.memoryStream.add({
            category: 'action_result',
            importance: 3,
            content: `反思评估: ${state.lastCriticSummary}`,
          });
        } catch (err) {
          console.warn(`[Critic] ${bot.name} 评估失败:`, err);
        }
        state.preExecutionSnapshot = null;
      }
    } catch (err) {
      writeDebug('EXEC_ERROR', `${bot.name} 计划执行异常`, err instanceof Error ? err.message : String(err));
      console.error(`[PlanExec] ${bot.name} 计划执行异常:`, err);
    }
  }

  // ─── 发送 prompt（思考阶段触发） ───

  function emitPrompt(botName: string, prompt: string, tier: PromptTier): void {
    pendingPrompts.set(botName, { prompt, tier });
    const pushed = wsPushPrompt(botName, prompt, tier);
    if (pushed) {
      pendingPrompts.delete(botName);
      console.log(`[GameMaster] ${botName} 认知 prompt (${tier}) WebSocket 推送完成`);
    } else {
      console.log(`[GameMaster] ${botName} 认知 prompt (${tier}) 等待拉取`);
    }
  }

  // ─── 思考阶段 ───

  async function triggerThink(bot: BotConfig, client: Client, isUrgent: boolean, urgentReason: string): Promise<void> {
    const state = getCogState(bot.name);
    const tier: PromptTier = isUrgent ? 'fast' : 'slow';

    // Habit Tier：非紧急时，尝试匹配已有技能（跳过 LLM）
    if (!isUrgent) {
      try {
        const recentObs = state.memoryStream.getSinceLastThink();
        const habitMatch = await tryMatchHabit(bot.name, recentObs);
        if (habitMatch.matched && habitMatch.skillName) {
          writeDebug('HABIT', `${bot.name} 习惯匹配: ${habitMatch.skillName} (相似度=${habitMatch.similarity?.toFixed(2)}, 成功率=${habitMatch.successRate?.toFixed(2)})`);
          console.log(`[GameMaster] ${bot.name} 🔄 Habit Tier: 执行技能 "${habitMatch.skillName}" (跳过 LLM)`);

          const habitResult = await executeHabit(bot.name, habitMatch.skillName, client);
          state.memoryStream.add({
            category: 'action_result',
            importance: 3,
            content: `[习惯] 执行技能 "${habitMatch.skillName}": ${habitResult.success ? '成功' : '失败'} - ${habitResult.result?.slice(0, 80) ?? ''}`,
          });
          state.memoryStream.markThinkDone();
          return; // 跳过 LLM 调用
        }
      } catch (err) {
        // 习惯匹配失败不影响正常思考流程
        console.warn(`[GameMaster] ${bot.name} Habit Tier 匹配失败:`, err);
      }
    }

    // 处理死亡反思
    const processed = await processPendingDeathIfAny(bot.mcBotName ?? bot.name);
    if (processed) {
      writeDebug('THINK', `${bot.name} 处理死亡反思`);
    }

    // 获取当前状态
    const status = await getStatus(client);
    const scanResult = await getScan(client, isUrgent ? 16 : 32); // 快思考扫描范围小，更快

    writeDebug(tier === 'fast' ? 'FAST_THINK' : 'SLOW_THINK',
      `${bot.name} ${tier === 'fast' ? '⚡快思考' : '🧠慢思考'} (${urgentReason || '定期'})`);
    writeDebug('STATUS', `${bot.name} HP:${status.health}/${status.food} pos:${status.position ? `(${status.position.x},${status.position.y},${status.position.z})` : '?'} inv:[${status.inventory ?? '空'}]`);

    let prompt: string;

    if (tier === 'fast') {
      // System 1：快思考 — 极短 prompt，无 skills/memory
      prompt = buildFastPrompt(bot.name, status, scanResult, urgentReason);
      writeDebug('FAST_PROMPT', `${bot.name} (${prompt.length} 字符)`, prompt);
    } else {
      // System 2：慢思考 — 完整 prompt
      const memory = await readMemory(memoryDir, bot.name, bot.mcBotName);
      const skills = await loadAgentSkills(bot.agentType);
      // 构建统一世界状态快照（社交 + 技能 + 路标）
      const socialMem = getSocialMemory(memoryDir, bot.name);
      const botStatusData: BotStatusData = {
        health: status.health ?? 20,
        food: status.food ?? 20,
        position: status.position ?? null,
        inventory: status.inventory ?? '',
        timeOfDay: status.timeOfDay ?? 0,
        isDay: status.isDay ?? true,
        isBusy: status.isBusy ?? false,
        currentAction: status.currentAction ?? null,
      };
      const goals = activeGoalsCache.get(bot.name) ?? [];
      const worldSnapshot = await buildWorldState(bot.name, botStatusData, agentRegistry, socialMem, skillLibrary, goals);
      const worldCtx = compressForPrompt(worldSnapshot);
      // 也保留传统社交摘要（兼容）
      const socialCtx = agentRegistry.summarizeForPrompt(bot.name);
      const socialMemSummary = socialMem.summarizeForPrompt();
      const fullSocialCtx = [socialCtx, socialMemSummary, worldCtx].filter(Boolean).join('\n');
      prompt = buildSlowPrompt(bot.name, status, scanResult, memory, skills, fullSocialCtx);
      writeDebug('SCAN', `${bot.name} 视野`, scanResult);
      writeDebug('MEMORY_STREAM', `${bot.name} 记忆流 (${state.memoryStream.stats.sinceLastThink} 条新)`, state.memoryStream.summarizeForPrompt());
      writeDebug('SLOW_PROMPT', `${bot.name} (${prompt.length} 字符)`);
    }

    emitPrompt(bot.name, prompt, tier);

    // 标记思考完成
    state.memoryStream.markThinkDone();
    state.memoryStream.compact(30);
    state.planExecutor.reset();

    console.log(`[GameMaster] ${bot.name} ${tier === 'fast' ? '⚡快思考' : '🧠慢思考'} (${urgentReason || '定期'})，prompt: ${prompt.length}字符`);
  }

  // ─── 观察 Tick（轻量，零 token） ───

  const observeTick = async () => {
    for (const bot of bots) {
      try {
        const client = await getOrCreateMcpClient(bot);
        const state = getCogState(bot.name);

        // 1) 获取状态
        const status = await getStatus(client);

        // 更新 Agent Registry
        agentRegistry.update(bot.name, {
          status: 'online',
          position: status.position ?? null,
          health: status.health ?? 20,
          food: status.food ?? 20,
          inventory: status.inventory ?? '',
          isBusy: status.isBusy ?? false,
          currentAction: status.currentAction ?? null,
          isDay: status.isDay ?? true,
        });

        // 如果 bot 正忙（正在执行之前的工具调用），仍然检查事件
        // 但跳过定期思考和扫描（避免干扰正在执行的动作）
        if (status.isBusy) {
          // 即使忙碌，也要检查是否有紧急事件（如受到攻击）
          const busyEvents = await getEvents(client);
          parseAndRecordEvents(bot.name, busyEvents, status, state.lastScan);
          const { urgent: busyUrgent, reason: busyReason } = needsUrgentInterrupt(bot.name, status);
          if (busyUrgent && !state.thinkScheduled && busyReason.includes('受到攻击')) {
            writeDebug('URGENT', `${bot.name} 忙碌中但受到攻击，触发反射: ${busyReason}`);
            state.planExecutor.interrupt(busyReason);
            await executeReflex(client, bot.name, status, busyReason);
          }
          continue;
        }

        // 2) 获取事件
        const events = await getEvents(client);

        // 3) 扫描（仅在非连续空闲时）
        let scanResult = state.lastScan;
        if (state.consecutiveIdleObserves < 5) {
          scanResult = await getScan(client, 32);
        }

        // 4) 记录到记忆流
        parseAndRecordEvents(bot.name, events, status, scanResult);

        // 4.5) 处理 Agent 间事件（来自事件总线）
        const busEvents = agentEventBus.drain(bot.name);
        for (const be of busEvents) {
          switch (be.type) {
            case 'agent:chat':
              state.memoryStream.add({ category: 'chat', importance: 7, content: `[Agent ${be.from}] ${be.message}` });
              break;
            case 'agent:trade_request':
              state.memoryStream.add({
                category: 'chat', importance: 8,
                content: `${be.from} 向你发起交易提案(${be.tradeId}): 给你 ${be.offerItems.map(i => `${i.name}x${i.count}`).join(',')}，想要 ${be.wantItems.map(i => `${i.name}x${i.count}`).join(',')}`,
              });
              break;
            case 'agent:trade_response':
              state.memoryStream.add({
                category: 'chat', importance: 6,
                content: `${be.from} ${be.accepted ? '接受' : '拒绝'}了你的交易(${be.tradeId})`,
              });
              break;
            case 'agent:join':
              state.memoryStream.add({ category: 'environment', importance: 4, content: `Agent ${be.agentName} 上线了` });
              break;
            case 'agent:leave':
              state.memoryStream.add({ category: 'environment', importance: 3, content: `Agent ${be.agentName} 离线了` });
              break;
            case 'agent:team':
              state.memoryStream.add({
                category: 'chat', importance: 5,
                content: `团队 "${be.teamName}": ${be.agentName} ${be.action === 'form' ? '创建' : '离开'}了团队`,
              });
              break;
          }
        }

        // 5) 检查紧急中断
        const { urgent, reason } = needsUrgentInterrupt(bot.name, status);
        if (urgent && !state.thinkScheduled) {
          writeDebug('URGENT', `${bot.name} 紧急中断: ${reason}`);
          console.log(`[GameMaster] ${bot.name} 紧急中断: ${reason}`);
          state.thinkScheduled = true;
          state.planExecutor.interrupt(reason);

          // System 0：即时反射 — 装备武器，识别攻击者
          const attacker = await executeReflex(client, bot.name, status, reason);

          // System 1：快思考 — AI 决定后续策略（反击/逃跑/求饶）
          const combatReason = attacker
            ? `${reason}，攻击者是「${attacker}」，已自动装备武器，请决定：反击/逃跑/求饶`
            : reason;
          await triggerThink(bot, client, true, combatReason);
          state.thinkScheduled = false;
          continue;
        }

        // 6) 检查是否到了定期思考时间
        const elapsed = Date.now() - state.memoryStream.lastThinkTime;
        if (elapsed >= cognitiveCycleMs && !state.thinkScheduled) {
          // 如果连续空闲超过 3 个周期，延长到 2 倍周期才思考
          if (state.consecutiveIdleObserves > 15 && elapsed < cognitiveCycleMs * 2) {
            console.log(`[GameMaster] ${bot.name} 持续空闲，延长认知周期`);
            continue;
          }

          state.thinkScheduled = true;
          await triggerThink(bot, client, false, '');
          state.thinkScheduled = false;
        } else {
          // 观察阶段日志（精简）
          const nextThink = Math.max(0, Math.round((cognitiveCycleMs - elapsed) / 1000));
          const streamSize = state.memoryStream.stats.sinceLastThink;
          if (state.consecutiveIdleObserves < 3 || state.consecutiveIdleObserves % 5 === 0) {
            console.log(`[GameMaster] ${bot.name} 观察 | 记忆+${streamSize} | 下次思考: ${nextThink}s | HP:${status.health ?? '?'}/${status.food ?? '?'}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const key = bot.mcBotName ?? bot.name;
        if (msg.includes('重连冷却中')) {
          // 冷却期间静默跳过，不刷屏
          if ((mcpFailCount.get(key) ?? 0) <= 1) {
            console.log(`[GameMaster] ${bot.name} ${msg}`);
          }
        } else if (msg.includes('Connection closed') || msg.includes('offline') || msg.includes('Not connected') || msg.includes('ECONNREFUSED') || msg.includes('EPIPE')) {
          console.warn(`[GameMaster] ${bot.name} MCP 连接断开，等待冷却后重连...`);
          agentRegistry.markOffline(bot.name);
          mcpLastDisconnect.set(key, Date.now());
          mcpFailCount.set(key, (mcpFailCount.get(key) ?? 0) + 1);
          mcpClients.delete(key);
          mcpTransports.delete(key);
        } else {
          console.error(`[GameMaster] ${bot.name} 观察错误:`, msg);
        }
      }
    }
  };

  // 首次立即执行观察 + 思考
  await observeTick();
  // 首次启动强制思考
  for (const bot of bots) {
    try {
      const client = await getOrCreateMcpClient(bot);
      await triggerThink(bot, client, false, '初始启动');
    } catch (err) {
      console.error(`[GameMaster] ${bot.name} 初始思考失败:`, err);
    }
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

async function main(): Promise<void> {
  const config = await loadConfig();
  await runLoop(config);
}

main().catch((err) => {
  console.error('[GameMaster]', err);
  process.exit(1);
});
