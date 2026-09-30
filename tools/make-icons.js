#!/usr/bin/env node
/* =====================================================================
   アプリのアイコンの PNG を icon.svg から作る。
   使い方(リポジトリの直下で): node tools/make-icons.js
   ブラウザ(Chromium)で SVG を描いて書き出すので、Playwright が要る
   (npm の全体に入っているものを使う。このリポジトリには依存を増やさない)。
   作るもの:
     apple-touch-icon.png   180×180  iPhone のホーム画面(角は端末が丸める。透明にしない)
     icon-192.png / icon-512.png     Android のホーム画面など(manifest.webmanifest)
     icon-maskable-512.png  512×512  Android の切り抜き用。丸に切っても欠けないよう、絵を 84% に縮める
     favicon-32.png         32×32    SVG のアイコンを使えないブラウザのタブ用
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');

// 切り抜き用: 地(最初の全面の rect)はそのまま、その後の絵を中心で縮める
function maskable(svg, k){
  const bg = svg.match(/<rect width="512" height="512"[^>]*\/>/);
  if(!bg) throw new Error('icon.svg に全面の地(<rect width="512" height="512" .../>)が見つかりません');
  const i = svg.indexOf(bg[0]) + bg[0].length, j = svg.lastIndexOf('</svg>');
  return svg.slice(0, i) + `\n  <g transform="translate(256 256) scale(${k}) translate(-256 -256)">` + svg.slice(i, j) + '  </g>\n</svg>\n';
}

const OUT = [
  { file: 'apple-touch-icon.png', size: 180, svg: SRC },
  { file: 'icon-192.png', size: 192, svg: SRC },
  { file: 'icon-512.png', size: 512, svg: SRC },
  { file: 'icon-maskable-512.png', size: 512, svg: maskable(SRC, 0.84) },
  { file: 'favicon-32.png', size: 32, svg: SRC },
];

(async () => {
  const b = await chromium.launch();
  for(const o of OUT){
    const p = await b.newPage({ viewport: { width: o.size, height: o.size }, deviceScaleFactor: 1 });
    const url = 'data:image/svg+xml;base64,' + Buffer.from(o.svg).toString('base64');
    await p.setContent(`<html><body style="margin:0"><img src="${url}" width="${o.size}" height="${o.size}" style="display:block"></body></html>`);
    await p.waitForFunction(() => document.images[0].complete);
    await p.screenshot({ path: path.join(ROOT, o.file), clip: { x: 0, y: 0, width: o.size, height: o.size } });
    await p.close();
    console.log('作成:', o.file, o.size + '×' + o.size);
  }
  await b.close();
})();
