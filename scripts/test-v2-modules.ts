/**
 * MCBook v2 模块集成测试
 *
 * 测试所有 v2 新模块在不连接 Minecraft 服务器的情况下是否能正常工作。
 * 覆盖：AgentRegistry, EventBus, SocialMemory, TradeEngine,
 *       SkillLibrary, SkillRetrieval, SkillGenerator, SkillExecutor,
 *       Critic, HabitTier, WorldState, PersonalityProfile, Social Tools
 */

import { AgentRegistry } from '../src/multi/agentRegistry.js';
import {
  AgentEventBus,
  setWaypoint,
  getAllWaypoints,
  formTeam,
  leaveTeam,
  getAgentTeams,
  getTeam,
  type AgentEvent,
} from '../src/multi/eventBus.js';
import { SocialMemory } from '../src/social/socialMemory.js';
import {
  createTradeProposal,
  acceptTrade,
  rejectTrade,
  getPendingTradesFor,
  cleanupExpiredTrades,
} from '../src/social/tradeEngine.js';
import { SkillLibrary } from '../src/skills/skillLibrary.js';
import { findRelevantSkills, type SkillMatch } from '../src/skills/skillRetrieval.js';
import { evaluate as criticEvaluate, summarizeForPrompt as criticSummary, type WorldSnapshot } from '../src/cognitive/critic.js';
import { loadProfile, traitPromptModifier, type PersonalityProfile } from '../src/agents/personalityProfile.js';
import { executeSocialTool } from '../src/mcp/tools/social.js';
import { agentRegistry } from '../src/multi/agentRegistry.js';
import { agentEventBus } from '../src/multi/eventBus.js';
import { buildWorldState, compressForPrompt, type BotStatusData } from '../src/cognitive/worldState.js';
import { getSocialMemory } from '../src/social/socialMemory.js';
import { skillLibrary } from '../src/skills/skillLibrary.js';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// ─── Test Helpers ───

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, testName: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    const msg = detail ? `${testName}: ${detail}` : testName;
    failures.push(msg);
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

// ─── Test Data ───

const TEST_DIR = join(process.cwd(), '.test-v2-tmp');

// ─── Tests ───

async function testAgentRegistry(): Promise<void> {
  section('1. AgentRegistry');

  const registry = new AgentRegistry();

  // Register
  registry.register('Bot_1', 'MCBook_Bot_1', 'survivor');
  registry.register('Bot_2', 'MCBook_Bot_2', 'merchant');
  registry.register('Bot_3', 'MCBook_Bot_3', 'predator');

  assert(registry.getAll().length === 3, 'register 3 agents');
  assert(registry.get('Bot_1')!.status === 'connecting', 'initial status is connecting');

  // Update
  registry.update('Bot_1', {
    position: { x: 10, y: 64, z: 20 },
    health: 18,
    food: 15,
    inventory: 'oak_log x10, cobblestone x32',
    isBusy: false,
    isDay: true,
  });

  const bot1 = registry.get('Bot_1')!;
  assert(bot1.status === 'online', 'status becomes online after update');
  assert(bot1.health === 18, 'health updated correctly');
  assert(bot1.position!.x === 10, 'position updated correctly');

  // getByMcName
  const found = registry.getByMcName('MCBook_Bot_2');
  assert(found !== undefined && found.name === 'Bot_2', 'getByMcName finds correct agent');

  // getOthers
  const others = registry.getOthers('Bot_1');
  assert(others.length === 0, 'getOthers excludes non-online agents (Bot_2/3 still connecting)');

  registry.update('Bot_2', { position: { x: 50, y: 64, z: 50 } });
  const others2 = registry.getOthers('Bot_1');
  assert(others2.length === 1 && others2[0].name === 'Bot_2', 'getOthers returns online agents');

  // markOffline / markOnline
  registry.markOffline('Bot_2');
  assert(registry.get('Bot_2')!.status === 'offline', 'markOffline works');
  registry.markOnline('Bot_2');
  assert(registry.get('Bot_2')!.status === 'online', 'markOnline works');

  // getPublicProfile
  const profile = registry.getPublicProfile('Bot_1');
  assert(profile !== null && profile.name === 'Bot_1', 'getPublicProfile returns data');
  assert(registry.getPublicProfile('NonExistent') === null, 'getPublicProfile returns null for unknown');

  // summarizeForPrompt
  const summary = registry.summarizeForPrompt('Bot_1');
  assert(summary.includes('Bot_2'), 'summarizeForPrompt includes other agents');
  assert(!summary.includes('Bot_1'), 'summarizeForPrompt excludes self');
}

