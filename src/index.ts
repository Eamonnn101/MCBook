/**
 * MCBook - OpenClaw + Mineflayer Minecraft 多智能体
 * 入口：启动单 Bot 测试
 */
import { createMCBot } from './bot/createBot.js';

const username = process.env.MC_BOT_USERNAME ?? 'MCBook_Bot_1';

const bot = createMCBot({ username });

bot.once('spawn', () => {
  bot.chat('MCBook 躯壳已上线，等待 OpenClaw 接入。');
});
