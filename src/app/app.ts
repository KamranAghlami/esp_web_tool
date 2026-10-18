import { BOOT_BANNER, DemoStream } from '../monitor/demo';
import {
  describePort,
  errorText,
  describeFormat,
  FORMATS,
  PortManager,
  type PortState,
} from '../serial/port-manager';
import { InputParser, type InputEvent, type KeyEvent, type PasteEvent } from '../tty/input';
import type { Tty } from '../tty/tty';
import { HitMap, type Ctx } from '../tui/context';
import { centered, cols, rows } from '../tui/layout';
import { Renderer, type CursorState } from '../tui/renderer';
import { contains, Screen, type Rect } from '../tui/screen';
import { Attr, type Style } from '../tui/style';
import { darkTheme, type Theme } from '../tui/theme';
import {
  dialog,
  type Focusable,
  keyBar,
  type KeyHint,
  Menu,
  type MenuItem,
  type MenuOptions,
  spinner,
} from '../tui/widgets';
import { stringWidth } from '../tui/width';
import { BAUD_RATES, FlashPane, formatSize } from './flash-pane';
import { HELP } from './help';
import { LINE_ENDINGS, MonitorPane } from './monitor-pane';
import {
  type KeyValueStore,
  rememberPort,
  type SerialSettings,
  type Settings,
  SettingsStore,
} from './settings';

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
/** Below this width the panes are shown one at a time. */
export const SPLIT_COLS = 120;

export const REPO_URL = 'https://github.com/KamranAghlami/esp_web_tool';
/** Monitor baud choices: slow ROM/legacy rates, then the flasher's. */
const MONITOR_BAUDS = [9600, 19200, 38400, 57600, 74880, ...BAUD_RATES];

/** Mouse tracking (button + drag, SGR encoding), bracketed paste, window title. */
const ENTER_APP = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b]0;ESP Web Tool\x07';

type MessageKind = 'info' | 'ok' | 'warn' | 'error';
/** A message shown in the bottom bar in place of the key hints, until it expires or a key. */
type Message = { text: string; kind: MessageKind; until: number };
type Overlay =
  | { kind: 'help'; scroll: number }
  | { kind: 'confirm'; title: string; body: string[]; onYes: () => void }
  | { kind: 'menu'; menu: Menu };
export type DemoMode = 'off' | 'normal' | 'flood';

/** How a gesture-gated browser call was triggered, for the M0 spike (SPEC §3.1). */
export interface SpikeRecord {
  trigger: 'key' | 'mouse';
  userActivation: boolean | null;
  result: 'granted' | 'cancelled' | 'error';
  detail?: string;
}

export interface AppOptions {
  tty: Tty;
  theme?: Theme;
  now?: () => number;
  /** Schedules a frame; defaults to requestAnimationFrame. */
  schedule?: (fn: () => void) => void;
  /** Opens a link in a new tab. Called from input dispatch, so popups are allowed. */
  openUrl?: (url: string) => void;
  /** Puts text on the clipboard. */
  copy?: (text: string) => Promise<void>;
  /** Where settings are remembered (localStorage in the page); none means nothing sticks. */
  storage?: KeyValueStore;
  /**
   * Synthetic log stream into the monitor, for trying it without a device and for the
   * throughput test. Only from the URL (`?demo`, `?demo=flood`); no key starts it.
   */
  demo?: DemoMode;
}

export class App {
  readonly tty: Tty;
  readonly theme: Theme;
  readonly flash = new FlashPane();
  readonly monitor = new MonitorPane();
  readonly ports: PortManager;
  readonly spike: SpikeRecord[] = [];

  /** Which pane has focus, and which widget inside the flash pane. */
  pane: 'flash' | 'monitor' = 'flash';
  private flashFocus = 0;
  private zoomed = false;
  /** Where the panes were last drawn, to center their menus on them. */
  private rects: { main: Rect | null; flash: Rect | null; monitor: Rect | null } = {
    main: null,
    flash: null,
    monitor: null,
  };
  private overlay: Overlay | null = null;
  private message: Message | null = null;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;

  private parser = new InputParser();
  private renderer = new Renderer();
  private hits = new HitMap();
  private frameQueued = false;
  private now: () => number;
  private schedule: (fn: () => void) => void;
  private openUrl: (url: string) => void;
  private copy: (text: string) => Promise<void>;
  private lastTrigger: 'key' | 'mouse' = 'key';
  private startDemo: DemoMode;
  private store: SettingsStore;
  private settings: Settings;

