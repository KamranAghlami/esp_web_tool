import { FORMATS, type Format } from '../serial/port-manager';
import { BAUD_RATES } from './flash-pane';
import { LINE_ENDINGS } from './monitor-pane';

/**
 * Settings remembered by this browser (SPEC §10). They live in localStorage, so every computer
 * or phone keeps its own. Serial settings are also kept per USB device (vid:pid), and applied
 * when that device is connected again.
 */
export interface Settings {
  flash: {
    baud: number;
    eraseAll: boolean;
    verify: boolean;
    resetAfter: boolean;
  };
  monitor: SerialSettings & { colorize: boolean };
  /** Keyed by `describePort()` ("303a:1001"), most recently used last. */
  ports: Record<string, SerialSettings>;
}

export interface SerialSettings {
  baud: number;
  format: Format;
  /** Index into LINE_ENDINGS. */
  eol: number;
}

/** The part of the Web Storage API we use; localStorage in the page, a Map in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY = 'esp-web-tool:settings:v1';
/** Remembered devices; the least recently used are dropped beyond this. */
export const MAX_PORTS = 32;

export function defaultSettings(): Settings {
  return {
    flash: {
      baud: 921600,
      eraseAll: false,
      verify: true,
      resetAfter: true,
    },
    monitor: { baud: 115200, format: '8N1', eol: 0, colorize: true },
    ports: {},
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const oneOf = <T>(v: unknown, list: readonly T[], d: T): T =>
  list.includes(v as T) ? (v as T) : d;
const baud = (v: unknown, d: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 300 && v <= 10_000_000 ? v : d;

function serial(v: unknown, d: SerialSettings): SerialSettings {
  const o = isObj(v) ? v : {};
  return {
    baud: baud(o.baud, d.baud),
    format: oneOf(o.format, FORMATS, d.format),
    eol: oneOf(
      o.eol,
      LINE_ENDINGS.map((_, i) => i),
      d.eol,
    ),
  };
}

/** Anything missing, malformed or from another version falls back to the default. */
export function parseSettings(json: string | null): Settings {
  const d = defaultSettings();
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    return d;
  }
  const o = isObj(raw) ? raw : {};
  const f = isObj(o.flash) ? o.flash : {};
  const m = isObj(o.monitor) ? o.monitor : {};
  const ports: Record<string, SerialSettings> = {};
  if (isObj(o.ports)) {
    for (const [key, v] of Object.entries(o.ports).slice(-MAX_PORTS)) {
      if (/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(key)) ports[key] = serial(v, d.monitor);
    }
  }
  return {
    flash: {
      baud: oneOf(f.baud, BAUD_RATES as readonly number[], d.flash.baud),
      eraseAll: bool(f.eraseAll, d.flash.eraseAll),
      verify: bool(f.verify, d.flash.verify),
      resetAfter: bool(f.resetAfter, d.flash.resetAfter),
    },
    monitor: { ...serial(m, d.monitor), colorize: bool(m.colorize, d.monitor.colorize) },
    ports,
  };
}

/** Records `s` as the settings for `key`, moving it to the most-recently-used end. */
export function rememberPort(ports: Settings['ports'], key: string, s: SerialSettings): void {
  delete ports[key];
  ports[key] = { ...s };
  const keys = Object.keys(ports);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PORTS))) delete ports[k];
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
