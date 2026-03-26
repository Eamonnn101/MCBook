/**
 * 感知工具 - 认知优化：相对方位 + ASCII 网格
 * get_scan 白名单降噪：仅玩家、敌对生物、矿物、食物源
 */
import type { Bot } from 'mineflayer';
import { z } from 'zod';

const DIRECTION_NAMES: Record<string, string> = {
  front: '正前方',
  back: '正后方',
  left: '左侧',
  right: '右侧',
  front_left: '左前方',
  front_right: '右前方',
  back_left: '左后方',
  back_right: '右后方',
};

const BLOCK_TO_CHAR: Record<string, string> = {
  oak_log: 'T',
  spruce_log: 'T',
  birch_log: 'T',
  jungle_log: 'T',
  acacia_log: 'T',
  dark_oak_log: 'T',
  water: 'W',
  lava: 'L',
  stone: 'S',
  cobblestone: 'S',
  grass_block: 'G',
  dirt: 'D',
  sand: 'n',
  gravel: 'r',
  coal_ore: 'C',
  iron_ore: 'I',
  gold_ore: 'G',
  diamond_ore: 'D',
  air: '.',
};

function getBlockChar(name: string): string {
  const key = Object.keys(BLOCK_TO_CHAR).find((k) => name.includes(k));
  return key ? BLOCK_TO_CHAR[key] : '?';
}

/**
 * 根据 bot 朝向，将相对坐标转换为方位描述
 */
function toRelativeDirection(
  bot: Bot,
  dx: number,
  dy: number,
  dz: number
): { direction: string; distance: number } {
  const yaw = bot.entity.yaw;
  const cos = Math.cos(-yaw);
  const sin = Math.sin(-yaw);
  const relX = dx * cos - dz * sin;
  const relZ = dx * sin + dz * cos;

  const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
  let direction = '';

  const angle = Math.atan2(relX, relZ);
  const deg = (angle * 180) / Math.PI;

  if (Math.abs(deg) < 22.5) direction = 'front';
  else if (Math.abs(deg - 180) < 22.5 || Math.abs(deg + 180) < 22.5) direction = 'back';
  else if (deg > 22.5 && deg < 67.5) direction = 'front_left';
  else if (deg > 67.5 && deg < 112.5) direction = 'left';
  else if (deg > 112.5 && deg < 157.5) direction = 'back_left';
  else if (deg < -22.5 && deg > -67.5) direction = 'front_right';
  else if (deg < -67.5 && deg > -112.5) direction = 'right';
  else direction = 'back_right';

  return { direction: DIRECTION_NAMES[direction] ?? direction, distance: dist };
}

/** 敌对生物名称（白名单） */
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom',
  'drowned', 'husk', 'stray', 'wither_skeleton', 'blaze', 'ghast', 'piglin',
  'hoglin', 'zoglin', 'warden',
]);

/** 矿物/资源方块（白名单） */
const ORE_AND_RESOURCE = new Set([
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'lapis_ore',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
]);

/** 食物源方块 */
const FOOD_SOURCE = new Set([
  'oak_leaves', 'birch_leaves', 'jungle_leaves', 'grass', 'tall_grass',
  'sweet_berry_bush', 'carrots', 'potatoes', 'wheat', 'beetroots',
]);

function isHostileMob(name: string): boolean {
  return HOSTILE_MOBS.has(name) || name.includes('zombie') || name.includes('skeleton');
}

function isWhitelistBlock(name: string): boolean {
  if (ORE_AND_RESOURCE.has(name)) return true;
  if (FOOD_SOURCE.has(name)) return true;
  if (name.endsWith('_ore') || name.endsWith('_log') || name.endsWith('_leaves')) return true;
  return false;
}

/**
 * 实体扫描（白名单降噪）- 仅返回玩家、敌对生物
 */
