/**
 * Plan Executor - 本地执行 AI 生成的行动计划（零 token）
 *
 * 斯坦福 Generative Agents 的核心思路：
 * AI 每 3 分钟"思考"一次，输出一个多步骤计划，
 * 然后 Plan Executor 逐步执行这些步骤，无需再次调用 AI。
 *
 * 计划格式：
 * [
 *   { "tool": "move_to", "args": { "x": 100, "y": 64, "z": 200 }, "note": "去矿洞" },
 *   { "tool": "mine", "args": { "block_type": "stone" }, "note": "挖石头" },
 *   { "tool": "chat", "args": { "message": "有人想交易吗？" }, "note": "找交易" }
 * ]
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

export interface PlanExecResult {
  step: PlanStep;
  success: boolean;
  result: string;
  durationMs: number;
}

export type PlanStatus = 'idle' | 'executing' | 'interrupted' | 'completed';

// 允许执行的工具白名单（防止注入）
const ALLOWED_TOOLS = new Set([
  'move_to', 'mine', 'chat', 'equip', 'attack', 'eat', 'craft', 'find_blocks', 'place',
  'get_scan', 'get_surrounding_blocks', 'get_inventory', 'get_health',
  'get_position', 'get_status', 'get_pending_events',
  // 社交工具
  'send_chat', 'query_agent_status', 'request_trade', 'accept_trade', 'reject_trade',
  'get_pending_trades', 'form_team', 'leave_team', 'set_waypoint', 'get_waypoints',
  'get_social_summary',
  // 技能库工具
  'use_skill', 'list_skills',
]);

/**
 * 工具名模糊映射 — 将 AI 乱写的工具名修正为合法的 7 个工具之一
 * 例: "minecraft:craft_planks" → "craft", "minecraft:harvest_grass" → "mine"
 */
function normalizeToolName(raw: string): string | null {
  // 去掉 minecraft: 或其他前缀
  const name = raw.replace(/^minecraft:/, '').toLowerCase();

  // 直接匹配
  if (ALLOWED_TOOLS.has(name)) return name;

  // 模糊映射表
  const TOOL_ALIASES: Record<string, string> = {
    // craft 变体
    craft_planks: 'craft', craft_sticks: 'craft', craft_tools: 'craft',
    craft_table: 'craft', craft_crafting_table: 'craft', craft_pickaxe: 'craft',
    craft_sword: 'craft', craft_axe: 'craft', craft_shovel: 'craft',
    craft_bread: 'craft', craft_seeds: 'craft',
    // mine 变体
    harvest: 'mine', harvest_grass: 'mine', gather: 'mine',
    gather_resources: 'mine', chop: 'mine', dig: 'mine', break: 'mine',
    collect: 'mine', harvest_wood: 'mine', chop_tree: 'mine',
    // move 变体
    walk: 'move_to', go: 'move_to', move: 'move_to', wander: 'move_to',
    run: 'move_to', travel: 'move_to', goto: 'move_to', walk_to: 'move_to',
    // attack 变体
    fight: 'attack', kill: 'attack', hit: 'attack', hunt: 'attack',
    // equip 变体
    hold: 'equip', wear: 'equip', use_item: 'equip', switch_item: 'equip',
    // eat 变体
    consume: 'eat', feed: 'eat', drink: 'eat',
    // chat 变体
    say: 'chat', tell: 'chat', speak: 'chat', message: 'chat',
    // find 变体
    find: 'find_blocks', search: 'find_blocks', locate: 'find_blocks',
    find_block: 'find_blocks', search_block: 'find_blocks', locate_block: 'find_blocks',
    find_resource: 'find_blocks', search_resource: 'find_blocks',
    // place 变体
    build: 'place', put: 'place', set: 'place',
    // 社交工具变体
    trade: 'request_trade', propose_trade: 'request_trade', trade_request: 'request_trade',
    whisper: 'send_chat', talk: 'send_chat', msg: 'send_chat',
    query_status: 'query_agent_status', check_agent: 'query_agent_status',
    create_team: 'form_team', join_team: 'form_team',
    add_waypoint: 'set_waypoint', mark_location: 'set_waypoint',
    list_waypoints: 'get_waypoints', pending_trades: 'get_pending_trades',
    decline_trade: 'reject_trade', refuse_trade: 'reject_trade',
    // 技能库变体
    run_skill: 'use_skill', exec_skill: 'use_skill', execute_skill: 'use_skill',
    skills: 'list_skills', show_skills: 'list_skills',
  };

  if (TOOL_ALIASES[name]) return TOOL_ALIASES[name];

  // 部分匹配：包含关键词
  if (name.includes('craft')) return 'craft';
  if (name.includes('mine') || name.includes('harvest') || name.includes('gather') || name.includes('chop') || name.includes('dig')) return 'mine';
  if (name.includes('move') || name.includes('walk') || name.includes('go')) return 'move_to';
  if (name.includes('attack') || name.includes('fight') || name.includes('kill')) return 'attack';
  if (name.includes('equip') || name.includes('hold') || name.includes('wear')) return 'equip';
  if (name.includes('eat') || name.includes('consum')) return 'eat';
  if (name.includes('chat') || name.includes('say') || name.includes('speak')) return 'chat';
  if (name.includes('find') || name.includes('search') || name.includes('locate')) return 'find_blocks';
  if (name.includes('place') || name.includes('build') || name.includes('put')) return 'place';

  return null;
}

