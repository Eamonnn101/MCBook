/**
 * Heartbeat Client - 认知循环版
 *
 * 流程：
 * 1. 从 Game Master 收到认知 prompt（WebSocket 或 HTTP）
 * 2. 发送给 OpenClaw，等待 AI 返回 JSON 计划
 * 3. 将 AI 的回复 POST 回 Game Master 的 /plan 端点
 * 4. Game Master 的 PlanExecutor 用自己的 MCP 连接执行计划
 *
 * 关键：OpenClaw 不需要也不应该直接调用 MCP 工具！
 *       它只需要输出 JSON 计划文本，由 Game Master 代为执行。
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import WebSocket from 'ws';

const CONFIG_PATH = join(process.cwd(), 'config', 'game-master.json');

interface BotConfig {
  name: string;
  mcBotName?: string;
  openclawAgent: string;
}

interface Config {
  intervalMs?: number;
  httpPort?: number;
  bots?: BotConfig[];
}

async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    return { intervalMs: 8000, httpPort: 3848, bots: [] };
  }
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as Config;
}

// ─── 发送到 OpenClaw 并捕获响应 ───

const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL;

async function sendViaHttp(agent: string, text: string): Promise<string> {
  if (!OPENCLAW_API_URL) throw new Error('OPENCLAW_API_URL not set');
  const res = await fetch(OPENCLAW_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, message: text }),
  });
  if (!res.ok) throw new Error(`OpenClaw API HTTP ${res.status}: ${await res.text()}`);
  return await res.text();
}

async function sendViaCli(agent: string, text: string): Promise<string> {
  const workspace = process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'workspace');
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['openclaw', 'agent', '--agent', agent, '--message', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: workspace,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.stdout?.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      process.stdout.write(d);
    });
    child.stdin.write(text, 'utf-8', (err) => {
      if (err) return reject(err);
      child.stdin.end();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`openclaw exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

/** 发送 prompt 给 OpenClaw，返回 AI 的文本响应 */
async function sendToOpenClaw(agent: string, text: string): Promise<string> {
  if (OPENCLAW_API_URL) {
    try {
      return await sendViaHttp(agent, text);
    } catch (err) {
      console.warn('[HeartbeatClient] HTTP API 失败，回退到 CLI:', err instanceof Error ? err.message : err);
    }
  }
  return await sendViaCli(agent, text);
}

/** 将 AI 的计划响应 POST 回 Game Master */
async function submitPlan(baseUrl: string, botName: string, planText: string): Promise<void> {
  const url = `${baseUrl}/plan`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: botName, plan: planText }),
    });
    if (res.ok) {
      const body = await res.text();
      console.log(`[HeartbeatClient] 计划已提交给 Game Master: ${body}`);
    } else {
      console.error(`[HeartbeatClient] 提交计划失败: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[HeartbeatClient] 提交计划错误:', err instanceof Error ? err.message : err);
  }
}

// ─── 频率控制 ───

const lastSendTime = new Map<string, number>();
const MIN_SEND_INTERVAL_MS: Record<string, number> = {
  urgent: 0,
  normal: 5000,
  cognitive: 0,
  idle: 20000,
};

function shouldSend(botName: string, tier: string): boolean {
  const now = Date.now();
  const last = lastSendTime.get(botName) ?? 0;
  const minInterval = MIN_SEND_INTERVAL_MS[tier] ?? 5000;
  return now - last >= minInterval;
}

// ─── WebSocket 模式 ───

function connectWebSocket(
  baseUrl: string,
  bot: BotConfig,
  onClose: () => void
): WebSocket {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + `?bot=${encodeURIComponent(bot.name)}`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[HeartbeatClient] WebSocket 已连接: ${bot.name}`);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { botName: string; tier: string; prompt: string };
      if (!shouldSend(msg.botName, msg.tier)) {
        console.log(`[HeartbeatClient] ${msg.botName} (${msg.tier}) 频率限制，跳过`);
        return;
      }
      console.log(`[HeartbeatClient] 收到 ${msg.botName} (${msg.tier}) prompt，发送给 OpenClaw...`);

      // 发送给 OpenClaw 并等待 AI 响应
      const response = await sendToOpenClaw(bot.openclawAgent, msg.prompt);
      lastSendTime.set(msg.botName, Date.now());
      console.log(`[HeartbeatClient] ${msg.botName} AI 已响应 (${response.length} 字符)`);

      // 将 AI 的响应（JSON 计划）POST 回 Game Master
      if (response.trim().length > 0) {
        await submitPlan(baseUrl, msg.botName, response);
      }
    } catch (err) {
      console.error(`[HeartbeatClient] ${bot.name} 处理失败:`, err instanceof Error ? err.message : err);
    }
  });

  ws.on('close', () => {
    console.warn(`[HeartbeatClient] WebSocket 断开: ${bot.name}`);
    onClose();
  });

  ws.on('error', (err) => {
    console.error(`[HeartbeatClient] WebSocket 错误: ${bot.name}:`, err.message);
  });

  return ws;
}

