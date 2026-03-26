/**
 * Skill Executor - 沙箱化 JS 技能执行器
 *
 * 在受限的 vm 上下文中执行技能 JS 代码。
 * 技能函数接收 SkillContext 对象，可以调用 MCP 工具。
 */

import vm from 'vm';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { skillLibrary } from './skillLibrary.js';

export interface SkillContext {
  /** 调用 MCP 工具 */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** 日志输出 */
  log: (msg: string) => void;
  /** 等待指定毫秒 */
  sleep: (ms: number) => Promise<void>;
  /** 当前 Bot 名称 */
  botName: string;
}

export interface SkillExecResult {
  success: boolean;
  result: string;
  durationMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 在沙箱中执行技能
 * @param owner - 技能所有者（Agent 名称或 'shared'）
 * @param skillName - 技能名称
 * @param client - MCP Client（用于调用工具）
 * @param botName - 当前 Bot 名称
 * @param timeoutMs - 超时毫秒数
 */
export async function executeSkill(
  owner: string,
  skillName: string,
  client: Client,
  botName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SkillExecResult> {
  const startMs = Date.now();

  // 加载代码
  let code = await skillLibrary.getCode(owner, skillName);
  if (!code) {
    // 尝试从 shared 加载
    code = await skillLibrary.getCode('shared', skillName);
  }
  if (!code) {
    return {
      success: false,
      result: `技能 "${skillName}" 不存在`,
      durationMs: Date.now() - startMs,
    };
  }

  // 构建上下文
  const logs: string[] = [];
  const context: SkillContext = {
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const contentArr = Array.isArray(result.content) ? result.content : [];
      const text = contentArr.find((c: Record<string, unknown>) => c.type === 'text');
      return text && 'text' in text ? String(text.text) : '';
    },
    log: (msg) => logs.push(msg),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5000))),
    botName,
  };

  try {
    // 包装代码为异步函数
    const wrappedCode = `
      (async function(ctx) {
        const { callTool, log, sleep, botName } = ctx;
        ${code}
      })
    `;

    const script = new vm.Script(wrappedCode, {
      filename: `skill:${skillName}`,
    });

    const sandbox = {
      console: { log: (msg: unknown) => logs.push(String(msg)) },
      setTimeout,
      clearTimeout,
      Promise,
      JSON,
      Math,
      Array,
      Object,
      String,
      Number,
      Date,
      Map,
      Set,
      Error,
    };

    const vmContext = vm.createContext(sandbox);
    const fn = script.runInContext(vmContext, { timeout: timeoutMs }) as (ctx: SkillContext) => Promise<unknown>;

    // 带超时执行
    const result = await Promise.race([
      fn(context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`技能执行超时 (${timeoutMs}ms)`)), timeoutMs),
      ),
    ]);

    const resultStr = typeof result === 'string' ? result : (logs.length > 0 ? logs.join('\n') : '技能执行完成');
    const durationMs = Date.now() - startMs;

    // 记录成功
    await skillLibrary.recordSuccess(owner, skillName);

    return { success: true, result: resultStr, durationMs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;

    // 记录失败
    await skillLibrary.recordFailure(owner, skillName);

    return {
      success: false,
      result: `技能 "${skillName}" 执行失败: ${errMsg}`,
      durationMs,
      error: errMsg,
    };
  }
}
