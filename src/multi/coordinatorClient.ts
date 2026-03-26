/**
 * Coordinator Client - Bot Runner 用的网络客户端
 *
 * 提供与 AgentRegistry/EventBus/TradeEngine/Waypoint/Team 相同的 API，
 * 但通过 WebSocket 与 Coordinator 通信。
 */

import WebSocket from 'ws';
import type { AgentInfo } from './agentRegistry.js';
import type { AgentEvent, Waypoint } from './eventBus.js';
import type { TradeProposal, TradeItem } from '../social/tradeEngine.js';

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class CoordinatorClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private eventListeners: Array<(event: AgentEvent) => void> = [];
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** 连接到 Coordinator，返回 Promise 等连接建立 */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        console.log(`[CoordinatorClient] 已连接 ${this.url}`);
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'response' && msg.requestId !== undefined) {
            const req = this.pending.get(msg.requestId);
            if (req) {
              clearTimeout(req.timer);
              this.pending.delete(msg.requestId);
              req.resolve(msg.data);
            }
          } else if (msg.type === 'event:pushed') {
            for (const listener of this.eventListeners) {
              listener(msg.event as AgentEvent);
            }
          }
        } catch (err) {
          console.error('[CoordinatorClient] 解析消息失败:', err);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        console.warn('[CoordinatorClient] 连接断开，5秒后重连...');
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error('WebSocket disconnected'));
          this.pending.delete(id);
        }
        this.reconnectTimer = setTimeout(() => this.reconnect(), 5000);
      });

      this.ws.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          console.error('[CoordinatorClient] WebSocket 错误:', err.message);
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
    } catch {
      console.warn('[CoordinatorClient] 重连失败，5秒后再试...');
      this.reconnectTimer = setTimeout(() => this.reconnect(), 5000);
    }
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  // ─── 通用请求 ───

  private send(msg: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected to Coordinator'));
      }
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${msg.type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, requestId: id }));
    });
  }

  // ─── Registry API ───

  async register(name: string, mcBotName: string, agentType: string): Promise<void> {
    await this.send({ type: 'register', name, mcBotName, agentType });
  }

  async update(name: string, data: Partial<AgentInfo>): Promise<void> {
    await this.send({ type: 'registry:update', name, data });
  }

  async get(name: string): Promise<AgentInfo | undefined> {
    const result = await this.send({ type: 'registry:get', name });
    return (result as AgentInfo | null) ?? undefined;
  }

  async getAll(): Promise<AgentInfo[]> {
    return (await this.send({ type: 'registry:getAll' })) as AgentInfo[];
  }

  async getOthers(excludeName: string): Promise<AgentInfo[]> {
    return (await this.send({ type: 'registry:getOthers', excludeName })) as AgentInfo[];
  }

  async getPublicProfile(name: string): Promise<Record<string, unknown> | null> {
    return (await this.send({ type: 'registry:getPublicProfile', name })) as Record<string, unknown> | null;
  }

  async summarizeForPrompt(excludeName: string): Promise<string> {
    return (await this.send({ type: 'registry:summarize', excludeName })) as string;
  }

  async markOffline(name: string): Promise<void> {
    await this.send({ type: 'registry:markOffline', name });
  }

  async markOnline(name: string): Promise<void> {
    await this.send({ type: 'registry:markOnline', name });
  }

  // ─── EventBus API ───

  async publish(event: AgentEvent): Promise<void> {
    await this.send({ type: 'event:publish', event });
  }

  async drain(agentName: string): Promise<AgentEvent[]> {
    return (await this.send({ type: 'event:drain', agentName })) as AgentEvent[];
  }

  async peek(agentName: string): Promise<AgentEvent[]> {
    return (await this.send({ type: 'event:peek', agentName })) as AgentEvent[];
  }

  /** 注册实时事件推送回调 */
  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventListeners.push(callback);
  }

  // ─── Trade API ───

  async createTradeProposal(
    from: string, target: string,
    offerItems: TradeItem[], wantItems: TradeItem[],
  ): Promise<TradeProposal> {
    return (await this.send({
      type: 'trade:create', from, target, offerItems, wantItems,
    })) as TradeProposal;
  }

  async acceptTrade(tradeId: string, accepterName: string): Promise<TradeProposal | null> {
    return (await this.send({ type: 'trade:accept', tradeId, accepterName })) as TradeProposal | null;
  }

  async rejectTrade(tradeId: string, rejecterName: string): Promise<boolean> {
    const result = (await this.send({ type: 'trade:reject', tradeId, rejecterName })) as { ok: boolean };
    return result.ok;
  }

  async getPendingTradesFor(agentName: string): Promise<TradeProposal[]> {
    return (await this.send({ type: 'trade:getPending', agentName })) as TradeProposal[];
  }

  // ─── Waypoint API ───

  async setWaypoint(name: string, position: { x: number; y: number; z: number }, createdBy: string): Promise<void> {
    await this.send({ type: 'waypoint:set', name, position, createdBy });
  }

  async getAllWaypoints(): Promise<Waypoint[]> {
    return (await this.send({ type: 'waypoint:getAll' })) as Waypoint[];
  }

  // ─── Team API ───

  async formTeam(teamName: string, members: string[], createdBy: string): Promise<Record<string, unknown>> {
    return (await this.send({ type: 'team:form', teamName, members, createdBy })) as Record<string, unknown>;
  }

  async leaveTeam(teamName: string, agentName: string): Promise<boolean> {
    const result = (await this.send({ type: 'team:leave', teamName, agentName })) as { ok: boolean };
    return result.ok;
  }

  async getAgentTeams(agentName: string): Promise<Array<Record<string, unknown>>> {
    return (await this.send({ type: 'team:getForAgent', agentName })) as Array<Record<string, unknown>>;
  }

  // ─── Dashboard / Cognitive State ───

  async updateCogState(name: string, state: Record<string, unknown>): Promise<void> {
    await this.send({ type: 'cogState:update', name, state });
  }
}
