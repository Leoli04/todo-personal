/**
 * build.mjs —— 把 src/ 下的模块、样式、示例数据内联成一个可双击运行的单文件 HTML。
 *
 * 为什么不用 <script type="module">：file:// 下 ES module 会被 CORS 拦。
 * 所以这里做的是「确定性拼接」——去 import/export，按依赖顺序拼成普通脚本。
 * 幂等：产物内容未变化就不写盘。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const R = (p) => resolve(__dir, p);

// 依赖顺序：被依赖的放前面
const MODULES = [
  'src/core/md.mjs',
  'src/core/merge.mjs',
  'src/app/github.mjs',
  'src/app/sync.mjs',
  'src/app/ui.mjs',
];

const IMPORT_RE = /^import\s+[\s\S]*?from\s+['"][^'"]*['"];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;

function strip(code, file) {
  const out = code.replace(IMPORT_RE, '').replace(EXPORT_RE, '');
  const leaked = out.match(/^\s*(import|export)\s/m);
  if (leaked) {
    throw new Error(`[build] ${file} 存在未被剥离的 ${leaked[1]} 语句，检查是否换了写法`);
  }
  return out;
}

const css = readFileSync(R('src/styles.css'), 'utf8');
const demo = readFileSync(R('todo.md'), 'utf8');

const banner = `/* built from src/ — 不要直接改这个文件，改 src/ 后跑 node build.mjs */`;

const js = MODULES
  .map((m) => `/* ---- ${m} ---- */\n` + strip(readFileSync(R(m), 'utf8'), m))
  .join('\n\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<title>Todo · GitHub 同步</title>
<style>
${css.trim()}
</style>
</head>
<body>
<div id="app"></div>
<script>
${banner}
window.__DEMO_MD__ = ${JSON.stringify(demo)};
${js.trim()}
</script>
</body>
</html>
`;

const outPath = R('dist/index.html');
if (!existsSync(R('dist'))) mkdirSync(R('dist'), { recursive: true });

const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
if (prev === html) {
  process.stdout.write('unchanged dist/index.html\n');
} else {
  writeFileSync(outPath, html, 'utf8');
  process.stdout.write(`written dist/index.html (${(html.length / 1024).toFixed(1)} KB)\n`);
}
