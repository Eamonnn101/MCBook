/**
 * 日志写入 - 观测层解耦（选项 B：Log Tailing）
 * 以 JSON 行格式写入，供 Dashboard 后端 tail -f 消费
 *
 * 两个日志文件：
 * - mcbook.jsonl   : 结构化日志（action/perception/event/state）
 * - debug.log      : 人类可读的调试日志（认知思考、计划执行、脱困等）
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = process.env.MCBOOK_LOG_DIR ?? join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'mcbook.jsonl');
const DEBUG_FILE = join(LOG_DIR, 'debug.log');

let stream: ReturnType<typeof createWriteStream> | null = null;
let debugStream: ReturnType<typeof createWriteStream> | null = null;

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function getStream() {
  if (!stream) {
    ensureLogDir();
    stream = createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return stream;
}

function getDebugStream() {
  if (!debugStream) {
    ensureLogDir();
    // 每次启动覆盖旧日志（'w' 模式），避免多次运行日志混在一起
    debugStream = createWriteStream(DEBUG_FILE, { flags: 'w' });
    const now = new Date();
    debugStream.write(`=== MCBook Debug Log 启动于 ${now.toISOString()} ===\n\n`);
  }
  return debugStream;
}

export interface LogEntry {
  ts: number;
  type: 'action' | 'perception' | 'event' | 'state';
  bot?: string;
  tool?: string;
  args?: unknown;
  result?: string;
  event?: unknown;
}

export function writeLog(entry: LogEntry): void {
  try {
    getStream().write(JSON.stringify(entry) + '\n');
  } catch {
    /* ignore */
  }
}

/**
 * 写入人类可读的调试日志
 * 格式: [HH:MM:SS] [TAG] message
 */
export function writeDebug(tag: string, message: string, data?: unknown): void {
  try {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    let line = `[${time}] [${tag}] ${message}`;
    if (data !== undefined) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      // 多行数据缩进
      if (dataStr.includes('\n')) {
        line += '\n' + dataStr.split('\n').map(l => '  ' + l).join('\n');
      } else {
        line += ' | ' + dataStr;
      }
    }
    line += '\n';
    getDebugStream().write(line);
    // 同时输出到 stderr 方便终端查看
    process.stderr.write(line);
  } catch {
    /* ignore */
  }
}
