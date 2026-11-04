/**
 * selftest.mjs —— 核心解析/补丁逻辑的机器校验。不依赖任何第三方库。
 * 跑法：node scripts/selftest.mjs
 * 约定：任何 FAIL 都以退出码 1 结束，便于 CI 卡住回归。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parse, toggleTask, addTask, removeTask, updateTask,
  buildTaskLine, deriveId, isOverdue, stats,
} from '../src/core/md.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * 固定夹具：自检必须与 todo.md 的真实内容解耦。
 * 曾经直接读 todo.md 当夹具，结果「往待办里加两条」就让 stats 断言全红——
 * 测试应当只对语法与补丁行为负责，不对用户数据负责。
 */
const SAMPLE = [
  '# Leo 的待办',
  '',
  '> 数据源说明：本文件既是人读的清单，也是这个 Todo 页面的数据库。',
  '> 页面按行解析，**只改动你操作的那一行**，其余内容原样保留。',
  '> 团队协作 / 手机快速记录时，直接在 GitHub 网页或 App 里编辑这个文件即可。',
  '',
  '## 工作',
  '',
  '- [ ] 写 Q4 OKR 初稿并同步给组内 #工作 @due(2026-11-06) !p1 <!--id:i0a1b2c-->',
  '- [ ] 修复 bill-service 空指针（工单 #8821） #工作 !p2 <!--id:i3d4e5f-->',
  '- [x] 拆分 SKILL.md 类型 6/7 的 SQL 规则 #工作 <!--id:i6a7b8c @done(2026-11-02)-->',
  '- [ ] 评审 RepoCensus v1.8 的 PRD 变更 #开源 #评审 @due(2026-11-10) !p2 <!--id:i9d0e1f-->',
  '',
  '## 生活',
  '',
  '- [ ] 修空调（卧室那台，制冷慢） #家事 @due(2026-11-05) <!--id:i2a3b4c-->',
  '- [ ] 带娃去体检 #家事 #孩子 @due(2026-11-15) <!--id:i5d6e7f-->',
  '- [x] 买奶粉 + 淡奶油（做奶糕用） #家事 <!--id:i8a9b0c @done(2026-11-01)-->',
  '',
  '## 学习',
  '',
  '- [ ] 看完《Designing Data-Intensive Applications》第 6 章 #读书',
  '- [ ] 给 dashboard 加一个周报视图 #开源',
  '',
  '```markdown',
  '<!-- 这里的 - [ ] 不会出现在页面里，代码块内容被解析器跳过 -->',
  '- [ ] 这行是示例，不是任务',
  '```',
  '',
].join('\n');