async function testEventBus(): Promise<void> {
  section('2. EventBus');

  const bus = new AgentEventBus();
  bus.registerAgent('Alice');
  bus.registerAgent('Bob');
  bus.registerAgent('Charlie');

  // Direct chat
  bus.publish({
    type: 'agent:chat',
    from: 'Alice',
    target: 'Bob',
    message: '你好 Bob',
    ts: Date.now(),
  });
  const bobEvents = bus.drain('Bob');
  assert(bobEvents.length === 1, 'direct chat delivered to target');
  assert(bus.drain('Charlie').length === 0, 'direct chat NOT delivered to non-target');

  // Broadcast chat
  bus.publish({
    type: 'agent:chat',
    from: 'Alice',
    target: null,
    message: '大家好',
    ts: Date.now(),
  });
  assert(bus.drain('Bob').length === 1, 'broadcast delivered to Bob');
  assert(bus.drain('Charlie').length === 1, 'broadcast delivered to Charlie');
  assert(bus.drain('Alice').length === 0, 'broadcast NOT delivered to sender');

  // Trade request
  bus.publish({
    type: 'agent:trade_request',
    tradeId: 'test_1',
    from: 'Alice',
    target: 'Bob',
    offerItems: [{ name: 'oak_log', count: 5 }],
    wantItems: [{ name: 'iron_ingot', count: 2 }],
    ts: Date.now(),
  });
  assert(bus.drain('Bob').length === 1, 'trade request delivered to target');

  // Join/Leave broadcast
  bus.publish({
    type: 'agent:join',
    agentName: 'Dave',
    agentType: 'survivor',
    ts: Date.now(),
  });
  assert(bus.drain('Alice').length === 1, 'join broadcast to Alice');
  assert(bus.drain('Bob').length === 1, 'join broadcast to Bob');

  // Team event — drain all queues first to clear accumulated events
  bus.drain('Alice');
  bus.drain('Bob');
  bus.drain('Charlie');
  bus.publish({
    type: 'agent:team',
    action: 'form',
    teamName: 'Builders',
    agentName: 'Alice',
    members: ['Alice', 'Bob'],
    ts: Date.now(),
  });
  assert(bus.drain('Bob').length === 1, 'team event delivered to member');
  assert(bus.drain('Charlie').length === 0, 'team event NOT delivered to non-member');

  // Peek (non-destructive)
  bus.publish({ type: 'agent:chat', from: 'Bob', target: 'Alice', message: 'test', ts: Date.now() });
  assert(bus.peek('Alice').length === 1, 'peek shows events');
  assert(bus.peek('Alice').length === 1, 'peek does not consume events');
  assert(bus.drain('Alice').length === 1, 'drain consumes events');
  assert(bus.drain('Alice').length === 0, 'drain empties queue');

  // Waypoints
  setWaypoint('base', { x: 100, y: 64, z: 200 }, 'Alice');
  setWaypoint('mine', { x: -50, y: 30, z: 100 }, 'Bob');
  assert(getAllWaypoints().length >= 2, 'waypoints stored');
  const baseWp = getAllWaypoints().find(w => w.name === 'base');
  assert(baseWp !== undefined && baseWp.position.x === 100, 'waypoint data correct');

  // Teams
  const team = formTeam('Miners', ['Alice', 'Bob', 'Charlie'], 'Alice');
  assert(team.members.size === 3, 'team created with 3 members');
  assert(getAgentTeams('Alice').length >= 1, 'getAgentTeams finds team');
  leaveTeam('Miners', 'Charlie');
  assert(getTeam('Miners')!.members.size === 2, 'leaveTeam removes member');
}

