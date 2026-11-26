// The note bar shown after ⌥⇧S, at the bottom center of the screen. Plain
// words are the note, `@name` puts the image in that folder and `#name` tags
// it. Typing either opens a list of existing folders or tags to pick from.
// Enter saves, Escape drops it.
//
// The input's own text is transparent; a copy of it behind (the mirror) is
// what you see, so @folder and #tag can be colored.

const MAX_SUGGESTIONS = 6;

// "My Folder", "my-folder" and "my_folder" are the same name.
export const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '-');

// Words with no spaces, so a folder with spaces is typed with dashes.
const tokenText = (name) => name.trim().replace(/\s+/g, '-');

export function parseNote(text) {
  let folder = null;
  const tags = [];
  const words = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (word[0] === '@') {
      if (word.length > 1) folder = word.slice(1);
    } else if (word[0] === '#') {
      if (word.length > 1 && !tags.some((t) => norm(t) === norm(word.slice(1)))) tags.push(word.slice(1));
    } else words.push(word);
  }
  return { note: words.join(' '), folder, tags };
}

// The @ or # word the caret is in, if any.
const activeToken = (text, caret) => {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const word = text.slice(start, end);
  if (word[0] !== '@' && word[0] !== '#') return null;
  return { kind: word[0], start, end, query: text.slice(start + 1, caret), word };
};

// Names starting with the query first, then names containing it, each in the
// order given (most recent or most used first).
const rank = (names, query) => {
  const q = norm(query);
  const starts = [];
  const contains = [];
  for (const name of names) {
    const n = norm(name);
    if (!q || n.startsWith(q)) starts.push(name);
    else if (n.includes(q)) contains.push(name);
  }
  return [...starts, ...contains];
};

const escapeHTML = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const FOLDER_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 4.25A1.75 1.75 0 0 1 3.25 2.5h2.7c.46 0 .9.18 1.23.51l.81.81c.14.14.33.22.53.22h4.23c.97 0 1.75.78 1.75 1.75v5.96c0 .97-.78 1.75-1.75 1.75h-9.5c-.97 0-1.75-.78-1.75-1.75V4.25Z"/></svg>';

