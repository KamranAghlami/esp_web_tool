import { parseOffset } from './offsets';

/**
 * Flash plans read from a manifest (SPEC §6): our `esp-web-tool.json`, plus read-only
 * adapters for esp-web-tools' `manifest.json` and ESP-IDF's `flasher_args.json`.
 */
export interface Manifest {
  name?: string;
  version?: string;
  /** Which format it was read as, for the status line. */
  format: 'esp-web-tool' | 'esp-web-tools' | 'flasher_args';
  sets: PlanSet[];
  /** Read anyway, but worth saying (a newer manifestVersion). */
  warning?: string;
}

export interface PlanSet {
  id: string;
  name: string;
  chip?: string;
  eraseAll?: boolean;
  baudrate?: number;
  monitorBaudrate?: number;
  flash?: { mode?: string; freq?: string; size?: string };
  parts: PlanPart[];
}

export interface PlanPart {
  /** Relative to the manifest, or an absolute https:// URL. */
  path: string;
  offset: number;
  sha256?: string;
  locked: boolean;
}

/**
 * The manifest looked for when no file is named: in a folder URL and in a GitHub release.
 * Other formats are read only when their URL (or file) is given directly.
 */
export const MANIFEST_NAME = 'esp-web-tool.json';

export class ManifestError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Parse manifest text in any supported format; throws ManifestError with a readable reason. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError('not valid JSON');
  }
  if (!isObj(raw)) throw new ManifestError('not a JSON object');
  if (Array.isArray(raw.sets)) return parseOurs(raw);
  if (Array.isArray(raw.builds)) return parseEspWebTools(raw);
  if (isObj(raw.flash_files)) return parseFlasherArgs(raw);
  throw new ManifestError('unknown format (expected "sets", "builds" or "flash_files")');
}

function parts(list: unknown, where: string, lockAll: boolean): PlanPart[] {
  if (!Array.isArray(list) || list.length === 0) throw new ManifestError(`${where}: no parts`);
  return list.map((p, i) => {
    if (!isObj(p) || typeof p.path !== 'string' || !p.path)
      throw new ManifestError(`${where}, part ${i + 1}: missing "path"`);
    const offset = parseOffset(p.offset);
    if (offset === null) throw new ManifestError(`${where}, part ${i + 1}: bad "offset"`);
    return {
      path: p.path,
      offset,
      sha256: optStr(p.sha256)?.toLowerCase(),
      locked: lockAll || p.locked === true,
    };
  });
}

function parseOurs(o: Obj): Manifest {
  const sets = (o.sets as unknown[]).map((s, i): PlanSet => {
    if (!isObj(s)) throw new ManifestError(`set ${i + 1}: not an object`);
    const id = optStr(s.id) ?? `set-${i + 1}`;
    const flash = isObj(s.flash)
      ? { mode: optStr(s.flash.mode), freq: optStr(s.flash.freq), size: optStr(s.flash.size) }
      : undefined;
    return {
      id,
      name: optStr(s.name) ?? id,
      chip: optStr(s.chip),
      eraseAll: typeof s.eraseAll === 'boolean' ? s.eraseAll : undefined,
      baudrate: optNum(s.baudrate),
      monitorBaudrate: optNum(s.monitorBaudrate),
      flash,
      parts: parts(s.parts, `set "${id}"`, s.locked === true),
    };
  });
  if (sets.length === 0) throw new ManifestError('"sets" is empty');
  const ids = new Set(sets.map((s) => s.id));
  if (ids.size !== sets.length) throw new ManifestError('set ids are not unique');
  // Unknown fields are ignored, so a newer version is read as v1 (SPEC §6).
  const v = optNum(o.manifestVersion);
  return {
    name: optStr(o.name),
    version: optStr(o.version),
    format: 'esp-web-tool',
    sets,
    ...(v !== undefined && v > 1 ? { warning: `manifestVersion ${v}, read as 1` } : {}),
  };
}

function parseEspWebTools(o: Obj): Manifest {
  const sets = (o.builds as unknown[]).map((b, i): PlanSet => {
    if (!isObj(b)) throw new ManifestError(`build ${i + 1}: not an object`);
    const chip = optStr(b.chipFamily);
    const id = chip ? chip.toLowerCase() : `build-${i + 1}`;
    return {
      id,
      name: chip ?? id,
      chip,
      eraseAll: o.new_install_prompt_erase === true ? true : undefined,
      parts: parts(b.parts, `build "${id}"`, false),
    };
  });
  if (sets.length === 0) throw new ManifestError('"builds" is empty');
  return { name: optStr(o.name), version: optStr(o.version), format: 'esp-web-tools', sets };
}

function parseFlasherArgs(o: Obj): Manifest {
  const files = Object.entries(o.flash_files as Obj).map(([offset, path]) => ({ offset, path }));
  const settings = isObj(o.flash_settings) ? o.flash_settings : {};
  const extra = isObj(o.extra_esptool_args) ? o.extra_esptool_args : {};
  const chip = optStr(extra.chip)
    ?.toUpperCase()
    .replace(/^ESP32(?=[A-Z])/, 'ESP32-');
  const app = isObj(o.app) ? optStr(o.app.file) : undefined;
  return {
    name: app?.replace(/\.bin$/, ''),
    format: 'flasher_args',
    sets: [
      {
        id: 'build',
        name: chip ?? 'ESP-IDF build',
        chip,
        flash: {
          mode: optStr(settings.flash_mode),
          freq: optStr(settings.flash_freq),
          size: optStr(settings.flash_size),
        },
        parts: parts(files, 'flash_files', false),
      },
    ],
  };
}
