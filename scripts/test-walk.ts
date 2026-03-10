/**
 * 快速走路测试 - 保持持久 MCP 连接，让 Bot 走几步
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function main() {
  console.log('[走路测试] 启动 MCP 客户端...');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(projectRoot, 'src/mcp/server.ts')],
    env: {
      ...process.env,
      MC_BOT_HOST: process.env.MC_BOT_HOST ?? 'localhost',
      MC_BOT_PORT: process.env.MC_BOT_PORT ?? '25565',
      MC_BOT_USERNAME: process.env.MC_BOT_USERNAME ?? 'MCBook_Bot_1',
    },
  });

  const client = new Client(
    { name: 'mcbook-walk-test', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((c: { type: string }) => c.type === 'text');
    return text && 'text' in text ? (text as { text: string }).text : JSON.stringify(result);
  };

  // 等待 Bot 就绪
  for (let i = 0; i < 30; i++) {
    const pos = await callTool('get_position');
    if (!pos.includes('尚未')) { console.log('[走路测试] Bot 就绪'); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 获取起始位置
  const startPos = await callTool('get_position');
  console.log(`起点: ${startPos}`);

  // 解析坐标
  const match = startPos.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
  if (!match) { console.error('无法解析坐标'); process.exit(1); }
  const [, sx, sy, sz] = match.map(Number);

  // 第一步：往 X+ 方向走 8 格
  console.log('\n--- 第一步：X+8 ---');
  const r1 = await callTool('move_to', { x: sx + 8, y: sy, z: sz });
  console.log(r1);
  const pos1 = await callTool('get_position');
  console.log(`当前: ${pos1}`);

  await new Promise((r) => setTimeout(r, 1000));

  // 第二步：往 Z+ 方向走 8 格
  console.log('\n--- 第二步：Z+8 ---');
  const match2 = pos1.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
  const [, cx, cy, cz] = (match2 ?? match).map(Number);
  const r2 = await callTool('move_to', { x: cx, y: cy, z: cz + 8 });
  console.log(r2);
  const pos2 = await callTool('get_position');
  console.log(`当前: ${pos2}`);

  // 最终扫描
  console.log('\n--- 周围环境 ---');
  const scan = await callTool('get_scan');
  console.log(scan);

  console.log('\n[走路测试] 完成！');
  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
