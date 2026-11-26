// The note bar shown after ⌥⇧S, at the bottom center of the screen. Plain
// words are the note, `@name` puts the image in that folder and `#name` tags
// it. Typing either opens a list of existing folders or tags to pick from.
// Picking one, or typing a space after the name, turns it into a chip where
// it stands; Backspace takes a chip out whole. Enter saves, Escape drops it.
//
// When editing a saved image (Raycast's Rename or Edit Note), its folder and
// tags start as chips at the front and its note is selected, so typing
// replaces the note and keeps the chips.

const MAX_SUGGESTIONS = 6;

// "My Folder", "my-folder" and "my_folder" are the same name.
export const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '-');

export function parseNote(text) {
  let folder = null;
  const tags = [];
  const words = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (word[0] === '@') {
      if (word.length > 1) folder = word.slice(1);
    } else if (word[0] === '#') {
      if (word.length > 1) tags.push(word.slice(1));
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
const iconFor = (kind) => (kind === '@' ? FOLDER_ICON : '<span class="note-hash">#</span>');

export function createNoteBar({ onSave, onCancel }) {
  const root = document.createElement('div');
  root.id = 'note';
  root.hidden = true;
  root.innerHTML = `
    <div class="note-scrim"></div>
    <div class="note-box">
      <div class="note-suggest" hidden></div>
      <div class="note-field">
        <div class="note-edit" contenteditable="true" spellcheck="false" autocorrect="off" autocapitalize="off" data-placeholder="Note  @folder  #tag"></div>
      </div>
    </div>
    <div class="note-toast" hidden>Saved</div>`;
  document.body.appendChild(root);

  const scrim = root.querySelector('.note-scrim');
  const box = root.querySelector('.note-box');
  const edit = root.querySelector('.note-edit');
  const list = root.querySelector('.note-suggest');
  const toast = root.querySelector('.note-toast');

  const state = {
    open: false,
    folders: [],
    tags: [],
    items: [], // current suggestions: { name, isNew }
    active: 0,
    token: null, // { kind, start, end, query, word, node }
    dismissed: null, // the word whose list Escape closed
    toastTimer: 0,
  };

  const known = (kind, name) => {
    const names = kind === '@' ? state.folders : state.tags;
    return names.find((n) => norm(n) === norm(name)) ?? name;
  };

  const makeChip = (kind, name) => {
    const chip = document.createElement('span');
    chip.className = `chip ${kind === '@' ? 'chip-folder' : 'chip-tag'}`;
    chip.contentEditable = 'false';
    chip.dataset.kind = kind;
    chip.dataset.name = name;
    chip.innerHTML = `<span class="chip-icon">${iconFor(kind)}</span>${escapeHTML(name)}`;
    return chip;
  };

  const placeCaret = (node, offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // The text node the caret is in, and where.
  const caret = () => {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
    if (node.nodeType !== Node.TEXT_NODE || !edit.contains(node)) return null;
    return { node, offset };
  };

  // Swaps the characters start..end of a text node for a chip, with one
  // space after it and the caret after that. One folder at a time.
  const chipify = (node, start, end, kind, name) => {
    if (kind === '@') edit.querySelectorAll('.chip-folder').forEach((c) => c.remove());
    const text = node.textContent;
    const after = document.createTextNode(` ${text.slice(end).replace(/^ /, '')}`);
    node.textContent = text.slice(0, start);
    const chip = makeChip(kind, known(kind, name));
    node.after(chip, after);
    placeCaret(after, 1);
    state.dismissed = null;
    state.active = 0;
    update();
  };

  const renderList = () => {
    if (!state.items.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;
    list.innerHTML = state.items.map((item, i) => `<div class="note-row${i === state.active ? ' active' : ''}" data-i="${i}">
        <span class="note-icon">${iconFor(state.token.kind)}</span><span class="note-name">${escapeHTML(item.name)}</span>${item.isNew ? '<span class="note-new">New</span>' : ''}
      </div>`).join('');
    // Line the list up with the word being typed.
    const range = document.createRange();
    range.setStart(state.token.node, state.token.start);
    range.collapse(true);
    const field = edit.getBoundingClientRect();
    const x = range.getBoundingClientRect().left - field.left - 10;
    const maxX = Math.max(0, field.width - list.offsetWidth);
    list.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
  };

  const update = () => {
    const empty = !edit.textContent.trim() && !edit.querySelector('.chip');
    edit.classList.toggle('empty', empty);
    // A stray <br> is what's left once everything is deleted.
    if (empty) edit.querySelectorAll('br').forEach((br) => br.remove());
    const at = caret();
    const token = at && activeToken(at.node.textContent, at.offset);
    state.token = token ? { ...token, node: at.node } : null;
    state.items = [];
    if (token && token.word !== state.dismissed) {
      const names = token.kind === '@' ? state.folders : state.tags;
      state.items = rank(names, token.query).slice(0, MAX_SUGGESTIONS).map((name) => ({ name }));
      const q = token.query.trim();
      if (q && !names.some((n) => norm(n) === norm(q))) state.items.push({ name: q, isNew: true });
    }
    if (state.active >= state.items.length) state.active = 0;
    renderList();
  };

  const accept = (item) => {
    const t = state.token;
    if (t && item) chipify(t.node, t.start, t.end, t.kind, item.name);
  };

  // A space typed right after "@name" or "#name" makes it a chip.
  const chipifyBeforeCaret = () => {
    const at = caret();
    if (!at) return;
    const before = at.node.textContent.slice(0, at.offset);
    const m = before.match(/(^|\s)([@#])([^\s@#]+)\s$/);
    if (!m) return;
    const start = at.offset - m[0].length + m[1].length;
    chipify(at.node, start, at.offset, m[2], m[3]);
  };

  const values = () => {
    let folder = null;
    let tags = [];
    let text = '';
    for (const node of edit.childNodes) {
      if (node.classList?.contains('chip')) {
        text += ' ';
        if (node.dataset.kind === '@') folder = node.dataset.name;
        else tags.push(node.dataset.name);
      } else text += node.textContent;
    }
    // Names still typed out (no space after them yet) count too.
    const typed = parseNote(text);
    if (typed.folder) folder = known('@', typed.folder);
    tags = [...tags, ...typed.tags.map((t) => known('#', t))];
    tags = tags.filter((t, i) => tags.findIndex((x) => norm(x) === norm(t)) === i);
    return { note: typed.note, folder, tags };
  };

  edit.addEventListener('keydown', (e) => {
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
      // Enter picks a suggestion first, unless it's already what's typed.
      const item = listOpen && !(e.metaKey || e.ctrlKey) && state.items[state.active];
      if (item && `${state.token.kind}${item.name}` !== state.token.word) accept(item);
      else onSave(values());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (listOpen) {
        state.dismissed = state.token?.word ?? null;
        update();
      } else onCancel();
    }
  });
  edit.addEventListener('beforeinput', (e) => {
    // One line of plain text.
    if (e.inputType.startsWith('format') || e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
    }
  });
  edit.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
    document.execCommand('insertText', false, text);
  });
  edit.addEventListener('input', (e) => {
    state.dismissed = null;
    state.active = 0;
    if (e.inputType === 'insertText' && /\s$/.test(e.data ?? '')) chipifyBeforeCaret();
    update();
  });
  document.addEventListener('selectionchange', () => state.open && update());

  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = e.target.closest('.note-row');
    if (row) accept(state.items[Number(row.dataset.i)]);
  });
  // Clicks anywhere else keep the caret in the note.
  for (const el of [scrim, box]) {
    el.addEventListener('mousedown', (e) => {
      if (edit.contains(e.target)) return;
      e.preventDefault();
      edit.focus();
    });
  }

  // Folder and tags as chips at the front, then the note, selected.
  const fill = ({ note = '', folder = '', tags = [] } = {}) => {
    edit.innerHTML = '';
    const chips = [...(folder ? [makeChip('@', folder)] : []), ...tags.map((t) => makeChip('#', t))];
    for (const chip of chips) edit.append(chip, document.createTextNode(' '));
    const text = document.createTextNode(note);
    edit.append(text);
    edit.focus();
    if (note) {
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else placeCaret(text, 0);
  };

  return {
    get isOpen() {
      return state.open;
    },
    open({ folders = [], tags = [], kind = 'screenshot', prefill = null } = {}) {
      clearTimeout(state.toastTimer);
      toast.hidden = true;
      state.open = true;
      state.folders = folders;
      state.tags = tags;
      state.dismissed = null;
      state.active = 0;
      root.dataset.kind = kind;
      root.hidden = false;
      fill(prefill ?? {});
      update();
    },
    close({ saved = false } = {}) {
      if (!state.open) return;
      state.open = false;
      edit.blur();
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
