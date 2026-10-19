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
import { sameChip, sizeBytes } from '../flash/chip';
import { formatOffset } from '../flash/offsets';
import { checkPlan } from '../flash/validate';
import { DumpDialog } from './dump-dialog';
import { BAUD_RATES, FlashPane, formatSize, isSavedFlash } from './flash-pane';
import { HELP } from './help';
import { JobCancelled, JobRunner } from './jobs';
import { PartEditor } from './part-editor';
import { LINE_ENDINGS, MonitorPane } from './monitor-pane';
import type { FileHost } from '../flash/host';
import {
  type KeyValueStore,
  type DeviceSettings,
  rememberDevice,
  type Settings,
  SettingsStore,
  type ValueStore,
} from './settings';

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
/** Below this width the panes are shown one at a time. */
export const SPLIT_COLS = 120;

export const REPO_URL = 'https://github.com/KamranAghlami/esp_web_tool';
/** Monitor baud choices: slow ROM/legacy rates, then the flasher's. */
const MONITOR_BAUDS = [9600, 19200, 38400, 57600, 74880, ...BAUD_RATES];

/**
 * Alternate screen (like vim or htop: no scrollback, no reflow on resize, so the frame can't
 * drift), mouse tracking (button + drag, SGR encoding), bracketed paste, window title.
 */
const ENTER_APP = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b]0;ESP Web Tool\x07';

type MessageKind = 'info' | 'ok' | 'warn' | 'error';
/** A message shown in the bottom bar in place of the key hints, until it expires or a key. */
type Message = { text: string; kind: MessageKind; until: number };
type Overlay =
  | { kind: 'help'; scroll: number }
  | { kind: 'confirm'; title: string; body: string[]; danger: boolean; answer(yes: boolean): void }
  | { kind: 'menu'; menu: Menu }
  | { kind: 'part'; editor: PartEditor }
  | { kind: 'dump'; dialog: DumpDialog };
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
  /** Where the flash plan (with file handles) is kept per device: IndexedDB in the page. */
  plans?: ValueStore;
  /** File pickers, folder access and fetch for the flash plan (`src/browser/files.ts`). */
  files: FileHost;
  /** Asset proxy base URL for GitHub release files (SPEC §7.4); none until it exists. */
  assetProxy?: string;
  /** Manifest field value from the URL (`?manifest=`, `?repo=`); loaded on start. */
  manifest?: string;
  /**
   * Synthetic log stream into the monitor, for trying it without a device and for the
   * throughput test. Only from the URL (`?demo`, `?demo=flood`); no key starts it.
   */
  demo?: DemoMode;
}

export class App {
  readonly tty: Tty;
  readonly theme: Theme;
  readonly flash: FlashPane;
  readonly monitor = new MonitorPane();
  readonly ports: PortManager;
  readonly jobs: JobRunner;
  readonly spike: SpikeRecord[] = [];
  private files: FileHost;