/** 修正过时/错误的物品名 (1.21 兼容) */
function normalizeItemName(name: string): string {
  const ITEM_ALIASES: Record<string, string> = {
    wooden_planks: 'oak_planks',
    wood_planks: 'oak_planks',
    planks: 'oak_planks',
    wood: 'oak_log',
    log: 'oak_log',
    cobble: 'cobblestone',
    wood_pickaxe: 'wooden_pickaxe',
    wood_sword: 'wooden_sword',
    wood_axe: 'wooden_axe',
    wood_shovel: 'wooden_shovel',
  };
  return ITEM_ALIASES[name] ?? name;
}

/**
 * 修正 AI 输出的非标准参数名
 * 例: craft_planks { material: "oak_log" } → craft { item_name: "wooden_planks" }
 */
function normalizeArgs(tool: string, args: Record<string, unknown>, rawTool: string): Record<string, unknown> {
  const cleanRaw = rawTool.replace(/^minecraft:/, '').toLowerCase();

  if (tool === 'craft') {
    // AI 写了 "craft_planks" 但 args 里没 item_name → 从工具名推断
    if (!args.item_name) {
      const craftMap: Record<string, string> = {
        craft_planks: 'oak_planks', craft_sticks: 'stick',
        craft_table: 'crafting_table', craft_crafting_table: 'crafting_table',
        craft_pickaxe: 'wooden_pickaxe', craft_sword: 'wooden_sword',
        craft_axe: 'wooden_axe', craft_shovel: 'wooden_shovel',
        craft_bread: 'bread',
      };
      const inferred = craftMap[cleanRaw];
      if (inferred) {
        // 检查 args 里是否有暗示 stone 的材料
        const argsStr = JSON.stringify(args).toLowerCase();
        let itemName = inferred;
        if (argsStr.includes('stone') || argsStr.includes('cobblestone')) {
          itemName = inferred.replace('wooden_', 'stone_');
        }
        return { item_name: itemName, count: args.count ?? args.quantity ?? 1 };
      }
      // craft_tools: 多工具一起合成 → 拆成第一个
      if (cleanRaw === 'craft_tools') {
        const tools = args as Record<string, unknown>;
        const first = tools.axe ?? tools.pickaxe ?? tools.sword ?? tools.shovel;
        if (first) return { item_name: String(first), count: 1 };
      }
      // 有 material/item 参数但不是 item_name
      const fallback = args.material ?? args.item ?? args.output ?? args.from;
      if (fallback) return { item_name: String(fallback), count: args.count ?? args.quantity ?? 1 };
    }
    // 确保 count 存在 + 修正过时物品名
    const fixedArgs: Record<string, unknown> = { ...args, count: args.count ?? args.quantity ?? 1 };
    if (typeof fixedArgs.item_name === 'string') {
      fixedArgs.item_name = normalizeItemName(fixedArgs.item_name as string);
    }
    return fixedArgs;
  }

  if (tool === 'mine') {
    if (!args.block_type && !args.x) {
      // AI 可能用 target/material/block 或 targets 数组
      let target = args.target ?? args.material ?? args.block ?? args.resource;
      if (!target && Array.isArray(args.targets) && args.targets.length > 0) {
        target = args.targets[0];
      }
      if (target) return { block_type: String(target) };
      // 从原始工具名推断: harvest_grass → grass_block, harvest_wood → oak_log
      const mineMap: Record<string, string> = {
        harvest_grass: 'grass_block', harvest_wood: 'oak_log',
        chop_tree: 'oak_log', gather_resources: 'oak_log',
      };
      if (mineMap[cleanRaw]) return { block_type: mineMap[cleanRaw] };
    }
    return args;
  }

  if (tool === 'move_to') {
    // 确保有 x, y, z
    return args;
  }

  if (tool === 'attack') {
    if (!args.target_name) {
      const target = args.target ?? args.mob ?? args.entity;
      if (target) return { target_name: String(target) };
    }
    return args;
  }

  if (tool === 'equip') {
    if (!args.item_name) {
      const item = args.item ?? args.tool ?? args.weapon;
      if (item) return { item_name: String(item) };
    }
    return args;
  }

  if (tool === 'eat') {
    if (!args.food_name && args.food) {
      return { food_name: String(args.food) };
    }
    return args;
  }

  if (tool === 'find_blocks') {
    if (!args.block_type) {
      const target = args.target ?? args.block ?? args.resource ?? args.type;
      if (target) return { block_type: String(target), count: args.count ?? 5 };
    }
    return args;
  }

  if (tool === 'place') {
    if (!args.block_name) {
      const block = args.block ?? args.item ?? args.material;
      if (block) return { ...args, block_name: String(block) };
    }
    return args;
  }

  return args;
}

