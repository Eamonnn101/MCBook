/**
 * 本地规则引擎 - 简单生存决策，零 token 消耗
 * 处理不需要 LLM 推理的机械性反应：饥饿时吃东西、被攻击时装备武器等
 */
import type { Bot } from 'mineflayer';

export interface RuleAction {
  type: string;
  detail: string;
}

const FOOD_PRIORITY = [
  'golden_apple', 'rabbit_stew', 'cooked_beef', 'steak', 'cooked_porkchop',
  'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'cooked_cod',
  'baked_potato', 'bread', 'apple', 'carrot', 'melon_slice', 'sweet_berries',
];

const WEAPON_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
];

function findItemByPriority(bot: Bot, priorityList: string[]): { name: string; slot: number } | null {
  const items = bot.inventory?.items?.() ?? [];
  for (const target of priorityList) {
    const item = items.find((i) => i.name === target);
    if (item) return { name: item.name, slot: item.slot };
  }
  return null;
}

/**
 * 自动进食：饥饿度 < threshold 时自动吃背包里最好的食物
 */
async function autoEat(bot: Bot, threshold = 8): Promise<RuleAction | null> {
  if (bot.food >= threshold) return null;
  const food = findItemByPriority(bot, FOOD_PRIORITY);
  if (!food) return null;

  try {
    const item = bot.inventory.items().find((i) => i.name === food.name);
    if (!item) return null;
    await bot.equip(item, 'hand');
    await bot.consume();
    return { type: 'auto_eat', detail: `自动食用 ${food.name}，饥饿度 ${bot.food}/20` };
  } catch {
    return null;
  }
}

/**
 * 被攻击时自动装备最好的武器
 */
async function autoEquipWeapon(bot: Bot): Promise<RuleAction | null> {
  const held = bot.heldItem;
  if (held && WEAPON_PRIORITY.includes(held.name)) return null;

  const weapon = findItemByPriority(bot, WEAPON_PRIORITY);
  if (!weapon) return null;

  try {
    const item = bot.inventory.items().find((i) => i.name === weapon.name);
    if (!item) return null;
    await bot.equip(item, 'hand');
    return { type: 'auto_equip', detail: `自动装备 ${weapon.name}` };
  } catch {
    return null;
  }
}

/** 被攻击冷却：避免反复触发 */
let lastHurtTime = 0;
const HURT_COOLDOWN_MS = 3000;

/**
 * 注册本地规则到 bot 事件
 * 返回一个回调列表，规则触发时 log
 */
export function registerLocalRules(
  bot: Bot,
  onAction?: (action: RuleAction) => void
): void {
  // 低饥饿度自动进食（health 事件中检查）
  bot.on('health', () => {
    autoEat(bot).then((action) => {
      if (action) onAction?.(action);
    }).catch(() => {});
  });

  // 被攻击时自动装备武器
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const now = Date.now();
    if (now - lastHurtTime < HURT_COOLDOWN_MS) return;
    lastHurtTime = now;

    autoEquipWeapon(bot).then((action) => {
      if (action) onAction?.(action);
    }).catch(() => {});
  });
}
