// Search text: `@folder` filters by folder, `#tag` by tag, other words match
// the note, the text in the image, the folder, tags and file name. The word
// being typed at the end can be a partial @ or # (shown as suggestions).
// The note bar in the app uses the same syntax (web/src/note.js).

import type { Item } from "./library";

// "My Folder", "my-folder" and "my_folder" are the same name.
export const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "-");

// Words have no spaces, so a folder with spaces is typed with dashes.
export const tokenText = (name: string) => name.trim().replace(/\s+/g, "-");

export type Query = {
  folders: string[];
  tags: string[];
  words: string[];
  // The last word, while it's still being typed (no space after it).
  last: { kind: "@" | "#" | ""; text: string } | null;
};

export function parseQuery(text: string): Query {
  const parts = text.split(/\s+/).filter(Boolean);
  const typing = parts.length > 0 && !/\s$/.test(text);
  const q: Query = { folders: [], tags: [], words: [], last: null };
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
  return q;
}

const dateText = (ms: number) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} ${d.toISOString().slice(0, 10)}`;
};

export function matches(item: Item, q: Query): boolean {
  const folder = item.folder ? norm(item.folder) : "";
  if (q.folders.some((f) => norm(f) !== folder)) return false;
  const tags = item.tags.map(norm);
  if (q.tags.some((t) => !tags.includes(norm(t)))) return false;
  // A half-typed @ or # narrows by prefix as you type.
  if (q.last?.kind === "@" && q.last.text && !folder.startsWith(norm(q.last.text))) return false;
  if (q.last?.kind === "#" && q.last.text && !tags.some((t) => t.startsWith(norm(q.last!.text)))) return false;
  if (!q.words.length) return true;
  const haystack = [item.note, item.text, item.folder ?? "", item.tags.join(" "), item.name, dateText(item.createdAt)]
    .join("\n")
    .toLowerCase();
  return q.words.every((w) => haystack.includes(w));
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

// The note editor's text (`note @folder #tag`) back into fields.
export function parseNote(text: string): { note: string; folder: string | null; tags: string[] } {
  let folder: string | null = null;
  const tags: string[] = [];
  const words: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (word[0] === "@") {
      if (word.length > 1) folder = word.slice(1);
    } else if (word[0] === "#") {
      const tag = word.slice(1);
      if (tag && !tags.some((t) => norm(t) === norm(tag))) tags.push(tag);
    } else words.push(word);
  }
  return { note: words.join(" "), folder, tags };
}

export function noteText(item: Pick<Item, "note" | "folder" | "tags">): string {
  return [item.note, item.folder ? `@${tokenText(item.folder)}` : "", ...item.tags.map((t) => `#${tokenText(t)}`)]
    .filter(Boolean)
    .join(" ");
}
