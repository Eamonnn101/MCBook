/**
 * Personality Profile - Agent 人格特质系统
 *
 * 从 JSON 文件加载数值化人格特质，注入到认知 prompt 中。
 * 特质影响 AI 的决策偏好（探索、社交、冒险等）。
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface PersonalityTraits {
  /** 探索欲望 0-1: 高=喜欢发现新区域, 低=守在基地 */
  exploration_drive: number;
  /** 社交性 0-1: 高=主动交流交易, 低=独来独往 */
  sociability: number;
  /** 风险容忍度 0-1: 高=夜晚探洞, 低=回避战斗 */
  risk_tolerance: number;
  /** 合作偏好 0-1: 高=优先团队目标, 低=自利优先 */
  cooperation_bias: number;
  /** 创造力 0-1: 高=尝试新建筑实验, 低=遵循已知策略 */
  creativity: number;
  /** 囤积倾向 0-1: 高=不愿交易出资源, 低=慷慨交易者 */
  hoarding_tendency: number;
}

export interface PersonalityProfile {
  /** Agent 显示名 */
  displayName: string;
  /** Agent 类型 */
  agentType: string;
  /** 数值化特质 */
  traits: PersonalityTraits;
  /** 初始目标列表 */
  initialGoals: string[];
  /** 背景故事 */
  background: string;
}

const profileCache = new Map<string, PersonalityProfile>();

/** 默认特质（中庸型） */
const DEFAULT_TRAITS: PersonalityTraits = {
  exploration_drive: 0.5,
  sociability: 0.5,
  risk_tolerance: 0.5,
  cooperation_bias: 0.5,
  creativity: 0.5,
  hoarding_tendency: 0.5,
};

/**
 * 加载 Agent 的人格配置文件
 * 查找 agents/<agentType>/profile.json
 */
export async function loadProfile(agentType: string): Promise<PersonalityProfile> {
  if (profileCache.has(agentType)) return profileCache.get(agentType)!;

  const path = join(process.cwd(), 'agents', agentType, 'profile.json');
  let profile: PersonalityProfile;

  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw);
      profile = {
        displayName: data.display_name ?? data.displayName ?? agentType,
        agentType,
        traits: { ...DEFAULT_TRAITS, ...(data.traits ?? {}) },
        initialGoals: data.initial_goals ?? data.initialGoals ?? [],
        background: data.background ?? '',
      };
    } catch {
      profile = createDefaultProfile(agentType);
    }
  } else {
    profile = createDefaultProfile(agentType);
  }

  profileCache.set(agentType, profile);
  return profile;
}

function createDefaultProfile(agentType: string): PersonalityProfile {
  return {
    displayName: agentType,
    agentType,
    traits: { ...DEFAULT_TRAITS },
    initialGoals: [],
    background: '',
  };
}

/**
 * 生成特质描述（注入 prompt）
 * 将数值特质转换为自然语言行为倾向
 */
export function traitPromptModifier(traits: PersonalityTraits): string {
  const parts: string[] = [];

  if (traits.exploration_drive > 0.7) parts.push('你热衷探索未知区域，不喜欢待在原地');
  else if (traits.exploration_drive < 0.3) parts.push('你倾向守在已知安全区域，不喜欢冒险远行');

  if (traits.sociability > 0.7) parts.push('你是社交型，主动与其他 Agent 交流和交易');
  else if (traits.sociability < 0.3) parts.push('你是独行侠，很少主动交流');

  if (traits.risk_tolerance > 0.7) parts.push('你敢于冒险，夜晚也敢外出探索');
  else if (traits.risk_tolerance < 0.3) parts.push('你非常谨慎，尽量避免一切危险');

  if (traits.cooperation_bias > 0.7) parts.push('你优先考虑团队利益');
  else if (traits.cooperation_bias < 0.3) parts.push('你以自身利益为优先');

  if (traits.creativity > 0.7) parts.push('你喜欢尝试新策略和创意建造');
  else if (traits.creativity < 0.3) parts.push('你偏好已验证的策略，不喜欢实验');

  if (traits.hoarding_tendency > 0.7) parts.push('你不轻易交易出自己的资源');
  else if (traits.hoarding_tendency < 0.3) parts.push('你乐于和他人分享资源');

  return parts.length > 0 ? `【性格倾向】${parts.join('。')}。` : '';
}
