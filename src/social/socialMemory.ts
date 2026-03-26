/**
 * Social Memory - 每个 Agent 的社交记忆图
 *
 * 记录与其他 Agent 的关系（信任度、交互次数），
 * 以及社交事件（交易、聊天、攻击）。
 * 持久化为 JSON 文件。
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

export interface SocialRelationship {
  agentName: string;
  trustScore: number;       // -1.0 ~ 1.0
  interactionCount: number;
  lastInteraction: number;  // timestamp
  positiveEvents: number;
  negativeEvents: number;
  tags: string[];           // e.g. ['trader', 'ally', 'hostile']
}

export interface SocialEvent {
  ts: number;
  type: 'trade_success' | 'trade_fail' | 'chat' | 'helped' | 'attacked_by' | 'team_formed' | 'team_left';
  otherAgent: string;
  detail: string;
}

interface SocialData {
  relationships: Record<string, SocialRelationship>;
  events: SocialEvent[];
}

const TRUST_DELTA = {
  trade_success: 0.1,
  trade_fail: -0.05,
  chat: 0.02,
  helped: 0.15,
  attacked_by: -0.3,
  team_formed: 0.1,
  team_left: -0.05,
} as const;

const MAX_EVENTS = 200;

export class SocialMemory {
  private data: SocialData = { relationships: {}, events: [] };
  private filePath: string;
  private dirty = false;

  constructor(memoryDir: string, agentName: string) {
    this.filePath = join(memoryDir, `${agentName}_social.json`);
  }

  /** 从磁盘加载 */
  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(raw) as SocialData;
    } catch {
      // 文件损坏时重置
      this.data = { relationships: {}, events: [] };
    }
  }

  /** 持久化到磁盘 */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    this.dirty = false;
  }

  /** 记录社交事件并更新信任度 */
  recordEvent(event: Omit<SocialEvent, 'ts'>): void {
    const entry: SocialEvent = { ts: Date.now(), ...event };
    this.data.events.push(entry);
    if (this.data.events.length > MAX_EVENTS) {
      this.data.events = this.data.events.slice(-MAX_EVENTS);
    }

    // 更新关系
    const rel = this.getOrCreateRelationship(event.otherAgent);
    rel.interactionCount++;
    rel.lastInteraction = Date.now();

    const delta = TRUST_DELTA[event.type] ?? 0;
    if (delta > 0) rel.positiveEvents++;
    if (delta < 0) rel.negativeEvents++;

    rel.trustScore = Math.max(-1, Math.min(1, rel.trustScore + delta));
    this.dirty = true;
  }

  /** 获取或创建与某个 Agent 的关系 */
  getOrCreateRelationship(agentName: string): SocialRelationship {
    if (!this.data.relationships[agentName]) {
      this.data.relationships[agentName] = {
        agentName,
        trustScore: 0,
        interactionCount: 0,
        lastInteraction: 0,
        positiveEvents: 0,
        negativeEvents: 0,
        tags: [],
      };
    }
    return this.data.relationships[agentName];
  }

  /** 获取某个 Agent 的信任度 */
  getTrustScore(agentName: string): number {
    return this.data.relationships[agentName]?.trustScore ?? 0;
  }

  /** 获取所有关系 */
  getAllRelationships(): SocialRelationship[] {
    return Object.values(this.data.relationships);
  }

  /** 获取最近 N 条社交事件 */
  getRecentEvents(n = 10): SocialEvent[] {
    return this.data.events.slice(-n);
  }

  /** 生成 prompt 注入用的社交摘要 */
  summarizeForPrompt(): string {
    const rels = this.getAllRelationships()
      .filter(r => r.interactionCount > 0)
      .sort((a, b) => b.lastInteraction - a.lastInteraction)
      .slice(0, 5);

    if (rels.length === 0) return '';

    const relSummary = rels.map(r => {
      const trustLabel = r.trustScore >= 0.3 ? '友好' :
        r.trustScore <= -0.3 ? '敌对' : '中性';
      return `${r.agentName}: ${trustLabel}(${r.trustScore.toFixed(2)}) 交互${r.interactionCount}次`;
    }).join('; ');

    const recentEvents = this.getRecentEvents(3)
      .map(e => `${e.otherAgent}:${e.type}(${e.detail})`)
      .join('; ');

    let summary = `社交关系: ${relSummary}`;
    if (recentEvents) summary += `\n最近社交: ${recentEvents}`;
    return summary;
  }
}

/** 每个 Bot 的社交记忆实例缓存 */
const socialMemories = new Map<string, SocialMemory>();

export function getSocialMemory(memoryDir: string, agentName: string): SocialMemory {
  const key = agentName;
  if (!socialMemories.has(key)) {
    socialMemories.set(key, new SocialMemory(memoryDir, agentName));
  }
  return socialMemories.get(key)!;
}
