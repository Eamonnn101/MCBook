/**
 * Critic Agent - 反思评估器
 *
 * 在计划执行完成后，比较执行前后的状态快照，
 * 评估目标完成度，更新技能成功率，并生成改进建议。
 */

import type { PlanExecResult, PlanStep } from './planExecutor.js';

export interface WorldSnapshot {
  health: number;
  food: number;
  position: { x: number; y: number; z: number } | null;
  inventory: string;
  isDay: boolean;
}

export interface CriticEvaluation {
  /** 总体评分 0-10 */
  score: number;
  /** 完成的目标 */
  goalsAchieved: string[];
  /** 失败的目标 */
  goalsFailed: string[];
  /** 背包变化 */
  inventoryDelta: { gained: string[]; lost: string[] };
  /** 血量变化 */
  healthDelta: number;
  /** 饥饿度变化 */
  foodDelta: number;
  /** 使用的技能/工具 */
  toolsUsed: string[];
  /** 改进建议 */
  recommendations: string[];
  /** 是否有连续失败的工具 */
  repeatedFailures: Map<string, number>;
}

/**
 * 评估计划执行结果
 */
export function evaluate(
  preState: WorldSnapshot,
  postState: WorldSnapshot,
  results: PlanExecResult[],
  planSteps: PlanStep[],
): CriticEvaluation {
  const goalsAchieved: string[] = [];
  const goalsFailed: string[] = [];
  const recommendations: string[] = [];
  const toolsUsed: string[] = [];
  const repeatedFailures = new Map<string, number>();

  // 分析每步结果
  let successCount = 0;
  for (const r of results) {
    toolsUsed.push(r.step.tool);
    if (r.success) {
      successCount++;
      const note = r.step.note ?? r.step.tool;
      goalsAchieved.push(note);
    } else {
      const note = r.step.note ?? r.step.tool;
      goalsFailed.push(`${note}: ${r.result.slice(0, 60)}`);
      // 统计连续失败
      const key = r.step.tool;
      repeatedFailures.set(key, (repeatedFailures.get(key) ?? 0) + 1);
    }
  }

  // 背包变化
  const preItems = parseInventory(preState.inventory);
  const postItems = parseInventory(postState.inventory);
  const gained: string[] = [];
  const lost: string[] = [];

  for (const [item, count] of postItems) {
    const prev = preItems.get(item) ?? 0;
    if (count > prev) gained.push(`+${count - prev} ${item}`);
  }
  for (const [item, count] of preItems) {
    const post = postItems.get(item) ?? 0;
    if (post < count) lost.push(`-${count - post} ${item}`);
  }

  // 血量/饥饿变化
  const healthDelta = postState.health - preState.health;
  const foodDelta = postState.food - preState.food;

  // 评分
  let score = 5; // 基础分

  // 成功率加分
  const successRate = results.length > 0 ? successCount / results.length : 0;
  score += successRate * 3; // 最多 +3

  // 资源获取加分
  if (gained.length > 0) score += Math.min(gained.length * 0.5, 2);
  if (lost.length > 0) score -= Math.min(lost.length * 0.3, 1);

  // 血量变化
  if (healthDelta < -5) score -= 1;
  if (healthDelta < -10) score -= 1;

  // 饥饿变化
  if (foodDelta < -5) score -= 0.5;

  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

  // 生成建议
  if (successRate < 0.5) {
    recommendations.push('计划成功率低，考虑简化步骤或先确认资源充足');
  }
  if (healthDelta < -5) {
    recommendations.push('血量损失严重，考虑先回血或避开危险区域');
  }
  if (foodDelta < -8) {
    recommendations.push('饥饿度下降过多，优先补充食物');
  }
  for (const [tool, count] of repeatedFailures) {
    if (count >= 2) {
      recommendations.push(`"${tool}" 连续失败 ${count} 次，考虑更换策略`);
    }
  }
  if (gained.length === 0 && lost.length === 0 && successCount > 0) {
    recommendations.push('行动成功但无资源变化，可能需要更有效的目标');
  }

  return {
    score,
    goalsAchieved,
    goalsFailed,
    inventoryDelta: { gained, lost },
    healthDelta,
    foodDelta,
    toolsUsed: [...new Set(toolsUsed)],
    recommendations,
    repeatedFailures,
  };
}

/** 生成供 prompt 注入的评估摘要 */
export function summarizeForPrompt(eval_: CriticEvaluation): string {
  const parts: string[] = [];
  parts.push(`评分: ${eval_.score}/10`);

  if (eval_.goalsAchieved.length > 0) {
    parts.push(`完成: ${eval_.goalsAchieved.slice(0, 3).join(', ')}`);
  }
  if (eval_.goalsFailed.length > 0) {
    parts.push(`失败: ${eval_.goalsFailed.slice(0, 3).join(', ')}`);
  }
  if (eval_.inventoryDelta.gained.length > 0) {
    parts.push(`获得: ${eval_.inventoryDelta.gained.join(', ')}`);
  }
  if (eval_.inventoryDelta.lost.length > 0) {
    parts.push(`失去: ${eval_.inventoryDelta.lost.join(', ')}`);
  }
  if (eval_.healthDelta !== 0) {
    parts.push(`血量变化: ${eval_.healthDelta > 0 ? '+' : ''}${eval_.healthDelta}`);
  }
  if (eval_.recommendations.length > 0) {
    parts.push(`建议: ${eval_.recommendations.join('; ')}`);
  }

  return parts.join(' | ');
}

/** 解析背包字符串为 Map */
function parseInventory(inv: string): Map<string, number> {
  const items = new Map<string, number>();
  if (!inv || inv === '空' || inv === '') return items;

  // 格式: "oak_log x10, cobblestone x32, ..."
  const parts = inv.split(',').map(s => s.trim());
  for (const part of parts) {
    const match = part.match(/^(\S+)\s+x(\d+)$/);
    if (match) {
      items.set(match[1], parseInt(match[2]));
    }
  }
  return items;
}
