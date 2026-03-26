/**
 * 聊天记录缓存，供 read_chat 使用
 */
export interface ChatEntry {
  timestamp: number;
  username: string;
  message: string;
}

const chatLog: ChatEntry[] = [];
const MAX_ENTRIES = 100;

export function addChat(username: string, message: string): void {
  chatLog.push({
    timestamp: Date.now(),
    username,
    message,
  });
  if (chatLog.length > MAX_ENTRIES) {
    chatLog.shift();
  }
}

export function getChat(limit = 20): ChatEntry[] {
  return chatLog.slice(-limit);
}
