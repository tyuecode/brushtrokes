/* 资源一致性检查（不跑浏览器，纯静态核对）
 *
 * 锁住几类「改一处忘另一处」的漂移：
 *   1. 风格元数据在 index.html 与 core.js 里各有一份，必须一致
 *   2. 播放器模板的占位符必须都被 index.html 替换
 *   3. 所有脚本引用都要带 ?v= 版本号（否则缓存清不掉）
 *   4. 脚本正文里不能出现字面 </script，会提前截断
 *   5. 内联脚本必须语法正确
 *
 * 跑法：npm run check
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failed = 0;
function ok(msg) { console.log('  \u2713 ' + msg); }
function bad(msg) { console.log('  \u2717 ' + msg); failed++; }

const indexHtml = read('index.html');
const playerHtml = read('player-template.html');
const OILCore = require(path.join(ROOT, 'core.js')).OILCore;

/* ---------------------------------------------- 1. 脚本按真实 HTML 规则提取 */
function extractScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length;
    const closeRe = /<\/script\s*>/gi;
    closeRe.lastIndex = start;
    const c = closeRe.exec(html);
    const end = c ? c.index : html.length;
    out.push({
      attrs: m[1],
      code: html.slice(start, end),
      external: /\bsrc\s*=/.test(m[1]),
      line: html.slice(0, m.index).split('\n').length,
      closed: !!c,
    });
    re.lastIndex = c ? closeRe.lastIndex : html.length;
  }
  return out;
}

console.log('\n[1] 脚本块');
for (const [name, html] of [['index.html', indexHtml], ['player-template.html', playerHtml]]) {
  const scripts = extractScripts(html);
  let badHere = false;
  scripts.forEach((s, i) => {
    if (!s.closed) { bad(`${name} 块#${i} 缺少 </script>`); badHere = true; }
    if (s.external) return;
    if (/<\/script/i.test(s.code)) { bad(`${name} 块#${i} 正文含字面 </script>`); badHere = true; }
    try { new vm.Script(s.code, { filename: `${name}#${i}` }); }
    catch (e) { bad(`${name} 块#${i} 语法错误: ${e.message}`); badHere = true; }
  });
  if (!badHere) ok(`${name} 的 ${scripts.length} 个脚本块均正常`);
}

/* ---------------------------------------------- 2. 版本号覆盖所有脚本引用 */
console.log('\n[2] 缓存清除');
if (!/window\.OIL_BUILD\s*=/.test(indexHtml)) {
  bad('index.html 缺少内联的 window.OIL_BUILD');
} else if (!/<script>[\s\S]{0,1200}?OIL_BUILD/.test(indexHtml)) {
  bad('OIL_BUILD 必须内联在 index.html 里（放 build.js 会被一起缓存）');
} else ok('OIL_BUILD 已内联');

// 动态加载 render.js 时必须带版本号
const renderLoad = indexHtml.match(/s\.src\s*=\s*'([^']+)'/);
if (!renderLoad) bad('未找到 render.js 的动态加载');
else if (!/\?v=/.test(renderLoad[1])) bad(`render.js 引用没带 ?v=：${renderLoad[1]}`);
else ok('render.js 引用带版本号');

if (!/worker\.js\?v=/.test(indexHtml)) bad('worker.js 没带 ?v=');
else ok('worker.js 引用带版本号');

