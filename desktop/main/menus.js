// main/menus.js — app menu (C6 accelerators pinned: CmdOrCtrl+O/L/comma/
// period/0) and per-row context menus (Menu.popup). Labels come from
// shared/copy.js; the few pure-chrome labels (Settings…, Edit/Window roles)
// are Electron role strings.
'use strict';

function installAppMenu({ Menu, app, copy, actions }) {
  const isMac = process.platform === 'darwin';
  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => actions.openSettings(),
  };

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: copy.addFilesMenu, accelerator: 'CmdOrCtrl+O', click: () => actions.addFiles() },
        { label: copy.addLinkMenu, accelerator: 'CmdOrCtrl+L', click: () => actions.focusLink() },
        { type: 'separator' },
        { label: copy.connectInstagramMenu, click: () => actions.connectInstagram() },
        { label: copy.disconnectInstagramMenu, click: () => actions.disconnectInstagram() },
        { type: 'separator' },
        { label: copy.cancelItemMenu, accelerator: 'CmdOrCtrl+.', click: () => actions.cancelSelected() },
        ...(isMac ? [] : [
          { type: 'separator' },
          settingsItem,
          { type: 'separator' },
          { role: 'quit' },
        ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: copy.windowTitle, accelerator: 'CmdOrCtrl+0', click: () => actions.showWindow() },
        ...(isMac ? [{ role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Context menu mirrors each state's action set (two paths to every action) —
// port of QueueRow.contextItems.
function rowMenuTemplate({ state, copy, actions }) {
  switch (state) {
    case 'waiting':
      return [{ label: copy.removeFromList, click: () => actions.remove() }];
    case 'lookingUp':
    case 'downloading':
    case 'preparing':
    case 'transcribing':
      return [{ label: copy.cancelTooltip, click: () => actions.cancel() }];
    case 'done':
      return [
        { label: copy.openTranscript, click: () => actions.openTranscript() },
        { label: copy.openSubtitles, click: () => actions.openSubtitles() },
        { label: copy.showInFinder, click: () => actions.showInFinder() },
        { label: copy.copyTranscript, click: () => actions.copyTranscript() },
        { label: copy.transcribeAgain, click: () => actions.transcribeAgain() },
        { type: 'separator' },
        { label: copy.removeFromList, click: () => actions.remove() },
      ];
    case 'failed':
      return [
        { label: copy.retry, click: () => actions.retry() },
        { label: copy.copyErrorDetails, click: () => actions.copyErrorDetails() },
        { label: copy.removeFromList, click: () => actions.remove() },
      ];
    case 'canceled':
      return [
        { label: copy.startAgain, click: () => actions.startAgain() },
        { label: copy.removeFromList, click: () => actions.remove() },
      ];
    default:
      return [];
  }
}

function popupRowMenu({ Menu, window, x, y, state, copy, actions }) {
  const template = rowMenuTemplate({ state, copy, actions });
  if (!template.length) return;
  const menu = Menu.buildFromTemplate(template);
  const opts = {};
  if (window) opts.window = window;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    opts.x = Math.round(x);
    opts.y = Math.round(y);
  }
  menu.popup(opts);
}

module.exports = { installAppMenu, popupRowMenu };
