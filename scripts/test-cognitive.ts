/**
 * 认知系统单元测试 - 不依赖 Minecraft 服务器
 */
import { MemoryStream } from '../src/cognitive/memoryStream.js';
import { PlanExecutor } from '../src/cognitive/planExecutor.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failed++;
  }
}

// ─── MemoryStream 测试 ───
console.log('\n=== MemoryStream 测试 ===');

{
  const ms = new MemoryStream();

  // 基础添加
  ms.add({ category: 'health_change', importance: 3, content: '血量 20/20 饥饿 18/20' });
  ms.add({ category: 'combat', importance: 9, content: '受伤: 血量 20 → 15' });
  ms.add({ category: 'chat', importance: 7, content: '[eamon97] 你好' });
  ms.add({ category: 'environment', importance: 2, content: '天黑了' });
  ms.add({ category: 'death', importance: 10, content: '你死亡了' });

  assert(ms.stats.total === 5, '添加 5 条观察');
  assert(ms.stats.sinceLastThink === 5, '自上次思考以来 5 条');
  assert(ms.stats.maxImportance === 10, '最高重要性 = 10');
  assert(ms.hasUrgent(), '有紧急事件');

  // 摘要输出
  const summary = ms.summarizeForPrompt();
  console.log('\n  --- 摘要输出 ---');
  console.log(summary.split('\n').map(l => `  ${l}`).join('\n'));

  assert(summary.includes('你死亡了'), '摘要包含死亡');
  assert(summary.includes('伤害'), '摘要包含战斗');
  assert(summary.includes('eamon97'), '摘要包含聊天');
  assert(summary.includes('环境变化'), '摘要包含环境变化');

  // markThinkDone
  ms.markThinkDone();
  assert(ms.stats.sinceLastThink === 0, 'markThinkDone 后 sinceLastThink = 0');
  assert(!ms.hasUrgent(), 'markThinkDone 后无紧急事件');

  // compact
  for (let i = 0; i < 100; i++) {
    ms.add({ category: 'environment', importance: 1, content: `观察 ${i}` });
  }
  ms.compact(20);
  assert(ms.stats.total === 20, 'compact 保留 20 条');
}

// ─── MemoryStream 合并测试 ───
console.log('\n=== MemoryStream 合并输出测试 ===');

{
  const ms = new MemoryStream();

  // 模拟 3 分钟内的事件
  for (let i = 0; i < 5; i++) {
    ms.add({ category: 'health_change', importance: 3, content: `血量 ${20 - i}/20` });
  }
  ms.add({ category: 'combat', importance: 9, content: '受伤: 血量 20 → 18' });
  ms.add({ category: 'combat', importance: 9, content: '受伤: 血量 18 → 15' });
  ms.add({ category: 'environment', importance: 2, content: '环境扫描变化A' });
  ms.add({ category: 'environment', importance: 2, content: '环境扫描变化B' });
  ms.add({ category: 'environment', importance: 2, content: '环境扫描变化C' });

  const summary = ms.summarizeForPrompt();
  console.log(summary.split('\n').map(l => `  ${l}`).join('\n'));

  // 状态变化应该只保留最新一条
  const healthLines = summary.split('\n').filter(l => l.includes('状态变化'));
  assert(healthLines.length === 1, '多次 health_change 合并为 1 条');

  // 战斗受伤应该合并
  assert(summary.includes('2 次伤害'), '多次受伤合并为数字');
}

// ─── PlanExecutor 测试 ───
console.log('\n=== PlanExecutor 测试 ===');

{
  const pe = new PlanExecutor();

  // 测试 JSON 解析 - 对象格式
  const planJson = JSON.stringify({
    reflection: '四周很安全，应该继续采集石头',
    plan: [
      { tool: 'move_to', args: { x: 100, y: 64, z: 200 }, note: '去矿洞' },
      { tool: 'mine', args: { block_type: 'stone' }, note: '挖石头' },
      { tool: 'chat', args: { message: '有人想交易吗？' }, note: '找交易' },
    ],
  });

  assert(pe.loadPlan(planJson), '解析 JSON 计划成功');
  assert(pe.progress === '0/3', '进度 0/3');
  assert(pe.lastReflection === '四周很安全，应该继续采集石头', '反思内容正确');
  assert(pe.status === 'idle', '状态 idle');
}

{
  const pe = new PlanExecutor();

  // 测试 markdown 代码块格式
  const mdPlan = `
\`\`\`json
{
  "reflection": "需要石头",
  "plan": [
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "挖石头" }
  ]
}
\`\`\`
  `;

  assert(pe.loadPlan(mdPlan), '解析 markdown JSON 成功');
  assert(pe.progress === '0/1', '进度 0/1');
}

{
  const pe = new PlanExecutor();

  // 测试纯数组格式
  const arrayPlan = JSON.stringify([
    { tool: 'move_to', args: { x: 50, y: 70, z: 50 } },
    { tool: 'mine', args: { block_type: 'oak_log' } },
  ]);

  assert(pe.loadPlan(arrayPlan), '解析数组格式成功');
  assert(pe.progress === '0/2', '进度 0/2');
}

{
  const pe = new PlanExecutor();

  // 测试非法工具过滤
  const badPlan = JSON.stringify({
    plan: [
      { tool: 'mine', args: { block_type: 'stone' } },
      { tool: 'rm -rf /', args: {} },  // 非法
      { tool: 'eval', args: { code: 'process.exit()' } },  // 非法
      { tool: 'chat', args: { message: 'hi' } },
    ],
  });

  assert(pe.loadPlan(badPlan), '带非法工具的计划可解析');
  assert(pe.progress === '0/2', '过滤掉非法工具后只剩 2 步');
}

{
  const pe = new PlanExecutor();
  pe.loadPlan(JSON.stringify({ plan: [
    { tool: 'mine', args: { block_type: 'stone' }, note: '挖石头' },
    { tool: 'chat', args: { message: 'done' }, note: '完成' },
  ]}));

  // 测试中断
  pe.interrupt('紧急：受到攻击');
  assert(pe.status === 'interrupted', '中断状态正确');

  // 测试执行摘要
  const summary = pe.getExecutionSummary();
  assert(summary.includes('上周期无执行计划'), '中断时无执行记录');
}

{
  const pe = new PlanExecutor();

  // 测试无效 JSON
  assert(!pe.loadPlan('这不是JSON'), '无效 JSON 返回 false');
  assert(!pe.loadPlan(''), '空字符串返回 false');
}

// ─── 结果 ───
console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
console.log('所有测试通过!');
