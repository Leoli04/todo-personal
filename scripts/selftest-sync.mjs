/**
 * selftest-sync.mjs —— 按需刷新引擎的机器校验。不依赖网络、不依赖 DOM。
 * 跑法：node scripts/selftest-sync.mjs
 *
 * 为什么单独一套：删掉定时轮询后，sync.mjs 变成了「调一次、返回一次结果」的纯逻辑，
 * 正好可以用假 client 把 200 / 304 / 404 / 离线 / 配额耗尽 / 并发去重全部覆盖到，
 * 不需要真的去打 GitHub。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSyncEngine } from '../src/app/sync.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ' :: ' + extra : ''}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

/** 假 client：按脚本返回预设结果，并记录每次 read 的入参 */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    read(opts) {
      calls.push(opts || {});
      const next = script.shift();
      if (!next) throw new Error('fakeClient: 脚本用完了');
      if (next instanceof Error) return Promise.reject(next);
      if (typeof next === 'function') return next(opts);
      return Promise.resolve(next);
    },
  };
}

function engineWith(script, hooks = {}) {
  const client = fakeClient(script);
  const seen = [];
  const data = [];
  const engine = createSyncEngine({
    client,
    getToken: hooks.getToken || (() => 'tok'),
    onData: (content) => { data.push(content); },
    onStatus: (st) => { seen.push(st.phase); },
  });
  return { engine, client, seen, data };
}

/* ------------------------------------------------- 1. 首次拉取（200） */

{
  const { engine, client, seen, data } = engineWith([
    { status: 200, content: '# t\n', etag: 'W/"a"', rate: { limit: 60, remaining: 58, reset: 0 } },
  ]);
  const r = await engine.refresh();

  eq('200：返回状态码', r.status, 200);
  eq('200：内容交给 onData', data[0], '# t\n');
  eq('200：phase 落 ok', engine.state().phase, 'ok');
  eq('200：ETag 记住', engine.state().etag, 'W/"a"');
  ok('200：记下成功时间', engine.state().lastOkAt > 0);
  eq('200：配额被记录', engine.state().rate.remaining, 58);
  ok('200：状态通知经历 syncing → ok', seen.includes('syncing') && seen.at(-1) === 'ok', seen.join('>'));
  eq('200：首次不带 If-None-Match', client.calls[0].etag, null);
  eq('200：只读形态不带 sha 需求', client.calls[0].wantSha, false);
  eq('200：带 token', client.calls[0].token, 'tok');
}

/* ------------------------------------------------- 2. 再拉一次（304） */

{
  const { engine, client, seen } = engineWith([
    { status: 200, content: 'v1', etag: 'W/"b"' },
    { status: 304, rate: { limit: 5000, remaining: 4990, reset: 0 } },
  ]);
  await engine.refresh();
  const before = engine.state().lastOkAt;
  await engine.refresh();

  eq('304：phase 落 not-modified', engine.state().phase, 'not-modified');
  eq('304：第二次带上 ETag', client.calls[1].etag, 'W/"b"');
  ok('304：仍算「连上了」，时间被更新', engine.state().lastOkAt >= before);
  ok('304：没有把 304 当失败', !seen.includes('error'), seen.join('>'));
}

/* ------------------------------------------------- 3. 文件不存在（404） */

{
  const { engine } = engineWith([{ status: 404 }]);
  const r = await engine.refresh();
  eq('404：返回状态码', r.status, 404);
  eq('404：phase 落 error', engine.state().phase, 'error');
  ok('404：错误信息点明路径问题', /文件不存在/.test(engine.state().error || ''), engine.state().error);
  eq('404：不谎报成功时间', engine.state().lastOkAt, 0);
}

/* ------------------------------------------------- 4. 离线与配额耗尽 */

{
  const err = Object.assign(new Error('Failed to fetch'), { status: 0 });
  const { engine } = engineWith([err]);
  await engine.refresh();
  eq('离线：phase 落 offline', engine.state().phase, 'offline');
}

{
  const err = Object.assign(new Error('API rate limit exceeded'), {
    name: 'GitHubError', status: 403, rate: { limit: 60, remaining: 0, reset: 0 },
  });
  const { engine } = engineWith([err]);
  await engine.refresh();
  eq('配额：phase 落 ratelimited', engine.state().phase, 'ratelimited');
  ok('配额：提示等重置', /等重置/.test(engine.state().error || ''), engine.state().error);
}

{
  const err = Object.assign(new Error('secondary rate limit'), {
    name: 'GitHubError', status: 403, rate: { retryAfter: 30 },
  });
  const { engine } = engineWith([err]);
  await engine.refresh();
  eq('retry-after：仍是 ratelimited', engine.state().phase, 'ratelimited');
  ok('retry-after：提示秒数', /30/.test(engine.state().error || ''), engine.state().error);
}

/* ------------------------------------------------- 5. 并发去重 */

{
  let release;
  const gate = new Promise((r) => { release = r; });
  const { engine, client } = engineWith([
    (opts) => gate.then(() => ({ status: 200, content: 'x', etag: 'W/"c"' })),
  ]);
  const first = engine.refresh();
  const second = await engine.refresh();      // 还在飞，应当被合并
  eq('并发：第二次被跳过', second.skipped, true);
  eq('并发：只发了一次请求', client.calls.length, 1);
  release();
  await first;
  eq('并发：第一次正常完成', engine.state().phase, 'ok');
}

/* ------------------------------------------------- 6. markPushed / resetEtag */

{
  const { engine, client } = engineWith([
    { status: 200, content: 'v1', etag: 'W/"d"' },
    { status: 200, content: 'v2', etag: 'W/"e"' },
  ]);
  await engine.refresh();
  engine.markPushed('W/"written"');
  eq('写回后：phase 置 ok', engine.state().phase, 'ok');
  eq('写回后：ETag 用写入结果', engine.state().etag, 'W/"written"');
  await engine.refresh();
  eq('写回后：下次读带新 ETag', client.calls[1].etag, 'W/"written"');

  engine.resetEtag();
  eq('重置后：ETag 清空', engine.state().etag, null);
}

/* ------------------------------------------------- 7. 源码层面：没有定时器 */

{
  const src = readFileSync(resolve(__dir, '../src/app/sync.mjs'), 'utf8');
  ok('源码：无 setInterval', !/setInterval/.test(src));
  ok('源码：无 setTimeout', !/setTimeout/.test(src));
  ok('源码：无自动补拉（visibilitychange）', !/visibilitychange/.test(src));
  ok('源码：不直接摸 DOM', !/document\./.test(src));
  const api = Object.keys(createSyncEngine({
    client: { read: () => Promise.resolve({ status: 304 }) },
    getToken: () => null, onData: () => {},
  })).sort().join(',');
  eq('API 面：只暴露按需调用', api, 'load,markPushed,refresh,resetEtag,state');}

/* ---------------------------------------------------------------- 汇总 */

const total = pass + fails.length;
const lines = [
  `passed ${pass}/${total}`,
  ...fails.map((f) => 'FAIL ' + f),
];
process.stdout.write(lines.join('\n') + '\n');
process.exit(fails.length ? 1 : 0);
