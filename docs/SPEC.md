# ESP Web Tool — Specification

Status: **Draft v0.2** (2026-10-18), M0 implemented — for iteration. Open questions are collected in §15.

## 1. Summary

A browser-based, full-screen, keyboard-driven **TUI** for Espressif chips that does two jobs:

1. **Flasher**: writes one or more binaries at given offsets. The user can either
   - pick local `.bin` files and offsets by hand, or
   - enter a public GitHub repo. The tool lists its releases, finds a manifest JSON in the chosen release that describes one or more *flash sets* (groups of binaries with offsets), and fills in the flash list from it.
2. **Serial monitor**: an ANSI-capable terminal attached to the same port, with reset/boot control.

It is a static site (no backend), built and deployed to **GitHub Pages** by **GitHub Actions**.

Repo: <https://github.com/KamranAghlami/esp_web_tool>
Deployed at: `https://kamranaghlami.github.io/esp_web_tool/`

### Goals
- One page, works offline after load, nothing to install.
- Keyboard first, but mouse works everywhere, and **touch works on supported Android phones** (§4.1).
- Flashing that is at least as reliable as `esptool.py write_flash` for common chips.
- A simple manifest format that firmware authors can generate in CI.

### Non-goals (v1)
- Private repos or authenticated GitHub access (a PAT may come later, see §15).
- eFuse burning, flash encryption, secure boot workflows.
- Non-Chromium browsers (Web Serial is Chromium only), and **all iOS/iPadOS browsers** (WebKit has neither Web Serial nor WebUSB). They get a clear "unsupported" screen that still lays out properly at phone size, and the demo stream (`?demo`) still works.

## 2. Platform constraints

| Constraint | Consequence |
|---|---|
| Web Serial API: Chrome/Edge/Opera desktop; Chrome on Android only partly (see §4.1) | Detect `navigator.serial`; on Android without it, fall back to WebUSB + `web-serial-polyfill`; with neither, show the unsupported screen. |
| Secure context required | GitHub Pages is HTTPS, and `localhost` works in dev. |
| `requestPort()` and `<input type=file>` need a user gesture | A key press counts as one. Run these calls directly from the key or click handler, never after an `await`. |
| Ports granted before are available through `getPorts()` without a gesture | Used to reconnect after a native-USB chip re-enumerates on reset (§9). |
| **GitHub release asset downloads have no CORS headers** (checked 2026-10-17, see below) | The browser can *list* releases but cannot *download* release assets. This is the main design problem. See §7.4. |

**CORS check (2026-10-17):**
- `api.github.com/repos/{o}/{r}/releases` → `access-control-allow-origin: *` ✅
- `github.com/{o}/{r}/releases/download/...` → 302 to `release-assets.githubusercontent.com`, and that response has **no** ACAO header ❌ (preflight returns 405)
- `api.github.com/.../releases/assets/{id}` with `Accept: application/octet-stream` → 302 to the same host ❌
- `raw.githubusercontent.com` → `*` ✅
- `*.github.io` (Pages) → `*` ✅

## 3. Architecture

### Stack
- **Vite + TypeScript** (strict). Static build output.
- **@xterm/xterm** (6.x): the only thing on the page. Addons: `fit`, `webgl` (falls back to the DOM renderer), `unicode11`, `web-links`.
- **@xterm/headless**: a virtual terminal behind the monitor pane (see below).
- **esptool-js** (Espressif, currently 0.7.x): bootloader protocol, chip detection, compressed writes, MD5 verify, reset strategies.
- **No UI framework.** A small TUI layer of our own, in TS (`src/tui/`).
- **Vitest** for unit tests, **Playwright** for UI tests against a fake `navigator.serial`.
- ESLint + Prettier.

### Rendering approach: a real TUI program in a browser terminal (decided)
Target feel: **running a CLI tool through ttyd**. The page is one full-window xterm.js terminal with no HTML chrome. The app is a terminal program that only talks to it the way a CLI talks to a TTY.

```
 ┌──────────── browser page ────────────┐
 │  xterm.js (fills the window)         │
 │     ▲ ANSI bytes        │ input bytes│   onData: keys, mouse (SGR 1006), paste
 │     │                   ▼            │
 │  ┌─ Tty interface ────────────────┐  │   write(), onData(), onResize(), cols, rows
 │  │  App (our "CLI program")       │  │
 │  │   state → render(Screen)       │  │
 │  │   Screen: cell buffer          │  │
 │  │   diff vs last frame → ANSI    │  │
 │  │   ┌ Monitor pane ───────────┐  │  │
 │  │   │ @xterm/headless ◀ serial │  │  │   device bytes are parsed by a real emulator,
 │  │   │ blit cells → Screen     │  │  │   then copied into our buffer (as tmux does)
 │  │   └─────────────────────────┘  │  │
 │  └────────────────────────────────┘  │
 └──────────────────────────────────────┘
```

- **The app only sees a `Tty`.** It writes ANSI and reads raw input byte sequences, exactly like a program reading stdin. It never touches the DOM, except for a thin `browser/` module for things only a browser can do (§3.1).
  - Side effect: the same core could later run in a real terminal under Node (a different `Tty` + serial backend). This is not a v1 goal, but the design should not rule it out.
