/**
 * Mineflayer 插件加载
 * 加载 pathfinder、collectblock、tool
 */
import type { Bot } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { plugin as toolPlugin } from 'mineflayer-tool';

export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinderModule.pathfinder);
  bot.loadPlugin(collectBlockPlugin);
  bot.loadPlugin(toolPlugin);
}
