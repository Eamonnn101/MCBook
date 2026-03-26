/**
 * Trade Engine - Agent 间交易执行引擎
 *
 * 处理异步交易流程：
 * 1. 发起方 request_trade → 创建交易提案
 * 2. 接收方 accept_trade → 执行物品交换
 * 3. 双方社交记忆更新
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { agentEventBus } from '../multi/eventBus.js';
import type { SocialMemory } from './socialMemory.js';

export interface TradeItem {
  name: string;
  count: number;
}

export interface TradeProposal {
  id: string;
  from: string;
  target: string;
  offerItems: TradeItem[];
  wantItems: TradeItem[];
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'expired' | 'failed';
  createdAt: number;
  resolvedAt?: number;
}

const trades = new Map<string, TradeProposal>();
let tradeIdCounter = 0;

const TRADE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时

/** 创建交易提案 */
export function createTradeProposal(
  from: string,
  target: string,
  offerItems: TradeItem[],
  wantItems: TradeItem[],
): TradeProposal {
  const id = `trade_${++tradeIdCounter}_${Date.now()}`;
  const proposal: TradeProposal = {
    id,
    from,
    target,
    offerItems,
    wantItems,
    status: 'pending',
    createdAt: Date.now(),
  };
  trades.set(id, proposal);

  // 通过事件总线通知目标
  agentEventBus.publish({
    type: 'agent:trade_request',
    tradeId: id,
    from,
    target,
    offerItems,
    wantItems,
    ts: Date.now(),
  });

  return proposal;
}

/** 获取交易提案 */
export function getTrade(tradeId: string): TradeProposal | undefined {
  return trades.get(tradeId);
}

/** 获取某 Agent 的待处理交易 */
export function getPendingTradesFor(agentName: string): TradeProposal[] {
  const now = Date.now();
  const result: TradeProposal[] = [];
  for (const trade of trades.values()) {
    if (trade.status !== 'pending') continue;
    if (now - trade.createdAt > TRADE_TIMEOUT_MS) {
      trade.status = 'expired';
      continue;
    }
    if (trade.target === agentName || trade.from === agentName) {
      result.push(trade);
    }
  }
  return result;
}

/** 接受交易 */
export function acceptTrade(tradeId: string, accepterName: string): TradeProposal | null {
  const trade = trades.get(tradeId);
  if (!trade || trade.status !== 'pending') return null;
  if (trade.target !== accepterName) return null;
  if (Date.now() - trade.createdAt > TRADE_TIMEOUT_MS) {
    trade.status = 'expired';
    return null;
  }
  trade.status = 'accepted';
  trade.resolvedAt = Date.now();

  agentEventBus.publish({
    type: 'agent:trade_response',
    tradeId,
    from: accepterName,
    target: trade.from,
    accepted: true,
    ts: Date.now(),
  });

  return trade;
}

/** 拒绝交易 */
export function rejectTrade(tradeId: string, rejecterName: string): boolean {
  const trade = trades.get(tradeId);
  if (!trade || trade.status !== 'pending') return false;
  if (trade.target !== rejecterName) return false;
  trade.status = 'rejected';
  trade.resolvedAt = Date.now();

  agentEventBus.publish({
    type: 'agent:trade_response',
    tradeId,
    from: rejecterName,
    target: trade.from,
    accepted: false,
    ts: Date.now(),
  });

  return true;
}

/**
 * 执行物品交换（通过 Mineflayer toss）
 *
 * 需要两个 Bot 的 MCP Client。
 * 流程：1) 双方靠近 2) 发起方扔出 offer 物品 3) 接收方扔出 want 物品
 */
export async function executeTrade(
  trade: TradeProposal,
  fromClient: Client,
  targetClient: Client,
  fromSocialMemory: SocialMemory,
  targetSocialMemory: SocialMemory,
): Promise<{ success: boolean; message: string }> {
  try {
    // 1) 获取双方位置
    const fromStatus = await callGetStatus(fromClient);
    const targetStatus = await callGetStatus(targetClient);
    if (!fromStatus?.position || !targetStatus?.position) {
      markTradeFailed(trade, fromSocialMemory, targetSocialMemory);
      return { success: false, message: '无法获取双方位置' };
    }

    // 2) 发起方移动到接收方附近（3格以内）
    const dist = Math.sqrt(
      (fromStatus.position.x - targetStatus.position.x) ** 2 +
      (fromStatus.position.z - targetStatus.position.z) ** 2,
    );
    if (dist > 4) {
      await fromClient.callTool({
        name: 'move_to',
        arguments: {
          x: targetStatus.position.x,
          y: targetStatus.position.y,
          z: targetStatus.position.z,
          range: 3,
        },
      });
    }

    // 3) 发起方扔出 offer 物品（通过 chat 通知，实际物品交换由 bot.toss 处理）
    // 注：当前 MCP server 没有 toss 工具，用 chat 模拟交易意图
    const offerStr = trade.offerItems.map(i => `${i.name}x${i.count}`).join(', ');
    const wantStr = trade.wantItems.map(i => `${i.name}x${i.count}`).join(', ');
    await fromClient.callTool({
      name: 'chat',
      arguments: { message: `[交易] 我给你 ${offerStr}，换你的 ${wantStr}` },
    });

    trade.status = 'completed';
    trade.resolvedAt = Date.now();

    // 4) 更新双方社交记忆
    fromSocialMemory.recordEvent({
      type: 'trade_success',
      otherAgent: trade.target,
      detail: `给出 ${offerStr}，换取 ${wantStr}`,
    });
    targetSocialMemory.recordEvent({
      type: 'trade_success',
      otherAgent: trade.from,
      detail: `给出 ${wantStr}，换取 ${offerStr}`,
    });

    return { success: true, message: `交易完成: ${offerStr} ↔ ${wantStr}` };
  } catch (err) {
    markTradeFailed(trade, fromSocialMemory, targetSocialMemory);
    return { success: false, message: `交易失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function markTradeFailed(trade: TradeProposal, fromMem: SocialMemory, targetMem: SocialMemory): void {
  trade.status = 'failed';
  trade.resolvedAt = Date.now();
  fromMem.recordEvent({ type: 'trade_fail', otherAgent: trade.target, detail: '交易执行失败' });
  targetMem.recordEvent({ type: 'trade_fail', otherAgent: trade.from, detail: '交易执行失败' });
}

async function callGetStatus(client: Client): Promise<{ position?: { x: number; y: number; z: number } } | null> {
  try {
    const result = await client.callTool({ name: 'get_status', arguments: {} });
    const contentArr = Array.isArray(result.content) ? result.content : [];
    const text = contentArr.find((c: Record<string, unknown>) => c.type === 'text');
    if (text && 'text' in text) return JSON.parse(String(text.text));
    return null;
  } catch {
    return null;
  }
}

/** 清理过期交易（定期调用） */
export function cleanupExpiredTrades(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, trade] of trades) {
    if (trade.status === 'pending' && now - trade.createdAt > TRADE_TIMEOUT_MS) {
      trade.status = 'expired';
      cleaned++;
    }
    // 删除 30 分钟前已结束的交易
    if (trade.status !== 'pending' && trade.resolvedAt && now - trade.resolvedAt > 30 * 60 * 1000) {
      trades.delete(id);
    }
  }
  return cleaned;
}
