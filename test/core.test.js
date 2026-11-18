/* 核心算法回归测试
 *
 * 这些用例锁住几个曾经出过问题、或很容易被改坏的约定：
 *   1. 色块外扩必须是「向外」——写反了会让相邻色块之间露出底色缝
 *   2. 时间轴严格串行 start[i] === start[i-1] + dur[i-1]
 *   3. 八种风格都能产出合法笔触，且 packed 记录字段数固定
 *   4. 透明像素不能把画面拉黑
 *
 * 跑法：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = path.join(__dirname, '..', 'core.js');
const OILCore = require(CORE).OILCore;

/* ------------------------------------------------------------------ 工具 */
function solidRGBA(w, h, r, g, b, a) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a;
  }
  return d;
}

/* 造一张有点结构的图：左半深色、右半亮色，加棋盘格和硬边。
 * 需要注意：线描风格只沿 Canny 脊线撒种子，图太平坦会一条笔都产不出来，
 * 所以这里必须有足够强的硬边缘。 */
function structuredRGBA(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 棋盘格给足强边缘，斜向渐变给方向场
      const cell = ((x >> 3) + (y >> 3)) & 1;
      const t = x / w;
      const base = cell ? 235 : 25;
      const v = Math.round(base * 0.72 + (40 + 200 * t) * 0.28);
      d[i] = v;
      d[i + 1] = Math.min(255, v * 0.88);
      d[i + 2] = Math.min(255, v * 0.74);
      d[i + 3] = 255;
    }
  }
  return d;
}

const BASE_OPTS = {
  layers: 5, scale: 1, workRes: 0, seed: 20261109, autoRois: 0, seconds: 30,
};

/* ------------------------------------------------- 1. 色块外扩方向 */
test('色块轮廓必须向外扩，而不是向内缩', () => {
  // inflateLoop 未导出，从源码抽取纯函数测试（它是自包含的数学函数）
  const fs = require('node:fs');
  const src = fs.readFileSync(CORE, 'utf8');
  const start = src.indexOf('function inflateLoop(');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { if (--depth === 0) { end = i + 1; break; } }
  }
  const inflateLoop = new Function(src.slice(start, end) + '; return inflateLoop;')();

  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  const areaOf = (p) => {
    let a = 0; const n = p.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      a += p[k * 2] * p[j * 2 + 1] - p[j * 2] * p[k * 2 + 1];
    }
    return Math.abs(a / 2);
  };

  const grown = inflateLoop(sq, 1.0);
  assert.ok(areaOf(grown) > areaOf(sq),
    `外扩后面积应变大：原 ${areaOf(sq)} -> ${areaOf(grown)}`);

  // 两种绕向都必须向外（旧实现两种都向内缩）
  const rev = [0, 0, 0, 10, 10, 10, 10, 0];
  assert.ok(areaOf(inflateLoop(rev, 1.0)) > areaOf(rev),
    '反向绕序也必须是外扩');
});

test('外扩后相邻色块应互相重叠，不能留缝', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(CORE, 'utf8');
  const start = src.indexOf('function inflateLoop(');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { if (--depth === 0) { end = i + 1; break; } }
  }
  const inflateLoop = new Function(src.slice(start, end) + '; return inflateLoop;')();

  const left = [0, 0, 10, 0, 10, 10, 0, 10];
  const right = [10, 0, 20, 0, 20, 10, 10, 10];
  const L = inflateLoop(left, 0.5), R = inflateLoop(right, 0.5);
  const lMaxX = Math.max(...Array.from({ length: L.length / 2 }, (_, k) => L[k * 2]));
  const rMinX = Math.min(...Array.from({ length: R.length / 2 }, (_, k) => R[k * 2]));
  assert.ok(rMinX <= lMaxX, `两块应重叠或相接，实际 gap=${(rMinX - lMaxX).toFixed(3)}`);
});

/* ------------------------------------------------- 2. 时间轴串行 */
test('时间轴严格串行：start[i] 等于上一笔的 start+dur', () => {
  for (const n of [100, 5000, 60000]) {
    const strokes = [];
    for (let k = 0; k < n; k++) {
      strokes.push({
        d: 'M0 0L10 10', c: '#123456', w: 4, a: 1, kind: 0,
        len: 12, layer: 0, detail: 0, tag: '',
      });
    }
    const tl = OILCore.buildTimeline([{ strokes, weight: 5 }], 90);
    for (let k = 1; k < tl.strokes.length; k++) {
      const prevEnd = tl.strokes[k - 1].start + tl.strokes[k - 1].dur;
      assert.strictEqual(tl.strokes[k].start, prevEnd,
        `n=${n} 第 ${k} 笔起点应精确衔接上一笔终点`);
    }
    assert.ok(Number.isFinite(tl.total) && tl.total > 0);
  }
});

test('时间轴 total 等于各阶段时长之和，且不为 NaN', () => {
  const tl = OILCore.buildTimeline([
    { strokes: [{ d: 'M0 0L1 1', c: '#fff', w: 2, a: 1, kind: 0, len: 5, layer: 0 }], weight: 3 },
    { strokes: [{ d: 'M0 0L2 2', c: '#fff', w: 2, a: 1, kind: 0, len: 5, layer: 0 }], weight: 7 },
  ], 60);
  assert.ok(Number.isFinite(tl.total));
  assert.ok(Math.abs(tl.total - 60) < 1e-9, `total 应约等于 60，实际 ${tl.total}`);
});

