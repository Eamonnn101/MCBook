import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';

function ex(r: { content?: Array<{ type?: string; text?: string }> }): string {
  return r.content?.find(c => c.type === 'text')?.text ?? '';
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(process.cwd(), 'src', 'mcp', 'server.ts')],
    env: {
      MC_BOT_HOST: 'localhost',
      MC_BOT_PORT: '25565',
      MC_BOT_USERNAME: 'CraftTest3',
    },
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'craft-test', version: '1.0.0' });
  await client.connect(transport);
  console.log('[CraftTest] Connected, waiting for bot...');
  await new Promise(r => setTimeout(r, 6000));

  console.log('\n--- 1. Status ---');
  const status1 = ex(await client.callTool({ name: 'get_status', arguments: {} }));
  console.log(status1);

  // Move to surface level if bot is underground
  const posMatch = status1.match(/位置[：:]\s*\(?([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/);
  const botY = posMatch ? parseFloat(posMatch[2]) : 65;
  if (botY < 60) {
    console.log(`\n--- 1b. Bot at y=${botY}, moving to surface ---`);
    const x = posMatch ? parseFloat(posMatch[1]) : 0;
    const z = posMatch ? parseFloat(posMatch[3]) : 0;
    try {
      console.log(ex(await client.callTool({ name: 'move_to', arguments: { x, y: 65, z } })));
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log('move_to surface failed:', (e as Error).message);
    }
  }

  console.log('\n--- 2. Mine oak_log ---');
  try {
    console.log(ex(await client.callTool({ name: 'mine', arguments: { block_type: 'oak_log' } })));
  } catch (e) {
    console.log('mine failed:', (e as Error).message);
    // Try mining dirt as fallback to verify mine works
    console.log('\n--- 2b. Mine dirt (fallback) ---');
    try {
      console.log(ex(await client.callTool({ name: 'mine', arguments: { block_type: 'dirt' } })));
    } catch (e2) {
      console.log('dirt mine also failed:', (e2 as Error).message);
    }
  }

  console.log('\n--- 3. Status after mine ---');
  console.log(ex(await client.callTool({ name: 'get_status', arguments: {} })));

  console.log('\n--- 4. Craft oak_planks ---');
  console.log(ex(await client.callTool({ name: 'craft', arguments: { item_name: 'oak_planks', count: 1 } })));

  console.log('\n--- 5. Craft stick ---');
  console.log(ex(await client.callTool({ name: 'craft', arguments: { item_name: 'stick', count: 1 } })));

  console.log('\n--- 6. Final status ---');
  console.log(ex(await client.callTool({ name: 'get_status', arguments: {} })));

  console.log('\n[CraftTest] Done!');
  process.exit(0);
}

main().catch(e => { console.error('[CraftTest] Error:', e.message); process.exit(1); });
