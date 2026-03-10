# MCBook

AI-driven Minecraft bot system inspired by [Stanford Generative Agents](https://arxiv.org/abs/2304.03442). Uses a **cognitive cycle** architecture — the AI "thinks" every 3 minutes instead of reacting to every event, reducing token usage by ~95%.

Built with [Mineflayer](https://github.com/PrismarinJS/mineflayer) + [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) + [OpenClaw](https://github.com/anthropics/openclaw).

## How It Works

```
┌─────────────────── Cognitive Cycle (3 min) ───────────────────┐
│                                                                │
│  [Observe]  8s poll → Memory Stream (zero token)               │
│      ↓                                                         │
│  [Think]    1 AI call → reflection + action plan (JSON)        │
│      ↓                                                         │
│  [Execute]  PlanExecutor runs steps via MCP (zero token)       │
│      ↓                                                         │
│  [Interrupt] death/low HP/attack → immediate think             │
│                                                                │
│  Old: 22 AI calls / 3 min     New: 1 AI call / 3 min          │
└────────────────────────────────────────────────────────────────┘
```

### Architecture

```
Minecraft Server (Paper 1.21+)
    ↕
MCP Server (src/mcp/) ← owns the bot, exposes 15 tools
    ↕
Game Master (scripts/game-master.ts)
    │  ├─ Memory Stream: accumulates observations
    │  ├─ Cognitive Prompt: builds "think" prompt every 3 min
    │  └─ PlanExecutor: runs AI's plan via MCP tools
    ↕
Heartbeat Client (scripts/heartbeat-client.ts)
    │  ├─ Receives prompt from Game Master (WebSocket)
    │  ├─ Sends to OpenClaw AI
    │  └─ POSTs AI's JSON plan back to Game Master
    ↕
OpenClaw AI → outputs JSON plan only, never calls tools directly
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Minecraft Java Edition server (Paper 1.21+ recommended)
- OpenClaw CLI (`npm install -g openclaw`)

### 1. Install

```bash
git clone https://github.com/yourname/mcbook.git
cd mcbook
npm install
```

### 2. Start Minecraft Server

Make sure your server is running on `localhost:25565`.

### 3. Run

Open two terminals:

```bash
# Terminal 1: Game Master (connects bot, runs cognitive cycle)
npm run game-master

# Terminal 2: Heartbeat Client (bridges Game Master ↔ OpenClaw)
npm run heartbeat-client
```

The bot will:
1. Connect to your Minecraft server
2. Start observing the world every 8 seconds
3. Every 3 minutes, send a "think" prompt to OpenClaw
4. OpenClaw returns a JSON action plan
5. PlanExecutor executes the plan step-by-step (mine, move, craft, etc.)
6. Urgent events (damage, death, chat) trigger immediate thinking

### 4. Manual Testing (without OpenClaw)

You can POST a plan directly to test:

```bash
curl -X POST http://localhost:3848/plan \
  -H "Content-Type: application/json" \
  -d '{"bot":"Bot_1","plan":"{\"reflection\":\"safe area\",\"plan\":[{\"tool\":\"mine\",\"args\":{\"block_type\":\"oak_log\"},\"note\":\"chop tree\"}]}"}'
```

## Configuration

Edit `config/game-master.json`:

```json
{
  "cognitiveCycleMs": 180000,
  "observeIntervalMs": 8000,
  "urgentHealthThreshold": 6,
  "httpPort": 3848,
  "memoryDir": "memory",
  "bots": [
    {
      "name": "Bot_1",
      "mcBotName": "MCBook_Bot_1",
      "mcporterServer": "minecraft-mcp",
      "openclawAgent": "main"
    }
  ]
}
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `cognitiveCycleMs` | `180000` (3 min) | How often the AI "thinks" |
| `observeIntervalMs` | `8000` | How often to poll bot state (zero token) |
| `urgentHealthThreshold` | `6` | HP below this triggers immediate think |
| `httpPort` | `3848` | Game Master HTTP/WebSocket port |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_BOT_HOST` | `localhost` | Minecraft server address |
| `MC_BOT_PORT` | `25565` | Minecraft server port |
| `MC_BOT_USERNAME` | `MCBook_Bot_1` | Bot username |
| `MC_BOT_VERSION` | auto-detect | Minecraft version override |
| `OPENCLAW_API_URL` | — | OpenClaw HTTP API (alternative to CLI) |

## Project Structure

```
mcbook/
├── src/
│   ├── bot/                    # Mineflayer bot management
│   │   ├── createBot.ts        # Bot creation & plugin loading
│   │   ├── localRules.ts       # Zero-token survival (auto-eat, auto-equip)
│   │   ├── actionLock.ts       # Concurrency lock
│   │   ├── pathfinder.ts       # Navigation with anti-stuck
│   │   └── plugins.ts          # Mineflayer plugin loader
│   ├── mcp/                    # MCP server (15 tools)
│   │   ├── server.ts           # Tool registration & bot lifecycle
│   │   ├── events.ts           # Event system (health/chat/combat/time)
│   │   ├── tools/
│   │   │   ├── perception.ts   # 8 sensing tools (scan, blocks, health...)
│   │   │   └── action.ts       # 7 action tools (move, mine, craft...)
│   │   ├── chatLog.ts          # Chat message buffer
│   │   ├── stateSnapshot.ts    # Pre-death inventory capture
│   │   └── deathReflection.ts  # Post-mortem learning
│   ├── cognitive/              # Stanford Generative Agents system
│   │   ├── memoryStream.ts     # Timestamped observation accumulator
│   │   └── planExecutor.ts     # Executes AI's JSON plans via MCP
│   └── observer/
│       └── logWriter.ts        # JSON-L log output
├── scripts/
│   ├── game-master.ts          # Cognitive cycle scheduler + HTTP server
│   ├── heartbeat-client.ts     # OpenClaw bridge (prompt → AI → plan)
│   └── test-cognitive.ts       # Unit tests for cognitive system
├── agents/                     # AI personality definitions
│   ├── architect/              # Builder personality
│   │   ├── SOUL.md             # Core traits & values
│   │   └── AGENTS.md           # Behavior rules & tool reference
│   ├── predator/SOUL.md
│   ├── hoarder/SOUL.md
│   └── merchant/
│       ├── SOUL.md
│       └── AGENTS.md
├── config/
│   └── game-master.json        # Runtime configuration
├── dashboard/                  # Web UI (port 3847)
│   ├── server.js
│   └── index.html
├── docs/
│   ├── GAME_MASTER.md
│   └── OPENCLAW_SETUP.md
└── package.json
```

## MCP Tools

### Perception (8 tools, read-only)

| Tool | Description |
|------|-------------|
| `get_status` | All-in-one: HP, hunger, position, inventory, time, isBusy |
| `get_scan` | Nearby players, hostile mobs, ores, trees (directional) |
| `get_surrounding_blocks` | Block grid or relative direction descriptions |
| `get_inventory` | Backpack items and counts |
| `get_health` | HP and hunger values |
| `get_position` | Current coordinates |
| `get_time_of_day` | Day/night status |
| `get_pending_events` | Queued game events (poll fallback) |

### Action (7 tools)

| Tool | Args | Description |
|------|------|-------------|
| `move_to` | `{x, y, z}` | Pathfind to coordinates |
| `mine` | `{block_type}` or `{x,y,z}` | Dig/chop/mine blocks |
| `craft` | `{item_name, count?}` | Craft items from inventory |
| `chat` | `{message}` | Send chat message |
| `equip` | `{item_name}` | Hold item in hand |
| `attack` | `{target_name}` | Attack entity until dead |
| `eat` | `{food_name?}` | Eat food (auto-select if empty) |

## AI Plan Format

The AI outputs structured JSON plans:

```json
{
  "reflection": "Area is safe, lots of oak trees nearby",
  "plan": [
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "chop trees" },
    { "tool": "craft", "args": { "item_name": "wooden_planks", "count": 4 }, "note": "make planks" },
    { "tool": "craft", "args": { "item_name": "wooden_pickaxe" }, "note": "make pickaxe" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "mine stone" },
    { "tool": "chat", "args": { "message": "Anyone want to trade?" }, "note": "find trades" }
  ]
}
```

## HTTP API

Game Master exposes these endpoints on `http://localhost:3848`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Bot cognitive state (memory stream size, plan progress, next think) |
| `GET` | `/heartbeat?bot=Bot_1` | Pull pending prompt (for heartbeat client) |
| `POST` | `/plan` | Submit AI's JSON plan `{"bot":"Bot_1","plan":"..."}` |
| `WebSocket` | `ws://localhost:3848?bot=Bot_1` | Real-time prompt push |

## Local Rules (Zero Token)

The bot handles basic survival without AI:
- **Auto-eat**: Eats best food when hunger < 8
- **Auto-equip**: Equips best weapon when attacked

## Tests

```bash
# Cognitive system unit tests (no Minecraft needed)
npm run test:cognitive

# MCP integration test (needs Minecraft)
npm run test:mcp
```

## Dashboard

```bash
npm run dashboard
# Open http://localhost:3847
```

## License

MIT