- **Rendering**: immediate mode. On each state change (batched per animation frame), widgets draw into a `Screen` cell grid (char, fg, bg, attrs, width). That grid is diffed against the previous frame, and only changed runs are emitted (cursor moves + SGR). Uses the alternate screen and a hidden cursor, except when editing text.
- **Input**: one parser for xterm's `onData` stream: CSI/SS3 keys, Alt as an ESC prefix, bracketed paste (`?2004`), SGR mouse (`?1000;1006`: click, wheel, drag). Keys and mouse reach the app as a terminal app would get them, which is what makes it feel real.
- **Layout**: nested horizontal/vertical splits with fixed/flex sizes, recomputed on resize. Three size classes: **wide** (≥ 120 cols, split panes), **normal** (≥ 80×24, one pane at a time) and **compact** (≥ 40×14, phones; §4.1). Only below 40×14 show a "terminal too small" notice, as real TUIs do (since M2b; M0 had 80×24, which is why an iPhone 14 Pro showed the notice).
- **Widgets** (`src/tui/`): Box (title in border), Text, List, Table, TextInput, Select (popup list), Checkbox/Radio, ProgressBar, Dialog/Confirm, StatusBar, KeyBar (which also shows messages), ScrollView, TermPane (the headless blit).
- **Monitor pane = a terminal inside the terminal.** Device bytes go into an `@xterm/headless` instance sized to the pane. That instance parses ANSI, cursor moves and clears just like a real terminal. Each frame we copy its visible buffer cells (`IBufferCell` gives char, colors, attributes) into the pane region. **Fullscreen** (`f`) makes the focused pane fill the window. We still blit rather than pass bytes straight through, so the key bar and status line stay.
- **Width**: use the `unicode11` addon, and use the same width table in `Screen`, so our layout and xterm agree. The UI's own strings use no emoji or ambiguous-width glyphs. Box drawing, block elements and `●▶✓✗` are fine.
- **Look**: page background = terminal background, no margins, terminal-style window title (we write OSC 0/2 and mirror it to `document.title`). Font: self-hosted monospace with full box-drawing coverage (JetBrains Mono or Iosevka). xterm's `customGlyphs` draws box and block characters pixel-perfect.
- **Text selection**: as in terminals: with mouse reporting on, **Shift+drag** selects. `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste.

*Alternatives considered:* **Ink** (React for CLIs): needs Node stream shims and a Yoga WASM layout engine, has weak mouse support, and offers no way to embed a terminal inside a pane. **blessed / terminal-kit**: Node only, unmaintained. **Ratatui → WASM**: a great toolkit, but it would move the app to Rust while flashing stays in esptool-js, so we would maintain a JS↔WASM bridge for every serial byte. **DOM character grid** (the previous draft): easier, but it never quite feels like a terminal (selection, cursor, font metrics), which is the whole point.

### 3.1 Browser-only bridges
A few things cannot go through a TTY. They live in `src/browser/` and are called from the app through a small interface:
- **`requestPort()` and the file picker need a user gesture.** xterm emits `onData` synchronously inside the DOM `keydown`/`mousedown` handler, so the gesture is still active. The rule: an action that needs a gesture is called *synchronously* from the input dispatch, with no `await` and no deferral to the next frame. **Check this in the M0 spike.**
- **Files**: (1) drag and drop onto the terminal (a DOM listener on the container; the TUI shows a "drop to add" overlay); (2) the native file picker (breaks the illusion for a moment, but is acceptable); (3) **best option**: `showDirectoryPicker()` (File System Access API) grants a folder once, e.g. an IDF `build/`. After that, a **TUI file browser** navigates it with no native dialogs. The permission can be kept in IndexedDB.
- **Downloads** (save log, export manifest): a Blob + temporary `<a download>`.
- **Links**: OSC 8 hyperlinks (release pages, manual-assist downloads) are opened by xterm's link handler.
- **Unsupported browser**: if `navigator.serial` is missing, the TUI still starts and shows a full-screen notice inside the terminal.

### Module layout
```
src/
  tty/            Tty interface, XtermTty (browser), input parser (keys/mouse/paste)
  tui/            Screen buffer + diff renderer, layout, widgets, focus, theme (ANSI palette)
  browser/        gesture-bound bridges: port picker, files/dir access, downloads
  app/            the program: views (Flash, Monitor, Help), keymap, app state
  serial/         PortManager (single owner of the SerialPort, state machine §9)
  flasher/        FlashJob: wraps esptool-js, validation, progress events
  monitor/        headless terminal per session, line endings, timestamps, log capture
  sources/
    manual.ts     local files → FlashPlan
    github.ts     URL parsing, releases API, caching, rate-limit handling
    manifest.ts   parse/validate our schema + adapters (esp-web-tools, flasher_args.json)
    fetcher.ts    asset download strategy (direct → proxy → manual assist) §7.4
  model/          FlashPlan, FlashPart, ChipInfo types
public/
  schema/v1.json  JSON Schema for the manifest (published on Pages)
proxy/            optional Cloudflare Worker (§7.4)
```

The core type that every source produces and the flasher consumes:
```ts
interface FlashPlan {
  label: string;                 // "my-fw v1.2.0 — ESP32-S3 8MB"
  chip?: ChipFamily;             // expected chip; mismatch → warning/confirm
  parts: { offset: number; name: string; data: Uint8Array; sha256?: string }[];
  flash: { mode?: 'qio'|'qout'|'dio'|'dout'|'keep'; freq?: string|'keep'; size?: string|'keep'|'detect' };
  eraseAll: boolean;
  baudrate: number;              // flashing baud, default 921600
  monitorBaudrate?: number;      // used after flashing, default 115200
}
```

## 4. UI

### Layout (wide screen ≥ 120 cols)
```
┌─ ESP Web Tool ──────────────────────────────────────────────────────────── v0.1.0 · a1b2c3d ─┐
│ PORT ● CP2102N (10c4:ea60)   CHIP ESP32-S3 (QFN56) rev v0.2   FLASH 8MB   MAC 34:85:18:aa:bb:cc │
├─ Flash ─────────────────────────────────────────┬─ Monitor ── 115200 8N1 ── LF ── ts:off ──────┤
│ Manifest [KamranAghlami/my-fw          ] Open…  │ I (312) cpu_start: Starting scheduler.      │
│ Release   v1.2.0 ▾   Set  ESP32-S3 8MB (chip ✓) ▾ │ I (318) main: hello world                   │
│ My Firmware 1.2.0 · 3 sets                      │ W (402) wifi: no AP configured              │
│ ┌ Parts ─────────────────────────────────────┐  │                                              │
│ │ [x] 0x000000  bootloader.bin      21.3 KiB │  │                                              │
│ │ [x] 0x008000  partition-table.bin  3.0 KiB │  │                                              │
│ │ [x] 0x010000  my-fw.bin            1.2 MiB │  │                                              │
│ │ [x] 0x110000  storage.bin   not found (404)│  │  ← red: blocks F                             │
│ │ + add part                                 │  │                                              │
│ └────────────────────────────────────────────┘  │                                              │
│ Baud [921600▾] Erase all [ ] Verify [x] Reset after [x]                                       │
│ my-fw.bin   ███████████████▌               52%  612 KiB/s                                     │
├─────────────────────────────────────────────────┴──────────────────────────────────────────────┤
│ c Connect  F Flash  E Erase  1/2 Pane  f Fullscreen  ^A Monitor menu  ^] Leave monitor  ? Help  │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Narrow screens (< 120 cols)
Flash and Monitor become full-screen views; `1` / `2` switches between them. The status line and key bar stay.

### 4.1 Phones (compact layout, touch, soft keyboard)

Feedback from M0: on an iPhone 14 Pro the app shows "terminal too small". Phones are a target for Android, so every view must also work in the compact class. **Rule from M1 on: every new view is designed and e2e-tested at 48×40 as well as at desktop size**, even before the rest of M2b lands.

**Which phones can actually connect** (checked 2026-10-17):
- **Android, Chrome ≥ M149 on devices with the Android Serial API**: native Web Serial for wired ports, rolling out from 2026 Q2 on "a limited set of devices" (blink-dev PSA, Feb 2026). Bluetooth RFCOMM serial is also partly supported. Any USB-serial chip the OS supports should work.
- **Other Android + Chrome**: WebUSB with Google's `web-serial-polyfill`, the path esptool-js documents. **Only USB CDC-ACM devices work**: chips using their own USB port (ESP32-S2/S3/C3/C6/H2/P4 USB-Serial/JTAG or TinyUSB CDC), and CDC-class bridges such as CH9102/CH343. **CP210x, CH340 and FTDI bridges do not work** (vendor-specific protocols), so the UI must say so plainly instead of failing at connect.
- **iPhone/iPad**: no path. Show the unsupported notice, laid out for the compact class.
- All Android phones need USB-OTG (a USB-C cable or adapter). Phones power the board from the port, so mention that power-hungry boards may brown out.

