/**
 * World State - 统一世界状态快照构建器
 *
 * 将 Bot 状态、社交信息、技能上下文等整合为结构化快照，
 * 并压缩为 token 高效的字符串供 prompt 注入。
 */

import type { AgentRegistry } from '../multi/agentRegistry.js';
import type { SocialMemory } from '../social/socialMemory.js';
import type { SkillLibrary } from '../skills/skillLibrary.js';
import { getPendingTradesFor } from '../social/tradeEngine.js';
import { getAgentTeams, getAllWaypoints } from '../multi/eventBus.js';

export interface BotStatusData {
  health: number;
  food: number;
  position: { x: number; y: number; z: number } | null;
  inventory: string;
  timeOfDay: number;
  isDay: boolean;
  isBusy: boolean;
  currentAction: string | null;
}

export interface WorldStateSnapshot {
  /** 基本状态 */
  status: BotStatusData;
  /** 社交摘要 */
  socialSummary: {
    nearbyAgents: Array<{ name: string; agentType: string; distance: number | null; status: string }>;
    trustScores: Record<string, number>;
    pendingTrades: number;
    teamNames: string[];
  };
  /** 活跃目标 */
  activeGoals: string[];
  /** 技能上下文 */
  skillContext: {
    availableCount: number;
    recentlyUsed: string[];
  };
  /** 共享路标 */
  waypoints: Array<{ name: string; x: number; y: number; z: number }>;
}

/**
 * 构建完整世界状态快照
 */
export async function buildWorldState(
  botName: string,
  status: BotStatusData,
  registry: AgentRegistry,
  socialMemory: SocialMemory,
  skillLib: SkillLibrary,
  activeGoals: string[] = [],
): Promise<WorldStateSnapshot> {
  // 社交信息
  const otherAgents = registry.getOthers(botName);
  const nearbyAgents = otherAgents.map(a => ({
    name: a.name,
    agentType: a.agentType,
    distance: status.position && a.position
      ? Math.round(Math.sqrt(
        (status.position.x - a.position.x) ** 2 +
        (status.position.z - a.position.z) ** 2,
      ))
      : null,
    status: a.isBusy ? '忙碌' : '空闲',
  }));

  const rels = socialMemory.getAllRelationships();
  const trustScores: Record<string, number> = {};
  for (const r of rels) {
    if (r.interactionCount > 0) {
      trustScores[r.agentName] = Math.round(r.trustScore * 100) / 100;
    }
  }

  const pendingTrades = getPendingTradesFor(botName).length;
  const teams = getAgentTeams(botName);
  const waypoints = getAllWaypoints().map(w => ({
    name: w.name,
    x: w.position.x,
    y: w.position.y,
    z: w.position.z,
  }));

  // 技能信息
  const skills = await skillLib.listAvailable(botName);

  return {
    status,
    socialSummary: {
      nearbyAgents,
      trustScores,
      pendingTrades,
      teamNames: teams.map(t => t.name),
    },
    activeGoals,
    skillContext: {
      availableCount: skills.length,
      recentlyUsed: skills
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, 3)
        .map(s => s.name),
    },
    waypoints,
  };
}

/**
 * 将世界状态压缩为 token 高效的字符串
 */
export function compressForPrompt(snapshot: WorldStateSnapshot): string {
  const s = snapshot.status;
  const parts: string[] = [];

  // 基本状态（已在 buildSlowPrompt 中处理，此处补充社交和技能）
  const social = snapshot.socialSummary;

  if (snapshot.activeGoals.length > 0) {
    parts.push(`当前目标: ${snapshot.activeGoals.join('；')}`);
  }

  if (social.nearbyAgents.length > 0) {
    const agentLines = social.nearbyAgents.map(a => {
      const dist = a.distance !== null ? `${a.distance}格` : '未知距���';
      const trust = social.trustScores[a.name];
      const trustStr = trust !== undefined
        ? ` 信任:${trust >= 0.3 ? '友好' : trust <= -0.3 ? '敌对' : '中性'}`
        : '';
      return `  ${a.name}[${a.agentType}] ${a.status} ${dist}${trustStr}`;
    });
    parts.push(`其他Agent:\n${agentLines.join('\n')}`);
  }

  if (social.pendingTrades > 0) {
    parts.push(`待处理交易: ${social.pendingTrades}个`);
  }

  if (social.teamNames.length > 0) {
    parts.push(`所在团队: ${social.teamNames.join(', ')}`);
  }

  if (snapshot.waypoints.length > 0) {
    const wpLines = snapshot.waypoints.slice(0, 5).map(w =>
      `  ${w.name}: (${w.x},${w.y},${w.z})`,
    );
    parts.push(`共享路标:\n${wpLines.join('\n')}`);
  }

  if (snapshot.skillContext.availableCount > 0) {
    parts.push(`可用技能: ${snapshot.skillContext.availableCount}个`);
    if (snapshot.skillContext.recentlyUsed.length > 0) {
      parts.push(`最近使用: ${snapshot.skillContext.recentlyUsed.join(', ')}`);
    }
  }

  return parts.join('\n');
}
