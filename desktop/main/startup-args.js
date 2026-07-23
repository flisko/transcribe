// main/startup-args.js — pure helpers for turning a process argv into the list
// of files/URLs to open, and for resolving relative paths against the launching
// process's working directory.
//
// Isolated from main.js (which requires electron and so cannot run under plain
// `node --test`) so the arg-filtering and path-resolution logic can be unit
// tested. No electron, no side effects.
'use strict';

const path = require('node:path');

// Drop the leading exec-path (packaged: argv[0] is the .exe) or the exec-path +
// main script (dev: argv = [electron, main.js, ...operands]), then strip any
// Chromium/Electron switch (they start with '-'), leaving only the file/URL
// operands the user asked to open.
function filterStartupArgs(argv, opts = {}) {
  const list = Array.isArray(argv) ? argv : [];
  const start = opts.packaged ? 1 : 2;
  return list
    .slice(start)
    .filter((a) => typeof a === 'string' && a !== '' && !a.startsWith('-'));
}

// Resolve a single open operand. URLs pass through untouched (they are matched
// ^https?:// downstream and must never be path-resolved). Absolute paths pass
// through. A relative path is resolved against `workingDir` — for a
// second-instance launch that is the *second* process's cwd (Electron hands it
// to the second-instance handler), NOT this process's cwd.
function resolveOpenArg(arg, workingDir) {
  if (typeof arg !== 'string' || arg === '') return arg;
  if (/^https?:\/\//i.test(arg)) return arg;
  if (path.isAbsolute(arg)) return arg;
  const base = (typeof workingDir === 'string' && workingDir) ? workingDir : process.cwd();
  return path.resolve(base, arg);
}

module.exports = { filterStartupArgs, resolveOpenArg };