  /** Which pane has focus, and which widget inside the flash pane. */
  pane: 'flash' | 'monitor' = 'flash';
  /** The focused widget in the Flash pane (null until the pane exists: the parts table). */
  private flashFocus: Focusable | null = null;
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
  private plans?: ValueStore;
  /** Plans are saved only once the remembered one was restored (or there was none). */
  private planReady = false;
  private planTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.plans = opts.plans;
    this.files = opts.files;
    this.flash = new FlashPane(
      opts.files,
      () => {
        this.invalidate();
        this.queuePlanSave();
      },
      opts.assetProxy,
    );
    this.flash.parts.onNotify = (text, kind) => this.notify(text, kind);
    this.flash.parts.onEdit = (row) => {
      const editor = new PartEditor(
        this.flash.plan,
        row,
        () => {
          if (this.overlay?.kind === 'part' && this.overlay.editor === editor) this.overlay = null;
          this.invalidate();
        },
        (text) => this.notify(text, 'warn'),
      );
      this.overlay = { kind: 'part', editor };
    };
    // After Enter in the Manifest field, the table is where the next keys belong.
    this.flash.onSubmitted = () => this.focusWidget(this.flash.parts);
    this.flash.release.onOpen = () => {
      const plan = this.flash.plan;
      this.openMenu(
        'Release',
        (plan.releases ?? []).map((r, i) => ({
          label: `${r.tag}  ${r.date}${r.prerelease ? '  pre' : ''}${r.draft ? '  draft' : ''}`,
          checked: i === plan.releaseIndex,
          action: () => plan.selectRelease(i),
        })),
        { within: this.rects.flash ?? undefined },
      );
    };
    this.flash.set.onOpen = () => {
      const plan = this.flash.plan;
      this.openMenu(
        'Set',
        (plan.manifest?.sets ?? []).map((set, i) => ({
          label: set.chip && set.chip !== set.name ? `${set.name}  (${set.chip})` : set.name,
          checked: i === plan.setIndex,
          action: () => plan.selectSet(i),
        })),
        { within: this.rects.flash ?? undefined },
      );
    };
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
    this.jobs = new JobRunner({
      ports: this.ports,
      // esptool's per-block "Writing at 0x…" lines would flood the monitor; the bar shows that.
      log: (text) => {
        if (!/^Writing at 0x/.test(text)) this.monitor.note(text, this.invalidate);
      },
      changed: this.invalidate,
      now: this.now,
    });
    this.flash.jobs = this.jobs;
    this.startDemo = opts.demo ?? 'off';
    this.store = new SettingsStore(opts.storage);
    this.settings = this.store.load();
    this.applySettings(this.settings.last);
    this.pane = this.settings.ui.pane;
    this.zoomed = this.settings.ui.fullscreen;
    if (opts.manifest) {
      this.useManifest(opts.manifest);
      this.planReady = true;
    } else {
      void this.restorePlan('last', this.settings.last.flash.manifest);
    }

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

  /** Puts a remembered snapshot into the widgets and the port manager (the plan: restorePlan). */
  private applySettings({ flash, monitor }: DeviceSettings): void {
    const f = this.flash;
    f.baud.index = Math.max(0, BAUD_RATES.indexOf(flash.baud as (typeof BAUD_RATES)[number]));
    f.eraseAll.checked = flash.eraseAll;
    f.verify.checked = flash.verify;
    f.resetAfter.checked = flash.resetAfter;
    this.ports.baudRate = monitor.baud;
    this.ports.format = monitor.format;
    this.monitor.eol = monitor.eol;
    if (this.monitor.colorize !== monitor.colorize) this.monitor.toggleColorize();
  }

  /**
   * Brings back the flash plan kept for `key` ("last" or a vid:pid): the manifest, the rows as
   * edited, picked files. Without one, falls back to loading the remembered Manifest field.
   */
  private async restorePlan(key: string, fallback: string): Promise<void> {
    let saved: unknown;
    try {
      saved = await this.plans?.get(key);
    } catch {
      saved = undefined;
    }
    if (isSavedFlash(saved)) {
      this.flash.restore(saved);
      // localStorage is written at once; IndexedDB can lose an edit made just before a reload.
      if (fallback && fallback !== saved.field) this.flash.manifest.setValue(fallback);
    } else if (fallback !== this.flash.manifest.value) this.useManifest(fallback);
    this.planReady = true;
    this.invalidate();
  }

  /** Plans also change from async reads; those changes are saved shortly after. */
  private queuePlanSave(): void {
    if (!this.plans || !this.planReady || this.planTimer) return;
    this.planTimer = setTimeout(() => this.savePlan(), 300);
  }

  /** Saves the plan as the last used, and for the connected device. */
  private savePlan(): void {
    if (this.planTimer) clearTimeout(this.planTimer);
    this.planTimer = null;
    if (!this.plans || !this.planReady) return;
    const saved = this.flash.save();
    // A put can fail (a handle the browser can't store, quota): that plan just isn't kept.
    const put = (key: string) => void this.plans!.put(key, saved).catch(() => {});
    put('last');
    const key = this.ports.port && portKey(this.ports.port);
    if (key && this.ports.state === 'open') put(key);
  }

  /** Put `text` in the Manifest field and load it (empty clears the field only). */
  private useManifest(text: string): void {
    this.flash.manifest.setValue(text);
    if (text.trim()) void this.flash.plan.load(text);
  }

