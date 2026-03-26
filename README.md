# MCBook

AI-driven Minecraft multi-agent society inspired by [Stanford Generative Agents](https://arxiv.org/abs/2304.03442). Each bot runs in its own terminal with a unique personality, forming a distributed AI agent society that collaborates, trades, and survives together.

Built with [Mineflayer](https://github.com/PrismarinJS/mineflayer) + [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) + LLM (Ollama / OpenClaw).

## Architecture

```
                    ┌──────────────────────────────┐
                    │    Coordinator Server         │
                    │    (shared state hub)         │
                    │                               │
                    │  AgentRegistry  EventBus      │
                    │  TradeEngine    Waypoints      │
                    │  Teams          Dashboard API  │
                    └──────┬───────────┬────────────┘
                      WS   │           │   WS
               ┌───────────┘           └───────────┐
               ▼                                   ▼
    ┌─────────────────────┐           ┌─────────────────────┐
    │   Bot Runner #1     │           │   Bot Runner #2     │
    │   (Terminal 1)      │           │   (Terminal 2)      │
    │                     │           │                     │
    │  MCP Server + Bot   │           │  MCP Server + Bot   │
    │  Cognitive Loop     │           │  Cognitive Loop     │
    │  Memory Stream      │           │  Memory Stream      │
    │  Personality: Surv. │           │  Personality: Arch. │
    │  LLM (Ollama/OC)    │           │  LLM (Ollama/OC)    │
    └─────────┬───────────┘           └─────────┬───────────┘
              │                                 │
              └──────────┐         ┌────────────┘
                         ▼         ▼
                  ┌─────────────────────┐
                  │  Minecraft Server   │
                  │  (Paper 1.21+)      │
                  └─────────────────────┘
```

### Cognitive Cycle

Each bot independently runs a cognitive loop:

```
┌─────────────── Cognitive Cycle ───────────────┐
│                                                │
│  [Observe]  8s poll → Memory Stream            │
│      ↓                                         │
│  [Think]    Fast (<3s) or Slow (3min) LLM call │
│      ↓          ↳ Reflex / Habit / Deliberation│
│  [Execute]  PlanExecutor runs steps via MCP    │
│      ↓                                         │
│  [Reflect]  Critic evaluates results           │
│      ↓                                         │
│  [Interrupt] death/low HP/chat → immediate     │
│                                                │
│  Three-tier reaction:                          │
│    Reflex  (<50ms)  JS handlers, no LLM       │
│    Habit   (<500ms) TF-IDF skill match         │
│    Deliberation (1-5s) Full LLM planning       │
└────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Minecraft Java Edition server (Paper 1.21+ recommended, `online-mode=false`)
- LLM backend: [Ollama](https://ollama.ai/) (recommended) or OpenClaw

### 1. Install

```bash
git clone https://github.com/Eamonnn101/MCBook.git
cd MCBook
npm install
```

### 2. Start Minecraft Server

Make sure your server is running on `localhost:25565`.

### 3. Run (Distributed Mode)

```bash
# Terminal 1: Start Coordinator (shared state hub)
npm run coordinator

# Terminal 2: Start Bot #1
npm run bot-runner -- --name Bot_1 --agent survivor --mc-name MCBook_Bot_1

# Terminal 3: Start Bot #2
npm run bot-runner -- --name Bot_2 --agent architect --mc-name MCBook_Bot_2

# Optional: Dashboard
npm run dashboard
```

Each bot will:
1. Connect to the Minecraft server and Coordinator
2. Observe the world every 8 seconds (zero token)
3. Think using fast/slow cognitive cycle
4. Execute plans step-by-step via MCP tools
5. Share events, trade, and collaborate through Coordinator

### 4. Single-Process Mode (Legacy)

```bash
# All bots in one process (v0.1 style)
npm run game-master

# Bridge to OpenClaw
npm run heartbeat-client
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_BOT_HOST` | `localhost` | Minecraft server address |
| `MC_BOT_PORT` | `25565` | Minecraft server port |
| `MC_BOT_USERNAME` | `MCBook_Bot_1` | Bot username |
| `MC_BOT_VERSION` | auto-detect | Minecraft version (e.g. `1.21.11`) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `minimax-m2.5:cloud` | Ollama model name |
| `OPENCLAW_API_URL` | — | OpenClaw HTTP API (fallback) |

### Bot Runner CLI

```bash
npx tsx scripts/bot-runner.ts \
  --name Bot_1 \            # Agent name (used in Coordinator)
  --agent survivor \         # Personality type
  --mc-name MCBook_Bot_1 \   # Minecraft username
  --coordinator ws://localhost:3849  # Coordinator WebSocket URL
```

### Coordinator CLI

```bash
npx tsx scripts/coordinator.ts \
  --ws-port 3849 \     # WebSocket port for Bot Runners
  --http-port 3848     # HTTP port for Dashboard/status
```

## Project Structure

```
mcbook/
├── src/
│   ├── bot/                    # Mineflayer bot management
│   │   ├── createBot.ts        # Bot creation & plugin loading
│   │   ├── localRules.ts       # Zero-token survival (auto-eat, auto-equip, reflexes)
│   │   ├── actionLock.ts       # Concurrency lock
│   │   ├── pathfinder.ts       # Navigation with anti-stuck & pillar-up
│   │   └── plugins.ts          # Mineflayer plugin loader
│   ├── mcp/                    # MCP server (17 tools)
│   │   ├── server.ts           # Tool registration & bot lifecycle
│   │   ├── events.ts           # Event system (health/chat/combat/time)
│   │   ├── tools/
│   │   │   ├── perception.ts   # Sensing tools (scan, blocks, health...)
│   │   │   ├── action.ts       # Action tools (move, mine, craft, follow...)
│   │   │   └── social.ts       # Social tools (chat, trade, team)
│   │   ├── chatLog.ts          # Chat message buffer
│   │   ├── stateSnapshot.ts    # Pre-death inventory capture
│   │   └── deathReflection.ts  # Post-mortem learning
│   ├── cognitive/              # Stanford Generative Agents system
│   │   ├── memoryStream.ts     # Timestamped observation accumulator
│   │   ├── planExecutor.ts     # Executes AI's JSON plans (with JSON repair)
│   │   ├── worldState.ts       # World state builder for prompts
│   │   ├── critic.ts           # Post-execution evaluation
│   │   └── habitTier.ts        # TF-IDF skill matching for fast reactions
│   ├── skills/                 # Skill library system
│   │   ├── skillLibrary.ts     # File-backed skill storage
│   │   ├── skillGenerator.ts   # Generate skills from successful plans
│   │   ├── skillRetrieval.ts   # TF-IDF skill retrieval
│   │   └── skillExecutor.ts    # Execute stored skills
│   ├── social/                 # Social systems
│   │   ├── socialMemory.ts     # Per-agent relationship memory
│   │   └── tradeEngine.ts      # Trade proposal/accept/reject
│   ├── multi/                  # Distributed coordination
│   │   ├── coordinatorServer.ts # WebSocket hub for shared state
│   │   ├── coordinatorClient.ts # Client API for Bot Runners
│   │   ├── agentRegistry.ts     # Agent registration & status
│   │   └── eventBus.ts          # Inter-agent event routing
│   ├── agents/
│   │   └── personalityProfile.ts # Personality loader
│   └── observer/
│       └── logWriter.ts        # JSON-L log output
├── scripts/
│   ├── coordinator.ts          # Coordinator entry point
│   ├── bot-runner.ts           # Single-bot cognitive loop
│   ├── game-master.ts          # Legacy multi-bot manager
│   ├── heartbeat-client.ts     # OpenClaw bridge
│   └── test-*.ts               # Test scripts
├── agents/                     # AI personality definitions
│   ├── survivor/SOUL.md        # Pragmatic survival personality
│   ├── architect/SOUL.md       # Builder personality
│   ├── predator/SOUL.md        # Combat personality
│   ├── hoarder/SOUL.md         # Resource collector
│   └── merchant/SOUL.md        # Trader personality
├── config/
│   └── game-master.json        # Legacy runtime config
├── dashboard/                  # Web UI (port 3847)
│   ├── server.js
│   └── index.html
├── skills/                     # Shared skill definitions
└── package.json
```

## MCP Tools

### Perception (read-only)

| Tool | Description |
|------|-------------|
| `get_status` | HP, hunger, position, inventory, time, isBusy |
| `get_scan` | Nearby players, mobs, ores, trees (directional) |
| `get_surrounding_blocks` | Block grid or relative directions |
| `get_time_of_day` | Day/night status |
| `get_pending_events` | Queued game events |
| `find_blocks` | Find specific blocks nearby |

### Action

| Tool | Args | Description |
|------|------|-------------|
| `move_to` | `{x, y, z}` | Pathfind to coordinates |
| `mine` | `{block_type}` or `{x,y,z}` | Dig/chop/mine blocks |
| `craft` | `{item_name, count?}` | Craft items |
| `chat` | `{message}` | Send chat message |
| `equip` | `{item_name}` | Hold item in hand |
| `attack` | `{target_name}` | Attack entity |
| `eat` | `{food_name?}` | Eat food (auto-select if empty) |
| `place` | `{block_name, x, y, z}` | Place block at position |
| `follow_player` | `{player_name, duration?, distance?}` | Follow a player (up to 120s) |
| `stop_follow` | `{}` | Stop following |

### Social (via Coordinator)

| Tool | Description |
|------|-------------|
| `send_chat` | Send targeted/broadcast message to agents |
| `query_agent_status` | Get another agent's status |
| `request_trade` | Propose item trade |
| `accept_trade` / `reject_trade` | Respond to trade |
| `form_team` | Create a team |
| `share_skill` | Share learned skill with another agent |
| `set_waypoint` | Mark a shared location |

## AI Plan Format

The AI outputs structured JSON plans:

```json
{
  "reflection": "Night is coming, need shelter. Player invited me to their base.",
  "plan": [
    { "tool": "chat", "args": { "message": "Thanks! I'll follow you." }, "note": "accept invite" },
    { "tool": "follow_player", "args": { "player_name": "eamon97", "duration": 60 }, "note": "follow to base" }
  ]
}
```

## Agent Personalities

Each bot has a unique personality defined in `agents/<type>/SOUL.md`:

| Type | Style | Priority |
|------|-------|----------|
| **survivor** | Pragmatic, cautious | Shelter > tools > resources |
| **architect** | Creative, planner | Build structures, design layouts |
| **predator** | Aggressive, hunter | Combat, mob farming, PvP |
| **hoarder** | Collector, organizer | Gather and stockpile resources |
| **merchant** | Social, trader | Trade items, negotiate deals |

## Tests

```bash
# Cognitive system unit tests (no Minecraft needed)
npm run test:cognitive

# MCP integration test (needs Minecraft)
MC_BOT_VERSION=1.21.11 npm run test:mcp

# Movement test
MC_BOT_VERSION=1.21.11 npm run test:move

# Mining test
MC_BOT_VERSION=1.21.11 npm run test:mine
```

## Dashboard

```bash
npm run dashboard
# Open http://localhost:3847
```

Shows real-time status of all connected agents: position, health, current action, inventory.

## Changelog

### v0.2.0 (2026-03-27)
- **Distributed architecture**: Coordinator + N Bot Runners (1 bot per terminal)
- **Multi-agent social system**: AgentRegistry, EventBus, TradeEngine, Teams, Waypoints
- **Three-tier reaction**: Reflex / Habit (TF-IDF) / Deliberation (LLM)
- **Skill library**: Auto-generate, store, retrieve, and share skills between agents
- **Social memory**: Per-agent relationship tracking
- **Critic system**: Post-execution evaluation and reflection
- **World state builder**: Rich context for LLM prompts
- **JSON repair**: Auto-fix truncated LLM output
- **follow_player / stop_follow**: New tools for player following
- **Improved pillar-up**: Reliable block placement during jumps
- **5 personality types**: survivor, architect, predator, hoarder, merchant
- **Embedded LLM**: Ollama → OpenClaw HTTP → OpenClaw CLI fallback chain

### v0.1.0
- Initial release: Stanford Generative Agents cognitive cycle
- MCP server with 15 tools
- Single-process Game Master + Heartbeat Client architecture
- Basic observation, planning, and execution

## License

MIT
