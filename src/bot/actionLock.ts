/**
 * 动作锁 - 防止 Game Master 心跳与长耗时动作冲突
 * 当 move_to、mine、attack 执行时 isBusy=true，Game Master 可跳过本轮心跳
 */
export type ActionType = 'move_to' | 'mine' | 'attack' | 'follow_player' | null;

let isBusy = false;
let currentAction: ActionType = null;
let pathfinderStopFn: (() => void) | null = null;

export function setPathfinderStop(fn: () => void): void {
  pathfinderStopFn = fn;
}

export function getActionLock(): { isBusy: boolean; currentAction: ActionType } {
  return { isBusy, currentAction };
}

export function setBusy(action: ActionType): void {
  isBusy = true;
  currentAction = action;
}

export function clearBusy(): void {
  isBusy = false;
  currentAction = null;
}

/**
 * 高优先级中断：停止当前寻路/挖矿
 */
export function stopCurrentAction(): void {
  if (pathfinderStopFn) {
    pathfinderStopFn();
  }
  clearBusy();
}
