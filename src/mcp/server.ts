/**
 * MCBook MCP 服务器 - OpenClaw 神经接口
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMCBot } from '../bot/createBot.js';
import { addChat, getChat } from './chatLog.js';
import {
  getSurroundingBlocksRelative,
  getSurroundingBlocksGrid,
  getScan,
  getScanBlocks,
  perceptionToolSchemas,
} from './tools/perception.js';
import {
  actionToolSchemas,
  executeMoveTo,
  executeMine,
  executeChat,
  executeEquip,
  executeAttack,
  executeEat,
  getMcData,
} from './tools/action.js';
import { getActionLock } from '../bot/actionLock.js';
import { registerEventListeners, getAndClearPendingEvents } from './events.js';
import { registerStateSnapshot, getLastSnapshot, clearSnapshot } from './stateSnapshot.js';
import { writePendingDeath } from './deathReflection.js';
import { writeLog } from '../observer/logWriter.js';
import { registerLocalRules } from '../bot/localRules.js';

const host = process.env.MC_BOT_HOST ?? 'localhost';
const port = parseInt(process.env.MC_BOT_PORT ?? '25565', 10);
const username = process.env.MC_BOT_USERNAME ?? 'MCBook_Bot_1';

const mcpServer = new McpServer({
  name: 'mcbook-minecraft',
  version: '1.0.0',
});

import type { Bot } from 'mineflayer';

let botInstance: Bot | null = null;
let botConnecting: Promise<Bot> | null = null;

async function ensureBot(): Promise<Bot> {
  if (botInstance) return botInstance;
  // 防止并发调用创建多个 Bot
  if (botConnecting) return botConnecting;

  botConnecting = new Promise<Bot>((resolve, reject) => {
    const bot = createMCBot({ host, port, username });
    bot.once('spawn', () => {
      botInstance = bot;
      botConnecting = null;
      registerStateSnapshot(bot);
      registerEventListeners(bot, (ev) => {
        // 过滤 Bot 自身的聊天消息，避免自回声反馈循环
        if (ev.type === 'chat') {
          if (ev.username === username || ev.username === bot.username) return;
          addChat(ev.username, ev.message);
        }
        if (ev.type === 'death') {
          const verdict = getLastSnapshot() ?? {};
          writePendingDeath(verdict, username);
          clearSnapshot();
        }
        writeLog({ ts: Date.now(), type: 'event', event: ev });
      });
      // 本地规则引擎：自动进食、自动装备武器等（零 token 消耗）
      registerLocalRules(bot, (action) => {
        writeLog({ ts: Date.now(), type: 'action', tool: `local:${action.type}`, result: action.detail });
      });
      setImmediate(() => resolve(bot));
    });
    bot.on('error', (err) => {
      botConnecting = null;
      reject(err);
    });
    // Bot 被踢出或断连时清空实例，允许重连
    bot.on('end', () => {
      console.error(`[MCBook] Bot ${username} 断开连接，将在下次调用时重连`);
      botInstance = null;
      botConnecting = null;
    });
  });

  return botConnecting;
}

/** 等待 Bot 的 entity 就绪（mcporter 等场景下 spawn 后 entity 可能稍晚才可用） */
async function ensureBotWithEntity(): Promise<Bot> {
  const b = await ensureBot();
  if (b.entity) return b;
  const maxWaitMs = 8000;
  const start = Date.now();
  while (!b.entity && Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return b;
}

function registerPerceptionTools() {
  mcpServer.registerTool(
    'get_surrounding_blocks',
    {
      description: perceptionToolSchemas.get_surrounding_blocks.description,
      inputSchema: perceptionToolSchemas.get_surrounding_blocks.inputSchema,
    },
    async (args: { format?: string; radius?: number }) => {
      writeLog({ ts: Date.now(), type: 'perception', tool: 'get_surrounding_blocks', args });
      const b = await ensureBotWithEntity();
      if (!b.entity) return { content: [{ type: 'text' as const, text: 'Bot 尚未完全加载，请稍候' }] };
      const format = args.format ?? 'relative';
      const radius = args.radius ?? 5;

      if (format === 'grid') {
        const grid = getSurroundingBlocksGrid(b, radius * 2 + 1);
        return { content: [{ type: 'text' as const, text: grid }] };
      }
      const list = getSurroundingBlocksRelative(b, radius);
      return {
        content: [{ type: 'text' as const, text: list.join('\n') || '周围无方块' }],
      };
    }
  );

  mcpServer.registerTool(
    'get_inventory',
    {
      description: perceptionToolSchemas.get_inventory.description,
      inputSchema: z.object({}),
    },
    async () => {
      const b = await ensureBotWithEntity();
      const inv = b.inventory;
      if (!inv?.items) return { content: [{ type: 'text' as const, text: '背包尚未加载，请稍候' }] };
      const items = inv.items().map((i) => `${i.name} x${i.count}`);
      return { content: [{ type: 'text' as const, text: items.join('\n') || '背包为空' }] };
    }
  );

  mcpServer.registerTool(
    'read_chat',
    {
      description: perceptionToolSchemas.read_chat.description,
      inputSchema: perceptionToolSchemas.read_chat.inputSchema,
    },
    async (args: { limit?: number }) => {
      const limit = args.limit ?? 20;
      const entries = getChat(limit);
      const text = entries.map((e) => `[${e.username}] ${e.message}`).join('\n');
      return { content: [{ type: 'text' as const, text: text || '无聊天记录' }] };
    }
  );

  mcpServer.registerTool(
    'get_health',
    {
      description: perceptionToolSchemas.get_health.description,
      inputSchema: z.object({}),
    },
    async () => {
      const b = await ensureBotWithEntity();
      const health = b.health ?? 20;
      const food = b.food ?? 20;
      return { content: [{ type: 'text' as const, text: `血量: ${health}/20, 饥饿度: ${food}/20` }] };
    }
  );

  mcpServer.registerTool(
    'get_position',
    {
      description: perceptionToolSchemas.get_position.description,
      inputSchema: z.object({}),
    },
    async () => {
      const b = await ensureBotWithEntity();
      if (!b.entity) return { content: [{ type: 'text' as const, text: 'Bot 尚未完全加载，请稍候' }] };
      const p = b.entity.position;
      return {
        content: [{ type: 'text' as const, text: `坐标: (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` }],
      };
    }
  );

  mcpServer.registerTool(
    'get_pending_events',
    {
      description: '获取待处理的游戏事件（血量变化、聊天消息、受伤、死亡等）。调用后事件会被清空。',
      inputSchema: z.object({}),
    },
    async () => {
      const events = getAndClearPendingEvents();
      const text =
        events.length === 0
          ? '无待处理事件'
          : events.map((e) => JSON.stringify(e)).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  mcpServer.registerTool(
    'get_time_of_day',
    {
      description: perceptionToolSchemas.get_time_of_day.description,
      inputSchema: z.object({}),
    },
    async () => {
      const b = await ensureBotWithEntity();
      const time = (b.time as { timeOfDay?: number } | undefined)?.timeOfDay ?? 0;
      const isDay = time >= 0 && time < 12000;
      return {
        content: [
          {
            type: 'text' as const,
            text: isDay ? `白天 (${time})` : `夜晚 (${time})`,
          },
        ],
      };
    }
  );

  mcpServer.registerTool(
    'get_scan',
    {
      description: perceptionToolSchemas.get_scan.description,
      inputSchema: perceptionToolSchemas.get_scan.inputSchema,
    },
    async (args: { radius?: number; include_blocks?: boolean }) => {
      const b = await ensureBotWithEntity();
      if (!b.entity) return { content: [{ type: 'text' as const, text: 'Bot 尚未完全加载' }] };
      const radius = args.radius ?? 32;
      const includeBlocks = args.include_blocks !== false;
      const entities = getScan(b, radius);
      const blocks = includeBlocks ? getScanBlocks(b, Math.min(radius, 8)) : [];
      const lines = [...entities, ...blocks];
      return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : '视野内无玩家、敌对生物或重要资源' }] };
    }
  );

  mcpServer.registerTool(
    'get_status',
    {
      description: perceptionToolSchemas.get_status.description,
      inputSchema: z.object({}),
    },
    async () => {
      const b = await ensureBotWithEntity();
      const { isBusy, currentAction } = getActionLock();
      const pos = b.entity ? b.entity.position : { x: 0, y: 0, z: 0 };
      const inv = b.inventory?.items?.() ?? [];
      const inventory = inv.map((i) => `${i.name} x${i.count}`).join(', ') || '空';
      const time = (b.time as { timeOfDay?: number } | undefined)?.timeOfDay ?? 0;
      const isDay = time >= 0 && time < 12000;
      const status = {
        health: b.health ?? 20,
        food: b.food ?? 20,
        position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        inventory,
        timeOfDay: time,
        isDay,
        isBusy,
        currentAction,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 0) }] };
    }
  );
}