/**
 * 尝试修复截断/不完整的 JSON
 * LLM 经常输出被截断的 JSON（缺少结尾的 ]} 等）
 */
function tryRepairJson(raw: string): unknown | null {
  // 策略 1: 补全缺失的括号
  let str = raw.trim();

  // 去掉末尾不完整的字符串值（截断在引号内）
  // 例: ..."note":"礼貌但谨慎  → 补全引号
  const lastQuote = str.lastIndexOf('"');
  if (lastQuote > 0) {
    // 检查最后一个引号之后是否有未闭合的情况
    const afterLast = str.slice(lastQuote + 1).trim();
    // 如果最后一个引号后没有有效的 JSON 结构符号，说明截断在值中间
    if (afterLast === '' || /^[^}\],:]/.test(afterLast)) {
      // 截断在引号内或值之后，尝试在最后一个完整的键值对处截断
      str = str.slice(0, lastQuote + 1);
    }
  }

  // 计算未闭合的括号
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;

  for (const ch of str) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }

  // 补全缺失的闭合符号
  while (brackets > 0) { str += ']'; brackets--; }
  while (braces > 0) { str += '}'; braces--; }

  try {
    return JSON.parse(str);
  } catch { /* try next strategy */ }

  // 策略 2: 找到最后一个完整的 plan step 对象，截断到那里
  const lastCompleteObj = str.lastIndexOf('},');
  if (lastCompleteObj > 0) {
    const truncated = str.slice(0, lastCompleteObj + 1);
    // 补全括号
    let b = 0; let k = 0;
    let inStr = false; let esc = false;
    for (const ch of truncated) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') b++; else if (ch === '}') b--;
      if (ch === '[') k++; else if (ch === ']') k--;
    }
    let fixed = truncated;
    while (k > 0) { fixed += ']'; k--; }
    while (b > 0) { fixed += '}'; b--; }
    try { return JSON.parse(fixed); } catch { /* give up */ }
  }

  return null;
}

export class PlanExecutor {
  private plan: PlanStep[] = [];
  private currentIndex: number = 0;
  private _status: PlanStatus = 'idle';
  private _interrupted: boolean = false;
  private results: PlanExecResult[] = [];
  private reflection: string = '';

