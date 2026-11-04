/**
 * github.mjs —— GitHub Contents API 的浏览器客户端
 *
 * 所有行为都来自 2026-11-04 的实测，不要凭印象改：
 *  - api.github.com 回 `Access-Control-Allow-Origin: *`，且预检允许
 *    PUT/PATCH/DELETE + Authorization 头 → 浏览器可直连读 **和写**。
 *  - 未认证配额 60 次/小时/IP；**304 仍然计费**（认证后才免），
 *    所以「用 ETag 省配额」只在带 token 时成立。
 *  - `Cache-Control: max-age=60`（API）/ `max-age=300`（raw）→ 必须自己管 ETag 并加 no-store，
 *    否则本地缓存会把「刚改完」的内容吃掉。
 *  - 写回必须带 blob sha（拿不到 sha 的 PUT 会被 422 拒），故写入路径要走 JSON media type。
 */

const API = 'https://api.github.com';

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/* ------------------------------------------------------- base64 (UTF-8) */

export function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromBase64Utf8(b64) {
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ------------------------------------------------------------- headers */

function headers(token, extra = {}) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function readRate(res) {
  const num = (k) => {
    const v = res.headers.get(k);
    return v === null ? null : Number(v);
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    reset: num('x-ratelimit-reset'), // epoch seconds
    retryAfter: num('retry-after'),
  };
}

export class GitHubError extends Error {
  constructor(message, { status, rate, body } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rate = rate;
    this.body = body;
  }
}

/* ----------------------------------------------------------- the client */

export function createClient({ owner, repo, path, branch = 'main' }) {
  if (!owner || !repo || !path) throw new Error('owner / repo / path 均为必填');

  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encPath(path)}`;

  /**
   * 读取文件。
   * @param {object} o
   * @param {string|null} o.etag   上次的 ETag，命中则返回 304
   * @param {string|null} o.token  有 token 时 304 不计配额
   * @param {boolean} o.wantSha    写回场景需要 sha，走 JSON；纯展示走 raw 省流量
   * @returns {Promise<{status:number, content?:string, sha?:string, etag?:string, rate?:object}>}
   */
  async function read({ etag = null, token = null, wantSha = false, signal } = {}) {
    const h = headers(token, wantSha
      ? {}
      : { Accept: 'application/vnd.github.raw' });
    if (etag) h['If-None-Match'] = etag;

    const url = `${base}?ref=${encodeURIComponent(branch)}`;
    let res;
    try {
      res = await fetch(url, { headers: h, cache: 'no-store', signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new GitHubError('网络不可达（离线或 DNS 失败）', { status: 0 });
    }

    const rate = readRate(res);

    if (res.status === 304) return { status: 304, etag, rate };
    if (res.status === 404) {
      return { status: 404, rate, notFound: true };
    }
    if (res.status === 403 || res.status === 429) {
      throw new GitHubError(
        rate.remaining === 0 ? '配额已用尽' : '被 GitHub 拒绝（权限或频率限制）',
        { status: res.status, rate },
      );
    }
    if (!res.ok) {
      throw new GitHubError(`读取失败 HTTP ${res.status}`, { status: res.status, rate });
    }

    const newEtag = res.headers.get('etag');

    if (wantSha) {
      const j = await res.json();
      return {
        status: 200,
        content: fromBase64Utf8(j.content || ''),
        sha: j.sha,
        etag: newEtag,
        size: j.size,
        rate,
      };
    }
    return { status: 200, content: await res.text(), etag: newEtag, rate };
  }

  /**
   * 写入（整文件覆盖）。sha 不匹配时 GitHub 返 409/422 → 视为冲突，由上层重新拉取合并。
   */
  async function write({ content, sha, message, token, committer } = {}) {
    if (!token) throw new GitHubError('写回需要 token', { status: 401 });

    const body = {
      message: message || 'chore(todo): update from web',
      content: toBase64Utf8(content),
      branch,
    };
    if (sha) body.sha = sha;
    if (committer) body.committer = committer;

    const res = await fetch(base, {
      method: 'PUT',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const rate = readRate(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }

    if (res.ok) {
      return { ok: true, sha: json?.content?.sha || null, commit: json?.commit?.sha || null, rate };
    }
    const conflict = res.status === 409 || res.status === 422;
    return {
      ok: false,
      conflict,
      status: res.status,
      message: json?.message || text.slice(0, 200),
      rate,
    };
  }

  /** 校验凭证与仓库可访问性，用于设置页的「测试连接」 */
  async function probe({ token = null } = {}) {
    const res = await fetch(`${API}/repos/${owner}/${repo}`, {
      headers: headers(token),
      cache: 'no-store',
    });
    const rate = readRate(res);
    if (!res.ok) return { ok: false, status: res.status, rate };
    const j = await res.json();
    return { ok: true, private: j.private, defaultBranch: j.default_branch, rate };
  }

  return { read, write, probe, url: base };
}

/* ---------------------------------------------------------------- token */

const TOKEN_KEY = 'todo-gh:token';

/** token 只存在本机 localStorage；页面不向任何第三方发送 */
export function loadToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function saveToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 隐私模式下静默降级为内存态 */ }
}
