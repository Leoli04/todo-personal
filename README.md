# todo-personal

**把 Markdown 文件当数据库的个人待办工具。** 数据是仓库里那份 [`todo.md`](todo.md)，
页面读它、改它，改完推回去就是一个 commit；在 GitHub 网页上改 Markdown，页面也会自动跟上。

- 在线版：<https://leoli04.github.io/todo-personal/>
- 单文件产物，双击即跑，无后端、无框架、无 CDN
- GitHub 上改 Markdown → 页面定时/切回前台时自动同步
- 页面内勾选、增删改、行内编辑，改动先落本地草稿，确认后再推送
- 多端同时改动时做三方合并，不静默覆盖

完整方案（含实测数据、同步延迟量化、取舍说明）见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 快速开始

无需安装依赖（零 dependency），只要有 Node ≥ 20：

```bash
npm run build     # → dist/index.html（约 69 KB）
npm test          # 核心 55 项 + 三方合并 18 项
npm run check:ui  # 可选：真实 Chrome 跑交互并出图，21 项断言，失败即退出码 1
```

不想用 npm 就直连脚本：`node build.mjs`、`node scripts/selftest.mjs`、`node scripts/check-ui.js`。

直接打开 `dist/index.html` 就能看到完整界面（内置示例数据，演示模式）。

## 连上你的仓库

1. 仓库里放一份 `todo.md`，格式见 [样例](todo.md)。
2. 页面右上角 → 设置 → 填 `owner / repo / 分支 / 文件路径`。
3. 想只读：到此为止。页面改动只存本地。
4. 想写回：填一个 fine-grained PAT，只授权该仓库的 **Contents: Read and write**。
   token 只存本机 `localStorage`，不会出现在构建产物里。

## 部署（想要跨设备就必须做）

不部署也能用：双击 `dist/index.html` 即可，但那只在**本机、本浏览器**成立。
手机/平板/第二台电脑要打开，就把页面挂到 GitHub Pages：

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**（只用点这一次）。
2. push 到 `main`：`.github/workflows/pages.yml` 会跑两套自检 → 构建 → 发布 `dist/`。
   自检不过就不发布。
3. 地址形如 `https://<owner>.github.io/<repo>/`，手机浏览器直接打开。

仓库是私有的话，Pages 需要账号有 Pro；不想公开也不想付费，就退回「本地文件 + 快照中转」形态。

## 换电脑 / 换手机

| 东西 | 会跟走吗 | 怎么处理 |
|---|---|---|
| 页面 | Pages 链接跟走 | 复制文件也行，但要记得重新 `node build.mjs` |
| 仓库配置 | ❌ 存在本机 localStorage | 设置里点「复制带配置的链接」，新设备打开即自动填好 |
| PAT | ❌ 故意不跟 | 新设备单独填一次（凭据不进链接、不进产物） |
| 未推送草稿 | ❌ | 换机前先点「立即推送」，否则只留在旧机器 |

带配置的链接形如：

```
https://<owner>.github.io/<repo>/#repo=<owner>/<repo>&branch=main&path=todo.md
```

页面读到参数后会写进本地配置，并把参数从地址栏抹掉（否则下次刷新会覆盖你手改的设置）。

⚠️ `file://` 打开和 `https://` 打开是**两个互不相通的存储空间**（origin 不同），
在两者之间切换等于从零开始：配置要重填、草稿看不见。选一种方式就固定用它。

## 同步延迟

| 通道 | 第一个能看到新内容的时刻 |
|---|---|
| 不配 token（raw CDN） | 0 ~ 5 分钟 |
| 不配 token（API 轮询） | 1 ~ 2 分钟 |
| 配 token（API + ETag） | 15 ~ 30 秒 |

选哪档由「同步间隔」和「有没有 token」共同决定，代码会按剩余配额自适应拉长间隔，不会把配额打光。

## 项目结构

```
src/core/md.mjs     解析 / 行级补丁 / 序列化
src/core/merge.mjs  三方合并
src/app/github.mjs  Contents API 客户端
src/app/sync.mjs    调度与退避
src/app/ui.mjs      界面
build.mjs           幂等内联构建
dist/index.html     产物
.github/workflows/  pages.yml（发布）· snapshot.yml（私有仓库快照）
scripts/            自检 + 快照生成 + CDP 复核
```

改 `src/` 后跑 `node build.mjs` 重新生成产物；不要直接改 `dist/index.html`。