**Sizing**: phones get a slightly smaller font (13px instead of 14px) chosen so portrait gives at least 44 cols (iPhone 14 Pro / Pixel 7: about 48×40; landscape about 100×20 with the keyboard closed). Pinch-zoom is disabled on the page; font size is set in Settings instead (`Ctrl -`/`+` doesn't exist on phones).

**Compact layout (40–79 cols)**: one pane at a time, as in "normal", plus:
- The status line shrinks to icons and short values (`● 303a:1001 115200 · ESP32-S3`); details go to an info overlay.
- Tables drop columns by priority: the parts table keeps `[x] offset name`, and size moves to the detail line of the selected row.
- Dialogs take the full width; the help overlay becomes a full-screen scrolling view.
- No box-in-box nesting deeper than one level, so borders don't eat 4–6 of 48 columns.

**Touch** (xterm.js has little touch support, so the app handles it):
- A `touch/` bridge in `src/browser/` turns touch events on the terminal element into the same input events as the mouse: tap → click at the cell, vertical swipe → wheel (with momentum), long press → open a context menu for the item under the finger (the touch version of a right-click).
- **Tap targets**: interactive rows and key-bar entries are at least one full row tall and padded with a space on each side; nothing needs a precise single-cell tap.
- Text selection: a "Select" mode in the monitor menu switches off mouse reporting so xterm's own selection works, then "Copy" copies.

**Extra-keys bar (Termux style)**: in the compact class, and whenever a touch device is detected, the bottom two rows of the TUI become an on-screen key row drawn inside the terminal: `Esc  Tab  Ctrl  ↑ ↓ ← →  ^A  ^]  ⌨`. `Ctrl` is sticky (it applies to the next key from the soft keyboard), and `⌨` shows or hides the soft keyboard. This keeps the CLI feel and makes the monitor's `Ctrl+A` / `Ctrl+]` usable without a hardware keyboard.

**Soft keyboard**:
- It only opens when it's needed: when a text field or the live monitor gets focus (the app focuses or blurs xterm's hidden textarea). Otherwise taps must not bring it up.
- On `visualViewport` resize the app refits, so the TUI sits above the keyboard instead of under it, and the focused field stays visible.
- xterm's textarea gets `autocomplete/autocorrect/autocapitalize="off"` and `spellcheck=false`. Gboard composition (predictive text) must still produce sane input; test it on a real phone, because this is a known weak spot of xterm.js on Android.

**As built (M2b, 2026-10-19)**, not yet tried on a real phone:
- **Compact** below 80 columns: the status line is `● 303a:1001 115200 · ESP32-S3`; the key bar keeps `c F ⏎ ? a e f`; the Flash pane drops the field label, wraps its options onto two rows, and shows sizes only on the selected row (errors always); help stacks each key over its description. Below 120 columns both pane names show as tabs (`1 Flash ─ 2 Monitor`), and a tap or click on one switches to it.
- **Touch** (`src/browser/touch.ts`): a tap is a click at the cell, a vertical swipe is the wheel, with momentum after a fling. Touches don't focus xterm's textarea, so a tap never brings the keyboard up. Long press and the monitor's Select mode are still to do.
- **Extra-keys bar** on touch devices (`pointer: coarse`, or `?touch=1`): `Esc Tab Ctrl ← ↓ ↑ → ^A ^] kbd A- A+`. `Ctrl` is sticky for the next typed key; `kbd` shows or hides the soft keyboard; `A-`/`A+` change the font.
- **Soft keyboard**: it is asked for whenever text is wanted (a text field, a dialog's field, the live monitor) and put away otherwise. The page follows `visualViewport`, so the TUI sits above it. The textarea has autocomplete, autocorrect, autocapitalize and spellcheck off.
- **Font**: 13px on phones, 14px elsewhere; `-` / `+` (or `A-` / `A+`) change it, remembered per browser. Pinch-zoom is off (`user-scalable=no`).
- **WebUSB fallback** (`src/browser/usb-serial.ts`) when there is no Web Serial: CDC-ACM devices through `web-serial-polyfill` (native-USB ESP32s, CH9102/CH343), and **CH340 through esptool-js's `WebUSBSerialPort`**, which the 2026-10-17 check didn't know about. CP210x and FTDI are refused with a message saying why. Without either API (iPhone, iPad): `✗ no Web Serial or WebUSB here`, and `?demo` still works.
- Tested at the Pixel 7 size in Playwright (`tests/e2e/phone.spec.ts`): the compact layout, tapping tabs and key-bar entries (a tap is a user gesture, so `requestPort` works), the extra keys, the stacked help.

**Installable (later)**: a web app manifest + service worker lets the app be "installed" so it opens full screen without the URL bar, which suits the terminal feel and also gives offline use (Goal 1).

### Keyboard
A browser tab is a hostile terminal. Chrome **does not let pages intercept** `Ctrl+T`, `Ctrl+W`, `Ctrl+N`, `Ctrl+Tab` or `Ctrl+Shift+T/W/N`. `Alt+digit` and `Ctrl+digit` switch browser tabs, and F5/F11/F12 are unreliable. So we use the lazygit/htop model: **single-key hotkeys** whenever no text input or monitor has focus, plus a **prefix key** inside the monitor. The prefix is `Ctrl+A`, as in picocom/minicom/screen; `idf.py monitor`'s `Ctrl+T` cannot be caught in a browser.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle focus between widgets; `1` / `2` jump to the Flash / Monitor pane |
| Arrows, `j`/`k`, `PgUp`/`PgDn`, `g`/`G` | Move in lists and tables; `Enter` selects; `Space` toggles |
| `c` | Connect / disconnect port |
| `F` | Flash: the checks of §5.5, then a confirm dialog with the plan summary and warnings |
| `E` | Erase the entire flash. Its confirm dialog takes only `y` (or a click on Yes), not `Enter` |
| `i` | Chip info: reset into the bootloader, read the chip, reset back into the app |
| `Enter` in the Manifest field | Load what it holds (URL, folder URL, GitHub repo); on an empty field, open the file picker |
| `a` / `e` / `d` / `o` | Parts table: add a part / edit the row's offset and file in the part dialog (also `Enter`) / delete row / allow reading local files (the manifest's folder, or again after a reload). `Space` toggles a row |
| `Enter` on the Monitor pane | Enter the monitor: **from here every key goes to the device** |
| `Ctrl+]` | Leave the monitor (back to hotkeys) |
| `Ctrl+A` | Monitor menu: a centered pop-up that lists its keys and is clickable (live, or with the Monitor pane focused). `r` reset, `b` boot mode, `C` clear, `s` settings ▸ (`b` baud ▸ with Custom…, `f` format 8N1/8E1/7E1… ▸, `e` line ending ▸, `i` input raw/line ▸), `h` log-level colors, `t` timestamps, `d` lines ▸ (DTR, RTS by hand), `l` save log ▸ (plain, or with ANSI colors), `f` fullscreen, `Ctrl+A` send a literal `Ctrl+A`, `?` help. Menus open centered on the pane they belong to. Submenus have a `‹ Back` row; Esc and Backspace go back. Current values show in the menu labels and the status line (`303a:1001 @ 115200 8N1`), not in the pane header. |
| `f` | Fullscreen the focused pane; again to restore |
| `D` | Dump (read) flash to a file: a dialog takes the offset and size (empty size: to the end of the flash). The file is named `esp32-s3-<mac>-0x000000-0x400000.bin`. The demo log stream moved to `?demo` (§10) |
| `Esc` while a job runs | Stop it, after a confirmation (a flash stopped halfway may not boot) |
| `?` | Help overlay listing all keys |
| `-` / `+` | Smaller / larger font, remembered per browser |
| `Esc` | Close dialog or overlay, cancel the current input |