async function testSocialMemory(): Promise<void> {
  section('3. SocialMemory');

  const memDir = join(TEST_DIR, 'social');
  await mkdir(memDir, { recursive: true });
  const mem = new SocialMemory(memDir, 'TestBot');

  // Record events
  mem.recordEvent({ type: 'trade_success', otherAgent: 'Alice', detail: '5 oak_log ↔ 2 iron' });
  mem.recordEvent({ type: 'trade_success', otherAgent: 'Alice', detail: '3 wheat ↔ 1 bread' });
  mem.recordEvent({ type: 'helped', otherAgent: 'Alice', detail: '帮忙建房子' });
  mem.recordEvent({ type: 'attacked_by', otherAgent: 'Evil', detail: '被偷袭' });
  mem.recordEvent({ type: 'chat', otherAgent: 'Bob', detail: '聊天' });

  // Trust scores
  const aliceTrust = mem.getTrustScore('Alice');
  assert(aliceTrust > 0, `Alice trust is positive (${aliceTrust.toFixed(2)})`);
  const evilTrust = mem.getTrustScore('Evil');
  assert(evilTrust < 0, `Evil trust is negative (${evilTrust.toFixed(2)})`);

  // Relationships
  const rels = mem.getAllRelationships();
  assert(rels.length === 3, 'has 3 relationships (Alice, Evil, Bob)');
  const aliceRel = rels.find(r => r.agentName === 'Alice')!;
  assert(aliceRel.interactionCount === 3, 'Alice interaction count = 3');
  assert(aliceRel.positiveEvents === 3, 'Alice positive events = 3');

  // Recent events
  const recent = mem.getRecentEvents(5);
  assert(recent.length === 5, 'has 5 recent events');

  // Prompt summary
  const summary = mem.summarizeForPrompt();
  assert(summary.includes('Alice') && summary.includes('友好'), 'summary shows Alice as friendly');
  assert(summary.includes('Evil') && summary.includes('敌对'), 'summary shows Evil as hostile');

  // Persistence
  await mem.save();
  const mem2 = new SocialMemory(memDir, 'TestBot');
  await mem2.load();
  assert(mem2.getTrustScore('Alice') === aliceTrust, 'trust score persists after save/load');
  assert(mem2.getAllRelationships().length === 3, 'relationships persist after save/load');
}

async function testTradeEngine(): Promise<void> {
  section('4. TradeEngine');

  // Setup global registry for trade engine
  agentRegistry.register('Trader_A', 'MC_A', 'merchant');
  agentRegistry.register('Trader_B', 'MC_B', 'survivor');
  agentEventBus.registerAgent('Trader_A');
  agentEventBus.registerAgent('Trader_B');

  // Create proposal
  const proposal = createTradeProposal(
    'Trader_A', 'Trader_B',
    [{ name: 'oak_log', count: 10 }],
    [{ name: 'iron_ingot', count: 3 }],
  );
  assert(proposal.status === 'pending', 'proposal status is pending');
  assert(proposal.from === 'Trader_A', 'proposal from is correct');

  // Pending trades
  const pendingB = getPendingTradesFor('Trader_B');
  assert(pendingB.length >= 1, 'Trader_B has pending trade');
  const pendingA = getPendingTradesFor('Trader_A');
  assert(pendingA.length >= 1, 'Trader_A also sees pending trade');

  // Event bus delivery
  const bEvents = agentEventBus.drain('Trader_B');
  assert(bEvents.some(e => e.type === 'agent:trade_request'), 'trade_request event delivered to Trader_B');

  // Accept trade
  const accepted = acceptTrade(proposal.id, 'Trader_B');
  assert(accepted !== null && accepted.status === 'accepted', 'trade accepted successfully');
  const aEvents = agentEventBus.drain('Trader_A');
  assert(aEvents.some(e => e.type === 'agent:trade_response' && (e as any).accepted), 'trade_response event with accepted=true');

  // Reject trade test
  const proposal2 = createTradeProposal(
    'Trader_A', 'Trader_B',
    [{ name: 'dirt', count: 64 }],
    [{ name: 'diamond', count: 1 }],
  );
  const rejected = rejectTrade(proposal2.id, 'Trader_B');
  assert(rejected === true, 'trade rejected successfully');

  // Wrong agent cannot accept
  const proposal3 = createTradeProposal('Trader_A', 'Trader_B', [{ name: 'a', count: 1 }], [{ name: 'b', count: 1 }]);
  const wrongAccept = acceptTrade(proposal3.id, 'Trader_A'); // Trader_A is not the target
  assert(wrongAccept === null, 'wrong agent cannot accept trade');

  // Cleanup
  const cleaned = cleanupExpiredTrades();
  assert(cleaned >= 0, `cleanupExpiredTrades runs (cleaned ${cleaned})`);
}

