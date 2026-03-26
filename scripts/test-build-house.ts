import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';

function ex(r: { content?: Array<{ type?: string; text?: string }> }): string {
  return r.content?.find(c => c.type === 'text')?.text ?? '';
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = ex(await client.callTool({ name, arguments: args }));
  console.log(`  [${name}] ${result}`);
  return result;
}

async function mineMultiple(client: Client, blockType: string, count: number): Promise<number> {
  let mined = 0;
  for (let i = 0; i < count; i++) {
    try {
      const result = await call(client, 'mine', { block_type: blockType });
      if (result.includes('已挖掘')) mined++;
      else { console.log(`  (stopped mining: ${result})`); break; }
    } catch (e) {
      console.log(`  mine #${i + 1} failed: ${(e as Error).message}`);
      break;
    }
  }
  return mined;
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(process.cwd(), 'src', 'mcp', 'server.ts')],
    env: {
      MC_BOT_HOST: 'localhost',
      MC_BOT_PORT: '25565',
      MC_BOT_USERNAME: 'BuilderBot',
    },
    cwd: process.cwd(),
  });
  const client = new Client({ name: 'build-test', version: '1.0.0' });
  await client.connect(transport);
  console.log('[BuildTest] Connected, waiting for bot to spawn...');
  await new Promise(r => setTimeout(r, 6000));

  // === Phase 1: Check status & location ===
  console.log('\n=== Phase 1: Status ===');
  const status = await call(client, 'get_status', {});
  const posMatch = status.match(/"x":([-\d.]+).*?"y":([-\d.]+).*?"z":([-\d.]+)/);
  const botPos = posMatch
    ? { x: Math.floor(parseFloat(posMatch[1])), y: Math.floor(parseFloat(posMatch[2])), z: Math.floor(parseFloat(posMatch[3])) }
    : { x: 0, y: 64, z: 0 };
  console.log(`  Bot position: (${botPos.x}, ${botPos.y}, ${botPos.z})`);

  // === Phase 2: Chop trees ===
  console.log('\n=== Phase 2: Chop Trees (need ~10 oak_log) ===');
  const logsNeeded = 10;
  const logsMined = await mineMultiple(client, 'oak_log', logsNeeded);
  console.log(`  Mined ${logsMined} oak_log`);

  if (logsMined < 3) {
    console.log('  Not enough logs! Trying to mine some dirt to test place instead...');
    await mineMultiple(client, 'dirt', 20);
  }

  // === Phase 3: Craft planks ===
  console.log('\n=== Phase 3: Craft Planks ===');
  // Each craft of oak_planks from 1 log yields 4 planks
  const craftCount = Math.max(logsMined, 1);
  for (let i = 0; i < craftCount; i++) {
    try {
      await call(client, 'craft', { item_name: 'oak_planks', count: 1 });
    } catch (e) {
      console.log(`  craft #${i + 1} failed: ${(e as Error).message}`);
      break;
    }
  }

  // Check inventory
  console.log('\n=== Phase 3b: Inventory Check ===');
  await call(client, 'get_status', {});

  // === Phase 4: Build a simple house ===
  // Simple 5x4x3 box (5 wide, 4 deep, 3 tall) with a door opening
  // Build near bot's current position
  console.log('\n=== Phase 4: Build House ===');

  // Re-check position after mining
  const status2 = ex(await client.callTool({ name: 'get_status', arguments: {} }));
  const posMatch2 = status2.match(/"x":([-\d.]+).*?"y":([-\d.]+).*?"z":([-\d.]+)/);
  const curPos = posMatch2
    ? { x: Math.floor(parseFloat(posMatch2[1])), y: Math.floor(parseFloat(posMatch2[2])), z: Math.floor(parseFloat(posMatch2[3])) }
    : botPos;

  // House origin: 3 blocks east of bot, on the ground level
  const hx = curPos.x + 3;
  const hy = curPos.y;  // ground level
  const hz = curPos.z;

  // Determine block to use: oak_planks if available, else dirt
  const invMatch = status2.match(/oak_planks x(\d+)/);
  const plankCount = invMatch ? parseInt(invMatch[1]) : 0;
  const blockName = plankCount >= 20 ? 'oak_planks' : 'dirt';
  console.log(`  Using ${blockName} (have ${plankCount} planks)`);
  console.log(`  House origin: (${hx}, ${hy}, ${hz})`);

  // Build floor (5x4)
  console.log('\n--- Floor ---');
  let placed = 0;
  for (let dx = 0; dx < 5; dx++) {
    for (let dz = 0; dz < 4; dz++) {
      try {
        await call(client, 'place', { block_name: blockName, x: hx + dx, y: hy, z: hz + dz });
        placed++;
      } catch (e) {
        console.log(`  place floor failed at (${hx + dx},${hy},${hz + dz}): ${(e as Error).message}`);
      }
    }
  }
  console.log(`  Floor: ${placed} blocks placed`);

  // Build walls (2 layers high)
  console.log('\n--- Walls ---');
  let wallPlaced = 0;
  for (let layer = 1; layer <= 2; layer++) {
    const wy = hy + layer;
    // Front wall (z = hz) - leave door opening at dx=2
    for (let dx = 0; dx < 5; dx++) {
      if (layer === 1 && dx === 2) continue; // door opening
      try {
        await call(client, 'place', { block_name: blockName, x: hx + dx, y: wy, z: hz });
        wallPlaced++;
      } catch (e) {
        console.log(`  wall fail: ${(e as Error).message}`);
      }
    }
    // Back wall (z = hz+3)
    for (let dx = 0; dx < 5; dx++) {
      try {
        await call(client, 'place', { block_name: blockName, x: hx + dx, y: wy, z: hz + 3 });
        wallPlaced++;
      } catch (e) {
        console.log(`  wall fail: ${(e as Error).message}`);
      }
    }
    // Left wall (x = hx)
    for (let dz = 1; dz < 3; dz++) {
      try {
        await call(client, 'place', { block_name: blockName, x: hx, y: wy, z: hz + dz });
        wallPlaced++;
      } catch (e) {
        console.log(`  wall fail: ${(e as Error).message}`);
      }
    }
    // Right wall (x = hx+4)
    for (let dz = 1; dz < 3; dz++) {
      try {
        await call(client, 'place', { block_name: blockName, x: hx + 4, y: wy, z: hz + dz });
        wallPlaced++;
      } catch (e) {
        console.log(`  wall fail: ${(e as Error).message}`);
      }
    }
  }
  console.log(`  Walls: ${wallPlaced} blocks placed`);

  // Build roof (5x4)
  console.log('\n--- Roof ---');
  let roofPlaced = 0;
  for (let dx = 0; dx < 5; dx++) {
    for (let dz = 0; dz < 4; dz++) {
      try {
        await call(client, 'place', { block_name: blockName, x: hx + dx, y: hy + 3, z: hz + dz });
        roofPlaced++;
      } catch (e) {
        console.log(`  roof fail: ${(e as Error).message}`);
      }
    }
  }
  console.log(`  Roof: ${roofPlaced} blocks placed`);

  // === Phase 5: Final status ===
  console.log('\n=== Phase 5: Final Status ===');
  await call(client, 'get_status', {});

  const totalBlocks = placed + wallPlaced + roofPlaced;
  console.log(`\n[BuildTest] Done! Placed ${totalBlocks} blocks total.`);
  process.exit(0);
}

main().catch(e => { console.error('[BuildTest] Error:', e.message); process.exit(1); });
