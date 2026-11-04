# Markdown-on-GitHub 个人 Todo 工具 · 设计方案

> 结论先行：**推荐「单文件页面 + GitHub Contents API 直连 + 本地草稿队列」三层结构**。
> 公开仓库可以零凭证只读；需要页面内写回时用 fine-grained PAT，只保存在本机。
> 同步延迟不是「实时」而是**可量化的 60s / 300s 两档**，取决于走哪条通道——这一点必须先讲清楚，
> 否则后面所有实现选择都站不住。

---

## 1. 为什么要先谈同步延迟

「GitHub 上改了，页面自动更新」这句话背后有三个物理约束，任何一个都绕不过：

1. `api.github.com` 未认证只有 **60 次/小时/IP**，且**未认证的 304 响应仍然计费**；
2. `raw.githubusercontent.com` 走 Fastly CDN，`Cache-Control: max-age=300`，
   在 TTL 内**即使源站已更新也只回 304**，最多 5 分钟盲区；
3. GitHub Actions 的 cron **最小间隔 5 分钟**，且高峰期会排队，实际常 8~15 分钟。

以下是我在 2026-11-04 对真实端点做的实测（不是文档摘抄）：

| 验证项 | 实测结果 | 对设计的影响 |
|---|---|---|
| `api.github.com` 的 CORS | `Access-Control-Allow-Origin: *` | 浏览器可直连 |
| `PUT` 预检 | `204`，`allow-methods: GET, POST, PATCH, PUT, DELETE`，`allow-headers` 含 `Authorization` | **页面内写回可行** |
| 未认证配额 | `X-RateLimit-Limit: 60` | 轮询最快 60s/次，且会被写回抢走配额 |
| 未认证 304 | `remaining` 57 → 55（照扣） | 「ETag 省配额」只在带 token 时成立 |
| API 响应缓存 | `Cache-Control: public, max-age=60` | 必须自己带 `If-None-Match` + `cache:'no-store'` |
| raw 响应缓存 | `Cache-Control: max-age=300`，`X-Cache: HIT`，`Source-Age: 261` | 高频轮询毫无意义 |
| raw 的 CORS | `Access-Control-Allow-Origin: *` | 可作零配额探测通道 |
| raw media type | 5847 B（纯文本）vs 8881 B（base64 JSON），ETag 相同 | 只读场景走 raw，省 34% 流量且免 base64 解码 |
| `Access-Control-Expose-Headers` | 含 `ETag`、`X-RateLimit-*`、`Retry-After` | 前端能读到配额与 ETag，可做自适应退避 |

由此得到延迟下限，**选方案就是选这一列**：

| 通道 | 配额成本 | 第一个能看到新内容的时刻 |
|---|---|---|
| raw CDN 轮询 | 0 | 0 ~ 300 s（不可控） |
| API 未认证轮询 | 60/h，建议 ≥120 s 一次 | 60 ~ 120 s |
| API + PAT 轮询 | 5000/h，304 免费 | 15 ~ 30 s |
| Actions 生成快照 | 0 | 5 ~ 15 min |

> 如果需求是「改完 10 秒内必须看到」，只有 **PAT + API 轮询 15s** 一条路。
> 如果接受「两分钟内」，不配 token 也够用。本方案同时支持两档，由配置切换。

---

## 2. 三种部署形态

按「仓库是否私有」「页面是否需要写回」分成三档，**从 A 起步，按需升级**。

### A. 直连只读（公开仓库，零凭证）

```
todo.md  ──(raw / API 未认证)──►  index.html  ──►  浏览器
```

- 页面内所有改动只落 `localStorage`，不写回。
- 优点：零配置、零密钥、把 `index.html` 丢到任何静态托管都能跑。
- 缺点：手机和电脑各改各的，不同步；改动要手动去 GitHub 提交。

### B. 直连读写（公开或私有仓库 + PAT）— **默认推荐**

```
todo.md ◄──(Contents API + PAT)──► index.html ◄──► localStorage 草稿
```

- PAT 存 `localStorage`，只在本机，不进代码、不进构建产物。
- 权限最小化：fine-grained token，只授权**这一个仓库**的 `Contents: Read and write`，设 90 天过期。
- 私有仓库**必须**走这一档（raw 对私有内容需要凭证，且浏览器侧无法安全注入）。

### C. 快照中转（私有仓库 + 不想在页面里放 token）

```
todo.md ──(Actions cron)──► data/todo.json ──► Pages ──► index.html
```