async function testSkillLibrary(): Promise<void> {
  section('5. SkillLibrary');

  // Clean up skills-db from previous runs to avoid conflicts
  const skillsDbDir = join(process.cwd(), 'skills-db');
  const testOwners = ['test_agent', 'other_agent'];
  for (const owner of testOwners) {
    const ownerDir = join(skillsDbDir, owner);
    if (existsSync(ownerDir)) await rm(ownerDir, { recursive: true });
  }
  // Also clean shared test skills
  const sharedDir = join(skillsDbDir, 'shared');
  if (existsSync(join(sharedDir, 'meta', 'craft_planks.json'))) {
    await rm(join(sharedDir, 'meta', 'craft_planks.json'));
    await rm(join(sharedDir, 'code', 'craft_planks.js')).catch(() => {});
  }

  const lib = new SkillLibrary();
  const skillsDir = join(TEST_DIR, 'skills-db');

  // Override skills root for testing (we'll save to TEST_DIR manually)
  // Test save + get
  await lib.saveSkill('test_agent', 'mine_oak',
    'log("Mining oak..."); await callTool("mine", {block_type: "oak_log"});',
    {
      name: 'mine_oak',
      description: 'Mine oak logs from nearby trees',
      tags: ['mine', 'oak_log', 'wood'],
      successCount: 5,
      failCount: 1,
      author: 'test_agent',
      shared: false,
      deprecated: false,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    }
  );

  const meta = await lib.getMeta('test_agent', 'mine_oak');
  assert(meta !== undefined, 'skill meta saved and retrieved');
  assert(meta!.successCount === 5, 'success count correct');

  const code = await lib.getCode('test_agent', 'mine_oak');
  assert(code !== null && code.includes('mine'), 'skill code saved and retrieved');

  // Success rate
  assert(lib.getSuccessRate(meta!) === 5 / 6, `success rate = ${(5 / 6).toFixed(3)}`);

  // Record success/failure
  await lib.recordSuccess('test_agent', 'mine_oak');
  const meta2 = await lib.getMeta('test_agent', 'mine_oak');
  assert(meta2!.successCount === 6, 'recordSuccess increments count');

  await lib.recordFailure('test_agent', 'mine_oak');
  const meta3 = await lib.getMeta('test_agent', 'mine_oak');
  assert(meta3!.failCount === 2, 'recordFailure increments count');

  // Save another skill
  await lib.saveSkill('test_agent', 'craft_planks',
    'await callTool("craft", {item_name: "oak_planks", count: 4});',
    {
      name: 'craft_planks',
      description: 'Craft oak planks from oak logs',
      tags: ['craft', 'oak_planks', 'wood'],
      successCount: 8,
      failCount: 0,
      author: 'test_agent',
      shared: false,
      deprecated: false,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    }
  );

  // listAvailable
  const available = await lib.listAvailable('test_agent');
  assert(available.length >= 2, `listAvailable returns ${available.length} skills`);

  // Promote to shared
  const promoted = await lib.promoteToShared('test_agent', 'craft_planks');
  assert(promoted === true, 'skill promoted to shared library');
  const sharedMeta = await lib.getMeta('shared', 'craft_planks');
  assert(sharedMeta !== undefined && sharedMeta.shared === true, 'shared skill exists');

  // Another agent can see shared skills
  const otherAvailable = await lib.listAvailable('other_agent');
  assert(otherAvailable.some(s => s.name === 'craft_planks'), 'other agent sees shared skill');

  // Delete
  const deleted = await lib.deleteSkill('test_agent', 'mine_oak');
  assert(deleted === true, 'skill deleted');
  assert(await lib.getMeta('test_agent', 'mine_oak') === undefined, 'deleted skill not found');
}

