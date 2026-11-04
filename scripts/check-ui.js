// CDP 复核：Todo 页面真实渲染 + 交互。同进程完成 启动 → 载入 → 交互 → 截图 → 关闭
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 路径全部相对本文件推导，目录改名或换机器 clone 都不用改脚本
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH
  || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  || '';
const FILE = 'file:///' + path.resolve(ROOT, 'dist/index.html').replace(/\\/g, '/');
const OUT = path.resolve(ROOT, '_shots');
const PORT = 9433;

if (!CHROME || !fs.existsSync(CHROME)) {
  console.log('ERROR: 找不到 Chrome，可用环境变量 CHROME_PATH 指定路径');
  process.exit(1);
}

const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=C:/Users/MrLi/AppData/Local/Temp/cr-todo-check',
    '--window-size=1280,1200', '--force-device-scale-factor=1', 'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const j = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)); if (j.length) { list = j; break; } } catch (e) { /* retry */ }
  }
  if (!list) { console.log('ERROR: 无法连接 Chrome'); chrome.kill(); process.exit(1); }

  const target = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await new Promise((r) => ws.addEventListener('open', r));

  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true });
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: FILE });
  await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };

  const report = {};
  const save = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  // 清掉上一轮遗留的 localStorage（同一个 user-data-dir 会累积），保证从示例数据起步
  await ev(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`);
  await send('Page.reload', {});
  await sleep(1400);

  // —— 1. 首屏结构
  report.boot = await ev(`(() => {
    const se = document.scrollingElement;
    return {
      hasApp: !!document.querySelector('#app'),
      tasks: document.querySelectorAll('.task').length,
      groups: document.querySelectorAll('.group').length,
      totalParsed: window.__todo ? window.__todo.S.doc.tasks.length : -1,
      openCount: document.querySelector('.stat b')?.textContent,
      hOverflow: se.scrollWidth - se.clientWidth,
      title: document.querySelector('.brand h1')?.textContent,
    };
  })()`);

  // —— 2. 勾选一个任务（第一个 checkbox）
  report.toggle = await ev(`(() => {
    const before = window.__todo.S.doc.tasks.filter(t => t.checked).length;
    const firstOpen = [...document.querySelectorAll('.task')].find(el => !el.classList.contains('task--done'));
    const id = firstOpen.dataset.id;
    firstOpen.querySelector('.check').click();
    const S = window.__todo.S;
    const t = S.doc.tasks.find(x => x.id === id);
    return {
      id, checked: t.checked, hasDoneTag: /@done\\(/.test(S.workSrc),
      doneBefore: before, doneAfter: S.doc.tasks.filter(x => x.checked).length,
      dirty: S.workSrc !== S.remoteSrc,
      renderedDone: document.querySelectorAll('.task--done').length,
      bannerShown: !!document.querySelector('.banner--draft'),
      firstLine: S.workSrc.split('\\n').find(l => l.includes(id)),
    };
  })()`);

  // —— 3. 搜索（关键词与期望值都从真实数据推导，不写死示例内容）
  report.search = await ev(`(() => {
    document.querySelector('[data-status="all"]').click();
    const S = window.__todo.S;
    const set = (v) => {
      const q = document.querySelector('#q');
      q.value = v;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const hay = (t) => (t.title + ' ' + t.tags.join(' ') + ' ' + t.group).toLowerCase();
    const longest = S.doc.tasks.map(t => t.title).sort((a, b) => b.length - a.length)[0] || '';
    const needle = longest.slice(0, 4);
    const expected = S.doc.tasks.filter(t => hay(t).includes(needle.toLowerCase())).length;
    set(needle);
    const filtered = document.querySelectorAll('.task').length;
    const inputKept = !!document.querySelector('#q');
    set('');
    return {
      needle, expected, filtered,
      restored: document.querySelectorAll('.task').length,
      qState: window.__todo.S.filters.q, inputKept,
    };
  })()`);

  // —— 4. 标签筛选（取数据里最高频的标签，避免依赖「家事」这类示例词）
  report.tagFilter = await ev(`(() => {
    const S = window.__todo.S;
    const freq = {};
    S.doc.tasks.forEach(t => t.tags.forEach(x => { freq[x] = (freq[x] || 0) + 1; }));
    const tag = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    if (!tag) return { error: 'no tag in data' };
    const chip = [...document.querySelectorAll('.tagbar .tag')].find(b => b.dataset.tag === tag);
    if (!chip) return { error: 'chip not found', tag };
    chip.click();
    const n = document.querySelectorAll('.task').length;
    const all = [...document.querySelectorAll('.task')].every(el => {
      const t = S.doc.tasks.find(x => x.id === el.dataset.id);
      return t && t.tags.includes(tag);
    });
    const expected = S.doc.tasks.filter(t => t.tags.includes(tag)).length;
    document.querySelector('[data-act="clear-tags"]')?.click();
    return { tag, expected, filtered: n, all, restored: document.querySelectorAll('.task').length };
  })()`);

  // —— 4.5 重置筛选，确保后续断言看到全量
  report.resetFilters = await ev(`(() => {
    const S = window.__todo.S;
    S.filters.q = ''; S.filters.tags = []; S.filters.group = '';
    document.querySelector('[data-status="open"]').click();
    return { tasks: document.querySelectorAll('.task').length, q: S.filters.q, tags: S.filters.tags };
  })()`);

  // —— 4.6 长标题布局：真实数据里最长的几条（如「读《…》」类条目）量一次包围盒
  report.wrap = await ev(`(() => {
    const rows = [...document.querySelectorAll('.task')].filter(el => {
      const t = window.__todo.S.doc.tasks.find(x => x.id === el.dataset.id);
      return t && t.title.length > 30;
    });
    const bad = [];
    for (const el of rows) {
      const main = el.querySelector('.task-main');
      const title = el.querySelector('.task-title');
      const meta = el.querySelector('.task-meta');
      if (!main || !title) continue;
      const label = title.textContent.slice(0, 18);
      const tr = title.getBoundingClientRect();
      const box = main.getBoundingClientRect();
      const over = title.scrollWidth - title.clientWidth;
      if (over > 1) bad.push({ reason: 'h-overflow', over, label });
      if (tr.right > box.right + 1) bad.push({ reason: 'out-of-box', label });
      if (meta && meta.getBoundingClientRect().top < tr.bottom - 1) bad.push({ reason: 'meta-overlap', label });
    }
    return { checked: rows.length, bad };
  })()`);

  // —— 5. 新增任务（含自然语言解析）
  report.add = await ev(`(() => {
    const before = window.__todo.S.doc.tasks.length;
    const input = document.querySelector('#new-title');
    input.value = 'CDP 验证任务 #测试 @due(2026-12-01) !p2';
    document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const S = window.__todo.S;
    const t = S.doc.tasks.find(x => x.title === 'CDP 验证任务');
    return {
      totalBefore: before, totalAfter: S.doc.tasks.length,
      created: !!t, tags: t?.tags, due: t?.due, prio: t?.priority, group: t?.group,
      line: S.workSrc.split('\\n').find(l => l.includes('CDP 验证任务')),
      domShown: document.querySelectorAll('.task').length,
    };
  })()`);

  // —— 5.5 行内编辑：点标题 → 改文字 → 回车
  report.edit = await ev(`(() => {
    const S = window.__todo.S;
    const target = S.doc.tasks.find(t => t.title.includes('CDP'));
    const row = document.querySelector('.task[data-id="' + target.id + '"]');
    if (!row) return { skipped: true };
    row.querySelector('.task-title').click();
    const input = document.querySelector('.edit');
    if (!input) return { skipped: true, reason: 'no-input' };
    const focused = document.activeElement === input;
    input.value = '改过的标题 #改';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const after = S.doc.tasks.find(t => t.id === target.id);
    return {
      focused, title: after && after.title, tags: after && after.tags,
      line: S.workSrc.split('\\n').find(l => l.includes('改过的标题')),
      editClosed: !document.querySelector('.edit'),
    };
  })()`);
  save();

  // —— 6. 看板视图
  save();
  report.board = await ev(`(() => {
    document.querySelector('[data-view="board"]').click();
    const cols = document.querySelectorAll('.col');
    const out = { cols: cols.length, perCol: [...cols].map(c => c.querySelectorAll('.task').length) };
    document.querySelector('[data-view="list"]').click();
    return out;
  })()`);

  // —— 7. 设置抽屉
  report.drawer = await ev(`(() => {
    document.querySelector('[data-act="drawer"]').click();
    const d = document.querySelector('.drawer');
    const fields = [...document.querySelectorAll('.drawer input, .drawer select')].map(e => e.id);
    const r = d ? d.getBoundingClientRect() : null;
    const foot = document.querySelector('.drawer-foot');
    const links = document.querySelectorAll('.foot-links .link');
    const fr = foot ? foot.getBoundingClientRect() : null;
    const overflowLinks = foot ? Math.max(0, Math.round(foot.scrollWidth - foot.clientWidth)) : -1;
    const cs = d ? getComputedStyle(d) : null;
    return {
      open: !!d, fields, width: r && Math.round(r.width),
      bg: cs && cs.backgroundColor, surfaceVar: cs && cs.getPropertyValue('--surface').trim(),
      darkMedia: matchMedia('(prefers-color-scheme: dark)').matches,
      footH: fr && Math.round(fr.height), linkCount: links.length,
      footOverflow: overflowLinks,
      footText: foot ? foot.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);
  await sleep(260);
  // 抽屉是 fixed 定位，只在视口内截图才不会被 captureBeyondViewport 拼歪
  let shotDrawer = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, 'todo-drawer.png'), Buffer.from(shotDrawer.data, 'base64'));
  await ev(`document.querySelector('[data-act="drawer-close"]').click()`);
  await sleep(120);

  // —— 8. 删除（confirm 自动接受）
  report.remove = await ev(`(async () => {
    const S = window.__todo.S;
    const target = S.doc.tasks.find(t => t.title === '改过的标题' || t.title.includes('CDP'));
    if (!target) return { skipped: true, titles: S.doc.tasks.map(t => t.title) };
    const before = S.doc.tasks.length;
    const el = document.querySelector('.task[data-id="' + target.id + '"]');
    if (!el) return { skipped: true, reason: 'dom-missing', id: target.id };
    el.querySelector('.task-del').click();
    await new Promise(r => setTimeout(r, 150));
    return { before, after: S.doc.tasks.length, gone: !S.doc.tasks.some(t => t.id === target.id) };
  })()`);
  save();

  // —— 9. 三态：撤销勾选后 dirty 仍成立（因为做过删除），确认本地持久化
  report.persist = await ev(`(() => {
    try { return { work: !!localStorage.getItem('todo-gh:work'), base: !!localStorage.getItem('todo-gh:base') }; }
    catch (e) { return { error: String(e) }; }
  })()`);

  report.logs = logs;

  // —— 截图：dark
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(280);
  let shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'todo-dark.png'), Buffer.from(shot.data, 'base64'));

  // —— 截图：light
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(280);
  shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'todo-light.png'), Buffer.from(shot.data, 'base64'));

  // —— 移动端 375
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(320);
  const mobile = await ev(`(() => {
    const se = document.scrollingElement;
    return { hOverflow: se.scrollWidth - se.clientWidth, composerBottom: Math.round(document.querySelector('.composer').getBoundingClientRect().bottom), vh: innerHeight };
  })()`);
  report.mobile = mobile;
  shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'todo-mobile.png'), Buffer.from(shot.data, 'base64'));

  // —— 10. 链接即配置：先验纯函数，再真导航一次
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  report.urlCfg = await ev(`(() => {
    const f = window.__todo.urlCfgFrom;
    return {
      full: f('?repo=leoli04/repocensus&path=docs/todo.md', ''),
      hash: f('', '#repo=leoli04/repocensus&branch=dev'),
      nameOnly: f('', '#repo=onlyname&owner=someone'),
      hashOverSearch: f('?repo=a/b', '#branch=hotfix'),
      empty: f('', ''),
    };
  })()`);

  // 只有 fragment 变化时 Chrome 不会重载页面，必须先离场再进，模拟「新设备首次打开链接」
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: FILE + '#repo=leoli04/todo-demo&branch=dev&path=docs/t.md' });
  await sleep(1300);
  report.urlNav = await ev(`(() => {
    const S = window.__todo && window.__todo.S;
    if (!S) return { error: 'no __todo' };
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('todo-gh:config') || 'null'); } catch (e) {}
    return {
      owner: S.cfg.owner, repo: S.cfg.repo, branch: S.cfg.branch, path: S.cfg.path,
      hashCleared: location.hash === '',
      share: window.__todo.shareUrl(),
      persisted: saved && saved.owner === 'leoli04',
      demoBannerGone: !document.querySelector('.banner--demo'),
      headerRepo: document.querySelector('.sub')?.textContent || '',
      // 仓库不存在/不可达时不能显示「刚刚同步过」
      lastOkAt: (S.sync || {}).lastOkAt || 0,
      phase: (S.sync || {}).phase || '',
    };
  })()`);
  shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'todo-urlcfg.png'), Buffer.from(shot.data, 'base64'));

  // —— 11. 断言：把「人工看 JSON」变成能卡住 CI 的硬校验
  const fails = [];
  let total = 0;
  const check = (name, cond, detail) => {
    total++;
    if (!cond) fails.push(name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  };
  const R = report;

  check('首屏：应用挂载且有数据', R.boot.hasApp && R.boot.totalParsed > 0, R.boot);
  check('首屏：无横向溢出', R.boot.hOverflow === 0, R.boot.hOverflow);
  check('勾选：状态翻转', R.toggle.checked === true, R.toggle);
  check('勾选：写入 @done', R.toggle.hasDoneTag === true, R.toggle.firstLine);
  check('勾选：只落草稿、不自动推送', R.toggle.dirty === true && R.toggle.bannerShown === true, R.toggle);
  check('搜索：命中数与数据一致', R.search.filtered === R.search.expected, R.search);
  check('搜索：清空后恢复全量', R.search.restored === R.boot.totalParsed && R.search.qState === '', R.search);
  check('标签：只留命中项', R.tagFilter.all === true && R.tagFilter.filtered === R.tagFilter.expected, R.tagFilter);
  check('新增：落地到数据源', R.add.created === true && R.add.totalAfter === R.add.totalBefore + 1, R.add);
  check('新增：自然语言解析正确',
    Array.isArray(R.add.tags) && R.add.tags.includes('测试') && R.add.due === '2026-12-01' && R.add.prio === 2, R.add);
  check('编辑：标题与标签一起生效',
    R.edit.title === '改过的标题' && Array.isArray(R.edit.tags) && R.edit.tags.includes('改') && R.edit.editClosed === true, R.edit);
  check('看板：分列渲染', R.board.cols >= 2 && R.board.perCol.some((n) => n > 0), R.board);
  check('抽屉：两个链接一行放下',
    R.drawer.open === true && R.drawer.linkCount === 2 && R.drawer.footOverflow === 0, R.drawer);
  check('删除：数据源同步移除', R.remove.gone === true && R.remove.after === R.remove.before - 1, R.remove);
  check('持久化：草稿与基线都落本地', R.persist.work === true && R.persist.base === true, R.persist);
  check('长标题：不溢出、不与元信息重叠', R.wrap.bad.length === 0, R.wrap);
  check('移动端 375：无横向溢出', R.mobile.hOverflow === 0, R.mobile);
  check('链接即配置：三种输入形态',
    R.urlCfg.full.repo === 'repocensus' && R.urlCfg.hash.branch === 'dev' && R.urlCfg.nameOnly.owner === 'someone', R.urlCfg);
  check('链接即配置：真导航后写盘并清 hash',
    R.urlNav.hashCleared === true && R.urlNav.persisted === true && R.urlNav.demoBannerGone === true, R.urlNav);
  // 仓库不可达（404）时不能显示「刚刚同步过」；若该仓库真实存在则跳过此断言
  check('错误态：不谎报已同步', R.urlNav.phase !== 'error' || R.urlNav.lastOkAt === 0, { phase: R.urlNav.phase, lastOkAt: R.urlNav.lastOkAt });
  check('console 无错误', R.logs.length === 0, R.logs);

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(fails.length ? `UI FAIL:\n- ${fails.join('\n- ')}` : `UI passed ${total}/${total}（长标题 ${R.wrap.checked} 条已量）`);
  chrome.kill();
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.log('FATAL: ' + e.stack); process.exit(1); });