  get status(): PlanStatus { return this._status; }
  get currentStep(): PlanStep | null { return this.plan[this.currentIndex] ?? null; }
  get progress(): string { return `${this.currentIndex}/${this.plan.length}`; }
  get isRunning(): boolean { return this._status === 'executing'; }
  get lastReflection(): string { return this.reflection; }
  get executionResults(): PlanExecResult[] { return [...this.results]; }

  /**
   * 解析 AI 返回的计划 JSON
   * 支持两种格式：
   * 1. 纯 JSON 数组
   * 2. 包含 reflection + plan 的对象
   */
  loadPlan(raw: string): boolean {
    try {
      // 尝试从 markdown 代码块中提取 JSON
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      let jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

      // 尝试修复截断的 JSON（LLM 输出常见问题）
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = tryRepairJson(jsonStr);
        if (parsed) {
          console.log('[PlanExecutor] JSON 已自动修复（截断/不完整）');
        }
      }

      if (parsed === undefined || parsed === null) {
        console.error('[PlanExecutor] 解析计划失败: 无法解析或修复 JSON');
        return false;
      }

      if (Array.isArray(parsed)) {
        this.plan = this.validateSteps(parsed);
        this.reflection = '';
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        this.plan = this.validateSteps((obj.plan ?? obj.steps ?? []) as unknown[]);
        this.reflection = String(obj.reflection ?? obj.summary ?? '');
      } else {
        return false;
      }

      this.currentIndex = 0;
      this._status = this.plan.length > 0 ? 'idle' : 'completed';
      this._interrupted = false;
      this.results = [];
      console.log(`[PlanExecutor] 计划已加载: ${this.plan.length} 步`);
      if (this.reflection) {
        console.log(`[PlanExecutor] 反思: ${this.reflection.slice(0, 100)}`);
      }
      return true;
    } catch (err) {
      // loadPlan 外层 try 兜底（不应到达）
      console.error('[PlanExecutor] 解析计划失败:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private validateSteps(steps: unknown[]): PlanStep[] {
    const valid: PlanStep[] = [];
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      const step = s as Record<string, unknown>;
      const rawTool = String(step.tool ?? step.action ?? '');
      const cleanRaw = rawTool.replace(/^minecraft:/, '').toLowerCase();
      const tool = normalizeToolName(rawTool);
      if (!tool) {
        console.warn(`[PlanExecutor] 跳过无法识别的工具: ${rawTool}`);
        continue;
      }
      if (tool !== rawTool) {
        console.log(`[PlanExecutor] 工具名修正: ${rawTool} → ${tool}`);
      }

      const rawArgs = (step.args ?? step.arguments ?? {}) as Record<string, unknown>;
      const noteStr = step.note ? String(step.note) : step.reason ? String(step.reason) : undefined;

      // 展开 craft_tools: { axe: "wooden_axe", pickaxe: "wooden_pickaxe" } → 多个 craft 步骤
      if (tool === 'craft' && cleanRaw === 'craft_tools') {
        const toolArgs = rawArgs as Record<string, unknown>;
        for (const [key, val] of Object.entries(toolArgs)) {
          if (typeof val === 'string' && val.includes('_')) {
            valid.push({ tool: 'craft', args: { item_name: val, count: 1 }, note: `craft ${key}` });
            console.log(`[PlanExecutor] 展开 craft_tools: craft ${val}`);
          }
        }
        continue;
      }

      const args = normalizeArgs(tool, rawArgs, rawTool);
      valid.push({ tool, args, note: noteStr });
    }
    return valid;
  }

  /** 中断当前计划（紧急事件触发） */
  interrupt(reason: string): void {
    if (this._status === 'executing' || this._status === 'idle') {
      this._interrupted = true;
      this._status = 'interrupted';
      console.log(`[PlanExecutor] 计划被中断: ${reason} (已执行 ${this.progress})`);
    }
  }