**Capital letters mark actions that cannot be undone**: `F` flash, `E` erase, `Ctrl+A C` clear the scrollback. Lowercase keys are safe to press by accident. `D` (dump) is capital only because `d` deletes a part row.

**Messages** (connected, copied, errors…) appear in the bottom bar in place of the key hints. They show a colored mark: `✓` ok, `•` info, `!` warning, `✗` error. The next key press or a click on the bar brings the hints back; otherwise info goes after 4 s and warnings after 8 s. Messages never float over the panes.

Every action can also be done with the mouse:
- Click to focus or select. The wheel scrolls lists, the monitor and the help.
- Key-bar entries are clickable.
- A `value ▾` picker (the flash baud) opens its full list on click, Enter or Space, and a click also focuses it.
- The title links to the repository and the version to its release page (`releases/tag/v<version>`). Both open with `window.open` from the click and are not underlined, to keep the frame clean.
- **Selection**: dragging in the monitor selects text tmux-style. The selection is anchored to the buffer (an xterm marker), so it stays on the same text while output streams in. Dragging past the edge scrolls. It is copied to the clipboard on release, through the Clipboard API with an `execCommand('copy')` fallback. Double click selects a word (a run of non-blank buffer cells) and triple click the line; both copy at once. They work on the monitor's own buffer, so pane borders never join a word. xterm's right-click word selection (on by default on macOS) is turned off for that reason. Shift-drag (Option-drag on macOS) is xterm's own screen selection, for anything else on screen.

### Visual style
- Colors are **terminal palette entries** (16 ANSI + a few truecolor accents), defined as an xterm `ITheme`. The default dark theme is a low-saturation background with green/amber/cyan accents. A light theme follows `prefers-color-scheme`.
- Progress bars use eighth-block characters (`▏▎▍▌▋▊▉█`) so they move smoothly; spinners use braille (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`).
- No quit key and no fake shell: closing the tab is how you leave (dropped after M0 testing; it added nothing).

## 5. Flasher

### 5.1 Connect (as built in M1)
1. `c` → `navigator.serial.requestPort()`; the port opens in the **monitor**. Connecting doesn't reset the board, so a running device keeps running.
2. The flasher **borrows the port** for each job (`F` flash, `E` erase, `D` dump, `i` chip info; §9): esptool-js `Transport` + `ESPLoader.main()` reset into the bootloader (classic DTR/RTS or USB-Serial/JTAG, picked by esptool-js), detect the chip, load the stub and raise the baud (`i` and `E` stay at 115200).
3. The status line then shows the chip, revision, flash size and MAC (`CHIP ESP32-S3 (QFN56) rev v0.2   FLASH 8MB   MAC …`), until the port changes. Before that it says `— i to detect`.
4. If the bootloader can't be reached, the error says what to do: "hold BOOT, tap RESET, release BOOT, then try again" (needed for ESP32-S2 native USB and boards without auto-reset). Other common errors get hints too: verify failures and timeouts suggest a lower flash baud (`src/app/jobs.ts`, `explain`).
5. esptool's own messages (`Connecting…`, `Chip is …`, `Hash of data verified`) are written into the monitor, dimmed and under a `── flash ──` header, like a CLI flasher's log. The per-block `Writing at 0x…` lines are left out; the progress bar shows that.
6. esptool-js is loaded only when the first job runs (a separate chunk of about 150 KB).

### 5.2 Source: the Manifest field
There is no source switch (the M0 `Files / GitHub / URL` radio is gone). One editable **Manifest** field says where the plan comes from, and the parts table below it can always be edited by hand.

**What the field accepts**:
- **A local manifest file**: the `Open…` button next to the field, or `Enter` on an empty field, opens the file picker. The file is read when the dialog closes. The field then shows the file's name.
- **A URL ending in `.json`**: fetched as the manifest.
- **A URL to a folder** (not ending in `.json`): the tool reads `<url>/esp-web-tool.json`, and only that name (decided 2026-10-18). The other formats (§6.1) are read only when their URL or file is given directly. The same applies when a picked file's address is edited into a folder URL.
- **A GitHub repo** (`owner/repo`, `https://github.com/owner/repo`, `…/releases/tag/<tag>`, `…/releases/latest`): its releases are listed and the latest is preselected (no drafts or pre-releases), with a `Release ▾` picker. The manifest is read from the release (§7).
- **Empty**: a hand-made plan, only the rows you add.

Text is read on `Enter`, files when the picker closes. A manifest with several sets shows a `Set ▾` picker (later preselected by the detected chip). Flash baud and Erase all come from the set when it gives them.

**Where the bins come from**: a part's path is relative to the manifest, or a full URL on any host.
- **Manifest from a URL**: `new URL(path, manifestUrl)`, so relative paths, root paths (`/fw/app.bin`) and URLs on other domains all work.
- **Manifest from a local file**: the browser does not give access to the file's folder. Those rows stay red ("needs folder access") until you press `o` (or click the notice). That opens a folder picker that starts in the manifest's folder (`showDirectoryPicker({ startIn: fileHandle })`), and one click grants it. Absolute disk paths (`/home/…`, `C:\…`) can't be read by a page: those rows are red until a file is picked for them.
- **Full URLs** (`https://…`, `//host/…`) are fetched as they are. GitHub release URLs go through the asset proxy.
- **No manifest**: a typed `host/path` is taken as `https://host/path`; a bare relative path is red.

**Rows can always be edited**, by key or by mouse:
- **The part dialog** (`Edit part` / `Add part`, centered on the Flash pane) holds the **Offset** (hex, with or without `0x`) and the **File**: a path relative to the manifest, a URL on any host, or a local file from `Browse…`. Tab moves between fields, `Enter` saves, `Esc` cancels. There is no separate replace key (`r` was removed, 2026-10-18).
- `e`, `Enter`, or a click on the selected row's offset or name opens it for that row.
- `a` or the `+ add part` row opens it empty. The File field has focus, and `Enter` on it while empty opens the file picker. Picking several files adds them all at once. An empty offset is a **smart offset** guessed from the file name.
- Delete a row with `d` or its `✕`.
- Toggle a row with `Space` or a click on `[x]`.

The only exception is **rows the manifest locks** (§6: `"locked": true` on a part, or on a set to lock all of its parts). They can't be deleted, edited or disabled, and they show `locked`.

**Red rows**: a row whose file can't be read is red with the reason. Reasons include 404, "unreachable or no CORS", needs folder access, needs permission again, an empty file, a `sha256` mismatch (the hash is dropped when the file is changed by hand), and needing the asset proxy. `F` refuses to start while any enabled row is red or still loading. Fix it in the part dialog, by granting access (`o`), or by disabling or deleting the row (if it isn't locked).

**Smart offsets** for an added file, from its name:
- `bootloader*.bin` → chip bootloader offset (ESP32/S2: `0x1000`; C2/C3/C6/H2/S3: `0x0`; C5/P4: `0x2000`). Until a chip is connected, use `0x0` and flag the row.
- `partition*table*.bin` / `partitions.bin` → `0x8000`
- `ota_data_initial.bin` → `0xd000`
- `*merged*.bin` / `*factory*.bin` → `0x0`
- otherwise → `0x10000`, or the first 64 KiB boundary after the last row

**Later**:
- Drag and drop of files or folders onto the terminal.
- Export the table as one of our manifests (§6).

