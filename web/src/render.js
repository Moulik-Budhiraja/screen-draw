// Turns elements into pixels. Shapes go through rough.js (the same library and
// options Excalidraw uses), pen strokes through perfect-freehand.
import rough from 'roughjs';
import { getStroke } from 'perfect-freehand';
import { boundsOfPoints, isBoxShape, isLinear, sampleCurve, dist } from './geometry.js';

const generator = rough.generator();
const shapeCache = new WeakMap();

export const FONT_FAMILY = 'Excalifont, sans-serif, "Segoe UI Emoji"';
export const LINE_HEIGHT = 1.25;
export const font = (size) => `${size}px ${FONT_FAMILY}`;

// Excalidraw: rectangles use an adaptive radius (25% up to a 32px cap), diamonds a proportional one.
export const cornerRadius = (x, proportional) => (proportional || x <= 128 ? x * 0.25 : 32);

const dashFor = (el) => (el.strokeStyle === 'dotted' ? [1.5, 6 + el.strokeWidth] : el.strokeStyle === 'dashed' ? [8, 8 + el.strokeWidth] : undefined);

const adjustRoughness = (el, w, h) => {
  const roughness = 1;
  const maxSize = Math.max(w, h);
  const minSize = Math.min(w, h);
  if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && isBoxShape(el)) || (isLinear(el) && maxSize >= 50)) return roughness;
  return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
};

const roughOptions = (el, w, h, continuousPath = false) => {
  const solid = el.strokeStyle === 'solid';
  const o = {
    seed: el.seed,
    strokeLineDash: dashFor(el),
    disableMultiStroke: !solid,
    strokeWidth: solid ? el.strokeWidth : el.strokeWidth + 0.5,
    fillWeight: el.strokeWidth / 2,
    hachureGap: el.strokeWidth * 4,
    roughness: adjustRoughness(el, w, h),
    stroke: el.strokeColor,
    preserveVertices: continuousPath,
  };
  if (isBoxShape(el)) {
    o.fillStyle = 'solid';
    o.fill = el.backgroundColor || undefined;
    if (el.type === 'ellipse') o.curveFitting = 1;
  }
  return o;
};

const arrowheadPoints = (el, pts) => {
  const tip = pts[pts.length - 1];
  // Excalidraw aims the head from 30% before the end of the last drawn segment.
  let from;
  if (pts.length > 2) {
    const steps = 20;
    const path = sampleCurve(pts, steps);
    from = path[path.length - 1 - Math.round(steps * 0.3)];
  } else {
    const a = pts[0];
    from = [tip[0] + (a[0] - tip[0]) * 0.3, tip[1] + (a[1] - tip[1]) * 0.3];
  }
  const d = dist(from, tip);
  if (d === 0) return null;
  const nx = (tip[0] - from[0]) / d;
  const ny = (tip[1] - from[1]) / d;
  const segLen = dist(pts[pts.length - 2], tip);
  const size = Math.min(25, segLen * 0.5);
  const angleDeg = 20 + 10 * Math.max(0, Math.min(1, (25 - size) / 15));
  const xs = tip[0] - nx * size;
  const ys = tip[1] - ny * size;
  const a = (angleDeg * Math.PI) / 180;
  const rot = (ang) => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return [(xs - tip[0]) * c - (ys - tip[1]) * s + tip[0], (xs - tip[0]) * s + (ys - tip[1]) * c + tip[1]];
  };
  return [tip, rot(-a), rot(a)];
};

const buildShapes = (el, w, h, local) => {
  if (el.type === 'rectangle') {
    const r = cornerRadius(Math.min(w, h));
    return [generator.path(
      `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`,
      roughOptions(el, w, h, true),
    )];
  }
  if (el.type === 'diamond') {
    const [tx, ty, rx, ry, bx, by, lx, ly] = [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2];
    const vr = cornerRadius(Math.abs(tx - lx), true);
    const hr = cornerRadius(Math.abs(ry - ty), true);
    return [generator.path(
      `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr}
       C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr}
       L ${bx + vr} ${by - hr}
       C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr}
       L ${lx + vr} ${ly + hr}
       C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr}
       L ${tx - vr} ${ty + hr}
       C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`,
      roughOptions(el, w, h, true),
    )];
  }
  if (el.type === 'ellipse') {
    return [generator.ellipse(w / 2, h / 2, w, h, roughOptions(el, w, h))];
  }
  if (isLinear(el)) {
    const o = roughOptions(el, w, h);
    const shapes = [local.length > 2 ? generator.curve(local, o) : generator.linearPath(local, o)];
    if (el.type === 'arrow') {
      const head = arrowheadPoints(el, local);
      if (head) {
        const [tip, a, b] = head;
        // Like Excalidraw: heads are solid unless the arrow is dotted.
        const ho = { ...o, roughness: Math.min(1, o.roughness) };
        if (el.strokeStyle === 'dotted') ho.strokeLineDash = [1.5, 6 + (el.strokeWidth - 1) - 1];
        else delete ho.strokeLineDash;
        shapes.push(generator.line(a[0], a[1], tip[0], tip[1], ho), generator.line(b[0], b[1], tip[0], tip[1], ho));
      }
    }
    return shapes;
  }
  return [];
};