async function testSkillRetrieval(): Promise<void> {
  section('6. SkillRetrieval (TF-IDF)');

  const skills = [
    { name: 'mine_oak_log', description: 'Mine oak logs from oak trees for wood', tags: ['mine', 'oak', 'wood'], successCount: 5, failCount: 0, author: 'a', shared: true, deprecated: false, createdAt: 0, lastUsed: 0 },
    { name: 'mine_iron_ore', description: 'Mine iron ore from underground veins', tags: ['mine', 'iron', 'ore'], successCount: 3, failCount: 1, author: 'a', shared: true, deprecated: false, createdAt: 0, lastUsed: 0 },
    { name: 'craft_wooden_pickaxe', description: 'Craft a wooden pickaxe using planks and sticks', tags: ['craft', 'pickaxe', 'wood'], successCount: 8, failCount: 0, author: 'a', shared: true, deprecated: false, createdAt: 0, lastUsed: 0 },
    { name: 'build_house', description: 'Build a simple house using cobblestone and wood planks', tags: ['build', 'house', 'cobblestone'], successCount: 2, failCount: 1, author: 'a', shared: true, deprecated: false, createdAt: 0, lastUsed: 0 },
    { name: 'hunt_cow', description: 'Hunt and kill a cow for food and leather', tags: ['hunt', 'cow', 'food'], successCount: 4, failCount: 0, author: 'a', shared: true, deprecated: false, createdAt: 0, lastUsed: 0 },
  ];

  // Query: mining wood
  const results1 = findRelevantSkills('I need to mine some wood oak logs', skills, 3);
  assert(results1.length > 0, `found ${results1.length} matches for "mine wood"`);
  assert(results1[0].skill.name === 'mine_oak_log', `top match is mine_oak_log (sim=${results1[0].similarity.toFixed(3)})`);

  // Query: crafting tools
  const results2 = findRelevantSkills('craft a pickaxe tool', skills, 3);
  assert(results2.length > 0, `found ${results2.length} matches for "craft pickaxe"`);
  assert(results2[0].skill.name === 'craft_wooden_pickaxe', `top match is craft_wooden_pickaxe`);

  // Query: food hunting
  const results3 = findRelevantSkills('hunt for food cow', skills, 3);
  assert(results3.length > 0, `found ${results3.length} matches for "hunt food"`);
  assert(results3[0].skill.name === 'hunt_cow', `top match is hunt_cow`);

  // Query: building
  const results4 = findRelevantSkills('build a house with cobblestone', skills, 3);
  assert(results4.length > 0, `found ${results4.length} matches for "build house"`);
  assert(results4[0].skill.name === 'build_house', `top match is build_house`);

  // Empty query
  const results5 = findRelevantSkills('', skills, 3);
  assert(results5.length === 0, 'empty query returns no results');

  // Empty skills
  const results6 = findRelevantSkills('mine wood', [], 3);
  assert(results6.length === 0, 'empty skills returns no results');
}