/** 真实数据源：只校验「能解析且往返不丢字节」，不写死任何数量 */
const LIVE = readFileSync(resolve(__dir, '../todo.md'), 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ' :: ' + extra : ''}`);
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

/** 逐行 diff 统计（同长度场景足够精确） */
function diffLines(a, b) {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  if (la.length !== lb.length) return { lengthChanged: true, changed: Math.abs(la.length - lb.length) };
  let n = 0;
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) n++;
  return { lengthChanged: false, changed: n };
}

/* ---------------------------------------------------------- 1. 解析正确 */

const doc = parse(SAMPLE);
eq('解析：任务总数', doc.tasks.length, 9);
eq('解析：分组数（首个 h1 是文档标题，不计入分组）', doc.groups.filter((g) => g.role === 'group').length, 3);
eq('解析：h1 标记为 title', doc.groups[0].role, 'title');
eq('解析：代码围栏内的假任务被跳过', doc.tasks.filter((t) => t.title.includes('示例')).length, 0);
eq('解析：工单里的 #8821 不被当作标签',
  doc.tasks.find((t) => t.id === 'i3d4e5f').title, '修复 bill-service 空指针（工单 #8821）');
eq('解析：该行只有一个标签',
  doc.tasks.find((t) => t.id === 'i3d4e5f').tags.join(','), '工作');

const first = doc.tasks[0];
eq('解析：标题干净（标签/截止/优先级已剥离）', first.title, '写 Q4 OKR 初稿并同步给组内');
eq('解析：标签', first.tags.join(','), '工作');
eq('解析：截止日期', first.due, '2026-11-06');
eq('解析：优先级', first.priority, 1);
eq('解析：id 来自注释', first.id, 'i0a1b2c');
eq('解析：未完成的 checked', first.checked, false);
eq('解析：所属分组', first.group, '工作');

const doneTask = doc.tasks.find((t) => t.id === 'i6a7b8c');
eq('解析：已完成状态', doneTask.checked, true);
eq('解析：完成日期', doneTask.doneAt, '2026-11-02');

const noId = doc.tasks.find((t) => t.title.includes('Designing Data'));
ok('解析：无 id 的任务标记为 ephemeral', noId.ephemeral === true);
eq('解析：ephemeral id 是确定性派生', noId.id, deriveId('学习', '看完《Designing Data-Intensive Applications》第 6 章'));

/* ------------------------------------------------- 2. round-trip 零损耗 */

eq('round-trip：解析后重写与原文字节完全一致',
  (doc.bom ? '\uFEFF' : '') + doc.lines.join(doc.eol), SAMPLE);

const crlf = SAMPLE.replace(/\r?\n/g, '\r\n');
const crlfDoc = parse(crlf);
ok('CRLF：行尾被识别', crlfDoc.eol === '\r\n');
eq('CRLF：round-trip 保留 CRLF', crlfDoc.lines.join(crlfDoc.eol), crlf.replace(/^\uFEFF/, ''));

const bomDoc = parse('\uFEFF# A\n\n- [ ] x\n');
ok('BOM：被识别并保留', bomDoc.bom === true);
eq('BOM：round-trip 保留', '\uFEFF' + bomDoc.lines.join(bomDoc.eol), '\uFEFF# A\n\n- [ ] x\n');

/* ---------------------------------------------------- 3. 勾选只改一行 */

const t1 = toggleTask(SAMPLE, 'i3d4e5f', true);
ok('toggle：返回 changed', t1.changed === true);
const d1 = diffLines(SAMPLE, t1.src);
eq('toggle：行数不变', d1.lengthChanged, false);
eq('toggle：只有 1 行发生变化', d1.changed, 1);
ok('toggle：目标行已勾选',
  t1.src.split(/\r?\n/).some((l) => l.includes('- [x] 修复 bill-service 空指针')));
ok('toggle：id 注释仍在', t1.src.includes('id:i3d4e5f'));

const t2 = toggleTask(SAMPLE, 'i0a1b2c', false);
eq('toggle 幂等：已是未完成再取消不产生改动', t2.changed, false);
eq('toggle 幂等：内容不变', t2.src, SAMPLE);

const t3 = toggleTask(SAMPLE, 'nope', true);
ok('toggle：未知 id 不崩且不改内容', t3.changed === false && t3.src === SAMPLE && t3.error === 'task-not-found');

/* ------------------------- 4. ephemeral 行被改动时才固化 id（最小 diff） */

const t4 = toggleTask(SAMPLE, noId.id, true);
const d4 = diffLines(SAMPLE, t4.src);
eq('ephemeral：勾选也只改 1 行', d4.changed, 1);
ok('ephemeral：被改行补上了真实 id 注释', /<!--id:i[0-9a-z]{7}-->/.test(t4.src.split(/\r?\n/).find((l) => l.includes('Data-Intensive'))));

/* -------------------------------------------------------- 5. 增删改查 */

const added = addTask(SAMPLE, { group: '工作', title: '准备周会材料', tags: ['工作'], due: '2026-11-07', priority: 2 });
ok('add：成功', added.changed === true);
const addedDoc = parse(added.src);
eq('add：任务数 +1', addedDoc.tasks.length, doc.tasks.length + 1);
const workTasks = addedDoc.tasks.filter((t) => t.group === '工作');
eq('add：插在同组末尾', workTasks[workTasks.length - 1].title, '准备周会材料');
const aLines = added.src.split(/\r?\n/);
const okIdx = aLines.findIndex((l) => l.includes('准备周会材料'));
ok('add：位置紧跟在「评审 RepoCensus」之后',
  aLines[okIdx - 1].includes('评审 RepoCensus'));
eq('add：新行格式', aLines[okIdx].startsWith('- [ ] 准备周会材料 #工作 @due(2026-11-07) !p2 <!--id:i'), true);

const newGroup = addTask(SAMPLE, { group: '备忘', title: '记一下 DNS 的新配置' });
const ngDoc = parse(newGroup.src);
ok('add：新分组标题被创建', ngDoc.groups.some((g) => g.title === '备忘'));
eq('add：新分组内任务数', ngDoc.tasks.filter((t) => t.group === '备忘').length, 1);

const removed = removeTask(SAMPLE, 'i2a3b4c');
const rmDoc = parse(removed.src);
eq('remove：任务数 -1', rmDoc.tasks.length, doc.tasks.length - 1);
ok('remove：目标消失', !removed.src.includes('修空调'));
ok('remove：同组其他任务仍在', removed.src.includes('带娃去体检'));

const upd = updateTask(SAMPLE, 'i5d6e7f', { title: '带娃去体检（改到儿童医院）', due: '2026-11-16' });
ok('update：标题与截止一起改，标签原样保留',
  upd.src.includes('- [ ] 带娃去体检（改到儿童医院） #家事 #孩子 @due(2026-11-16) <!--id:i5d6e7f-->'),
  upd.src.split(/\r?\n/).find((l) => l.includes('体检')));

/* ------------------------------------------------------ 6. 序列化对称性 */

const round = buildTaskLine(parse(SAMPLE).tasks.find((t) => t.id === 'i0a1b2c'));
eq('serialize：与原行一致',
  round.trim(),
  '- [ ] 写 Q4 OKR 初稿并同步给组内 #工作 @due(2026-11-06) !p1 <!--id:i0a1b2c-->');

/* ---------------------------------------------------------- 7. 派生逻辑 */

const st = stats(doc.tasks);
eq('stats：总数', st.total, 9);
eq('stats：已完成', st.done, 2);
eq('stats：未完成', st.open, 7);
eq('stats：完成率', st.pct, 22);

ok('overdue：过期未完成判 true', isOverdue({ due: '2026-11-01', checked: false }, '2026-11-04') === true);
ok('overdue：已完成不判逾期', isOverdue({ due: '2026-11-01', checked: true }, '2026-11-04') === false);
ok('overdue：无截止不判', isOverdue({ due: null, checked: false }, '2026-11-04') === false);

/* ------------------------------------------------- 8. 真实数据源自洽性 */

const live = parse(LIVE);
ok('todo.md：可解析且至少有一个任务', live.tasks.length > 0);
ok('todo.md：往返字节一致（不丢 BOM/EOL/空行）',
  (live.bom ? '\uFEFF' : '') + live.lines.join(live.eol) === LIVE);
ok('todo.md：每个任务的标题非空', live.tasks.every((t) => t.title.length > 0));
// 只查「固化 id」的唯一性：ephemeral id 由 (分组,标题) 派生，同名任务天然同 id，
// 那是设计取舍（同组同名本就不是两条不同的待办），不该让 CI 红。
const solidIds = live.tasks.filter((t) => !t.ephemeral).map((t) => t.id);
ok('todo.md：显式 id 不重复（重复会让补丁打到错行）',
  new Set(solidIds).size === solidIds.length);


/* ---------------------------------------------------------------- 汇总 */

const total = pass + fails.length;
const lines = [
  `passed ${pass}/${total}`,
  ...fails.map((f) => 'FAIL ' + f),
];
process.stdout.write(lines.join('\n') + '\n');
process.exit(fails.length ? 1 : 0);
