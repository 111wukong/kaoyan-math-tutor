/* 从 web/src/components/ui/Math.tsx 抽出「纯逻辑管线」，供 Node 离线跑。
 *
 * 为什么要抽而不是手抄：
 *   手抄一份副本，改产品代码时副本不会跟着变 —— 那这套检查就是自欺欺人。
 *   这里的做法是**每次运行时从源码现场抽**，抄错、抄漏都会立刻暴露。
 *
 * 为什么不用正则剥 TS 类型：
 *   类型标注散布在参数、返回值、泛型、as 断言里，正则剥不干净，
 *   剥漏一处 `new Map<string, string>()` 就整段语法错误。
 *   所以走真编译器：先切出无 JSX 的核心，再交给 tsc 转译。
 *
 * 切法：
 *   · 顶部 import 去掉（react / @/lib/utils 只有 JSX 组件用得到）
 *   · 末尾的 RichText / InlineMath 两个 React 组件整段去掉（它们含 JSX）
 *   · katex 用 declare 声明成全局，运行时由 harness 注入真身
 *   · 末尾补一行 export，把要用的函数暴露出去
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');

const SRC = join(REPO, 'web', 'src', 'components', 'ui', 'Math.tsx');

/** 切出无 JSX 的核心源码（仍是 TS） */
export function coreSource() {
  const lines = readFileSync(SRC, 'utf8').split('\n');

  /* 去掉顶部 import。不按行号硬写 —— 将来上面再加一行 import，行号就漂了。
   * 按「连续出现在文件最前面的 import 行」切。 */
  let head = 0;
  while (head < lines.length && (lines[head].startsWith('import ') || lines[head].trim() === '')) head++;

  /* 从「React 组件形式」那段注释开始到文件末尾都是 JSX 组件，整段去掉。
   * 用标记而不是行号，同样是为了抗漂移。 */
  const cutAt = lines.findIndex((l) => l.includes('React 组件形式'));
  if (cutAt < 0) throw new Error('Math.tsx 里没找到「React 组件形式」标记 —— 文件结构变了，抽取逻辑要跟着改');

  /* 去掉正文里的 export 关键字，出口统一由抽取器在末尾补一行。
   * 不这么做的话 `export function renderRich` 会和末尾那句重复声明，
   * tsc 直接报 TS2323 拒绝出产物。 */
  const body = lines.slice(head, cutAt).join('\n').replace(/^export /gm, '');

  return [
    'declare const katex: any;',
    body,
    '/* --- 抽取器补的出口 --- */',
    'export { renderRich, inlinePipeline, autoLatex, renderTex, escapeHtml, emphasize, blockMd };',
    '',
  ].join('\n');
}

/** 用 tsc 把核心源码转译成 .mjs，返回产物路径 */
export function buildCore(outDir = join(REPO, '.tmp-pipeline')) {
  mkdirSync(outDir, { recursive: true });
  const tsPath = join(outDir, 'Math.core.ts');
  writeFileSync(tsPath, coreSource(), 'utf8');

  const tsc = join(REPO, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}`);

  const args = [
    tsPath,
    '--target', 'es2022',
    '--module', 'es2022',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
    '--outDir', outDir,
    '--noEmitOnError', 'false',
  ];

  let tscOut = '';
  try {
    execFileSync(tsc, args, { cwd: REPO, stdio: 'pipe' });
  } catch (e) {
    /* tsc 因为**类型**报错而退出（典型：独立编译没有 vite/client 引用，
     * 于是 import.meta.env 报 TS2339）—— 这种情况产物照样出来了，照用即可。
     * 语法错误会让产物缺失，下面的存在性检查会拦住，所以不会放过真问题。 */
    tscOut = String(e.stdout || '') + String(e.stderr || '');
  }

  /* tsc 对 .ts 输入只会产出 .js。而 package.json 里没有 "type": "module"，
   * Node 会把 .js 当 CommonJS 试一遍、失败了再按 ESM 重新解析，
   * 每次都要打一条 MODULE_TYPELESS_PACKAGE_JSON 警告。
   * 改名成 .mjs 就没有这个问题（也省掉一次重解析）。 */
  const jsPath = join(outDir, 'Math.core.js');
  const mjsPath = join(outDir, 'Math.core.mjs');
  if (existsSync(jsPath)) {
    renameSync(jsPath, mjsPath);
  }
  if (existsSync(mjsPath)) return mjsPath;

  throw new Error(`tsc 没产出产物，检查 ${outDir}\n${tscOut}`);
}
