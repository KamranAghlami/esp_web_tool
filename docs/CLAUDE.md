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

The app never touches the DOM except in `src/main.ts` (and, later, `src/browser/`). Gesture-gated browser calls (`requestPort`, file pickers) must run synchronously from input dispatch.

## Commands

`npm run dev` · `npm test` · `npm run test:e2e` · `npm run lint` · `npm run typecheck` · `npm run format:check`