// ─── HTTP 轮询 fallback ───

async function fetchPromptHttp(baseUrl: string, botName: string): Promise<{ text: string; tier: string } | null> {
  const url = `${baseUrl}/heartbeat?bot=${encodeURIComponent(botName)}`;
  const res = await fetch(url);
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tier = res.headers.get('X-Prompt-Tier') ?? 'normal';
  const text = await res.text();
  return text.trim().length > 0 ? { text, tier } : null;
}

// ─── 主逻辑 ───

async function run(): Promise<void> {
  const config = await loadConfig();
  const port = config.httpPort ?? 3848;
  const intervalMs = config.intervalMs ?? 8000;
  const bots = config.bots ?? [];
  const baseUrl = `http://localhost:${port}`;

  if (bots.length === 0) {
    console.error('[HeartbeatClient] 未配置 bots，请编辑 config/game-master.json');
    process.exit(1);
  }

  console.log(`[HeartbeatClient] 认知循环模式启动，目标 ${baseUrl}`);
  console.log(`[HeartbeatClient] 流程: Game Master prompt → OpenClaw → JSON 计划 → POST /plan → Game Master 执行`);
  if (OPENCLAW_API_URL) {
    console.log(`[HeartbeatClient] 使用 OpenClaw HTTP API: ${OPENCLAW_API_URL}`);
  } else {
    console.log('[HeartbeatClient] 未设置 OPENCLAW_API_URL，使用 CLI spawn 模式');
  }

  // 为每个 bot 尝试 WebSocket 连接
  const wsConnected = new Set<string>();
  const WS_RECONNECT_MS = 5000;

  for (const bot of bots) {
    const tryConnect = () => {
      try {
        const ws = connectWebSocket(baseUrl, bot, () => {
          wsConnected.delete(bot.name);
          console.log(`[HeartbeatClient] ${bot.name} 将在 ${WS_RECONNECT_MS}ms 后重连...`);
          setTimeout(tryConnect, WS_RECONNECT_MS);
        });
        ws.on('open', () => wsConnected.add(bot.name));
      } catch {
        setTimeout(tryConnect, WS_RECONNECT_MS);
      }
    };
    tryConnect();
  }

  // HTTP 轮询作为 fallback
  let consecutiveErrors = 0;

  const httpTick = async () => {
    for (const bot of bots) {
      if (wsConnected.has(bot.name)) continue;

      try {
        const result = await fetchPromptHttp(baseUrl, bot.name);
        if (!result) continue;
        if (!shouldSend(bot.name, result.tier)) continue;

        // 发送给 OpenClaw
        const response = await sendToOpenClaw(bot.openclawAgent, result.text);
        lastSendTime.set(bot.name, Date.now());
        consecutiveErrors = 0;
        console.log(`[HeartbeatClient] ${bot.name} (${result.tier}, HTTP fallback) AI 已响应`);

        // POST 回 Game Master
        if (response.trim().length > 0) {
          await submitPlan(baseUrl, bot.name, response);
        }
      } catch (err) {
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
          console.warn('[HeartbeatClient] 无法连接 Game Master (HTTP fallback)');
        } else {
          console.error(`[HeartbeatClient] ${bot.name} HTTP 错误:`, msg);
        }
      }
    }
  };

  await httpTick();

  const scheduleHttpTick = () => {
    const backoff = Math.min(intervalMs * Math.pow(1.5, consecutiveErrors), 60000);
    const interval = consecutiveErrors > 2 ? backoff : intervalMs;
    setTimeout(async () => {
      await httpTick();
      scheduleHttpTick();
    }, interval);
  };
  scheduleHttpTick();
}

run().catch((err) => {
  console.error('[HeartbeatClient]', err);
  process.exit(1);
});
