/**
 * 事件驱动触发器 - 纯事件模式，零轮询消耗
 * 当血量、聊天、受伤等事件发生时，可触发 OpenClaw 推理
 *
 * 若 OpenClaw MCP 客户端支持服务器主动推送 (notifications)，
 * 可在此调用 mcpServer 的 notification 接口推送事件。
 * 若不支持，客户端可周期性调用 get_pending_events 获取待处理事件。
 */
import type { Bot } from 'mineflayer';

export type GameEvent =
  | { type: 'health'; health: number; food: number }
  | { type: 'chat'; username: string; message: string }
  | { type: 'entityHurt'; entity: string; health: number }
  | { type: 'death' }
  | { type: 'spawn' }
  | { type: 'time'; timeOfDay: number; isDay: boolean };

export type EventCallback = (event: GameEvent) => void | Promise<void>;

const pendingEvents: GameEvent[] = [];
const MAX_PENDING = 50;

/**
 * 注册事件监听，当游戏内发生重要变化时回调
 * 用于事件驱动模式：仅在有实质性变化时触发 AI 推理
 */
export function registerEventListeners(bot: Bot, onEvent: EventCallback): void {
  let lastHealth = bot.health;
  let lastFood = bot.food;

  const push = (e: GameEvent) => {
    pendingEvents.push(e);
    if (pendingEvents.length > MAX_PENDING) pendingEvents.shift();
    onEvent(e);
  };

  bot.on('health', () => {
    if (bot.health !== lastHealth || bot.food !== lastFood) {
      lastHealth = bot.health;
      lastFood = bot.food;
      push({ type: 'health', health: bot.health, food: bot.food });
    }
  });

  bot.on('chat', (username: string, message: string) => {
    // 过滤掉 bot 自己的消息，避免自己触发快思考→自己和自己对话
    if (username === bot.username) return;
    push({ type: 'chat', username, message });
  });

  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      push({ type: 'entityHurt', entity: 'self', health: bot.health });
    }
  });

  bot.on('death', () => {
    push({ type: 'death' });
  });

  bot.on('spawn', () => {
    push({ type: 'spawn' });
  });

  // 仅在日夜切换时触发，避免每 tick (50ms) 洪泛
  let wasDay = true;
  bot.on('time', () => {
    const time = bot.time as { timeOfDay?: number; isDay?: boolean };
    const isDay = (time.timeOfDay ?? 0) < 12000;
    if (isDay !== wasDay) {
      wasDay = isDay;
      push({ type: 'time', timeOfDay: time.timeOfDay ?? 0, isDay });
    }
  });
}

/** 获取并清空待处理事件（供不支持推送的客户端轮询） */
export function getAndClearPendingEvents(): GameEvent[] {
  const copy = [...pendingEvents];
  pendingEvents.length = 0;
  return copy;
}
