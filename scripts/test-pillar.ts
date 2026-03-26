/**
 * 测试手动垫方块上升 (pillar up)
 *
 * 不走 pathfinder，直接用 jump + placeBlock 手动垫。
 * 用法: MC_BOT_VERSION=1.21.11 npx tsx scripts/test-pillar.ts [层数]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMCBot } from '../src/bot/createBot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const layers = parseInt(process.argv[2] ?? '5', 10);

  const bot = createMCBot({
    username: process.env.MC_BOT_USERNAME ?? 'MCBook_Bot_1',
  });

  await new Promise<void>((resolve) => {
    bot.once('spawn', () => {
      console.log('[Bot] 已 spawn');
      resolve();
    });
  });

  // 等一下让 entity 加载
  await new Promise(r => setTimeout(r, 2000));

  const { Vec3 } = await import('vec3');
  const startPos = bot.entity.position.clone();
  console.log(`\n[开始] 位置: (${Math.floor(startPos.x)}, ${Math.floor(startPos.y)}, ${Math.floor(startPos.z)})`);
  console.log(`[背包] ${bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || '空'}`);

  const scaffoldNames = ['dirt', 'cobblestone', 'oak_planks', 'oak_log', 'stone', 'sand', 'gravel', 'cobbled_deepslate'];

  for (let i = 0; i < layers; i++) {
    let item = bot.inventory.items().find(it => scaffoldNames.some(s => it.name.includes(s)));
    if (!item) {
      console.log(`[采集] 没有垫方块材料，挖附近方块...`);
      const px = Math.floor(bot.entity.position.x);
      const py = Math.floor(bot.entity.position.y);
      const pz = Math.floor(bot.entity.position.z);
      // 挖旁边的方块（不挖脚下，避免掉落）
      const offsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[1,-1,0],[-1,-1,0],[0,-1,1],[0,-1,-1]];
      let dug = false;
      for (const [dx, dy, dz] of offsets) {
        const block = bot.blockAt(new Vec3(px + dx, py + dy, pz + dz));
        if (block && block.name !== 'air' && block.name !== 'bedrock' && block.name !== 'water' && block.boundingBox === 'block') {
          try {
            await bot.dig(block);
            console.log(`[采集] 挖了 ${block.name}`);
            dug = true;
            break;
          } catch { /* try next */ }
        }
      }
      if (dug) {
        // 等掉落物被捡起
        await new Promise(r => setTimeout(r, 1000));
        console.log(`[采集] 当前背包: ${bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ')}`);
      }
      item = bot.inventory.items().find(it => scaffoldNames.some(s => it.name.includes(s)));
      if (!item) {
        console.log(`[停止] 仍然没有可用材料`);
        break;
      }
    }

    const feetY = Math.floor(bot.entity.position.y);
    const bx = Math.floor(bot.entity.position.x);
    const bz = Math.floor(bot.entity.position.z);

    const below = bot.blockAt(new Vec3(bx, feetY - 1, bz));
    if (!below || below.name === 'air') {
      console.log(`[停止] 脚下没有支撑方块`);
      break;
    }

    try {
      await bot.equip(item, 'hand');
      await bot.lookAt(new Vec3(bx + 0.5, feetY, bz + 0.5), true);

      await bot.lookAt(new Vec3(bx + 0.5, feetY, bz + 0.5), true);

      bot.setControlState('sneak', true);
      bot.setControlState('jump', true);

      // 等 bot 升高
      for (let t = 0; t < 20; t++) {
        await new Promise(r => setTimeout(r, 50));
        if (bot.entity.position.y > feetY + 0.5) break;
      }
      bot.setControlState('jump', false);

      const refBlock = bot.blockAt(new Vec3(bx, feetY - 1, bz));
      if (refBlock && refBlock.name !== 'air') {
        await (bot as any)._genericPlace(refBlock, new Vec3(0, 1, 0), { sneak: true });
        console.log(`[放置] 在 y=${feetY} 放了 ${item.name}`);
      }

      bot.setControlState('sneak', false);
      await new Promise(r => setTimeout(r, 500));
      const newY = Math.floor(bot.entity.position.y);
      console.log(`[第${i + 1}层] y: ${feetY} → ${newY} ${newY > feetY ? '✅' : '❌'}`);
    } catch (err) {
      bot.setControlState('jump', false);
      console.log(`[第${i + 1}层] 失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  const endPos = bot.entity.position;
  const gained = Math.floor(endPos.y) - Math.floor(startPos.y);
  console.log(`\n[结果] y: ${Math.floor(startPos.y)} → ${Math.floor(endPos.y)}（上升 ${gained}/${layers} 格）`);
  console.log(gained >= layers ? '✅ 全部成功' : `⚠️ 成功 ${gained}/${layers}`);

  bot.quit();
  process.exit(0);
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
