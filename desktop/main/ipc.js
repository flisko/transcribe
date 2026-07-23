// main/ipc.js — the renderer->main command surface (C4). One invoke channel
// ('cmd'); payloads are normalized defensively (id commands accept either the
// bare id string or {id}). Everything renderer-visible flows through the queue
// so every mutation broadcasts a fresh snapshot.
'use strict';

const SETTING_KEYS = ['model', 'language', 'keepVideo', 'downloadFolder', 'notifyOnFinish'];

// Row actions the e2e suite may dispatch directly through rowMenu (a native
// popup cannot be clicked by Playwright). Only active with TRANSCRIBE_TEST_LOG.
const ROW_ACTIONS = ['openTranscript', 'openSubtitles', 'showInFinder', 'copyTranscript',
                     'copyErrorDetails', 'transcribeAgain', 'retry', 'startAgain',
                     'cancel', 'remove'];

function idOf(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload.id === 'string') return payload.id;
  return null;
}

function registerIpc({ ipcMain, queue, settings, catalog, languages, actions }) {
  ipcMain.handle('cmd', (_event, cmd, payload) => {
    switch (cmd) {
      case 'addFiles': {
        const paths = Array.isArray(payload) ? payload
          : (payload && Array.isArray(payload.paths) ? payload.paths : []);
        queue.addFiles(paths.filter((p) => typeof p === 'string'));
        return;
      }
      case 'addLink':
        return queue.addLink(typeof payload === 'string' ? payload : payload && payload.text);
      case 'linkFieldValidate':
        return queue.linkValid(typeof payload === 'string' ? payload : payload && payload.text);
      case 'browse':
        return actions.browse();
      case 'cancel': return queue.cancel(idOf(payload));
      case 'cancelAll': return queue.cancelAll();
      case 'retry': return queue.retry(idOf(payload));
      case 'remove': return queue.remove(idOf(payload));
      case 'startAgain': return queue.startAgain(idOf(payload));
      case 'transcribeAgain': return queue.transcribeAgain(idOf(payload));
      case 'openTranscript': return queue.openTranscript(idOf(payload));
      case 'openSubtitles': return queue.openSubtitles(idOf(payload));
      case 'showInFinder': return queue.showInFinder(idOf(payload));
      case 'copyTranscript': return queue.copyTranscript(idOf(payload));
      case 'copyErrorDetails': return queue.copyErrorDetails(idOf(payload));
      case 'clearDone': return queue.clearDone();
      case 'select': return queue.select(idOf(payload));
      case 'setSetting': {
        const key = payload && payload.key;
        let value = payload && payload.value;
        if (!SETTING_KEYS.includes(key)) return false;
        if (key === 'model' && !catalog.all.some((m) => m.sel === value)) return false;
        if (key === 'language' && !languages.isValid(value)) return false;
        if (key === 'keepVideo' || key === 'notifyOnFinish') value = !!value;
        if (key === 'downloadFolder' && (typeof value !== 'string' || !value)) return false;
        settings.set(key, value);
        queue.refresh();
        return true;
      }
      case 'chooseDownloadFolder': return actions.chooseDownloadFolder();
      case 'runSetup': return actions.runSetup();
      case 'recheckDeps': return queue.probeDeps();
      case 'openReleasePage': return actions.openReleasePage();
      case 'dismissBanner': return queue.dismissBanner();
      case 'rowMenu': {
        const id = idOf(payload);
        if (id == null) return;
        const action = payload && payload.action;
        if (action && process.env.TRANSCRIBE_TEST_LOG && ROW_ACTIONS.includes(action)) {
          return queue[action](id);   // e2e shim — see ROW_ACTIONS
        }
        return actions.rowMenu({ id, x: payload.x, y: payload.y });
      }
      case 'openSettingsWindow': return actions.openSettingsWindow();
      default:
        return;   // unknown commands are ignored, never a throw across IPC
    }
  });
}

module.exports = { registerIpc };
