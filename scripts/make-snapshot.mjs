/**
 * make-snapshot.mjs —— 形态 C 用：把 todo.md 烘成同源 JSON，供 Actions 定时提交。
 * 只在「私有仓库 + 不在页面里放 token」时才需要。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stats, isOverdue } from '../src/core/md.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'todo.md'), 'utf8');
const doc = parse(src);

const tasks = doc.tasks.map((t) => ({
  id: t.id,
  title: t.title,
  checked: t.checked,
  tags: t.tags,
  due: t.due,
  priority: t.priority,
  group: t.group,
  doneAt: t.doneAt,
  overdue: isOverdue(t),
}));

const payload = {
  generatedAt: new Date().toISOString(),
  title: doc.groups.find((g) => g.role === 'title')?.title || '待办',
  groups: doc.groups.filter((g) => g.role === 'group').map((g) => g.title),
  stats: stats(doc.tasks),
  tasks,
};

mkdirSync(resolve(root, 'data'), { recursive: true });
writeFileSync(resolve(root, 'data/todo.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
process.stdout.write(`snapshot: ${tasks.length} tasks\n`);
