import { BOOT_BANNER, DemoStream } from '../monitor/demo';
import { describePort, errorText, PortManager, type PortState } from '../serial/port-manager';
import { InputParser, type InputEvent, type KeyEvent, type PasteEvent } from '../tty/input';
import type { Tty } from '../tty/tty';
import { HitMap, type Ctx } from '../tui/context';
import { centered, cols, rows } from '../tui/layout';
import { Renderer, type CursorState } from '../tui/renderer';
import { Screen, type Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import { darkTheme, type Theme } from '../tui/theme';
import { dialog, type Focusable, keyBar, type KeyHint, spinner } from '../tui/widgets';
import { stringWidth, truncate } from '../tui/width';
import { BAUD_RATES, FlashPane, formatSize } from './flash-pane';
import { HELP } from './help';
import { LINE_ENDINGS, MonitorPane } from './monitor-pane';

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
/** Below this width the panes are shown one at a time. */
export const SPLIT_COLS = 120;

/** Mouse tracking (button + drag, SGR encoding), bracketed paste, window title. */
const ENTER_APP = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b]0;ESP Web Tool\x07';

type Toast = { text: string; kind: 'info' | 'ok' | 'warn' | 'error'; until: number };
type Overlay =
  | { kind: 'help'; scroll: number }
  | { kind: 'confirm'; title: string; body: string[]; onYes: () => void };
