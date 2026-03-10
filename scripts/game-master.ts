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
import { readFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { processPendingDeathIfAny } from '../src/mcp/deathReflection.js';
import { MemoryStream } from '../src/cognitive/memoryStream.js';
import { PlanExecutor } from '../src/cognitive/planExecutor.js';
import type { ObservationCategory } from '../src/cognitive/memoryStream.js';

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

// ─── Prompt 优先级 ───
type PromptTier = 'urgent' | 'normal' | 'cognitive';

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

  const srvConfig = getMcpServerConfig(bot.mcporterServer, bot.mcBotName ?? bot.name);
  const transport = new StdioClientTransport({
    command: srvConfig.command,
    args: srvConfig.args ?? [],
    env: srvConfig.env,
    cwd: srvConfig.cwd,
  });
  client = new Client({ name: 'game-master', version: '1.0.0' });
  await client.connect(transport);
  mcpClients.set(key, client);
  mcpTransports.set(key, transport);
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

  // 发现新敌对生物
  if (scanChanged && scanResult.includes('敌对生物') && !state.lastScan.includes('敌对生物')) {
    ms.add({ category: 'combat', importance: 9, content: '发现新敌对生物！' });
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

/** 判断是否需要紧急中断 */
function needsUrgentInterrupt(botName: string, status: BotStatus): { urgent: boolean; reason: string } {
  const state = getCogState(botName);

  // 死亡
  if (state.memoryStream.getSinceLastThink().some(o => o.category === 'death')) {
    return { urgent: true, reason: '死亡' };
  }

  // 低血量
  if (status.health !== undefined && status.health < (urgentHealthThreshold)) {
    return { urgent: true, reason: `低血量(${status.health})` };
  }

  // 受到伤害（血量下降）
  if (status.health !== undefined && status.health < state.lastHealth) {
    return { urgent: true, reason: '受到伤害' };
  }

  // 发现新敌对生物
  if (state.memoryStream.hasUrgent()) {
    return { urgent: true, reason: '紧急事件' };
  }

  // 玩家聊天（社交）
  if (state.memoryStream.getSinceLastThink().some(o => o.category === 'chat')) {
    return { urgent: true, reason: '收到聊天消息' };
  }

  return { urgent: false, reason: '' };
}

let urgentHealthThreshold = 6;

// ─── 认知周期 Prompt 构建 ───

function buildCognitivePrompt(
  botName: string,
  status: BotStatus,
  scanResult: string,
  memory: string,
  isUrgent: boolean,
  urgentReason: string,
): string {
  const state = getCogState(botName);
  const timeStr = status.isDay ? '白天' : '夜晚';
  const health = status.health ?? 20;
  const food = status.food ?? 20;
  const pos = status.position ? `(${status.position.x}, ${status.position.y}, ${status.position.z})` : '(?, ?, ?)';
  const hungerNote = food < 8 ? '（你很饿！）' : food < 14 ? '（建议补充食物）' : '';

  // 记忆流摘要
  const observations = state.memoryStream.summarizeForPrompt();

  // 上次计划执行摘要
  const planSummary = state.planExecutor.getExecutionSummary();

  const urgentTag = isUrgent ? `\n!! 紧急中断: ${urgentReason} — 请优先处理 !!\n` : '';

  return `${urgentTag}
【认知周期 - ${isUrgent ? '紧急' : '定期'}思考】

【生存准则】${memory || '（暂无）'}

【当前状态】
  ${timeStr} | 血量 ${health}/20 | 饥饿 ${food}/20${hungerNote} | 坐标 ${pos}
  背包: ${status.inventory ?? '空'}

【观察记录】
${observations}

【上周期执行情况】
${planSummary}

【当前视野】
${scanResult}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你是一个 Minecraft 生存 Bot。你每 3 分钟被唤醒一次来"思考"。

!! 极其重要 !!
1. 你必须只输出纯 JSON 文本。系统会自动读取你的 JSON 并执行其中的计划步骤。
2. 绝对不要调用任何 MCP 工具/tool_call/mcporter 命令！你没有权限直接执行工具。
3. 不要输出解释、markdown、代码块标记，只要纯 JSON。
4. 不存在 walk/wander/sleep/go/list_items/get_items 等命令。只有下面 7 个工具名可以写在计划中。

━━ 可用行动工具（7个）━━
1. move_to — 移动到坐标（唯一的移动方式）
   参数: { "x": 数字, "y": 数字, "z": 数字 }
   示例: { "tool": "move_to", "args": { "x": 100, "y": 64, "z": 200 }, "note": "去矿洞" }

2. mine — 挖掘/采集方块（挖矿、砍树、挖土都用这个）
   参数: { "block_type": "方块名" } 或 { "x": 数字, "y": 数字, "z": 数字 }
   常用方块名: stone, oak_log, birch_log, coal_ore, iron_ore, dirt, cobblestone
   示例: { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "砍树" }

3. chat — 发送聊天消息
   参数: { "message": "内容" }

4. equip — 手持/装备物品
   参数: { "item_name": "物品名" }
   示例: { "tool": "equip", "args": { "item_name": "wooden_pickaxe" }, "note": "装备木镐" }

5. attack — 攻击目标（持续攻击直到击杀）
   参数: { "target_name": "目标名" }
   示例: { "tool": "attack", "args": { "target_name": "zombie" }, "note": "击杀僵尸" }

6. eat — 吃东西恢复饥饿度
   参数: { "food_name": "食物名" } 或 {} (留空=自动选最好的)

7. craft — 合成物品（需背包有材料）
   参数: { "item_name": "物品名", "count": 数量 }
   常用: wooden_planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe

━━ 输出格式（严格遵守）━━
\`\`\`json
{
  "reflection": "1-2句话总结当前局势",
  "plan": [
    { "tool": "工具名", "args": { ... }, "note": "原因" },
    { "tool": "工具名", "args": { ... }, "note": "原因" }
  ]
}
\`\`\`

**规则**：
- 计划 3-8 个步骤
- ${isUrgent ? '!! 当前是紧急情况，优先处理威胁/生存 !!' : '按优先级安排：生存 > 采集资源 > 建造 > 交易'}
- 夜晚注意防御，可以挖洞躲避或找安全位置
- 只输出 JSON，不要解释`;
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
        statusMap[bot.name] = {
          hasPendingPrompt: pendingPrompts.has(bot.name),
          pendingTier: pendingPrompts.get(bot.name)?.tier,
          memoryStreamSize: ms?.stats.sinceLastThink ?? 0,
          planStatus: pe?.status ?? 'idle',
          planProgress: pe?.progress ?? '0/0',
          lastThinkTime: ms?.lastThinkTime ?? 0,
          nextThinkIn: ms ? Math.max(0, cognitiveCycleMs - (Date.now() - ms.lastThinkTime)) : 0,
          consecutiveIdle: state?.consecutiveIdleObserves ?? 0,
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

          // 解析计划
          if (!pe.loadPlan(planText)) {
            console.warn(`[GameMaster] ${botName} AI 返回了无法解析的计划: ${planText.slice(0, 200)}`);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Failed to parse plan JSON');
            return;
          }

          // 保存反思到记忆
          if (pe.lastReflection) {
            state.memoryStream.add({
              category: 'action_result',
              importance: 3,
              content: `AI 反思: ${pe.lastReflection}`,
            });
          }

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

  // ─── 执行 AI 计划 ───

  async function executePlanForBot(bot: BotConfig): Promise<void> {
    const state = getCogState(bot.name);
    const pe = state.planExecutor;
    if (!pe.currentStep) return;

    // 记录计划开始时间，只有在此之后的新紧急事件才中断
    const planStartTime = Date.now();

    try {
      const client = await getOrCreateMcpClient(bot);
      const results = await pe.execute(
        client,
        (result) => {
          const icon = result.success ? '+' : 'x';
          state.memoryStream.add({
            category: 'action_result',
            importance: result.success ? 2 : 5,
            content: `[${icon}] ${result.step.tool}${result.step.note ? `(${result.step.note})` : ''}: ${result.result.slice(0, 100)}`,
          });
          console.log(`[PlanExec] ${bot.name} [${icon}] ${result.step.tool}: ${result.result.slice(0, 80)}`);
        },
        // 中断检查：只有计划执行期间新产生的紧急事件才中断
        () => {
          const recentUrgent = state.memoryStream.getSinceLastThink()
            .filter(o => o.ts > planStartTime && o.importance >= 8);
          return recentUrgent.length > 0;
        },
      );

      console.log(`[PlanExec] ${bot.name} 计划执行完毕: ${results.length} 步，状态: ${pe.status}`);
    } catch (err) {
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

    // 处理死亡反思
    const processed = await processPendingDeathIfAny(bot.mcBotName ?? bot.name);
    if (processed) console.log(`[GameMaster] 已处理 ${bot.name} 的死亡反思`);

    // 获取当前状态
    const status = await getStatus(client);
    const scanResult = await getScan(client, 32);
    const memory = await readMemory(memoryDir, bot.name, bot.mcBotName);

    // 构建认知 prompt
    const prompt = buildCognitivePrompt(
      bot.name, status, scanResult, memory, isUrgent, urgentReason
    );

    const tier: PromptTier = isUrgent ? 'urgent' : 'cognitive';
    emitPrompt(bot.name, prompt, tier);

    // 标记思考完成
    state.memoryStream.markThinkDone();
    state.memoryStream.compact(30);
    state.planExecutor.reset();

    console.log(`[GameMaster] ${bot.name} 思考阶段触发 (${tier}: ${urgentReason || '定期'})，记忆流: ${state.memoryStream.stats.total} 条`);
  }

  // ─── 观察 Tick（轻量，零 token） ───

  const observeTick = async () => {
    for (const bot of bots) {
      try {
        const client = await getOrCreateMcpClient(bot);
        const state = getCogState(bot.name);

        // 1) 获取状态
        const status = await getStatus(client);

        // 如果 bot 正忙（正在执行之前的工具调用），跳过
        if (status.isBusy) {
          console.log(`[GameMaster] ${bot.name} isBusy(${status.currentAction})，跳过观察`);
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

        // 5) 检查紧急中断
        const { urgent, reason } = needsUrgentInterrupt(bot.name, status);
        if (urgent && !state.thinkScheduled) {
          console.log(`[GameMaster] ${bot.name} 紧急中断: ${reason}`);
          state.thinkScheduled = true;
          state.planExecutor.interrupt(reason);

          // 立即触发思考
          await triggerThink(bot, client, true, reason);
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
        if (msg.includes('Connection closed') || msg.includes('offline') || msg.includes('Not connected') || msg.includes('ECONNREFUSED')) {
          console.warn(`[GameMaster] ${bot.name} MCP 未就绪（请确认 Minecraft 已启动）`);
          const key = bot.mcBotName ?? bot.name;
          mcpClients.delete(key);
          mcpTransports.delete(key);
        } else {
          console.error(`[GameMaster] ${bot.name} 观察错误:`, err);
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
