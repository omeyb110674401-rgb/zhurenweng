/**
 * 生成站点品牌资产（issue #53）：`favicon.ico`、`apple-icon.png`、`public/og-image.png`。
 *
 * 为什么是脚本 + 静态文件，而不是 Next 的 `icon.tsx` / `apple-icon.tsx` /
 * `opengraph-image.tsx` 文件约定：
 *   1. 同一个目录里不能同时存在 `icon.svg` 与 `icon.tsx`（基础名冲突），而手写的
 *      SVG 是最好的 favicon（任意尺寸都清晰、不依赖字体）；
 *   2. **文件约定的 og:image 会被页面自己的 `openGraph` 整块覆盖** —— 实测统计页与
 *      详情页都因此完全没有分享图。改成静态文件 + 显式声明后，谁覆盖都不会丢；
 *   3. 构建期不再执行 satori/resvg 光栅化，Docker 构建少一个不确定项。
 *
 * 光栅化走仓库已有的 `next/og`（satori + resvg wasm），无新增依赖；实测可在独立
 * Node 进程里直接跑（不需要 Next 服务器）。
 *
 * 标记：琥珀底 + 三条递减白杠（「一列公示条目」），与 `src/app/icon.svg` 同一份形状。
 * **不含文字**：站名是中文，光栅化器不带 CJK 字体（写中文就是豆腐块），按需子集化
 * 一个中文字体属单独一轮（已登记 FOLLOWUPS）。
 *
 * 改标记时：icon.svg 与 `mark()` / `appleMark()` / `ogCard()` 三处一起改，
 * 然后重跑本脚本（产物提交）。
 *
 * 用法：node scripts/gen-brand-assets.mjs [--preview 目录]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { ImageResponse } from 'next/og.js';

const AMBER = '#b45309';
const WHITE = '#ffffff';

/** 三条递减白杠：`left` / `width` 按标记宽度取比例，`barHeight` 带 2px 下限（否则 16px 下糊成发丝）。 */
function bars(size, { leftRatio, widthRatios }) {
  const barHeight = Math.max(2, Math.round(size * 0.078));
  const gap = barHeight;
  const total = barHeight * 3 + gap * 2;
  const top = (size - total) / 2;
  const left = size * leftRatio;
  return widthRatios.map((ratio, index) =>
    h('div', {
      key: `bar-${index}`,
      style: {
        position: 'absolute',
        left,
        top: top + index * (barHeight + gap),
        width: size * ratio,
        height: barHeight,
        borderRadius: barHeight / 2,
        background: WHITE,
        display: 'flex',
      },
    }),
  );
}

/** favicon 的标记：琥珀圆角方（透明四角）+ 三条白杠。 */
function mark(size) {
  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: AMBER,
        borderRadius: size * 0.219,
      },
    },
    bars(size, { leftRatio: 0.25, widthRatios: [0.5, 0.375, 0.25] }),
  );
}

/** iOS 主屏图标：满幅琥珀（iOS 自己加圆角遮罩）+ 居中的三条白杠。 */
function appleMark(size) {
  const barHeight = Math.round(size * 0.089);
  const gap = Math.round(size * 0.089);
  const widths = [0.622, 0.467, 0.311];
  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: AMBER,
        gap,
      },
    },
    widths.map((ratio, index) =>
      h('div', {
        key: `apple-bar-${index}`,
        style: {
          width: size * ratio,
          height: barHeight,
          borderRadius: barHeight / 2,
          background: WHITE,
          display: 'flex',
        },
      }),
    ),
  );
}

/** 分享卡片：琥珀底 + 两处色块 + 白色文档卡（卡内三条递减横杠）。 */
function ogCard() {
  const { width, height } = { width: 1200, height: 630 };
  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        background: AMBER,
      },
    },
    [
      h('div', {
        key: 'arc-top',
        style: {
          position: 'absolute',
          top: -160,
          right: -120,
          width: 520,
          height: 520,
          borderRadius: 260,
          background: '#c2410c',
          display: 'flex',
        },
      }),
      h('div', {
        key: 'arc-bottom',
        style: {
          position: 'absolute',
          bottom: -200,
          left: -140,
          width: 460,
          height: 460,
          borderRadius: 230,
          background: '#92400e',
          display: 'flex',
        },
      }),
      h(
        'div',
        {
          key: 'card',
          style: {
            width: 620,
            height: 380,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: WHITE,
            borderRadius: 28,
            gap: 34,
          },
        },
        [
          { width: 380, color: '#b45309' },
          { width: 290, color: '#d97706' },
          { width: 190, color: '#f59e0b' },
        ].map((bar, index) =>
          h('div', {
            key: `og-bar-${index}`,
            style: {
              width: bar.width,
              height: 34,
              borderRadius: 17,
              background: bar.color,
              display: 'flex',
            },
          }),
        ),
      ),
    ],
  );
}

async function renderPng(element, width, height) {
  const response = new ImageResponse(element, { width, height });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 把若干 PNG 打包成一个 ICO。
 * 结构：6 字节目录头（保留位 / 类型 1=图标 / 图像数）+ 每图 16 字节目录项 + 图像数据。
 * Vista 起 ICO 允许直接内嵌 PNG（不必转 BMP），目录项的宽高用 0 表示 256。
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // 调色板颜色数（PNG 不用）
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // 数据长度
    entry.writeUInt32LE(offset, 12); // 数据偏移
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const icoSizes = [16, 32, 48];
const icoImages = [];
for (const size of icoSizes) {
  icoImages.push({ size, png: await renderPng(mark(size), size, size) });
}
const ico = buildIco(icoImages);
const icoTarget = join(process.cwd(), 'src', 'app', 'favicon.ico');
writeFileSync(icoTarget, ico);
console.log(`favicon.ico：${icoTarget}（${icoSizes.join('/')} 三个尺寸，${ico.length} 字节）`);

const applePng = await renderPng(appleMark(180), 180, 180);
const appleTarget = join(process.cwd(), 'src', 'app', 'apple-icon.png');
writeFileSync(appleTarget, applePng);
console.log(`apple-icon.png：${appleTarget}（180×180，${applePng.length} 字节）`);

const ogPng = await renderPng(ogCard(), 1200, 630);
const ogDir = join(process.cwd(), 'public');
mkdirSync(ogDir, { recursive: true });
const ogTarget = join(ogDir, 'og-image.png');
writeFileSync(ogTarget, ogPng);
console.log(`og-image.png：${ogTarget}（1200×630，${ogPng.length} 字节）`);

// --preview <dir>：额外导出放大的 PNG，便于人眼确认图形没有错位（CI 与人眼各管一段）
const previewIndex = process.argv.indexOf('--preview');
if (previewIndex !== -1) {
  const dir = process.argv[previewIndex + 1] ?? '.';
  mkdirSync(dir, { recursive: true });
  const previewPng = await renderPng(mark(192), 192, 192);
  const previewPath = join(dir, 'brand-mark-192.png');
  writeFileSync(previewPath, previewPng);
  console.log(`预览图：${previewPath}（${previewPng.length} 字节）`);
}