### 5.5 Validation (before the flash button is enabled)
- **Error**: overlapping regions; a part extends past the detected flash size; an empty file; no parts enabled.
- **Warning** (needs confirmation): offset not 4 KiB aligned; plan chip ≠ detected chip; bootloader offset does not match the chip; image magic byte `0xE9` missing at the bootloader or app offset.
- As built (`src/flash/validate.ts`): the plan-only checks run on `F`, and their warnings are in the confirm dialog. The chip-dependent ones run once the bootloader has answered; new warnings then get a second dialog while the chip waits in the bootloader.
- When the chip is detected, guessed bootloader offsets (`?` in the table) become the chip's real one.
- **Wrong set**: if the selected set names another chip and exactly one set names this chip, that set is selected and the flash stops with "the ESP32-S3 set is now selected, F again". `i` selects it the same way.

### 5.6 Flash run
As built: one esptool session per job (`src/flash/esp.ts`, `src/app/jobs.ts`). Progress shows the part being written, a bar, the overall %, and the rate. The verify is esptool's: the stub's MD5 of each region against ours (`src/flash/md5.ts`; WebCrypto has no MD5). esptool-js's own hard reset only lowers RTS without raising it first, so the reset after a job is ours: the monitor reopens, then pulses EN with its tested sequence, which also catches the boot log from its first line.

1. Optionally erase all.
2. Write each enabled part with compression. Progress is shown per part and overall, with throughput and ETA.
3. If Verify is on, compare the device's MD5 of each region with the local MD5.
4. If Reset after is on, hard reset; then (optional, default on) hand the port to the monitor at `monitorBaudrate` (§9).
5. Show a final summary: ✓/✗ for each part, total time.
- Cancel (`Esc` during flashing) needs a confirmation, because stopping halfway leaves the device unbootable.
- Errors show the esptool-js message plus a short hint for common cases (sync timeout → boot mode; checksum → lower the baud).

## 6. Manifest format (`esp-web-tool.json`, v1)

Published as a JSON Schema at `https://kamranaghlami.github.io/esp_web_tool/schema/v1.json`.

```json
{
  "$schema": "https://kamranaghlami.github.io/esp_web_tool/schema/v1.json",
  "manifestVersion": 1,
  "name": "My Firmware",
  "version": "1.2.0",
  "sets": [
    {
      "id": "esp32s3-8mb",
      "name": "ESP32-S3 · 8 MB",
      "description": "Default build for DevKitC-1 N8",
      "chip": "ESP32-S3",
      "flash": { "mode": "dio", "freq": "80m", "size": "8MB" },
      "eraseAll": false,
      "baudrate": 921600,
      "monitorBaudrate": 115200,
      "parts": [
        { "path": "bootloader.bin",      "offset": "0x0" },
        { "path": "partition-table.bin", "offset": "0x8000" },
        { "path": "my-fw-esp32s3.bin",   "offset": "0x10000", "sha256": "…" }
      ]
    },
    {
      "id": "esp32c3-4mb",
      "name": "ESP32-C3 · 4 MB (merged)",
      "chip": "ESP32-C3",
      "parts": [ { "path": "my-fw-esp32c3-merged.bin", "offset": 0 } ]
    }
  ]
}
```

Rules:
- `sets` is a non-empty array, and `id` values are unique within it. `id` is used in deep links.
- `chip` is one of: `ESP32`, `ESP32-S2`, `ESP32-S3`, `ESP32-C2`, `ESP32-C3`, `ESP32-C5`, `ESP32-C6`, `ESP32-C61`, `ESP32-H2`, `ESP32-P4`. It is optional. If it is present, the set matching the connected chip is preselected and marked `chip ✓`.
- `offset`: a hex string or a non-negative integer.
- `path`: a **bare filename** means a release asset with that name in the same release (or a path relative to the manifest URL in URL mode). An **absolute `https://` URL** is fetched as is (it must be CORS-enabled).
- `sha256` (optional): checked after download, before flashing.
- `locked` (optional, default `false`): on a part, the user can't delete, edit or disable it. On a set, it applies to all of that set's parts. Extra rows can still be added.
- Unknown fields are ignored, which keeps the format forward compatible. A larger `manifestVersion` → warn and try anyway.

**Adapters** (read only, converted to our model):
- **esp-web-tools `manifest.json`** (`builds[].chipFamily`, `builds[].parts[].{path,offset}`, `new_install_prompt_erase`): each build becomes a set.
- **ESP-IDF `flasher_args.json`** (`flash_files`, `flash_settings`, `extra_esptool_args.chip`): becomes a single set.

## 7. GitHub integration

### 7.1 Input
These forms are accepted in the Manifest field (§5.2) and in the `?manifest=` / `?repo=` deep-link parameters:
- `owner/repo`
- `https://github.com/owner/repo` (with or without a trailing path)
- `https://github.com/owner/repo/releases/tag/<tag>` → preselects that tag
- `https://github.com/owner/repo/releases/latest` → preselects the latest release

### 7.2 Listing releases
- `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=30`, paginated with "load more".
- Each entry shows the tag, name, date, a `pre`/`draft` badge, and a manifest badge (●) if a recognized manifest asset exists.
- Releases without any manifest are still selectable and fall back to the asset picker (§7.3, step 4).
- The release body (markdown) is shown as plain text in a scrollable "Notes" box.
- **Rate limit**: unauthenticated requests get 60/hour per IP. Cache responses in `sessionStorage` with ETag (a `304` does not count against the limit). Read `x-ratelimit-remaining`; when it reaches 0, show a reset countdown.

### 7.3 Finding the manifest in a release
Only the asset named `esp-web-tool.json` (decided 2026-10-18; the other formats are read only when named directly). None found → **asset picker** (later): list the `.bin` assets and use the same smart offsets as §5.2.

The manifest asset itself is also a release asset and hits the CORS problem, so it goes through the fetcher (§7.4).

### 7.4 Downloading assets (the CORS problem)
Browsers cannot download GitHub release assets directly (§2). The `fetcher` tries these strategies in order:

1. **Direct**: absolute URLs on CORS-enabled hosts (Pages, raw.githubusercontent, any `ACAO: *` host).
2. **Asset proxy** (recommended to ship): a small **Cloudflare Worker** in `proxy/`, free tier. It:
   - only accepts `https://github.com/{o}/{r}/releases/download/{tag}/{name}` URLs (a strict regex; anything else gets 403),
   - follows the redirect, streams the body back with `ACAO` set to the Pages origin (plus `localhost` for dev),
   - caches at the edge (release assets do not change), and enforces a size cap (e.g. 32 MiB).
   The proxy base URL is set at build time (`VITE_ASSET_PROXY`), and the user can override it in Settings, so anyone can run their own.
3. **Manual assist** (always available, needs no infrastructure): the tool shows the list of required files with normal download links (a click navigates, so CORS does not apply). The user then drops the downloaded files onto the tool. Files are matched by name, offsets come from the manifest, and `sha256` is checked when present.

If no proxy is configured, the UI goes straight to Manual assist and explains why in one line.

**How existing web flashers handle this** (checked 2026-10-17):
- **T-SDR-C5** (`kamranaghlami.github.io/T-SDR-C5`): no proxy. Its CI runs `gh release download` for every release and copies the binaries into the Pages site, along with `versions.json` and `manifests/<tag>.json`. The page then fetches everything **same-origin**. The cost is that the firmware repo has to cooperate and redeploy its Pages on each release.
- **WLED** (`install.wled.me`): lists releases live from the GitHub API, but rewrites each asset URL to `https://download.wled.me/<same path>`, a **CORS-enabled mirror they run themselves** (nginx). This is the asset-proxy approach (strategy 2) on their own server.

