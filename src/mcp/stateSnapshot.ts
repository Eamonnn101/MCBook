/**
 * 死亡状态快照 - 在死亡瞬间抓取死前状态
 * 方案：health 事件时保存快照，death 时使用最近快照（死亡时背包已清空，需用扣血前的快照）
 */
import type { Bot } from 'mineflayer';

export interface DeathVerdict {
  killer?: string;
  lastHeldItem?: string;
  hadArmor?: boolean;
  inventory?: string[];
  health?: number;
  food?: number;
}

let lastSnapshot: DeathVerdict | null = null;

export function captureSnapshot(bot: Bot): DeathVerdict {
  const inv = bot.inventory?.items?.() ?? [];
  const held = bot.heldItem;
  const invItems = inv.map((i) => i.name);
  const hadArmor = invItems.some((n) =>
    n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots')
  );

  lastSnapshot = {
    lastHeldItem: held?.name,
    hadArmor,
    inventory: inv.map((i) => `${i.name} x${i.count}`),
    health: bot.health,
    food: bot.food,
  };
  return lastSnapshot;
}

export function getLastSnapshot(): DeathVerdict | null {
  return lastSnapshot;
}

export function clearSnapshot(): void {
  lastSnapshot = null;
}

/**
 * 注册到 bot：health 时保存快照，death 时可通过 getLastSnapshot 获取
 */
export function registerStateSnapshot(bot: Bot): void {
  let lastHealth = bot.health;

  bot.on('health', () => {
    if (bot.health < lastHealth) {
      captureSnapshot(bot);
    }
    lastHealth = bot.health;
  });

  bot.on('death', () => {
    if (!lastSnapshot) captureSnapshot(bot);
  });
}
