// Bundles the drawing engine and inlines it (plus the Excalifont subsets) into
// one self-contained HTML file the native app loads.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'build', 'overlay.html');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'web/src/app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'safari16',
  write: false,
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// Unicode ranges from Excalidraw's own subsetting of Excalifont.
const subsets = [
  ['Excalifont-0.woff2', 'U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212'],
  ['Excalifont-1.woff2', 'U+100-130,U+132-137,U+139-149,U+14c-151,U+154-17e,U+192,U+1fc-1ff,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+2113'],
  ['Excalifont-4.woff2', 'U+2c7,U+2d8-2d9,U+2db,U+2dd,U+302,U+306-307,U+30a-30c,U+326-328,U+212e,U+2211,U+fb01-fb02'],
  ['Excalifont-6.woff2', 'U+300-301,U+303'],
];
const fontCss = subsets.map(([file, range]) => {
  const data = fs.readFileSync(path.join(root, 'web/fonts', file)).toString('base64');
  return `@font-face{font-family:Excalifont;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range};font-display:block}`;
}).join('\n');

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
  .replace('/*FONTS*/', () => fontCss)
  .replace('<!--SCRIPT-->', () => `<script>${js}</script>`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);
