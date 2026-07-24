// main/instagram.js — in-app Instagram login + scoped cookie extraction so yt-dlp
// can fetch reels that Instagram gates behind a login.
//
// SECURITY (per the audit): the login runs in an ISOLATED persistent session
// partition with NO preload and sandbox:true, so the remote instagram.com page
// has no bridge to the app's IPC/command surface and no Node access. Only
// instagram.com cookies are ever read. The cookie CONTENT (never a stored file)
// is handed to the engine, which writes it to a per-user-private temp and deletes
// it after each yt-dlp call. The persisted login lives only in the encrypted
// Chromium partition (DPAPI at rest on Windows) until the user disconnects.
'use strict';

const IG_PARTITION = 'persist:transcribe-instagram';
const IG_LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const IG_DOMAINS = ['.instagram.com', 'instagram.com'];

// Electron cookie objects -> Netscape cookie file body (what yt-dlp --cookies reads).
// Pure + exported for tests.
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Instagram session captured by Transcribe (in-app login)'];
  for (const c of cookies || []) {
    const domain = String(c.domain || '');
    if (!domain || !c.name) continue;
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiry = c.session ? '0' : String(Math.floor(c.expirationDate || 0));
    // Tabs separate the 7 fields; strip any stray tab/newline from a value so one
    // malformed cookie can't corrupt the file or inject a line.
    const value = String(c.value == null ? '' : c.value).replace(/[\t\r\n]/g, '');
    lines.push([domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expiry, c.name, value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// Exported for tests + the queue's "is this an IG link" check.
function isInstagramUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch (_) { return false; }
}

// Bind the manager to an Electron session + BrowserWindow factory (injected so
// the module stays testable and Electron lives only in main.js).
function createInstagram({ session, BrowserWindow, getParent, hardenLoginWindow }) {
  const ses = session.fromPartition(IG_PARTITION);
  let loginWin = null;

  async function isConnected() {
    try {
      const s = await ses.cookies.get({ name: 'sessionid', domain: '.instagram.com' });
      return !!(s && s.length && s[0].value);
    } catch (_) { return false; }
  }

  async function scopedCookies() {
    const seen = new Map();
    for (const domain of IG_DOMAINS) {
      let arr = [];
      try { arr = await ses.cookies.get({ domain }); } catch (_) {}
      for (const c of arr) seen.set(c.name + '|' + c.domain + '|' + c.path, c);
    }
    return [...seen.values()];
  }

  // Netscape cookie content for a URL, or null (not an IG link / not connected).
  async function cookiesForUrl(url) {
    if (!isInstagramUrl(url) || !(await isConnected())) return null;
    const cookies = await scopedCookies();
    return cookies.length ? toNetscape(cookies) : null;
  }

  // Opens the login window; resolves once logged in (sessionid present) or the
  // window is closed. No preload, sandboxed, isolated partition.
  function login() {
    if (loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const parent = getParent && getParent();
      loginWin = new BrowserWindow({
        width: 460, height: 720, title: 'Log in to Instagram', autoHideMenuBar: true,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        webPreferences: {
          partition: IG_PARTITION,   // isolated, persistent, encrypted at rest
          sandbox: true,             // remote page fully sandboxed
          contextIsolation: true,
          nodeIntegration: false,
          // NO preload — instagram.com gets no window.api / IPC bridge.
        },
      });
      if (hardenLoginWindow) hardenLoginWindow(loginWin);
      loginWin.loadURL(IG_LOGIN_URL);
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearInterval(timer); resolve(); };
      const timer = setInterval(async () => {
        if (!loginWin || loginWin.isDestroyed()) { done(); return; }
        if (await isConnected()) { const w = loginWin; if (w && !w.isDestroyed()) w.close(); done(); }
      }, 1500);
      loginWin.on('closed', () => { loginWin = null; done(); });
    });
  }

  async function logout() {
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    try { await ses.clearStorageData(); } catch (_) {}
  }

  return { isConnected, cookiesForUrl, login, logout };
}

module.exports = { createInstagram, toNetscape, isInstagramUrl, IG_PARTITION, IG_LOGIN_URL };