export function getScan(bot: Bot, radius = 32): string[] {
  if (!bot.entity) return [];
  const pos = bot.entity.position;
  const results: string[] = [];

  for (const [id, entity] of Object.entries(bot.entities)) {
    if (entity === bot.entity) continue;
    const dist = entity.position.distanceTo(pos);
    if (dist > radius) continue;

    const { direction, distance } = toRelativeDirection(
      bot,
      entity.position.x - pos.x,
      entity.position.y - pos.y,
      entity.position.z - pos.z
    );

    const ent = entity as { username?: string; name?: string };
    const displayName = ent.username ?? ent.name ?? '未知';

    if ((ent as { type?: string }).type === 'player' || ent.username) {
      const held = (ent as { heldItem?: { name?: string } }).heldItem;
      const heldStr = held?.name ? `，手持 ${held.name}` : '';
      results.push(`距离你 ${distance} 格处发现玩家「${displayName}」${heldStr}，位于你的【${direction}】`);
    } else if (ent.name && isHostileMob(ent.name)) {
      results.push(`距离你 ${distance} 格处发现敌对生物「${ent.name}」，位于你的【${direction}】`);
    }
  }
  return results;
}

/**
 * 白名单方块扫描 - 矿物、食物源、树木
 * 按类型聚合，避免逐个方块输出导致数据量爆炸
 * 例: "oak_log x5：最近在【正前方 3格】" 而非 5 行独立描述
 */
export function getScanBlocks(bot: Bot, radius = 16): string[] {
  if (!bot.entity) return [];
  const pos = bot.entity.position.floored();

  // 按方块类型聚合：记录数量和最近的一个（含坐标）
  const aggregated = new Map<string, { count: number; nearestDir: string; nearestDist: number; nearestPos: { x: number; y: number; z: number } }>();

  // y 范围扩大：树木可达 7+ 格高，矿物可在脚下更深处
  const yMin = -4;
  const yMax = Math.min(8, 319 - pos.y); // 不超过世界高度
  for (let x = -radius; x <= radius; x++) {
    for (let y = yMin; y <= yMax; y++) {
      for (let z = -radius; z <= radius; z++) {
        const block = bot.blockAt(pos.offset(x, y, z));
        if (!block || block.name === 'air' || block.name.includes('air')) continue;
        if (!isWhitelistBlock(block.name)) continue;

        const { direction, distance } = toRelativeDirection(bot, x, y, z);
        const absPos = { x: pos.x + x, y: pos.y + y, z: pos.z + z };
        const existing = aggregated.get(block.name);
        if (!existing || distance < existing.nearestDist) {
          aggregated.set(block.name, {
            count: (existing?.count ?? 0) + 1,
            nearestDir: direction,
            nearestDist: distance,
            nearestPos: absPos,
          });
        } else {
          existing.count++;
        }
      }
    }
  }

  const results: string[] = [];
  for (const [name, info] of aggregated) {
    const p = info.nearestPos;
    results.push(`${name} x${info.count}：最近在【${info.nearestDir} ${info.nearestDist}格】坐标(${p.x},${p.y},${p.z})`);
  }
  return results;
}

/**
 * 周围方块（相对方位）- 按类型+方位聚合
 * 例: "stone x23：主要在【正前方】【左侧】" 而非 23 行独立描述
 */
export function getSurroundingBlocksRelative(bot: Bot, radius = 5): string[] {
  const pos = bot.entity.position.floored();
  const aggregated = new Map<string, { count: number; directions: Map<string, number>; nearestDist: number }>();

  for (let x = -radius; x <= radius; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -radius; z <= radius; z++) {
        const block = bot.blockAt(pos.offset(x, y, z));
        if (!block || block.name === 'air' || block.name === 'void_air' || block.name === 'cave_air') continue;

        const { direction, distance } = toRelativeDirection(bot, x, y, z);
        const existing = aggregated.get(block.name);
        if (existing) {
          existing.count++;
          existing.directions.set(direction, (existing.directions.get(direction) ?? 0) + 1);
          if (distance < existing.nearestDist) existing.nearestDist = distance;
        } else {
          const dirs = new Map<string, number>();
          dirs.set(direction, 1);
          aggregated.set(block.name, { count: 1, directions: dirs, nearestDist: distance });
        }
      }
    }
  }

  const results: string[] = [];
  // 按数量降序，取前 15 种方块（避免信息过载）
  const sorted = [...aggregated.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  for (const [name, info] of sorted) {
    // 取出现次数最多的 2 个方位
    const topDirs = [...info.directions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => `【${d}】`);
    results.push(`${name} x${info.count}：主要在${topDirs.join('')}，最近${info.nearestDist}格`);
  }
  return results;
}

