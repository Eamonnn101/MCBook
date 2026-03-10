/**
 * 测试 move_to 工具 - 将 Bot 移动到指定坐标
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function main() {
  const [x, y, z] = process.argv.slice(2).map(Number).filter((n) => !isNaN(n));
  const targetX = x ?? 238;
  const targetY = y ?? 64;
  const targetZ = z ?? 428;

  console.log(`[MCBook] 移动 Bot 到 (${targetX}, ${targetY}, ${targetZ})...\n`);

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(projectRoot, 'src/mcp/server.ts')],
    env: { ...process.env },
  });

  const client = new Client({ name: 'mcbook-move', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const err = result.content?.find((c) => c.type === 'text');
      throw new Error(err && 'text' in err ? String(err.text) : 'Tool error');
    }
    const text = result.content?.find((c) => c.type === 'text');
    return text && 'text' in text ? text.text : JSON.stringify(result);
  };

  const waitForBot = async () => {
    for (let i = 0; i < 30; i++) {
      const pos = await callTool('get_position');
      if (!pos.includes('尚未完全加载')) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Bot 连接超时');
  };

  try {
    await waitForBot();
    console.log('Bot 已就绪，开始寻路...\n');

    const result = await callTool('move_to', { x: targetX, y: targetY, z: targetZ, range: 2 });
    console.log(result);
    console.log('\n[MCBook] 移动完成');
  } catch (err) {
    console.error('[MCBook] 失败:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
