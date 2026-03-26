/**
 * 寻路封装，含防卡死 + 自动脱困
 */
import type { Bot } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
import { setPathfinderStop } from './actionLock.js';

const { goals, Movements } = pathfinderModule as unknown as {
  goals: { GoalNear: new (x: number, y: number, z: number, r: number) => unknown };
  Movements: new (b: Bot) => Record<string, unknown>;
};
const GOTO_TIMEOUT_MS = 60000;
const STUCK_CHECK_INTERVAL_MS = 3000;
const STUCK_THRESHOLD = 0.3;
const STUCK_CONSECUTIVE = 3;
const MAX_UNSTUCK_ATTEMPTS = 4; // 最多尝试脱困次数

export type PathfinderBot = Bot & {
  pathfinder: {
    setMovements: (m: unknown) => void;
    setGoal: (goal: unknown) => void;
    goto: (goal: unknown) => Promise<void>;
    movements: unknown;
  };
};

export function setupPathfinder(bot: Bot): void {
  const pfBot = bot as PathfinderBot;
  if (!pfBot.pathfinder) {
    throw new Error('pathfinder 插件未加载');
  }

  const movements = new Movements(bot) as Record<string, unknown>;

  // 允许挖掘障碍物通过
  movements.canDig = true;
  // 允许跑酷跳跃（1格高台阶）
  movements.allowParkour = true;
  // 允许冲刺
  movements.allowSprinting = true;
  // 允许 1x1 垫方块上升（从坑里跳出来）
  movements.allow1by1towers = true;
  // 扩展脚手架方块列表（用于垫高/搭桥）
  try {
    const registry = (bot as unknown as { registry: Record<string, Record<string, { id: number }>> }).registry;
    const scaffoldBlocks: number[] = [];
    const scaffoldNames = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate',
      'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
      'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'sand', 'gravel', 'stone'];
    for (const name of scaffoldNames) {
      const item = registry.itemsByName?.[name];
      if (item) scaffoldBlocks.push(item.id);
    }
    if (scaffoldBlocks.length > 0) {
      movements.scafoldingBlocks = scaffoldBlocks;
    }
  } catch { /* keep defaults */ }

  pfBot.pathfinder.setMovements(movements);

  setPathfinderStop(() => {
    pfBot.pathfinder.setGoal(null);
  });
}

/**
 * 单次垫方块上升：跳起 → 等0.5s → 脚下放方块
 */
