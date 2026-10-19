import { FORMATS, type Format } from '../serial/port-manager';
import { BAUD_RATES } from './flash-pane';
import { LINE_ENDINGS } from './monitor-pane';

/**
 * Settings remembered by this browser (SPEC §10), in localStorage. `last` is what was used
 * most recently and what the page starts with. Each USB device (vid:pid) also gets a full copy,
 * restored when that device is connected again, so every board keeps its own manifest and
 * monitor setup. The flash plan itself (rows, picked files) is kept in a ValueStore.
 */
export interface Settings {
  last: DeviceSettings;
  /** Layout, kept per browser only: connecting a device moves focus to the monitor anyway. */
  ui: UiSettings;
  /** Keyed by `describePort()` ("303a:1001"), most recently used last. */
  devices: Record<string, DeviceSettings>;
}

export interface UiSettings {
  pane: 'flash' | 'monitor';
  fullscreen: boolean;
  /** Terminal font size in px; null: the default for the device (13 on phones, else 14). */
  fontSize: number | null;
}

export interface DeviceSettings {
  flash: FlashSettings;
  monitor: MonitorSettings;
}

export interface FlashSettings {
  /** The Manifest field when it holds a URL or owner/repo (a picked file can't be kept). */
  manifest: string;
  baud: number;
  eraseAll: boolean;
  verify: boolean;
  resetAfter: boolean;
}

export interface MonitorSettings {
  baud: number;
  format: Format;
  /** Index into LINE_ENDINGS. */
  eol: number;
  colorize: boolean;
  timestamps: boolean;
  /** Line input instead of raw keys. */
  lineMode: boolean;
}

/** The part of the Web Storage API we use; localStorage in the page, a Map in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Async store for structured-clonable values: IndexedDB in the page. Keeps the flash plan
 * per device ("last" and vid:pid), file and folder handles included, which localStorage can't.
 */
export interface ValueStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export const STORAGE_KEY = 'esp-web-tool:settings:v2';
/** Remembered devices; the least recently used are dropped beyond this. */
export const MAX_DEVICES = 32;

export function defaultDeviceSettings(): DeviceSettings {
  return {
    flash: {
      manifest: '',
      baud: 921600,
      eraseAll: false,
      verify: true,
      resetAfter: true,
    },
    monitor: {
      baud: 115200,
      format: '8N1',
      eol: 0,
      colorize: true,
      timestamps: false,
      lineMode: false,
    },
  };
}

export function defaultSettings(): Settings {
  return {
    last: defaultDeviceSettings(),
    ui: { pane: 'flash', fullscreen: false, fontSize: null },
    devices: {},
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v.slice(0, 2000) : d);
const oneOf = <T>(v: unknown, list: readonly T[], d: T): T =>
  list.includes(v as T) ? (v as T) : d;
const baud = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 300 && v <= 10_000_000 ? v : d;

/** Every field is checked on its own; anything missing or malformed gets its default. */
function parseDevice(v: unknown): DeviceSettings {
  const d = defaultDeviceSettings();
  const f = obj(obj(v).flash);
  const m = obj(obj(v).monitor);
  return {
    flash: {
      manifest: str(f.manifest, d.flash.manifest),
      baud: oneOf(f.baud, BAUD_RATES as readonly number[], d.flash.baud),
      eraseAll: bool(f.eraseAll, d.flash.eraseAll),
      verify: bool(f.verify, d.flash.verify),
      resetAfter: bool(f.resetAfter, d.flash.resetAfter),
    },
    monitor: {
      baud: baud(m.baud, d.monitor.baud),
      format: oneOf(m.format, FORMATS, d.monitor.format),
      eol: oneOf(
        m.eol,
        LINE_ENDINGS.map((_, i) => i),
        d.monitor.eol,
      ),
      colorize: bool(m.colorize, d.monitor.colorize),
      timestamps: bool(m.timestamps, d.monitor.timestamps),
      lineMode: bool(m.lineMode, d.monitor.lineMode),
    },
  };
}

export function parseSettings(json: string | null): Settings {
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    return defaultSettings();
  }
  const o = obj(raw);
  const devices: Record<string, DeviceSettings> = {};
  for (const [key, v] of Object.entries(obj(o.devices)).slice(-MAX_DEVICES)) {
    if (/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(key)) devices[key] = parseDevice(v);
  }
  const ui = obj(o.ui);
  return {
    last: parseDevice(o.last),
    ui: {
      pane: oneOf(ui.pane, ['flash', 'monitor'] as const, 'flash'),
      fullscreen: bool(ui.fullscreen, false),
      fontSize:
        typeof ui.fontSize === 'number' && ui.fontSize >= 8 && ui.fontSize <= 28
          ? ui.fontSize
          : null,
    },
    devices,
  };
}

/** Records `s` for `key`, moving it to the most-recently-used end. */
export function rememberDevice(devices: Settings['devices'], key: string, s: DeviceSettings): void {
  delete devices[key];
  devices[key] = structuredClone(s);
  const keys = Object.keys(devices);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DEVICES))) delete devices[k];
}

/** Reads and writes the settings; storage errors (quota, privacy mode) are ignored. */
export class SettingsStore {
  private last = '';

  constructor(private store?: KeyValueStore) {}

  load(): Settings {
    let json: string | null = null;
    try {
      json = this.store?.getItem(STORAGE_KEY) ?? null;
    } catch {
      // storage blocked
    }
    const s = parseSettings(json);
    this.last = JSON.stringify(s);
    return s;
  }

  /** Writes only when something changed. */
  save(s: Settings): void {
    const json = JSON.stringify(s);
    if (json === this.last) return;
    this.last = json;
    try {
      this.store?.setItem(STORAGE_KEY, json);
    } catch {
      // storage full or blocked: settings just won't stick
    }
  }
}
