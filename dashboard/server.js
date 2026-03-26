/**
 * Dashboard 后端 - 日志 tail + Game Master 状态 + WebSocket 广播
 * 优化：增加 Game Master 状态轮询，合并展示
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync, watch, statSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3847', 10);
const LOG_FILE = join(process.cwd(), 'logs', 'mcbook.jsonl');
const GM_STATUS_URL = process.env.GM_STATUS_URL ?? 'http://localhost:3848/status';

const httpServer = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    createReadStream(join(__dirname, 'index.html')).pipe(res);
    return;
  }
  // 代理 Game Master 状态接口
  if (req.url === '/gm-status') {
    fetch(GM_STATUS_URL)
      .then(async (r) => {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(await r.text());
      })
      .catch(() => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Game Master 未运行' }));
      });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ─── 日志 tail ───

let lastSize = 0;
function tailLog() {
  if (!existsSync(LOG_FILE)) return;
  try {
    const st = statSync(LOG_FILE);
    if (st.size < lastSize) lastSize = 0;
    if (st.size > lastSize) {
      const buf = readFileSync(LOG_FILE);
      const chunk = buf.subarray(lastSize);
      lastSize = st.size;
      chunk.toString().split('\n').filter(Boolean).forEach((line) => {
        try {
          broadcast(JSON.parse(line));
        } catch {}
      });
    }
  } catch {}
}

// 初始化日志监控
if (existsSync(LOG_FILE)) {
  lastSize = statSync(LOG_FILE).size;
  watch(LOG_FILE, (_, filename) => {
    if (filename) tailLog();
  });
} else {
  // 日志文件不存在时定期检查（Bot 可能还未启动）
  const checkInterval = setInterval(() => {
    if (existsSync(LOG_FILE)) {
      lastSize = statSync(LOG_FILE).size;
      watch(LOG_FILE, (_, filename) => {
        if (filename) tailLog();
      });
      clearInterval(checkInterval);
    }
  }, 5000);
}

// ─── Game Master 状态定期广播 ───

async function pollGmStatus() {
  try {
    const res = await fetch(GM_STATUS_URL);
    if (res.ok) {
      const status = await res.json();
      broadcast({ type: 'gm_status', ...status });
    }
  } catch {
    // Game Master 未运行，静默
  }
}

setInterval(pollGmStatus, 10000);

httpServer.listen(PORT, () => {
  console.log(`[Dashboard] http://localhost:${PORT}`);
});
