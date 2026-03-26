/**
 * Event Bus - Agent 间事件总线
 *
 * 在 Game Master 进程内路由 Agent 间通信。
 * 全局单例，所有 Bot 共享。
 */

import { EventEmitter } from 'events';

// ─── 事件类型定义 ───

export interface AgentJoinEvent {
  type: 'agent:join';
  agentName: string;
  agentType: string;
  ts: number;
}

export interface AgentLeaveEvent {
  type: 'agent:leave';
  agentName: string;
  reason: string;
  ts: number;
}

export interface AgentChatEvent {
  type: 'agent:chat';
  from: string;
  target: string | null;  // null = broadcast
  message: string;
  ts: number;
}

export interface TradeRequestEvent {
  type: 'agent:trade_request';
  tradeId: string;
  from: string;
  target: string;
  offerItems: Array<{ name: string; count: number }>;
  wantItems: Array<{ name: string; count: number }>;
  ts: number;
}

export interface TradeResponseEvent {
  type: 'agent:trade_response';
  tradeId: string;
  from: string;
  target: string;
  accepted: boolean;
  ts: number;
}

export interface AgentPositionEvent {
  type: 'agent:position_update';
  agentName: string;
  position: { x: number; y: number; z: number };
  ts: number;
}

export interface WaypointEvent {
  type: 'agent:waypoint';
  agentName: string;
  waypointName: string;
  position: { x: number; y: number; z: number };
  ts: number;
}

export interface TeamEvent {
  type: 'agent:team';
  action: 'form' | 'leave' | 'dissolve';
  teamName: string;
  agentName: string;
  members?: string[];
  ts: number;
}

export type AgentEvent =
  | AgentJoinEvent
  | AgentLeaveEvent
  | AgentChatEvent
  | TradeRequestEvent
  | TradeResponseEvent
  | AgentPositionEvent
  | WaypointEvent
  | TeamEvent;

// ─── Event Bus 实现 ───

export class AgentEventBus extends EventEmitter {
  /** 每个 Agent 的待处理事件队列 */
  private pendingEvents = new Map<string, AgentEvent[]>();
  private readonly maxPendingPerAgent = 50;

  /** 发布事件（广播给所有监听者 + 存入目标 Agent 的队列） */
  publish(event: AgentEvent): void {
    this.emit(event.type, event);
    this.emit('*', event);

    // 根据事件类型路由到目标 Agent 的待处理队列
    const targets = this.getEventTargets(event);
    for (const target of targets) {
      this.enqueue(target, event);
    }
  }

  /** 获取并清空某个 Agent 的待处理事件 */
  drain(agentName: string): AgentEvent[] {
    const events = this.pendingEvents.get(agentName) ?? [];
    this.pendingEvents.set(agentName, []);
    return events;
  }

  /** 查看某个 Agent 的待处理事件（不清空） */
  peek(agentName: string): AgentEvent[] {
    return this.pendingEvents.get(agentName) ?? [];
  }

  /** 注册 Agent（初始化队列） */
  registerAgent(agentName: string): void {
    if (!this.pendingEvents.has(agentName)) {
      this.pendingEvents.set(agentName, []);
    }
  }

  private enqueue(agentName: string, event: AgentEvent): void {
    if (!this.pendingEvents.has(agentName)) {
      this.pendingEvents.set(agentName, []);
    }
    const queue = this.pendingEvents.get(agentName)!;
    queue.push(event);
    // 保持队列大小
    while (queue.length > this.maxPendingPerAgent) {
      queue.shift();
    }
  }

  /** 根据事件类型确定目标 Agent */
  private getEventTargets(event: AgentEvent): string[] {
    switch (event.type) {
      case 'agent:chat':
        // 定向聊天 → 目标；广播 → 所有已注册 Agent（除发送者）
        if (event.target) return [event.target];
        return [...this.pendingEvents.keys()].filter(n => n !== event.from);

      case 'agent:trade_request':
        return [event.target];

      case 'agent:trade_response':
        return [event.target];

      case 'agent:join':
      case 'agent:leave':
        // 广播给所有人（除自己）
        return [...this.pendingEvents.keys()].filter(n => n !== event.agentName);

      case 'agent:team':
        // 广播给所有队员
        return (event.members ?? []).filter(n => n !== event.agentName);

      case 'agent:waypoint':
      case 'agent:position_update':
        // 位置更新不入队（太频繁），只通过 emit 广播
        return [];

      default:
        return [];
    }
  }
}

/** 全局单例 */
export const agentEventBus = new AgentEventBus();

// ─── 共享路标存储 ───

export interface Waypoint {
  name: string;
  position: { x: number; y: number; z: number };
  createdBy: string;
  ts: number;
}

const waypoints = new Map<string, Waypoint>();

export function setWaypoint(name: string, position: { x: number; y: number; z: number }, createdBy: string): void {
  waypoints.set(name, { name, position, createdBy, ts: Date.now() });
}

export function getWaypoint(name: string): Waypoint | undefined {
  return waypoints.get(name);
}

export function getAllWaypoints(): Waypoint[] {
  return [...waypoints.values()];
}

// ─── 团队管理 ───

export interface Team {
  name: string;
  members: Set<string>;
  createdBy: string;
  ts: number;
}

const teams = new Map<string, Team>();

export function formTeam(name: string, members: string[], createdBy: string): Team {
  const team: Team = { name, members: new Set(members), createdBy, ts: Date.now() };
  teams.set(name, team);
  return team;
}

export function leaveTeam(teamName: string, agentName: string): boolean {
  const team = teams.get(teamName);
  if (!team) return false;
  team.members.delete(agentName);
  if (team.members.size === 0) teams.delete(teamName);
  return true;
}

export function getTeam(teamName: string): Team | undefined {
  return teams.get(teamName);
}

export function getAgentTeams(agentName: string): Team[] {
  return [...teams.values()].filter(t => t.members.has(agentName));
}