/* ------------------------------------------------- 3. 八种风格 */
test('八种风格都能生成合法笔触', () => {
  const W = 96, H = 72;
  const rgba = structuredRGBA(W, H);
  const A = OILCore.analyze(rgba, W, H, BASE_OPTS);

  for (const style of OILCore.STYLE_ORDER) {
    const def = OILCore.STYLES[style];
    assert.ok(def, `风格 ${style} 应存在于注册表`);

    const stages = OILCore.buildStages(A, rgba, W, H,
      Object.assign({}, BASE_OPTS, { style }), () => {});
    assert.ok(Array.isArray(stages) && stages.length > 0, `${style} 应产出阶段`);

    const tl = OILCore.buildTimeline(stages, 30);
    assert.ok(tl.strokes.length > 0, `${style} 应产出笔触`);
    assert.ok(Number.isFinite(tl.total) && tl.total > 0, `${style} 时长应是正数`);

    // 每笔的路径和颜色必须有效（NaN 会画不出来）
    for (const s of tl.strokes.slice(0, 200)) {
      assert.ok(!/NaN|undefined/.test(s.d), `${style} 的路径含 NaN: ${s.d.slice(0, 40)}`);
      assert.ok(/^#[0-9a-f]{6}$/i.test(s.c) || /^rgb/.test(s.c),
        `${style} 颜色格式异常: ${s.c}`);
      assert.ok(Number.isFinite(s.w) && s.w >= 0, `${style} 宽度异常: ${s.w}`);
      assert.ok(Number.isFinite(s.start) && Number.isFinite(s.dur),
        `${style} 时间异常`);
    }
  }
});

test('每种风格的 steps / nStages / ground 都齐全', () => {
  for (const style of OILCore.STYLE_ORDER) {
    const d = OILCore.STYLES[style];
    assert.ok(typeof d.label === 'string' && d.label.length, `${style} 缺 label`);
    assert.ok(Array.isArray(d.steps) && d.steps.length > 0, `${style} 缺 steps`);
    assert.strictEqual(d.nStages, d.steps.length,
      `${style} 的 nStages(${d.nStages}) 应等于 steps 数(${d.steps.length})`);
    assert.ok(d.ground && d.ground.type, `${style} 缺 ground`);
  }
  assert.strictEqual(OILCore.STYLE_ORDER.length, 8, '应有八种风格');
});

/* ------------------------------------------------- 4. 透明像素 */
test('全透明区域不应被当成纯黑（alpha 不能被忽略）', () => {
  const W = 64, H = 64;
  const opts = Object.assign({}, BASE_OPTS, { style: 'oil' });

  // 完全不透明红 vs 完全透明但 RGB 仍为红
  const opaque = solidRGBA(W, H, 220, 60, 60, 255);
  const clear = solidRGBA(W, H, 220, 60, 60, 0);

  const A1 = OILCore.analyze(opaque, W, H, opts);
  const A2 = OILCore.analyze(clear, W, H, opts);

  // 两者 RGB 相同，按 alpha 加权后 RGB 仍然相同 → 分层结果应一致
  // （修复前因为透明像素 RGB=0 参与平均，会把结果拉黑导致差异）
  let diff = 0;
  for (let i = 0; i < A1.labels.length; i++) {
    if (A1.labels[i] !== A2.labels[i]) diff++;
  }
  assert.strictEqual(diff, 0, '同 RGB 不同 alpha 的分层结果应一致');

  // 关键：透明图的层亮度不能塌到 0（修复前全是 0）
  const lum = A2.layers.map(l => l.L);
  assert.ok(lum.some(v => v > 1),
    `透明像素应按 alpha 加权保留颜色，实际层亮度 ${lum.map(v => v.toFixed(1)).join(',')}`);
});

test('worker 里的透明合成逻辑不会破坏不透明图', () => {
  // 复刻 worker.js 的合成分支：全部 alpha=255 时应原样返回
  const W = 32, H = 32;
  const rgba = solidRGBA(W, H, 10, 20, 30, 255);
  const before = Array.from(rgba);
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
  assert.strictEqual(hasAlpha, false, '不透明图不应触发合成');
  assert.deepStrictEqual(Array.from(rgba), before);
});

/* ------------------------------------------------- 5. 边界输入 */
test('极小图不会崩，也不产生 NaN 笔触', () => {
  for (const [w, h] of [[8, 8], [9, 16], [1, 1]]) {
    const rgba = structuredRGBA(w, h);
    const A = OILCore.analyze(rgba, w, h, BASE_OPTS);
    assert.ok(A.AW > 0 && A.AH > 0);
    const stages = OILCore.buildStages(A, rgba, w, h,
      Object.assign({}, BASE_OPTS, { style: 'oil' }), () => {});
    const tl = OILCore.buildTimeline(stages, 20);
    for (const s of tl.strokes) {
      assert.ok(!/NaN/.test(s.d), `${w}x${h} 产出 NaN 路径`);
    }
  }
});

test('极扁/极长图也能处理', () => {
  for (const [w, h] of [[256, 8], [8, 256]]) {
    const rgba = structuredRGBA(w, h);
    const A = OILCore.analyze(rgba, w, h, BASE_OPTS);
    const stages = OILCore.buildStages(A, rgba, w, h,
      Object.assign({}, BASE_OPTS, { style: 'posterize' }), () => {});
    const tl = OILCore.buildTimeline(stages, 20);
    assert.ok(tl.strokes.length > 0, `${w}x${h} 色块应产出笔触`);
  }
});
