# OpenClaw 接入 Minecraft 配置指南

## 重要说明

OpenClaw 的 `plugins.entries` 只接受**已安装的插件**（如 `@openclaw/voice-call`），不能直接配置外部 MCP 服务器的 command/args。  
Minecraft MCP 需要通过 **McPorter** 管理：McPorter 是 MCP 服务器运行时，Agent 通过 mcporter skill 调用 `mcporter call minecraft-mcp.<工具名>` 来使用 Minecraft 工具。

---

## 方式一：McPorter + mcporter skill（推荐）

### 1. 安装 McPorter

```bash
npm install -g mcporter
```

### 2. 添加 Minecraft MCP 到 McPorter 配置

在 **OpenClaw 工作区** 下执行（工作区默认：`~/.openclaw/workspace`）：

```bash
cd ~/.openclaw/workspace   # Windows: cd C:\Users\<用户名>\.openclaw\workspace

npx mcporter config add minecraft-mcp --stdio "npx" --arg "tsx" --arg "C:/Users/eamon/OneDrive/Vibe Geming/mcbook/src/mcp/server.ts" --env "MC_BOT_HOST=localhost" --env "MC_BOT_PORT=25565" --env "MC_BOT_USERNAME=MCBook_Bot_1" --scope project
```

**注意**：将路径 `C:/Users/eamon/OneDrive/Vibe Geming/mcbook/...` 替换为你的 mcbook 项目实际路径。

### 3. 安装 mcporter skill（若尚未安装）

```bash
npx playbooks add skill openclaw/skills --skill mcporter
```

### 4. 在 OpenClaw 中启用 mcporter skill

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "skills": {
    "entries": {
      "mcporter": {
        "enabled": true
      }
    }
  }
}
```

或在 OpenClaw 设置 → Skills 中启用 mcporter。

### 5. 确保 tools 允许 exec

mcporter skill 通过 exec 运行 `mcporter call`。若 tools.profile 为 `messaging` 等限制型配置，需在 `tools.alsoAllow` 中加入 `exec`：

```json
{
  "tools": {
    "profile": "messaging",
    "alsoAllow": ["exec"]
  }
}
```

### 6. 重启 OpenClaw Gateway

```bash
openclaw gateway
```

### 7. 验证

在 OpenClaw 对话中尝试：

- 「帮我看看 Minecraft 里我现在在哪」
- 「移动到坐标 240 65 430」
- 「挖一棵橡木」

Agent 会通过 `mcporter call minecraft-mcp.get_position`、`mcporter call minecraft-mcp.move_to` 等调用 Minecraft 工具。

---

## 方式二：手动编辑 mcporter.json

若已安装 mcporter，可直接编辑 `~/.openclaw/workspace/config/mcporter.json`：

```json
{
  "mcpServers": {
    "minecraft-mcp": {
      "command": "npx",
      "args": [
        "tsx",
        "C:/Users/eamon/OneDrive/Vibe Geming/mcbook/src/mcp/server.ts"
      ],
      "env": {
        "MC_BOT_HOST": "localhost",
        "MC_BOT_PORT": "25565",
        "MC_BOT_USERNAME": "MCBook_Bot_1"
      }
    }
  },
  "imports": []
}
```

---

## 前置条件

1. **Minecraft 服务器已启动**（默认 localhost:25565）
2. **mcbook 依赖已安装**：在 mcbook 目录执行 `npm install`
3. **OpenClaw 已安装**：`npm i -g openclaw`

---

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| MC_BOT_HOST | 服务器地址 | localhost |
| MC_BOT_PORT | 端口 | 25565 |
| MC_BOT_USERNAME | Bot 用户名 | MCBook_Bot_1 |

---

## 故障排查

### 1. 报错 "plugin not found: minecraft-mcp"

- 原因：`plugins.entries` 中配置了 minecraft-mcp，但 OpenClaw 没有内置该插件。
- 解决：从 `plugins.entries` 中删除 minecraft-mcp，改用 McPorter + mcporter skill（见上文）。

### 2. OpenClaw 找不到 Minecraft 工具

- 检查 `~/.openclaw/workspace/config/mcporter.json` 是否包含 minecraft-mcp；
- 确认 mcporter skill 已启用；
- 确认 tools 允许 exec（`tools.alsoAllow` 包含 `exec`）；
- 查看 Gateway 日志：`openclaw gateway --verbose`。

### 3. 验证 mcporter 配置

```bash
cd ~/.openclaw/workspace
npx mcporter list minecraft-mcp --schema
```

应能看到 Minecraft 工具列表（get_position、move_to、mine 等）。

### 4. Bot 无法连接游戏

- 确认 Minecraft 服务器已启动；
- 检查 MC_BOT_HOST、MC_BOT_PORT 是否正确；
- 若服务器在另一台机器，修改 MC_BOT_HOST。

### 5. 工具调用超时

- 寻路、挖矿等操作可能较慢，可适当增加超时时间；
- 先让 Bot 移动到目标附近再执行复杂操作。