  private snapshot(): DeviceSettings {
    const f = this.flash;
    return {
      flash: {
        // A picked file's name can't be reopened after a reload, so it isn't kept.
        manifest: f.manifest.value === f.plan.localName ? '' : f.manifest.value,
        baud: f.baud.value,
        eraseAll: f.eraseAll.checked,
        verify: f.verify.checked,
        resetAfter: f.resetAfter.checked,
      },
      monitor: {
        baud: this.ports.baudRate,
        format: this.ports.format,
        eol: this.monitor.eol,
        colorize: this.monitor.colorize,
      },
    };
  }

  /** Records the current state as the last used, and for the connected device; written if changed. */
  private saveSettings(): void {
    const s = this.settings;
    s.last = this.snapshot();
    s.ui = { pane: this.pane, fullscreen: this.zoomed };
    const key = this.ports.port && portKey(this.ports.port);
    if (key && this.ports.state === 'open') rememberDevice(s.devices, key, s.last);
    this.store.save(s);
    // Input saves at once, so a reload right after an edit keeps it.
    this.savePlan();
  }

  private dispatch(e: InputEvent): void {
    if (e.type === 'mouse') {
      this.lastTrigger = 'mouse';
      // A click on a widget focuses it, even if the click also opened an overlay (a menu).
      const covered = this.overlay;
      const { owner } = this.hits.dispatch(e);
      if (e.action === 'down' && owner && !covered) this.focusWidget(owner);
      if (e.action === 'down' && covered?.kind === 'part') covered.editor.clicked(owner);
      if (e.action === 'down' && covered?.kind === 'dump') covered.dialog.clicked(owner);
      return;
    }
    this.lastTrigger = 'key';

    if (this.overlay) {
      if (e.type === 'key') this.overlayKey(e);
      else if (this.overlay.kind === 'part') this.overlay.editor.handlePaste(e.text);
      else if (this.overlay.kind === 'dump') this.overlay.dialog.handlePaste(e.text);
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
      // The widget may use Esc itself (e.g. to cancel an inline edit); otherwise it leaves.
      if (!focus.handleKey(e) && e.name === 'escape') this.cycleFocus(1);
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
    if (this.jobs.running) {
      if (e.name === 'escape') {
        this.askCancel();
        return true;
      }
      if (['c', 'F', 'E', 'D', 'i'].includes(e.name)) {
        this.notify('The flasher is busy: Esc stops it', 'warn');
        return true;
      }
    }
    switch (e.name) {
      case 'c':
        this.toggleConnect();
        return true;
      case 'i':
        this.identify();
        return true;
      case 'F':
        this.startFlash();
        return true;
      case 'f':
        this.toggleFullscreen();
        return true;
      case 'E':
        this.startErase();
        return true;
      case '1':
        this.focusPane('flash');
        return true;
      case '2':
        this.focusPane('monitor');
        return true;
      case 'D':
        this.openDump();
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
    if (o.kind === 'part') {
      o.editor.handleKey(e);
      return;
    }
    if (o.kind === 'dump') {
      o.dialog.handleKey(e);
      return;
    }
    if (o.kind === 'help') {
      if (e.name === 'escape' || e.name === 'q' || e.name === '?' || e.name === 'enter')
        this.overlay = null;
      else if (e.name === 'down' || e.name === 'j') o.scroll++;
      else if (e.name === 'up' || e.name === 'k') o.scroll = Math.max(0, o.scroll - 1);
      else if (e.name === 'pagedown' || e.name === ' ') o.scroll += 10;
      else if (e.name === 'pageup') o.scroll = Math.max(0, o.scroll - 10);
      else if (e.name === 'G' || e.name === 'end')
        o.scroll = HELP.length; // clamped when drawn
      else if (e.name === 'g' || e.name === 'home') o.scroll = 0;
      return;
    }
    if (e.name === 'y' || e.name === 'Y' || (e.name === 'enter' && !o.danger)) {
      this.overlay = null;
      o.answer(true);
    } else if (e.name === 'n' || e.name === 'N' || e.name === 'escape') {
      this.overlay = null;
      o.answer(false);
    }
  }

  /**
   * A yes/no dialog. Dangerous ones (erase, stopping a flash) take only `y`, not Enter, so a
   * stray Enter can't confirm them.
   */
  private ask(title: string, body: string[], danger = false): Promise<boolean> {
    return new Promise((resolve) => {
      this.overlay = { kind: 'confirm', title, body, danger, answer: resolve };
      this.invalidate();
    });
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
    // A widget that went away (e.g. the Set picker of a one-set manifest) falls back to the table.
    const list = this.flash.focusables();
    return this.flashFocus && list.includes(this.flashFocus) ? this.flashFocus : this.flash.parts;
  }

  private cycleFocus(d: number): void {
    const ring = this.ring();
    const cur = ring.indexOf(this.focused()!);
    const next = (cur + d + ring.length) % ring.length;
    if (ring[next] === this.monitor) {
      this.pane = 'monitor';
    } else {
      this.pane = 'flash';
      this.flashFocus = ring[next]!;
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
    if (this.flash.focusables().includes(w as Focusable)) {
      this.pane = 'flash';
      this.flashFocus = w as Focusable;
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
        // A device seen before gets back everything it had last time (flash and monitor).
        const key = portKey(port);
        const known = key ? this.settings.devices[key] : undefined;
        if (known) {
          this.applySettings(known);
          void this.restorePlan(key!, known.flash.manifest);
        }
        return ports.open(port).then(() => {
          this.setDemo('off');
          this.monitor.clear();
          this.focusPane('monitor');
          this.saveSettings();
          this.notify(
            `Connected ${describePort(port)} @ ${ports.baudRate} ${ports.format}` +
              (known ? ' (settings restored)' : ''),
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

  /** The flasher needs the port open in the monitor first; it borrows it from there. */
  private needPort(): boolean {
    if (this.ports.state === 'open') return true;
    this.notify(
      this.ports.state === 'busy' ? 'The flasher is busy' : 'Connect a port first (c)',
      'warn',
    );
    return false;
  }

  /** `F`: check the plan, confirm, then flash (SPEC §5.5, §5.6). */
  private startFlash(): void {
    if (this.jobs.running) return;
    const f = this.flash;
    const pre = checkPlan(f.plan, this.jobs.chip ?? undefined);
    if (pre.errors.length) {
      this.notify(pre.errors[0]!, 'warn');
      return;
    }
    if (!this.needPort()) return;
    const parts = f.plan.rows.filter((p) => p.enabled);
    const total = parts.reduce((n, p) => n + p.data!.length, 0);
    const list = parts.slice(0, 8).map((p) => `  ${formatOffset(p.offset)}  ${p.name}`);
    if (parts.length > 8) list.push(`  … ${parts.length - 8} more`);
    const body = [
      `${parts.length} part${parts.length === 1 ? '' : 's'} · ${formatSize(total)} · ${f.baud.value} baud` +
        (f.eraseAll.checked ? ' · erase all first' : ''),
      ...list,
      ...(pre.warnings.length ? ['', ...pre.warnings.map((w) => `! ${w}`)] : []),
    ];
    void this.ask('Flash', body).then((yes) => {
      if (yes) void this.runFlash(pre.warnings);
    });
  }

  private async runFlash(confirmed: string[]): Promise<void> {
    const f = this.flash;
    const plan = f.plan;
    const jobs = this.jobs;
    this.monitor.note('\n── flash ──\n', this.invalidate);
    const res = await jobs.run(
      'flash',
      f.baud.value,
      // A set may give the app's baud; the monitor switches to it after flashing.
      { reset: f.resetAfter.checked, baudRate: () => plan.set?.monitorBaudrate },
      async (s) => {
        const chip = s.info;
        plan.applyChip(chip.bootloaderOffset);
        const want = plan.set?.chip;
        if (want && !sameChip(want, chip.name)) {
          const i = plan.setFor(chip.name);
          if (i >= 0) {
            plan.selectSet(i);
            throw new Error(
              `The set was for ${want}: the ${chip.name} set is now selected, F again`,
            );
          }
        }
        const checks = checkPlan(plan, chip);
        if (checks.errors.length) throw new Error(checks.errors[0]);
        const fresh = checks.warnings.filter((w) => !confirmed.includes(w));
        if (
          fresh.length &&
          !(await this.ask(
            'Flash: check these first',
            fresh.map((w) => `! ${w}`),
          ))
        )
          throw new JobCancelled();
        jobs.checkCancelled();

        const parts = plan.rows
          .filter((r) => r.enabled)
          .map((r) => ({ name: r.name, offset: r.offset, data: r.data! }));
        const total = parts.reduce((n, p) => n + p.data.length, 0);
        const t0 = this.now();
        if (f.eraseAll.checked) {
          jobs.step('Erasing', null);
          await s.erase();
        }
        let current = -1;
        await s.write(parts, {
          verify: f.verify.checked,
          flashMode: plan.set?.flash?.mode,
          flashFreq: plan.set?.flash?.freq,
          onProgress: (i, frac) => {
            const part = parts[i]!;
            if (i !== current) {
              current = i;
              jobs.step(part.name, null, part.data.length);
            }
            const before = parts.slice(0, i).reduce((n, p) => n + p.data.length, 0);
            jobs.progress((before + frac * part.data.length) / total, frac * part.data.length);
          },
        });
        const secs = ((this.now() - t0) / 1000).toFixed(1);
        return (
          `Flashed ${parts.length} part${parts.length === 1 ? '' : 's'} (${formatSize(total)})` +
          `${f.verify.checked ? ', verified,' : ''} in ${secs} s`
        );
      },
    );
    this.notify(res.text, res.ok ? 'ok' : 'error');
  }

  /** `E`: erase the whole flash chip, after a confirmation that Enter can't give. */
  private startErase(): void {
    if (this.jobs.running || !this.needPort()) return;
    const body = [
      'Erases the whole flash chip: firmware, settings (NVS) and file systems.',
      "This can't be undone.  y to erase, n or Esc to keep it",
    ];
    void this.ask('Erase flash', body, true).then(async (yes) => {
      if (!yes) return;
      this.monitor.note('\n── erase ──\n', this.invalidate);
      const res = await this.jobs.run('erase', 115200, { reset: true }, async (s) => {
        const t0 = this.now();
        this.jobs.step('Erasing', null);
        await s.erase();
        const size = s.info.flashSize ? `the ${s.info.flashSize} flash` : 'the flash';
        return `Erased ${size} in ${((this.now() - t0) / 1000).toFixed(1)} s`;
      });
      this.notify(res.text, res.ok ? 'ok' : 'error');
    });
  }

  /** `D`: the Dump dialog, then read and save a file. */
  private openDump(): void {
    if (this.jobs.running || !this.needPort()) return;
    const dialog = new DumpDialog(
      (offset, size) => void this.runDump(offset, size),
      () => {
        if (this.overlay?.kind === 'dump') this.overlay = null;
        this.invalidate();
      },
      (text) => this.notify(text, 'warn'),
    );
    this.overlay = { kind: 'dump', dialog };
  }

  private async runDump(offset: number, size: number | null): Promise<void> {
    const jobs = this.jobs;
    this.monitor.note('\n── dump ──\n', this.invalidate);
    const res = await jobs.run(
      'dump',
      this.flash.baud.value,
      { reset: this.flash.resetAfter.checked },
      async (s) => {
        const flash = sizeBytes(s.info.flashSize);
        const n = size ?? (flash !== null ? flash - offset : null);
        if (!n || n <= 0) throw new Error("The flash size wasn't detected: give a size");
        jobs.step(`Reading ${formatSize(n)}`, 0, n);
        const data = await s.read(offset, n, (done) => jobs.progress(done / n, done));
        const mac = (s.info.mac ?? '').replace(/:/g, '');
        // esp32-s3-3485…-0x000000-0x400000.bin: chip, MAC, offset, size
        const name = `${s.info.name.toLowerCase()}${mac ? `-${mac}` : ''}-${formatOffset(offset)}-${formatOffset(n)}.bin`;
        this.files.save(name, data);
        return `Saved ${name}`;
      },
    );
    this.notify(res.text, res.ok ? 'ok' : 'error');
  }

  /** `i`: reset into the bootloader, read the chip's details, and reset back into the app. */
  private identify(): void {
    if (this.jobs.running || !this.needPort()) return;
    this.monitor.note('\n── chip info ──\n', this.invalidate);
    void this.jobs
      .run('identify', 115200, { reset: true }, async (s) => {
        const c = s.info;
        const i = this.flash.plan.setFor(c.name);
        if (i >= 0 && i !== this.flash.plan.setIndex) this.flash.plan.selectSet(i);
        return [c.description, c.flashSize && `${c.flashSize} flash`, c.mac && `MAC ${c.mac}`]
          .filter(Boolean)
          .join(' · ');
      })
      .then((res) => this.notify(res.text, res.ok ? 'ok' : 'error'));
  }

  /** Esc while a job runs: stopping a flash halfway can leave the chip unbootable. */
  private askCancel(): void {
    const flashing = this.jobs.state?.kind === 'flash';
    const body = flashing
      ? [
          'Stopping halfway leaves the chip without a complete firmware:',
          'it may not boot until it is flashed again.  y to stop',
        ]
      : ['Stop the running job?  y to stop'];
    void this.ask('Stop', body, flashing).then((yes) => {
      if (yes) void this.jobs.cancel();
    });
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
    if (s === 'none') this.jobs.chip = null;
    if (detail === 'reconnected')
      this.notify(`Reconnected ${describePort(this.ports.port!)}`, 'ok');
    else if (detail && s === 'none') this.notify(`Port closed: ${detail}`, 'warn');
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
      case 'busy':
        x = screen.text(x, r.y, `${spinner(ctx)} `, { fg: theme.warn });
        x = screen.text(x, r.y, `${describePort(p.port!)} · flasher`, { fg: theme.fg });
        break;
      case 'error':
        x = screen.text(x, r.y, '✗ error', { fg: theme.error });
        break;
    }
    x = screen.text(x + 3, r.y, 'CHIP ', { fg: theme.dim });
    const chip = this.jobs.chip;
    if (chip) {
      // `ESP32-S3 (QFN56) (revision v0.2)` → `ESP32-S3 (QFN56) rev v0.2`
      const name = chip.description.replace(/\(revision (v[\d.]+)\)/, 'rev $1');
      x = screen.text(x, r.y, name, { fg: theme.fg });
      if (chip.flashSize) {
        x = screen.text(x + 3, r.y, 'FLASH ', { fg: theme.dim });
        x = screen.text(x, r.y, chip.flashSize, { fg: theme.fg });
      }
      if (chip.mac) {
        x = screen.text(x + 3, r.y, 'MAC ', { fg: theme.dim });
        x = screen.text(x, r.y, chip.mac, { fg: theme.fg });
      }
    } else {
      x = screen.text(x, r.y, p.port ? '— i to detect' : '—', { fg: theme.dim });
    }

    const showRate = this.demo !== 'off' || p.state === 'open';
    const { rxPerSec, txPerSec, fps } = this.stats;
    const right = showRate
      ? `${this.demo !== 'off' ? `demo:${this.demo} ` : ''}rx ${formatSize(rxPerSec)}/s · tx ${formatSize(txPerSec)}/s · ${fps} fps`
      : '';
    // The rates give way to the chip details when the line is too short for both.
    if (right && x + 2 <= r.x + r.w - stringWidth(right))
      screen.text(r.x + r.w - stringWidth(right), r.y, right, { fg: theme.dim });
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
    if (this.overlay?.kind === 'part') {
      const editor = this.overlay.editor;
      return [
        { key: 'Tab', label: 'Next field' },
        { key: '⏎', label: editor.row ? 'Save' : 'Add', action: () => editor.save() },
        { key: 'Esc', label: 'Cancel', action: () => (this.overlay = null) },
      ];
    }
    if (this.overlay?.kind === 'dump') {
      const dialog = this.overlay.dialog;
      return [
        { key: 'Tab', label: 'Next field' },
        { key: '⏎', label: 'Read', action: () => dialog.submit() },
        { key: 'Esc', label: 'Cancel', action: () => (this.overlay = null) },
      ];
    }
    if (this.overlay?.kind === 'confirm') {
      const o = this.overlay;
      const answer = (yes: boolean) => () => {
        this.overlay = null;
        o.answer(yes);
      };
      return [
        { key: 'y', label: 'Yes', action: answer(true) },
        { key: 'n', label: 'No', action: answer(false) },
        { key: 'Esc', label: 'No', action: answer(false) },
      ];
    }
    if (this.jobs.running) {
      return [
        { key: 'Esc', label: 'Stop', action: () => this.askCancel() },
        { key: '1/2', label: 'Pane' },
        { key: 'f', label: 'Fullscreen', action: () => this.toggleFullscreen() },
        { key: '?', label: 'Help', action: () => (this.overlay = { kind: 'help', scroll: 0 }) },
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
    const parts = this.flash.parts;
    // The parts table's own keys go in the middle, in place of the focus/pane hints.
    const local: KeyHint[] =
      this.pane === 'flash' && this.focused() === parts
        ? [
            { key: 'a', label: 'Add', action: () => parts.add() },
            { key: 'e', label: 'Edit' },
            { key: 'd', label: 'Delete' },
            { key: 'Space', label: 'On/off' },
          ]
        : [
            { key: 'Tab', label: 'Focus' },
            { key: '1/2', label: 'Pane' },
          ];
    return [
      { key: 'c', label: connected ? 'Disconnect' : 'Connect', action: () => this.toggleConnect() },
      { key: 'F', label: 'Flash', action: () => this.startFlash() },
      { key: 'E', label: 'Erase', action: () => this.startErase() },
      ...local,
      { key: 'f', label: 'Fullscreen', action: () => this.toggleFullscreen() },
      { key: '⏎', label: 'Monitor', action: () => (this.focusPane('monitor'), this.enterLive()) },
      { key: 'D', label: 'Dump', action: () => this.openDump() },
      { key: 'i', label: 'Chip', action: () => this.identify() },
      { key: '?', label: 'Help', action: () => (this.overlay = { kind: 'help', scroll: 0 }) },
    ];
  }

  /** Body lines (`! …` in the warning color), then clickable `y Yes` / `n No`. */
  private drawConfirm(ctx: Ctx, o: Extract<Overlay, { kind: 'confirm' }>): void {
    const { screen, theme } = ctx;
    const bg = theme.inputBg;
    const w = Math.min(
      screen.cols - 4,
      Math.max(36, ...o.body.map(stringWidth), stringWidth(o.title)) + 6,
    );
    const inner = dialog(ctx, o.title, w, o.body.length + 6, o.danger ? theme.error : theme.warn);
    o.body.forEach((l, i) =>
      screen.text(
        inner.x + 2,
        inner.y + 1 + i,
        l,
        { fg: l.startsWith('!') ? theme.warn : theme.fg, bg },
        inner.w - 3,
      ),
    );
    const y = inner.y + inner.h - 2;
    let x = inner.x + Math.floor((inner.w - 17) / 2);
    for (const [key, label, yes] of [
      ['y', 'Yes', true],
      ['n', 'No', false],
    ] as const) {
      const start = x;
      x = screen.text(x, y, ` ${key} `, { fg: theme.keyFg, bg: theme.border, attrs: Attr.Bold });
      x = screen.text(x, y, `${label} `, { fg: theme.fg, bg: theme.border });
      ctx.hits.add({ x: start, y, w: x - start, h: 1 }, (e) => {
        if (e.action !== 'down') return;
        this.overlay = null;
        o.answer(yes);
      });
      x += 3;
    }
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
    if (o.kind === 'part') {
      o.editor.render(ctx, this.rects.flash ?? this.rects.main!);
      return;
    }
    if (o.kind === 'dump') {
      o.dialog.render(ctx, this.rects.flash ?? this.rects.main!);
      return;
    }
    if (o.kind === 'confirm') {
      this.drawConfirm(ctx, o);
      return;
    }
    const lines = HELP;
    const keyW = Math.max(...lines.filter(([, d]) => d).map(([k]) => stringWidth(k))) + 2;
    const descW = Math.max(...lines.map(([, d]) => stringWidth(d ?? '')));
    const h = Math.min(lines.length + 4, screen.rows - 4);
    const inner = dialog(
      ctx,
      'Help · Esc to close',
      Math.min(screen.cols - 4, keyW + descW + 6),
      h,
    );
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
      screen.text(body.x + 2 + keyW, y, d, { fg: theme.fg, bg: theme.inputBg }, body.w - keyW - 3);
    });
  }
}

/** Settings key for a USB serial device ("303a:1001"); null when the port has no USB ids. */
function portKey(port: SerialPort): string | null {
  return port.getInfo().usbVendorId === undefined ? null : describePort(port);
}