export function getSurroundingBlocksGrid(bot: Bot, size = 5): string {
  const pos = bot.entity.position.floored();
  const half = Math.floor(size / 2);
  const grid: string[][] = [];

  for (let z = -half; z <= half; z++) {
    const row: string[] = [];
    for (let x = -half; x <= half; x++) {
      const block = bot.blockAt(pos.offset(x, 0, z));
      if (Math.abs(x) < 0.5 && Math.abs(z) < 0.5) {
        row.push('@');
      } else {
        row.push(block ? getBlockChar(block.name) : '.');
      }
    }
    grid.push(row);
  }

  const lines = grid.map((r) => r.join(' '));
  return `俯视网格 (${size}x${size}, @=自己, T=树, W=水, S=石头, G=草):\n${lines.join('\n')}`;
}

/**
 * 定向搜索指定方块类型（长距离，最大 64 格）
 * 返回最近的几个匹配方块的精确坐标
 * mcData 由调用方传入（避免 ESM 下 require 问题）
 */
export function findBlocks(bot: Bot, blockType: string, maxDistance = 64, count = 5, mcData?: Record<string, any>): string[] {
  if (!bot.entity) return [];

  if (!mcData) return [`需要传入 mcData`];

  const blockId = mcData.blocksByName[blockType]?.id;
  if (blockId === undefined) return [`未知方块类型: ${blockType}`];

  const blocks = bot.findBlocks({
    matching: blockId,
    maxDistance,
    count,
  });

  if (blocks.length === 0) return [`${maxDistance}格内未找到 ${blockType}`];

  const pos = bot.entity.position;
  const results: string[] = [];
  for (const b of blocks) {
    const dist = Math.round(Math.sqrt(
      (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2
    ));
    const { direction } = toRelativeDirection(bot, b.x - pos.x, b.y - pos.y, b.z - pos.z);
    results.push(`${blockType} 在 (${b.x},${b.y},${b.z}) 距离${dist}格【${direction}】`);
  }
  return results;
}

export const perceptionToolSchemas = {
  get_surrounding_blocks: {
    description: '查看周围方块/地形。这是观察环境的主要方式。format: relative=相对方位文字描述(默认)，grid=ASCII俯视地图',
    inputSchema: {
      format: z.enum(['relative', 'grid']).optional().describe('输出格式：relative(文字) 或 grid(地图)'),
      radius: z.number().optional().describe('范围半径(格)，默认5'),
    },
  },
  get_inventory: {
    description: '查看背包中的所有物品和数量。（注意：没有 list_items/get_items 等命令，只有 get_inventory）',
    inputSchema: {},
  },
  read_chat: {
    description: '获取最近的聊天消息记录，查看其他玩家说了什么。',
    inputSchema: {
      limit: z.number().optional().describe('最多返回条数，默认20'),
    },
  },
  get_health: {
    description: '获取当前血量和饥饿度数值。',
    inputSchema: {},
  },
  get_position: {
    description: '获取当前所在坐标 (x, y, z)。',
    inputSchema: {},
  },
  get_time_of_day: {
    description: '获取游戏内时间，判断现在是白天还是夜晚。',
    inputSchema: {},
  },
  get_scan: {
    description: '扫描周围的玩家、敌对生物（zombie/skeleton/creeper等）和资源（矿物/树木/食物）。这是发现威胁和资源的主要方式。',
    inputSchema: {
      radius: z.number().optional().describe('扫描半径(格)，默认32'),
      include_blocks: z.boolean().optional().describe('是否包含矿物/树木等资源方块，默认true'),
    },
  },
  get_status: {
    description: '获取综合状态：血量、饥饿度、坐标、背包、时间、是否正在执行动作(isBusy)。一次获取所有信息。',
    inputSchema: {},
  },
  find_blocks: {
    description: '搜索指定类型的方块，返回最近几个的精确坐标。用于寻找树木(oak_log)、矿物(coal_ore/iron_ore)等资源的位置。搜索范围最大64格。',
    inputSchema: {
      block_type: z.string().describe('方块类型名，如 oak_log, birch_log, coal_ore, iron_ore, diamond_ore, stone, crafting_table'),
      max_distance: z.number().optional().describe('最大搜索距离(格)，默认64'),
      count: z.number().optional().describe('返回数量，默认5'),
    },
  },
};
