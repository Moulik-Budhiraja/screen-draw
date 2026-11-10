import rough from 'roughjs';
import * as G from './geometry.js';
import { drawElement, font, LINE_HEIGHT, measureWidth, wrapText } from './render.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PALETTE = { 1: '#e03131', 2: '#1971c2', 3: '#2f9e44', 4: '#1e1e1e', 5: '#ffffff' };
const FILL_ALPHA = 0.3;
const TOOL_KEYS = { v: 'select', r: 'rectangle', d: 'diamond', c: 'ellipse', a: 'arrow', w: 'line', q: 'freedraw', t: 'text', e: 'eraser' };
const DEFAULT_TOOL = 'freedraw';
const STROKE_WIDTH = 2;
const FREEDRAW_STROKE_WIDTH = 1;
const FONT_SIZE = 20;
const SELECTION_COLOR = '#6965db';
const HIT_TOLERANCE = 6.8;
const HANDLE_SIZE = 8;
const SELECTION_PADDING = 4;
const ROTATION_OFFSET = 16;
const POINT_RADIUS = 5;
const BOUND_TEXT_PADDING = 5;
const DOUBLE_ESC_MS = 450;
const NUDGE = 1;
const NUDGE_SHIFT = 5;
const DUPLICATE_OFFSET = 10;
const SIZE_MIN = 0.5;
const SIZE_MAX = 6;
const SIZE_STEP = 1.25;
const WHEEL_STEP = 30;
const BOARD_LIMIT = 100;

const hexToRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  elements: [],
  selected: new Set(),
  tool: DEFAULT_TOOL,
  stroke: PALETTE[1],
  fill: null,
  strokeStyle: 'solid',
  action: null,
  editing: null,
  multi: null,
  erasing: new Set(),
  pointer: [0, 0],
  lastEsc: 0,
  pendingDots: [],
  clipboard: null,
  size: 1, // scroll-adjusted scale for new strokes and text
  sizeHintUntil: 0,
  wheelAcc: 0,
};

const history = { stack: [[]], index: 0 };

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const rc = rough.canvas(canvas);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);
const clone = (v) => JSON.parse(JSON.stringify(v));
const byId = (id) => S.elements.find((e) => e.id === id);
const selectedEls = () => S.elements.filter((e) => S.selected.has(e.id));

// ---------------------------------------------------------------------------
// Rendering loop
// ---------------------------------------------------------------------------

let frameRequested = false;
const dirty = () => {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(render);
};

const resize = () => {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  dirty();
};

function render() {
  frameRequested = false;
  syncBoundTexts();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const editingId = S.editing?.id;
  for (const el of S.elements) {
    if (el.containerId) continue;
    const alpha = S.erasing.has(el.id) ? 0.2 : 1;
    drawElement(ctx, rc, el, alpha);
    if (el.boundTextId && el.boundTextId !== editingId) {
      const t = byId(el.boundTextId);
      if (t) drawElement(ctx, rc, t, alpha);
    }
  }
  drawSelection();
  drawMarquee();
  drawSizeHint();
}

// Brief preview next to the cursor while scrolling: a line at the new stroke
// width and "Aa" at the new font size.
function drawSizeHint() {
  const left = S.sizeHintUntil - performance.now();
  if (left <= 0) return;
  const [px, py] = S.pointer;
  const sw = strokeWidthFor(S.tool === 'freedraw' ? 'freedraw' : 'rectangle');
  const lineW = S.tool === 'freedraw' ? sw * 2.8 : sw;
  const fs = fontSizeNow();
  ctx.save();
  ctx.globalAlpha = Math.min(1, left / 250);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 3;
  ctx.strokeStyle = S.stroke;
  ctx.fillStyle = S.stroke;
  ctx.lineCap = 'round';
  ctx.lineWidth = lineW;
  const x = px + 18;
  const y = py + 18 + lineW / 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 40, y);
  ctx.stroke();
  ctx.font = font(fs);
  ctx.textBaseline = 'top';
  ctx.fillText('Aa', x, y + lineW / 2 + 6);
  ctx.restore();
  dirty();
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) return; // pinch gesture
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  S.wheelAcc += e.deltaY * px;
  let steps = 0;
  while (Math.abs(S.wheelAcc) >= WHEEL_STEP && Math.abs(steps) < 2) {
    const dir = S.wheelAcc < 0 ? 1 : -1; // scroll up = bigger
    steps += dir;
    S.wheelAcc += dir * WHEEL_STEP;
  }
  if (Math.abs(S.wheelAcc) >= WHEEL_STEP) S.wheelAcc = Math.sign(S.wheelAcc) * (WHEEL_STEP - 1);
  if (!steps) return;
  S.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, S.size * SIZE_STEP ** steps));
  S.pointer = [e.clientX, e.clientY];
  S.sizeHintUntil = performance.now() + 900;
  if (S.tool === 'freedraw') setCursor(penCursor());
  dirty();
}

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

// New elements take the current scroll size; placed elements keep theirs.
const strokeWidthFor = (type) => Math.round((type === 'freedraw' ? FREEDRAW_STROKE_WIDTH : STROKE_WIDTH) * S.size * 2) / 2;
const fontSizeNow = () => Math.max(8, Math.round(FONT_SIZE * S.size));

const newElement = (type, props) => ({
  id: uid(),
  type,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: S.stroke,
  backgroundColor: G.isBoxShape({ type }) ? S.fill : null,
  strokeStyle: type === 'freedraw' || type === 'text' ? 'solid' : S.strokeStyle,
  strokeWidth: strokeWidthFor(type),
  seed: randomSeed(),
  groupIds: [],
  ...props,
});

const outerGroup = (el) => (el.groupIds?.length ? el.groupIds[el.groupIds.length - 1] : null);

// An element plus everything that belongs with it (its outermost group).
const withGroup = (el) => {
  const g = outerGroup(el);
  if (!g) return [el.id];
  return S.elements.filter((e) => e.groupIds?.includes(g) && !e.containerId).map((e) => e.id);
};

const selectionIsSingleGroup = () => {
  const els = selectedEls();
  if (els.length < 2) return null;
  const g = outerGroup(els[0]);
  if (!g || !els.every((e) => outerGroup(e) === g)) return null;
  const members = S.elements.filter((e) => e.groupIds?.includes(g) && !e.containerId);
  return members.length === els.length ? g : null;
};

