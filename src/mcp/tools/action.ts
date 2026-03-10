/**
 * 行动工具
 */
import type { Bot } from 'mineflayer';
import { z } from 'zod';
import { gotoWithTimeout } from '../../bot/pathfinder.js';
import { setBusy, clearBusy } from '../../bot/actionLock.js';

/** 缓存 minecraft-data 实例，避免每次工具调用都 dynamic import */
let mcDataCache: { version: string; data: unknown } | null = null;
export async function getMcData(version: string) {
  if (mcDataCache && mcDataCache.version === version) return mcDataCache.data as Record<string, any>;
  const mod = await import('minecraft-data');
  const factory = (mod.default ?? mod) as (v: string) => Record<string, any>;
  const data = factory(version);
  mcDataCache = { version, data };
  return data as Record<string, any>;
}

export const actionToolSchemas = {
  move_to: {
    description: '移动/走路/寻路到指定坐标（这是唯一的移动方式，没有 walk/wander/go 等命令）。Bot 会自动寻路避开障碍物。',
    inputSchema: {
      x: z.number().describe('目标 X 坐标'),
      y: z.number().describe('目标 Y 坐标（高度）'),
      z: z.number().describe('目标 Z 坐标'),
      range: z.number().optional().describe('到达范围（格），默认2'),
    },
  },
  mine: {
    description: '挖掘/采集方块（也用于砍树、挖矿）。可以按方块类型自动寻找最近的，也可以指定精确坐标。Bot 会自动走过去并挖掘。',
    inputSchema: {
      block_type: z.string().optional().describe('方块类型名，如 oak_log(砍树), stone(挖石头), coal_ore(挖煤矿), iron_ore(挖铁矿), dirt(挖泥土)'),
      x: z.number().optional().describe('精确 X 坐标（与 block_type 二选一）'),
      y: z.number().optional().describe('精确 Y 坐标'),
      z: z.number().optional().describe('精确 Z 坐标'),
    },
  },
  craft: {
    description: '合成/制作物品。需要背包有足够的材料。常用: wooden_planks(木板), stick(木棍), crafting_table(工作台), wooden_pickaxe(木镐), stone_pickaxe(石镐)',
    inputSchema: {
      item_name: z.string().describe('要合成的物品名称（Minecraft 内部名）'),
      count: z.number().optional().describe('合成数量，默认1'),
    },
  },
  chat: {
    description: '在游戏内聊天中发送消息，与其他玩家交流。',
    inputSchema: {
      message: z.string().describe('要发送的消息内容'),
    },
  },
  equip: {
    description: '装备/手持物品。用于切换手中的工具或武器。（注意：不是 hold/use/select，只有 equip）',
    inputSchema: {
      item_name: z.string().describe('物品名称，如 diamond_sword, wooden_pickaxe, torch'),
    },
  },
  attack: {
    description: '攻击指定目标（生物或玩家）。会持续攻击直到目标死亡或 60 秒超时。用于自卫或狩猎。',
    inputSchema: {
      target_name: z.string().describe('目标名称，如 zombie, skeleton, creeper, 或玩家用户名'),
    },
  },
  eat: {
    description: '进食/吃东西恢复饥饿度。可指定食物名，也可留空自动选背包里恢复最高的食物。',
    inputSchema: {
      food_name: z.string().optional().describe('食物名称如 bread, cooked_beef, apple。留空=自动选最好的'),
    },
  },
};

export async function executeMoveTo(bot: Bot, args: { x: number; y: number; z: number; range?: number }): Promise<string> {
  setBusy('move_to');
  try {
    await gotoWithTimeout(bot, args.x, args.y, args.z, args.range ?? 2);
    return `已到达 (${args.x}, ${args.y}, ${args.z})`;
  } finally {
    clearBusy();
  }
}

export async function executeMine(
  bot: Bot,
  args: { block_type?: string; x?: number; y?: number; z?: number }
): Promise<string> {
  setBusy('mine');
  try {
    return await executeMineInner(bot, args);
  } finally {
    clearBusy();
  }
}

async function executeMineInner(
  bot: Bot,
  args: { block_type?: string; x?: number; y?: number; z?: number }
): Promise<string> {
  const pfBot = bot as Bot & { collectBlock?: { collect: (b: unknown) => Promise<void> } };

  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const { Vec3 } = await import('vec3');
    const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
    if (!block) return `坐标 (${args.x},${args.y},${args.z}) 处无方块`;
    if (block.name === 'air') return `该位置是空气`;
    if (pfBot.collectBlock) {
      await pfBot.collectBlock.collect(block);
      return `已挖掘并收集 ${block.name}`;
    }
    await bot.dig(block);
    return `已挖掘 ${block.name}`;
  }

  if (args.block_type) {
    const mcData = await getMcData(bot.version);
    const blockId = mcData.blocksByName[args.block_type]?.id;
    if (!blockId) return `未知方块类型: ${args.block_type}`;

    const block = bot.findBlock({
      matching: blockId,
      maxDistance: 64,
    });
    if (!block) return `附近未找到 ${args.block_type}`;

    if (pfBot.collectBlock) {
      await pfBot.collectBlock.collect(block);
      return `已挖掘并收集 ${args.block_type}`;
    }
    await bot.dig(block);
    return `已挖掘 ${args.block_type}`;
  }

  return '请提供 block_type 或 (x, y, z) 坐标';
}