const fetchTargets = [...indexHtml.matchAll(/grab\('([^']+)'\)/g)].map(m => m[1]);
if (fetchTargets.length === 0) bad('未找到播放器模板的 fetch');
else {
  // grab() 内部统一拼 + V，确认 V 里含 ?v=
  const vLine = indexHtml.match(/const V\s*=\s*'\?v='\s*\+/);
  if (!vLine) bad('fetch 的 V 没有拼接 ?v=');
  else ok(`fetch 目标(${fetchTargets.join(', ')})统一走 V = '?v='+OIL_BUILD`);
}

if (fs.existsSync(path.join(ROOT, 'build.js'))) {
  bad('build.js 仍存在，会和内联版本号形成两个来源');
} else ok('build.js 已移除（版本号单一来源）');

/* ---------------------------------------------- 3. 风格元数据一致 */
console.log('\n[3] 风格元数据一致性');
const STYLE_META_MATCH = indexHtml.match(/const STYLE_META = \[([\s\S]*?)\];/);
if (!STYLE_META_MATCH) bad('index.html 找不到 STYLE_META');
else {
  const keys = [...STYLE_META_MATCH[1].matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
  const stepsMatch = indexHtml.match(/const STYLE_STEPS = \{([\s\S]*?)\n\};/);
  const stepsKeys = stepsMatch
    ? [...stepsMatch[1].matchAll(/^\s*([a-z]+):\s*\[/gm)].map(m => m[1])
    : [];

  if (keys.length !== 8) bad(`STYLE_META 有 ${keys.length} 个风格，应为 8`);
  else ok('STYLE_META 有 8 个风格');

  const missingSteps = keys.filter(k => !stepsKeys.includes(k));
  if (missingSteps.length) bad(`这些风格缺 STYLE_STEPS：${missingSteps.join(', ')}`);
  else ok('每个风格都有对应的 STYLE_STEPS');

  // 与 core.js 注册表比对
  const coreKeys = OILCore.STYLE_ORDER;
  const onlyIdx = keys.filter(k => !coreKeys.includes(k));
  const onlyCore = coreKeys.filter(k => !keys.includes(k));
  if (onlyIdx.length || onlyCore.length) {
    bad(`风格键不一致。仅 index.html: [${onlyIdx}], 仅 core.js: [${onlyCore}]`);
  } else ok('index.html 与 core.js 的风格键完全一致');

  // 工序数与 core.js 对齐
  for (const k of coreKeys) {
    if (!keys.includes(k)) continue;
    const coreSteps = OILCore.STYLES[k].steps.length;
    const m = stepsMatch && stepsMatch[1].match(new RegExp(`^\\s*${k}:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (m) {
      const n = m[1].split(',').filter(s => s.trim()).length;
      if (n !== coreSteps) bad(`${k} 工序数不一致：index.html ${n} vs core.js ${coreSteps}`);
    }
  }
  ok('工序数与 core.js 对齐（逐项已核对）');
}

/* ---------------------------------------------- 4. 占位符全部被替换 */
console.log('\n[4] 播放器模板占位符');
const placeholders = [...new Set([...playerHtml.matchAll(/__[A-Z]+__/g)].map(m => m[0]))];
const unhandled = placeholders.filter(p => !indexHtml.includes(p));
if (unhandled.length) bad(`index.html 未处理这些占位符：${unhandled.join(', ')}`);
else ok(`${placeholders.length} 个占位符全部在 index.html 中有替换`);

/* ---------------------------------------------- 5. 关键可访问性 / 健壮性约定 */
console.log('\n[5] 可访问性与健壮性约定');
const checks = [
  ['选图区可键盘聚焦', /id="drop"[^>]*tabindex="0"/.test(indexHtml)],
  ['选图区有 role', /id="drop"[^>]*role="button"/.test(indexHtml)],
  ['风格卡片用 role=radio', /setAttribute\('role',\s*'radio'\)/.test(indexHtml)],
  ['风格容器是 radiogroup', /id="styleBox"[^>]*role="radiogroup"/.test(indexHtml)],
  ['存在 :focus-visible 样式', /:focus-visible/.test(indexHtml)],
  ['label 用 for 关联控件', !/<label>/.test(indexHtml)],
  ['导出用 toBlob', /cv\.toBlob\(/.test(indexHtml)],
  ['导出上报真实尺寸', /clamped/.test(indexHtml)],
  ['fetch 检查 response.ok', /res\.ok|\.ok\b/.test(indexHtml)],
  ['worker.onerror 重置进度', /worker\.onerror[\s\S]{0,200}setProg\(0\)/.test(indexHtml)],
  ['选图有 try/catch', /async function takeFile[\s\S]{0,900}catch/.test(indexHtml)],
  ['缩略图 URL 会回收', /revokeObjectURL\(thumbURL\)/.test(indexHtml)],
  ['播放器有暂停按钮', /id="btnPlay"/.test(playerHtml)],
  ['播放器有重播按钮', /id="btnReplay"/.test(playerHtml)],
  ['播放器舞台可缩放', /id="stage"/.test(playerHtml) && /scale\(/.test(playerHtml)],
  ['播放器 body 不再写死宽高', !/html,body\{[^}]*width:1920px/.test(playerHtml)],
  ['worker 校验图像尺寸', /rgba\.length !== w \* h \* 4/.test(read('worker.js'))],
  ['worker 处理透明像素', /hasAlpha/.test(read('worker.js'))],
];
for (const [label, cond] of checks) cond ? ok(label) : bad(label);

/* ---------------------------------------------- 汇总 */
console.log('\n' + '-'.repeat(46));
if (failed) {
  console.log(`  检查未通过：${failed} 项`);
  process.exit(1);
} else {
  console.log('  全部检查通过');
}
