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
  'move_to', 'mine', 'chat', 'equip', 'attack', 'eat', 'craft',
  'get_scan', 'get_surrounding_blocks', 'get_inventory', 'get_health',
  'get_position', 'get_status', 'get_pending_events',
]);

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
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed)) {
        this.plan = this.validateSteps(parsed);
        this.reflection = '';
      } else if (parsed && typeof parsed === 'object') {
        this.plan = this.validateSteps(parsed.plan ?? parsed.steps ?? []);
        this.reflection = parsed.reflection ?? parsed.summary ?? '';
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
      console.error('[PlanExecutor] 解析计划失败:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private validateSteps(steps: unknown[]): PlanStep[] {
    const valid: PlanStep[] = [];
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      const step = s as Record<string, unknown>;
      const tool = String(step.tool ?? step.action ?? '');
      if (!ALLOWED_TOOLS.has(tool)) {
        console.warn(`[PlanExecutor] 跳过不允许的工具: ${tool}`);
        continue;
      }
      valid.push({
        tool,
        args: (step.args ?? step.arguments ?? {}) as Record<string, unknown>,
        note: step.note ? String(step.note) : step.reason ? String(step.reason) : undefined,
      });
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

  /** 执行整个计划 */
  async execute(
    client: Client,
    onStepDone?: (result: PlanExecResult) => void,
    checkInterrupt?: () => boolean,
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

        const result = await client.callTool({
          name: step.tool,
          arguments: step.args,
        });

        const contentArr = Array.isArray(result.content) ? result.content : [];
        const text = contentArr.find((x: Record<string, unknown>) => x.type === 'text');
        const resultText = (text && 'text' in text ? String(text.text) : '') ?? '';
        const execResult: PlanExecResult = {
          step,
          success: !resultText.includes('失败'),
          result: resultText.slice(0, 200),
          durationMs: Date.now() - startMs,
        };

        this.results.push(execResult);
        onStepDone?.(execResult);

        // 如果步骤失败且是关键动作，跳过剩余计划
        if (!execResult.success && ['move_to', 'mine', 'attack'].includes(step.tool)) {
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