- token 只存在于 Actions secrets，页面拿同源 JSON，零 CORS、零配额、CDN 快。
- 代价：延迟 5~15 分钟；写回要靠 GitHub 网页或 Issue 表单。
- 适合「只给家人/自己看，编辑都在 GitHub 上做」的场景。

本仓库实现了 **A 和 B**，并附上 C 的 workflow 模板（`snapshot.yml`，默认不启用）。

---

## 3. 数据格式契约

Markdown 既是数据源又是给人看的文档，两者必须同时成立。约定如下：

```markdown
# Leo 的待办                   ← 首个 h1 = 文档标题，不参与分组

## 工作                        ← h2 起 = 分组

- [ ] 写 Q4 OKR 初稿 #工作 @due(2026-11-06) !p1 <!--id:i0a1b2c-->
- [x] 拆分 SKILL.md 类型 6/7    #工作 <!--id:i6a7b8c @done(2026-11-02)-->
```

文档里贴的示例代码块（围栏内）会被解析器整体跳过，不会变成任务，也不会被写回覆盖。

| 语法 | 含义 | 渲染可见性 |
|---|---|---|
| `- [ ]` / `- [x]` | 未完成 / 已完成 | 可见（GitHub 原生 task list） |
| `#标签` | 标签，首字符必须是字母或汉字 | 可见 |
| `@due(YYYY-MM-DD)` | 截止日期 | 可见 |
| `!p0`~`!p3` | 优先级 | 可见 |
| `<!--id:xxx-->` | 稳定 ID，机器用 | 不可见 |
| `<!--@done(日期)-->` | 完成时间戳 | 不可见 |

**三个刻意的设计决定：**

1. **ID 藏在 HTML 注释里**，GitHub 渲染时不可见，不会污染阅读。
   为什么需要 ID：没有稳定主键，「改标题」和「删旧建新」无法区分，三方合并必然丢数据。
2. **无 ID 的行是 ephemeral**，按 `hash(分组 + 标题)` 派生临时 ID。
   只有**这一行被修改的那一刻**才固化真 ID——没动过的行一个字节都不改，保证 diff 最小。
3. **`#8821` 这类工单号不会被误判成标签**（要求 `#` 后首字符为字母或汉字）。
   这是实测踩出来的：不加约束，`（工单 #8821）` 会把标题截断成 `（工单`。

---

## 4. 目录结构

```
todo-personal/
├─ todo.md                      # 数据源本体（放你的真实仓库里，被页面读取）
├─ dist/
│  └─ index.html                # 单文件产物：双击即跑，可直接丢 Pages / 任意静态托管
├─ src/
│  ├─ core/
│  │  ├─ md.mjs                 # 解析 / 行级补丁 / 序列化（纯函数，无 DOM）
│  │  └─ merge.mjs              # 三方合并（base / local / remote 逐字段判定）
│  ├─ app/
│  │  ├─ github.mjs             # Contents API 客户端：条件读取、带 sha 写回、配额解析
│  │  ├─ sync.mjs               # 调度器：定时、可见性、退避、配额自适应
│  │  └─ ui.mjs                 # 视图与交互
│  └─ styles.css                # 主题变量 + 响应式
├─ build.mjs                    # 幂等内联构建 → dist/index.html
├─ scripts/
│  ├─ selftest.mjs              # 解析/补丁 55 项断言（固定夹具，不依赖 todo.md 内容）
│  ├─ selftest-merge.mjs        # 合并 18 项断言
│  └─ check-ui.js               # 真实 Chrome（CDP）跑一遍交互并截图
└─ .github/workflows/
   └─ snapshot.yml              # 可选：Actions 生成 data/todo.json
```

**为什么开发态拆模块、交付态拼单文件：**

- 直接写单文件 HTML 会逼着你把解析逻辑复制两份（页面一份、测试一份），必然漂移。
- `build.mjs` 只做一件事：去掉 `import`/`export`，按依赖顺序拼进 `<script>`，
  产出仍是**普通脚本**而不是 `type="module"`——因为 `file://` 下 module 会被 CORS 拦，双击打不开。
- 构建幂等：产物内容不变就不写盘。

---

## 5. 关键实现

### 5.1 行级补丁，而不是全文重写

这是整个项目最容易做错的地方。反例：解析成对象数组 → 用户勾一个 → 把整个数组序列化写回。
结果每次提交都是**整文件 diff**，PR 无法 review，冲突率接近 100%。

正确做法是记住每行的 `lineIndex`，**只替换那一行**：

