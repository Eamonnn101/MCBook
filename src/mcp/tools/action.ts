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
  place: {
    description: '放置方块到指定坐标。需要背包中有对应方块物品。Bot会自动走到附近并放置。',
    inputSchema: {
      block_name: z.string().describe('要放置的方块物品名，如 oak_planks, cobblestone, dirt, crafting_table'),
      x: z.number().describe('目标 X 坐标'),
      y: z.number().describe('目标 Y 坐标（高度）'),
      z: z.number().describe('目标 Z 坐标'),
    },
  },
  follow_player: {
    description: '持续跟随指定玩家移动。Bot 会自动寻路跟在玩家身后，直到达到指定时间或手动停止。',
    inputSchema: {
      player_name: z.string().describe('要跟随的玩家名称'),
      duration: z.number().optional().describe('跟随持续时间（秒），默认30秒，最长120秒'),
      distance: z.number().optional().describe('跟随距离（格），默认3'),
    },
  },
  stop_follow: {
    description: '停止跟随玩家，原地站定。',
    inputSchema: {},
  },
};

export async function executeFollowPlayer(
  bot: Bot,
  args: { player_name: string; duration?: number; distance?: number },
): Promise<string> {
  const target = bot.players[args.player_name]?.entity;
  if (!target) {
    return `找不到玩家 ${args.player_name}（不在视野内或未上线）`;
  }

  const duration = Math.min(args.duration ?? 30, 120) * 1000;
  const followDist = args.distance ?? 3;

  setBusy('follow_player');
  try {
    const pfBot = bot as Bot & { pathfinder?: { setGoal: (g: unknown) => void; isMoving: () => boolean } };
    if (!pfBot.pathfinder) {
      return '寻路模块未加载';
    }

    const pfModule = await import('mineflayer-pathfinder');
    const GoalFollow = (pfModule as unknown as {
      goals: { GoalFollow: new (entity: unknown, range: number) => unknown };
    }).goals.GoalFollow;

    pfBot.pathfinder.setGoal(new GoalFollow(target, followDist));

    // Wait for duration, periodically checking if player still exists
    const startTime = Date.now();
    while (Date.now() - startTime < duration) {
      await new Promise(r => setTimeout(r, 1000));
      const currentTarget = bot.players[args.player_name]?.entity;
      if (!currentTarget) {
        pfBot.pathfinder.setGoal(null as unknown as never);
        return `跟随结束: 玩家 ${args.player_name} 离开了视野（已跟随 ${Math.round((Date.now() - startTime) / 1000)}秒）`;
      }
      // Update goal to keep following (entity ref may change)
      pfBot.pathfinder.setGoal(new GoalFollow(currentTarget, followDist));
    }

    pfBot.pathfinder.setGoal(null as unknown as never);
    return `已跟随 ${args.player_name} ${Math.round(duration / 1000)} 秒`;
  } finally {
    clearBusy();
  }
}

export async function executeStopFollow(bot: Bot): Promise<string> {
  try {
    const pfBot = bot as Bot & { pathfinder?: { setGoal: (g: unknown) => void } };
    pfBot.pathfinder?.setGoal(null as unknown as never);
  } catch { /* ignore */ }
  clearBusy();
  return '已停止跟随';
}

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

/** 判断方块名是否为原木（树干）类型 */
function isLogBlock(name: string): boolean {
  return name.endsWith('_log') || name.endsWith('_wood') || name === 'mangrove_log';
}

/**
 * 工具优先级表：针对不同方块类型，按优先级排列最佳工具
 */
const TOOL_PRIORITY: Record<string, string[]> = {
  // 原木/木头 → 斧头
  log: ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'],
  wood: ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe'],
  // 石头/矿物 → 镐子
  stone: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
  ore: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
  deepslate: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
  cobblestone: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'],
  // 泥土/沙子 → 铲子
  dirt: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'],
  sand: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'],
  gravel: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'],
  grass: ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'],
};

/**
 * 自动装备最佳工具
 * 优先使用 mineflayer-tool 插件，fallback 到手动匹配
 */