  private demo: DemoMode = 'off';
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private demoStream = new DemoStream();

  /** Stats for the status line (and the e2e perf check). */
  stats = { fps: 0, rxPerSec: 0, txPerSec: 0 };
  private frames = 0;
  private statRx = 0;
  private statTx = 0;
  private statTimer: ReturnType<typeof setInterval>;

  constructor(opts: AppOptions) {
    this.tty = opts.tty;
    this.theme = opts.theme ?? darkTheme;
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn) => requestAnimationFrame(fn));
    this.openUrl = opts.openUrl ?? (() => {});
    this.copy = opts.copy ?? (() => Promise.resolve());
    this.monitor.onCopy = (text) => {
      const n = [...text].length;
      this.copy(text).then(
        () => this.notify(`Copied ${n} character${n === 1 ? '' : 's'}`, 'ok'),
        (err: unknown) => this.notify(`Copy failed: ${errorText(err)}`, 'error'),
      );
    };
    this.flash.baud.onOpen = () =>
      this.openMenu(
        'Flash baud',
        BAUD_RATES.map((b, i) => ({
          label: String(b),
          checked: i === this.flash.baud.index,
          action: () => (this.flash.baud.index = i),
        })),
        { within: this.rects.flash ?? undefined },
      );
    this.ports = new PortManager({
      onData: (bytes) => this.monitor.write(bytes, () => this.invalidate()),
      onState: (s, detail) => this.onPortState(s, detail),
    });
    this.flash.onSimDone = () => this.notify('Simulated run finished (nothing was written)', 'ok');
    this.flash.source.onChange = () => (this.flashFocus = 0);
    this.startDemo = opts.demo ?? 'off';
    this.store = new SettingsStore(opts.storage);
    this.settings = this.store.load();
    this.applySettings();

    this.tty.onData((d) => this.onData(d));
    this.tty.onResize(() => {
      this.renderer.invalidate();
      this.invalidate();
    });
    this.statTimer = setInterval(() => this.sampleStats(), 1000);
  }

  start(): void {
    this.tty.write(ENTER_APP);
    this.setDemo(this.startDemo);
    this.renderer.invalidate();
    this.invalidate();
  }

  dispose(): void {
    clearInterval(this.statTimer);
    this.setDemo('off');
  }

  invalidate = (): void => {
    if (this.frameQueued) return;
    this.frameQueued = true;
    this.schedule(() => {
      this.frameQueued = false;
      this.frame();
    });
  };

  private sampleStats(): void {
    const rx = this.monitor.bytesIn;
    const tx = this.ports.bytesOut;
    this.stats = { fps: this.frames, rxPerSec: rx - this.statRx, txPerSec: tx - this.statTx };
    this.frames = 0;
    this.statRx = rx;
    this.statTx = tx;
    if (this.demo !== 'off' || this.ports.state === 'open') this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Input

  private onData(data: string): void {
    for (const e of this.parser.feed(data)) {
      // The next key puts the hints back (a message it causes replaces them again).
      if (e.type === 'key') this.message = null;
      this.dispatch(e);
    }
    this.saveSettings();
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Settings

  private applySettings(): void {
    const { flash, monitor } = this.settings;
    const f = this.flash;
    f.baud.index = Math.max(0, BAUD_RATES.indexOf(flash.baud as (typeof BAUD_RATES)[number]));
    f.eraseAll.checked = flash.eraseAll;
    f.verify.checked = flash.verify;
    f.resetAfter.checked = flash.resetAfter;
    this.applySerial(monitor);
    if (this.monitor.colorize !== monitor.colorize) this.monitor.toggleColorize();
  }

  private applySerial(s: SerialSettings): void {
    this.ports.baudRate = s.baud;
    this.ports.format = s.format;
    this.monitor.eol = s.eol;
  }

  private currentSerial(): SerialSettings {
    return { baud: this.ports.baudRate, format: this.ports.format, eol: this.monitor.eol };
  }

  /** Snapshot the current state; written only if it changed. */
  private saveSettings(): void {
    const f = this.flash;
    const s = this.settings;
    s.flash = {
      baud: f.baud.value,
      eraseAll: f.eraseAll.checked,
      verify: f.verify.checked,
      resetAfter: f.resetAfter.checked,
    };
    s.monitor = { ...this.currentSerial(), colorize: this.monitor.colorize };
    const key = this.ports.port && portKey(this.ports.port);
    if (key && this.ports.state === 'open') rememberPort(s.ports, key, this.currentSerial());
    this.store.save(s);
  }

  private dispatch(e: InputEvent): void {
    if (e.type === 'mouse') {
      this.lastTrigger = 'mouse';
      // A click on a widget focuses it, even if the click also opened an overlay (a menu).
      const covered = this.overlay !== null;
      const { owner } = this.hits.dispatch(e);
      if (e.action === 'down' && owner && !covered) this.focusWidget(owner);
      return;
    }
    this.lastTrigger = 'key';

    if (this.overlay) {
      if (e.type === 'key') this.overlayKey(e);
      return;
    }

    if (this.monitor.live) {
      this.liveInput(e);
      return;
    }

    const focus = this.focused();
    if (e.type === 'paste') {
      focus?.handlePaste?.(e.text);
      return;
    }

    if (e.name === 'tab') {
      this.cycleFocus(e.shift ? -1 : 1);
      return;
    }
    if (focus?.capturesText) {
      if (e.name === 'escape') this.cycleFocus(1);
      else focus.handleKey(e);
      return;
    }
    if (this.hotkey(e)) return;
    focus?.handleKey(e);
  }

  private hotkey(e: KeyEvent): boolean {
    if (e.ctrl && e.name === 'a' && this.pane === 'monitor') {
      this.openMonitorMenu();
      return true;
    }
    if (e.ctrl || e.alt) return false;
    switch (e.name) {
      case 'c':
        this.toggleConnect();
        return true;
      case 'F':
        this.startFlash();
        return true;
      case 'f':
        this.toggleFullscreen();
        return true;
      case 'E':
        this.notify('Erase arrives with esptool-js in M1', 'info');
        return true;
      case 's':
        this.flash.source.cycle();
        return true;
      case '1':
        this.focusPane('flash');
        return true;
      case '2':
        this.focusPane('monitor');
        return true;
      case 'D':
        this.notify('Dump (read) flash arrives with esptool-js in M1', 'info');
        return true;
      case '?':
        this.overlay = { kind: 'help', scroll: 0 };
        return true;
      case 'enter':
        if (this.pane === 'monitor') {
          this.enterLive();
          return true;
        }
        return false;
    }
    return false;
  }

  private overlayKey(e: KeyEvent): void {
    const o = this.overlay!;
    if (o.kind === 'menu') {
      o.menu.handleKey(e);
      return;
    }
    if (o.kind === 'help') {
      if (e.name === 'escape' || e.name === 'q' || e.name === '?' || e.name === 'enter')
        this.overlay = null;
      else if (e.name === 'down' || e.name === 'j') o.scroll++;
      else if (e.name === 'up' || e.name === 'k') o.scroll = Math.max(0, o.scroll - 1);
      return;
    }
    if (e.name === 'y' || e.name === 'Y' || e.name === 'enter') {
      this.overlay = null;
      o.onYes();
    } else if (e.name === 'n' || e.name === 'N' || e.name === 'escape') {
      this.overlay = null;
    }
  }

  /** Keys while the monitor is live go to the device, except Ctrl+] and the Ctrl+A menu. */
  private liveInput(e: KeyEvent | PasteEvent): void {
    if (e.type === 'paste') {
      this.send(e.text.replace(/\r?\n/g, this.monitor.lineEnding.value));
      return;
    }
    if (e.ctrl && e.name === ']') {
      this.monitor.live = false;
      return;
    }
    if (e.ctrl && e.name === 'a') {
      this.openMonitorMenu();
      return;
    }
    this.monitor.pane.scrollToBottom();
    this.send(e.name === 'enter' ? this.monitor.lineEnding.value : e.raw);
  }

  /**
   * Opens a menu as the overlay. An action menu passes `from`, the key of the item to
   * highlight first (e.g. the entry a submenu was opened from); a choice list starts on its
   * checked value.
   */
  private openMenu(title: string, items: MenuItem[], opts: MenuOptions = {}, from?: string): Menu {
    const menu = new Menu(
      title,
      items,
      () => {
        if (this.overlay?.kind === 'menu' && this.overlay.menu === menu) this.overlay = null;
      },
      opts,
    );
    if (from !== undefined) {
      menu.selected = Math.max(
        0,
        menu.items.findIndex((i) => i.key === from),
      );
    }
    this.overlay = { kind: 'menu', menu };
    return menu;
  }

  /** The Ctrl+A menu; `from` re-selects the item a submenu was opened from. */
  private openMonitorMenu(from?: string): void {
    const open = this.ports.state === 'open';
    const m = this.monitor;
    const p = this.ports;
    this.openMenu(
      'Monitor · Ctrl-A',
      [
        { key: 'r', label: 'Reset chip', action: () => this.resetChip() },
        { key: 'b', label: 'Boot (download) mode', action: () => this.bootMode() },
        { key: 'C', label: 'Clear', action: () => m.clear() },
        {
          key: 's',
          label: `Settings: ${p.baudRate} ${p.format} ${m.lineEnding.label} ▸`,
          action: () => this.openSettingsMenu(),
        },
        {
          key: 'h',
          label: 'Log level colors',
          checked: m.colorize,
          action: () => this.toggleColors(),
        },
        {
          key: 'f',
          label: 'Fullscreen pane',
          checked: this.zoomed,
          action: () => this.toggleFullscreen(),
        },
        { key: '^A', label: 'Send Ctrl-A', action: () => open && this.send('\x01') },
        { key: '?', label: 'Help', action: () => (this.overlay = { kind: 'help', scroll: 0 }) },
      ],
      { within: this.monitorArea() },
      from ?? 'r',
    );
  }

  /** Serial settings: each opens a list; Back returns here, and from here to the menu. */
  private openSettingsMenu(from?: string): void {
    const m = this.monitor;
    const p = this.ports;
    this.openMenu(
      'Settings',
      [
        { key: 'b', label: `Baud: ${p.baudRate} ▸`, action: () => this.openBaudMenu() },
        { key: 'f', label: `Format: ${p.format} ▸`, action: () => this.openFormatMenu() },
        {
          key: 'e',
          label: `Line ending: ${m.lineEnding.label} ▸`,
          action: () => this.openEolMenu(),
        },
      ],
      { within: this.monitorArea(), onBack: () => this.openMonitorMenu('s') },
      from ?? 'b',
    );
  }

  /** A list under Settings: Back (or Esc) returns to it. */
  private openSettingsList(title: string, from: string, items: MenuItem[]): void {
    this.openMenu(title, items, {
      within: this.monitorArea(),
      onBack: () => this.openSettingsMenu(from),
    });
  }

  /** Monitor menus center on the monitor pane, or the main area while it is hidden. */
  private monitorArea(): Rect | undefined {
    return this.rects.monitor ?? this.rects.main ?? undefined;
  }

  private openBaudMenu(): void {
    this.openSettingsList(
      'Baud rate',
      'b',
      MONITOR_BAUDS.map((b) => ({
        label: String(b),
        checked: b === this.ports.baudRate,
        action: () => this.setMonitorBaud(b),
      })),
    );
  }

  private openFormatMenu(): void {
    const p = this.ports;
    this.openSettingsList(
      'Format',
      'f',
      FORMATS.map((f) => ({
        label: describeFormat(f),
        checked: f === p.format,
        action: () => {
          if (p.state === 'open')
            void p.setFormat(f).then(() => this.notify(`Format: ${f}`, 'info'));
          else p.format = f;
        },
      })),
    );
  }

  private openEolMenu(): void {
    this.openSettingsList(
      'Line ending',
      'e',
      LINE_ENDINGS.map((l, i) => ({
        label: l.label,
        checked: i === this.monitor.eol,
        action: () => (this.monitor.eol = i),
      })),
    );
  }

  private toggleFullscreen(): void {
    this.zoomed = !this.zoomed;
  }

  private resetChip(): void {
    if (this.ports.state !== 'open') return this.notify('Connect a port first (c)', 'warn');
    void this.ports.reset().then(() => this.notify('Reset sent', 'ok'));
  }

  private bootMode(): void {
    const ports = this.ports;
    if (ports.state !== 'open') return this.notify('Connect a port first (c)', 'warn');
    void ports
      .enterBootloader()
      .then(() =>
        this.notify(`Boot mode sequence sent (${ports.usbJtag ? 'USB-JTAG' : 'DTR/RTS'})`, 'ok'),
      );
  }

  private toggleColors(): void {
    this.monitor.toggleColorize();
    this.notify(`Log level colors: ${this.monitor.colorize ? 'on' : 'off'}`, 'info');
  }

  private setMonitorBaud(baud: number): void {
    const ports = this.ports;
    if (ports.state === 'open')
      void ports.setBaud(baud).then(() => this.notify(`Baud: ${baud}`, 'info'));
    else ports.baudRate = baud;
  }

  private send(data: string): void {
    if (this.ports.state === 'open') void this.ports.write(data);
  }

  // -------------------------------------------------------------------------
  // Focus

  private ring(): Focusable[] {
    return [...this.flash.focusables(), this.monitor];
  }

  private focused(): Focusable | null {
    if (this.pane === 'monitor') return this.monitor;
    const list = this.flash.focusables();
    return list[Math.min(this.flashFocus, list.length - 1)] ?? null;
  }

  private cycleFocus(d: number): void {
    const ring = this.ring();
    const cur = ring.indexOf(this.focused()!);
    const next = (cur + d + ring.length) % ring.length;
    if (ring[next] === this.monitor) {
      this.pane = 'monitor';
    } else {
      this.pane = 'flash';
      this.flashFocus = next;
    }
  }

  private focusPane(p: 'flash' | 'monitor'): void {
    this.pane = p;
  }

  private focusWidget(w: unknown): void {
    if (w === this.monitor) {
      this.pane = 'monitor';
      return;
    }
    const i = this.flash.focusables().indexOf(w as Focusable);
    if (i >= 0) {
      this.pane = 'flash';
      this.flashFocus = i;
    }
  }

  private enterLive(): void {
    if (this.ports.state !== 'open') {
      this.notify(
        this.demo !== 'off'
          ? 'Demo stream is output-only; connect a port to type'
          : 'Connect a port first (c)',
        'warn',
      );
      return;
    }
    this.monitor.live = true;
    this.monitor.pane.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Actions

  private toggleConnect(): void {
    const ports = this.ports;
    if (ports.state === 'unsupported') {
      this.notify('Web Serial is not available: use Chrome, Edge or Opera on desktop', 'error');
      return;
    }
    if (ports.port) {
      void ports.close().then(() => this.notify('Disconnected', 'info'));
      return;
    }
    // Called synchronously from the key/mouse handler so the user activation still applies.
    const record: SpikeRecord = {
      trigger: this.lastTrigger,
      userActivation:
        typeof navigator !== 'undefined' ? (navigator.userActivation?.isActive ?? null) : null,
      result: 'error',
    };
    this.spike.push(record);
    ports
      .request()
      .then((port) => {
        record.result = 'granted';
        // A device seen before gets the serial settings it had last time.
        const key = portKey(port);
        const known = key ? this.settings.ports[key] : undefined;
        if (known) this.applySerial(known);
        return ports.open(port).then(() => {
          this.setDemo('off');
          this.monitor.clear();
          this.focusPane('monitor');
          this.saveSettings();
          this.notify(
            `Connected ${describePort(port)} @ ${ports.baudRate} ${ports.format}` +
              (known ? ' (remembered settings)' : ''),
            'ok',
          );
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          record.result = 'cancelled';
          this.notify('No port selected', 'warn');
        } else {
          record.detail = errorText(err);
          this.notify(`Could not open port: ${record.detail}`, 'error');
        }
      })
      .finally(() => this.invalidate());
  }

  private startFlash(): void {
    if (this.flash.running) return;
    const parts = this.flash.parts.items.filter((p) => p.enabled);
    if (parts.length === 0) {
      this.notify('No parts enabled', 'warn');
      return;
    }
    const total = parts.reduce((n, p) => n + p.size, 0);
    this.overlay = {
      kind: 'confirm',
      title: 'Flash (simulated)',
      body: [
        `${parts.length} parts · ${formatSize(total)} · ${this.flash.baud.value} baud`,
        '',
        'M0 has no flasher yet: this only animates the progress bar.',
        'Nothing is sent to any device.',
        '',
        'Continue?  y / n',
      ],
      onYes: () => this.flash.simulate(this.now()),
    };
  }

  private setDemo(mode: DemoMode): void {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    this.demo = mode;
    this.monitor.active = mode !== 'off' || this.ports.state === 'open';
    if (mode === 'off') return;
    if (this.ports.state === 'open') {
      this.demo = 'off';
      this.notify('Disconnect the port before starting the demo stream', 'warn');
      return;
    }
    if (!this.monitor.pane.bytesIn) this.monitor.write(BOOT_BANNER, this.invalidate);
    // normal ≈ a chatty app; flood ≈ a saturated 2 Mbaud link (~200 KB/s).
    const perTick = mode === 'flood' ? 10_000 : 120;
    const tick = mode === 'flood' ? 50 : 100;
    this.demoTimer = setInterval(() => {
      // Like a real device, keep sending while the parser catches up; only cap the backlog.
      if (this.monitor.pane.backlog < 20)
        this.monitor.write(this.demoStream.next(perTick), this.invalidate);
    }, tick);
    this.notify(
      `Demo stream${mode === 'flood' ? ': flood (~2 Mbaud)' : ''}. Connecting a port stops it`,
      'info',
    );
  }

  private onPortState(s: PortState, detail?: string): void {
    this.monitor.active = s === 'open' || this.demo !== 'off';
    if (s !== 'open') this.monitor.live = false;
    if (detail && s === 'none') this.notify(`Port closed: ${detail}`, 'warn');
    this.invalidate();
  }

  /** Show a message in the bottom bar: warnings and errors for 8 s, the rest for 4 s. */
  notify(text: string, kind: MessageKind = 'info'): void {
    const ms = kind === 'warn' || kind === 'error' ? 8000 : 4000;
    this.message = { text, kind, until: this.now() + ms };
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.messageTimer = null;
      this.invalidate();
    }, ms + 20);
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Drawing

  private frame(): void {
    const { cols: w, rows: h } = this.tty;
    const screen = new Screen(w, h);
    const cursor: CursorState = { visible: false, x: 0, y: 0 };
    this.hits.clear();
    const ctx: Ctx = {
      screen,
      hits: this.hits,
      theme: this.theme,
      cursor,
      now: this.now(),
      invalidate: this.invalidate,
    };

    if (w < MIN_COLS || h < MIN_ROWS) this.drawTooSmall(ctx);
    else this.drawApp(ctx);

    this.tty.write(this.renderer.render(screen, cursor));
    this.frames++;
  }

  private drawTooSmall(ctx: Ctx): void {
    const { screen, theme } = ctx;
    const lines = [
      'Terminal too small',
      `${screen.cols}×${screen.rows} (need ${MIN_COLS}×${MIN_ROWS})`,
      'Enlarge the window or zoom out (Ctrl -)',
    ];
    const r = centered({ x: 0, y: 0, w: screen.cols, h: screen.rows }, 44, lines.length);
    lines.forEach((l, i) => {
      screen.text(r.x + Math.floor((r.w - stringWidth(l)) / 2), r.y + i, l, {
        fg: i ? theme.dim : theme.warn,
        attrs: i ? 0 : Attr.Bold,
      });
    });
  }

  private drawApp(ctx: Ctx): void {
    const { screen, theme } = ctx;
    const W = screen.cols;
    const H = screen.rows;
    const border = { fg: theme.border };

    // Frame: title, status, pane header, panes, separator, key bar, bottom.
    screen.box({ x: 0, y: 0, w: W, h: H }, border);
    this.link(ctx, 2, 0, 'ESP Web Tool', REPO_URL, { fg: theme.title, attrs: Attr.Bold });
    const ver = `v${__APP_VERSION__} · ${__GIT_SHA__}`;
    const release = `${REPO_URL}/releases/tag/v${__APP_VERSION__}`;
    this.link(ctx, W - 3 - stringWidth(ver), 0, ver, release, { fg: theme.dim });
    this.drawStatus(ctx, { x: 2, y: 1, w: W - 4, h: 1 });

    const main: Rect = { x: 1, y: 3, w: W - 2, h: H - 6 };
    const split = W >= SPLIT_COLS && !this.zoomed;
    screen.text(0, 2, '├', border);
    screen.hline(1, 2, W - 2, '─', border);
    screen.text(W - 1, 2, '┤', border);
    screen.text(0, H - 3, '├', border);
    screen.hline(1, H - 3, W - 2, '─', border);
    screen.text(W - 1, H - 3, '┤', border);

    // Clicking anywhere in a pane focuses it; widget hits drawn later take precedence.
    let flashRect: Rect | null = null;
    let monRect: Rect | null = null;
    if (split) {
      const flashW = Math.max(56, Math.min(76, Math.floor(main.w * 0.45)));
      const [l, , rr] = cols(main, [flashW, 1, { flex: 1 }]);
      flashRect = l!;
      monRect = rr!;
      screen.text(l!.x + l!.w, 2, '┬', border);
      screen.vline(l!.x + l!.w, main.y, main.h, '│', border);
      screen.text(l!.x + l!.w, H - 3, '┴', border);
    } else if (this.pane === 'flash') {
      flashRect = main;
    } else {
      monRect = main;
    }

    this.rects = { main, flash: flashRect, monitor: monRect };
    const focus = this.focused();
    if (flashRect) {
      this.paneTitle(ctx, flashRect.x, 'Flash', this.pane === 'flash', '1');
      ctx.hits.add(flashRect, (e) => e.action === 'down' && this.focusPane('flash'));
      screen.withClip(flashRect, () =>
        this.flash.render(ctx, flashRect!, this.pane === 'flash' ? focus : null),
      );
    }
    if (monRect) {
      const live = this.monitor.live;
      const title = 'Monitor';
      this.paneTitle(
        ctx,
        monRect.x,
        title,
        this.pane === 'monitor',
        '2',
        live ? theme.borderLive : undefined,
      );
      ctx.hits.add(monRect, (e) => e.action === 'down' && this.focusPane('monitor'));
      screen.withClip(monRect, () => this.monitor.render(ctx, monRect!));
    }

    const bar = { x: 2, y: H - 2, w: W - 4, h: 1 };
    if (this.message && this.message.until > ctx.now) this.drawMessage(ctx, bar, this.message);
    else keyBar(ctx, bar, this.hints());
    if (this.overlay) {
      ctx.cursor.visible = false; // no text cursor blinking through a dialog
      this.drawOverlay(ctx);
    }
  }

  /** Text that opens `url` when clicked, set into a border with a space each side. */
  private link(ctx: Ctx, x: number, y: number, text: string, url: string, style: Style): void {
    const { screen } = ctx;
    screen.text(x, y, ' ', {});
    const end = screen.text(x + 1, y, text, style);
    screen.text(end, y, ' ', {});
    ctx.hits.add(
      { x: x + 1, y, w: end - x - 1, h: 1 },
      (e) => e.action === 'down' && this.openUrl(url),
    );
  }

  /** Writes `─ 1 Flash ─` into the pane header row; returns the column after it. */
  private paneTitle(
    ctx: Ctx,
    x: number,
    title: string,
    focused: boolean,
    key: string,
    color?: number,
  ): number {
    const { screen, theme } = ctx;
    const c = color ?? (focused ? theme.borderFocus : theme.title);
    let cx = screen.text(x + 1, 2, ' ', {});
    cx = screen.text(cx, 2, key, { fg: theme.keyFg });
    cx = screen.text(cx, 2, ` ${title} `, { fg: c, attrs: focused ? Attr.Bold : 0 });
    if (focused) screen.text(x, 2, '━', { fg: c });
    return cx;
  }

  private drawStatus(ctx: Ctx, r: Rect): void {
    const { screen, theme } = ctx;
    const p = this.ports;
    let x = r.x;
    x = screen.text(x, r.y, 'PORT ', { fg: theme.dim });
    switch (p.state) {
      case 'unsupported':
        x = screen.text(
          x,
          r.y,
          '✗ Web Serial not supported in this browser (use Chrome or Edge on desktop)',
          { fg: theme.error },
        );
        break;
      case 'none':
        x = screen.text(x, r.y, '○ not connected', { fg: theme.fg });
        x = screen.text(x, r.y, '  press c', { fg: theme.dim });
        break;
      case 'opening':
        x = screen.text(x, r.y, `${spinner(ctx)} opening…`, { fg: theme.warn });
        break;
      case 'open':
        x = screen.text(x, r.y, '● ', { fg: theme.ok });
        x = screen.text(x, r.y, `${describePort(p.port!)} @ ${p.baudRate} ${p.format}`, {
          fg: theme.fg,
        });
        break;
      case 'error':
        x = screen.text(x, r.y, '✗ error', { fg: theme.error });
        break;
    }
    x = screen.text(x + 3, r.y, 'CHIP ', { fg: theme.dim });
    screen.text(x, r.y, '— (detection in M1)', { fg: theme.dim });

    const showRate = this.demo !== 'off' || p.state === 'open';
    const { rxPerSec, txPerSec, fps } = this.stats;
    const right = showRate
      ? `${this.demo !== 'off' ? `demo:${this.demo} ` : ''}rx ${formatSize(rxPerSec)}/s · tx ${formatSize(txPerSec)}/s · ${fps} fps`
      : '';
    if (right) screen.text(r.x + r.w - stringWidth(right), r.y, right, { fg: theme.dim });
  }

  private hints(): KeyHint[] {
    if (this.overlay?.kind === 'menu') {
      const menu = this.overlay.menu;
      return [
        { key: '↑↓', label: 'Move' },
        { key: '⏎', label: 'Select' },
        { key: 'Esc', label: menu.isSubmenu ? 'Back' : 'Close', action: () => menu.back() },
      ];
    }
    if (this.monitor.live) {
      return [
        { key: 'LIVE', label: 'keys go to the device' },
        { key: '^]', label: 'Leave', action: () => (this.monitor.live = false) },
        { key: '^A', label: 'Menu', action: () => this.openMonitorMenu() },
      ];
    }
    const connected = this.ports.port !== null;
    return [
      { key: 'c', label: connected ? 'Disconnect' : 'Connect', action: () => this.toggleConnect() },
      { key: 'F', label: 'Flash', action: () => this.startFlash() },
      { key: 'E', label: 'Erase' },
      { key: 's', label: 'Source', action: () => this.flash.source.cycle() },
      { key: 'Tab', label: 'Focus' },
      { key: '1/2', label: 'Pane' },
      { key: 'f', label: 'Fullscreen', action: () => this.toggleFullscreen() },
      { key: '⏎', label: 'Monitor', action: () => (this.focusPane('monitor'), this.enterLive()) },
      { key: 'D', label: 'Dump' },
      { key: '?', label: 'Help', action: () => (this.overlay = { kind: 'help', scroll: 0 }) },
    ];
  }

  /** `✓ Connected 303a:1001 @ 115200 8N1`: a colored mark, then the text. Click dismisses. */
  private drawMessage(ctx: Ctx, r: Rect, m: Message): void {
    const { screen, theme } = ctx;
    const [mark, color] = {
      info: ['•', theme.accent],
      ok: ['✓', theme.ok],
      warn: ['!', theme.warn],
      error: ['✗', theme.error],
    }[m.kind] as [string, number];
    screen.text(r.x, r.y, mark, { fg: color, attrs: Attr.Bold });
    screen.text(r.x + 2, r.y, m.text, { fg: m.kind === 'info' ? theme.fg : color }, r.w - 2);
    ctx.hits.add(r, (e) => {
      if (e.action === 'down') this.message = null;
    });
  }

  private drawOverlay(ctx: Ctx): void {
    const o = this.overlay!;
    const { screen, theme } = ctx;
    if (o.kind === 'menu') {
      o.menu.render(ctx);
      return;
    }
    if (o.kind === 'confirm') {
      const w = Math.max(...o.body.map(stringWidth), stringWidth(o.title)) + 6;
      const inner = dialog(ctx, o.title, w, o.body.length + 4, theme.warn);
      o.body.forEach((l, i) =>
        screen.text(inner.x + 2, inner.y + 1 + i, l, { fg: theme.fg, bg: theme.inputBg }),
      );
      return;
    }
    const lines = HELP;
    const h = Math.min(lines.length + 4, screen.rows - 4);
    const inner = dialog(ctx, 'Help · Esc to close', 70, h);
    // Wheel scrolls anywhere; a click outside the dialog closes it.
    const outer = { x: inner.x - 1, y: inner.y - 1, w: inner.w + 2, h: inner.h + 2 };
    ctx.hits.add({ x: 0, y: 0, w: screen.cols, h: screen.rows }, (e) => {
      if (e.action === 'wheelup') o.scroll = Math.max(0, o.scroll - 3);
      else if (e.action === 'wheeldown') o.scroll += 3;
      else if (e.action === 'down' && !contains(outer, e.x, e.y)) this.overlay = null;
    });
    const body = rows(inner, [1, { flex: 1 }, 1])[1]!;
    o.scroll = Math.max(0, Math.min(o.scroll, lines.length - body.h));
    lines.slice(o.scroll, o.scroll + body.h).forEach(([k, d], i) => {
      const y = body.y + i;
      if (!d) {
        screen.text(body.x + 2, y, k, { fg: theme.accent, bg: theme.inputBg, attrs: Attr.Bold });
        return;
      }
      screen.text(body.x + 2, y, k, { fg: theme.keyFg, bg: theme.inputBg, attrs: Attr.Bold });
      screen.text(body.x + 22, y, d, { fg: theme.fg, bg: theme.inputBg }, body.w - 24);
    });
  }
}

/** Settings key for a USB serial device ("303a:1001"); null when the port has no USB ids. */
function portKey(port: SerialPort): string | null {
  return port.getInfo().usbVendorId === undefined ? null : describePort(port);
}
