# Transcribe DS — design-system source

This directory is the design source of truth for **Transcribe**, the native macOS app
(local whisper.cpp transcription of files and video links). It is authored as a
[claude.ai/design](https://claude.ai/design) design-system project: every HTML file in
`cards/` renders as one preview card, grouped by its first-line marker comment
(`<!-- @dsCard group="…" -->`).

## Contents

```
design/
├── tokens.css        # canonical token source — ALL colors, type, spacing, radii, shadows
├── cards/
│   ├── brand.html          Brand       — icon, gradient, accent do/don't
│   ├── colors.html         Foundations — semantic colors, light + dark side by side
│   ├── typography.html     Foundations — type scale with usage
│   ├── spacing.html        Foundations — 4px grid, radii, elevation, fixed sizes
│   ├── buttons.html        Components  — prominent / bordered / borderless, states
│   ├── dropzone.html       Components  — idle + drag-targeted overlay
│   ├── link-input.html     Components  — normal / invalid / links-limited
│   ├── queue-rows.html     Components  — all 8 row states
│   ├── progress.html       Components  — bar anatomy, ETA rules, footer lines
│   ├── update-banner.html  Components  — "Version 1.0.42 is available."
│   ├── empty-state.html    Screens     — "Ready to transcribe"
│   ├── setup.html          Screens     — one-time setup checklist
│   ├── settings.html       Screens     — the Settings pane
│   └── main-window.html    Screens     — hero: full main-window composition
└── README.md
```

Cards are self-contained except for one relative link: `<link rel="stylesheet"
href="../tokens.css">`. No colors are hardcoded in cards — everything paints through
`var(--…)` tokens, so a token edit re-themes every card. Each card renders correctly in
light and dark (system `prefers-color-scheme`, or force with `data-theme="dark" |
"light"` on any element — `colors.html` uses that to show both themes at once).

## Token → SwiftUI mapping

The app (the Swift sources in `app/`) implements this language natively. The full
mapping lives in the comment header of `tokens.css`; the short version:

| Token | SwiftUI |
| --- | --- |
| `--color-accent` `#6E45E2` | `Color(red: 0.431, green: 0.271, blue: 0.886)` — app-wide `.tint` |
| `--color-grad-start/end` | `#5C33C7` / `#8C57F2` — app icon only, never UI chrome |
| `--color-success/destructive/warning` | `.systemGreen` / `.systemRed` / `.systemOrange` |
| `--color-window-bg`, `--color-content-bg` | `.windowBackgroundColor`, `.controlBackgroundColor` |
| `--color-label` … `--color-quaternary-label` | `Color.primary`, `.secondary`, `.tertiaryLabelColor`, `.quaternaryLabelColor` |
| `--color-separator` | `.separatorColor` |
| `--space-*` (4px grid) | `.padding(16)` == `--space-4`, etc. |
| `--radius-card` 10 / `--radius-button` 6 / capsule | `RoundedRectangle(cornerRadius: 10/6)`, `Capsule()` progress (4pt tall) |
| Type scale 20/15/13/12/11 | `.title2` / `.title3` / `.body` / `.callout` / `.caption` |

Dark-mode values differ for most tokens (see the two dark blocks in `tokens.css`); on
the SwiftUI side the semantic NSColors adapt automatically — only the accent shades are
explicit.

## Re-syncing to claude.ai/design

The cards live in the **"Transcribe"** design project on claude.ai/design. To re-sync
after editing:

1. Edit tokens/cards here (keep the `@dsCard` marker as the exact first line of every
   card, and keep the two dark blocks in `tokens.css` in sync).
2. Ask Claude to push via DesignSync — for a fresh project: `create_project("Transcribe")
   → finalize_plan → write_files` with the contents of this directory; for an existing
   project, `write_files` the changed files only. Each HTML file becomes a preview card
   under its marker's group.
3. Sanity checks before pushing: every `var(--…)` referenced by a card is defined in
   `tokens.css`; every card starts with the marker line; cards render at 600–800px wide
   in both light and dark.

User-facing copy in the cards is verbatim from the UX spec (see
`docs/superpowers/specs/2026-07-23-transcribe-2-design.md`) — change it there first,
then here, then in `app/Copy.swift`.
