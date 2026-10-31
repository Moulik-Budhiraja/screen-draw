// Small geometry helpers shared by rendering, hit-testing and transforms.

export const rotate = (x, y, cx, cy, a) => {
  if (!a) return [x, y];
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const distToSegment = (p, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

export const distToPolyline = (p, pts) => {
  if (pts.length === 1) return dist(p, pts[0]);
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distToSegment(p, pts[i], pts[i + 1]));
  return d;
};

// Catmull-Rom through the points; close to how rough.js draws `curve`.
export const sampleCurve = (points, steps = 16) => {
  if (points.length < 3) return points.map((p) => p.slice());
  const pts = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((k) =>
        0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
          (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(points[points.length - 1].slice());
  return out;
};

export const boundsOfPoints = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

export const isBoxShape = (el) => el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse';
export const isLinear = (el) => el.type === 'line' || el.type === 'arrow';
export const hasPoints = (el) => isLinear(el) || el.type === 'freedraw';

export const freedrawSize = (el) => el.strokeWidth * 4.25;

// Points actually drawn for a linear element (curved when more than two points).
export const linearPath = (el) => sampleCurve(el.points);

// Axis-aligned bounds in screen space.
export const getAABB = (el) => {
  if (isLinear(el)) return boundsOfPoints(linearPath(el));
  if (el.type === 'freedraw') {
    const [x0, y0, x1, y1] = boundsOfPoints(el.points);
    const r = freedrawSize(el) / 2;
    return [x0 - r, y0 - r, x1 + r, y1 + r];
  }
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const corners = [[el.x, el.y], [el.x + el.width, el.y], [el.x + el.width, el.y + el.height], [el.x, el.y + el.height]]
    .map(([x, y]) => rotate(x, y, cx, cy, el.angle || 0));
  return boundsOfPoints(corners);
};

export const unionAABB = (els) => {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const el of els) {
    const [x0, y0, x1, y1] = getAABB(el);
    b = [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)];
  }
  return b;
};

// Point in the element's own unrotated frame, relative to its top-left.
export const toLocal = (el, p) => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const [x, y] = rotate(p[0], p[1], cx, cy, -(el.angle || 0));
  return [x - el.x, y - el.y];
};

const diamondPoints = (w, h) => [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];

export const insideShape = (el, p) => {
  const [lx, ly] = toLocal(el, p);
  const w = el.width;
  const h = el.height;
  if (el.type === 'rectangle' || el.type === 'text') return lx >= 0 && ly >= 0 && lx <= w && ly <= h;
  if (el.type === 'ellipse') {
    const a = w / 2 || 1;
    const b = h / 2 || 1;
    return ((lx - a) / a) ** 2 + ((ly - b) / b) ** 2 <= 1;
  }
  if (el.type === 'diamond') {
    const a = w / 2 || 1;
    const b = h / 2 || 1;
    return Math.abs(lx - a) / a + Math.abs(ly - b) / b <= 1;
  }
  return false;
};

export const distToOutline = (el, p) => {
  const [lx, ly] = toLocal(el, p);
  const w = el.width;
  const h = el.height;
  if (el.type === 'rectangle') {
    if (lx >= 0 && ly >= 0 && lx <= w && ly <= h) return Math.min(lx, w - lx, ly, h - ly);
    return Math.hypot(Math.max(0, -lx, lx - w), Math.max(0, -ly, ly - h));
  }
  if (el.type === 'diamond') {
    const d = diamondPoints(w, h);
    return distToPolyline([lx, ly], [...d, d[0]]);
  }
  if (el.type === 'ellipse') {
    const a = w / 2 || 0.5;
    const b = h / 2 || 0.5;
    const px = lx - a;
    const py = ly - b;
    const r = Math.hypot(px, py);
    if (r === 0) return Math.min(a, b);
    const t = 1 / Math.sqrt((px / a) ** 2 + (py / b) ** 2);
    return r * Math.abs(1 - t);
  }
  return Infinity;
};

export const snapAngle = (from, to, step = Math.PI / 12) => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
};

export const normalizeAngle = (a) => {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
};