  /** 社交工具名集合（在 Game Master 进程中本地执行，不通过 MCP Client） */
  private static SOCIAL_TOOLS = new Set([
    'send_chat', 'query_agent_status', 'request_trade', 'accept_trade', 'reject_trade',
    'get_pending_trades', 'form_team', 'leave_team', 'set_waypoint', 'get_waypoints',
    'get_social_summary', 'share_skill',
  ]);

  /** 执行整个计划 */
  async execute(
    client: Client,
    onStepDone?: (result: PlanExecResult) => void,
    checkInterrupt?: () => boolean,
    socialToolHandler?: (tool: string, args: Record<string, unknown>) => string | Promise<string>,
  ): Promise<PlanExecResult[]> {
    if (this.plan.length === 0) return [];
    this._status = 'executing';
    this._interrupted = false;

    while (this.currentIndex < this.plan.length) {
      // 检查中断
      if (this._interrupted || (checkInterrupt && checkInterrupt())) {
        this._status = 'interrupted';
        console.log(`[PlanExecutor] 中断于第 ${this.currentIndex + 1} 步`);
        break;
      }

      const step = this.plan[this.currentIndex];
      const startMs = Date.now();

      try {
        console.log(`[PlanExecutor] 执行 ${this.currentIndex + 1}/${this.plan.length}: ${step.tool}${step.note ? ` (${step.note})` : ''}`);

        let resultText: string;

        // 社交工具在 Game Master 进程中本地执行
        if (PlanExecutor.SOCIAL_TOOLS.has(step.tool) && socialToolHandler) {
          resultText = await Promise.resolve(socialToolHandler(step.tool, step.args));
        } else {
          const result = await client.callTool({
            name: step.tool,
            arguments: step.args,
          });

          const contentArr = Array.isArray(result.content) ? result.content : [];
          const text = contentArr.find((x: Record<string, unknown>) => x.type === 'text');
          resultText = (text && 'text' in text ? String(text.text) : '') ?? '';
        }
        const isFail = resultText.includes('失败') || resultText.includes('未找到') || resultText.includes('找不到');
        const execResult: PlanExecResult = {
          step,
          success: !isFail,
          result: resultText.slice(0, 200),
          durationMs: Date.now() - startMs,
        };

        this.results.push(execResult);
        onStepDone?.(execResult);

        // 如果步骤失败且是关键动作，跳过剩余计划（mine 找不到 → craft 必然失败）
        if (!execResult.success && ['move_to', 'mine', 'attack', 'craft'].includes(step.tool)) {
          console.warn(`[PlanExecutor] 关键步骤失败，中止计划: ${resultText.slice(0, 100)}`);
          this._status = 'interrupted';
          break;
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PlanExecutor] 步骤 ${this.currentIndex + 1} 错误: ${msg}`);
        this.results.push({
          step,
          success: false,
          result: msg.slice(0, 200),
          durationMs: Date.now() - startMs,
        });
        // 连接错误则中断
        if (msg.includes('Connection') || msg.includes('offline')) {
          this._status = 'interrupted';
          break;
        }
      }

      this.currentIndex++;
    }

    if (this._status === 'executing') {
      this._status = 'completed';
      console.log(`[PlanExecutor] 计划完成: ${this.results.length} 步`);
    }

    return this.results;
  }

  /** 获取执行摘要（用于下次思考的上下文） */
  getExecutionSummary(): string {
    if (this.results.length === 0) return '上周期无执行计划。';

    const lines = [`上周期计划执行情况 (${this.results.length}/${this.plan.length} 步):`];
    for (const r of this.results) {
      const icon = r.success ? '+' : 'x';
      lines.push(`  [${icon}] ${r.step.tool}${r.step.note ? ` (${r.step.note})` : ''}: ${r.result.slice(0, 80)}`);
    }

    if (this._status === 'interrupted') {
      lines.push(`  (计划被中断，剩余 ${this.plan.length - this.currentIndex} 步未执行)`);
    }

    return lines.join('\n');
  }

  /** 重置 */
  reset(): void {
    this.plan = [];
    this.currentIndex = 0;
    this._status = 'idle';
    this._interrupted = false;
    this.results = [];
    this.reflection = '';
  }
}
