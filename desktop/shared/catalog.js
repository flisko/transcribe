// catalog.js — the six-model whisper catalog (port of Models in app/Logic.swift).
// minBytes is a plausibility floor: a smaller file means truncated/corrupt.
'use strict';

const Copy = require('./copy');

function model(sel, display, technical, fileName, minBytes, blurb, caption) {
  return {
    sel,        // engine selector, also the persisted settings value
    display,    // short human name shown in the quick-setting label
    technical,  // whisper.cpp model name, shown in (parentheses)
    fileName,   // GGML file under models/
    minBytes,
    blurb,      // one-line trade-off shown in the quick-settings menu
    caption,    // fuller sentence shown under the option in Settings
    menuTitle: `${display} (${technical}) — ${blurb}`,
  };
}

const all = [
  model('best', Copy.modelDisplayBest, 'large-v3', 'ggml-large-v3.bin', 2_500_000_000,
    'most accurate, slower (recommended)',
    'Most accurate for Croatian, Slovenian, and other smaller languages. Slower. Recommended.'),
  model('fast', Copy.modelDisplayFast, 'large-v3-turbo', 'ggml-large-v3-turbo.bin', 1_200_000_000,
    'about 4x faster, slightly less accurate',
    'About 4x faster. Slightly less accurate, mainly on smaller languages.'),
  model('medium', 'Medium', 'medium', 'ggml-medium.bin', 1_300_000_000,
    'lighter and quicker, still solid',
    'A good middle ground when the big models feel slow. Half the size of Fast.'),
  model('small', 'Small', 'small', 'ggml-small.bin', 400_000_000,
    'much faster, noticeably less accurate',
    'Much faster and much smaller. Fine for clear speech in major languages.'),
  model('base', 'Base', 'base', 'ggml-base.bin', 120_000_000,
    'very fast, rough transcripts',
    'Very fast rough drafts. Expect mistakes, especially outside English.'),
  model('tiny', 'Tiny', 'tiny', 'ggml-tiny.bin', 60_000_000,
    'fastest, lowest accuracy',
    'The fastest possible pass. Only for quick gist checks.'),
];

// Unknown selector -> Best, same as the engine.
function by(sel) {
  return all.find((m) => m.sel === sel) || all[0];
}

module.exports = { all, by };