const boundMaxWidth = (c) => {
  if (c.type === 'ellipse') return Math.round((c.width / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (c.type === 'diamond') return Math.round(c.width / 2) - BOUND_TEXT_PADDING * 2;
  return c.width - BOUND_TEXT_PADDING * 2;
};

const boundMaxHeight = (c) => {
  if (c.type === 'ellipse') return Math.round((c.height / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2;
  if (c.type === 'diamond') return Math.round(c.height / 2) - BOUND_TEXT_PADDING * 2;
  return c.height - BOUND_TEXT_PADDING * 2;
};

// Grow the container when its text no longer fits, mirroring Excalidraw.
const containerHeightFor = (c, textHeight) => {
  if (c.type === 'ellipse') return Math.round(((textHeight + BOUND_TEXT_PADDING * 2) / Math.SQRT2) * 2);
  if (c.type === 'diamond') return Math.round((textHeight + BOUND_TEXT_PADDING * 2) * 2);
  return textHeight + BOUND_TEXT_PADDING * 2;
};

const layoutText = (t) => {
  const lh = t.fontSize * LINE_HEIGHT;
  if (t.containerId) {
    const c = byId(t.containerId);
    if (!c) return;
    const maxW = Math.max(1, boundMaxWidth(c));
    t.lines = wrapText(t.text, t.fontSize, maxW);
    t.width = Math.max(...t.lines.map((l) => measureWidth(l, t.fontSize)), 0);
    t.height = t.lines.length * lh;
    if (t.height > boundMaxHeight(c)) {
      const cy = c.y + c.height / 2;
      c.height = containerHeightFor(c, t.height);
      c.y = cy - c.height / 2;
    }
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;
    t.width = Math.max(t.width, 1);
    t.x = cx - t.width / 2;
    t.y = cy - t.height / 2;
    t.angle = c.angle;
  } else {
    t.lines = t.text.split('\n');
    t.width = Math.max(...t.lines.map((l) => measureWidth(l, t.fontSize)), 1);
    t.height = t.lines.length * lh;
  }
};

const syncBoundTexts = () => {
  for (const el of S.elements) if (el.type === 'text') layoutText(el);
};

const deleteIds = (ids) => {
  const all = new Set(ids);
  for (const id of ids) {
    const el = byId(id);
    if (el?.boundTextId) all.add(el.boundTextId);
  }
  for (const el of S.elements) {
    if (el.containerId && all.has(el.id)) {
      const c = byId(el.containerId);
      if (c && !all.has(c.id)) delete c.boundTextId;
    }
  }
  S.elements = S.elements.filter((e) => !all.has(e.id));
  for (const id of all) S.selected.delete(id);
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const flushPendingDots = () => {
  S.pendingDots.forEach((d) => clearTimeout(d.timer));
  S.pendingDots = [];
};

const commit = () => {
  flushPendingDots();
  syncBoundTexts();
  const snap = clone(S.elements);
  const last = history.stack[history.index];
  if (JSON.stringify(last) === JSON.stringify(snap)) return;
  history.stack.length = history.index + 1;
  history.stack.push(snap);
  if (history.stack.length > 300) history.stack.shift();
  history.index = history.stack.length - 1;
};

const restore = (i) => {
  history.index = i;
  S.elements = clone(history.stack[i]);
  S.selected = new Set([...S.selected].filter((id) => byId(id)));
  dirty();
};

const undo = () => {
  if (S.multi) finishMulti();
  if (history.index > 0) restore(history.index - 1);
};
const redo = () => {
  if (history.index < history.stack.length - 1) restore(history.index + 1);
};

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

const hitElement = (el, p, { tol = HIT_TOLERANCE, strokeOnly = false } = {}) => {
  if (el.type === 'text') {
    const [lx, ly] = G.toLocal(el, p);
    return lx >= -tol && ly >= -tol && lx <= el.width + tol && ly <= el.height + tol;
  }
  if (G.isBoxShape(el)) {
    if (G.distToOutline(el, p) <= tol + el.strokeWidth / 2) return true;
    if (strokeOnly) return false;
    if (el.backgroundColor && G.insideShape(el, p)) return true;
    if (el.boundTextId) {
      const t = byId(el.boundTextId);
      if (t && hitElement(t, p, { tol: 0 })) return true;
    }
    // Excalidraw lets you grab a transparent shape from inside once it is selected.
    if (S.selected.has(el.id) && G.insideShape(el, p)) return true;
    return false;
  }
  if (G.isLinear(el)) return G.distToPolyline(p, G.linearPath(el)) <= tol + el.strokeWidth / 2;
  if (el.type === 'freedraw') return G.distToPolyline(p, el.points) <= tol + G.freedrawSize(el) / 2;
  return false;
};

const topHit = (p, opts) => {
  for (let i = S.elements.length - 1; i >= 0; i--) {
    const el = S.elements[i];
    if (el.containerId) continue;
    if (hitElement(el, p, opts)) return el;
  }
  return null;
};

// Shape whose center the point is close to: double-click there to label the shape.
const containerNear = (p) => {
  for (let i = S.elements.length - 1; i >= 0; i--) {
    const el = S.elements[i];
    if (!G.isBoxShape(el) || !G.insideShape(el, p)) continue;
    const [lx, ly] = G.toLocal(el, p);
    const u = (lx - el.width / 2) / (el.width / 2 || 1);
    const v = (ly - el.height / 2) / (el.height / 2 || 1);
    const near = Math.hypot(u, v) <= 0.6 || G.dist([lx, ly], [el.width / 2, el.height / 2]) <= 40;
    if (near) return el;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Selection frame + handles
// ---------------------------------------------------------------------------

const currentFrame = () => {
  const els = selectedEls();
  if (!els.length) return null;
  if (els.length === 1 && (G.isBoxShape(els[0]) || els[0].type === 'text')) {
    const el = els[0];
    return { x: el.x, y: el.y, w: el.width, h: el.height, angle: el.angle || 0, single: el };
  }
  if (S.action?.type === 'rotate' && S.action.frame) {
    return { ...S.action.frame, angle: S.action.frame.angle + S.action.delta };
  }
  const [x0, y0, x1, y1] = G.unionAABB(els);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, angle: 0, single: els.length === 1 ? els[0] : null };
};

const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const DIR_CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];

const getHandles = () => {
  if (S.editing || S.multi || !S.selected.size) return [];
  const frame = currentFrame();
  if (!frame) return [];
  const handles = [];
  const el = frame.single;
  if (el && G.isLinear(el)) {
    el.points.forEach((pt, i) => handles.push({ kind: 'point', index: i, pos: pt }));
    for (let i = 0; i < el.points.length - 1; i++) {
      const a = el.points[i];
      const b = el.points[i + 1];
      if (G.dist(a, b) > 30) {
        const mid = el.points.length > 2 ? midOnCurve(el, i) : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        handles.push({ kind: 'mid', index: i, pos: mid });
      }
    }
    if (el.points.length <= 2) return handles;
  }
  const { x, y, w, h, angle } = frame;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const L = x - SELECTION_PADDING;
  const T = y - SELECTION_PADDING;
  const R = x + w + SELECTION_PADDING;
  const B = y + h + SELECTION_PADDING;
  // Excalidraw (desktop): four corner handles sitting just outside the box, no side
  // handles (drag the box edge instead), rotation handle 16px above the top edge.
  const o = HANDLE_SIZE / 2;
  const pos = { nw: [L - o, T - o], ne: [R + o, T - o], se: [R + o, B + o], sw: [L - o, B + o] };
  for (const dir of ['nw', 'ne', 'se', 'sw']) {
    handles.push({ kind: 'resize', dir, pos: G.rotate(pos[dir][0], pos[dir][1], cx, cy, angle) });
  }
  handles.push({ kind: 'rotate', pos: G.rotate(cx, T - ROTATION_OFFSET, cx, cy, angle) });
  return handles;
};

const midOnCurve = (el, i) => {
  const steps = 16;
  const path = G.sampleCurve(el.points, steps);
  return path[i * steps + steps / 2] || el.points[i];
};

const hitHandle = (p) => {
  const handles = getHandles();
  // Points first so line endpoints win over box corners.
  const order = ['point', 'mid', 'rotate', 'resize'];
  for (const kind of order) {
    for (const h of handles) {
      if (h.kind !== kind) continue;
      const r = kind === 'point' || kind === 'mid' ? POINT_RADIUS + 4 : HANDLE_SIZE;
      if (G.dist(p, h.pos) <= r) return h;
    }
  }
  // Dragging an edge of the selection box resizes that side.
  if (!handles.some((h) => h.kind === 'resize')) return null;
  const f = currentFrame();
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const [lx, ly] = G.rotate(p[0], p[1], cx, cy, -f.angle);
  const L = f.x - SELECTION_PADDING;
  const T = f.y - SELECTION_PADDING;
  const R = f.x + f.w + SELECTION_PADDING;
  const B = f.y + f.h + SELECTION_PADDING;
  const near = 5;
  const inX = lx > L && lx < R;
  const inY = ly > T && ly < B;
  if (inX && Math.abs(ly - T) <= near) return { kind: 'resize', dir: 'n' };
  if (inX && Math.abs(ly - B) <= near) return { kind: 'resize', dir: 's' };
  if (inY && Math.abs(lx - L) <= near) return { kind: 'resize', dir: 'w' };
  if (inY && Math.abs(lx - R) <= near) return { kind: 'resize', dir: 'e' };
  return null;
};

const insideFrame = (p) => {
  const f = currentFrame();
  if (!f) return false;
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const [lx, ly] = G.rotate(p[0], p[1], cx, cy, -f.angle);
  return lx >= f.x - SELECTION_PADDING && lx <= f.x + f.w + SELECTION_PADDING && ly >= f.y - SELECTION_PADDING && ly <= f.y + f.h + SELECTION_PADDING;
};

const strokeRotatedRect = (x, y, w, h, angle, dashed) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.setLineDash(dashed || []);
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.restore();
};

function drawSelection() {
  if (S.editing || S.multi || !S.selected.size) return;
  const busy = S.action && ['create-box', 'create-linear', 'freedraw', 'marquee'].includes(S.action.type);
  if (busy) return;
  const els = selectedEls();
  const frame = currentFrame();
  if (!frame) return;
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 1;
  const pad = SELECTION_PADDING;
  const group = selectionIsSingleGroup();
  const singleLinear = frame.single && G.isLinear(frame.single) && frame.single.points.length <= 2;

  if (els.length > 1 && !group) {
    for (const el of els) {
      if (G.isBoxShape(el) || el.type === 'text') strokeRotatedRect(el.x - pad, el.y - pad, el.width + pad * 2, el.height + pad * 2, el.angle || 0, false);
      else {
        const [x0, y0, x1, y1] = G.getAABB(el);
        strokeRotatedRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2, 0, false);
      }
    }
  }
  if (group) {
    const [x0, y0, x1, y1] = G.unionAABB(els);
    strokeRotatedRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2, 0, [8, 4]);
  }
  if (!singleLinear) {
    strokeRotatedRect(frame.x - pad, frame.y - pad, frame.w + pad * 2, frame.h + pad * 2, frame.angle, els.length > 1 ? [2, 2] : null);
  }

  for (const h of getHandles()) {
    ctx.beginPath();
    ctx.setLineDash([]);
    if (h.kind === 'point') {
      ctx.arc(h.pos[0], h.pos[1], POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = '#5e5ad8';
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = SELECTION_COLOR;
    } else if (h.kind === 'mid') {
      ctx.arc(h.pos[0], h.pos[1], POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(177, 151, 252, 0.7)';
      ctx.fill();
    } else if (h.kind === 'rotate') {
      ctx.arc(h.pos[0], h.pos[1], HANDLE_SIZE / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.save();
      ctx.translate(h.pos[0], h.pos[1]);
      ctx.rotate(frame.angle);
      ctx.beginPath();
      ctx.roundRect(-HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE, 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawMarquee() {
  const a = S.action;
  if (a?.type !== 'marquee') return;
  const [x0, y0] = a.start;
  const [x1, y1] = a.end;
  ctx.save();
  ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 1;
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// The pen cursor is a dot as wide as the line it will draw.
const penCursor = () => {
  const c = S.stroke;
  const ring = c.toLowerCase() === '#ffffff' ? '#1e1e1e' : '#ffffff';
  const r = Math.max(3, strokeWidthFor('freedraw') * 1.4);
  const size = Math.ceil(r * 2 + 4);
  const mid = size / 2;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${mid}' cy='${mid}' r='${r}' fill='${c}' stroke='${ring}' stroke-width='1.5'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(mid)} ${Math.round(mid)}, crosshair`;
};

const eraserCursor = () => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><circle cx='10' cy='10' r='7' fill='rgba(255,255,255,0.4)' stroke='#1e1e1e' stroke-width='1.5'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, crosshair`;
};

const baseCursor = () => {
  switch (S.tool) {
    case 'select': return 'default';
    case 'freedraw': return penCursor();
    case 'eraser': return eraserCursor();
    case 'text': return 'text';
    default: return 'crosshair';
  }
};

const setCursor = (c) => {
  if (canvas.style.cursor !== c) canvas.style.cursor = c;
};

const updateHoverCursor = (p) => {
  if (S.tool !== 'select') return setCursor(baseCursor());
  const h = hitHandle(p);
  if (h) {
    if (h.kind === 'rotate') return setCursor('grab');
    if (h.kind === 'point' || h.kind === 'mid') return setCursor('pointer');
    const angle = currentFrame()?.angle || 0;
    const idx = (DIRS.indexOf(h.dir) + Math.round(G.normalizeAngle(angle) / (Math.PI / 4))) % 8;
    return setCursor(DIR_CURSORS[idx % 4]);
  }
  if (topHit(p) || (S.selected.size > 1 && insideFrame(p))) return setCursor('move');
  setCursor('default');
};

const setTool = (tool) => {
  if (S.multi) finishMulti();
  if (S.editing) commitText();
  S.tool = tool;
  if (tool !== 'select') S.selected.clear();
  setCursor(baseCursor());
  dirty();
};

// ---------------------------------------------------------------------------
// Pointer handling
// ---------------------------------------------------------------------------

const pt = (e) => [e.clientX, e.clientY];

function onPointerDown(e) {
  if (e.button !== 0) return;
  const p = pt(e);
  S.pointer = p;
  if (S.editing) {
    commitText();
    S.action = { type: 'noop' };
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (S.multi) return multiDown(p, e);
  switch (S.tool) {
    case 'select': return selectDown(p, e);
    case 'rectangle':
    case 'diamond':
    case 'ellipse': return startBox(p);
    case 'line':
    case 'arrow': return startLinear(p);
    case 'freedraw': return startFreedraw(p, e);
    case 'text':
      S.action = { type: 'noop' };
      return openTextAt(p, { fromTextTool: true });
    case 'eraser': return startErase(p);
  }
}

function onPointerMove(e) {
  const p = pt(e);
  S.pointer = p;
  const a = S.action;
  if (!a) {
    if (S.multi) {
      const el = byId(S.multi);
      if (el) {
        const prev = el.points[el.points.length - 2];
        el.points[el.points.length - 1] = e.shiftKey ? G.snapAngle(prev, p) : p;
        dirty();
      }
    }
    updateHoverCursor(p);
    return;
  }
  switch (a.type) {
    case 'create-box': updateBox(a, p, e); break;
    case 'create-linear': updateLinear(a, p, e); break;
    case 'freedraw': {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const q = pt(ev);
        const last = a.el.points[a.el.points.length - 1];
        if (G.dist(q, last) >= 1) {
          a.el.points.push(q);
          if (a.el.pressures) a.el.pressures.push(ev.pressure);
        }
      }
      break;
    }
    case 'erase': eraseAlong(a.last, p); a.last = p; break;
    case 'move': updateMove(a, p, e); break;
    case 'resize': updateResize(a, p, e); break;
    case 'rotate': updateRotate(a, p, e); break;
    case 'point': updatePoint(a, p, e); break;
    case 'marquee': updateMarquee(a, p, e); break;
  }
  dirty();
}

function onPointerUp(e) {
  const a = S.action;
  S.action = null;
  if (!a) return;
  switch (a.type) {
    case 'create-box': {
      const el = a.el;
      if (el.width < 3 && el.height < 3) {
        deleteIds([el.id]);
        break;
      }
      commit();
      S.selected = new Set([el.id]);
      S.tool = 'select';
      setCursor(baseCursor());
      break;
    }
    case 'create-linear': {
      if (a.moved) finishLinear(a.el);
      else {
        // A click (no drag) starts a multi-point line: keep clicking to add points.
        a.el.points = [a.origin.slice(), a.origin.slice()];
        S.multi = a.el.id;
      }
      break;
    }
    case 'freedraw': {
      a.el.finished = true;
      const [x0, y0, x1, y1] = G.boundsOfPoints(a.el.points);
      if (x1 - x0 < 3 && y1 - y0 < 3) {
        // Hold off committing a dot: it may be the first half of a double-click.
        const id = a.el.id;
        const timer = setTimeout(() => {
          S.pendingDots = S.pendingDots.filter((d) => d.id !== id);
          commit();
        }, 400);
        S.pendingDots.push({ id, timer });
      } else commit();
      break;
    }
    case 'erase': {
      if (S.erasing.size) {
        deleteIds([...S.erasing]);
        S.erasing.clear();
        commit();
      }
      break;
    }
    case 'move':
    case 'resize':
    case 'rotate':
    case 'point':
      commit();
      break;
  }
  updateHoverCursor(pt(e));
  dirty();
}

function onDoubleClick(e) {
  const p = pt(e);
  // Throw away the dots the two clicks left behind in pen mode.
  if (S.pendingDots.length) {
    const ids = S.pendingDots.map((d) => d.id);
    S.pendingDots.forEach((d) => clearTimeout(d.timer));
    S.pendingDots = [];
    deleteIds(ids);
  }
  if (S.multi) {
    const el = byId(S.multi);
    const unique = dedupe(el.points.slice(0, -1));
    if (unique.length >= 2) {
      finishMulti();
      return;
    }
    deleteIds([el.id]);
    S.multi = null;
  }
  S.action = null;
  // Cmd+double-click skips binding to a shape, like Excalidraw.
  openTextAt(p, { noBind: e.metaKey });
  dirty();
}

// --- select tool -------------------------------------------------------------

function selectDown(p, e) {
  const h = hitHandle(p);
  if (h) {
    const els = selectedEls();
    if (h.kind === 'point') return startPointDrag(els[0], h.index, p);
    if (h.kind === 'mid') {
      const el = els[0];
      el.points.splice(h.index + 1, 0, h.pos.slice());
      return startPointDrag(el, h.index + 1, p);
    }
    const frame = currentFrame();
    const orig = new Map(els.map((el) => [el.id, clone(el)]));
    if (h.kind === 'rotate') {
      const cx = frame.x + frame.w / 2;
      const cy = frame.y + frame.h / 2;
      S.action = { type: 'rotate', frame: { ...frame, single: null }, center: [cx, cy], start: Math.atan2(p[1] - cy, p[0] - cx), orig, delta: 0 };
      return;
    }
    S.action = { type: 'resize', dir: h.dir, frame: { ...frame, single: null }, start: p, orig, single: frame.single };
    return;
  }

  const hit = topHit(p);
  if (hit) {
    const ids = withGroup(hit);
    if (e.shiftKey) {
      if (S.selected.has(hit.id)) {
        ids.forEach((id) => S.selected.delete(id));
        S.action = { type: 'noop' };
        dirty();
        return;
      }
      ids.forEach((id) => S.selected.add(id));
    } else if (!S.selected.has(hit.id)) {
      S.selected = new Set(ids);
    }
    if (e.altKey) duplicateSelection(0, false);
    return startMove(p);
  }
  if (S.selected.size > 1 && insideFrame(p)) {
    if (e.altKey) duplicateSelection(0, false);
    return startMove(p);
  }
  if (!e.shiftKey) S.selected.clear();
  S.action = { type: 'marquee', start: p, end: p, base: new Set(S.selected) };
  dirty();
}

function startMove(p) {
  const els = selectedEls();
  S.action = { type: 'move', start: p, orig: new Map(els.map((el) => [el.id, clone(el)])) };
  dirty();
}

function updateMove(a, p, e) {
  let dx = p[0] - a.start[0];
  let dy = p[1] - a.start[1];
  if (e.shiftKey) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  for (const [id, o] of a.orig) {
    const el = byId(id);
    if (!el) continue;
    translate(el, o, dx, dy);
  }
}

const translate = (el, o, dx, dy) => {
  if (G.hasPoints(el)) el.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  else {
    el.x = o.x + dx;
    el.y = o.y + dy;
  }
};

function updateMarquee(a, p) {
  a.end = p;
  const [x0, x1] = [Math.min(a.start[0], p[0]), Math.max(a.start[0], p[0])];
  const [y0, y1] = [Math.min(a.start[1], p[1]), Math.max(a.start[1], p[1])];
  const sel = new Set(a.base);
  for (const el of S.elements) {
    if (el.containerId) continue;
    const [ex0, ey0, ex1, ey1] = G.getAABB(el);
    if (ex0 >= x0 && ey0 >= y0 && ex1 <= x1 && ey1 <= y1) withGroup(el).forEach((id) => sel.add(id));
  }
  S.selected = sel;
}

// --- resize ------------------------------------------------------------------

// Works in the frame's own (unrotated) coordinates. Returns the new box, with
// signed width/height so flips can be applied to point-based elements.
const resizeFrame = (f, dir, local, shift, alt) => {
  const dx = local[0];
  const dy = local[1];
  const hasE = dir.includes('e');
  const hasW = dir.includes('w');
  const hasN = dir.includes('n');
  const hasS = dir.includes('s');
  let w = f.w;
  let h = f.h;
  if (hasE) w = f.w + dx * (alt ? 2 : 1);
  if (hasW) w = f.w - dx * (alt ? 2 : 1);
  if (hasS) h = f.h + dy * (alt ? 2 : 1);
  if (hasN) h = f.h - dy * (alt ? 2 : 1);
  if (shift && f.w > 0 && f.h > 0) {
    const ratio = f.w / f.h;
    const corner = (hasE || hasW) && (hasN || hasS);
    if (corner) {
      if (Math.abs(w) / f.w > Math.abs(h) / f.h) h = (Math.sign(h) || 1) * (Math.abs(w) / ratio);
      else w = (Math.sign(w) || 1) * Math.abs(h) * ratio;
    } else if (hasN || hasS) w = Math.abs(h) * ratio;
    else h = Math.abs(w) / ratio;
  }
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  let x0;
  let y0;
  if (alt || (!hasE && !hasW)) x0 = cx - w / 2;
  else if (hasE) x0 = f.x;
  else x0 = f.x + f.w - w;
  if (alt || (!hasN && !hasS)) y0 = cy - h / 2;
  else if (hasS) y0 = f.y;
  else y0 = f.y + f.h - h;
  return { x0, y0, w, h };
};

function updateResize(a, p, e) {
  const f = a.frame;
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const [sx, sy] = G.rotate(a.start[0], a.start[1], cx, cy, -f.angle);
  const [px, py] = G.rotate(p[0], p[1], cx, cy, -f.angle);
  const single = a.single;
  const hasText = [...a.orig.values()].some((o) => o.type === 'text');
  const keepRatio = e.shiftKey || single?.type === 'text' || (!single && hasText);
  const r = resizeFrame(f, a.dir, [px - sx, py - sy], keepRatio, e.altKey);

  if (single && (G.isBoxShape(single) || single.type === 'text')) {
    const el = byId(single.id);
    const o = a.orig.get(single.id);
    const w = Math.abs(r.w);
    const h = Math.abs(r.h);
    const [wcx, wcy] = G.rotate(r.x0 + r.w / 2, r.y0 + r.h / 2, cx, cy, f.angle);
    if (el.type === 'text') {
      const scale = Math.max(w / (o.width || 1), 0.05);
      el.fontSize = Math.max(4, o.fontSize * scale);
      layoutText(el);
      el.x = wcx - el.width / 2;
      el.y = wcy - el.height / 2;
    } else {
      el.width = Math.max(w, 1);
      el.height = Math.max(h, 1);
      el.x = wcx - el.width / 2;
      el.y = wcy - el.height / 2;
    }
    return;
  }

  // Group / point-based resize: map every point through the frame scale.
  const scaleX = f.w ? r.w / f.w : 1;
  const scaleY = f.h ? r.h / f.h : 1;
  const map = ([x, y]) => [r.x0 + (x - f.x) * scaleX, r.y0 + (y - f.y) * scaleY];
  for (const [id, o] of a.orig) {
    const el = byId(id);
    if (!el) continue;
    if (G.hasPoints(el)) el.points = o.points.map(map);
    else {
      const [ncx, ncy] = map([o.x + o.width / 2, o.y + o.height / 2]);
      if (el.type === 'text') {
        el.fontSize = Math.max(4, o.fontSize * Math.abs(scaleX));
        layoutText(el);
      } else {
        el.width = Math.max(1, o.width * Math.abs(scaleX));
        el.height = Math.max(1, o.height * Math.abs(scaleY));
      }
      el.x = ncx - el.width / 2;
      el.y = ncy - el.height / 2;
    }
  }
}

// --- rotate ------------------------------------------------------------------

function updateRotate(a, p, e) {
  const [cx, cy] = a.center;
  let delta = Math.atan2(p[1] - cy, p[0] - cx) - a.start;
  const step = Math.PI / 12;
  const els = [...a.orig.values()];
  if (els.length === 1 && (G.isBoxShape(els[0]) || els[0].type === 'text')) {
    const o = els[0];
    let angle = (o.angle || 0) + delta;
    if (e.shiftKey) angle = Math.round(angle / step) * step;
    byId(o.id).angle = G.normalizeAngle(angle);
    return;
  }
  if (e.shiftKey) delta = Math.round(delta / step) * step;
  a.delta = delta;
  for (const o of els) {
    const el = byId(o.id);
    if (!el) continue;
    if (G.hasPoints(el)) el.points = o.points.map(([x, y]) => G.rotate(x, y, cx, cy, delta));
    else {
      const [ncx, ncy] = G.rotate(o.x + o.width / 2, o.y + o.height / 2, cx, cy, delta);
      el.x = ncx - o.width / 2;
      el.y = ncy - o.height / 2;
      el.angle = G.normalizeAngle((o.angle || 0) + delta);
    }
  }
}

// --- line points -----------------------------------------------------------

function startPointDrag(el, index, p) {
  S.action = { type: 'point', id: el.id, index, start: p, orig: clone(el.points) };
  dirty();
}

function updatePoint(a, p, e) {
  const el = byId(a.id);
  if (!el) return;
  const o = a.orig[a.index] || el.points[a.index];
  let np = [o[0] + p[0] - a.start[0], o[1] + p[1] - a.start[1]];
  if (e.shiftKey) {
    const neighbor = a.index > 0 ? el.points[a.index - 1] : el.points[a.index + 1];
    if (neighbor) np = G.snapAngle(neighbor, np);
  }
  el.points[a.index] = np;
}

// --- creation ----------------------------------------------------------------

function startBox(p) {
  const el = newElement(S.tool, { x: p[0], y: p[1] });
  S.elements.push(el);
  S.selected.clear();
  S.action = { type: 'create-box', el, origin: p };
}

function updateBox(a, p, e) {
  let dx = p[0] - a.origin[0];
  let dy = p[1] - a.origin[1];
  if (e.shiftKey) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (Math.sign(dx) || 1) * m;
    dy = (Math.sign(dy) || 1) * m;
  }
  let [x0, y0] = a.origin;
  if (e.altKey) {
    x0 -= dx;
    y0 -= dy;
    dx *= 2;
    dy *= 2;
  }
  a.el.x = Math.min(x0, x0 + dx);
  a.el.y = Math.min(y0, y0 + dy);
  a.el.width = Math.abs(dx);
  a.el.height = Math.abs(dy);
}

function startLinear(p) {
  const el = newElement(S.tool, { points: [p.slice(), p.slice()] });
  S.elements.push(el);
  S.selected.clear();
  S.action = { type: 'create-linear', el, origin: p, moved: false };
}

function updateLinear(a, p, e) {
  if (G.dist(p, a.origin) > 4) a.moved = true;
  a.el.points[1] = e.shiftKey ? G.snapAngle(a.origin, p) : p;
}

const dedupe = (pts) => pts.filter((q, i) => i === 0 || G.dist(q, pts[i - 1]) > 2);

function finishLinear(el) {
  el.points = dedupe(el.points);
  if (el.points.length < 2) {
    deleteIds([el.id]);
    return;
  }
  commit();
  S.selected = new Set([el.id]);
  S.tool = 'select';
  setCursor(baseCursor());
}

function multiDown(p, e) {
  const el = byId(S.multi);
  if (!el) {
    S.multi = null;
    return;
  }
  const committed = el.points.slice(0, -1);
  const last = committed[committed.length - 1];
  if (committed.length >= 2 && G.dist(p, last) < 8) {
    finishMulti();
    return;
  }
  const q = e.shiftKey ? G.snapAngle(last, p) : p;
  el.points[el.points.length - 1] = q;
  el.points.push(q.slice());
  dirty();
}

function finishMulti() {
  const el = byId(S.multi);
  S.multi = null;
  if (!el) return;
  el.points = el.points.slice(0, -1);
  finishLinear(el);
  dirty();
}

function startFreedraw(p, e) {
  // Stylus input gets pressure-sensitive strokes, mouse/trackpad constant width.
  const variable = e.pointerType === 'pen' && e.pressure !== 0.5;
  const el = newElement('freedraw', { points: [p], variable, pressures: variable ? [e.pressure] : undefined });
  S.elements.push(el);
  S.selected.clear();
  S.action = { type: 'freedraw', el };
}

// --- eraser ------------------------------------------------------------------

function startErase(p) {
  S.action = { type: 'erase', last: p };
  eraseAlong(p, p);
  dirty();
}

function eraseAlong(a, b) {
  const steps = Math.max(1, Math.ceil(G.dist(a, b) / 4));
  for (let i = 0; i <= steps; i++) {
    const q = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
    for (const el of S.elements) {
      if (el.containerId || S.erasing.has(el.id)) continue;
      // Excalidraw's eraser padding: generous for pen strokes, tight for shapes.
      const tol = el.type === 'freedraw' ? 15 - G.freedrawSize(el) / 2 : el.strokeWidth / 2 + 3;
      if (hitElement(el, q, { tol, strokeOnly: !el.backgroundColor })) withGroup(el).forEach((id) => S.erasing.add(id));
    }
  }
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

// Which shape a new text box should attach to. Excalidraw binds when the one
// selected shape is double-clicked, or when the click lands on a shape that is
// filled, already labelled, or on its outline. On top of that we snap to any
// shape whose center the click is near.
const containerFor = (p) => {
  const sel = selectedEls();
  if (sel.length === 1 && G.isBoxShape(sel[0]) && G.insideShape(sel[0], p)) return sel[0];
  for (let i = S.elements.length - 1; i >= 0; i--) {
    const el = S.elements[i];
    if (!G.isBoxShape(el)) continue;
    const onStroke = G.distToOutline(el, p) <= HIT_TOLERANCE;
    const inside = G.insideShape(el, p);
    if (onStroke || (inside && (el.backgroundColor || el.boundTextId))) return el;
  }
  return containerNear(p);
};

function openTextAt(p, { fromTextTool = false, noBind = false } = {}) {
  const container = noBind ? null : containerFor(p);
  if (container) {
    if (container.boundTextId && byId(container.boundTextId)) return editText(byId(container.boundTextId), { fromTextTool });
    // Make sure there is room for at least one line, like Excalidraw.
    const minH = fontSizeNow() * LINE_HEIGHT + BOUND_TEXT_PADDING * 2;
    if (container.height < minH) {
      container.y -= (minH - container.height) / 2;
      container.height = minH;
    }
    const t = newElement('text', { text: '', fontSize: fontSizeNow(), containerId: container.id, strokeColor: S.stroke });
    container.boundTextId = t.id;
    S.elements.push(t);
    return editText(t, { isNew: true, fromTextTool });
  }
  const existing = topHit(p);
  if (existing?.type === 'text') return editText(existing, { fromTextTool });
  if (existing?.boundTextId && byId(existing.boundTextId)) {
    const t = byId(existing.boundTextId);
    if (hitElement(t, p, { tol: 0 })) return editText(t, { fromTextTool });
  }
  const lh = fontSizeNow() * LINE_HEIGHT;
  const t = newElement('text', { text: '', fontSize: fontSizeNow(), x: p[0], y: p[1] - lh / 2, strokeColor: S.stroke });
  S.elements.push(t);
  editText(t, { isNew: true, fromTextTool });
}

function editText(el, { isNew = false, fromTextTool = false } = {}) {
  S.selected.clear();
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = el.text;
  ta.spellcheck = false;
  ta.setAttribute('autocomplete', 'off');
  S.editing = { id: el.id, ta, isNew, fromTextTool };
  bridge({ type: 'editing', value: true });
  ta.addEventListener('input', () => {
    el.text = ta.value;
    layoutEditor();
    dirty();
  });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(ta);
  layoutEditor();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  setCursor(baseCursor());
  dirty();
}

function layoutEditor() {
  const ed = S.editing;
  if (!ed) return;
  const el = byId(ed.id);
  if (!el) return;
  layoutText(el);
  const ta = ed.ta;
  const lh = el.fontSize * LINE_HEIGHT;
  ta.style.font = font(el.fontSize);
  ta.style.lineHeight = `${lh}px`;
  ta.style.color = el.strokeColor;
  if (el.containerId) {
    const c = byId(el.containerId);
    const maxW = Math.max(1, boundMaxWidth(c));
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;
    ta.style.whiteSpace = 'pre-wrap';
    ta.style.textAlign = 'center';
    ta.style.width = `${maxW}px`;
    ta.style.height = `${el.height}px`;
    ta.style.left = `${cx - maxW / 2}px`;
    ta.style.top = `${cy - el.height / 2}px`;
  } else {
    ta.style.whiteSpace = 'pre';
    ta.style.textAlign = 'left';
    ta.style.width = `${el.width + el.fontSize}px`;
    ta.style.height = `${el.height}px`;
    ta.style.left = `${el.x}px`;
    ta.style.top = `${el.y}px`;
  }
  ta.style.transformOrigin = el.containerId ? 'center center' : `${el.width / 2}px ${el.height / 2}px`;
  ta.style.transform = `rotate(${el.angle || 0}rad)`;
}

function commitText() {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  bridge({ type: 'editing', value: false });
  ed.ta.remove();
  const el = byId(ed.id);
  if (el) {
    el.text = ed.ta.value;
    if (!el.text.trim()) deleteIds([el.id]);
    else layoutText(el);
  }
  commit();
  if (ed.fromTextTool) {
    S.tool = 'select';
    if (el && byId(el.id)) S.selected = new Set([el.containerId || el.id]);
  }
  setCursor(baseCursor());
  dirty();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const applyStyle = (fn) => {
  const els = selectedEls();
  for (const el of els) {
    fn(el);
    if (el.boundTextId) {
      const t = byId(el.boundTextId);
      if (t) fn(t);
    }
  }
  if (els.length) commit();
  dirty();
};

const setStrokeColor = (color) => {
  S.stroke = color;
  applyStyle((el) => {
    el.strokeColor = color;
  });
  if (S.editing) {
    const el = byId(S.editing.id);
    if (el) {
      el.strokeColor = color;
      layoutEditor();
    }
  }
  setCursor(S.tool === 'select' ? canvas.style.cursor : baseCursor());
};

const setFill = (color) => {
  S.fill = color;
  applyStyle((el) => {
    if (G.isBoxShape(el)) el.backgroundColor = color;
  });
};

const toggleDotted = () => {
  const styled = selectedEls().find((el) => G.isBoxShape(el) || G.isLinear(el));
  const current = styled ? styled.strokeStyle : S.strokeStyle;
  const next = current === 'solid' ? 'dotted' : 'solid';
  S.strokeStyle = next;
  applyStyle((el) => {
    if (G.isBoxShape(el) || G.isLinear(el)) el.strokeStyle = next;
  });
};

const nudge = (dx, dy) => {
  const els = selectedEls();
  if (!els.length) return;
  for (const el of els) translate(el, clone(el), dx, dy);
  commit();
  dirty();
};

// Copy elements (plus their bound text) with fresh ids, keeping groups and bindings intact.
const cloneSet = (els, dx, dy) => {
  const idMap = new Map();
  const groupMap = new Map();
  const all = [];
  for (const el of els) {
    all.push(el);
    if (el.boundTextId) {
      const t = byId(el.boundTextId) || S.clipboard?.find((c) => c.id === el.boundTextId);
      if (t) all.push(t);
    }
  }
  all.forEach((el) => idMap.set(el.id, uid()));
  return all.map((el) => {
    const c = clone(el);
    c.id = idMap.get(el.id);
    c.seed = randomSeed();
    c.groupIds = (el.groupIds || []).map((g) => {
      if (!groupMap.has(g)) groupMap.set(g, uid());
      return groupMap.get(g);
    });
    if (el.boundTextId) c.boundTextId = idMap.get(el.boundTextId);
    if (el.containerId) c.containerId = idMap.get(el.containerId);
    translate(c, el, dx, dy);
    return c;
  });
};

function duplicateSelection(offset = DUPLICATE_OFFSET, doCommit = true) {
  const els = selectedEls();
  if (!els.length) return;
  const copies = cloneSet(els, offset, offset);
  S.elements.push(...copies);
  S.selected = new Set(copies.filter((c) => !c.containerId).map((c) => c.id));
  if (doCommit) commit();
  dirty();
}

const copySelection = () => {
  const els = selectedEls();
  if (!els.length) return false;
  const withText = [...els];
  for (const el of els) if (el.boundTextId && byId(el.boundTextId)) withText.push(byId(el.boundTextId));
  S.clipboard = clone(withText);
  return true;
};

const paste = () => {
  if (!S.clipboard?.length) return;
  const tops = S.clipboard.filter((el) => !el.containerId);
  const [x0, y0, x1, y1] = G.unionAABB(tops);
  const dx = S.pointer[0] - (x0 + x1) / 2;
  const dy = S.pointer[1] - (y0 + y1) / 2;
  const copies = cloneSet(tops, dx, dy);
  S.elements.push(...copies);
  S.selected = new Set(copies.filter((c) => !c.containerId).map((c) => c.id));
  S.tool = 'select';
  commit();
  dirty();
};

const toggleGroup = () => {
  const g = selectionIsSingleGroup();
  const els = selectedEls();
  if (g) {
    for (const el of els) el.groupIds = el.groupIds.filter((id) => id !== g);
  } else if (els.length > 1) {
    const id = uid();
    for (const el of els) el.groupIds = [...(el.groupIds || []), id];
  } else return;
  commit();
  dirty();
};

const moveLayer = (dir, toEnd) => {
  if (!S.selected.size) return;
  const sel = (el) => S.selected.has(el.id);
  if (toEnd) {
    const picked = S.elements.filter(sel);
    const rest = S.elements.filter((e) => !sel(e));
    S.elements = dir > 0 ? [...rest, ...picked] : [...picked, ...rest];
  } else {
    // Skip bound text when stepping: it always renders with its container.
    const arr = S.elements;
    const visible = (i) => !arr[i].containerId;
    if (dir > 0) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (!sel(arr[i])) continue;
        let j = i + 1;
        while (j < arr.length && !visible(j)) j++;
        if (j < arr.length && !sel(arr[j])) {
          const [el] = arr.splice(i, 1);
          arr.splice(j, 0, el);
        }
      }
    } else {
      for (let i = 0; i < arr.length; i++) {
        if (!sel(arr[i])) continue;
        let j = i - 1;
        while (j >= 0 && !visible(j)) j--;
        if (j >= 0 && !sel(arr[j])) {
          const [el] = arr.splice(i, 1);
          arr.splice(j, 0, el);
        }
      }
    }
  }
  commit();
  dirty();
};

const changeFontSize = (factor) => {
  const texts = [];
  for (const el of selectedEls()) {
    if (el.type === 'text') texts.push(el);
    if (el.boundTextId && byId(el.boundTextId)) texts.push(byId(el.boundTextId));
  }
  for (const t of texts) {
    const cx = t.x + t.width / 2;
    t.fontSize = Math.max(8, Math.round(t.fontSize * factor));
    layoutText(t);
    if (!t.containerId) t.x = cx - t.width / 2;
  }
  if (texts.length) commit();
  dirty();
};

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const bridge = (msg) => {
  window.webkit?.messageHandlers?.bridge?.postMessage(msg);
  return !!window.webkit?.messageHandlers?.bridge;
};

const exit = () => {
  if (!bridge({ type: 'exit' })) close();
};

const escTap = () => {
  const now = performance.now();
  if (now - S.lastEsc < DOUBLE_ESC_MS) {
    S.lastEsc = 0;
    exit();
    return;
  }
  S.lastEsc = now;
};

const FKEYS = { F1: 1, F2: 2, F3: 3, F4: 4, F5: 5 };

function onKeyDown(e) {
  if (S.editing) {
    if (e.key === 'Escape') {
      e.preventDefault();
      commitText();
      escTap();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitText();
    } else if (e.key === 'F6' || FKEYS[e.key]) e.preventDefault();
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.action) {
      S.action = null;
    } else if (S.multi) finishMulti();
    else if (S.selected.size) S.selected.clear();
    escTap();
    dirty();
    return;
  }

  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // Tab: draw over the still of the screen from when ⌥G opened, or the live screen.
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    bridge({ type: 'background' });
    return;
  }

  if (mod) {
    let handled = true;
    if (key === 'z' && e.shiftKey) redo();
    else if (key === 'z') undo();
    else if (key === 'y') redo();
    else if (key === 'a') {
      S.tool = 'select';
      S.selected = new Set(S.elements.filter((el) => !el.containerId).map((el) => el.id));
      setCursor(baseCursor());
      dirty();
    } else if (key === 'd') duplicateSelection();
    else if (key === 'c') handled = copySelection();
    else if (key === 'x') {
      if (copySelection()) {
        deleteIds([...S.selected]);
        commit();
        dirty();
      }
    } else if (key === 'v') paste();
    else if (key === 'g') toggleGroup();
    else if (e.key === 'ArrowUp' || key === ']' || key === '}') moveLayer(1, e.shiftKey || e.altKey);
    else if (e.key === 'ArrowDown' || key === '[' || key === '{') moveLayer(-1, e.shiftKey || e.altKey);
    else if (e.shiftKey && (key === '.' || key === '>')) changeFontSize(1.1);
    else if (e.shiftKey && (key === ',' || key === '<')) changeFontSize(1 / 1.1);
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }
  if (e.altKey && !e.code.startsWith('Digit')) return;

  // Fill: F1–F5 (or Shift+1–5 when the F-keys are media keys), F6 / Shift+6 clears.
  const fillIndex = FKEYS[e.key] || (e.shiftKey && /^Digit[1-5]$/.test(e.code) ? Number(e.code.slice(5)) : 0);
  if (fillIndex) {
    e.preventDefault();
    setFill(hexToRgba(PALETTE[fillIndex], FILL_ALPHA));
    return;
  }
  if (e.key === 'F6' || (e.shiftKey && e.code === 'Digit6')) {
    e.preventDefault();
    setFill(null);
    return;
  }
  if (/^Digit[1-5]$/.test(e.code)) {
    e.preventDefault();
    setStrokeColor(PALETTE[Number(e.code.slice(5))]);
    return;
  }

  if (TOOL_KEYS[key] && !e.shiftKey) {
    e.preventDefault();
    setTool(TOOL_KEYS[key]);
    return;
  }
  if (key === 'x') {
    e.preventDefault();
    toggleDotted();
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (S.selected.size) {
      deleteIds([...S.selected]);
      commit();
      dirty();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (S.multi) return finishMulti();
    const els = selectedEls();
    if (els.length === 1) {
      const el = els[0];
      if (el.type === 'text') editText(el);
      else if (G.isBoxShape(el)) {
        const c = el;
        openTextAt([c.x + c.width / 2, c.y + c.height / 2]);
      }
    }
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    if (S.selected.size) {
      const step = e.shiftKey ? NUDGE_SHIFT : NUDGE;
      nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
    } else if (!S.action && !S.multi && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      navigateBoards(e.key === 'ArrowUp' ? -1 : 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Artboard history: like a shell's command history. Saved boards never change;
// editing a recalled board saves the edited version as a new, newest entry.
// ---------------------------------------------------------------------------

const boards = {
  list: Array.isArray(window.__SD_HISTORY) ? window.__SD_HISTORY.filter((b) => Array.isArray(b?.elements)) : [],
  index: null, // position in `list` being shown, or null for a fresh board
  base: '[]', // the shown board as it was loaded, to tell whether it was edited
  shot: null, // name of the still of the screen taken when the overlay opened
};

if (!window.__SD_HISTORY) {
  try {
    boards.list = JSON.parse(localStorage.getItem('sd-history') || '[]');
  } catch {
    boards.list = [];
  }
}

const persistBoards = () => {
  const json = JSON.stringify(boards.list);
  const shots = [...new Set(boards.list.map((b) => b.shot).filter(Boolean))];
  if (!bridge({ type: 'history', json, shots })) {
    try {
      localStorage.setItem('sd-history', json);
    } catch {
      // Browser preview only; nothing to do.
    }
  }
};

// Save the current board as the newest entry if it has content and differs
// from what was loaded.
const saveBoard = () => {
  if (S.editing) commitText();
  if (S.multi) finishMulti();
  flushPendingDots();
  const elements = S.elements.filter((el) => el.type !== 'text' || el.text.trim());
  const json = JSON.stringify(elements);
  if (!elements.length || json === boards.base) return;
  // A new board keeps the still it was drawn on; an edited copy keeps the
  // original's.
  const shot = boards.index === null ? boards.shot : boards.list[boards.index].shot;
  const board = { savedAt: Date.now(), elements: JSON.parse(json) };
  if (shot) board.shot = shot;
  boards.list.push(board);
  if (boards.list.length > BOARD_LIMIT) boards.list.splice(0, boards.list.length - BOARD_LIMIT);
  boards.index = boards.list.length - 1;
  boards.base = json;
  persistBoards();
};

const showBoard = (index) => {
  const elements = index === null ? [] : clone(boards.list[index].elements);
  boards.index = index;
  boards.base = JSON.stringify(elements);
  S.elements = elements;
  S.selected.clear();
  S.action = null;
  S.erasing.clear();
  history.stack = [clone(elements)];
  history.index = 0;
  bridge({ type: 'board', shot: (index !== null && boards.list[index].shot) || null });
  render();
};

// dir -1 = older (↑), +1 = newer (↓). Past the newest is a fresh, empty board.
function navigateBoards(dir) {
  saveBoard();
  const current = boards.index === null ? boards.list.length : boards.index;
  const next = current + dir;
  if (next < 0) return;
  if (next >= boards.list.length) {
    if (boards.index !== null) showBoard(null);
    return;
  }
  showBoard(next);
}

// ---------------------------------------------------------------------------
// Lifecycle (called from the native side)
// ---------------------------------------------------------------------------

function reset() {
  if (S.editing) {
    S.editing.ta.remove();
    S.editing = null;
  }
  flushPendingDots();
  S.elements = [];
  S.selected.clear();
  S.action = null;
  S.multi = null;
  S.erasing.clear();
  S.tool = DEFAULT_TOOL;
  S.lastEsc = 0;
  history.stack = [[]];
  history.index = 0;
  boards.index = null;
  boards.base = '[]';
  setCursor(baseCursor());
  render();
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Save the board to history and clear the canvas, then wait until the empty
// frame is on screen so the window never re-opens showing the old drawing.
async function close() {
  saveBoard();
  reset();
  await nextFrame();
  await nextFrame();
}

window.SD = {
  reset,
  close,
  show(shot) {
    reset();
    boards.shot = shot || null;
    window.focus();
    canvas.focus();
  },
  boards,
  state: S,
};

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('dblclick', onDoubleClick);
window.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('resize', resize);
document.fonts?.load(font(FONT_SIZE)).then(() => dirty());
resize();
reset();
