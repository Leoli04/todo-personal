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

  // —— 3. 搜索
  report.search = await ev(`(() => {
    const set = (v) => {
      const q = document.querySelector('#q');
      q.value = v;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('空调');
    const filtered = document.querySelectorAll('.task').length;
    const inputKept = !!document.querySelector('#q');
    set('');
    return {
      filtered, restored: document.querySelectorAll('.task').length,
      qState: window.__todo.S.filters.q, inputKept,
      sameNode: document.querySelector('#q') === document.querySelector('#q'),
    };
  })()`);

  // —— 4. 标签筛选
  report.tagFilter = await ev(`(() => {
    const chip = [...document.querySelectorAll('.tagbar .tag')].find(b => b.dataset.tag === '家事');
    if (!chip) return { error: 'no chip' };
    chip.click();
    const n = document.querySelectorAll('.task').length;
    const allHome = [...document.querySelectorAll('.task')].every(el => {
      const t = window.__todo.S.doc.tasks.find(x => x.id === el.dataset.id);
      return t && t.tags.includes('家事');
    });
    document.querySelector('[data-act="clear-tags"]')?.click();
    return { filtered: n, allHome, restored: document.querySelectorAll('.task').length, tags: [...window.__todo.S.filters.tags] };
  })()`);

  // —— 4.5 重置筛选，确保后续断言看到全量
  report.resetFilters = await ev(`(() => {
    const S = window.__todo.S;
    S.filters.q = ''; S.filters.tags = []; S.filters.group = '';
    document.querySelector('[data-status="open"]').click();
    return { tasks: document.querySelectorAll('.task').length, q: S.filters.q, tags: S.filters.tags };
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

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  chrome.kill();
})().catch((e) => { console.log('FATAL: ' + e.stack); process.exit(1); });
