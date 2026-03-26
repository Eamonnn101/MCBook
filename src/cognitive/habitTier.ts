/**
 * Habit Tier - System 0.5 习惯层
 *
 * 在 LLM 调用之前尝试匹配已有技能。
 * 如果技能匹配度高且成功率好，直接执行技能，跳过 LLM。
 * 目标延迟: <500ms（只涉及文件读取 + 字符串匹配）
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { skillLibrary, type SkillMeta } from '../skills/skillLibrary.js';
import { findRelevantSkills } from '../skills/skillRetrieval.js';
import { executeSkill } from '../skills/skillExecutor.js';
import type { Observation } from './memoryStream.js';

export interface HabitMatchResult {
  matched: boolean;
  skillName?: string;
  similarity?: number;
  successRate?: number;
}

export interface HabitExecResult {
  executed: boolean;
  skillName?: string;
  success?: boolean;
  result?: string;
  durationMs?: number;
}

/** 匹配阈值 */
const SIMILARITY_THRESHOLD = 0.85;
const SUCCESS_RATE_THRESHOLD = 0.7;
const MIN_USES_THRESHOLD = 3;

/**
 * 尝试从技能库中匹配当前情境
 * @param agentName - Agent 名称
 * @param observations - 最近的观察记录
 * @param context - 额外上下文（当前状态摘要）
 * @returns 匹配结果
 */
export async function tryMatchHabit(
  agentName: string,
  observations: Observation[],
  context: string = '',
): Promise<HabitMatchResult> {
  // 构建任务描述（从最近观察中提取关键信息）
  const taskDesc = buildTaskDescription(observations, context);
  if (!taskDesc) return { matched: false };

  // 获取可用技能
  const skills = await skillLibrary.listAvailable(agentName);
  if (skills.length === 0) return { matched: false };

  // 检索匹配技能
  const matches = findRelevantSkills(taskDesc, skills, 1);
  if (matches.length === 0) return { matched: false };

  const best = matches[0];
  const meta = best.skill;
  const total = meta.successCount + meta.failCount;
  const successRate = skillLibrary.getSuccessRate(meta);

  // 检查匹配度和成功率
  if (best.similarity < SIMILARITY_THRESHOLD) return { matched: false };
  if (total < MIN_USES_THRESHOLD) return { matched: false };
  if (successRate < SUCCESS_RATE_THRESHOLD) return { matched: false };

  return {
    matched: true,
    skillName: meta.name,
    similarity: best.similarity,
    successRate,
  };
}

/**
 * 执行匹配到的技能
 */
export async function executeHabit(
  agentName: string,
  skillName: string,
  client: Client,
): Promise<HabitExecResult> {
  const startMs = Date.now();

  // 确定技能所有者（先找私有，再找共享）
  let owner = agentName;
  let meta = await skillLibrary.getMeta(agentName, skillName);
  if (!meta) {
    meta = await skillLibrary.getMeta('shared', skillName);
    owner = 'shared';
  }
  if (!meta) {
    return { executed: false };
  }

  const result = await executeSkill(owner, skillName, client, agentName);

  return {
    executed: true,
    skillName,
    success: result.success,
    result: result.result,
    durationMs: Date.now() - startMs,
  };
}

/** 从观察记录构建任务描述 */
function buildTaskDescription(observations: Observation[], context: string): string {
  const parts: string[] = [];

  // 最近的重要观察
  const important = observations
    .filter(o => o.importance >= 5)
    .slice(-5)
    .map(o => o.content);

  if (important.length > 0) {
    parts.push(important.join('; '));
  }

  if (context) parts.push(context);

  return parts.join('. ');
}