async function pillarUp(
  bot: Bot,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Vec3: any,
  scaffoldItems: string[],
): Promise<boolean> {
  const scaffoldItem = bot.inventory.items().find(i => scaffoldItems.some(s => i.name.includes(s)));
  if (!scaffoldItem) return false;

  const startY = Math.floor(bot.entity.position.y);
  const bx = Math.floor(bot.entity.position.x);
  const bz = Math.floor(bot.entity.position.z);

  const belowBlock = bot.blockAt(new Vec3(bx, startY - 1, bz));
  if (!belowBlock || belowBlock.name === 'air') return false;

  try {
    await bot.equip(scaffoldItem, 'hand');
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
      console.log(`[Pathfinder] 垫方块 ${scaffoldItem.name} → y=${startY}`);
    }

    bot.setControlState('sneak', false);
    await new Promise(r => setTimeout(r, 500));
    return true;
  } catch (err) {
    bot.setControlState('jump', false);
    bot.setControlState('sneak', false);
    console.warn(`[Pathfinder] 垫方块失败:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * 尝试脱困：挖掉面前的方块 / 跳跃 / 垫方块
 */
async function tryUnstuck(bot: Bot): Promise<boolean> {
  const { Vec3 } = await import('vec3');
  const pos = bot.entity.position;
  const yaw = bot.entity.yaw;

  // 前方方向
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const frontX = Math.floor(pos.x + dx);
  const frontZ = Math.floor(pos.z + dz);
  const feetY = Math.floor(pos.y);

  // 策略 1：挖掉面前阻挡的方块（脚部 + 头部高度）
  for (const dy of [0, 1]) {
    const block = bot.blockAt(new Vec3(frontX, feetY + dy, frontZ));
    if (block && block.name !== 'air' && block.boundingBox === 'block') {
      try {
        console.log(`[Pathfinder] 脱困：挖掉前方 ${block.name} at (${frontX},${feetY + dy},${frontZ})`);
        await bot.dig(block);
        return true;
      } catch { /* 挖不了就跳过 */ }
    }
  }

  // 策略 2：跳跃（可能卡在半格高的方块上）
  try {
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 400));
    bot.setControlState('jump', false);

    // 跳起来后尝试往前走一步
    bot.setControlState('forward', true);
    await new Promise(r => setTimeout(r, 600));
    bot.setControlState('forward', false);
    return true;
  } catch { /* ignore */ }

  // 策略 3：在脚下放方块垫高（从坑里出来）— 支持多次垫高
  const scaffoldItems = ['dirt', 'cobblestone', 'oak_planks', 'oak_log', 'stone', 'sand', 'gravel', 'cobbled_deepslate'];
  const item = bot.inventory.items().find(i => scaffoldItems.some(s => i.name.includes(s)));
  if (item) {
    for (let pillar = 0; pillar < 3; pillar++) {
      const placed = await pillarUp(bot, Vec3, scaffoldItems);
      if (!placed) break;
    }
    return true;
  }

  // 策略 4：挖掉头顶方块（可能被困在封闭空间）
  const headBlock = bot.blockAt(new Vec3(Math.floor(pos.x), feetY + 2, Math.floor(pos.z)));
  if (headBlock && headBlock.name !== 'air' && headBlock.boundingBox === 'block') {
    try {
      console.log(`[Pathfinder] 脱困：挖掉头顶 ${headBlock.name}`);
      await bot.dig(headBlock);
      return true;
    } catch { /* ignore */ }
  }

  return false;
}

/**
 * 寻路到坐标，带超时、防卡死和自动脱困
 */
export async function gotoWithTimeout(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range = 2
): Promise<void> {
  const pfBot = bot as PathfinderBot;

  for (let attempt = 0; attempt <= MAX_UNSTUCK_ATTEMPTS; attempt++) {
    const goal = new goals.GoalNear(x, y, z, range);
    let lastPos = bot.entity.position.clone();
    let stuckTimer: ReturnType<typeof setInterval> | null = null;
    let stuckCount = 0;
    let isStuck = false;

    const clearStuckCheck = () => {
      if (stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearAll = () => {
      clearStuckCheck();
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        clearAll();
        pfBot.pathfinder.setGoal(null);
        reject(new Error(`寻路超时 (${GOTO_TIMEOUT_MS}ms)`));
      }, GOTO_TIMEOUT_MS);
    });

    const stuckPromise = new Promise<'stuck'>((resolve) => {
      stuckTimer = setInterval(() => {
        const dist = bot.entity.position.distanceTo(lastPos);
        lastPos = bot.entity.position.clone();
        if (dist < STUCK_THRESHOLD) {
          stuckCount++;
          if (stuckCount >= STUCK_CONSECUTIVE) {
            isStuck = true;
            clearAll();
            pfBot.pathfinder.setGoal(null);
            resolve('stuck');
          }
        } else {
          stuckCount = 0;
        }
      }, STUCK_CHECK_INTERVAL_MS);
    });

    const gotoPromise = pfBot.pathfinder
      .goto(goal)
      .then(() => 'done' as const)
      .finally(clearAll);

    const result = await Promise.race([gotoPromise, stuckPromise, timeoutPromise]);

    if (result === 'done') return; // 成功到达

    if (result === 'stuck' && attempt < MAX_UNSTUCK_ATTEMPTS) {
      console.log(`[Pathfinder] 卡住，尝试脱困 (${attempt + 1}/${MAX_UNSTUCK_ATTEMPTS})...`);
      const freed = await tryUnstuck(bot);
      if (freed) {
        // 短暂等待让物理引擎稳定
        await new Promise(r => setTimeout(r, 500));
        continue; // 重试寻路
      }
    }

    // 多次脱困失败，抛出错误让上层处理
    throw new Error(`寻路卡住，脱困失败 (尝试 ${attempt + 1} 次)`);
  }
}

/**
 * 停止当前寻路（供高优先级中断）
 */
export function stopPathfinder(bot: Bot): void {
  const pfBot = bot as PathfinderBot;
  if (pfBot.pathfinder) {
    pfBot.pathfinder.setGoal(null);
  }
}