function findTargetEntity(bot: Bot, targetName: string): unknown {
  const name = targetName.toLowerCase();
  let best: unknown = null;
  let bestDist = Infinity;

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity) continue;
    const ent = entity as { username?: string; name?: string; position?: { distanceTo: (p: unknown) => number } };
    const displayName = (ent.username ?? ent.name ?? '').toLowerCase();
    if (!displayName.includes(name)) continue;

    const dist = ent.position!.distanceTo(bot.entity!.position);
    if (dist < bestDist) {
      bestDist = dist;
      best = entity;
    }
  }
  return best;
}

export async function executeAttack(bot: Bot, args: { target_name: string }): Promise<string> {
  const target = findTargetEntity(bot, args.target_name) as { isValid?: boolean; once?: (ev: string, fn: () => void) => void; username?: string; name?: string } | null;
  if (!target) return `未找到目标「${args.target_name}」`;

  setBusy('attack');
  const ATTACK_INTERVAL_MS = 750;
  const MAX_ATTACK_MS = 60000;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stopAttack = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    clearBusy();
  };

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (msg: string) => {
      if (resolved) return;
      resolved = true;
      stopAttack();
      clearTimeout(timeoutId);
      // 清除 death 监听，防止泄漏
      (target as { removeListener: (ev: string, fn: (...a: unknown[]) => void) => void }).removeListener('death', onDeath);
      resolve(msg);
    };

    const timeoutId = setTimeout(() => {
      finish('攻击超时，已停止');
    }, MAX_ATTACK_MS);

    const checkTarget = () => {
      if (!(target as { isValid?: boolean }).isValid || !bot.entity) {
        finish('目标已消失');
        return;
      }
      try { bot.attack(target as Parameters<Bot['attack']>[0]); } catch { /* ignore */ }
    };

    const onDeath = () => {
      finish(`已击杀 ${target.username ?? target.name ?? '目标'}`);
    };

    checkTarget();
    intervalId = setInterval(checkTarget, ATTACK_INTERVAL_MS);
    (target as { once: (ev: string, fn: () => void) => void }).once('death', onDeath);
  });
}

/** 食物恢复值（简化，常见食物） */
const FOOD_POINTS: Record<string, number> = {
  cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6,
  steak: 8, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3,
  bread: 5, baked_potato: 5, carrot: 3, apple: 4, golden_apple: 4,
  melon_slice: 2, sweet_berries: 2, mushroom_stew: 6, rabbit_stew: 10,
  cooked_cod: 5, cooked_salmon: 6, tropical_fish: 1, pufferfish: 1,
};

function getFoodPoints(name: string): number {
  return FOOD_POINTS[name] ?? (name.includes('cooked') ? 5 : 2);
}

export async function executeEat(bot: Bot, args: { food_name?: string }): Promise<string> {
  const inv = bot.inventory;
  if (!inv?.items) return '背包尚未加载';

  const items = inv.items();
  // 仅从已知食物中选择，避免选中非食物物品
  const foodItems = items.filter((i) => i.name in FOOD_POINTS);

  let item = args.food_name
    ? items.find((i) => i.name.includes(args.food_name!))
    : foodItems.reduce<typeof items[0] | undefined>((best, i) => {
        const pts = getFoodPoints(i.name);
        return !best || pts > getFoodPoints(best.name) ? i : best;
      }, undefined);

  if (!item) return args.food_name ? `背包中无 ${args.food_name}` : '背包中无可食用食物';

  await bot.equip(item, 'hand');
  await bot.consume();
  return `已食用 ${item.name}`;
}

export async function executeChat(bot: Bot, args: { message: string }): Promise<string> {
  if (typeof bot.chat !== 'function') {
    const client = bot as Bot & { _client?: { write?: (name: string, data: unknown) => void } };
    if (client._client?.write) {
      client._client.write('chat', { message: args.message });
      return `已发送 (fallback): ${args.message}`;
    }
    throw new Error('聊天功能不可用，请检查服务器版本');
  }
  bot.chat(args.message);
  return `已发送: ${args.message}`;
}

export async function executeEquip(bot: Bot, args: { item_name: string }): Promise<string> {
  const item = bot.inventory.items().find((i) => i.name.includes(args.item_name));
  if (!item) return `背包中无 ${args.item_name}`;
  await bot.equip(item, 'hand');
  return `已装备 ${item.name}`;
}