**Proxy rate-limit concern** (decision postponed): if many people use a shared proxy, all of their downloads come from the proxy's IPs. Mitigations:
- The proxy never calls `api.github.com`. Release listing stays in the browser, so each user uses their own IP and their own 60/hour budget.
- `releases/download` has no documented per-IP limit like the REST API, but GitHub may still throttle abusive volume.
- Release assets do not change for a given tag and filename, so the proxy caches aggressively: edge cache plus an optional R2 copy keyed by `{owner}/{repo}/{tag}/{name}`. GitHub then sees about one fetch per asset per region, not one per user.
- Self-hosting stays possible (`VITE_ASSET_PROXY` / Settings), and firmware repos that care can use the Pages-mirror pattern and skip the proxy.

So a generic "any public repo" flasher needs a proxy. For a firmware repo that cooperates, the T-SDR-C5 pattern also works with strategy 1: its manifest uses absolute `https://<owner>.github.io/<repo>/…` part URLs (and the manifest itself can be loaded by URL in the Manifest field, §5.2). The producer workflow (§12) should offer both outputs: release assets, and a Pages mirror.

## 8. Serial monitor

- The status line shows the rx and tx rates while a port is open or the demo runs.
- Device output is parsed by the pane's `@xterm/headless` instance (§3) and drawn inside the TUI, so ANSI colors, cursor moves and clears (ESP-IDF log colors, `menuconfig`-style output, REPLs) behave as they do in a real terminal.
- **Log-level colors** (on by default, `Ctrl+A h` toggles): plain ESP-IDF lines starting `E (`, `W (` or `I (` are colored red, yellow or green, as `idf.py monitor` does. Firmware built without `CONFIG_LOG_COLORS` (the default in recent ESP-IDF) sends no escape codes of its own. Lines that already start with an escape code pass through untouched. The colorizer works on raw bytes before the terminal parser and holds at most a 3-byte line prefix, released after 30 ms if the device goes quiet (`src/monitor/log-color.ts`).
- **Input modes**: *raw* (default; each keystroke is sent, which suits REPLs like MicroPython) or *line* (a local edit line, sent on Enter). In line mode the monitor's bottom row is the input line (`› [text]`) while live; paste goes into it.
- Line ending on send: `LF` / `CR` / `CRLF` / none.
- Baud presets from 9600 to 2000000, plus a custom value (`Custom…`, 300 to 10000000). Changing the baud reopens the port.
- Frame format: 8N1 by default; 8E1, 8O1, 8N2, 7E1, 7O1, 7N1 from the menu (Web Serial `dataBits`/`parity`/`stopBits`). Changing it reopens the port.
- Timestamps (`Ctrl+A t`): a dim `12:34:56.789` before each received line, taken when its first byte arrives. They are added after the log-level colorizer, so it still sees `E (` at the start of a line (`src/monitor/timestamps.ts`).
- DTR/RTS toggles, **Reset** (EN pulse), **Boot** (enter the download mode sequence). The sequences follow esptool and depend on the port:
  - USB-UART bridge (CP210x, CH340, FTDI…): the classic auto-reset circuit. `(DTR,RTS)` = `(0,1)` 100 ms → `(1,0)` 50 ms → `(0,0)`.
  - Espressif USB-Serial/JTAG (`303a:1001`: C3, C5, C6, H2, P4, S3 native USB): strap first, then reset, passing through `(1,1)`. `(0,0)` → `(1,0)` → `(1,1)` → `(0,1)` 100 ms → `(0,0)`. The classic sequence does not latch download mode here. This is the likely reason boot mode failed on an ESP32-C5 in M0 testing; not yet confirmed on hardware.
  - Each step sets both lines in one `setSignals()` call, so a USB adapter sees one control-line change per step.
  - ESP32-S2/S3 USB-OTG CDC (TinyUSB) is not handled yet; it needs the manual BOOT+RESET path (§5).
- Scrollback of 10k lines (configurable); scroll lock when the user scrolls up; clear.
- **Save log** (`Ctrl+A l`): download the session as `esp-monitor-YYYYMMDD-HHMMSS.log`, plain text or with ANSI codes (`.ansi.log`). It is what the monitor showed, timestamps and flasher notes included, up to the newest 32 MiB (`src/monitor/session-log.ts`). Clear doesn't empty it.
- Decoding: UTF-8 with a streaming decoder (multi-byte sequences split across chunks are handled); invalid bytes show as `�`.
- *Later*: hex view, ELF-based backtrace decoding (needs the `.elf`, which could be an optional manifest field).

## 9. Port ownership

There is a single `PortManager`. Only one consumer holds the port at a time.

```
          Ctrl+O                 Ctrl+F / Ctrl+E
 [NoPort] ──────▶ [Idle] ◀─────────────────────▶ [Flashing]
    ▲              │  ▲                               │
    │   disconnect │  │ Ctrl+] / stop        done + reset + auto-monitor
    │              ▼  │                               │
    └──────────── [Monitoring] ◀──────────────────────┘
```

