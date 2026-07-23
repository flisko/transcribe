// Refreshes the renderer's tracked copy of the design tokens (npm run
// sync-tokens). design/tokens.css is the canonical source — edit it there,
// never in renderer/. Byte-exact copy so the two files diff clean.
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', '..', 'design', 'tokens.css');
const dest = path.resolve(__dirname, '..', 'renderer', 'tokens.css');

if (!fs.existsSync(src)) {
  console.error(`sync-tokens: source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
const data = fs.readFileSync(src);
const unchanged = fs.existsSync(dest) && fs.readFileSync(dest).equals(data);
if (unchanged) {
  console.log(`sync-tokens: renderer/tokens.css already up to date`);
} else {
  fs.writeFileSync(dest, data);
  console.log(`sync-tokens: copied design/tokens.css -> renderer/tokens.css (${data.length} bytes)`);
}
