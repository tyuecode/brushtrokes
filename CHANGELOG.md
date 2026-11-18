# 更新日志

版本号对应 `index.html` 里的 `window.OIL_BUILD`。

## 20261118-brushtrokes

修复了一批正确性与可用性问题，并补上自动化检查。

### 修复

- **色块外扩方向反了**（`core.js` `inflateLoop`）
  屏幕坐标下法线朝向内，导致「外扩」实际是内缩，相邻色块交界处反而露出底色缝。
  改为按绕向正确取外法线后，两块会互相压住。
- **缓存清除机制失效**（`index.html`）
  版本号原本放在 `build.js`，而 `build.js` 自身也被 Pages 缓存 4 小时，
  老访客永远读到旧版本号，`render.js` / `worker.js` 也永远命中旧缓存。
  改为把 `OIL_BUILD` 内联进 `index.html`，并移除 `build.js`。
- **播放器在常见屏幕被裁切**（`player-template.html`）
  原本 body 写死 `1920×1080` + `overflow:hidden`，1366×768 笔记本、
  带地址栏的 1080p 屏幕、以及所有竖图都会被直接切掉且无法滚动。
  改为固定舞台 + 按视口等比缩放，画布尺寸同时受宽高约束。
- **透明 PNG 出现黑块**（`core.js` / `worker.js`）
  降采样与取色都只看 RGB，透明像素（通常 RGB=0）被当纯黑参与分层和 Canny。
  降采样改为按 alpha 加权，worker 先把透明像素合成到该风格的画布底色上。
- **选图解码失败会错配**（`index.html`）
  先改 `curFile` 再 await 解码，解码失败会「用旧图生成、把坏文件塞进播放器」，
  且缩略图 blob URL 从不回收。改为解码成功后才提交状态，失败给明确提示。
- **导出尺寸误报**（`index.html`）
  大图选 3 倍时实际被静默缩到 8000px，文件名和提示却写原始倍数尺寸。
  改为回传真实输出尺寸，并在被限制时明确提示。
- **导出内存开销**（`index.html`）
  `toDataURL` + 逐字节 `atob` 改回 `toBlob`，不再生成 base64 中间字符串。
- **播放器没有暂停/重播**（`player-template.html`）
  补上按钮与空格 / `R` 快捷键；播完后停止 RAF，不再永久空转。
- **键盘完全不可用**（`index.html`）
  选图区与风格卡片原本是纯 `div`，无法 Tab 聚焦。补 `role` / `tabindex` /
  回车空格 / 方向键，并加 `:focus-visible` 样式；`label` 用 `for` 关联控件。
- **错误处理补齐**（`index.html` / `worker.js`）
  `worker.onerror` 补 `setProg(0)`；`fetch` 检查 `response.ok`；
  worker 校验图像尺寸；生成播放器时对内联 JSON 做 `</script>` 转义；
  meta description 补全八种风格并加 Open Graph。

### 新增

- `package.json` + `test/core.test.js`：`node --test` 算法回归测试（零依赖）
- `test/check-assets.js`：资源一致性静态检查（版本号 / 风格元数据 / 占位符 / 可访问性约定）
- `.nojekyll`
- `README` 补充测试说明、8000px 导出上限、版本号必须内联的原因

## 20261111-brushtrokes

首个公开版本：八种风格、纯前端、单文件播放器、高清终帧导出。
