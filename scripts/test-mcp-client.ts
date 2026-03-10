/**
 * MCP 客户端测试 - 模拟 OpenClaw 调用工具控制 Bot
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function main() {
  console.log('[MCBook 测试] 启动 MCP 客户端...\n');

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
    { name: 'mcbook-test', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('[MCBook 测试] 已连接 MCP 服务器');
  console.log('[MCBook 测试] 等待 Bot 连接游戏...\n');

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(result.content?.[0]?.type === 'text' ? String(result.content[0].text) : 'Tool error');
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

    console.log('--- 1. 获取当前位置 ---');
    const pos = await callTool('get_position');
    console.log(pos, '\n');

    console.log('--- 2. 获取周围方块 (ASCII 网格) ---');
    const grid = await callTool('get_surrounding_blocks', { format: 'grid', radius: 3 });
    console.log(grid, '\n');

    console.log('--- 3. 获取背包 ---');
    const inv = await callTool('get_inventory');
    console.log(inv, '\n');

    console.log('--- 4. 发送聊天消息 ---');
    let chatResult: string;
    try {
      chatResult = await callTool('chat', {
        message: '[MCBook 测试] 流程验证成功！Bot 可被 MCP 控制。',
      });
    } catch (e) {
      chatResult = `聊天发送失败 (可能服务器版本不支持): ${e}`;
      console.warn(chatResult, '\n');
    }
    console.log(chatResult, '\n');

    console.log('--- 5. 获取血量 ---');
    const health = await callTool('get_health');
    console.log(health, '\n');

    console.log('[MCBook 测试] 测试完成！');
  } catch (err) {
    console.error('[MCBook 测试] 失败:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