async function autoEquipBestTool(bot: Bot, block: unknown): Promise<void> {
  // 策略 1：尝试 mineflayer-tool 插件
  const toolBot = bot as Bot & { tool?: { equipForBlock: (b: unknown) => Promise<void> } };
  if (toolBot.tool?.equipForBlock) {
    try {
      await toolBot.tool.equipForBlock(block);
      return;
    } catch {
      // 插件失败，fallback 到手动匹配
    }
  }

  // 策略 2：手动匹配最佳工具
  const blockName = (block as { name?: string }).name ?? '';
  const items = bot.inventory.items();
  if (items.length === 0) return;

  // 根据方块名匹配工具优先级列表
  let toolList: string[] | undefined;
  for (const [keyword, tools] of Object.entries(TOOL_PRIORITY)) {
    if (blockName.includes(keyword)) {
      toolList = tools;
      break;
    }
  }
  if (!toolList) return;

  // 在背包中找到优先级最高的工具
  for (const toolName of toolList) {
    const item = items.find(i => i.name === toolName);
    if (item) {
      try {
        await bot.equip(item, 'hand');
        console.log(`[AutoEquip] 装备 ${toolName} 用于挖 ${blockName}`);
      } catch { /* ignore */ }
      return;
    }
  }
}

/**
 * 砍整棵树：从底部原木开始，向上找到所有相连的原木并依次挖掘
 * 返回挖掘的原木数量
 */
