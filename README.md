# ESP Web Tool

Flash and monitor Espressif chips from your browser, in a full-screen terminal UI that feels like running a CLI tool through ttyd.

**Live:** https://kamranaghlami.github.io/esp_web_tool/ (Chrome, Edge or Opera on desktop; uses Web Serial)

> Status: **M0** — terminal UI shell, serial connect and a raw serial monitor. Flashing
> (esptool-js) arrives in M1; the flash pane currently shows an example plan and a
> simulated run. See [docs/SPEC.md](docs/SPEC.md) for the full design and milestones.

## Try it

- `c` connect a serial port, `Enter` on the Monitor pane to type to the device, `Ctrl-]` to leave
- `Ctrl-A` opens the monitor menu: `r` reset, `b` boot mode, `s` baud, `f` format (8N1…), `e` line ending
- No device at hand? Open the page with `?demo` for a synthetic log stream
- `?` shows every key

## Develop

Requires Node 24.

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Vitest)
npm run test:e2e     # browser tests (Playwright, fake serial port)
npm run lint && npm run typecheck && npm run format:check
```

`?renderer=dom` or `?renderer=webgl` forces xterm's renderer; by default WebGL is used only when it is GPU-backed.

## How it works

The page is a single xterm.js terminal. The app is a terminal program behind a small `Tty` interface: it draws into a cell buffer, diffs frames into ANSI, and parses keys and SGR mouse input from the terminal's input stream. The serial monitor is a headless xterm whose cells are blitted into its pane, like tmux. Details in [docs/SPEC.md §3](docs/SPEC.md#3-architecture).

## License

MIT