/** 统一错误返回，防止异常中断 MCP 连接 */
function errorText(tool: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `[${tool}] 失败: ${msg}` }] };
}

function registerActionTools() {
  mcpServer.registerTool(
    'move_to',
    {
      description: actionToolSchemas.move_to.description,
      inputSchema: actionToolSchemas.move_to.inputSchema,
    },
    async (args: { x: number; y: number; z: number; range?: number }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'move_to', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeMoveTo(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('move_to', err); }
    }
  );

  mcpServer.registerTool(
    'mine',
    {
      description: actionToolSchemas.mine.description,
      inputSchema: actionToolSchemas.mine.inputSchema,
    },
    async (args: { block_type?: string; x?: number; y?: number; z?: number }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'mine', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeMine(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('mine', err); }
    }
  );

  mcpServer.registerTool(
    'chat',
    {
      description: actionToolSchemas.chat.description,
      inputSchema: actionToolSchemas.chat.inputSchema,
    },
    async (args: { message: string }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'chat', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeChat(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('chat', err); }
    }
  );

  mcpServer.registerTool(
    'equip',
    {
      description: actionToolSchemas.equip.description,
      inputSchema: actionToolSchemas.equip.inputSchema,
    },
    async (args: { item_name: string }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'equip', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeEquip(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('equip', err); }
    }
  );

  mcpServer.registerTool(
    'attack',
    {
      description: actionToolSchemas.attack.description,
      inputSchema: actionToolSchemas.attack.inputSchema,
    },
    async (args: { target_name: string }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'attack', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeAttack(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('attack', err); }
    }
  );

  mcpServer.registerTool(
    'eat',
    {
      description: actionToolSchemas.eat.description,
      inputSchema: actionToolSchemas.eat.inputSchema,
    },
    async (args: { food_name?: string }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'eat', args });
      try {
        const b = await ensureBotWithEntity();
        const msg = await executeEat(b, args);
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (err) { return errorText('eat', err); }
    }
  );

  mcpServer.registerTool(
    'craft',
    {
      description: actionToolSchemas.craft.description,
      inputSchema: actionToolSchemas.craft.inputSchema,
    },
    async (args: { item_name: string; count?: number }) => {
      writeLog({ ts: Date.now(), type: 'action', tool: 'craft', args });
      try {
        const b = await ensureBotWithEntity();
        const mcData = await getMcData(b.version);
        const item = mcData.itemsByName[args.item_name];
        if (!item) return { content: [{ type: 'text' as const, text: `未知物品: ${args.item_name}` }] };

        const recipe = b.recipesFor(item.id, null, 1, null)[0];
        if (!recipe) return { content: [{ type: 'text' as const, text: `无合成配方: ${args.item_name}` }] };

        await b.craft(recipe, args.count ?? 1, undefined);
        return { content: [{ type: 'text' as const, text: `已合成 ${args.item_name} x${args.count ?? 1}` }] };
      } catch (err) { return errorText('craft', err); }
    }
  );
}

async function main() {
  registerPerceptionTools();
  registerActionTools();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  await ensureBot();
}

main().catch((err) => {
  console.error('[MCBook MCP]', err);
  process.exit(1);
});