async function chopTree(bot: Bot, baseBlock: { position: { x: number; y: number; z: number; offset: (x: number, y: number, z: number) => { x: number; y: number; z: number } }; name: string }): Promise<number> {
  const { Vec3 } = await import('vec3');
  let count = 0;
  const baseX = baseBlock.position.x;
  const baseZ = baseBlock.position.z;
  let y = baseBlock.position.y;

  // 从基座向上逐格检查原木（包括斜上方1格，覆盖大橡树等）
  const maxHeight = 30; // 安全上限
  while (count < maxHeight) {
    let foundLog = false;

    // 检查当前 y 层以及周围 1 格（覆盖大树/斜树干）
    const offsets = count === 0
      ? [{ dx: 0, dz: 0 }]  // 第一个直接挖传入的方块位置
      : [
          { dx: 0, dz: 0 },
          { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
          { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
        ];

    for (const { dx, dz } of offsets) {
      const pos = new Vec3(baseX + dx, y, baseZ + dz);
      const block = bot.blockAt(pos);
      if (block && isLogBlock(block.name)) {
        // 走近到能挖的距离
        const dist = bot.entity.position.distanceTo(pos);
        if (dist > 4.5) {
          try {
            await gotoWithTimeout(bot, pos.x, pos.y, pos.z, 3);
          } catch {
            // 走不过去就跳过
            continue;
          }
        }
        await autoEquipBestTool(bot, block);
        try {
          await bot.dig(block);
          count++;
          foundLog = true;
        } catch {
          // 挖不了就跳过
        }
      }
    }

    if (!foundLog && count > 0) break; // 连续空层说明到树顶了
    y++;
  }

  return count;
}

/**
 * 挖掘后返回地面：如果挖掘导致 bot 位置低于出发点，尝试回到出发高度
 */
async function returnToSurface(bot: Bot, originY: number): Promise<void> {
  const currentY = Math.floor(bot.entity.position.y);
  if (currentY >= originY) return; // 没有掉下去

  console.log(`[Mine] 挖掘后掉到 y=${currentY}，尝试回到 y=${originY}`);

  // 策略1: 用 pathfinder 走回去
  try {
    await gotoWithTimeout(
      bot,
      Math.floor(bot.entity.position.x),
      originY,
      Math.floor(bot.entity.position.z),
      2,
    );
    return;
  } catch {
    // pathfinder 失败，尝试手动垫方块
  }

  // 策略2: 手动垫方块（pillar up）
  const { Vec3 } = await import('vec3');
  const scaffoldNames = ['dirt', 'cobblestone', 'oak_planks', 'oak_log', 'stone', 'sand', 'gravel', 'cobbled_deepslate', 'netherrack'];
  const maxPillar = originY - currentY + 1;

  for (let i = 0; i < maxPillar && Math.floor(bot.entity.position.y) < originY; i++) {
    const item = bot.inventory.items().find(it => scaffoldNames.some(s => it.name.includes(s)));
    if (!item) {
      console.log(`[Mine] 无方块可垫，无法回到地面`);
      break;
    }

    const startY = Math.floor(bot.entity.position.y);
    const bx = Math.floor(bot.entity.position.x);
    const bz = Math.floor(bot.entity.position.z);
    const belowBlock = bot.blockAt(new Vec3(bx, startY - 1, bz));
    if (!belowBlock || belowBlock.name === 'air') break;

    try {
      await bot.equip(item, 'hand');
      await bot.lookAt(new Vec3(bx + 0.5, startY, bz + 0.5), true);

      bot.setControlState('sneak', true);
      bot.setControlState('jump', true);

      for (let t = 0; t < 20; t++) {
        await new Promise(r => setTimeout(r, 50));
        if (bot.entity.position.y > startY + 0.5) break;
      }
      bot.setControlState('jump', false);

      const support = bot.blockAt(new Vec3(bx, startY - 1, bz));
      if (support && support.name !== 'air') {
        await (bot as any)._genericPlace(support, new Vec3(0, 1, 0), { sneak: true });
        console.log(`[Mine] 垫方块 ${item.name} → y=${startY}`);
      }
      bot.setControlState('sneak', false);
      await new Promise(r => setTimeout(r, 500));
    } catch {
      bot.setControlState('jump', false);
      bot.setControlState('sneak', false);
      break;
    }
  }
}

async function executeMineInner(
  bot: Bot,
  args: { block_type?: string; x?: number; y?: number; z?: number }
): Promise<string> {
  // 记住出发点高度，挖完后回到地面
  const originY = Math.floor(bot.entity.position.y);

  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const { Vec3 } = await import('vec3');
    const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
    if (!block) return `坐标 (${args.x},${args.y},${args.z}) 处无方块`;
    if (block.name === 'air') return `该位置是空气`;

    // 走近
    const dist = bot.entity.position.distanceTo(block.position);
    if (dist > 4.5) {
      await gotoWithTimeout(bot, args.x, args.y, args.z, 3);
    }

    // 如果是原木，砍整棵树
    if (isLogBlock(block.name)) {
      const count = await chopTree(bot, block);
      await returnToSurface(bot, originY);
      return count > 0 ? `已砍伐整棵树，共 ${count} 个 ${block.name}` : `无法挖掘 ${block.name}`;
    }

    await autoEquipBestTool(bot, block);
    await bot.dig(block);
    await returnToSurface(bot, originY);
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

    // 走近
    const dist = bot.entity.position.distanceTo(block.position);
    if (dist > 4.5) {
      await gotoWithTimeout(bot, block.position.x, block.position.y, block.position.z, 3);
    }

    // 如果是原木，砍整棵树
    if (isLogBlock(args.block_type)) {
      const count = await chopTree(bot, block);
      await returnToSurface(bot, originY);
      return count > 0 ? `已砍伐整棵树，共 ${count} 个 ${args.block_type}` : `附近未找到可砍伐的 ${args.block_type}`;
    }

    await autoEquipBestTool(bot, block);
    await bot.dig(block);
    await returnToSurface(bot, originY);
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
  const target = findTargetEntity(bot, args.target_name) as {
    isValid?: boolean;
    once?: (ev: string, fn: () => void) => void;
    removeListener?: (ev: string, fn: (...a: unknown[]) => void) => void;
    username?: string;
    name?: string;
    position: { x: number; y: number; z: number; distanceTo: (p: unknown) => number };
  } | null;
  if (!target) return `未找到目标「${args.target_name}」`;

  setBusy('attack');
  const ATTACK_INTERVAL_MS = 600;
  const MAX_ATTACK_MS = 30000;     // 30秒超时（不再是60秒）
  const ATTACK_RANGE = 3.5;         // 近战攻击距离
  const GIVE_UP_RANGE = 32;         // 目标跑超过32格就放弃
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stopAttack = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // 停止追踪移动
    try {
      const pfBot = bot as Bot & { pathfinder?: { setGoal: (g: unknown) => void } };
      pfBot.pathfinder?.setGoal(null);
    } catch { /* ignore */ }
    clearBusy();
  };

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (msg: string) => {
      if (resolved) return;
      resolved = true;
      stopAttack();
      clearTimeout(timeoutId);
      target.removeListener?.('death', onDeath);
      resolve(msg);
    };

    const timeoutId = setTimeout(() => {
      finish('攻击超时，已停止');
    }, MAX_ATTACK_MS);

    const checkTarget = async () => {
      // 目标失效
      if (!target.isValid || !bot.entity) {
        finish('目标已消失');
        return;
      }

      const dist = target.position.distanceTo(bot.entity.position);

      // 目标跑太远，放弃追击
      if (dist > GIVE_UP_RANGE) {
        finish(`目标已远离 (${Math.round(dist)}格)，停止追击`);
        return;
      }

      // 面向目标
      try {
        const { Vec3 } = await import('vec3');
        const targetPos = new Vec3(target.position.x, target.position.y + 1.6, target.position.z);
        await bot.lookAt(targetPos);
      } catch { /* ignore */ }

      // 如果太远，追踪目标
      if (dist > ATTACK_RANGE) {
        try {
          const pfBot = bot as Bot & { pathfinder?: { setGoal: (g: unknown) => void } };
          if (pfBot.pathfinder) {
            const pfModule = await import('mineflayer-pathfinder');
            const GoalFollow = (pfModule as unknown as { goals: { GoalFollow: new (entity: unknown, range: number) => unknown } }).goals.GoalFollow;
            pfBot.pathfinder.setGoal(new GoalFollow(target, ATTACK_RANGE - 0.5));
          }
        } catch { /* ignore */ }
        return; // 这一 tick 只追踪，下一 tick 再攻击
      }

      // 在攻击范围内，执行攻击
      try {
        bot.attack(target as unknown as Parameters<Bot['attack']>[0]);
      } catch { /* ignore */ }
    };

    const onDeath = () => {
      finish(`已击杀 ${target.username ?? target.name ?? '目标'}`);
    };

    // 首次立即攻击
    checkTarget();
    intervalId = setInterval(() => { checkTarget(); }, ATTACK_INTERVAL_MS);
    target.once?.('death', onDeath);
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

export async function executePlace(bot: Bot, args: { block_name: string; x: number; y: number; z: number }): Promise<string> {
  const { Vec3 } = await import('vec3');

  // Find the item in inventory
  const item = bot.inventory.items().find((i) => i.name === args.block_name);
  if (!item) return `背包中无 ${args.block_name}`;

  // Equip the block in hand
  await bot.equip(item, 'hand');

  const targetPos = new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z));

  // Check if the target position is already occupied by a solid block
  const targetBlock = bot.blockAt(targetPos);
  if (targetBlock && targetBlock.name !== 'air' && targetBlock.name !== 'water' && targetBlock.name !== 'lava') {
    return `目标位置 (${args.x},${args.y},${args.z}) 已被 ${targetBlock.name} 占据`;
  }

  // Find an adjacent solid block to place against
  const faces = [
    { vec: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },   // below -> place on top
    { vec: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },    // above -> place on bottom
    { vec: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },    // west -> place on east face
    { vec: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },    // east -> place on west face
    { vec: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },    // north -> place on south face
    { vec: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },    // south -> place on north face
  ];

  for (const { vec, face } of faces) {
    const refPos = targetPos.plus(vec);
    const refBlock = bot.blockAt(refPos);
    if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water' && refBlock.name !== 'lava') {
      // Move close enough to place (within 4.5 blocks)
      const dist = bot.entity.position.distanceTo(targetPos);
      if (dist > 4.5) {
        await gotoWithTimeout(bot, targetPos.x, targetPos.y, targetPos.z, 3);
      }
      await bot.placeBlock(refBlock, face);
      return `已放置 ${args.block_name} 在 (${args.x},${args.y},${args.z})`;
    }
  }

  return `无法放置: 目标位置 (${args.x},${args.y},${args.z}) 周围无相邻实体方块可依附`;
}
