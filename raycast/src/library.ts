// The Screen Utils library: images in folders under one root, and
// `.screenutils.json` at the root with each image's note, tags and the text
// read off it (written by the app, Sources/ScreenUtils/Library.swift).
// Folders are the root's subfolders, so one made in Finder counts too, and
// images without an entry still show up. Every change reads the index fresh
// and replaces it in one rename, since the app writes it too.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { norm } from "./query";

export const INDEX_NAME = ".screenutils.json";
const IMAGE = /\.(png|jpe?g|heic|gif|webp|tiff?)$/i;

export type Item = {
  path: string; // absolute
  rel: string; // key in the index: "Folder/name.png" or "name.png"
  name: string;
  folder: string | null;
  note: string;
  tags: string[];
  text: string;
  kind: string;
  createdAt: number;
  width?: number;
  height?: number;
};

export type Library = {
  root: string;
  items: Item[]; // newest first
  folders: string[]; // most recently used first
  tags: string[]; // most used first
};

type Entry = Record<string, unknown> & {
  note?: string;
  tags?: string[];
  text?: string;
  kind?: string;
  createdAt?: number;
  width?: number;
  height?: number;
};
type Index = Record<string, Entry>;

export const expandHome = (p: string) => (p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p);

async function readIndex(root: string): Promise<Index> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(root, INDEX_NAME), "utf8"));
    return json && typeof json.items === "object" && json.items ? json.items : {};
  } catch {
    return {};
  }
}

async function writeIndex(root: string, items: Index) {
  const file = path.join(root, INDEX_NAME);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2));
  await fs.rename(tmp, file);
}

async function updateIndex(root: string, change: (items: Index) => void) {
  const items = await readIndex(root);
  change(items);
  await writeIndex(root, items);
}

async function listDir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function loadLibrary(root: string): Promise<Library> {
  const index = await readIndex(root);
  const folders: string[] = [];
  const files: { rel: string; folder: string | null }[] = [];
  for (const entry of await listDir(root)) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      folders.push(entry.name);
      for (const sub of await listDir(path.join(root, entry.name))) {
        if (sub.isFile() && IMAGE.test(sub.name) && !sub.name.startsWith("."))
          files.push({ rel: `${entry.name}/${sub.name}`, folder: entry.name });
      }
    } else if (entry.isFile() && IMAGE.test(entry.name)) files.push({ rel: entry.name, folder: null });
  }

  const items = await Promise.all(
    files.map(async ({ rel, folder }): Promise<Item> => {
      const meta = index[rel] ?? {};
      const full = path.join(root, rel);
      let createdAt = typeof meta.createdAt === "number" ? meta.createdAt : 0;
      if (!createdAt)
        createdAt = await fs.stat(full).then(
          (s) => s.birthtimeMs || s.mtimeMs,
          () => 0,
        );
      return {
        path: full,
        rel,
        name: path.basename(rel),
        folder,
        note: typeof meta.note === "string" ? meta.note : "",
        tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === "string") : [],
        text: typeof meta.text === "string" ? meta.text : "",
        kind: typeof meta.kind === "string" ? meta.kind : "screenshot",
        createdAt,
        width: typeof meta.width === "number" ? meta.width : undefined,
        height: typeof meta.height === "number" ? meta.height : undefined,
      };
    }),
  );
  items.sort((a, b) => b.createdAt - a.createdAt);

  const folderLast = new Map<string, number>();
  const tagUse = new Map<string, { count: number; last: number; name: string }>();
  for (const item of items) {
    if (item.folder && !folderLast.has(item.folder)) folderLast.set(item.folder, item.createdAt);
    for (const tag of item.tags) {
      const use = tagUse.get(norm(tag)) ?? { count: 0, last: item.createdAt, name: tag };
      use.count++;
      tagUse.set(norm(tag), use);
    }
  }
  folders.sort((a, b) => (folderLast.get(b) ?? 0) - (folderLast.get(a) ?? 0) || a.localeCompare(b));
  const tags = [...tagUse.values()].sort((a, b) => b.count - a.count || b.last - a.last).map((t) => t.name);
  return { root, items, folders, tags };
}

// Name typed after @: an existing folder's own spelling, or a new safe name.
export function resolveFolder(folders: string[], typed: string | null): string | null {
  const name = typed?.trim();
  if (!name) return null;
  const existing = folders.find((f) => norm(f) === norm(name));
  if (existing) return existing;
  const safe = name.replace(/[/:]/g, "-").replace(/^\.+/, "").slice(0, 64);
  return safe || null;
}

const resolveTags = (known: string[], typed: string[]) => typed.map((t) => known.find((k) => norm(k) === norm(t)) ?? t);

async function freeName(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
}

// Change an image's note, tags and folder. Moving folders moves the file.
// Returns the item's new path.
export async function editItem(
  lib: Library,
  item: Item,
  change: { note: string; folder: string | null; tags: string[] },
): Promise<string> {
  const folder = resolveFolder(lib.folders, change.folder);
  const tags = resolveTags(lib.tags, change.tags);
  let rel = item.rel;
  if (folder !== item.folder) {
    const dir = folder ? path.join(lib.root, folder) : lib.root;
    await fs.mkdir(dir, { recursive: true });
    const name = await freeName(dir, item.name);
    await fs.rename(item.path, path.join(dir, name));
    rel = folder ? `${folder}/${name}` : name;
  }
  await updateIndex(lib.root, (items) => {
    const entry: Entry = { ...(items[item.rel] ?? {}) };
    if (!entry.createdAt) entry.createdAt = item.createdAt;
    delete items[item.rel];
    items[rel] = { ...entry, note: change.note, tags };
  });
  return path.join(lib.root, rel);
}

// After the file itself is gone (moved to the Trash).
export async function forgetItem(lib: Library, item: Item) {
  await updateIndex(lib.root, (items) => {
    delete items[item.rel];
  });
}
