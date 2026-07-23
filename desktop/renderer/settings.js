// settings.js — settings window renderer. Same dumb-renderer contract as the
// main window: everything displayed comes from the C4 snapshot; every control
// fires setSetting/chooseDownloadFolder and waits for the next snapshot.
(function () {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);

  // C7: only the setup-tool name is platform-aware; the sentence is otherwise verbatim.
  const SETUP_NAME = navigator.platform.indexOf('Mac') !== -1 ? 'setup.command' : 'Transcribe Setup';
  const MODEL_MISSING_TIP = "This model isn't downloaded — run " + SETUP_NAME + '.';

  const WARN_SVG = '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M10.28 3.9 2.33 17.66a2 2 0 0 0 1.73 3.04h15.88a2 2 0 0 0 1.73-3.04L13.72 3.9a2 2 0 0 0-3.44 0Z" fill="var(--color-warning)"/><path d="M12 9v5" stroke="var(--color-on-warning)" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.1" r="1.15" fill="var(--color-on-warning)"/></svg>';

  let snapshot = null;

  const invoke = (cmd, payload) =>
    api.invoke(cmd, payload).catch((err) => console.error(cmd, err));

  function render() {
    if (!snapshot) return;
    const s = snapshot;

    renderModels(s);

    const lang = s.languages.find((l) => l.code === s.settings.language);
    $('langName').textContent = lang ? lang.name
      : (s.settings.language === 'auto' ? 'Auto-detect' : s.settings.language);

    setSwitch($('keepVideoSwitch'), !!s.settings.keepVideo);
    setSwitch($('notifySwitch'), !!s.settings.notifyOnFinish);

    $('folderName').textContent = s.settings.downloadFolderDisplay || '';
    $('folderIcon').title = s.settings.downloadFolder || '';
    $('folderName').title = s.settings.downloadFolder || '';
  }

  function renderModels(s) {
    const list = $('modelList');
    list.textContent = '';
    s.catalog.forEach((m) => {
      const opt = document.createElement('button');
      opt.className = 'opt';
      opt.type = 'button';
      const on = m.sel === s.settings.model;
      const radio = document.createElement('span');
      radio.className = 'radio' + (on ? ' on' : '');
      const txt = document.createElement('span');
      txt.className = 'txt';
      const b = document.createElement('b');
      b.textContent = m.display + ' (' + m.technical + ')';
      if (!m.present) {
        const warn = document.createElement('span');
        warn.innerHTML = WARN_SVG;
        warn.title = MODEL_MISSING_TIP;
        warn.style.display = 'inline-flex';
        b.appendChild(warn);
      }
      const small = document.createElement('small');
      small.textContent = m.caption;
      txt.appendChild(b);
      txt.appendChild(small);
      opt.appendChild(radio);
      opt.appendChild(txt);
      opt.addEventListener('click', () => invoke('setSetting', { key: 'model', value: m.sel }));
      list.appendChild(opt);
    });
  }

  function setSwitch(el, on) {
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  $('keepVideoSwitch').addEventListener('click', () => {
    if (snapshot) invoke('setSetting', { key: 'keepVideo', value: !snapshot.settings.keepVideo });
  });
  $('notifySwitch').addEventListener('click', () => {
    if (snapshot) invoke('setSetting', { key: 'notifyOnFinish', value: !snapshot.settings.notifyOnFinish });
  });
  $('chooseFolderBtn').addEventListener('click', () => invoke('chooseDownloadFolder'));

  $('langBtn').addEventListener('click', () => {
    if (!snapshot) return;
    TranscribePopover.openLanguagePopover({
      anchor: $('langBtn'),
      languages: snapshot.languages,
      selected: snapshot.settings.language,
      onPick: (code) => invoke('setSetting', { key: 'language', value: code })
    });
  });

  api.onState((s) => {
    snapshot = s;
    render();
  });
})();