```js
export function patchTask(src, id, mutator) {
  const doc = parse(src);
  const t = findTask(doc, id);
  if (!t) return { src, changed: false, error: 'task-not-found' };

  const next = { ...t, tags: [...t.tags] };
  mutator(next);
  if (next.ephemeral) { next.id = randomId(); next.ephemeral = false; } // 只会影响这一行

  doc.lines[t.lineIndex] = buildTaskLine(next);   // ← 唯一被改的元素
  return { src: join(doc), changed: true, task: next };
}
```

自检里有一条硬断言：**勾选一个任务，全文 diff 必须恰好 1 行**。
round-trip 也必须是字节级的——解析完原样写回，得到的字符串要和原文完全相同（含 CRLF、BOM）。

### 5.2 解析器要跳过代码围栏

文档里贴一段示例 `- [ ] 不是任务` 是很自然的事。不跳过围栏，就会凭空多出任务、写回时还会覆盖它。
`parse()` 用 `fence` 状态机处理 ```` ``` ```` 和 `~~~`，front matter 同理。

### 5.3 三方合并：多端编辑不丢数据

场景很常见：地铁上手机勾了一条，回家电脑改了另一条，然后点推送。

```js
// 逐字段三态判定：谁改了用谁，两边都改才叫冲突
function mergeField(base, local, remote, key) {
  const b = norm(base, key), l = norm(local, key), r = norm(remote, key);
  if (l === r || r === b) return { value: local[key], conflict: false };
  if (l === b) return { value: remote[key], conflict: false };  // 本地没动
  return { value: local[key], conflict: true };                 // 都改了，保留本地并上报
}
```

结构策略：**以远端为准**（标题、空行、任务顺序都跟远端），本地不重排；
逐任务按 ID 对齐后只合并字段。这样合并结果仍然是一份「远端的排版 + 本地的改动」，不会把文件搅乱。

冲突不静默处理：返回 `conflicts` 列表，UI 提示「N 处冲突保留本地版本」。

### 5.4 写回必须带 sha（乐观锁）

`PUT /contents` 不带 `sha` 会被 422 拒（文件已存在时）。这个 `sha` 是 blob sha，
**只有 JSON media type 的 GET 才返回**，raw 只给内容。

于是写回路径固定是：`GET(JSON) 拿 sha + 内容` → 比对本地基线 → 必要时合并 → `PUT(sha)`。
`sha` 过期时 GitHub 返 409/422，视为并发冲突：重新拉一次、再合并、重试一次，仍失败就交给人。

```js
const res = await client.write({ content: target, sha: latest.sha, token });
if (!res.ok && res.conflict) { /* 重拉 → 合并 → 重试一次 */ }
```

### 5.5 同步调度

```js
// 退避优先级：retry-after > 配额重置时间 > 指数退避
if (e.rate?.remaining === 0)  wait = reset - now;        // 配额耗尽，别硬撞
else if (e.rate?.retryAfter) wait = retryAfter * 1000;
else                         wait = 2s * 2^n, 上限 5min;
```

另外三条容易被忽略的规则：

- **页面隐藏就停表**（`visibilitychange`），重新可见且距上次 >15s 才立刻同步。省电也省配额。
- **未认证时自适应拉长间隔**：`remaining < 10` 时把间隔拉到「剩余配额刚好撑到重置」的值。
- **`x-ratelimit-remaining` 与 `retry-after` 都通过 `Access-Control-Expose-Headers` 暴露**，前端读得到，
  不用猜。

---

## 6. 功能设计

| 能力 | 实现要点 |
|---|---|
| 任务增删改查 | 走行级补丁；新增按「当前分组」定位插入，分组不存在则在文件末尾建新分组 |
| 完成状态 | 点圆圈即切换，同时写 `@done(日期)`（可关）；已完成项降透明度 + 删除线 |
| 按状态筛选 | 待办 / 已完成 / 全部；**看板视图下自动失效**（看板本身就按状态分列） |
| 按标签筛选 | 标签栏多选（AND 语义），点任务上的标签可直接筛 |
| 搜索 | 匹配标题 + 标签 + 分组，局部重绘，不打断输入法 |
| 列表 / 看板 | 列表按分组，看板按状态两列；< 720px 看板自动单列 |
| 自然语言新增 | 输入 `买牛奶 #家事 @due(2026-11-06) !p1`，复用同一套 `parseInline` |
| 行内编辑 | 编辑框展示**整行正文**（标题+标签+截止+优先级），回车/失焦提交，Esc 取消 |
| 本地存储 | `workSrc`（工作副本）+ `remoteSrc`（基线）双份，离线可改，刷新不丢 |
| 编辑入口 | 三种：页面内联编辑 / 页面「推送」按钮 / 直接去 GitHub 改文件 |
| 响应式 | 375px 起可用；底部固定输入条带 `safe-area-inset` |
| 状态可见 | 顶部 chip 显示 同步中/已同步/无变化/离线/配额受限；底部显示剩余配额 |
| 主题 | 三态循环：跟随系统 → 浅色 → 深色。`auto` 不写属性、交给 `prefers-color-scheme`；`light`/`dark` 写 `<html data-theme>` 显式覆盖，选择存进 `cfg.theme` |
| 演示模式 | 未配置仓库时用内置示例数据，零配置即可看到完整界面 |

