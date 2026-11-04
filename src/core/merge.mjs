/**
 * merge.mjs —— 三方合并（base / local / remote）
 *
 * 场景：手机在 GitHub 上勾了一个任务，电脑这边也改了另一条，然后点「推送」。
 * 没有合并就会整文件覆盖，把远端那次勾选吞掉。
 *
 * 策略：
 *  - 结构以 remote 为准（标题、空行、注释、任务顺序都跟远端），本地不重排。
 *  - 逐任务按 id 对齐，逐字段三态判定：谁改了用谁，两边都改才叫冲突。
 *  - 本地新增 → 插到所属分组的标题行之后；本地删除 → 从 remote 里摘掉。
 *  - 冲突时保留本地值并上报，由用户决定，不静默丢数据。
 */
import { parse, buildTaskLine, deriveId } from './md.mjs';

const FIELDS = ['checked', 'title', 'tags', 'due', 'priority'];

function norm(task, key) {
  if (!task) return '';
  const v = task[key];
  if (Array.isArray(v)) return v.join('\u0001');
  return v === null || v === undefined ? '' : String(v);
}

function mergeField(base, local, remote, key) {
  const b = norm(base, key);
  const l = norm(local, key);
  const r = norm(remote, key);
  if (l === r || r === b) return { value: local ? local[key] : remote[key], conflict: false };
  if (l === b) return { value: remote[key], conflict: false };
  return { value: local[key], conflict: true }; // 两边都改且不同
}

function indexById(doc) {
  const m = new Map();
  for (const t of doc.tasks) {
    // ephemeral id 是按「分组+标题」派生的，可能撞车，再兜一层序号
    let key = t.id;
    let n = 1;
    while (m.has(key)) key = `${t.id}#${n++}`;
    m.set(key, t);
  }
  return m;
}

/**
 * @returns {{src:string, conflicts:Array<{id:string, field:string}>, added:number, removed:number}}
 */
export function mergeMarkdown(baseSrc, localSrc, remoteSrc) {
  if (localSrc === baseSrc) return { src: remoteSrc, conflicts: [], added: 0, removed: 0, fastPath: 'no-local-change' };
  if (remoteSrc === baseSrc) return { src: localSrc, conflicts: [], added: 0, removed: 0, fastPath: 'no-remote-change' };

  const base = parse(baseSrc);
  const local = parse(localSrc);
  const remote = parse(remoteSrc);

  const byId = (doc) => {
    const m = new Map();
    for (const t of doc.tasks) {
      const k = t.ephemeral ? deriveId(t.group, t.title) : t.id;
      if (!m.has(k)) m.set(k, t);
    }
    return m;
  };

  const bMap = byId(base);
  const lMap = byId(local);
  const rMap = byId(remote);
  if (rMap.size && !lMap.size && bMap.size === rMap.size) {
    // 本地被清空得离谱（多半是解析异常），宁可放弃合并也不毁数据
    return { src: remoteSrc, conflicts: [], added: 0, removed: 0, fastPath: 'suspicious-local' };
  }

  const conflicts = [];
  const removed = [];
  const addedByGroup = new Map();

  // 本地删除：在 base 里存在、local 里不存在
  for (const [id, t] of bMap) {
    if (!lMap.has(id)) removed.push(id);
  }
  // 本地新增：local 里有、base 里没有
  for (const [id, t] of lMap) {
    if (!bMap.has(id)) {
      if (!addedByGroup.has(t.group)) addedByGroup.set(t.group, []);
      addedByGroup.get(t.group).push(t);
    }
  }

  const remoteLineToTask = new Map(remote.tasks.map((t) => [t.lineIndex, t]));
  const rIdOf = new Map(remote.tasks.map((t) => [t.id, t]));

  const out = [];
  const emittedGroups = new Set();

  const flushAdded = (groupName) => {
    if (!groupName || emittedGroups.has(groupName)) return;
    const list = addedByGroup.get(groupName);
    if (!list) return;
    emittedGroups.add(groupName);
    for (const t of list) {
      out.push(buildTaskLine({ ...t, indent: t.indent || '', ephemeral: false }));
    }
  };

  for (let i = 0; i < remote.lines.length; i++) {
    const g = remote.groups.find((x) => x.lineIndex === i);
    if (g && g.role !== 'title') {
      out.push(remote.lines[i]);
      flushAdded(g.title); // 新增任务落在分组标题之后
      continue;
    }

    const rt = remoteLineToTask.get(i);
    if (!rt) { out.push(remote.lines[i]); continue; }

    const id = rt.ephemeral ? deriveId(rt.group, rt.title) : rt.id;
    if (removed.includes(id)) continue; // 本地删了

    const bt = bMap.get(id);
    const lt = lMap.get(id);

    if (!bt && !lt) { out.push(buildTaskLine(rt)); continue; } // 远端新增
    if (!lt) { out.push(buildTaskLine(rt)); continue; }        // 本地没有但也没删记录，保守保留远端

    const merged = { ...rt };
    for (const f of FIELDS) {
      const { value, conflict } = mergeField(bt, lt, rt, f);
      merged[f] = value;
      if (conflict) conflicts.push({ id, field: f });
    }
    out.push(buildTaskLine({ ...merged, id: rt.id, ephemeral: false, indent: rt.indent }));
  }

  // 远端没有、本地新增、且分组也不在远端 → 追加新分组
  for (const [group, list] of addedByGroup) {
    if (emittedGroups.has(group)) continue;
    emittedGroups.add(group);
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`## ${group || '未分组'}`, '');
    for (const t of list) out.push(buildTaskLine({ ...t, indent: '', ephemeral: false }));
  }

  const src = (remote.bom ? '\uFEFF' : '') + out.join(remote.eol);
  return {
    src,
    conflicts,
    added: [...addedByGroup.values()].reduce((n, l) => n + l.length, 0),
    removed: removed.length,
  };
}