- Monitor → Flash (`PortManager.acquire`): cancel the reader, release the lock, close; the state is `busy` (status line `⠋ 303a:1001 · flasher`). esptool-js opens the port at 115200, syncs, and raises the baud.
- Flash → Monitor (`release`): close the transport, reopen at the monitor baud (a set's `monitorBaudrate` if it gives one), start the reader, then reset into the app if Reset after is on.
- **Native USB (USB-Serial/JTAG, USB-OTG CDC)**: a reset can make the device re-enumerate, so the `SerialPort` object goes away. `release` then retries for 6 s with ports from `getPorts()` that have the same `usbVendorId`/`usbProductId` (no gesture needed).
- **Unplug and replug** (or a board that resets itself and re-enumerates): the monitor says "device unplugged, waiting for it", and when a port with the same USB ids appears (`navigator.serial` `connect` event), it is reopened: "Reconnected 303a:1001". Disconnecting with `c` stops the waiting.

## 10. Deep links and settings

Query parameters (they can be combined):
- `?manifest=<anything the Manifest field accepts>` (§5.2), loaded on open; `?repo=owner/repo` is an alias
- `&tag=v1.2.0` or `&tag=latest`
- `&set=esp32s3-8mb` — preselect the set (if it matches the chip, flashing is one `Ctrl+F` away)
- `&baud=921600&monitor=115200`
- `?demo` or `?demo=flood`: a synthetic ESP-IDF log stream in the monitor, for trying it without a device (`flood` is about a saturated 2 Mbaud link; the e2e throughput test uses it). No key starts it.

The tool never starts flashing from a link alone; the user always confirms.

Settings live in `localStorage`, so every browser (each computer or phone) keeps its own. Best effort: blocked or full storage just means nothing sticks. They are saved after each input that changes them (`src/app/settings.ts`, key `esp-web-tool:settings:v2`). Every field is validated on load and falls back to its default.
- **What is remembered**: the Manifest field (when it holds a URL or `owner/repo`), flash baud, Erase all / Verify / Reset after, monitor baud / format / line ending, log-level colors.
- **Layout**: the active pane and fullscreen, per browser only, not per device (connecting a device moves focus to the monitor anyway).
- **Last used**: the page starts with whatever was used most recently.
- **Per USB device**: a full copy of all of the above is also kept per `vid:pid` (the 32 most recent devices). It is restored when that device is connected again (its flash plan too, or else its remembered manifest is loaded again), so each board keeps its own plan and monitor setup, and the message says "(settings restored)". A device seen for the first time keeps the current setup. Web Serial exposes no serial number, so two boards with the same USB ids (e.g. two native-USB ESP32-C5s, both `303a:1001`) share one entry.
- **The flash plan, files included** (decided 2026-10-18), last used and per device like the rest. It lives in IndexedDB (`src/browser/plan-store.ts`, database `esp-web-tool`, store `plans`, keys `last` and `vid:pid`), because only IndexedDB can keep file and folder handles. It holds the Manifest field, the parsed manifest, release list and selection, set, status, and every row as edited (offset, on/off, path or file handle, lock). Part data is not stored; it is read again. Input saves at once; async changes (reads finishing) about 300 ms later.
- **Permission after a reload**: Chrome keeps the handles but not the right to read them, unless the user chose "Allow on every visit". Rows needing it are red ("needs permission again (o)"), and a notice above the table says so. `o` (or a click on the notice) asks for all of them in one gesture (`requestPermission`). A page can't prompt without a gesture, so it doesn't ask on load. Files picked through the `<input type=file>` fallback have no handle and come back red ("not kept after reload: pick it again").
- **Later**: theme, auto-monitor, timestamps, asset proxy URL, recent repos (last 10).
- URL parameters override remembered settings for that visit.

## 11. Privacy and security

- No backend except the optional asset proxy, which is stateless and only allows GitHub release URLs.
- No analytics. Local files never leave the browser.
- The proxy only handles public release downloads and never sees serial data.
- Strict CSP via a `<meta>` tag: `connect-src` limited to `api.github.com`, the proxy origin, and `https:` (for absolute manifest URLs).

## 12. CI/CD (GitHub Actions)

**`.github/workflows/ci.yml`** is a single workflow, so deploys are gated on the checks:
- **check** (pull requests, pushes to `main`, manual runs): Node 24, `npm ci` with cache → `lint` · `format:check` · `typecheck` · `test` (Vitest) → Playwright on Chromium (`test:e2e`, which builds and serves the site). On failure the Playwright report and traces are uploaded.
- **build-pages** (pushes to `main` only, after **check**): `npm run build` with `BASE_PATH=/<repo>/` and `GIT_SHA` (shown in the title bar next to the `package.json` version) → `actions/configure-pages` → `actions/upload-pages-artifact`.
- **deploy-pages**: `actions/deploy-pages` with `pages: write` + `id-token: write`, concurrency group `pages` (never cancels, so an older run cannot overwrite a newer deploy).
- One-time repo setup: Pages source = **GitHub Actions** (done via the API when M0 was pushed).

**`.github/workflows/proxy.yml`** (optional, M4) — deploys `proxy/` with `wrangler` when `proxy/**` changes. Needs `CLOUDFLARE_API_TOKEN`.

**Producer side** (M4): document a workflow snippet, possibly a reusable action, that firmware repos can use. It builds with ESP-IDF, converts `build/flasher_args.json` into `esp-web-tool.json`, and attaches both the manifest and the binaries to the release.

## 13. Testing

- **Simulated chip** (`tests/fake-esp.ts`): an ESP32-S3 behind a fake port. Its app echoes input and prints a boot log. A reset with IO0 strapped low (DTR during the sequence) enters the ROM, which speaks esptool's SLIP protocol: sync, registers, security info, the stub upload (it answers `OHAI`), baud change, compressed and plain writes, MD5, erase, and read with acks. The same code runs in Vitest (`tests/fake-port.ts`, Node streams) and in the page (the harness injects its source). Not modelled: timing, flow control, flash encryption.
- **Unit (Vitest)**: input parser (key, mouse and paste sequences); Screen diff renderer (golden frames as text snapshots, rendered into `@xterm/headless` and compared cell by cell); layout; GitHub URL parsing; manifest validation and adapters (fixtures for all three formats); smart offsets; overlap and size validation; the streaming UTF-8 decoder; rate-limit and ETag cache logic (mocked `fetch`).
- **UI (Playwright)**: a fake `navigator.serial` injected before load. Assertions read the xterm buffer (`term.buffer.active`) as text, which is exactly what the user sees. It drives connect → chip info, the monitor echoing input, keyboard navigation, and the manifest → parts table flow against a mocked GitHub API.
- **Hardware (manual checklist, per release)**: ESP32 (CP210x), ESP32-S3 (native USB), ESP32-C3 (native USB), ESP32-S2 (native USB, manual boot). For each: flash, verify, auto-monitor, reset, monitor baud change, unplug and replug. **Android phone over OTG**: one native-USB board (polyfill path), one CP210x board (must show the "not supported on this phone" message, or work if the phone has native Web Serial), plus typing in the live monitor with Gboard.
- **Mobile layout (Playwright)**: run the e2e suite under device emulation as well (Pixel 7 and iPhone 14 profiles, with touch enabled): compact layout renders, taps hit the right widgets, the extra-keys bar sends the right bytes, and iOS shows the unsupported notice instead of "too small".

## 14. Milestones

| # | Scope | Done when |
|---|---|---|
| M0 ✅ | Scaffold (Vite/TS), `Tty` + input parser, Screen/diff renderer, layout + core widgets, keymap, help overlay, CI + Pages deploy. **Spike**: `requestPort()` from a key and from a mouse click via xterm `onData`; headless-terminal blit performance at 2 Mbaud | The empty shell is live on Pages, CI is green, and the spike passes |
| M1 ✅ | The Manifest field (local file + folder grant, URL, folder URL, GitHub release listing), manifest parser + adapters, editable parts table with red rows and locks, `?manifest=`; esptool-js: chip info (`i`), validation, flash/verify/reset (`F`), erase (`E`), dump to a file (`D`), stop (`Esc`). Tested end to end against a simulated ESP32-S3 (§13); **needs a hardware run** | A local IDF build flashes onto ESP32 and ESP32-S3 |
| M2 ✅ | Serial monitor, port handoff, native-USB reconnect; timestamps, line input, DTR/RTS, custom baud, save log; focus moves to the monitor after a flash with Reset after. **Needs a hardware run** | Flash → auto-monitor works on a native-USB chip |
| M2b ✅ | **Phones**: compact size class, touch bridge, extra-keys bar, soft-keyboard handling, WebUSB + `web-serial-polyfill` fallback (plus CH340), Android device emulation in e2e. **Needs a real phone** | Flash + monitor a native-USB ESP32 from an Android phone over OTG |
| M3 | GitHub release files through the asset proxy (once the rate limit is settled), Manual assist download, release notes | A real release with `esp-web-tool.json` flashes via manual assist |
| M4 | Proxy hardening (caching, limits) and self-hosting docs, JSON Schema, producer workflow docs | One-click flash from a release link |
| M5 | Polish: light theme, log save, error hints, accessibility pass, installable app (PWA) | — |

### M0 findings (2026-10-17)

- **Gesture spike: passes.** A key press or a click inside xterm.js gives `requestPort()` the user activation it needs. Both paths are covered by e2e tests against a fake `navigator.serial` that rejects calls without activation (like Chrome). The tests confirm activation is `false` before the input, so the input is what grants it. Chrome's activation is *transient* (about 5 s), not strictly "synchronous inside the handler". We still call gesture-gated APIs synchronously from input dispatch.
- **Test-harness trap**: Playwright grants the page a user gesture whenever it evaluates there: `page.evaluate`, `exposeBinding`, and `page.goto` itself (about 1 s after load). Gesture tests therefore wait about 5 s for that activation to expire, and the page reports to the test only through `fetch` requests caught by `page.route`. See `tests/e2e/harness.ts`.
- **Monitor throughput: passes.** On GitHub's 4-core runner (headless Chromium, DOM renderer), the demo flood runs at **60 fps while taking in 196 KiB/s**, the full demo rate, about a saturated 2 Mbaud link. The JS pipeline alone (headless parse → blit → diff → ANSI) does 2.7 MiB/s there, about 14× real time (`tests/unit/term-pane.test.ts`). On the 1-core dev VM with no GPU, the browser's own paint dominates (about 10 fps, 120 KiB/s), so e2e perf thresholds are smoke-level. Not yet measured: the hardware-WebGL path on a desktop.
- **Renderer choice**: software WebGL (SwiftShader/llvmpipe) was about 10× slower than xterm's DOM renderer, so WebGL is only enabled when `WEBGL_debug_renderer_info` reports a real GPU. `?renderer=dom|webgl` overrides this.
- **Packaging**: `@xterm/headless@6.0.0` declares a `module` entry it does not ship, so Vite aliases it to `lib-headless/xterm-headless.mjs`. The bundle is about 655 kB (175 kB gzipped), mostly two copies of xterm.js core; worth revisiting (lazy-load the headless monitor terminal) if load time matters.
- **TypeScript 6** is pinned because `typescript-eslint` does not support TS 7 yet.
- **Laptop test (2026-10-18)**: the monitor works with a real ESP32-C5. Fixed after it:
  - Boot mode did nothing. If the C5 was on its native USB port, the classic sequence was the wrong one. Added the USB-Serial/JTAG sequence (§8); needs a retest.
  - Plain ESP-IDF logs showed uncolored. Added log-level colors (§8).
  - A black strip appeared at the bottom on first load. xterm.css paints its viewport `#000`, and the pixels below the last whole row showed through. The viewport is now transparent, and the terminal refits when a web font finishes loading.
  - Removed the quit key and the fake shell.
- **Second laptop pass (2026-10-18)**:
  - Ctrl+A gave no visible menu; it is now a pop-up with `?` for help.
  - Shift-drag selection did not do what was wanted. xterm's selection is screen-fixed, so it spans both panes and stays put while the log scrolls; on macOS it needs Option. Added buffer-anchored drag selection in the monitor.
  - Added: mouse wheel in the help, the title and version as links, a tx rate next to rx, and clickable dropdowns for baud and line ending.
- **Third pass (2026-10-18)**: the frame format is configurable (was fixed 8N1). The pane header lost "● LIVE" (the key bar says it) and the baud/line-ending dropdowns (they are in the menu). Baud +/- removed. Zoom renamed Fullscreen. Menus are centered and submenus have Back. Links are no longer underlined.
- **Fourth pass (2026-10-18)**:
  - ← no longer goes back in menus.
  - Menus center on their pane.
  - The version links to its own release.
  - The text cursor is hidden while an overlay is open.
  - The flash baud is a `value ▾` picker instead of a `‹ value ›` stepper, and clicking it focuses it.
- **Fifth pass (2026-10-18)**:
  - Settings are remembered per browser and per USB device.
  - Baud, format and line ending moved under Ctrl+A `s` Settings, and `f` is Fullscreen in that menu.
  - `D` is reserved for dumping flash; the demo stream is now URL-only.
  - Double/triple click selects a word/line in the monitor. xterm's right-click word selection (macOS default) treated borders as part of words and is now off.
- **Sixth pass (2026-10-18)**:
  - The flash source and repo/URL fields are no longer remembered.
  - Toasts became bottom-bar messages.
  - `f` is Fullscreen everywhere, `F` is Flash (capitals = cannot be undone), and Ctrl+A `C` clears.
- **Seventh pass (2026-10-18)**: everything (flash and monitor) is remembered as "last used" and per USB device. Picked files can't be kept.
- **DevTools artifact (2026-10-18)**: after opening and closing DevTools in Chrome on macOS, the frame sat one row low with a stale border line on top. The app had been drawing on the normal screen since the fake shell was removed. xterm reflows the normal screen on resize, and its view can stop short of the bottom. Fixed by going back to the alternate screen (`?1049h`: no scrollback, no reflow) and scrolling to the bottom after every refit.
- **Eighth pass (2026-10-18), M1 started**:
  - The Source radio became one Manifest field (§5.2): local file + folder grant, URL, folder URL, GitHub release listing.
  - The parts table is editable by key and mouse; red rows block `F`; the manifest can lock rows.
  - The active pane and fullscreen are remembered.
  - The message says "(settings restored)".
  - Focus starts on the parts table, and Enter in the Manifest field moves focus there.
- **Ninth pass (2026-10-18)**:
  - Shorter Manifest placeholder; the help's key column sizes to its longest key (no clipped rows).
  - Shorter errors: one manifest name is tried, and a fetch that fails is "unreachable or no CORS".
  - Only `esp-web-tool.json` is looked for when no file is named.
  - The whole flash plan, picked files included, is kept per device in IndexedDB; `o` asks for permission again after a reload.
  - Bins can be URLs on any host or root paths, and can be typed.
  - `r` is gone: `e` opens the part dialog (offset and file). `+ add part` sits one column away from the `▶` marker.
  - A pushed commit that fails CI never deploys: `1af82bf` and `59085f8` failed on a test that read the screen before the redraw after a resize, so Pages stayed on `472e2ac` until the fix.

## 15. Open questions

0. **Phones**: which Android phone(s) will you test with? That decides whether we can rely on native Web Serial (M149+, device-dependent) or only on the polyfill. Do your target boards use native USB or CP210x/CH340 bridges?

1. **CORS strategy**: decided (2026-10-18): **build the asset proxy** (§7.4), **once the rate-limit concern is settled**. Until then, GitHub release files show as red rows ("needs the asset proxy"), and URL manifests on CORS-enabled hosts work fully.
2. **Where the manifest lives**: "in the release's root" could mean (a) a **release asset** (this draft), or (b) a file at the **repo root at the release tag**, fetched via `raw.githubusercontent.com`, which *is* CORS-enabled. (b) gets the manifest past CORS without a proxy, but the binaries would still need one. Should we support both?
3. ~~Manifest filename~~: decided (2026-10-18), `esp-web-tool.json`, and it is the only name looked for when no file is named (folder URLs, releases).
4. ~~Rendering~~: decided, a real TUI inside xterm.js (§3).
5. **Asset download strategy** (§7.4): proxy decided (see 1); waiting on the rate-limit discussion.
5b. **Proxy rate limit**: settle the concern before building the proxy (§7.4 lists the mitigations).
6. **Optional GitHub token** for higher rate limits and private repos: in scope for v1 or later?
7. ~~Package manager and license~~: npm and MIT for M0 (easy to change).
