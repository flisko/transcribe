// Refreshes the renderer's tracked copy of the design tokens (npm run
// sync-tokens). design/tokens.css is the canonical source — edit it there,
// never in renderer/. The copy is the source verbatim behind a one-line
// "generated copy" banner, so anyone opening renderer/tokens.css knows not to
// edit it — and so re-running the script is a no-op instead of silently
// stripping that banner off the committed file.
'use strict';
const fs = require('fs');
const path = require('path');

const HEADER = Buffer.from('/* generated copy — run npm run sync-tokens */\r\n');

const src = path.resolve(__dirname, '..', '..', 'design', 'tokens.css');
const dest = path.resolve(__dirname, '..', 'renderer', 'tokens.css');

if (!fs.existsSync(src)) {
  console.error(`sync-tokens: source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
const data = Buffer.concat([HEADER, fs.readFileSync(src)]);
const unchanged = fs.existsSync(dest) && fs.readFileSync(dest).equals(data);
if (unchanged) {
  console.log(`sync-tokens: renderer/tokens.css already up to date`);
} else {
  fs.writeFileSync(dest, data);
  console.log(`sync-tokens: copied design/tokens.css -> renderer/tokens.css (${data.length} bytes)`);
}
