/**
 * Memory Stream - 斯坦福 Generative Agents 式记忆流
 *
 * 在认知周期之间累积所有观察（事件、状态变化、扫描结果），
 * 思考阶段时一次性呈现给 AI，避免逐条发送导致 token 爆炸。
 *
 * 核心概念：
 * - Observation: 时间戳 + 类别 + 重要性 + 内容
 * - 重要性评分: urgent=10, normal=5, idle=1
 * - 压缩输出: 同类连续观察合并，减少 token
 */

export type ObservationCategory =
  | 'health_change'       // 血量/饥饿度变化
  | 'combat'              // 战斗相关（受伤、敌对生物）
  | 'chat'                // 聊天消息
  | 'environment'         // 环境变化（扫描结果、日夜）
  | 'death'               // 死亡
  | 'spawn'               // 重生
  | 'action_result'       // 本地规则执行结果
  | 'state_snapshot'      // 定时状态快照
  | 'habit_execution'     // 习惯层技能执行
  | 'critic_evaluation';  // Critic 评估结果

export interface Observation {
  ts: number;
  category: ObservationCategory;
  importance: number;  // 1-10
  content: string;
  raw?: unknown;       // 原始数据（不序列化给 AI）
}

export class MemoryStream {
  private observations: Observation[] = [];
  private readonly maxSize: number;

  /** 上一次思考阶段的时间（初始为当前时间，避免 elapsed 计算溢出） */
  lastThinkTime: number = Date.now();

  /** 上一次状态快照（用于增量比较） */
  private lastSnapshot: Record<string, unknown> = {};

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /** 添加观察 */
  add(obs: Omit<Observation, 'ts'> & { ts?: number }): void {
    const entry: Observation = { ts: Date.now(), ...obs };
    this.observations.push(entry);
    if (this.observations.length > this.maxSize) {
      this.observations.shift();
    }
  }

  /** 获取自上次思考以来的所有观察 */
  getSinceLastThink(): Observation[] {
    return this.observations.filter(o => o.ts > this.lastThinkTime);
  }

  /** 获取最高重要性（用于判断是否需要紧急中断） */
  getMaxImportanceSinceThink(): number {
    const recent = this.getSinceLastThink();
    if (recent.length === 0) return 0;
    return Math.max(...recent.map(o => o.importance));
  }

  /** 是否有紧急事件需要立即处理 */
  hasUrgent(): boolean {
    return this.getSinceLastThink().some(o => o.importance >= 8);
  }

  /** 标记思考完成，重置计时 */
  markThinkDone(): void {
    this.lastThinkTime = Date.now();
  }

  /** 清除已处理的观察（保留最近 N 条作为上下文） */
  compact(keepRecent = 20): void {
    if (this.observations.length > keepRecent) {
      this.observations = this.observations.slice(-keepRecent);
    }
  }

  /** 更新状态快照，返回变化的字段 */
  updateSnapshot(snapshot: Record<string, unknown>): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(snapshot)) {
      const strVal = JSON.stringify(value);
      if (strVal !== JSON.stringify(this.lastSnapshot[key])) {
        changed.push(key);
      }
    }
    this.lastSnapshot = { ...snapshot };
    return changed;
  }

  /**
   * 压缩输出：将累积的观察压缩为 AI 可读的摘要
   * 核心优化点 —— 同类事件合并，减少 token
   */
  summarizeForPrompt(): string {
    const recent = this.getSinceLastThink();
    if (recent.length === 0) return '本周期无新观察。';

    const elapsed = Math.round((Date.now() - this.lastThinkTime) / 1000);
    const lines: string[] = [`过去 ${elapsed} 秒内发生了 ${recent.length} 件事：`];

    // 按类别分组
    const groups = new Map<ObservationCategory, Observation[]>();
    for (const obs of recent) {
      if (!groups.has(obs.category)) groups.set(obs.category, []);
      groups.get(obs.category)!.push(obs);
    }

    // 优先级排序：combat > death > health > chat > environment > action > state
    const categoryOrder: ObservationCategory[] = [
      'death', 'combat', 'health_change', 'chat',
      'environment', 'action_result', 'spawn', 'state_snapshot',
    ];

    for (const cat of categoryOrder) {
      const items = groups.get(cat);
      if (!items || items.length === 0) continue;

      switch (cat) {
        case 'death':
          lines.push(`** 你死亡了！${items.length > 1 ? `(${items.length}次)` : ''}`);
          break;

        case 'combat': {
          // 合并战斗事件
          const damages = items.filter(i => i.content.includes('受伤'));
          const hostiles = items.filter(i => i.content.includes('敌对'));
          if (damages.length > 0) {
            lines.push(`- 战斗: 受到 ${damages.length} 次伤害`);
          }
          // 敌对生物只记最新一条
          if (hostiles.length > 0) {
            lines.push(`- ${hostiles[hostiles.length - 1].content}`);
          }
          // 其他战斗事件
          for (const item of items.filter(i => !i.content.includes('受伤') && !i.content.includes('敌对'))) {
            lines.push(`- ${item.content}`);
          }
          break;
        }

        case 'health_change': {
          // 只取最新的血量状态
          const last = items[items.length - 1];
          lines.push(`- 状态变化: ${last.content}`);
          break;
        }

        case 'chat': {
          // 聊天消息全部保留（重要的社交信息）
          for (const item of items) {
            lines.push(`- 聊天: ${item.content}`);
          }
          break;
        }

        case 'environment': {
          // 环境变化：合并，只保留最新扫描
          const timeChanges = items.filter(i => i.content.includes('日') || i.content.includes('夜'));
          const scans = items.filter(i => !i.content.includes('日') && !i.content.includes('夜'));
          if (timeChanges.length > 0) {
            lines.push(`- ${timeChanges[timeChanges.length - 1].content}`);
          }
          if (scans.length > 0) {
            lines.push(`- 环境变化 ${scans.length} 次（详见当前视野）`);
          }
          break;
        }

        case 'action_result': {
          // 本地规则动作
          for (const item of items) {
            lines.push(`- 自动动作: ${item.content}`);
          }
          break;
        }

        case 'spawn':
          lines.push(`- 重生${items.length > 1 ? ` ${items.length} 次` : ''}`);
          break;

        case 'state_snapshot':
          // 状态快照不输出（太冗余），仅做内部跟踪
          break;
      }
    }

    return lines.join('\n');
  }

  /** 统计信息 */
  get stats() {
    const recent = this.getSinceLastThink();
    return {
      total: this.observations.length,
      sinceLastThink: recent.length,
      maxImportance: recent.length > 0 ? Math.max(...recent.map(o => o.importance)) : 0,
      categories: [...new Set(recent.map(o => o.category))],
    };
  }
}
