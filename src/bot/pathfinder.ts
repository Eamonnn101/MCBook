/**
 * 寻路封装，含防卡死机制
 */
import type { Bot } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
import { setPathfinderStop } from './actionLock.js';

const { goals, Movements } = pathfinderModule as {
  goals: { GoalNear: new (x: number, y: number, z: number, r: number) => unknown };
  Movements: new (b: Bot) => unknown;
};
const GOTO_TIMEOUT_MS = 60000;
const STUCK_CHECK_INTERVAL_MS = 4000;
const STUCK_THRESHOLD = 0.2;
const STUCK_CONSECUTIVE = 3; // 连续 N 次未移动才视为卡住

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

  const movements = new Movements(bot);
  pfBot.pathfinder.setMovements(movements);

  // 暴露 stop 供 actionLock 高优先级中断
  setPathfinderStop(() => {
    pfBot.pathfinder.setGoal(null);
  });
}

/**
 * 寻路到坐标，带超时和防卡死
 */
export async function gotoWithTimeout(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range = 2
): Promise<void> {
  const pfBot = bot as PathfinderBot;
  const goal = new goals.GoalNear(x, y, z, range);

  let lastPos = bot.entity.position.clone();
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckCount = 0;

  const clearStuckCheck = () => {
    if (stuckTimer) {
      clearInterval(stuckTimer);
      stuckTimer = null;
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      clearStuckCheck();
      pfBot.pathfinder.setGoal(null);
      reject(new Error(`寻路超时 (${GOTO_TIMEOUT_MS}ms)`));
    }, GOTO_TIMEOUT_MS);
  });

  const clearAll = () => {
    clearStuckCheck();
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  };

  // 防卡死：连续 N 次几乎没动才强制重置
  stuckTimer = setInterval(() => {
    const dist = bot.entity.position.distanceTo(lastPos);
    lastPos = bot.entity.position.clone();
    if (dist < STUCK_THRESHOLD) {
      stuckCount++;
      if (stuckCount >= STUCK_CONSECUTIVE) {
        clearAll();
        pfBot.pathfinder.setGoal(null);
      }
    } else {
      stuckCount = 0;
    }
  }, STUCK_CHECK_INTERVAL_MS);

  const gotoPromise = pfBot.pathfinder
    .goto(goal)
    .finally(clearAll);

  await Promise.race([gotoPromise, timeoutPromise]);
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
