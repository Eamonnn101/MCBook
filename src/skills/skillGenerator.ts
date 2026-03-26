/**
 * Skill Generator - 从成功的计划中提取可复用技能
 *
 * 当 PlanExecutor 成功执行一个计划后，尝试将其转换为可复用的 JS 技能。
 * 技能代码由计划步骤模板化生成，而非 AI 重新编写。
 */

import type { PlanStep, PlanExecResult } from '../cognitive/planExecutor.js';
import { skillLibrary, type SkillMeta } from './skillLibrary.js';

/**
 * 从成功执行的计划中提取技能
 * @param planSteps - 原始计划步骤
 * @param results - 执行结果
 * @param reflection - AI 的反思文本
 * @param agentName - 创建者名称
 * @returns 生成的技能名称，null 表示未生成
 */
export async function maybeGenerateSkill(
  planSteps: PlanStep[],
  results: PlanExecResult[],
  reflection: string,
  agentName: string,
): Promise<string | null> {
  // 条件：至少 3 步、全部成功、包含有意义的动作
  if (planSteps.length < 3) return null;
  if (results.some(r => !r.success)) return null;

  const actionSteps = planSteps.filter(s =>
    ['mine', 'craft', 'move_to', 'place', 'attack'].includes(s.tool),
  );
  if (actionSteps.length < 2) return null;

  // 生成技能名称（基于主要动作）
  const primaryTool = actionSteps[0].tool;
  const primaryTarget = getTargetName(actionSteps[0]);
  const name = generateSkillName(primaryTool, primaryTarget, planSteps);

  // 检查是否已存在
  const existing = await skillLibrary.getMeta(agentName, name);
  if (existing) return null;
  const sharedExisting = await skillLibrary.getMeta('shared', name);
  if (sharedExisting) return null;

  // 生成代码
  const code = generateSkillCode(planSteps);
  const description = generateDescription(planSteps, reflection);
  const tags = extractTags(planSteps);

  const meta: SkillMeta = {
    name,
    description,
    tags,
    successCount: 1,
    failCount: 0,
    author: agentName,
    shared: false,
    deprecated: false,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };

  await skillLibrary.saveSkill(agentName, name, code, meta);
  console.log(`[SkillGenerator] ${agentName} 生成新技能: ${name} (${planSteps.length} 步)`);
  return name;
}

/** 从计划步骤生成 JS 代码 */
function generateSkillCode(steps: PlanStep[]): string {
  const lines: string[] = [
    '// 自动生成的技能',
    `// 步骤数: ${steps.length}`,
    '',
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const argsStr = JSON.stringify(step.args);
    if (step.note) lines.push(`// ${step.note}`);
    lines.push(`log('步骤 ${i + 1}: ${step.tool}');`);
    lines.push(`await callTool('${step.tool}', ${argsStr});`);
    lines.push('');
  }

  lines.push("log('技能执行完成');");
  return lines.join('\n');
}

/** 生成技能名称 */
function generateSkillName(primaryTool: string, target: string, steps: PlanStep[]): string {
  const toolNames = [...new Set(steps.map(s => s.tool))];
  if (toolNames.length === 1) {
    return `${primaryTool}_${target}`.replace(/\s+/g, '_').toLowerCase();
  }
  // 组合名称
  const prefix = toolNames.slice(0, 2).join('_and_');
  return `${prefix}_${target}`.replace(/\s+/g, '_').toLowerCase();
}

/** 从步骤获取目标名称 */
function getTargetName(step: PlanStep): string {
  const args = step.args;
  return String(
    args.block_type ?? args.item_name ?? args.target_name ?? args.block_name ?? 'task',
  );
}

/** 生成描述 */
function generateDescription(steps: PlanStep[], reflection: string): string {
  const stepDescs = steps.map(s => {
    const target = getTargetName(s);
    return `${s.tool}(${target})`;
  }).join(' → ');

  return reflection
    ? `${reflection}. 步骤: ${stepDescs}`
    : `执行 ${stepDescs}`;
}

/** 提取标签 */
function extractTags(steps: PlanStep[]): string[] {
  const tags = new Set<string>();
  for (const step of steps) {
    tags.add(step.tool);
    const target = getTargetName(step);
    if (target !== 'task') tags.add(target);
  }
  return [...tags];
}

/**
 * 检查是否有技能可以被提升到共享库
 * 在每次认知周期后调用
 */
export async function tryPromoteSkills(agentName: string): Promise<string[]> {
  const promoted: string[] = [];
  const metas = await skillLibrary.loadMeta(agentName);

  for (const [name, meta] of metas) {
    if (meta.shared || meta.deprecated) continue;
    const total = meta.successCount + meta.failCount;
    if (total >= 3 && skillLibrary.getSuccessRate(meta) >= 0.7) {
      const ok = await skillLibrary.promoteToShared(agentName, name);
      if (ok) {
        promoted.push(name);
        console.log(`[SkillGenerator] 技能 "${name}" 已提升到共享库`);
      }
    }
  }

  return promoted;
}