const cached = (el, key, make) => {
  const hit = shapeCache.get(el);
  if (hit && hit.key === key) return hit.value;
  const value = make();
  shapeCache.set(el, { key, value });
  return value;
};

// perfect-freehand outline -> Path2D with the same quadratic smoothing Excalidraw uses.
// Mouse/trackpad strokes are constant width (Excalidraw's default); stylus strokes
// use pressure for the original variable-width look.
const freedrawPath = (el, origin) => {
  const pts = el.points.map(([x, y], i) => [x - origin[0], y - origin[1], el.pressures?.[i] ?? 0.5]);
  const outline = el.variable
    ? getStroke(pts, {
      simulatePressure: false,
      size: el.strokeWidth * 4.25,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.2,
      easing: (t) => Math.sin((t * Math.PI) / 2),
      last: !!el.finished,
    })
    : getStroke(pts.map(([x, y]) => [x, y]), {
      simulatePressure: false,
      size: el.strokeWidth * 1.4 * 2,
      thinning: 0,
      smoothing: 0.5,
      streamline: 0.5,
      last: !!el.finished,
    });
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
};

// --- text -----------------------------------------------------------------

const measureCtx = document.createElement('canvas').getContext('2d');

// Excalifont's vertical metrics (units per em 1000), as Excalidraw uses them.
const ASCENT = 886 / 1000;
const DESCENT = 374 / 1000;

export const measureWidth = (text, size) => {
  measureCtx.font = font(size);
  return measureCtx.measureText(text).width;
};

export const wrapText = (text, size, maxWidth) => {
  const out = [];
  for (const para of text.split('\n')) {
    if (maxWidth == null) {
      out.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measureWidth(candidate, size) <= maxWidth || line === '') {
        if (measureWidth(candidate, size) > maxWidth && line === '') {
          // A single word longer than the box: break it by characters.
          let chunk = '';
          for (const ch of candidate) {
            if (measureWidth(chunk + ch, size) > maxWidth && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line);
  }
  return out;
};

const drawText = (ctx, el) => {
  const lines = el.lines || el.text.split('\n');
  const lh = el.fontSize * LINE_HEIGHT;
  const ascent = el.fontSize * ASCENT;
  const descent = el.fontSize * DESCENT;
  const baseline = ascent + (lh - ascent - descent) / 2;
  ctx.font = font(el.fontSize);
  ctx.fillStyle = el.strokeColor;
  ctx.textBaseline = 'alphabetic';
  const centered = !!el.containerId;
  ctx.textAlign = centered ? 'center' : 'left';
  const x = centered ? el.width / 2 : 0;
  lines.forEach((line, i) => ctx.fillText(line, x, i * lh + baseline));
};

// --- entry point ----------------------------------------------------------

export const drawElement = (ctx, rc, el, alpha = 1) => {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (el.type === 'freedraw') {
    const origin = el.points[0];
    const key = `${el.points.length}|${el.points.map((p) => `${(p[0] - origin[0]).toFixed(1)},${(p[1] - origin[1]).toFixed(1)}`).join(';')}|${el.finished}|${el.strokeWidth}|${el.variable}`;
    const path = cached(el, key, () => freedrawPath(el, origin));
    ctx.translate(origin[0], origin[1]);
    ctx.fillStyle = el.strokeColor;
    ctx.fill(path);
  } else if (isLinear(el)) {
    const [x0, y0, x1, y1] = boundsOfPoints(el.points);
    const local = el.points.map(([x, y]) => [x - x0, y - y0]);
    const key = `${el.type}|${local.map((p) => p.join(',')).join(';')}|${el.strokeColor}|${el.strokeStyle}|${el.strokeWidth}|${el.seed}`;
    const shapes = cached(el, key, () => buildShapes(el, x1 - x0, y1 - y0, local));
    ctx.translate(x0, y0);
    shapes.forEach((s) => rc.draw(s));
  } else {
    const w = el.width;
    const h = el.height;
    ctx.translate(el.x + w / 2, el.y + h / 2);
    ctx.rotate(el.angle || 0);
    ctx.translate(-w / 2, -h / 2);
    if (el.type === 'text') drawText(ctx, el);
    else {
      const key = `${el.type}|${w}|${h}|${el.strokeColor}|${el.backgroundColor}|${el.strokeStyle}|${el.strokeWidth}|${el.seed}`;
      const shapes = cached(el, key, () => buildShapes(el, w, h));
      shapes.forEach((s) => rc.draw(s));
    }
  }
  ctx.restore();
};
