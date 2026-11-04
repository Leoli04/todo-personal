/**
 * md.mjs —— Markdown 即数据库：解析 / 行级补丁 / 序列化
 *
 * 设计约束（很重要，改代码前先读）：
 *  1) 只做「行级替换」，绝不重排全文。任何全文重写都会让 git diff 变成整文件，
 *     PR 无法 review，冲突率飙升。
 *  2) 行尾符（CRLF/LF）与 BOM 原样保留，否则 Windows + CI 混合环境会产生幽灵 diff。
 *  3) 代码围栏内的 `- [ ]` 不是任务，必须跳过。
 *  4) 无 id 的行 = ephemeral，只在「被修改的那一刻」固化 id，没动过的行一个字节都不改。
 *
 * 支持的语法（面向人，GitHub 原生渲染可读）：
 *   # 分组
 *   - [ ] 任务标题 #标签 @due(2026-11-05) !p1 <!--id:a1b2c3d-->
 *   - [x] 已完成 <!--id:a1b2c3d @done(2026-11-03)-->
 */

const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const TRAILING_COMMENT_RE = /\s*<!--([\s\S]*?)-->\s*$/;
const ID_RE = /(?:^|\s)id:([A-Za-z0-9_-]{1,64})(?=\s|$)/;
const DONE_RE = /@done\(\s*(\d{4}-\d{2}-\d{2})\s*\)/;
const DUE_RE = /@due\(\s*(\d{4}-\d{2}-\d{2})\s*\)/;
const PRIO_RE = /(?:^|\s)!p([0-3])\b/i;
// 首字符必须是字母或汉字：避免把「工单 #8821」里的工单号当成标签。
const TAG_RE = /(?:^|\s)#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5/-]*)/g;

/* ---------------------------------------------------------------- utils */

export function detectEol(src) {
  const i = src.indexOf('\n');
  return i > 0 && src[i - 1] === '\r' ? '\r\n' : '\n';
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function base36(n, width) {
  return n.toString(36).padStart(width, '0').slice(-width);
}

/** 确定性 id：同 (分组, 标题) 恒得同一值，跨设备一致，便于合并 */
export function deriveId(group, title) {
  return 'e' + base36(hash32(`${group}\u0000${title}`), 7);
}

function randomId() {
  const rnd = Math.floor(Math.random() * 0xffffffff);
  return 'i' + base36(hash32(String(Date.now()) + String(rnd)), 7);
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------------------------------------------------------- parse */

/**
 * 把行内文本拆成 { title, tags, due, priority, id, doneAt }
 */
export function parseInline(rest, group) {
  let body = rest;
  let id = null;
  let doneAt = null;
  let hadComment = false;

  const cm = body.match(TRAILING_COMMENT_RE);
  if (cm) {
    hadComment = true;
    body = body.slice(0, cm.index);
    const inner = cm[1];
    const im = inner.match(ID_RE);
    if (im) id = im[1];
    const dm = inner.match(DONE_RE);
    if (dm) doneAt = dm[1];
  }

  let priority = null;
  const pm = body.match(PRIO_RE);
  if (pm) {
    priority = Number(pm[1]);
    body = body.replace(PRIO_RE, ' ');
  }

  let due = null;
  const duem = body.match(DUE_RE);
  if (duem) {
    due = duem[1];
    body = body.replace(DUE_RE, ' ');
  }

  const tags = [];
  let tm;
  TAG_RE.lastIndex = 0;
  while ((tm = TAG_RE.exec(body))) tags.push(tm[1]);
  if (tags.length) body = body.replace(TAG_RE, ' ');

  const title = body.replace(/\s+/g, ' ').trim();
  const ephemeral = !id;
  if (!id) id = deriveId(group, title);

  return { title, tags, due, priority, id, doneAt, ephemeral, hadComment };
}

/**
 * 文件里是否存在二级及以下标题。有 → 首个 h1 视为文档标题；
 * 没有 → 全篇 h1 都是分组（照顾「# 工作 / # 生活」这种极简写法）。
 */
function hasSubHeading(lines) {
  let fence = null;
  let inFm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') { inFm = true; continue; }
    if (inFm) { if (line.trim() === '---') inFm = false; continue; }
    const fm = line.match(FENCE_RE);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const hm = line.match(HEADING_RE);
    if (hm && hm[1].length >= 2) return true;
  }
  return false;
}

/**
 * @returns {{eol:string, bom:boolean, lines:string[], tasks:Task[], groups:Group[]}}
 */
export function parse(src) {
  const bom = src.charCodeAt(0) === 0xfeff;
  const text = bom ? src.slice(1) : src;
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const sub = hasSubHeading(lines);

  const tasks = [];
  const groups = [];
  let fence = null;
  let inFrontMatter = false;
  let currentGroup = '';
  let currentGroupLevel = 0;
  let titleTaken = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // front matter：仅文件开头第一行 --- 才生效
    if (i === 0 && line.trim() === '---') { inFrontMatter = true; continue; }
    if (inFrontMatter) {
      if (line.trim() === '---') { inFrontMatter = false; }
      continue;
    }

    const fm = line.match(FENCE_RE);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;

    const hm = line.match(HEADING_RE);
    if (hm) {
      const level = hm[1].length;
      const title = hm[2].trim();
      // 首个 h1 + 存在子标题 ⇒ 文档标题，不参与分组，也不改变当前分组
      if (level === 1 && sub && !titleTaken) {
        titleTaken = true;
        groups.push({ title, level, lineIndex: i, role: 'title' });
        continue;
      }
      currentGroup = title;
      currentGroupLevel = level;
      groups.push({ title, level, lineIndex: i, role: 'group' });
      continue;
    }

    const tm = line.match(TASK_RE);
    if (!tm) continue;

    const indent = tm[1].replace(/\t/g, '  ');
    const checked = tm[2].toLowerCase() === 'x';
    const inline = parseInline(tm[3], currentGroup);

    tasks.push({
      ...inline,
      checked,
      indent,
      group: currentGroup,
      groupLevel: currentGroupLevel,
      lineIndex: i,
      raw: line,
    });
  }

  return { eol, bom, lines, tasks, groups };
}

