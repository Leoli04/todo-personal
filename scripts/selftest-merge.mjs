/**
 * selftest-merge.mjs —— 三方合并的机器校验
 */
import { mergeMarkdown } from '../src/core/merge.mjs';
import { parse } from '../src/core/md.mjs';

let pass = 0;
const fails = [];
const eq = (n, a, b) => {
  if (a === b) pass++;
  else fails.push(`${n} :: expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`);
};
const ok = (n, c, extra = '') => { if (c) pass++; else fails.push(n + (extra ? ' :: ' + extra : '')); };

const BASE = [
  '# 待办',
  '',
  '## 工作',
  '',
  '- [ ] A 任务 #工作 <!--id:tA-->',
  '- [ ] B 任务 #工作 <!--id:tB-->',
  '- [ ] C 任务 #工作 <!--id:tC-->',
  '',
  '## 生活',
  '',
  '- [ ] D 任务 #生活 <!--id:tD-->',
  '',
].join('\n');

const pick = (src, id) => parse(src).tasks.find((t) => t.id === id);

/* 1. 快路径 */
eq('本地无改动 → 用远端',
  mergeMarkdown(BASE, BASE, BASE.replace('A 任务', 'A 任务(远端)')).src,
  BASE.replace('A 任务', 'A 任务(远端)'));

eq('远端无改动 → 用本地',
  mergeMarkdown(BASE, BASE.replace('B 任务', 'B 改过'), BASE).src,
  BASE.replace('B 任务', 'B 改过'));

/* 2. 分头改动：远端勾 A，本地改 B 标题 —— 两边都要留 */
const remote1 = BASE.replace('- [ ] A 任务', '- [x] A 任务');
const local1 = BASE.replace('B 任务', 'B 任务（本地改名）');
const m1 = mergeMarkdown(BASE, local1, remote1);
eq('合并：远端的勾选保留', pick(m1.src, 'tA').checked, true);
eq('合并：本地的改名保留', pick(m1.src, 'tB').title, 'B 任务（本地改名）');
eq('合并：无冲突', m1.conflicts.length, 0);
eq('合并：任务数不变', parse(m1.src).tasks.length, 4);

/* 3. 同一字段两边都改 → 记为冲突且保留本地 */
const remote2 = BASE.replace('B 任务', 'B 远端改名');
const local2 = BASE.replace('B 任务', 'B 本地改名');
const m2 = mergeMarkdown(BASE, local2, remote2);
ok('冲突：被上报', m2.conflicts.some((c) => c.id === 'tB' && c.field === 'title'), JSON.stringify(m2.conflicts));
eq('冲突：保留本地值', pick(m2.src, 'tB').title, 'B 本地改名');

/* 4. 本地删除 */
const local3 = base => base.replace('- [ ] C 任务 #工作 <!--id:tC-->\n', '');
const m3 = mergeMarkdown(BASE, local3(BASE), remote1);
ok('删除：C 消失', !parse(m3.src).tasks.some((t) => t.id === 'tC'));
eq('删除：计数', m3.removed, 1);
eq('删除：远端的勾选仍在', pick(m3.src, 'tA').checked, true);

/* 5. 本地新增 */
const ADDED = BASE.replace(
  '## 生活',
  '## 新增组\n\n- [ ] 新任务 #杂项 <!--id:tN-->\n\n## 生活',
);
const m4 = mergeMarkdown(BASE, ADDED, remote1);
const tasks4 = parse(m4.src).tasks;
ok('新增：任务存在', tasks4.some((t) => t.title === '新任务'));
eq('新增：计数', m4.added, 1);
const addedIdx = tasks4.findIndex((t) => t.title === '新任务');
eq('新增：落在所属分组', tasks4[addedIdx].group, '新增组');

/* 6. 远端新增任务 + 本地改动，远端新任务必须保留 */
const remote3 = BASE.replace(
  '- [ ] C 任务 #工作 <!--id:tC-->',
  '- [ ] C 任务 #工作 <!--id:tC-->\n- [ ] 远端新加 #工作 <!--id:tE-->',
);
const m5 = mergeMarkdown(BASE, local1, remote3);
ok('远端新增：保留', parse(m5.src).tasks.some((t) => t.id === 'tE'));
ok('远端新增：本地改名也保留', parse(m5.src).tasks.some((t) => t.title === 'B 任务（本地改名）'));

/* 7. 合并结果结构完好：标题与空行不丢 */
const m6 = mergeMarkdown(BASE, local1, remote1);
eq('结构：分组数', parse(m6.src).groups.filter((g) => g.role === 'group').length, 2);
ok('结构：以换行结尾', m6.src.endsWith('\n'));

const total = pass + fails.length;
process.stdout.write([`passed ${pass}/${total}`, ...fails.map((f) => 'FAIL ' + f)].join('\n') + '\n');
process.exit(fails.length ? 1 : 0);
