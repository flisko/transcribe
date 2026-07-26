// view.js — main window renderer. Dumb by contract (C4): renders the state
// snapshot from main verbatim (all status/footer text arrives pre-composed)
// and sends commands back via window.api.invoke. Local-only concerns: row
// selection, link-field editing, drag choreography, popovers.
(function () {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);

  // Static UI text in the user's language, pushed once per load by main. The HTML
  // ships English so there is never a blank frame; this replaces it as soon as it
  // arrives. Empty until then, so every read goes through T().
  let S = {};
  const T = (key, fallback) => (S[key] !== undefined ? S[key] : (fallback || ''));

  function applyStrings(strings) {
    S = strings || {};
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = S[el.dataset.i18n];
      if (v !== undefined) el.textContent = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      const v = S[el.dataset.i18nTitle];
      if (v !== undefined) el.title = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
      const v = S[el.dataset.i18nPlaceholder];
      if (v !== undefined) el.placeholder = v;
    }
    // The empty-state subtitle is the one string with a deliberate line break.
    if (S.emptySubtitle) {
      const p = $('emptySubtitle');
      p.textContent = '';
      S.emptySubtitle.split('\n').forEach((line, i) => {
        if (i) p.appendChild(document.createElement('br'));
        p.appendChild(document.createTextNode(line));
      });
    }
    if (S.searchLanguages) window.TranscribePopover.setSearchPlaceholder(S.searchLanguages);
    if (snapshot) render();   // repaint anything already on screen
  }
  api.onStrings(applyStrings);

  if (navigator.platform.indexOf('Mac') !== -1) document.body.classList.add('mac');

  // ---------- icons ----------
  const ICONS = {
    film: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M7 4.5v15M17 4.5v15M2.5 9H7M2.5 15H7M17 9h4.5M17 15h4.5"/></svg>',
    waveform: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 10v4M6.5 7v10M10 4.5v15M13.5 8v8M17 5.5v13M20.5 9.5v5"/></svg>',
    link: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    done: '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="var(--color-success)"/><path d="M7.6 12.4l3 3.1 5.8-6.6" fill="none" stroke="var(--color-on-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    failed: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M10.28 3.9 2.33 17.66a2 2 0 0 0 1.73 3.04h15.88a2 2 0 0 0 1.73-3.04L13.72 3.9a2 2 0 0 0-3.44 0Z" fill="var(--color-destructive)"/><path d="M12 9v5" stroke="var(--color-on-accent)" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.1" r="1.15" fill="var(--color-on-accent)"/></svg>',
    canceled: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9.25"/><path d="M8 12h8" stroke-linecap="round"/></svg>',
    x: '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4" stroke="var(--color-content-bg)" stroke-width="2" stroke-linecap="round"/></svg>',
    ellipsis: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9.25"/><circle cx="7.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.4" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>',
    checkOn: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="var(--color-success)"/><path d="M7.6 12.4l3 3.1 5.8-6.6" fill="none" stroke="var(--color-on-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    checkOff: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-tertiary-label)" stroke-width="1.6"><circle cx="12" cy="12" r="9.2"/></svg>'
  };

  const ACTIVE_STATES = { lookingUp: 1, downloading: 1, preparing: 1, transcribing: 1 };

  let snapshot = null;
  let selectedId = null;
  let installClicked = false;   // links-limited "Install…" → "Check Again" swap

  const invoke = (cmd, payload) =>
    api.invoke(cmd, payload).catch((err) => console.error(cmd, err));

  const looksLikeWebLink = (s) => /^https?:\/\//i.test(s.trim());

  function itemById(id) {
    return snapshot ? snapshot.items.find((it) => it.id === id) : undefined;
  }

  // ---------- render ----------
  function render() {
    if (!snapshot) return;
    const s = snapshot;
    const phase = s.phase;

    renderToolbar(s);
    renderBanner(s.banner);

    $('inputs').classList.toggle('dimmed', phase === 'setup');
    const limited = phase === 'ready' && s.deps.linksLimited;
    $('linkArea').hidden = limited;
    $('linksLimited').hidden = !limited;
    if (!limited) installClicked = false;
    $('installBtn').textContent = installClicked ? T('checkAgain', 'Check Again') : T('linksLimitedInstall', 'Install…');

    renderQuickSettings(s);

    $('empty').hidden = !(phase === 'ready' && s.items.length === 0);
    $('setup').hidden = phase !== 'setup';
    if (phase === 'setup') renderSetup(s.deps);
    renderRows(s.items);

    $('footerText').textContent = s.footer.text || '';
    $('cancelAllBtn').hidden = !s.footer.showCancelAll;

    $('dropOverlayText').textContent = phase === 'setup'
      ? T('dropOverlaySetup', 'Finish setup to start transcribing')
      : T('dropOverlay', 'Drop to add to the queue');
  }

  function renderToolbar(s) {
    const sel = itemById(selectedId);
    const selectionIsInProgress = !!(sel && ACTIVE_STATES[sel.state]);
    $('clearDoneBtn').hidden = !(s.selectionHint.clearDoneVisible && !selectionIsInProgress);
  }

  function renderBanner(banner) {
    $('banner').hidden = !banner;
    if (banner) $('bannerMsg').textContent = banner.text || ('Version ' + banner.version + ' is available.');
  }

  function renderQuickSettings(s) {
    const lang = s.languages.find((l) => l.code === s.settings.language);
    $('langName').textContent = lang ? lang.name
      : (s.settings.language === 'auto' ? T('autoDetect', 'Auto-detect') : s.settings.language);
    const model = s.catalog.find((m) => m.sel === s.settings.model);
    $('modelName').textContent = model ? model.display : s.settings.model;
  }

  function renderSetup(deps) {
    const engineOK = deps.folderOK !== false;
    $('checklist').hidden = !engineOK;
    $('engineMissing').hidden = engineOK;
    if (!engineOK) return;
    const rows = [
      [T('setupWhisper', 'Speech recognition (whisper)'), deps.whisperOK],
      [T('setupFfmpeg', 'Audio converter (ffmpeg)'), deps.ffmpegOK],
      [T('setupModels', 'Language models (4.6 GB download)'), deps.modelsOK],
      [T('setupYtDlp', 'Link downloader (yt-dlp) — optional, only needed for video links'), deps.ytDlpOK]
    ];
    const list = $('checklist');
    list.textContent = '';
    for (const [name, ok] of rows) {
      const row = document.createElement('div');
      row.className = 'check';
      row.innerHTML = (ok ? ICONS.checkOn : ICONS.checkOff) +
        '<span class="name"></span><span class="st' + (ok ? ' ok' : '') + '"></span>';
      row.querySelector('.name').textContent = name;
      row.querySelector('.st').textContent = ok ? T('installed', 'Installed') : T('notInstalled', 'Not installed');
      list.appendChild(row);
    }
  }

  // ---------- queue rows ----------
  const rowEls = new Map();     // id -> element
  const knownIds = new Set();   // ids rendered in a previous snapshot (scroll gate)

  function renderRows(items) {
    const queue = $('queue');
    const seen = new Set();
    // Parity with AppModel.swift (scrollTarget set on every fresh add): scroll a
    // brand-new row into view so a file/link added to a full queue isn't lost
    // below the fold. The initial population (empty knownIds) never scrolls.
    const firstPaint = knownIds.size === 0;
    let scrollTargetEl = null;
    items.forEach((item) => {
      seen.add(item.id);
      let el = rowEls.get(item.id);
      if (!el) {
        el = createRow(item.id);
        rowEls.set(item.id, el);
        if (!firstPaint && !knownIds.has(item.id)) scrollTargetEl = el;
      }
      updateRow(el, item);
    });
    for (const [id, el] of rowEls) {
      if (!seen.has(id)) { el.remove(); rowEls.delete(id); }
    }
    if (selectedId && !seen.has(selectedId)) setSelected(null);
    // Reorder only where the DOM disagrees — re-appending unconditionally
    // would restart the indeterminate-bar animation on every snapshot.
    items.forEach((item, i) => {
      const el = rowEls.get(item.id);
      if (queue.children[i] !== el) queue.insertBefore(el, queue.children[i] || null);
    });
    knownIds.clear();
    for (const id of seen) knownIds.add(id);
    // Scroll after the DOM is settled (the row is now inserted/positioned).
    if (scrollTargetEl) scrollTargetEl.scrollIntoView({ block: 'nearest' });
  }

  function setSelected(id) {
    if (selectedId === id) return;
    selectedId = id;
    invoke('select', id);
  }

  function createRow(id) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = id;
    el.innerHTML =
      '<span class="icon"></span>' +
      '<div class="mid"><div class="title"></div><div class="status"></div></div>' +
      '<div class="trail"></div>';
    el.addEventListener('click', () => {
      setSelected(id);
      if (snapshot) { renderRows(snapshot.items); renderToolbar(snapshot); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setSelected(id);
      invoke('rowMenu', { id, x: Math.round(e.clientX), y: Math.round(e.clientY) });
    });
    return el;
  }

  function iconKeyFor(item) {
    if (item.state === 'done') return 'done';
    if (item.state === 'failed') return 'failed';
    if (item.state === 'canceled') return 'canceled';
    if (item.kind === 'link') return 'link';
    if (item.kind === 'audio') return 'waveform';
    return 'film';
  }

  function updateRow(el, item) {
    el.dataset.state = item.state;   // stable hook for tests and styling
    const iconKey = iconKeyFor(item);
    const icon = el.querySelector('.icon');
    if (icon.dataset.key !== iconKey) {
      icon.dataset.key = iconKey;
      icon.innerHTML = ICONS[iconKey];
    }

    const title = el.querySelector('.title');
    if (title.textContent !== item.title) title.textContent = item.title;

    const status = el.querySelector('.status');
    if (status.textContent !== item.statusText) status.textContent = item.statusText;
    status.title = item.statusTitle || item.statusText;
    status.classList.toggle('wrap', item.state === 'failed' || item.state === 'done');

    updateBar(el, item);
    updateTrail(el, item);

    el.classList.toggle('flash', !!item.flash);
    if (item.flash && !el.dataset.flashed) {
      el.dataset.flashed = '1';
      el.scrollIntoView({ block: 'nearest' });
    } else if (!item.flash) {
      delete el.dataset.flashed;
    }
    el.classList.toggle('selected', item.id === selectedId);
    el.setAttribute('aria-label', item.title + ', ' + item.statusText);
  }

  function updateBar(el, item) {
    const mid = el.querySelector('.mid');
    let bar = mid.querySelector('.bar');
    if (!item.showProgressBar) { if (bar) bar.remove(); return; }
    const created = !bar;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<i></i>';
      mid.appendChild(bar);
    }
    const indet = !!item.indeterminate;
    const wasIndet = bar.classList.contains('indet');
    bar.classList.toggle('indet', indet);
    const fill = bar.firstChild;
    if (indet) {
      fill.style.width = '';
      return;
    }
    const width = Math.max(0, Math.min(100, item.progressPct || 0)) + '%';
    // Leaving the indeterminate segment (which sits at a fixed 40% width from
    // CSS): the .25s width transition would animate 40%->real%, visibly shrinking
    // the bar while the label already reads "Transcribing — 1%". Suppress the
    // transition for this one handoff frame so the determinate bar starts at the
    // true percentage. (Under reduce-motion the stylesheet already sets
    // transition:none, so restoring to '' keeps it none — no regression.)
    if (wasIndet || created) {
      const prev = fill.style.transition;
      fill.style.transition = 'none';
      fill.style.width = width;
      void fill.offsetWidth;          // force reflow: commit width with no transition
      fill.style.transition = prev;   // '' -> back to the stylesheet's .25s transition
    } else {
      fill.style.width = width;
    }
  }

  function updateTrail(el, item) {
    const sig = item.state + '|' + item.canRetry + '|' + item.canOpen;
    const trail = el.querySelector('.trail');
    if (trail.dataset.sig === sig) return;
    trail.dataset.sig = sig;
    trail.textContent = '';
    const add = (node) => trail.appendChild(node);

    const iconBtn = (svg, tip, cmd, ghost) => {
      const b = document.createElement('button');
      b.className = 'iconbtn' + (ghost ? ' ghost' : '');
      b.title = tip;
      b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); invoke(cmd, item.id); });
      return b;
    };
    const smallBtn = (label, cmd) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); invoke(cmd, item.id); });
      return b;
    };
    const ellipsisBtn = () => {
      const b = document.createElement('button');
      b.className = 'iconbtn';
      b.innerHTML = ICONS.ellipsis;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = b.getBoundingClientRect();
        invoke('rowMenu', { id: item.id, x: Math.round(r.left), y: Math.round(r.bottom + 2) });
      });
      return b;
    };

    switch (item.state) {
      case 'waiting':
        add(iconBtn(ICONS.x, T('removeTooltip', 'Remove'), 'remove', true));
        break;
      case 'lookingUp': {
        const sp = document.createElement('span');
        sp.className = 'spinner';
        add(sp);
        add(iconBtn(ICONS.x, T('cancelTooltip', 'Cancel'), 'cancel', true));
        break;
      }
      case 'downloading':
      case 'preparing':
      case 'transcribing':
        add(iconBtn(ICONS.x, T('cancelTooltip', 'Cancel'), 'cancel', false));
        break;
      case 'done':
        if (item.canOpen !== false) add(smallBtn(T('open', 'Open'), 'openTranscript'));
        add(ellipsisBtn());
        break;
      case 'failed':
        if (item.canRetry !== false) add(smallBtn(T('retry', 'Retry'), 'retry'));
        add(ellipsisBtn());
        break;
      case 'canceled':
        add(smallBtn(T('startAgain', 'Start Again'), 'startAgain'));
        add(iconBtn(ICONS.x, T('removeTooltip', 'Remove'), 'remove', true));
        break;
    }
  }

  // ---------- static chrome wiring ----------
  $('clearDoneBtn').addEventListener('click', () => invoke('clearDone'));
  $('gearBtn').addEventListener('click', () => invoke('openSettingsWindow'));
  $('bannerDownloadBtn').addEventListener('click', () => invoke('openReleasePage'));
  $('bannerDismissBtn').addEventListener('click', () => invoke('dismissBanner'));
  $('browseBtn').addEventListener('click', (e) => { e.stopPropagation(); invoke('browse'); });
  $('dropzone').addEventListener('click', () => invoke('browse'));
  $('cancelAllBtn').addEventListener('click', () => invoke('cancelAll'));
  $('runSetupBtn').addEventListener('click', () => invoke('runSetup'));
  $('checkAgainBtn').addEventListener('click', () => invoke('recheckDeps'));
  $('installBtn').addEventListener('click', () => {
    if (installClicked) {
      invoke('recheckDeps');
    } else {
      installClicked = true;
      $('installBtn').textContent = T('checkAgain', 'Check Again');
      invoke('runSetup');
    }
  });

  // ---------- link field ----------
  const linkField = $('linkField');
  const addBtn = $('addBtn');
  function syncAddEnabled() { addBtn.disabled = linkField.value.trim() === ''; }
  linkField.addEventListener('input', () => { $('linkError').hidden = true; syncAddEnabled(); });
  linkField.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLink(); });
  addBtn.addEventListener('click', submitLink);
  syncAddEnabled();

  function submitLink() {
    const text = linkField.value.trim();
    if (!text) return;
    api.invoke('linkFieldValidate', text).then((ok) => {
      if (ok) {
        invoke('addLink', text);
        linkField.value = '';
        syncAddEnabled();
        $('linkError').hidden = true;
      } else {
        $('linkError').hidden = false;
      }
    }).catch((err) => console.error('linkFieldValidate', err));
  }

  function focusLink() {
    if ($('linkArea').hidden) return;
    linkField.focus();
    linkField.select();   // a fresh paste replaces the old text instantly
  }
  api.onFocusLink(focusLink);

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    const inField = e.target instanceof HTMLInputElement;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); focusLink(); return; }
    if (inField) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
      const it = itemById(selectedId);
      if (it && !ACTIVE_STATES[it.state]) { e.preventDefault(); invoke('remove', selectedId); }
    } else if (mod && e.key === '.' && selectedId) {
      const it = itemById(selectedId);
      if (it && ACTIVE_STATES[it.state]) { e.preventDefault(); invoke('cancel', selectedId); }
    }
  });

  // Cmd/Ctrl+V with the list focused pastes a clipboard URL straight in.
  document.addEventListener('paste', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const text = (e.clipboardData.getData('text/plain') || '').trim();
    if (text && looksLikeWebLink(text)) invoke('addLink', text);
  });

  // ---------- quick settings ----------
  $('langBtn').addEventListener('click', () => {
    if (!snapshot) return;
    TranscribePopover.openLanguagePopover({
      anchor: $('langBtn'),
      languages: snapshot.languages,
      selected: snapshot.settings.language,
      onPick: (code) => invoke('setSetting', { key: 'language', value: code })
    });
  });
  $('modelBtn').addEventListener('click', () => {
    if (!snapshot) return;
    TranscribePopover.openMenu({
      anchor: $('modelBtn'),
      items: snapshot.catalog.map((m) => ({
        label: m.menuTitle + (m.present ? '' : ' — not downloaded'),
        onClick: () => invoke('setSetting', { key: 'model', value: m.sel })
      }))
    });
  });

  // ---------- drag & drop (files AND dragged text/URLs) ----------
  let dragDepth = 0;
  const overlay = $('dropOverlay');

  function dragHasPayload(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
  }
  function showOverlay(show) {
    if (show) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('show'));
    } else {
      overlay.classList.remove('show');
      overlay.hidden = true;
    }
  }
  window.addEventListener('dragenter', (e) => {
    if (!dragHasPayload(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) showOverlay(true);
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showOverlay(false);
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    showOverlay(false);
    if (!snapshot || snapshot.phase !== 'ready') return;
    const dt = e.dataTransfer;
    if (dt.files && dt.files.length) {
      const paths = Array.from(dt.files).map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) invoke('addFiles', paths);
      return;
    }
    const raw = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    const line = raw.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
    if (line && looksLikeWebLink(line)) invoke('addLink', line.trim());
  });

  // ---------- state feed ----------
  api.onState((s) => {
    snapshot = s;
    render();
  });
})();