/* ------------------------------------------------------------ serialize */

export function buildTaskLine(t) {
  const parts = [];
  if (t.title) parts.push(t.title);
  for (const tag of t.tags || []) parts.push('#' + tag);
  if (t.due) parts.push(`@due(${t.due})`);
  if (typeof t.priority === 'number') parts.push(`!p${t.priority}`);

  let line = `${t.indent || ''}- [${t.checked ? 'x' : ' '}] ${parts.join(' ')}`.trimEnd();

  const meta = [];
  if (t.id && !t.ephemeral) meta.push(`id:${t.id}`);
  if (t.doneAt) meta.push(`@done(${t.doneAt})`);
  if (meta.length) line += ` <!--${meta.join(' ')}-->`;
  return line;
}

function join(doc) {
  return (doc.bom ? '\uFEFF' : '') + doc.lines.join(doc.eol);
}

/* --------------------------------------------------------------- mutate */

function findTask(doc, id) {
  return doc.tasks.find((t) => t.id === id && !t.ephemeral) ||
         doc.tasks.find((t) => t.id === id);
}

/**
 * 对单个任务行做原地补丁。返回 { src, changed, task?, error? }
 */
export function patchTask(src, id, mutator) {
  const doc = parse(src);
  const t = findTask(doc, id);
  if (!t) return { src, changed: false, error: 'task-not-found' };

  const next = { ...t, tags: [...t.tags] };
  const before = JSON.stringify({ ...t, lineIndex: 0, raw: 0 });
  mutator(next);

  // 改动落到这一行时才固化 id，保证其余行零 diff
  if (next.ephemeral) { next.id = randomId(); next.ephemeral = false; }

  const after = JSON.stringify({ ...next, lineIndex: 0, raw: 0 });
  if (before === after) return { src, changed: false, task: t };

  doc.lines[t.lineIndex] = buildTaskLine(next);
  return { src: join(doc), changed: true, task: next };
}

export function toggleTask(src, id, checked, opts = {}) {
  return patchTask(src, id, (t) => {
    t.checked = checked;
    if (opts.trackDoneDate) t.doneAt = checked ? todayISO() : null;
  });
}

export function updateTask(src, id, patch) {
  return patchTask(src, id, (t) => Object.assign(t, patch));
}

export function removeTask(src, id) {
  const doc = parse(src);
  const t = findTask(doc, id);
  if (!t) return { src, changed: false, error: 'task-not-found' };
  doc.lines.splice(t.lineIndex, 1);
  // 清理可能留下的连续空行（最多 1 行，避免吃掉用户的排版）
  if (doc.lines[t.lineIndex] === '' && doc.lines[t.lineIndex - 1] === '') {
    doc.lines.splice(t.lineIndex, 1);
  }
  return { src: join(doc), changed: true };
}

/**
 * 追加任务。有同名分组则插到该分组最后一个任务之后；否则新建分组。
 */
export function addTask(src, { group, title, tags = [], due = null, priority = null, checked = false }) {
  const doc = parse(src);
  const clean = String(title || '').trim();
  if (!clean) return { src, changed: false, error: 'empty-title' };

  const task = {
    id: randomId(),
    ephemeral: false,
    checked,
    title: clean,
    tags,
    due,
    priority,
    doneAt: checked ? todayISO() : null,
  };

  const g = doc.groups.find((x) => x.title === group && x.role === 'group');
  const line = buildTaskLine({ ...task, indent: '' });

  if (!g) {
    // 新建分组：沿用现有分组的标题层级，缺省 h2；文件末尾追加，前后留空行
    const peer = doc.groups.find((x) => x.role === 'group');
    const hashes = '#'.repeat(peer ? peer.level : 2);
    const tail = doc.lines[doc.lines.length - 1];
    if (tail !== undefined && tail.trim() !== '') doc.lines.push('');
    doc.lines.push(`${hashes} ${group || '未分组'}`, '', line);
  } else {
    const inGroup = doc.tasks.filter((t) => t.group === group);
    if (inGroup.length) {
      const last = inGroup[inGroup.length - 1];
      doc.lines.splice(last.lineIndex + 1, 0, line);
    } else {
      // 分组存在但为空：插在标题行之后（跳过一个空行）
      let at = g.lineIndex + 1;
      if (doc.lines[at] === '') at += 1;
      doc.lines.splice(at, 0, line);
    }
  }

  return { src: join(doc), changed: true, task };
}

/* -------------------------------------------------------------- helpers */

export function stats(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.checked).length;
  return { total, done, open: total - done, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function isOverdue(task, ref = todayISO()) {
  return !!task.due && !task.checked && task.due < ref;
}

export function groupBy(tasks, keyFn) {
  const map = new Map();
  for (const t of tasks) {
    const k = keyFn(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}
