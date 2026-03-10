/**
 * 日志写入 - 观测层解耦（选项 B：Log Tailing）
 * 以 JSON 行格式写入，供 Dashboard 后端 tail -f 消费
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = process.env.MCBOOK_LOG_DIR ?? join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'mcbook.jsonl');

let stream: ReturnType<typeof createWriteStream> | null = null;

function getStream() {
  if (!stream) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      /* ignore */
    }
    stream = createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return stream;
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
