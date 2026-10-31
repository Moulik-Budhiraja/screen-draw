// Draws the app icon with rough.js (the same sketchy strokes the app uses) and
// writes assets/icon.svg. scripts/make-icon.sh turns it into AppIcon.icns.
// Fixed seeds keep the drawing identical between runs.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const rough = require('roughjs');
const gen = rough.generator();

const RED = '#e03131';
const BLUE = '#1971c2';

// macOS icon grid: an 824pt rounded square centered on a 1024pt canvas.
const S = 1024, BODY = 824, M = (S - BODY) / 2, R = 186;

function paths(drawable) {
  return gen.toPaths(drawable).map(p =>
    `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || 'none'}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('\n    ');
}

const base = { roughness: 1.1, bowing: 1, disableMultiStroke: false };

// A red loop, the way you'd circle something on screen.
const circle = gen.ellipse(584, 432, 420, 340, {
  ...base, stroke: RED, strokeWidth: 22, seed: 7, roughness: 1.6,
  fill: '#ffa8a8', fillStyle: 'hachure', hachureGap: 30, fillWeight: 9, hachureAngle: -41,
});

// A blue arrow sweeping up into it.
const tail = [250, 800], tip = [402, 590];
const shaft = gen.curve([tail, [282, 700], [336, 636], tip], {
  ...base, stroke: BLUE, strokeWidth: 22, seed: 3, roughness: 1.4,
});
const ang = Math.atan2(tip[1] - 636, tip[0] - 336);
const head = (side) => {
  const a = ang + Math.PI + side * (28 * Math.PI / 180);
  return gen.line(tip[0], tip[1], tip[0] + Math.cos(a) * 84, tip[1] + Math.sin(a) * 84, {
    ...base, stroke: BLUE, strokeWidth: 22, seed: side > 0 ? 11 : 13,
  });
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eeedf6"/>
    </linearGradient>
  </defs>
  <rect x="${M}" y="${M + 12}" width="${BODY}" height="${BODY}" rx="${R}" fill="#000" opacity="0.10"/>
  <rect x="${M}" y="${M + 4}" width="${BODY}" height="${BODY}" rx="${R}" fill="#000" opacity="0.10"/>
  <rect x="${M}" y="${M}" width="${BODY}" height="${BODY}" rx="${R}" fill="url(#paper)" stroke="#000" stroke-opacity="0.06" stroke-width="2"/>
  <g>
    ${paths(circle)}
    ${paths(shaft)}
    ${paths(head(1))}
    ${paths(head(-1))}
  </g>
</svg>
`;

mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
writeFileSync(new URL('../assets/icon.svg', import.meta.url), svg);
console.log('wrote assets/icon.svg');
