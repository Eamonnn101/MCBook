/**
 * Coordinator Server - 分布式共享状态中心
 *
 * 托管 AgentRegistry、EventBus、TradeEngine、Waypoints、Teams，
 * 通过 WebSocket 为多个 Bot Runner 提供统一的共享状态服务。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { AgentRegistry, type AgentInfo } from './agentRegistry.js';
import {
  AgentEventBus,
  type AgentEvent,
  setWaypoint, getAllWaypoints, getWaypoint,
  formTeam, leaveTeam, getAgentTeams,
  type Waypoint, type Team,
} from './eventBus.js';
import {
  createTradeProposal, acceptTrade, rejectTrade,
  getPendingTradesFor, cleanupExpiredTrades,
  type TradeProposal,
} from '../social/tradeEngine.js';

export interface CoordinatorMessage {
  type: string;
  requestId?: number;
  [key: string]: unknown;
}

export interface CoordinatorResponse {
  type: 'response';
  requestId: number;
  data: unknown;
}

export class CoordinatorServer {
  private wss: WebSocketServer | null = null;
  private registry = new AgentRegistry();
  private eventBus = new AgentEventBus();
  /** botName → WebSocket connection */
  private connections = new Map<string, WebSocket>();

  constructor(private port: number = 3849) {}

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });
    console.log(`[Coordinator] WebSocket 服务已启动 ws://localhost:${this.port}`);

    this.wss.on('connection', (ws) => {
      let botName: string | null = null;

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as CoordinatorMessage;
          const result = this.handleMessage(msg, ws, botName);

          // Track botName after registration
          if (msg.type === 'register' && typeof msg.name === 'string') {
            botName = msg.name;
            this.connections.set(botName, ws);
            console.log(`[Coordinator] Bot "${botName}" 已连接`);
          }

          // Send response if requestId present
          if (msg.requestId !== undefined) {
            const response: CoordinatorResponse = {
              type: 'response',
              requestId: msg.requestId,
              data: result instanceof Promise ? null : result,
            };
            if (result instanceof Promise) {
              result.then((data) => {
                response.data = data;
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(response));
                }
              });
            } else if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(response));
            }
          }
        } catch (err) {
          console.error('[Coordinator] 消息处理错误:', err);
        }
      });

      ws.on('close', () => {
        if (botName) {
          console.log(`[Coordinator] Bot "${botName}" 已断开`);
          this.registry.markOffline(botName);
          this.connections.delete(botName);
        }
      });
    });

    // 推送事件到目标 Bot Runner
    this.eventBus.on('*', (event: AgentEvent) => {
      this.pushEventToTargets(event);
    });

    // 定期清理过期交易
    setInterval(() => cleanupExpiredTrades(), 60_000);
  }

  stop(): void {
    this.wss?.close();
  }

  /** 获取 registry 用于 HTTP /status 端点 */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(msg: Record<string, any>, _ws: WebSocket, _botName: string | null): unknown {
    switch (msg.type) {
      // ─── Registry ───
      case 'register': {
        const { name, mcBotName, agentType } = msg;
        this.registry.register(name, mcBotName, agentType);
        this.eventBus.registerAgent(name);
        // Broadcast join to other bots
        this.eventBus.publish({
          type: 'agent:join',
          agentName: name,
          agentType,
          ts: Date.now(),
        });
        return { ok: true };
      }

      case 'registry:update': {
        const { name, data } = msg;
        this.registry.update(name, data);
        return { ok: true };
      }

      case 'registry:get': {
        const info = this.registry.get(msg.name as string);
        return info ?? null;
      }

      case 'registry:getAll':
        return this.registry.getAll();

      case 'registry:getOthers':
        return this.registry.getOthers(msg.excludeName as string);

      case 'registry:getPublicProfile':
        return this.registry.getPublicProfile(msg.name as string);

      case 'registry:summarize':
        return this.registry.summarizeForPrompt(msg.excludeName as string);

      case 'registry:markOffline':
        this.registry.markOffline(msg.name as string);
        return { ok: true };

      case 'registry:markOnline':
        this.registry.markOnline(msg.name as string);
        return { ok: true };

      // ─── EventBus ───
      case 'event:publish': {
        const event = msg.event as AgentEvent;
        this.eventBus.publish(event);
        return { ok: true };
      }

      case 'event:drain': {
        const events = this.eventBus.drain(msg.agentName as string);
        return events;
      }

      case 'event:peek': {
        const events = this.eventBus.peek(msg.agentName as string);
        return events;
      }

      // ─── Trade ───
      case 'trade:create': {
        const { from, target, offerItems, wantItems } = msg;
        const proposal = createTradeProposal(from, target, offerItems, wantItems);
        return proposal;
      }

      case 'trade:accept': {
        const result = acceptTrade(msg.tradeId as string, msg.accepterName as string);
        return result;
      }

      case 'trade:reject': {
        const ok = rejectTrade(msg.tradeId as string, msg.rejecterName as string);
        return { ok };
      }

      case 'trade:getPending': {
        return getPendingTradesFor(msg.agentName as string);
      }

      // ─── Waypoints ───
      case 'waypoint:set': {
        const { name, position, createdBy } = msg;
        setWaypoint(name, position, createdBy);
        return { ok: true };
      }

      case 'waypoint:getAll':
        return getAllWaypoints();

      case 'waypoint:get':
        return getWaypoint(msg.name as string) ?? null;

      // ─── Teams ───
      case 'team:form': {
        const { teamName, members, createdBy } = msg;
        const team = formTeam(teamName, members, createdBy);
        // Broadcast team event
        this.eventBus.publish({
          type: 'agent:team',
          action: 'form',
          teamName,
          agentName: createdBy,
          members,
          ts: Date.now(),
        });
        return serializeTeam(team);
      }

      case 'team:leave': {
        const ok = leaveTeam(msg.teamName as string, msg.agentName as string);
        if (ok) {
          this.eventBus.publish({
            type: 'agent:team',
            action: 'leave',
            teamName: msg.teamName as string,
            agentName: msg.agentName as string,
            ts: Date.now(),
          });
        }
        return { ok };
      }

      case 'team:getForAgent':
        return getAgentTeams(msg.agentName as string).map(serializeTeam);

      // ─── Cognitive State (for dashboard) ───
      case 'cogState:update': {
        // Store cognitive state for dashboard aggregation
        const name = msg.name as string;
        const agent = this.registry.get(name);
        if (agent) {
          // Store as extra metadata (dashboard can read via /status)
          (agent as unknown as Record<string, unknown>)._cogState = msg.state;
        }
        return { ok: true };
      }

      default:
        console.warn(`[Coordinator] 未知消息类型: ${msg.type}`);
        return { error: `unknown type: ${msg.type}` };
    }
  }

  /** 推送事件到对应的 Bot Runner WebSocket */
  private pushEventToTargets(event: AgentEvent): void {
    // Determine which bots should receive this event push
    const targets = this.getEventPushTargets(event);
    for (const target of targets) {
      const ws = this.connections.get(target);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event:pushed', event }));
      }
    }
  }

  private getEventPushTargets(event: AgentEvent): string[] {
    switch (event.type) {
      case 'agent:chat':
        if (event.target) return [event.target];
        return [...this.connections.keys()].filter(n => n !== event.from);
      case 'agent:trade_request':
        return [event.target];
      case 'agent:trade_response':
        return [event.target];
      case 'agent:join':
      case 'agent:leave':
        return [...this.connections.keys()].filter(n => n !== event.agentName);
      case 'agent:team':
        return (event.members ?? []).filter(n => n !== event.agentName);
      default:
        return [];
    }
  }
}

/** Team 的 Set 不能直接 JSON.stringify，转成数组 */
function serializeTeam(team: Team): Record<string, unknown> {
  return {
    name: team.name,
    members: [...team.members],
    createdBy: team.createdBy,
    ts: team.ts,
  };
}
