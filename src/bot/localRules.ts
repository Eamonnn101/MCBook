/**
 * 本地规则引擎 - 快思考（System 1）反射弧
 *
 * 参考《Thinking, Fast and Slow》System 1：
 * 不经过 AI 推理，直接执行的本能反应。零 token、零延迟。
 *
 * 包括：
 * - 被攻击 → 自动装备武器（战斗/逃跑交给 AI 快思考决策）
 * - 饥饿 → 自动进食
 * - 低血量 → 进食恢复
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

/** 自动进食 */
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
  } catch { return null; }
}

/** 自动装备武器 */
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
  } catch { return null; }
}


/** 被攻击冷却 */
let lastHurtTime = 0;
const HURT_COOLDOWN_MS = 2000;

/** 低血量自动吃东西冷却 */
let lastLowHpEatTime = 0;
const LOW_HP_EAT_COOLDOWN_MS = 5000;

/** 苦力怕闪避冷却 */
let lastCreeperDodgeTime = 0;
const CREEPER_DODGE_COOLDOWN_MS = 3000;
/** 苦力怕检测距离（格） */
const CREEPER_DANGER_RADIUS = 6;

/**
 * 注册本地规则（System 1 反射弧）
 */
export function registerLocalRules(
  bot: Bot,
  onAction?: (action: RuleAction) => void
): void {
  // 低饥饿度自动进食
  bot.on('health', () => {
    autoEat(bot).then((action) => {
      if (action) onAction?.(action);
    }).catch(() => {});

    // 低血量主动进食恢复（即使不饿）
    if (bot.health < 10) {
      const now = Date.now();
      if (now - lastLowHpEatTime < LOW_HP_EAT_COOLDOWN_MS) return;
      lastLowHpEatTime = now;
      autoEat(bot, 20).then((action) => {
        if (action) {
          action.detail = `低血量(${bot.health})紧急进食 - ${action.detail}`;
          onAction?.(action);
        }
      }).catch(() => {});
    }
  });

  // 被攻击：仅自动装备武器（战斗/逃跑决策交给 AI 快思考）
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const now = Date.now();
    if (now - lastHurtTime < HURT_COOLDOWN_MS) return;
    lastHurtTime = now;

    // 自动装备武器（本能反应，不需要 AI 判断）
    autoEquipWeapon(bot).then((action) => {
      if (action) onAction?.(action);
    }).catch(() => {});
  });

  // 苦力怕靠近 → 立即闪避（System 0 反射，<50ms 决策）
  bot.on('entityMoved', (entity) => {
    if (!entity?.name || entity.name !== 'creeper') return;
    if (!bot.entity?.position) return;
    const now = Date.now();
    if (now - lastCreeperDodgeTime < CREEPER_DODGE_COOLDOWN_MS) return;

    const dist = entity.position.distanceTo(bot.entity.position);
    if (dist > CREEPER_DANGER_RADIUS) return;

    lastCreeperDodgeTime = now;

    // 计算逃跑方向（远离苦力怕）
    const dx = bot.entity.position.x - entity.position.x;
    const dz = bot.entity.position.z - entity.position.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const escapeX = bot.entity.position.x + (dx / len) * 8;
    const escapeZ = bot.entity.position.z + (dz / len) * 8;

    // 立即设置控制状态：冲刺 + 跳跃逃离
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    bot.lookAt(bot.entity.position.offset(dx / len * 5, 0, dz / len * 5));

    // 1秒后停止冲刺（避免卡状态）
    setTimeout(() => {
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    }, 1000);

    onAction?.({
      type: 'creeper_dodge',
      detail: `⚡苦力怕靠近(${dist.toFixed(1)}格)! 立即闪避 → (${Math.round(escapeX)},${Math.round(escapeZ)})`,
    });
  });

  // 脚下方块检测：岩浆/火 → 跳离（System 0 反射）
  bot.on('move', () => {
    if (!bot.entity?.position) return;
    const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!blockBelow) return;

    const dangerBlocks = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block'];
    if (!dangerBlocks.includes(blockBelow.name)) return;

    // 跳跃 + 冲刺逃离
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    setTimeout(() => {
      bot.setControlState('jump', false);
      bot.setControlState('sprint', false);
    }, 800);

    onAction?.({
      type: 'lava_dodge',
      detail: `⚡脚下是${blockBelow.name}! 紧急跳离`,
    });
  });
}
