/**
 * sync.mjs —— 同步调度器
 *
 * 只负责「什么时候去拉、拉失败怎么办」，不碰数据内容。
 *
 * 退避规则（按 GitHub 官方 best practice + 实测配额行为）：
 *  - 连续失败：2s → 4s → 8s … 上限 5min
 *  - 配额耗尽（403 + remaining=0）：等到 x-ratelimit-reset，期间不重试
 *  - retry-after 存在：优先服从
 *  - 未认证且剩余配额 < 10：把轮询间隔拉长到「剩余配额撑到重置」的安全值
 *  - 页面隐藏：停表；重新可见且距上次 >15s：立即同步
 */

const MAX_BACKOFF = 5 * 60 * 1000;

export function createSyncEngine({ client, getToken, onData, onStatus, intervalMs = 120000 }) {
  let timer = null;
  let stopped = true;
  let running = false;
  let failures = 0;
  let etag = null;
  let lastOkAt = 0;
  let lastCheckAt = 0;
  let nextAt = 0;
  let rate = null;
  let phase = 'idle'; // idle | syncing | ok | not-modified | error | offline | ratelimited
  let lastError = '';
  let effectiveInterval = intervalMs;

  const emit = () => {
    onStatus?.({
      phase, lastOkAt, lastCheckAt, nextAt, rate, error: lastError,
      failures, interval: effectiveInterval,
    });
  };

  function setPhase(p, err = '') {
    phase = p;
    lastError = err;
    emit();
  }

  /** 依据配额把间隔调到「不会在重置前打光」的值 */
  function adaptInterval(r) {
    if (!r || r.limit !== 60 || r.remaining === null) { effectiveInterval = intervalMs; return; }
    const now = Math.floor(Date.now() / 1000);
    const left = Math.max(30, (r.reset || now + 3600) - now);
    if (r.remaining <= 3) { effectiveInterval = left * 1000; return; }
    // 留 20% 余量给写回和手动刷新
    const budget = Math.max(1, Math.floor(r.remaining * 0.8));
    effectiveInterval = Math.max(intervalMs, Math.ceil((left / budget) * 1000));
  }

  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    nextAt = Date.now() + delay;
    timer = setTimeout(tick, delay);
    emit();
  }

  async function tick({ force = false } = {}) {
    if (running) return;
    if (!force && document.visibilityState === 'hidden') { schedule(effectiveInterval); return; }
    running = true;
    setPhase('syncing');
    lastCheckAt = Date.now();

    try {
      const res = await client.read({ etag, token: getToken() || null, wantSha: false });
      rate = res.rate || rate;
      // 服务器答话了，就算网络通畅（404 是「路径不对」，不是断网）
      failures = 0;

      if (res.status === 304) {
        lastOkAt = Date.now();
        setPhase('not-modified');
        adaptInterval(rate);
      } else if (res.status === 200) {
        lastOkAt = Date.now();
        etag = res.etag || null;
        await onData(res.content, { etag, rate });
        setPhase('ok');
        adaptInterval(rate);
      } else if (res.status === 404) {
        // 不能记 lastOkAt：否则界面会显示「刚刚同步过」，实际什么都没读到
        setPhase('error', '文件不存在（检查 repo / branch / path）');
        effectiveInterval = MAX_BACKOFF;
      }
      schedule(effectiveInterval);
    } catch (e) {
      failures += 1;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (e.name === 'GitHubError' && e.rate) rate = e.rate;

      if (offline || e.status === 0) {
        setPhase('offline', '离线');
        schedule(Math.min(5000 * failures, MAX_BACKOFF));
      } else if (e.rate && e.rate.remaining === 0) {
        const wait = Math.max(60, ((e.rate.reset || 0) * 1000) - Date.now());
        setPhase('ratelimited', '配额用尽，等待重置');
        effectiveInterval = wait;
        schedule(wait);
      } else if (e.rate?.retryAfter) {
        const wait = e.rate.retryAfter * 1000;
        setPhase('ratelimited', `被要求 ${e.rate.retryAfter}s 后重试`);
        schedule(wait);
      } else {
        setPhase('error', e.message || '同步失败');
        schedule(Math.min(2000 * 2 ** (failures - 1), MAX_BACKOFF));
      }
    } finally {
      running = false;
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && !stopped) {
      if (Date.now() - lastCheckAt > 15000) tick({ force: true });
      else schedule(Math.max(1000, nextAt - Date.now()));
    }
  }

  function onOnline() {
    if (!stopped) { failures = 0; tick({ force: true }); }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    tick({ force: true });
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
  }

  function syncNow() {
    return tick({ force: true });
  }

  /** 写回成功后调用，避免立刻又拉一次 */
  function markPushed(newEtag = null) {
    if (newEtag) etag = newEtag;
    lastOkAt = Date.now();
    failures = 0;
    setPhase('ok');
    schedule(effectiveInterval);
  }

  function resetEtag() { etag = null; }

  return { start, stop, syncNow, markPushed, resetEtag, setInterval: (ms) => { intervalMs = ms; effectiveInterval = ms; }, state: () => ({ phase, etag, rate }) };
}