顶部三个图标各自只做一件事：**主题（半明半暗圆）/ 立即同步（环形箭头）/ 设置（齿轮）**。
早先设置按钮画成了「圆 + 八条射线」，在 16px 下和太阳图标几乎无法区分，
用户点它期待的是切换明暗，结果弹出同步设置抽屉 —— 已把该图标换成带齿的齿轮，
并把主题切换真正补上。

**默认不自动推送。** 改动先落本地草稿，顶部出现「本地有未推送改动 → 立即推送」。
理由：手机误触勾选就触发一次 commit，会把 git 历史弄脏。要自动就开开关，走 3 秒 debounce。

---

## 7. 从 GitHub 到页面：完整数据流

```
                 ┌──────────────── 页面（单文件）────────────────┐
   GitHub        │                                              │
┌─────────┐      │  ┌─────────┐   ┌──────────┐   ┌───────────┐  │
│ todo.md │─────►│  │  sync   │──►│  parse   │──►│  render   │  │
└─────────┘      │  │ 调度器  │   │ md.mjs   │   │  ui.mjs   │  │
     ▲           │  └────┬────┘   └──────────┘   └─────┬─────┘  │
     │           │       │ 304 就跳过                  │ 用户操作 │
     │           │       ▼                             ▼        │
     │           │  ┌─────────────┐          ┌──────────────┐   │
     │           │  │ state:      │◄─────────│ patchTask    │   │
     │           │  │ remoteSrc   │          │ workSrc 变更 │   │
     │           │  │ workSrc     │          └──────────────┘   │
     │           │  └──────┬──────┘                             │
     │           │         │ dirty?                             │
     │           │         ▼                                    │
     │           │  ┌──────────────┐   PUT(sha)   ┌──────────┐  │
     └───────────┼──│ merge 三方合并│◄─────────────│ 推送按钮 │  │
                 │  └──────────────┘              └──────────┘  │
                 └──────────────────────────────────────────────┘
```

一次同步的判定链：

1. **触发**：可见性变化 / 定时器到点 / 手动刷新 / 网络恢复。
2. **取数**：带上次的 `ETag` 发条件请求。
   - `304` → 内容没变，只更新「上次检查时间」，**不重绘**。
   - `200` → 拿到新内容，比较 `content === remoteSrc`。
3. **分流**：
   - 本地无改动 → 直接用远端覆盖 `workSrc`，重绘。
   - 本地有改动（dirty）→ 保留 `workSrc` 不动，置 `remoteNewer`，顶部提示「远端有更新，点击合并」。
     绝不自动覆盖——那等于吞掉用户没推送的改动。
4. **写回**：拿最新 sha → 若非基线版本则三方合并 → PUT → 成功后把 `workSrc`/`remoteSrc` 同步为合并结果。

---

## 8. 部署：按「要不要跨设备」三选一

| 方式 | 怎么做 | 适合 | 代价 |
|---|---|---|---|
| 本地文件 | 双击 `dist/index.html` | 只在一台电脑用、不想公开仓库 | 换机要拷文件；`file://` 与 `https://` 的 localStorage 互不相通 |
| **GitHub Pages（推荐）** | 仓库自带 `.github/workflows/pages.yml`，push 到 main 自动发布 | 手机/平板/多台电脑都能开 | 仓库需公开（或账号为 Pro 时用私有 Pages） |
| 任意静态托管 | 把 `dist/index.html` 传上去 | 已有服务器/内网 | 多一步上传，其余同 Pages |

Pages 只需要点一次开关：

1. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
2. push 到 `main`，workflow 会跑两套自检 → `node build.mjs` → 发布 `dist/`。
   **测试不过就不发布**，避免把坏版本推上线。
3. 发布后地址形如 `https://<owner>.github.io/<repo>/`，手机可直接打开。

不需要 Pages 也可以：产物是单个 HTML，任何静态空间、内网共享目录、甚至微信发给自己都能跑。

### 8.1 换电脑 / 换手机，哪些东西跟得走