export function createNoteBar({ onSave, onCancel }) {
  const root = document.createElement('div');
  root.id = 'note';
  root.hidden = true;
  root.innerHTML = `
    <div class="note-scrim"></div>
    <div class="note-box">
      <div class="note-suggest" hidden></div>
      <div class="note-field">
        <div class="note-mirror"><span class="note-mirror-text"></span></div>
        <input class="note-input" type="text" spellcheck="false" autocomplete="off" placeholder="Note  @folder  #tag">
      </div>
    </div>
    <div class="note-toast" hidden>Saved</div>`;
  document.body.appendChild(root);

  const scrim = root.querySelector('.note-scrim');
  const box = root.querySelector('.note-box');
  const input = root.querySelector('.note-input');
  const mirror = root.querySelector('.note-mirror-text');
  const list = root.querySelector('.note-suggest');
  const toast = root.querySelector('.note-toast');

  const state = {
    open: false,
    folders: [],
    tags: [],
    items: [], // current suggestions: { name, isNew }
    active: 0,
    token: null,
    dismissed: null, // the token text whose list Escape closed
    toastTimer: 0,
  };

  const renderMirror = () => {
    const text = input.value;
    const caretToken = activeToken(text, input.selectionStart ?? text.length);
    let html = '';
    let at = 0;
    for (const part of text.split(/(\s+)/)) {
      const start = at;
      at += part.length;
      if (part.length > 1 && (part[0] === '@' || part[0] === '#')) {
        const cls = part[0] === '@' ? 'tok-folder' : 'tok-tag';
        const mark = caretToken && caretToken.start === start ? ' data-active="1"' : '';
        html += `<span class="${cls}"${mark}>${escapeHTML(part)}</span>`;
      } else if (caretToken && caretToken.start === start) {
        html += `<span data-active="1">${escapeHTML(part)}</span>`;
      } else html += escapeHTML(part);
    }
    mirror.innerHTML = html;
    mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  const renderList = () => {
    if (!state.items.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;
    list.innerHTML = state.items.map((item, i) => {
      const icon = state.token.kind === '@' ? FOLDER_ICON : '<span class="note-hash">#</span>';
      return `<div class="note-row${i === state.active ? ' active' : ''}" data-i="${i}">
        <span class="note-icon">${icon}</span><span class="note-name">${escapeHTML(item.name)}</span>${item.isNew ? '<span class="note-new">New</span>' : ''}
      </div>`;
    }).join('');
    // Line the list up with the word being typed.
    const marker = mirror.querySelector('[data-active]');
    const field = input.getBoundingClientRect();
    const x = marker ? marker.getBoundingClientRect().left - field.left - 10 : 0;
    const maxX = Math.max(0, field.width - list.offsetWidth);
    list.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
  };

  const update = () => {
    const caret = input.selectionStart ?? input.value.length;
    const token = activeToken(input.value, caret);
    state.token = token;
    state.items = [];
    if (token && token.word !== state.dismissed) {
      const names = token.kind === '@' ? state.folders : state.tags;
      state.items = rank(names, token.query).slice(0, MAX_SUGGESTIONS).map((name) => ({ name }));
      const q = token.query.trim();
      if (q && !names.some((n) => norm(n) === norm(q))) state.items.push({ name: q, isNew: true });
      // Nothing to pick when the one match is what's already typed.
      if (state.items.length === 1 && `${token.kind}${tokenText(state.items[0].name)}` === token.word) state.items = [];
    }
    if (state.active >= state.items.length) state.active = 0;
    renderMirror();
    renderList();
  };

  const accept = (item) => {
    const t = state.token;
    if (!t || !item) return;
    const text = input.value;
    const insert = `${t.kind}${tokenText(item.name)}`;
    const after = text.slice(t.end);
    const spacer = after.startsWith(' ') ? '' : ' ';
    input.value = text.slice(0, t.start) + insert + spacer + after;
    const caret = t.start + insert.length + 1;
    input.setSelectionRange(caret, caret);
    state.active = 0;
    update();
  };

  // What the highlighted suggestion would change the word into, if anything.
  const pendingCompletion = () => {
    const t = state.token;
    const item = state.items[state.active];
    if (!t || !item || list.hidden) return null;
    const insert = `${t.kind}${tokenText(item.name)}`;
    return insert === t.word ? null : item;
  };

  const resolved = () => {
    const parsed = parseNote(input.value);
    // Use an existing folder's or tag's own spelling.
    if (parsed.folder) parsed.folder = state.folders.find((f) => norm(f) === norm(parsed.folder)) ?? parsed.folder;
    parsed.tags = parsed.tags.map((t) => state.tags.find((x) => norm(x) === norm(t)) ?? t);
    return parsed;
  };

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    e.stopPropagation();
    const listOpen = !list.hidden && state.items.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'n' || e.key === 'p'))) {
      if (!listOpen) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' || e.key === 'n' ? 1 : -1;
      state.active = (state.active + dir + state.items.length) % state.items.length;
      renderList();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (listOpen) accept(state.items[state.active]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const completion = !(e.metaKey || e.ctrlKey) && pendingCompletion();
      if (completion) accept(completion);
      else onSave(resolved());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (listOpen) {
        state.dismissed = state.token?.word ?? null;
        update();
      } else onCancel();
    }
  });
  input.addEventListener('input', () => {
    state.dismissed = null;
    state.active = 0;
    update();
  });
  // Moving the caret into or out of a word changes the list.
  for (const type of ['keyup', 'click', 'select', 'scroll']) input.addEventListener(type, () => update());
  document.addEventListener('selectionchange', () => state.open && update());

  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = e.target.closest('.note-row');
    if (row) accept(state.items[Number(row.dataset.i)]);
  });
  // Clicks anywhere else keep the caret in the note.
  for (const el of [scrim, box]) {
    el.addEventListener('mousedown', (e) => {
      if (e.target !== input) e.preventDefault();
      input.focus();
    });
  }

  return {
    get isOpen() {
      return state.open;
    },
    open({ folders = [], tags = [], kind = 'screenshot' } = {}) {
      clearTimeout(state.toastTimer);
      toast.hidden = true;
      state.open = true;
      state.folders = folders;
      state.tags = tags;
      state.dismissed = null;
      state.active = 0;
      input.value = '';
      root.dataset.kind = kind;
      root.hidden = false;
      box.classList.remove('note-in');
      void box.offsetWidth;
      box.classList.add('note-in');
      update();
      input.focus();
    },
    close({ saved = false } = {}) {
      if (!state.open) return;
      state.open = false;
      input.blur();
      list.hidden = true;
      if (saved) {
        scrim.hidden = true;
        box.hidden = true;
        toast.hidden = false;
        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(() => this.hide(), 1100);
      } else this.hide();
    },
    hide() {
      clearTimeout(state.toastTimer);
      root.hidden = true;
      toast.hidden = true;
      scrim.hidden = false;
      box.hidden = false;
    },
  };
}
