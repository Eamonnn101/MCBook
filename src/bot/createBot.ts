/**
 * 创建并配置 Mineflayer Bot
 */
import mineflayer from 'mineflayer';
import { loadPlugins } from './plugins.js';
import { setupPathfinder } from './pathfinder.js';

export interface CreateBotOptions {
  host?: string;
  port?: number;
  username: string;
  version?: string;
}

export function createMCBot(options: CreateBotOptions) {
  const host = options.host ?? process.env.MC_BOT_HOST ?? 'localhost';
  const port = options.port ?? parseInt(process.env.MC_BOT_PORT ?? '25565', 10);

  const version = options.version ?? process.env.MC_BOT_VERSION ?? undefined;

  const bot = mineflayer.createBot({
    host,
    port,
    username: options.username,
    version,
  });

  loadPlugins(bot);

  bot.once('spawn', () => {
    setupPathfinder(bot);
    console.error(`[MCBook] Bot ${options.username} 已连接并加载插件`);
  });

  bot.on('error', (err) => {
    console.error(`[MCBook] Bot ${options.username} 错误:`, err);
  });

  bot.on('kicked', (reason) => {
    console.warn(`[MCBook] Bot ${options.username} 被踢出:`, reason);
  });

  return bot;
}
