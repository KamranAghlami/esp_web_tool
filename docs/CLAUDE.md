# ESP Web Tool

Browser-based TUI (feels like a CLI running through ttyd) for flashing Espressif chips and monitoring their serial port, deployed to GitHub Pages.

- The spec is the source of truth: [docs/SPEC.md](SPEC.md). Update it when decisions change.
- Project memory lives in `docs/memory/` (index: `docs/memory/MEMORY.md`), not in `~/.claude`.

## Layout

- `src/tty/` — `Tty` interface, xterm binding, input parser (keys, SGR mouse, bracketed paste)
- `src/tui/` — cell `Screen`, diff `Renderer`, layout, widgets, theme. Widgets draw immediate-mode into a `Ctx` and register click regions in a `HitMap`
- `src/app/` — the program: panes, keymap, overlays
- `src/monitor/` — headless-xterm `TermPane` (blitted into the monitor pane), demo stream
- `src/serial/` — `PortManager`, the single owner of the `SerialPort`
- `src/flash/` — the flash plan: manifest parser + adapters, Manifest-field targets, GitHub releases, `FlashPlan` (rows, red rows, locks), checks (`validate.ts`), and `esp.ts`, the esptool-js session (lazy-loaded; `chip.ts` holds what doesn't need it). No DOM: it talks to the browser through `FileHost`
- `src/app/jobs.ts` — flasher jobs: borrow the port from `PortManager`, run one esptool session, give it back
- `tests/fake-esp.ts` — the simulated ESP32-S3 (ROM + stub over SLIP) used by unit and e2e tests; self-contained so its source can be injected into the page
- `src/browser/` — DOM-side implementations (`files.ts`: pickers, folder access, fetch, kept handles; `plan-store.ts`: IndexedDB)
- `src/app/settings.ts` — what is remembered in `localStorage`: last used, per USB device, layout

The app never touches the DOM except in `src/main.ts` and `src/browser/`. Gesture-gated browser calls (`requestPort`, file and folder pickers) must run synchronously from input dispatch.

## UI conventions (decided with the user; details in SPEC §4)

- Everything is drawn inside the terminal: no DOM overlays, no floating toasts. Messages replace the key hints in the bottom bar.
- Capital letters for actions that can't be undone (`F` flash, `E` erase, `Ctrl+A C` clear). `f` is fullscreen.
- Menus are pop-ups centered on the pane they belong to. Submenus have a `‹ Back` row, and Esc/Backspace go back (not ←).
- Every keyboard action also works with the mouse, and every view is tested at desktop size (phones later, §4.1).
- The app draws on the alternate screen (`?1049h`); without it, resizes leave stale lines.
- Settings are remembered: as last used, per USB vid:pid (manifest + monitor), and per browser for layout (pane, fullscreen). The flash plan (rows, picked file handles) is kept the same way in IndexedDB (`src/browser/plan-store.ts`).
- Dialogs (e.g. the part dialog) are centered on their pane: Tab moves, Enter saves, Esc cancels.

## Commands

`npm run dev` · `npm test` · `npm run test:e2e` · `npm run lint` · `npm run typecheck` · `npm run format:check`
