/**
 * 测试 mine 工具 - 挖掘指定坐标的方块（如树）
 * 用法: npm run test:mine [x y z] 或 npm run test:mine -- oak_log
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const isBlockType = args[0] && !/^\d+$/.test(args[0]);
  const blockType = isBlockType ? args[0] : null;
  const [x, y, z] = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const targetX = x ?? 225;
  const targetY = y ?? 67;
  const targetZ = z ?? 443;

  if (blockType) {
    console.log(`[MCBook] 挖掘最近的 ${blockType}...\n`);
  } else {
    console.log(`[MCBook] 先移动到树附近，再挖掘 (${targetX}, ${targetY}, ${targetZ})...\n`);
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(projectRoot, 'src/mcp/server.ts')],
    env: { ...process.env },
  });

  const client = new Client({ name: 'mcbook-mine', version: '1.0.0' }, { capabilities: {} });
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
    console.log('Bot 已就绪\n');

    if (!blockType) {
      console.log('--- 1. 移动到目标附近 ---');
      const moveTo = { x: targetX - 2, y: targetY, z: targetZ - 2 };
      await callTool('move_to', moveTo);
      console.log('已到达附近\n');
    }

    console.log('--- 2. 开始挖掘 ---');
    const mineArgs = blockType
      ? { block_type: blockType }
      : { x: targetX, y: targetY, z: targetZ };
    const result = await callTool('mine', mineArgs);
    console.log(result);
    console.log('\n[MCBook] 挖掘完成');
  } catch (err) {
    console.error('[MCBook] 失败:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
