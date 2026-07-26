// popover.js — searchable language popover + lightweight menu, shared by the
// main window and the settings window. Pure DOM, no framework.
// The languages array arrives in display order (Auto-detect, pinned hr/sl,
// then A–Z); separators are drawn after index 0 and 2 in the unfiltered view.
(function () {
  'use strict';

  // The search placeholder is the popover's only piece of text; the renderers
  // hand it over once the localized string table arrives.
  let SEARCH_PLACEHOLDER = 'Search languages';
  function setSearchPlaceholder(text) { if (text) SEARCH_PLACEHOLDER = text; }

  const CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

  // Search matches the English name (contains) or the code (prefix).
  function filterLanguages(languages, query) {
    const q = query.trim().toLowerCase();
    if (!q) return languages.slice();
    return languages.filter((l) =>
      l.name.toLowerCase().includes(q) || l.code.toLowerCase().startsWith(q));
  }

  function makeLayer() {
    const layer = document.createElement('div');
    layer.className = 'popover-layer';
    document.body.appendChild(layer);
    return layer;
  }

  function place(el, anchor, width, height) {
    const r = anchor.getBoundingClientRect();
    const pad = 8;
    let left = Math.min(Math.max(r.left, pad), window.innerWidth - width - pad);
    let top = r.bottom + 6;
    if (top + height > window.innerHeight - pad) {
      top = Math.max(pad, Math.min(r.top - 6 - height, window.innerHeight - height - pad));
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  // opts: {anchor, languages:[{code,name}], selected, onPick(code)}
  function openLanguagePopover(opts) {
    const layer = makeLayer();
    const pop = document.createElement('div');
    pop.className = 'popover';
    const height = Math.min(360, window.innerHeight - 16);
    pop.style.height = height + 'px';
    pop.innerHTML =
      '<div class="search-wrap"><input class="field" type="text" spellcheck="false"></div>' +
      '<div class="list"></div>';
    layer.appendChild(pop);
    place(pop, opts.anchor, 260, height);

    const input = pop.querySelector('input');
    input.placeholder = SEARCH_PLACEHOLDER;
    const list = pop.querySelector('.list');
    let results = [];
    let highlighted = 0;

    function close() {
      layer.remove();
      document.removeEventListener('keydown', onKeyDoc, true);
    }
    function pick(code) { close(); opts.onPick(code); }

    function renderList() {
      const unfiltered = input.value.trim() === '';
      list.textContent = '';
      results.forEach((lang, index) => {
        const row = document.createElement('button');
        row.className = 'lang-row' + (index === highlighted ? ' highlighted' : '');
        row.type = 'button';
        const check = document.createElement('span');
        check.className = 'check';
        if (lang.code === opts.selected) check.innerHTML = CHECK_SVG;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = lang.name;
        row.appendChild(check);
        row.appendChild(name);
        if (lang.code !== 'auto') {
          const code = document.createElement('span');
          code.className = 'code';
          code.textContent = lang.code;
          row.appendChild(code);
        }
        // Keep type-to-search focus in the field while clicking rows.
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => pick(lang.code));
        row.addEventListener('mousemove', () => {
          if (highlighted !== index) { highlighted = index; updateHighlight(); }
        });
        list.appendChild(row);
        if (unfiltered && (index === 0 || index === 2)) {
          const sep = document.createElement('div');
          sep.className = 'sep';
          list.appendChild(sep);
        }
      });
    }

    function updateHighlight() {
      const rows = list.querySelectorAll('.lang-row');
      rows.forEach((r, i) => r.classList.toggle('highlighted', i === highlighted));
      const el = rows[highlighted];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function refilter() {
      results = filterLanguages(opts.languages, input.value);
      highlighted = 0;
      renderList();
    }

    input.addEventListener('input', refilter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlighted = Math.min(highlighted + 1, Math.max(0, results.length - 1));
        updateHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlighted = Math.max(highlighted - 1, 0);
        updateHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length) pick(results[Math.min(Math.max(highlighted, 0), results.length - 1)].code);
      }
    });
    function onKeyDoc(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKeyDoc, true);
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });

    refilter();
    input.focus();
    return close;
  }

  // opts: {anchor, items:[{label, onClick}]}
  function openMenu(opts) {
    const layer = makeLayer();
    const menu = document.createElement('div');
    menu.className = 'menu';
    layer.appendChild(menu);
    opts.items.forEach((item) => {
      const el = document.createElement('button');
      el.className = 'menu-item';
      el.type = 'button';
      el.textContent = item.label;
      el.addEventListener('click', () => { close(); item.onClick(); });
      menu.appendChild(el);
    });
    function close() {
      layer.remove();
      document.removeEventListener('keydown', onKeyDoc, true);
    }
    function onKeyDoc(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKeyDoc, true);
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
    place(menu, opts.anchor, Math.max(160, menu.offsetWidth), menu.offsetHeight);
    return close;
  }

  window.TranscribePopover = { openLanguagePopover, openMenu, setSearchPlaceholder };
})();
