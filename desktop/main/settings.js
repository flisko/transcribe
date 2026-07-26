// main/settings.js — JSON persistence at userData/settings.json (main.js
// passes the path; tests pass a temp file). Defaults mirror AppModel.swift's
// registered defaults. A corrupt or missing file yields defaults — never a
// crash: losing preferences beats losing the app.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createSettings({ file, downloadsDir } = {}) {
  const defaults = {
    model: 'best',
    language: 'hr',
    keepVideo: false,
    downloadFolder: downloadsDir || path.join(os.homedir(), 'Downloads'),
    notifyOnFinish: true,
    // The launch-time update CHECK (the banner). Nothing is ever installed
    // automatically — see Copy.settingsAutoCheckCaption.
    autoCheckUpdates: true,
  };

  let data = { ...defaults };
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = { ...defaults, ...parsed };
      }
    } catch { /* absent or corrupt -> defaults */ }
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* a read-only disk must not take the queue down */ }
  }

  return {
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaults[key];
    },
    set(key, value) {
      data[key] = value;
      persist();
    },
    all() { return { ...data }; },
    // Falls back to the downloads dir (and repairs the setting) if the stored
    // folder vanished.
    downloadFolder() {
      const fallback = defaults.downloadFolder;
      const stored = typeof data.downloadFolder === 'string' && data.downloadFolder
        ? data.downloadFolder : fallback;
      try {
        if (fs.statSync(stored).isDirectory()) return stored;
      } catch { }
      if (data.downloadFolder !== fallback) {
        data.downloadFolder = fallback;
        persist();
      }
      return fallback;
    },
  };
}

module.exports = { createSettings };
