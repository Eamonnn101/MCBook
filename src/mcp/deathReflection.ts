/**
 * 死亡反思 - 当 Bot 死亡时，用死前快照触发 OpenClaw 反思，并保存生存法则到 memory
 */
import { spawn } from 'child_process';
import { readFile, appendFile, unlink, writeFile, mkdir } from 'fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { DeathVerdict } from './stateSnapshot.js';

function getMemoryDir(): string {
  return process.env.MCBOOK_MEMORY_DIR || join(process.cwd(), 'memory');
}
const BOT_NAME = process.env.MC_BOT_USERNAME || 'MCBook_Bot_1';

function buildReflectionPrompt(verdict: DeathVerdict): string {
  const inv = verdict.inventory?.join(', ') ?? '未知';
  return `你刚才在 Minecraft 中死亡了。死前状态：手持 ${verdict.lastHeldItem ?? '无'}，护甲：${verdict.hadArmor ? '有' : '无'}，背包有：${inv}。
请反思为什么会死（例如：有食物为什么没吃？有武器为什么没装备？），并总结一条生存法则（一句话，直接输出法则内容，不要其他废话）。`;
}

export async function runDeathReflection(verdict: DeathVerdict): Promise<string> {
  const prompt = buildReflectionPrompt(verdict);
  return new Promise((resolve, reject) => {
    const child = spawn('openclaw', ['agent', '--message', prompt, '--json'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`openclaw exit ${code}`));
        return;
      }
      try {
        const json = JSON.parse(out);
        const text = json?.content?.[0]?.text ?? json?.text ?? out.trim();
        resolve(text);
      } catch {
        resolve(out.trim());
      }
    });
  });
}

export async function appendToMemory(botName: string, line: string): Promise<void> {
  const path = join(getMemoryDir(), `${botName}_memory.txt`);
  await appendFile(path, `\n${line}`, 'utf-8');
}

function getPendingPath(botName: string): string {
  return join(getMemoryDir(), `death_pending_${botName}.json`);
}

export function writePendingDeath(verdict: DeathVerdict, botName = BOT_NAME): void {
  const path = getPendingPath(botName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(verdict), 'utf-8');
}

export async function processPendingDeathIfAny(botName = BOT_NAME): Promise<boolean> {
  const path = getPendingPath(botName);
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, 'utf-8');
    await unlink(path);
    const verdict = JSON.parse(raw) as DeathVerdict;
    const reflection = await runDeathReflection(verdict);
    await appendToMemory(botName, reflection);
    return true;
  } catch (err) {
    // OpenClaw CLI 不可用时，用简单的反思替代
    console.warn(`[DeathReflection] 反思失败 (${err instanceof Error ? err.message : err})，保存基础记录`);
    try { await unlink(path); } catch { /* ignore */ }
    await appendToMemory(botName, `[${new Date().toISOString()}] 死亡记录（反思服务不可用）`);
    return true;
  }
}