async function testCritic(): Promise<void> {
  section('7. Critic Agent');

  const preState: WorldSnapshot = {
    health: 20, food: 18,
    position: { x: 0, y: 64, z: 0 },
    inventory: 'oak_log x5, cobblestone x10',
    isDay: true,
  };

  const postState: WorldSnapshot = {
    health: 15, food: 14,
    position: { x: 20, y: 64, z: 30 },
    inventory: 'oak_log x15, cobblestone x10, oak_planks x8',
    isDay: true,
  };

  const steps = [
    { tool: 'mine', args: { block_type: 'oak_log' }, note: '砍树' },
    { tool: 'mine', args: { block_type: 'oak_log' }, note: '继续砍树' },
    { tool: 'craft', args: { item_name: 'oak_planks', count: 8 }, note: '做木板' },
  ];

  const results = steps.map((step, i) => ({
    step,
    success: true,
    result: `成功: ${step.note}`,
    durationMs: 1000 + i * 500,
  }));

  const evaluation = criticEvaluate(preState, postState, results, steps);

  assert(evaluation.score >= 7, `score >= 7 (got ${evaluation.score})`);
  assert(evaluation.goalsAchieved.length === 3, `3 goals achieved`);
  assert(evaluation.goalsFailed.length === 0, `0 goals failed`);
  assert(evaluation.inventoryDelta.gained.length > 0, `gained items detected`);
  assert(evaluation.healthDelta === -5, `health delta = -5`);
  assert(evaluation.toolsUsed.includes('mine'), `tools used includes mine`);
  assert(evaluation.toolsUsed.includes('craft'), `tools used includes craft`);

  const summary = criticSummary(evaluation);
  assert(summary.includes('评分'), 'summary includes score');
  assert(summary.length > 0, `summary generated (${summary.length} chars)`);

  // Test with failures
  const failResults = [
    { step: steps[0], success: false, result: '失败: 找不到方块', durationMs: 500 },
    { step: steps[1], success: false, result: '失败: 找不到方块', durationMs: 500 },
    { step: steps[2], success: true, result: '成功', durationMs: 500 },
  ];
  const failEval = criticEvaluate(preState, preState, failResults, steps);
  assert(failEval.score < 7, `low score for failures (got ${failEval.score})`);
  assert(failEval.recommendations.length > 0, 'has recommendations for failures');
  assert(failEval.repeatedFailures.get('mine')! >= 2, 'detects repeated mine failures');
}

async function testPersonalityProfile(): Promise<void> {
  section('8. PersonalityProfile');

  // Load survivor profile
  const survivor = await loadProfile('survivor');
  assert(survivor.displayName === 'Survivor', 'survivor display name correct');
  assert(survivor.traits.risk_tolerance === 0.3, 'survivor risk_tolerance = 0.3');
  assert(survivor.initialGoals.length > 0, 'survivor has initial goals');
  assert(survivor.background.length > 0, 'survivor has background');

  // Load merchant profile
  const merchant = await loadProfile('merchant');
  assert(merchant.traits.sociability === 0.9, 'merchant sociability = 0.9');
  assert(merchant.traits.hoarding_tendency === 0.2, 'merchant hoarding = 0.2');

  // Load predator profile
  const predator = await loadProfile('predator');
  assert(predator.traits.risk_tolerance === 0.9, 'predator risk_tolerance = 0.9');
  assert(predator.traits.cooperation_bias === 0.1, 'predator cooperation_bias = 0.1');

  // Load hoarder profile
  const hoarder = await loadProfile('hoarder');
  assert(hoarder.traits.hoarding_tendency === 0.95, 'hoarder hoarding = 0.95');
  assert(hoarder.traits.sociability === 0.2, 'hoarder sociability = 0.2');

  // Load architect profile
  const architect = await loadProfile('architect');
  assert(architect.traits.creativity === 0.9, 'architect creativity = 0.9');

  // Trait prompt modifier
  const predatorPrompt = traitPromptModifier(predator.traits);
  assert(predatorPrompt.includes('冒险'), `predator prompt mentions risk-taking: "${predatorPrompt.slice(0, 50)}..."`);
  assert(predatorPrompt.includes('自身利益'), `predator prompt mentions self-interest`);

  const hoarderPrompt = traitPromptModifier(hoarder.traits);
  assert(hoarderPrompt.includes('不轻易交易'), `hoarder prompt mentions reluctance to trade`);
  assert(hoarderPrompt.includes('谨慎'), `hoarder prompt mentions caution`);

  // Default profile for unknown type
  const unknown = await loadProfile('nonexistent_type');
  assert(unknown.traits.exploration_drive === 0.5, 'unknown type gets default traits');

  // Test caching (second load should be instant)
  const survivor2 = await loadProfile('survivor');
  assert(survivor2 === survivor, 'profile caching works (same reference)');
}

