/**
 * Coordinator - 分布式共享状态中心入口
 *
 * 启动 WebSocket 服务托管 AgentRegistry、EventBus、TradeEngine 等共享状态。
 * 同时提供 HTTP /status 端点供 Dashboard 使用。
 *
 * 用法:
 *   npx tsx scripts/coordinator.ts [--ws-port 3849] [--http-port 3848]
 */
import { createServer } from 'http';
import { CoordinatorServer } from '../src/multi/coordinatorServer.js';

function parseArg(name: string, defaultValue: number): number {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return defaultValue;
}

const wsPort = parseArg('--ws-port', 3849);
const httpPort = parseArg('--http-port', 3848);

// ─── Start Coordinator WebSocket ───
const coordinator = new CoordinatorServer(wsPort);
coordinator.start();

// ─── HTTP Server (Dashboard compatibility) ───
const httpServer = createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/status') {
    const registry = coordinator.getRegistry();
    const agents = registry.getAll();
    const statusMap: Record<string, unknown> = {};
    for (const agent of agents) {
      statusMap[agent.name] = {
        agentType: agent.agentType,
        status: agent.status,
        position: agent.position,
        health: agent.health,
        food: agent.food,
        isBusy: agent.isBusy,
        currentAction: agent.currentAction,
        isDay: agent.isDay,
        lastSeen: agent.lastSeen,
        // Cognitive state from bot runners (if reported)
        ...((agent as Record<string, unknown>)._cogState as Record<string, unknown> ?? {}),
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusMap, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    const registry = coordinator.getRegistry();
    const agents = registry.getAll();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end([
      'MCBook Coordinator (分布式共享状态中心)',
      '',
      `WebSocket: ws://localhost:${wsPort}`,
      `HTTP:      http://localhost:${httpPort}`,
      '',
      `在线 Agent: ${agents.filter(a => a.status === 'online').length}/${agents.length}`,
      agents.map(a => `  ${a.name} [${a.agentType}] ${a.status}`).join('\n'),
      '',
      'GET /status  — Agent 状态 JSON (Dashboard 用)',
    ].join('\n'));
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(httpPort, () => {
  console.log(`[Coordinator] HTTP 服务已启动 http://localhost:${httpPort}`);
  console.log(`[Coordinator] WebSocket 服务 ws://localhost:${wsPort}`);
  console.log('[Coordinator] 等待 Bot Runner 连接...');
});