数据分四层，各有归属，别指望它们一起搬家：

| 数据 | 存在哪 | 换设备后 |
|---|---|---|
| 页面本身 | 文件或 Pages URL | Pages 链接直接开；本地文件需拷贝或重新 `node build.mjs` |
| 仓库配置（owner/repo/branch/path） | `localStorage`，按 origin 隔离 | 设置里点「复制带配置的链接」，新设备打开即自动填好；也可手填一次 |
| PAT | `localStorage`，只在本机 | **必须重填**；有意不放进链接，也不进构建产物 |
| 未推送的本地草稿 | `localStorage` | **不跟走**：换机前先点「立即推送」，否则那份改动只留在旧机器 |

带参数的链接长这样（`?` 与 `#` 都认，`#` 优先）：

```
https://leoli04.github.io/todo-personal/#repo=leoli04/todo-personal&branch=main&path=todo.md
```

启动时读取 → 并入配置 → 用 `history.replaceState` 把参数从地址栏抹掉。
抹掉这一步是必须的：留着的话，你在设置里改成别的仓库，一刷新又被链接改回去。

两个容易踩的坑：

- **`file://` 的 localStorage origin 是 `null`**，与 `https://*.github.io` 不共享。在「本地文件」和「Pages」之间来回切，等于换了一个全新实例：配置要重填、草稿看不见。选定一种打开方式就固定用它。
- **换浏览器同样等于换实例**（localStorage 不跨浏览器）。所以「链接带配置」是唯一省事的迁移方式。

不建议把 PAT 写进代码或 CI 产物；页面里只从 `localStorage` 读。

---

## 9. 已知限制（诚实清单）

| 限制 | 说明 | 缓解 |
|---|---|---|
| 未认证 304 也计费 | 实测 remaining 会掉 | 配置 token，或把间隔提到 ≥120s |
| raw 有最长 300s 盲区 | CDN TTL 内回 304 | 需要快就配 token 走 API |
| 页面内写回需 PAT | 浏览器拿不到 OAuth 之外的凭证 | fine-grained + 最小权限 + 90 天过期；或走形态 C |
| 合并只做字段级 | 不支持任务在分组间移动的自动合并 | 结构以远端为准；移动操作需人工确认 |
| 大文件未分页 | 单次 GET 有 1 MB 上限（Contents API） | Todo 场景远达不到；超了改用 raw 或分文件 |
| 无多人协作语义 | 没有冲突锁，只靠 sha 乐观锁 + 合并 | 个人工具够用 |
| 编辑是「整行正文」 | 改标签需在框里直接改 `#tag` | 与解析规则对称，避免「改标题清空标签」 |

---

## 10. 自检

```bash
node scripts/selftest.mjs        # 解析 / 补丁 / 序列化：55 项
node scripts/selftest-merge.mjs  # 三方合并：18 项
node build.mjs                   # 构建 dist/index.html
node scripts/check-ui.js         # 真实 Chrome 跑交互 + 出图：26 项断言
```

`check-ui.js` 用 CDP 驱动真实 Chrome（不是 jsdom），断言的是**渲染后的 DOM**而不是函数返回值，
且失败时以退出码 1 结束，可直接进 CI：

- 首屏：应用挂载、解析出的任务数 > 0、页面横向溢出 = 0
- 勾选：状态翻转、`@done` 写入、只落草稿不自动推送、草稿提示出现
- 搜索：关键词与命中数**由真实数据推导**（不写死示例内容），清空后恢复全量且输入框节点未被替换
- 标签筛选：用数据中最高频的标签，命中项必须全部含该标签
- 新增 `CDP 验证任务 #测试 @due(2026-12-01) !p2` → 标签/截止/优先级全部落到行内
- 行内编辑 → 标题与标签同时更新，编辑框关闭
- 看板 → 按状态分列渲染
- 设置抽屉 → 两个可带走项一行放下、无溢出
- 主题 → 三态循环各落对属性、显式深色压过系统浅色、深色系统下选浅色同样生效、选择写盘；
  两处浅色色板（显式 + 系统）用 CSSOM 比对，变量名与值必须完全一致
- 删除 → 目标从数据源消失且总数 -1
- 长标题（> 30 字）→ 换行不溢出、不与标签行重叠（量包围盒，不靠眼估）
- 375px 视口：横向溢出 0
- 链接即配置：三种输入形态 + 真导航后写盘并清 hash；错误态不谎报「已同步」
- console 错误 0

最近一次结果：`55/55`、`18/18`、UI `26/26`（长标题 3 条已量）。
