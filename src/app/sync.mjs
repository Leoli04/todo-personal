/**
 * sync.mjs —— 按需拉取（不做定时轮询）
 *
 * 设计前提：GitHub 上改 todo.md 会触发 Pages 重新部署，部署完页面本身没变，
 * 变的是它要读的数据。所以「拿到最新数据」只需要一件事：**点刷新时拉一次**。
 * 定时器、退避、可见性自动补拉全部去掉 —— 它们只在需要「后台保持最新」时才成立。
 *
 * 保留的只有两件仍有价值的事：
 *  - ETag 条件请求：第二次刷新大概率 304，省流量；带 token 时 304 还不计配额
 *  - 错误分型：离线 / 配额耗尽 / 被要求重试 / 文件不存在，分别给人话提示
 *
 * 不碰数据内容，也不碰 DOM（便于在 Node 里用假 client 直接单测）。
 */

export function createSyncEngine({ client, getToken, onData, onStatus }) {
  let etag = null;
  let running = false;
  let phase = 'idle'; // idle | syncing | ok | not-modified | error | offline | ratelimited
  let lastOkAt = 0;
  let rate = null;
  let lastError = '';

  const emit = () => onStatus?.({ phase, lastOkAt, rate, error: lastError });

  function setPhase(p, err = '') {
    phase = p;
    lastError = err;
    emit();
  }

  /**
   * 拉一次。并发调用会被合并（第二次直接返回 skipped），
   * 避免用户连点刷新把配额打光。
   * @returns {Promise<{status?:number, skipped?:boolean, error?:string}>}
   */
  async function refresh() {
    if (running) return { skipped: true };
    running = true;
    setPhase('syncing');

    try {
      const res = await client.read({ etag, token: getToken() || null, wantSha: false });
      rate = res.rate || rate;

      if (res.status === 304) {
        // 内容没变，但「确实连上了」——记时间，别谎报失败
        lastOkAt = Date.now();
        setPhase('not-modified');
        return { status: 304 };
      }
      if (res.status === 200) {
        lastOkAt = Date.now();
        etag = res.etag || null;
        await onData(res.content, { etag, rate });
        setPhase('ok');
        return { status: 200 };
      }
      if (res.status === 404) {
        // 不能记 lastOkAt：否则界面显示「刚刚刷新过」，实际什么都没读到
        setPhase('error', '文件不存在（检查 repo / branch / path）');
        return { status: 404 };
      }
      setPhase('error', `HTTP ${res.status}`);
      return { status: res.status };
    } catch (e) {
      if (e.name === 'GitHubError' && e.rate) rate = e.rate;
      const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || e.status === 0;
      if (offline) setPhase('offline', '离线');
      else if (e.rate && e.rate.remaining === 0) setPhase('ratelimited', '配额已用尽，等重置');
      else if (e.rate?.retryAfter) setPhase('ratelimited', `被要求 ${e.rate.retryAfter}s 后重试`);
      else setPhase('error', e.message || '刷新失败');
      return { error: e.message || 'refresh failed' };
    } finally {
      running = false;
    }
  }

  /** 首屏、改配置、清缓存后调用：语义上等同刷新，单独命名便于阅读 */
  function load() {
    return refresh();
  }

  /** 写回成功后调用：更新 ETag 与时间，避免马上又拉一次 */
  function markPushed(newEtag = null) {
    if (newEtag) etag = newEtag;
    lastOkAt = Date.now();
    setPhase('ok');
  }

  function resetEtag() {
    etag = null;
  }

  return {
    load,
    refresh,
    markPushed,
    resetEtag,
    state: () => ({ phase, etag, rate, lastOkAt, error: lastError }),
  };
}