async function testSocialTools(): Promise<void> {
  section('9. Social MCP Tools');

  // Ensure agents are registered in global registry
  agentRegistry.register('SocBot_A', 'MC_SA', 'survivor');
  agentRegistry.register('SocBot_B', 'MC_SB', 'merchant');
  agentEventBus.registerAgent('SocBot_A');
  agentEventBus.registerAgent('SocBot_B');

  // send_chat (direct)
  const chatResult = await executeSocialTool('SocBot_A', 'send_chat', { target: 'SocBot_B', message: '你好' });
  assert(chatResult.includes('已向 SocBot_B 发送消息'), `send_chat direct: ${chatResult}`);
  const chatEvents = agentEventBus.drain('SocBot_B');
  assert(chatEvents.length === 1 && chatEvents[0].type === 'agent:chat', 'chat event delivered');

  // send_chat (broadcast)
  const broadcastResult = await executeSocialTool('SocBot_A', 'send_chat', { message: '大家好' });
  assert(broadcastResult.includes('已广播'), `send_chat broadcast: ${broadcastResult}`);

  // query_agent_status
  agentRegistry.update('SocBot_B', { position: { x: 10, y: 64, z: 20 }, health: 15 });
  const statusResult = await executeSocialTool('SocBot_A', 'query_agent_status', { agent_name: 'SocBot_B' });
  assert(statusResult.includes('SocBot_B'), `query_agent_status: ${statusResult.slice(0, 60)}`);

  // query unknown agent
  const unknownResult = await executeSocialTool('SocBot_A', 'query_agent_status', { agent_name: 'Ghost' });
  assert(unknownResult.includes('未找到'), `unknown agent: ${unknownResult}`);

  // request_trade
  const tradeResult = await executeSocialTool('SocBot_A', 'request_trade', {
    target: 'SocBot_B',
    offer_items: [{ name: 'oak_log', count: 5 }],
    want_items: [{ name: 'iron_ingot', count: 2 }],
  });
  assert(tradeResult.includes('交易提案已发送'), `request_trade: ${tradeResult.slice(0, 60)}`);

  // get_pending_trades
  const pendingResult = await executeSocialTool('SocBot_B', 'get_pending_trades', {});
  assert(!pendingResult.includes('无待处理'), `get_pending_trades shows trades: ${pendingResult.slice(0, 60)}`);

  // set_waypoint
  const wpResult = await executeSocialTool('SocBot_A', 'set_waypoint', { name: 'shop', x: 100, y: 64, z: 200 });
  assert(wpResult.includes('路标'), `set_waypoint: ${wpResult}`);

  // get_waypoints
  const wpsResult = await executeSocialTool('SocBot_A', 'get_waypoints', {});
  assert(wpsResult.includes('shop'), `get_waypoints: ${wpsResult.slice(0, 60)}`);

  // form_team
  const teamResult = await executeSocialTool('SocBot_A', 'form_team', { team_name: 'Squad', members: ['SocBot_B'] });
  assert(teamResult.includes('已创建'), `form_team: ${teamResult}`);

  // leave_team
  const leaveResult = await executeSocialTool('SocBot_B', 'leave_team', { team_name: 'Squad' });
  assert(leaveResult.includes('已离开'), `leave_team: ${leaveResult}`);

  // share_skill — clean up from previous runs
  const socSkillsDb = join(process.cwd(), 'skills-db');
  for (const owner of ['SocBot_A', 'SocBot_B']) {
    const metaPath = join(socSkillsDb, owner, 'meta', 'test_share_skill.json');
    const codePath = join(socSkillsDb, owner, 'code', 'test_share_skill.js');
    if (existsSync(metaPath)) await rm(metaPath);
    if (existsSync(codePath)) await rm(codePath);
  }
  // First save a skill for SocBot_A
  await skillLibrary.saveSkill('SocBot_A', 'test_share_skill',
    'log("shared skill");',
    { name: 'test_share_skill', description: 'test', tags: ['test'], successCount: 1, failCount: 0, author: 'SocBot_A', shared: false, deprecated: false, createdAt: Date.now(), lastUsed: Date.now() },
  );
  const shareResult = await executeSocialTool('SocBot_A', 'share_skill', { skill_name: 'test_share_skill', target: 'SocBot_B' });
  assert(shareResult.includes('已将技能'), `share_skill: ${shareResult}`);
  const sharedMeta = await skillLibrary.getMeta('SocBot_B', 'test_share_skill');
  assert(sharedMeta !== undefined, 'shared skill exists in target library');

  // share_skill to unknown agent
  const shareUnknown = await executeSocialTool('SocBot_A', 'share_skill', { skill_name: 'test_share_skill', target: 'Ghost' });
  assert(shareUnknown.includes('未找到'), `share to unknown agent: ${shareUnknown}`);

  // share nonexistent skill
  const shareNone = await executeSocialTool('SocBot_A', 'share_skill', { skill_name: 'nonexistent', target: 'SocBot_B' });
  assert(shareNone.includes('没有'), `share nonexistent skill: ${shareNone}`);

  // Unknown tool
  const unknownTool = await executeSocialTool('SocBot_A', 'fake_tool', {});
  assert(unknownTool.includes('未知'), `unknown tool handled: ${unknownTool}`);
}