type DemoMode = 'off' | 'normal' | 'flood';

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
  private overlay: Overlay | null = null;
  private toasts: Toast[] = [];
  private prefix = false;

  private parser = new InputParser();
  private renderer = new Renderer();
  private hits = new HitMap();
  private frameQueued = false;
  private now: () => number;
  private schedule: (fn: () => void) => void;
  private lastTrigger: 'key' | 'mouse' = 'key';

  private demo: DemoMode = 'off';
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private demoStream = new DemoStream();

  /** Stats for the status line (and the e2e perf check). */
  stats = { fps: 0, bytesPerSec: 0 };
  private frames = 0;
  private statBytes = 0;
  private statTimer: ReturnType<typeof setInterval>;

  constructor(opts: AppOptions) {
    this.tty = opts.tty;
    this.theme = opts.theme ?? darkTheme;
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn) => requestAnimationFrame(fn));
    this.ports = new PortManager({
      onData: (bytes) => this.monitor.write(bytes, () => this.invalidate()),
      onState: (s, detail) => this.onPortState(s, detail),
    });
    this.flash.onSimDone = () => this.toast('Simulated run finished (nothing was written)', 'ok');
    this.flash.source.onChange = () => (this.flashFocus = 0);

    this.tty.onData((d) => this.onData(d));
    this.tty.onResize(() => {
      this.renderer.invalidate();
      this.invalidate();
    });
    this.statTimer = setInterval(() => this.sampleStats(), 1000);
  }

  start(): void {
    this.tty.write(ENTER_APP);
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
    const bytes = this.monitor.pane.bytesIn;
    this.stats = { fps: this.frames, bytesPerSec: bytes - this.statBytes };
    this.frames = 0;
    this.statBytes = bytes;
    if (this.demo !== 'off' || this.ports.state === 'open') this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Input

  private onData(data: string): void {
    for (const e of this.parser.feed(data)) this.dispatch(e);
    this.invalidate();
  }

  private dispatch(e: InputEvent): void {
    if (e.type === 'mouse') {
      this.lastTrigger = 'mouse';
      const { owner } = this.hits.dispatch(e);
      if (e.action === 'down' && owner && !this.overlay) this.focusWidget(owner);
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
    if (e.ctrl || e.alt) return false;
    switch (e.name) {
      case 'c':
        this.toggleConnect();
        return true;
      case 'f':
        this.startFlash();
        return true;
      case 'E':
        this.toast('Erase arrives with esptool-js in M1', 'info');
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
      case 'z':
        this.zoomed = !this.zoomed;
        return true;
      case 'D':
        this.setDemo(this.demo === 'off' ? 'normal' : this.demo === 'normal' ? 'flood' : 'off');
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
    if (this.prefix) {
      this.prefix = false;
      this.monitorMenu(e);
      return;
    }
    if (e.ctrl && e.name === ']') {
      this.monitor.live = false;
      return;
    }
    if (e.ctrl && e.name === 'a') {
      this.prefix = true;
      return;
    }
    this.monitor.pane.scrollToBottom();
    this.send(e.name === 'enter' ? this.monitor.lineEnding.value : e.raw);
  }

  private monitorMenu(e: KeyEvent): void {
    const ports = this.ports;
    const open = ports.state === 'open';
    switch (e.ctrl ? `^${e.name}` : e.name) {
      case '^a':
        this.send('\x01');
        break;
      case 'r':
        if (open) void ports.reset().then(() => this.toast('Reset sent', 'ok'));
        break;
      case 'b':
        if (open)
          void ports
            .enterBootloader()
            .then(() =>
              this.toast(
                `Boot mode sequence sent (${ports.usbJtag ? 'USB-JTAG' : 'DTR/RTS'})`,
                'ok',
              ),
            );
        break;
      case 'c':
        this.monitor.clear();
        break;
      case 'h':
        this.monitor.toggleColorize();
        this.toast(`Log level colors: ${this.monitor.colorize ? 'on' : 'off'}`, 'info');
        break;
      case 'e':
        this.monitor.eol = (this.monitor.eol + 1) % LINE_ENDINGS.length;
        this.toast(`Line ending: ${this.monitor.lineEnding.label}`, 'info');
        break;
      case '+':
      case '=':
      case '-': {
        const list = [9600, 19200, 38400, 57600, 74880, ...BAUD_RATES];
        const i = list.indexOf(ports.baudRate);
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.name === '-' ? -1 : 1)))]!;
        if (open) void ports.setBaud(next).then(() => this.toast(`Baud: ${next}`, 'info'));
        else ports.baudRate = next;
        break;
      }
      case 'z':
        this.zoomed = !this.zoomed;
        break;
      case 't':
      case 'l':
        this.toast('Timestamps and log saving arrive in M2', 'info');
        break;
      case 'escape':
        break;
      default:
        this.toast(
          '^A menu: r reset · b boot · c clear · e line end · h colors · +/- baud · z zoom',
          'info',
        );
    }
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
      this.toast(
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
      this.toast('Web Serial is not available: use Chrome, Edge or Opera on desktop', 'error');
      return;
    }
    if (ports.port) {
      void ports.close().then(() => this.toast('Disconnected', 'info'));
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
        return ports.open(port).then(() => {
          this.setDemo('off');
          this.monitor.clear();
          this.focusPane('monitor');
          this.toast(
            `Connected ${describePort(port)} @ ${ports.baudRate} (picked via ${record.trigger})`,
            'ok',
          );
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          record.result = 'cancelled';
          this.toast('No port selected', 'warn');
        } else {
          record.detail = errorText(err);
          this.toast(`Could not open port: ${record.detail}`, 'error');
        }
      })
      .finally(() => this.invalidate());
  }

  private startFlash(): void {
    if (this.flash.running) return;
    const parts = this.flash.parts.items.filter((p) => p.enabled);
    if (parts.length === 0) {
      this.toast('No parts enabled', 'warn');
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
      this.toast('Disconnect the port before starting the demo stream', 'warn');
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
    this.toast(
      mode === 'flood'
        ? 'Demo stream: flood (~2 Mbaud). D again to stop'
        : 'Demo stream on. D again for flood',
      'info',
    );
  }

  private onPortState(s: PortState, detail?: string): void {
    this.monitor.active = s === 'open' || this.demo !== 'off';
    if (s !== 'open') this.monitor.live = false;
    if (detail && s === 'none') this.toast(`Port closed: ${detail}`, 'warn');
    this.invalidate();
  }

  toast(text: string, kind: Toast['kind'] = 'info'): void {
    this.toasts = [...this.toasts.slice(-2), { text, kind, until: this.now() + 4000 }];
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
    screen.text(2, 0, ' ESP Web Tool ', { fg: theme.title, attrs: Attr.Bold });
    const ver = ` v${__APP_VERSION__} · ${__GIT_SHA__} `;
    screen.text(W - 2 - stringWidth(ver), 0, ver, { fg: theme.dim });
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
      const title = live ? 'Monitor ● LIVE' : 'Monitor';
      const info = `${this.ports.baudRate} 8N1 · ${this.monitor.lineEnding.label}`;
      const end = this.paneTitle(
        ctx,
        monRect.x,
        title,
        this.pane === 'monitor',
        '2',
        live ? theme.borderLive : undefined,
      );
      screen.text(end + 1, 2, ` ${info} `, { fg: theme.dim });
      ctx.hits.add(monRect, (e) => e.action === 'down' && this.focusPane('monitor'));
      screen.withClip(monRect, () => this.monitor.render(ctx, monRect!));
    }

    keyBar(ctx, { x: 2, y: H - 2, w: W - 4, h: 1 }, this.hints());
    this.drawToasts(ctx, main);
    if (this.overlay) this.drawOverlay(ctx);
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
        x = screen.text(x, r.y, `${describePort(p.port!)} @ ${p.baudRate}`, { fg: theme.fg });
        break;
      case 'error':
        x = screen.text(x, r.y, '✗ error', { fg: theme.error });
        break;
    }
    x = screen.text(x + 3, r.y, 'CHIP ', { fg: theme.dim });
    screen.text(x, r.y, '— (detection in M1)', { fg: theme.dim });

    const showRate = this.demo !== 'off' || p.state === 'open';
    const right = showRate
      ? `${this.demo !== 'off' ? `demo:${this.demo} ` : ''}rx ${formatSize(this.stats.bytesPerSec)}/s · ${this.stats.fps} fps`
      : '';
    if (right) screen.text(r.x + r.w - stringWidth(right), r.y, right, { fg: theme.dim });
  }

  private hints(): KeyHint[] {
    if (this.monitor.live && this.prefix) {
      return [
        { key: 'r', label: 'Reset' },
        { key: 'b', label: 'Boot' },
        { key: 'c', label: 'Clear' },
        { key: 'e', label: 'Line end' },
        { key: 'h', label: 'Colors' },
        { key: '+/-', label: 'Baud' },
        { key: 'z', label: 'Zoom' },
        { key: '^A', label: 'Send ^A' },
        { key: 'Esc', label: 'Cancel' },
      ];
    }
    if (this.monitor.live) {
      return [
        { key: 'LIVE', label: 'keys go to the device' },
        { key: '^]', label: 'Leave', action: () => (this.monitor.live = false) },
        { key: '^A', label: 'Menu', action: () => (this.prefix = true) },
      ];
    }
    const connected = this.ports.port !== null;
    return [
      { key: 'c', label: connected ? 'Disconnect' : 'Connect', action: () => this.toggleConnect() },
      { key: 'f', label: 'Flash', action: () => this.startFlash() },
      { key: 'E', label: 'Erase' },
      { key: 's', label: 'Source', action: () => this.flash.source.cycle() },
      { key: 'Tab', label: 'Focus' },
      { key: '1/2', label: 'Pane' },
      { key: 'z', label: 'Zoom', action: () => (this.zoomed = !this.zoomed) },
      { key: '⏎', label: 'Monitor', action: () => (this.focusPane('monitor'), this.enterLive()) },
      {
        key: 'D',
        label: 'Demo',
        action: () => this.setDemo(this.demo === 'off' ? 'normal' : 'off'),
      },
      { key: '?', label: 'Help', action: () => (this.overlay = { kind: 'help', scroll: 0 }) },
    ];
  }

  private drawToasts(ctx: Ctx, main: Rect): void {
    const { screen, theme } = ctx;
    const now = ctx.now;
    this.toasts = this.toasts.filter((t) => t.until > now);
    if (!this.toasts.length) return;
    ctx.invalidate();
    let y = main.y + main.h - 1;
    for (const t of [...this.toasts].reverse()) {
      const color = { info: theme.accent, ok: theme.ok, warn: theme.warn, error: theme.error }[
        t.kind
      ];
      const text = ` ${truncate(t.text, main.w - 6)} `;
      const w = stringWidth(text) + 2;
      const x = main.x + main.w - w - 1;
      screen.text(x, y, '▌', { fg: color, bg: theme.inputBg });
      screen.text(x + 1, y, text, { fg: theme.fg, bg: theme.inputBg });
      screen.text(x + w - 1, y, ' ', { bg: theme.inputBg });
      y--;
    }
  }

  private drawOverlay(ctx: Ctx): void {
    const o = this.overlay!;
    const { screen, theme } = ctx;
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
