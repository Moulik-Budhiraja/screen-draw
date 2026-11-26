// Search text: `@folder` filters by folder, `#tag` by tag, time phrases
// ("yesterday", "last 3 hours", see when.ts) by when it was taken, and other
// words match what you typed for it (note, folder, tags, file name) or, ranked
// below those, the text read off the image. The word being typed at the end
// can be a partial @ or # (shown as suggestions).
// The note bar in the app uses the same syntax (web/src/note.js).

import type { Item } from "./library";
import { extractSpan, type Span } from "./when";

// "My Folder", "my-folder" and "my_folder" are the same name.
export const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "-");

// Words have no spaces, so a folder with spaces is typed with dashes.
export const tokenText = (name: string) => name.trim().replace(/\s+/g, "-");

export type Query = {
  folders: string[];
  tags: string[];
  words: string[];
  span: Span | null;
  // The last word, while it's still being typed (no space after it).
  last: { kind: "@" | "#" | ""; text: string } | null;
};

export function parseQuery(text: string, now = Date.now()): Query {
  const parts = text.split(/\s+/).filter(Boolean);
  const typing = parts.length > 0 && !/\s$/.test(text);
  const q: Query = { folders: [], tags: [], words: [], span: null, last: null };
  parts.forEach((word, i) => {
    const isLast = typing && i === parts.length - 1;
    const kind = word[0] === "@" || word[0] === "#" ? word[0] : "";
    const body = kind ? word.slice(1) : word;
    if (isLast) q.last = { kind, text: body };
    if (!body) return;
    if (kind === "@" && !isLast) q.folders.push(body);
    else if (kind === "#" && !isLast) q.tags.push(body);
    else if (!kind) q.words.push(body.toLowerCase());
  });
  const { span, rest } = extractSpan(q.words, now);
  q.span = span;
  q.words = rest;
  return q;
}

export enum Match {
  None = 0,
  Text = 1, // only through the text read off the image
  Label = 2, // through what you typed for it
}

export function match(item: Item, q: Query): Match {
  const folder = item.folder ? norm(item.folder) : "";
  if (q.folders.some((f) => norm(f) !== folder)) return Match.None;
  const tags = item.tags.map(norm);
  if (q.tags.some((t) => !tags.includes(norm(t)))) return Match.None;
  // A half-typed @ or # narrows by prefix as you type.
  if (q.last?.kind === "@" && q.last.text && !folder.startsWith(norm(q.last.text))) return Match.None;
  if (q.last?.kind === "#" && q.last.text && !tags.some((t) => t.startsWith(norm(q.last!.text)))) return Match.None;
  if (q.span && (item.createdAt < q.span.start || item.createdAt >= q.span.end)) return Match.None;
  if (!q.words.length) return Match.Label;
  const label = [item.note, item.folder ?? "", item.tags.join(" "), item.name].join("\n").toLowerCase();
  if (q.words.every((w) => label.includes(w))) return Match.Label;
  const text = item.text.toLowerCase();
  return q.words.every((w) => label.includes(w) || text.includes(w)) ? Match.Text : Match.None;
}

// Folders (or tags) whose names match what's being typed, best first.
export function suggest(names: string[], typed: string, exclude: string[] = []): string[] {
  const q = norm(typed);
  const skip = new Set(exclude.map(norm));
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const n = norm(name);
    if (skip.has(n)) continue;
    if (!q || n.startsWith(q)) starts.push(name);
    else if (n.includes(q)) contains.push(name);
  }
  return [...starts, ...contains];
}

// The search text with the word being typed swapped for a finished token.
export function applyToken(text: string, kind: "@" | "#", name: string): string {
  const base = /\s$/.test(text) || !text ? text : text.replace(/\S+$/, "");
  return `${base}${kind}${tokenText(name)} `;
}