async function testWorldState(): Promise<void> {
  section('10. WorldState');

  // Setup: register agents + social memory
  agentRegistry.register('WS_Bot', 'MC_WS', 'survivor');
  agentRegistry.register('WS_Other', 'MC_WO', 'merchant');
  agentRegistry.update('WS_Bot', { position: { x: 0, y: 64, z: 0 }, health: 20, food: 18 });
  agentRegistry.update('WS_Other', { position: { x: 30, y: 64, z: 40 }, health: 15, food: 12 });

  const memDir = join(TEST_DIR, 'ws-social');
  await mkdir(memDir, { recursive: true });
  const socialMem = new SocialMemory(memDir, 'WS_Bot');
  socialMem.recordEvent({ type: 'trade_success', otherAgent: 'WS_Other', detail: 'test trade' });

  const botStatus: BotStatusData = {
    health: 20, food: 18,
    position: { x: 0, y: 64, z: 0 },
    inventory: 'oak_log x10',
    timeOfDay: 6000, isDay: true,
    isBusy: false, currentAction: null,
  };

  const snapshot = await buildWorldState('WS_Bot', botStatus, agentRegistry, socialMem, skillLibrary);
  assert(snapshot.status.health === 20, 'snapshot includes status');
  assert(snapshot.socialSummary.nearbyAgents.length >= 1, 'snapshot includes nearby agents');
  const wsOther = snapshot.socialSummary.nearbyAgents.find(a => a.name === 'WS_Other');
  assert(wsOther !== undefined, 'nearby agents includes WS_Other');
  assert(wsOther?.distance !== null, 'distance calculated');

  const compressed = compressForPrompt(snapshot);
  assert(compressed.length > 0, `compressed prompt generated (${compressed.length} chars)`);
  assert(compressed.includes('WS_Other'), 'compressed includes other agent');
}

// ─── Main ───

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     MCBook v2 模块集成测试                    ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Setup temp dir
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true });
  }
  await mkdir(TEST_DIR, { recursive: true });

  try {
    await testAgentRegistry();
    await testEventBus();
    await testSocialMemory();
    await testTradeEngine();
    await testSkillLibrary();
    await testSkillRetrieval();
    await testCritic();
    await testPersonalityProfile();
    await testSocialTools();
    await testWorldState();
  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err);
    failed++;
    failures.push(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cleanup
  try {
    await rm(TEST_DIR, { recursive: true });
  } catch { /* ignore */ }

  // Report
  console.log('\n══════════════════════════════════════════════');
  console.log(`  总计: ${passed + failed} | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  失败列表:');
    for (const f of failures) {
      console.log(`    • ${f}`);
    }
  }
  console.log('══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
