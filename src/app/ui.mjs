/**
 * ui.mjs —— 视图与交互层。无框架、无依赖，状态单一来源即 workSrc（Markdown 文本）。
 */
import {
  parse, toggleTask, addTask, updateTask, removeTask,
  parseInline, stats, isOverdue, todayISO,
} from '../core/md.mjs';
import { mergeMarkdown } from '../core/merge.mjs';
import { createClient, loadToken, saveToken, GitHubError } from './github.mjs';
import { createSyncEngine } from './sync.mjs';

const DEMO = (typeof window !== 'undefined' && window.__DEMO_MD__) ||
  '# 我的待办\n\n## 收件箱\n\n- [ ] 双击标题可以改，点左边圆圈可以勾 #示例 <!--id:i1demo-->\n';

const LS = {
  cfg: 'todo-gh:config',
  work: 'todo-gh:work',
  base: 'todo-gh:base',
};

const DEFAULT_CFG = {
  owner: '', repo: '', branch: 'main', path: 'todo.md',
  autoPush: false, theme: 'auto',
};

/* --------------------------------------------------------------- state */

const S = {
  cfg: { ...DEFAULT_CFG },
  remoteSrc: '',
  workSrc: '',
  doc: null,
  filters: { q: '', status: 'open', tags: [], group: '' },
  view: 'list',
  editingId: null,
  sync: {},
  busy: false,
  toast: null,
  drawer: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const dirty = () => S.workSrc !== S.remoteSrc;
const configured = () => !!(S.cfg.owner && S.cfg.repo && S.cfg.path);

/* ------------------------------------------------ 链接即配置（换机迁移） */

/**
 * 从 search / hash 解析仓库配置，hash 覆盖 search（便于 `…/#repo=owner/name` 短链）。
 * 纯函数，不碰 DOM，自检可直接调用。
 */
function urlCfgFrom(search, hash) {
  const p = new URLSearchParams();
  for (const raw of [String(search || '').replace(/^\?/, ''), String(hash || '').replace(/^#/, '')]) {
    if (!raw) continue;
    let sp;
    try { sp = new URLSearchParams(raw); } catch { continue; }
    for (const [k, v] of sp) p.set(k, v);
  }
  const out = {};
  const full = (p.get('repo') || '').trim();
  if (full) {
    const [o, r] = full.includes('/') ? full.split('/').filter(Boolean) : [];
    if (o && r) { out.owner = o; out.repo = r; }
    else {
      out.repo = full;
      const own = (p.get('owner') || '').trim();
      if (own) out.owner = own;
    }
  }
  const br = (p.get('branch') || '').trim();
  if (br) out.branch = br;
  const pa = (p.get('path') || '').trim();
  if (pa) out.path = pa;
  return out;
}

/** 把链接里的参数并进配置；用过即抹掉，避免刷新时覆盖用户手改的设置 */
function applyUrlCfg() {
  let next = {};
  try { next = urlCfgFrom(location.search, location.hash); } catch { return false; }
  if (!Object.keys(next).length) return false;
  S.cfg = { ...S.cfg, ...next };
  persistCfgOnly();
  try {
    history.replaceState(null, '', location.href.split('#')[0].split('?')[0]);
  } catch { /* file:// 下个别浏览器拒绝，参数留着也无害 */ }
  return true;
}

/** 生成可带走的链接：只含仓库坐标，绝不含 token */
function shareUrl() {
  if (!configured()) return '';
  const base = location.href.split('#')[0].split('?')[0];
  // 保留 / 不转义，链接肉眼可读
  const enc = (v) => encodeURIComponent(String(v)).replace(/%2F/g, '/');
  const q = `repo=${enc(`${S.cfg.owner}/${S.cfg.repo}`)}`
    + `&branch=${enc(S.cfg.branch || 'main')}`
    + `&path=${enc(S.cfg.path || 'todo.md')}`;
  return `${base}#${q}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ---------------------------------------------------------- persistence */

function loadLocal() {
  try {
    const cfg = JSON.parse(localStorage.getItem(LS.cfg) || 'null');
    if (cfg) S.cfg = { ...DEFAULT_CFG, ...cfg };
    S.workSrc = localStorage.getItem(LS.work) || '';
    S.remoteSrc = localStorage.getItem(LS.base) || S.workSrc;
  } catch { /* 隐私模式：纯内存运行 */ }

  if (!S.workSrc) {
    S.workSrc = DEMO;
    S.remoteSrc = DEMO;
  }
  setDoc(S.workSrc);
}

function persistCfgOnly() {
  try { localStorage.setItem(LS.cfg, JSON.stringify(S.cfg)); } catch { /* ignore */ }
}

function persist() {
  persistCfgOnly();
  try {
    localStorage.setItem(LS.work, S.workSrc);
    localStorage.setItem(LS.base, S.remoteSrc);
  } catch { /* ignore */ }
}

function setDoc(src) {
  S.doc = parse(src);
  const tags = new Set();
  for (const t of S.doc.tasks) t.tags.forEach((x) => tags.add(x));
  S.allTags = [...tags].sort();
}

function setWork(src) {
  S.workSrc = src;
  setDoc(src);
  persist();
  render();
}

/* -------------------------------------------------------------- helpers */

function fmtRelative(ts) {
  if (!ts) return '尚未同步';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 10) return '刚刚';
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function fmtDue(due) {
  const [, m, d] = due.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function toast(msg, kind = 'info', ms = 3200) {
  S.toast = { msg, kind, at: Date.now() };
  render();
  setTimeout(() => {
    if (S.toast && Date.now() - S.toast.at >= ms - 50) { S.toast = null; render(); }
  }, ms);
}

function visibleTasks() {
  const { q, status, tags, group } = S.filters;
  const needle = q.trim().toLowerCase();
  // 看板本身就是「按状态分列」，再叠一层状态筛选会永远空一列
  const byStatus = S.view !== 'board';
  return S.doc.tasks.filter((t) => {
    if (byStatus && status === 'open' && t.checked) return false;
    if (byStatus && status === 'done' && !t.checked) return false;
    if (group && t.group !== group) return false;
    if (tags.length && !tags.every((x) => t.tags.includes(x))) return false;
    if (needle) {
      const hay = `${t.title} ${t.tags.join(' ')} ${t.group}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/* ---------------------------------------------------------------- sync */

let client = null;
let engine = null;
let engineSeq = 0;

function rebuildEngine() {
  // 换配置时旧请求可能还在飞：用序号作废它的回调，避免旧仓库的响应盖到新配置上
  const seq = ++engineSeq;
  engine = null;
  client = null;
  if (!configured()) return;

  client = createClient({
    owner: S.cfg.owner, repo: S.cfg.repo, path: S.cfg.path, branch: S.cfg.branch,
  });
  engine = createSyncEngine({
    client,
    getToken: loadToken,
    onStatus: (st) => { if (seq !== engineSeq) return; S.sync = st; render(); },
    onData: (content) => {
      if (seq !== engineSeq) return;
      if (content === S.remoteSrc) {
        if (!dirty()) { S.workSrc = content; setDoc(content); }
        return;
      }
      // 远端变了。本地有未推送改动时先存着，交给用户决定是否合并
      S.remoteSrc = content;
      persist();
      if (dirty()) {
        S.remoteNewer = true;
        toast('远端有新内容，本地改动尚未合并', 'warn');
      } else {
        S.workSrc = content;
        setDoc(content);
        persist();
        render();
      }
    },
  });
  engine.load();
}

async function pushNow() {
  if (S.busy) return;
  if (!configured()) { toast('先在设置里填入仓库信息', 'warn'); S.drawer = true; render(); return; }
  const token = loadToken();
  if (!token) { toast('写回需要 Personal Access Token', 'warn'); S.drawer = true; render(); return; }

  S.busy = true;
  render();
  try {
    // 1) 拿最新内容 + blob sha（写回必须带 sha）
    const latest = await client.read({ token, wantSha: true });
    if (latest.status !== 200) throw new Error('无法读取远端最新版本');

    let target = S.workSrc;
    let mergeInfo = null;

    // 2) 远端在本地读取之后又变了 → 三方合并，不整文件覆盖
    if (latest.content !== S.remoteSrc) {
      const merged = mergeMarkdown(S.remoteSrc, S.workSrc, latest.content);
      target = merged.src;
      mergeInfo = merged;
    }

    // 3) 提交
    const res = await client.write({
      content: target,
      sha: latest.sha,
      token,
      message: `chore(todo): update ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    });

    if (!res.ok) {
      if (res.conflict) {
        // sha 过期：重新拉一次再合并，最多一次
        const retry = await client.read({ token, wantSha: true });
        if (retry.status === 200) {
          const merged = mergeMarkdown(S.remoteSrc, S.workSrc, retry.content);
          const res2 = await client.write({
            content: merged.src, sha: retry.sha, token,
            message: `chore(todo): update ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          });
          if (res2.ok) {
            S.remoteSrc = merged.src;
            S.workSrc = merged.src;
            setDoc(merged.src);
            persist();
            // 写回后强制下一次刷新取全文：PUT 返回的是 commit sha，不是 blob 的 ETag，不能拿来当校验值
            engine?.markPushed();
            engine?.resetEtag();
            toast(merged.conflicts.length ? `已推送，${merged.conflicts.length} 处冲突保留本地版本` : '已推送到 GitHub', 'ok');
            return;
          }
        }
      }
      throw new Error(res.message || '推送失败');
    }

    S.remoteSrc = target;
    S.workSrc = target;
    S.remoteNewer = false;
    setDoc(target);
    persist();
    engine?.markPushed();
    engine?.resetEtag();
    toast(mergeInfo?.conflicts.length
      ? `已推送，${mergeInfo.conflicts.length} 处冲突保留本地版本`
      : '已推送到 GitHub', 'ok');
  } catch (e) {
    toast(e.message || '推送失败', 'err', 5000);
  } finally {
    S.busy = false;
    render();
  }
}

async function mergeRemote() {
  if (!configured()) return;
  const token = loadToken() || null;
  try {
    const latest = await client.read({ token, wantSha: false });
    if (latest.status !== 200) { toast('远端读取失败', 'err'); return; }
    const merged = mergeMarkdown(S.remoteSrc, S.workSrc, latest.content);
    S.remoteSrc = latest.content;
    S.workSrc = merged.src;
    S.remoteNewer = false;
    setDoc(merged.src);
    persist();
    toast(merged.conflicts.length
      ? `已合并，${merged.conflicts.length} 处冲突保留本地版本`
      : '已合并远端更新', merged.conflicts.length ? 'warn' : 'ok');
  } catch (e) {
    toast(e.message || '合并失败', 'err');
  }
}

/* --------------------------------------------------------------- render */

function chipStatus() {
  const st = S.sync || {};
  const phase = st.phase || 'idle'; // 同步引擎未启动时 phase 为空，不能落到默认文案
  const map = {
    ok: ['ok', '已刷新'],
    'not-modified': ['ok', '无变化'],
    syncing: ['busy', '刷新中'],
    offline: ['warn', '离线'],
    error: ['err', st.error || '刷新失败'],
    ratelimited: ['warn', '配额受限'],
    idle: ['idle', configured() ? '待刷新' : '演示模式'],
  };
  const [kind, label] = map[phase] || ['idle', '未知'];
  return `<span class="dot dot--${kind}"></span><span class="chip-label">${esc(label)}</span>`;
}

/** 编辑框里展示的是「整行正文」（标题 + 标签 + 截止 + 优先级），与解析规则对称 */
function inlineValue(t) {
  return [t.title]
    .concat(t.tags.map((x) => '#' + x))
    .concat(t.due ? [`@due(${t.due})`] : [])
    .concat(typeof t.priority === 'number' ? [`!p${t.priority}`] : [])
    .filter(Boolean)
    .join(' ');
}

function taskHTML(t) {
  const overdue = isOverdue(t);
  const editing = S.editingId === t.id;
  const meta = [];
  for (const tag of t.tags) meta.push(`<button class="tag" data-act="tag" data-tag="${esc(tag)}">#${esc(tag)}</button>`);
  if (t.due) meta.push(`<span class="due ${overdue ? 'due--over' : ''}">${esc(fmtDue(t.due))}${overdue ? ' 逾期' : ''}</span>`);
  if (typeof t.priority === 'number') meta.push(`<span class="prio prio--${t.priority}">P${t.priority}</span>`);

  return `
    <li class="task ${t.checked ? 'task--done' : ''} ${overdue ? 'task--over' : ''}" data-id="${esc(t.id)}">
      <button class="check" data-act="toggle" aria-label="${t.checked ? '取消完成' : '标记完成'}" aria-pressed="${t.checked}">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
      </button>
      <div class="task-main">
        ${editing
          ? `<input class="edit" value="${esc(inlineValue(t))}" data-id="${esc(t.id)}" aria-label="编辑任务" />`
          : `<div class="task-title" data-act="edit" title="单击编辑">${esc(t.title)}</div>`}
        ${meta.length && !editing ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      </div>
      <button class="icon-btn task-del" data-act="del" aria-label="删除">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </li>`;
}

function listHTML(tasks) {
  if (!tasks.length) return `<div class="empty">没有符合条件的任务</div>`;
  const byGroup = new Map();
  for (const t of tasks) {
    const k = t.group || '未分组';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(t);
  }
  return [...byGroup].map(([group, items]) => {
    const done = items.filter((t) => t.checked).length;
    return `
      <section class="group">
        <header class="group-head">
          <h2>${esc(group)}</h2>
          <span class="group-count">${done}/${items.length}</span>
        </header>
        <ul class="task-list">${items.map(taskHTML).join('')}</ul>
      </section>`;
  }).join('');
}

function boardHTML(tasks) {
  const cols = [
    { key: 'open', label: '进行中', items: tasks.filter((t) => !t.checked) },
    { key: 'done', label: '已完成', items: tasks.filter((t) => t.checked) },
  ];
  return `<div class="board">${cols.map((c) => `
    <div class="col">
      <div class="col-head"><span>${c.label}</span><b>${c.items.length}</b></div>
      <ul class="task-list">${c.items.length ? c.items.map(taskHTML).join('') : '<li class="empty-mini">—</li>'}</ul>
    </div>`).join('')}</div>`;
}

function statsHTML() {
  const st = stats(S.doc.tasks);
  const over = S.doc.tasks.filter((t) => isOverdue(t)).length;
  return `
    <div class="stats">
      <div class="stat"><b>${st.open}</b><span>待办</span></div>
      <div class="stat"><b>${st.done}</b><span>完成</span></div>
      <div class="stat ${over ? 'stat--warn' : ''}"><b>${over}</b><span>逾期</span></div>
      <div class="stat"><b>${st.pct}%</b><span>完成率</span></div>
      <div class="bar"><i style="width:${st.pct}%"></i></div>
    </div>`;
}

function toolbarHTML() {
  const f = S.filters;
  const tabs = [['open', '待办'], ['done', '已完成'], ['all', '全部']];
  return `
    <div class="toolbar">
      <div class="search-wrap">
        <svg class="search-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input id="q" placeholder="搜索任务、标签、分组" value="${esc(f.q)}" />
      </div>
      <div class="seg ${S.view === 'board' ? 'seg--off' : ''}" role="tablist" title="${S.view === 'board' ? '看板已按状态分列，此项不生效' : ''}">
        ${tabs.map(([k, label]) => `<button role="tab" data-status="${k}" class="${f.status === k ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      <div class="view-toggle">
        <button data-view="list" class="${S.view === 'list' ? 'on' : ''}" title="分组列表">列表</button>
        <button data-view="board" class="${S.view === 'board' ? 'on' : ''}" title="看板">看板</button>
      </div>
    </div>
    ${S.allTags.length ? `<div class="tagbar">
      ${S.allTags.map((t) => `<button class="tag ${f.tags.includes(t) ? 'tag--on' : ''}" data-act="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
      ${f.tags.length ? '<button class="clear-tags" data-act="clear-tags">清除</button>' : ''}
    </div>` : ''}`;
}

function composerHTML() {
  const groups = S.doc.groups.filter((g) => g.role !== 'title').map((g) => g.title);
  const target = S.filters.group || groups[0] || '收件箱';
  return `
    <form class="composer" id="composer">
      <select id="new-group" aria-label="分组">
        ${groups.map((g) => `<option ${g === target ? 'selected' : ''}>${esc(g)}</option>`).join('')}
        <option value="__new">+ 新分组…</option>
      </select>
      <input id="new-title" placeholder="加一条…#标签 @due(2026-11-10) !p1" autocomplete="off" />
      <button type="submit" class="btn-primary">添加</button>
    </form>`;
}

function bannerHTML() {
  const parts = [];
  if (!configured()) {
    parts.push(`<div class="banner banner--demo">演示模式 · 数据只在本机
      <button data-act="drawer" class="link">连接 GitHub 仓库 →</button></div>`);
  }
  if (S.remoteNewer && dirty()) {
    parts.push(`<div class="banner banner--warn">远端有更新，本地也有改动
      <button data-act="merge" class="link">合并（保留双方改动）</button></div>`);
  } else if (dirty()) {
    parts.push(`<div class="banner banner--draft">本地有未推送改动${configured() ? '' : '，连上仓库后才会写回'}
      <button data-act="${configured() ? 'push' : 'drawer'}" class="link">${configured() ? '立即推送' : '去设置'}</button></div>`);
  }
  return parts.join('');
}

function drawerHTML() {
  if (!S.drawer) return '';
  const c = S.cfg;
  const hasToken = !!loadToken();
  return `
  <div class="drawer-mask" data-act="drawer-close"></div>
  <aside class="drawer" role="dialog" aria-label="设置">
    <header><h3>同步设置</h3><button class="icon-btn" data-act="drawer-close" aria-label="关闭">×</button></header>

    <label class="field"><span>仓库（owner/repo）</span>
      <div class="row">
        <input id="cfg-owner" placeholder="owner" value="${esc(c.owner)}" />
        <span class="slash">/</span>
        <input id="cfg-repo" placeholder="repo" value="${esc(c.repo)}" />
      </div>
    </label>
    <div class="row2">
      <label class="field"><span>分支</span><input id="cfg-branch" value="${esc(c.branch)}" /></label>
      <label class="field"><span>文件路径</span><input id="cfg-path" value="${esc(c.path)}" /></label>
    </div>
    <label class="field"><span>Personal Access Token ${hasToken ? '<em class="ok-mark">已保存</em>' : ''}</span>
      <input id="cfg-token" type="password" placeholder="github_pat_… （仅存本机）" value="" />
    </label>
    <p class="hint">
      Fine-grained token，只勾这一个仓库的 <b>Contents: Read and write</b> 即可。
      留空表示只读模式（页面不写回，改动仅存本地）。
    </p>
    <label class="field field--switch">
      <input type="checkbox" id="cfg-autopush" ${c.autoPush ? 'checked' : ''} />
      <span>勾选后自动推送（延迟 3 秒合并提交）</span>
    </label>

    <div class="drawer-actions">
      <button class="btn-ghost" data-act="probe">测试连接</button>
      <button class="btn-primary" data-act="save-cfg">保存并刷新</button>
    </div>
    <div class="drawer-foot">
      <div class="foot-links">
        <button class="link" data-act="copy-link">复制带配置的链接</button>
        <button class="link" data-act="reset-local">清空本地缓存</button>
      </div>
      <span class="ver">v1.2</span>
    </div>
    <p class="hint hint--foot">
      不做后台轮询：在 GitHub 上改完 todo.md、等 Actions 部署完，点顶栏的刷新按钮取一次最新内容。
    </p>
    <p class="hint hint--foot">
      链接只带仓库坐标，不含 token。换电脑/换浏览器打开它即自动连上，token 需在新设备单独填一次
      （凭据不跟着链接走，这是有意的）。
    </p>
  </aside>`;
}

/* --------------------------------------------------------------- theme */

const THEMES = [
  { key: 'auto', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
];

function themeLabel() {
  return (THEMES.find((t) => t.key === S.cfg.theme) || THEMES[0]).label;
}

/** auto → 不写 data-theme（交给 prefers-color-scheme）；light/dark → 显式覆盖 */
function applyTheme() {
  const t = S.cfg.theme === 'light' || S.cfg.theme === 'dark' ? S.cfg.theme : '';
  const root = document.documentElement;
  if (t) root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
}

function themeIcon() {
  const t = S.cfg.theme;
  if (t === 'light') {
    return '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.3v1.9M8 12.8v1.9M1.3 8h1.9M12.8 8h1.9M3.2 3.2l1.35 1.35M11.45 11.45l1.35 1.35M12.8 3.2l-1.35 1.35M4.55 11.45L3.2 12.8"/></svg>';
  }
  if (t === 'dark') {
    return '<svg viewBox="0 0 16 16"><path d="M13.6 9.7A5.9 5.9 0 0 1 6.3 2.4a5.9 5.9 0 1 0 7.3 7.3Z"/></svg>';
  }
  // auto：半明半暗，避免和“浅色”那个太阳混淆
  return '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.4"/><path d="M8 2.6v10.8a5.4 5.4 0 0 0 0-10.8Z" fill="currentColor" stroke="none"/></svg>';
}

function render() {
  const app = $('#app');
  const tasks = visibleTasks();
  const st = S.sync || {};
  const isDemo = !configured();

  app.innerHTML = `
    <header class="top">
      <div class="brand">
        <div class="brand-mark">✓</div>
        <div>
          <h1>${esc(S.doc.groups.find((g) => g.role === 'title')?.title || '我的待办')}</h1>
          <div class="sub">${esc(S.cfg.owner ? `${S.cfg.owner}/${S.cfg.repo}` : '本地演示')} · ${fmtRelative(st.lastOkAt)}</div>
        </div>
      </div>
      <div class="top-actions">
        <div class="chip ${isDemo ? 'chip--demo' : ''}">${chipStatus()}</div>
        <button class="icon-btn" data-act="theme" aria-label="主题：${themeLabel()}" title="主题：${themeLabel()}（点击切换）">
          ${themeIcon()}
        </button>
        <button class="icon-btn" data-act="sync" aria-label="刷新" title="刷新（从 GitHub 拉取最新内容）">
          <svg viewBox="0 0 16 16" class="${st.phase === 'syncing' ? 'spin' : ''}"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11"/></svg>
        </button>
        <button class="icon-btn" data-act="drawer" aria-label="设置" title="设置">
          <svg viewBox="0 0 24 24" class="ico-gear"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
        </button>
      </div>
    </header>

    ${statsHTML()}
    ${bannerHTML()}
    ${toolbarHTML()}

    <main class="content">
      ${S.view === 'board' ? boardHTML(tasks) : listHTML(tasks)}
    </main>

    ${composerHTML()}
    <footer class="foot">
      <span class="count">${tasks.length} / ${S.doc.tasks.length} 条显示</span>
      <span class="sep">·</span>
      <span>${dirty() ? '<b class="warn-mark">未推送</b>' : '已同步'}</span>
      ${st.rate?.remaining !== null && st.rate?.remaining !== undefined
        ? `<span class="sep">·</span><span title="未认证每小时 60 次">配额 ${st.rate.remaining}/${st.rate.limit}</span>` : ''}
    </footer>

    ${drawerHTML()}
    ${S.toast ? `<div class="toast toast--${S.toast.kind}">${esc(S.toast.msg)}</div>` : ''}
  `;

  if (S.editingId) {
    const el = $('.edit');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }
  const q = $('#q');
  if (q && S.filters.q) {
    // 保持光标位置：仅在搜索框不是当前焦点时重设
    if (document.activeElement !== q) q.value = S.filters.q;
  }
}

/**
 * 只重绘列表区域。搜索输入走这条路径：
 * 全量 render 会替换掉 <input>，导致光标跳动、中文输入法候选框被打断。
 */
function renderListOnly() {
  const tasks = visibleTasks();
  const main = $('.content');
  if (main) main.innerHTML = S.view === 'board' ? boardHTML(tasks) : listHTML(tasks);
  const cnt = $('.foot .count');
  if (cnt) cnt.textContent = `${tasks.length} / ${S.doc.tasks.length} 条显示`;
}

/* --------------------------------------------------------------- events */

let autoPushTimer = null;

function scheduleAutoPush() {
  if (!S.cfg.autoPush || !loadToken() || !configured()) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => pushNow(), 3000);
}

function mutate(fn) {
  const before = S.workSrc;
  const r = fn(S.workSrc);
  if (r && r.src !== undefined && r.src !== before) {
    setWork(r.src);
    scheduleAutoPush();
  }
  return r;
}

document.addEventListener('click', async (e) => {
  const actEl = e.target.closest('[data-act]');
  const statusBtn = e.target.closest('[data-status]');
  const viewBtn = e.target.closest('[data-view]');

  if (statusBtn) { S.filters.status = statusBtn.dataset.status; render(); return; }
  if (viewBtn) {
    S.view = viewBtn.dataset.view;
    if (S.view === 'board') S.filters.status = 'all';
    render();
    return;
  }
  if (!actEl) return;

  const act = actEl.dataset.act;
  const id = actEl.closest('.task')?.dataset.id;

  switch (act) {
    case 'toggle': {
      const t = S.doc.tasks.find((x) => x.id === id);
      if (!t) return;
      mutate((src) => toggleTask(src, id, !t.checked, { trackDoneDate: true }));
      break;
    }
    case 'edit':
      S.editingId = id;
      render();
      break;
    case 'del': {
      const t = S.doc.tasks.find((x) => x.id === id);
      if (!t) return;
      if (!confirm(`删除「${t.title}」？会从 Markdown 里移除这一行。`)) return;
      mutate((src) => removeTask(src, id));
      toast('已删除，可在推送前撤销（刷新页面前有效）', 'info');
      break;
    }
    case 'tag': {
      const tag = actEl.dataset.tag;
      if (actEl.closest('.tagbar')) {
        const i = S.filters.tags.indexOf(tag);
        if (i >= 0) S.filters.tags.splice(i, 1); else S.filters.tags.push(tag);
      } else {
        S.filters.tags = [tag];
      }
      render();
      break;
    }
    case 'clear-tags':
      S.filters.tags = [];
      render();
      break;
    case 'sync': {
      if (!engine) { toast('先连接仓库', 'warn'); S.drawer = true; render(); return; }
      const r = await engine.refresh();
      if (r?.skipped) toast('正在刷新，请稍候', 'info', 1500);
      else if (r?.status === 304) toast('已是最新内容', 'info', 1800);
      else if (r?.status === 200) toast('已取到最新内容', 'ok', 1800);
      break;
    }
    case 'push':
      await pushNow();
      break;
    case 'merge':
      await mergeRemote();
      break;
    case 'theme': {
      const i = THEMES.findIndex((x) => x.key === (S.cfg.theme || 'auto'));
      S.cfg.theme = THEMES[(i + 1) % THEMES.length].key;
      applyTheme();
      persistCfgOnly();
      render();
      toast(`主题：${themeLabel()}`, 'info', 1500);
      break;
    }
    case 'drawer':
      S.drawer = true;
      render();
      break;
    case 'drawer-close':
      S.drawer = false;
      render();
      break;
    case 'save-cfg': {
      S.cfg.owner = $('#cfg-owner').value.trim();
      S.cfg.repo = $('#cfg-repo').value.trim();
      S.cfg.branch = $('#cfg-branch').value.trim() || 'main';
      S.cfg.path = $('#cfg-path').value.trim() || 'todo.md';
      S.cfg.autoPush = $('#cfg-autopush').checked;
      const tk = $('#cfg-token').value.trim();
      if (tk) saveToken(tk);
      persist();
      S.drawer = false;
      rebuildEngine();
      render();
      toast(configured() ? '已连接，正在拉取最新内容…' : '请填写 owner 与 repo', configured() ? 'ok' : 'warn');
      break;
    }
    case 'probe': {
      const owner = $('#cfg-owner').value.trim();
      const repo = $('#cfg-repo').value.trim();
      if (!owner || !repo) { toast('先填 owner 与 repo', 'warn'); return; }
      const tk = $('#cfg-token').value.trim() || loadToken() || null;
      try {
        const c = createClient({ owner, repo, path: $('#cfg-path').value.trim() || 'todo.md', branch: $('#cfg-branch').value.trim() || 'main' });
        const r = await c.probe({ token: tk });
        toast(r.ok
          ? `连通 · ${r.private ? '私有' : '公开'}仓库 · 默认分支 ${r.defaultBranch}`
          : `失败 HTTP ${r.status}（检查仓库名或 token 权限）`, r.ok ? 'ok' : 'err', 4200);
      } catch (err) {
        toast(err.message || '连接失败', 'err');
      }
      break;
    }
    case 'copy-link': {
      if (!configured()) { toast('先在设置里填入仓库信息', 'warn'); return; }
      const url = shareUrl();
      const ok = await copyText(url);
      const local = location.protocol === 'file:';
      toast(
        !ok ? `复制失败，手动拷贝：${url}`
          : local ? '已复制（本地文件路径只在同机同路径有效，部署到 Pages 才是跨设备链接）'
            : '已复制，换设备打开即自动连上',
        ok && !local ? 'ok' : 'warn', 5200,
      );
      break;
    }
    case 'reset-local': {
      if (!confirm('清空本地缓存并重新从 GitHub 拉取？（未推送的改动会丢失）')) return;
      try {
        localStorage.removeItem(LS.work);
        localStorage.removeItem(LS.base);
      } catch { /* ignore */ }
      S.workSrc = ''; S.remoteSrc = ''; S.remoteNewer = false;
      rebuildEngine();
      toast('已清空，等待同步', 'ok');
      break;
    }
    default:
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    S.filters.q = e.target.value;
    renderListOnly();
  }
});

function commitEdit(id, raw) {
  const t = S.doc.tasks.find((x) => x.id === id);
  S.editingId = null;
  const val = String(raw || '').trim();
  if (!val || !t) { render(); return; }
  const parsed = parseInline(val, t.group);
  mutate((src) => updateTask(src, id, {
    title: parsed.title || t.title,
    tags: parsed.tags,
    due: parsed.due,
    priority: parsed.priority,
    doneAt: t.doneAt, // 编辑不应抹掉完成日期
  }));
}

document.addEventListener('keydown', (e) => {
  if (e.target.classList?.contains('edit')) {
    if (e.key === 'Enter') {
      commitEdit(e.target.dataset.id, e.target.value);
    } else if (e.key === 'Escape') {
      S.editingId = null;
      render();
    }
  }
  if (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName)) {
    e.preventDefault();
    $('#q')?.focus();
  }
});

// 点走焦点也算确认，避免编辑框永久停留
document.addEventListener('focusout', (e) => {
  if (!e.target.classList?.contains('edit')) return;
  const id = e.target.dataset.id;
  if (S.editingId !== id) return; // Enter/Esc 已处理
  commitEdit(id, e.target.value);
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'composer') return;
  e.preventDefault();
  const input = $('#new-title');
  const raw = input.value.trim();
  if (!raw) return;

  let group = $('#new-group').value;
  if (group === '__new') {
    group = prompt('新分组名称') || '收件箱';
  }
  const parsed = parseInline(raw, group);
  if (!parsed.title) { toast('标题不能为空', 'warn'); return; }

  mutate((src) => addTask(src, {
    group, title: parsed.title, tags: parsed.tags, due: parsed.due, priority: parsed.priority,
  }));
  input.value = '';
  input.focus();
});

/* ----------------------------------------------------------------- boot */

loadLocal();
const cfgedFromUrl = applyUrlCfg();
applyTheme(); // 先落主题属性再渲染，避免浅色用户在深色底上闪一下
rebuildEngine();
render();
if (cfgedFromUrl) toast('已按链接参数连接仓库', 'ok');

window.__todo = { S, pushNow, mergeRemote, urlCfgFrom, shareUrl, applyUrlCfg }; // 便于自检脚本驱动
