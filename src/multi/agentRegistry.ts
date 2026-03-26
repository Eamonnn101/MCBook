/**
 * Agent Registry - 全局 Agent 注册表
 *
 * 在 Game Master 进程中维护所有 Bot 的实时状态。
 * 每次 observeTick 后更新，供社交工具查询。
 */

export interface AgentInfo {
  /** 逻辑名称 (e.g. "Bot_1") */
  name: string;
  /** MC 用户名 (e.g. "MCBook_Bot_1") */
  mcBotName: string;
  /** Agent 人格类型 (e.g. "survivor") */
  agentType: string;
  /** 在线状态 */
  status: 'online' | 'offline' | 'connecting';
  /** 最近位置 */
  position: { x: number; y: number; z: number } | null;
  /** 当前血量 */
  health: number;
  /** 当前饥饿度 */
  food: number;
  /** 背包摘要 */
  inventory: string;
  /** 是否忙碌（正在执行动作） */
  isBusy: boolean;
  /** 当前动作 */
  currentAction: string | null;
  /** 是否白天 */
  isDay: boolean;
  /** 最后更新时间戳 */
  lastSeen: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  /** 注册一个新 Agent（初始状态为 connecting） */
  register(name: string, mcBotName: string, agentType: string): void {
    this.agents.set(name, {
      name,
      mcBotName,
      agentType,
      status: 'connecting',
      position: null,
      health: 20,
      food: 20,
      inventory: '',
      isBusy: false,
      currentAction: null,
      isDay: true,
      lastSeen: Date.now(),
    });
  }

  /** 更新 Agent 状态（来自 getStatus 结果） */
  update(name: string, data: Partial<Omit<AgentInfo, 'name' | 'mcBotName' | 'agentType'>>): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    Object.assign(agent, data, { lastSeen: Date.now() });
    if (agent.status === 'connecting') agent.status = 'online';
  }

  /** 标记为离线 */
  markOffline(name: string): void {
    const agent = this.agents.get(name);
    if (agent) agent.status = 'offline';
  }

  /** 标记为在线 */
  markOnline(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = 'online';
      agent.lastSeen = Date.now();
    }
  }

  /** 获取单个 Agent 信息 */
  get(name: string): AgentInfo | undefined {
    return this.agents.get(name);
  }

  /** 通过 MC 用户名查找 */
  getByMcName(mcBotName: string): AgentInfo | undefined {
    for (const agent of this.agents.values()) {
      if (agent.mcBotName === mcBotName) return agent;
    }
    return undefined;
  }

  /** 获取所有在线 Agent */
  getOnline(): AgentInfo[] {
    return [...this.agents.values()].filter(a => a.status === 'online');
  }

  /** 获取所有 Agent */
  getAll(): AgentInfo[] {
    return [...this.agents.values()];
  }

  /** 获取除指定 Agent 外的其他在线 Agent */
  getOthers(excludeName: string): AgentInfo[] {
    return this.getOnline().filter(a => a.name !== excludeName);
  }

  /** 获取公开状态（供 query_agent_status 等社交工具使用） */
  getPublicProfile(name: string): Record<string, unknown> | null {
    const agent = this.agents.get(name);
    if (!agent) return null;
    return {
      name: agent.name,
      agentType: agent.agentType,
      status: agent.status,
      position: agent.position,
      health: agent.health,
      food: agent.food,
      isBusy: agent.isBusy,
      isDay: agent.isDay,
      lastSeen: agent.lastSeen,
    };
  }

  /** 生成社交上下文摘要（注入到 prompt 中） */
  summarizeForPrompt(excludeName: string): string {
    const others = this.getOthers(excludeName);
    if (others.length === 0) return '附近无其他 Agent';

    return others.map(a => {
      const pos = a.position ? `(${a.position.x},${a.position.y},${a.position.z})` : '未知';
      const statusStr = a.status === 'online' ? (a.isBusy ? '忙碌' : '空闲') : '离线';
      return `${a.name}[${a.agentType}] ${statusStr} HP:${a.health} 坐标:${pos}`;
    }).join('\n');
  }
}

/** 全局单例 */
export const agentRegistry = new AgentRegistry();
