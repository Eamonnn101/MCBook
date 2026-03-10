# Game Master 使用说明

## 概述

Game Master 采用**拉取模式**：收集情报、构建 Prompt，通过 HTTP 接口提供。由 **heartbeat-client** 或 OpenClaw 主动拉取后再发送，不再推送，避免传空信息。

**Bot 常驻**：Game Master 使用 MCP Client 长连接，Bot 一直保持在 Minecraft 世界中。

## 启动

```bash
# 终端 1：Game Master（HTTP 服务 + 数据收集）
npm run game-master

# 终端 2：Heartbeat Client（主动拉取并发送给 OpenClaw）
npm run heartbeat-client
```

## 配置

编辑 `config/game-master.json`：

| 字段 | 说明 |
|------|------|
| intervalMs | 心跳间隔（毫秒），默认 8000 |
| httpPort | HTTP 服务端口，默认 3848 |
| memoryDir | 记忆文件目录，默认 `memory` |
| allowInterruptOnThreat | 发现威胁时是否打断当前动作（默认 false） |
| bots | Bot 列表 |

每个 Bot 配置：

| 字段 | 说明 |
|------|------|
| name | 逻辑名称 |
| mcBotName | MC 内 Bot 用户名（与 MC_BOT_USERNAME 一致） |
| mcporterServer | mcporter 中的服务器名 |
| openclawAgent | OpenClaw Agent 名（main、predator、hoarder 等） |

## HTTP 接口

- `GET /` - 简要说明
- `GET /heartbeat?bot=Bot_1` - 拉取 prompt，拉取后清空（204 表示暂无）

## 动作锁

当 Bot 正在执行 `move_to`、`mine`、`attack` 等长耗时动作时，`get_status` 返回 `isBusy: true`。Game Master 会**跳过本轮心跳**，避免打断动作。

## 死亡反思

当 Bot 死亡时，躯体层会保存死前快照并写入 `memory/death_pending_<mcBotName>.json`。Game Master 在下一轮心跳时会：

1. 检测到待处理死亡
2. 调用 OpenClaw 进行反思
3. 将生存法则追加到 `memory/<mcBotName>_memory.txt`
4. 删除待处理文件

## 多 Bot 配置示例

```json
{
  "bots": [
    {
      "name": "Predator",
      "mcBotName": "MCBook_Predator",
      "mcporterServer": "minecraft-mcp-predator",
      "openclawAgent": "predator"
    },
    {
      "name": "Hoarder",
      "mcBotName": "MCBook_Hoarder",
      "mcporterServer": "minecraft-mcp-hoarder",
      "openclawAgent": "hoarder"
    }
  ]
}
```

需在 `~/.openclaw/workspace/config/mcporter.json` 中配置对应的 MCP 服务器，并在 OpenClaw 的 `agents.list` 中注册 predator、hoarder。
