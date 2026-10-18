import { defaultRelease, listReleases, manifestAsset, type Release, viaProxy } from './github';
import { FetchError, type FileHost, type LocalFile, type LocalFolder } from './host';
import { classify } from './locate';
import { ManifestError, type Manifest, parseManifest, type PlanSet } from './manifest';
import { guessOffset } from './offsets';

/** One row of the parts table. */
export interface PlanRow {
  id: number;
  enabled: boolean;
  offset: number;
  /** Offset came from the file name and may be wrong (bootloader before chip detection). */
  offsetGuessed: boolean;
  name: string;
  /** Manifest path for manifest rows; null for files the user added. */
  path: string | null;
  locked: boolean;
  sha256?: string;
  data: Uint8Array | null;
  loading: boolean;
  /** Why the file can't be used; red in the table, and flashing is refused. */
  error: string | null;
}

export type PlanStatus = { kind: 'idle' | 'loading' | 'ok' | 'error'; text: string };

/** Where relative part paths resolve. */
type Base =
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: LocalFile; folder: LocalFolder | null }
  | null;

const NEEDS_FOLDER = 'needs folder access (o)';
const isAbsolute = (p: string) => /^https?:\/\//i.test(p);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const decoder = new TextDecoder();

/**
 * The flash plan behind the Flash pane (SPEC §5.2): loads a manifest from whatever the
 * Manifest field holds, turns the chosen set into rows, fetches each part, and lets the user
 * edit rows (unless the manifest locks them). Async results from a superseded load are
 * dropped (`gen`).
 */
export class FlashPlan {
  rows: PlanRow[] = [];
  manifest: Manifest | null = null;
  setIndex = 0;
  releases: Release[] | null = null;
  releaseIndex = -1;
  status: PlanStatus = { kind: 'idle', text: '' };
  /** The picked manifest file's name, shown in the field while it is the source. */
  localName: string | null = null;
  /** Called when a set becomes active, so the pane can take its baud and erase settings. */
  onSet?: (set: PlanSet) => void;
  /** Called with a picked manifest file's name once it loaded, for the field to show. */
  onFile?: (name: string) => void;

  private base: Base = null;
  private gen = 0;
  /** Latest read per row, so a slow earlier read never overwrites a newer one. */
  private jobs = new WeakMap<PlanRow, number>();
  private jobId = 0;
  private nextId = 1;

  constructor(
    private host: FileHost,
    private onChange: () => void,
    private proxy?: string,
  ) {}

  get set(): PlanSet | null {
    return this.manifest?.sets[this.setIndex] ?? null;
  }

  get release(): Release | null {
    return this.releases?.[this.releaseIndex] ?? null;
  }

  /** A local manifest whose relative parts can't be read until its folder is granted. */
  get needsFolder(): boolean {
    return this.rows.some((r) => r.error === NEEDS_FOLDER);
  }

  private setStatus(kind: PlanStatus['kind'], text: string): void {
    this.status = { kind, text };
    this.onChange();
  }

  // ---------------------------------------------------------------------------
  // Loading

  /** Load what the Manifest field holds (URL, folder URL or GitHub repo). */
  async load(text: string): Promise<void> {
    const gen = ++this.gen;
    const target = classify(text);
    this.localName = null;
    this.releases = null;
    if (!target) {
      this.clearManifest();
      this.setStatus('error', `Not a URL or owner/repo: ${text.trim()}`);
      return;
    }
    if (target.kind === 'github') {
      this.setStatus('loading', `Listing releases of ${target.owner}/${target.repo}…`);
      let releases: Release[];
      try {
        releases = await listReleases(this.host, target.owner, target.repo);
      } catch (err) {
        if (gen === this.gen) this.fail(`GitHub: ${message(err)}`);
        return;
      }
      if (gen !== this.gen) return;
      this.releases = releases;
      const i = defaultRelease(releases, target.tag);
      if (i < 0) return this.fail(`${target.owner}/${target.repo} has no releases`);
      await this.loadRelease(i, gen);
      return;
    }

    let lastError = '';
    for (const url of target.candidates) {
      this.setStatus('loading', `Reading ${url}…`);
      try {
        const m = parseManifest(decoder.decode(await this.host.fetchBytes(url)));
        if (gen !== this.gen) return;
        this.apply(m, { kind: 'url', url });
        return;
      } catch (err) {
        if (gen !== this.gen) return;
        lastError = `${baseName(new URL(url).pathname)}: ${message(err)}`;
        // A folder URL tries the next name only when this one isn't there.
        if (err instanceof ManifestError) break;
      }
    }
    this.fail(target.candidates.length > 1 ? `No manifest found (${lastError})` : lastError);
  }

  /** Switch to another release of the listed repo. */
  selectRelease(i: number): void {
    if (!this.releases?.[i]) return;
    void this.loadRelease(i, ++this.gen);
  }

  private async loadRelease(i: number, gen: number): Promise<void> {
    this.releaseIndex = i;
    const r = this.releases![i]!;
    const asset = manifestAsset(r);
    if (!asset) {
      this.clearManifest();
      return this.fail(
        `Release ${r.tag} has no esp-web-tool.json, manifest.json or flasher_args.json`,
      );
    }
    const url = viaProxy(asset.url, this.proxy);
    if (!url) {
      this.clearManifest();
      return this.fail(
        `Release ${r.tag} has ${asset.name}, but GitHub release files need the asset proxy (not set up yet)`,
      );
    }
    this.setStatus('loading', `Reading ${asset.name} from ${r.tag}…`);
    try {
      const m = parseManifest(decoder.decode(await this.host.fetchBytes(url)));
      if (gen === this.gen) this.apply(m, { kind: 'url', url });
    } catch (err) {
      if (gen === this.gen) this.fail(`${asset.name}: ${message(err)}`);
    }
  }

  /** File picker for a manifest. Must run synchronously from a key press or click. */
  openFile(): void {
    const picked = this.host.pickFiles({ multiple: false, json: true });
    void picked.then(async ([file]) => {
      if (file) await this.loadFile(file);
    });
  }

  async loadFile(file: LocalFile): Promise<void> {
    const gen = ++this.gen;
    this.releases = null;
    this.setStatus('loading', `Reading ${file.name}…`);
    try {
      const m = parseManifest(decoder.decode(await file.read()));
      if (gen !== this.gen) return;
      this.localName = file.name;
      this.onFile?.(file.name);
      this.apply(m, { kind: 'file', file, folder: null });
    } catch (err) {
      if (gen === this.gen) this.fail(`${file.name}: ${message(err)}`);
    }
  }

  /** Re-read the current source (Enter on an unchanged field). */
  reload(): void {
    if (this.base?.kind === 'file') void this.loadFile(this.base.file);
  }

  /** Folder picker for a local manifest's parts. Must run synchronously from input. */
  grantFolder(): void {
    const base = this.base;
    if (base?.kind !== 'file') return;
    void this.host.pickFolder(base.file).then((folder) => {
      if (!folder || this.base !== base) return;
      base.folder = folder;
      for (const row of this.rows) if (row.path && row.error === NEEDS_FOLDER) this.fetchRow(row);
      this.onChange();
    });
  }

  private apply(m: Manifest, base: Base): void {
    this.manifest = m;
    this.base = base;
    this.setIndex = 0;
    this.useSet();
  }

  selectSet(i: number): void {
    if (!this.manifest?.sets[i]) return;
    this.setIndex = i;
    this.useSet();
  }

  private useSet(): void {
    const m = this.manifest!;
    const set = this.set!;
    this.rows = set.parts.map((p) => ({
      id: this.nextId++,
      enabled: true,
      offset: p.offset,
      offsetGuessed: false,
      name: baseName(p.path),
      path: p.path,
      locked: p.locked,
      sha256: p.sha256,
      data: null,
      loading: true,
      error: null,
    }));
    const what = [m.name, m.version].filter(Boolean).join(' ') || 'Manifest';
    const sets = m.sets.length > 1 ? ` · ${m.sets.length} sets` : '';
    this.setStatus('ok', `${what}${sets} (${m.format})`);
    this.onSet?.(set);
    for (const row of this.rows) this.fetchRow(row);
  }

  private clearManifest(): void {
    this.manifest = null;
    this.base = null;
    this.rows = [];
  }

  private fail(text: string): void {
    this.setStatus('error', text);
  }

  /** Read one manifest part relative to the manifest; the row turns red if it can't be. */
  private fetchRow(row: PlanRow): void {
    const path = row.path!;
    const base = this.base;
    let job: Promise<Uint8Array>;
    if (isAbsolute(path) || base?.kind === 'url') {
      const url = isAbsolute(path) ? path : new URL(path, (base as { url: string }).url).href;
      const proxied = new URL(url).hostname === 'github.com' ? viaProxy(url, this.proxy) : url;
      if (!proxied)
        return this.settle(row, Promise.reject(new FetchError('needs the asset proxy')));
      job = this.host.fetchBytes(proxied);
    } else if (base?.kind === 'file') {
      if (!base.folder) return this.settle(row, Promise.reject(new FetchError(NEEDS_FOLDER)));
      job = base.folder.read(path);
    } else {
      return this.settle(row, Promise.reject(new FetchError('no manifest location')));
    }
    this.settle(row, job);
  }

  /** Load a row's data from `job`; only the row's latest job may update it. */
  private settle(row: PlanRow, job: Promise<Uint8Array>): void {
    const id = ++this.jobId;
    this.jobs.set(row, id);
    row.loading = true;
    row.error = null;
    const done = (data: Uint8Array | null, error: string | null) => {
      if (this.jobs.get(row) !== id) return;
      row.loading = false;
      row.data = error ? null : data;
      row.error = error;
      this.onChange();
    };
    const sha256 = row.sha256;
    job.then(
      async (data) => done(data, await checkData(data, sha256)),
      (err: unknown) => done(null, message(err)),
    );
  }

  // ---------------------------------------------------------------------------
  // Editing (SPEC §5.2): always possible, except on rows the manifest locks.

  /** File picker for extra parts. Must run synchronously from a key press or click. */
  addFiles(): void {
    void this.host.pickFiles({ multiple: true }).then((files) => {
      for (const file of files) {
        const { offset, guessed } = guessOffset(
          file.name,
          this.rows.map((r) => ({ offset: r.offset, size: r.data?.length ?? 0 })),
        );
        const row: PlanRow = {
          id: this.nextId++,
          enabled: true,
          offset,
          offsetGuessed: guessed,
          name: file.name,
          path: null,
          locked: false,
          data: null,
          loading: true,
          error: null,
        };
        this.rows.push(row);
        this.readLocal(row, file);
      }
      this.onChange();
    });
  }

  /** Replace a row's file with a local one. Must run synchronously from input. */
  replaceFile(row: PlanRow): boolean {
    if (row.locked) return false;
    void this.host.pickFiles({ multiple: false }).then(([file]) => {
      if (!file) return;
      row.name = file.name;
      row.path = null;
      row.sha256 = undefined;
      this.readLocal(row, file);
    });
    return true;
  }

  private readLocal(row: PlanRow, file: LocalFile): void {
    this.settle(row, file.read());
  }

  deleteRow(row: PlanRow): boolean {
    if (row.locked) return false;
    this.rows = this.rows.filter((r) => r !== row);
    this.onChange();
    return true;
  }

  setOffset(row: PlanRow, offset: number): boolean {
    if (row.locked) return false;
    row.offset = offset;
    row.offsetGuessed = false;
    this.onChange();
    return true;
  }

  toggle(row: PlanRow): boolean {
    if (row.locked) return false;
    row.enabled = !row.enabled;
    this.onChange();
    return true;
  }

  /** Why flashing can't start, or null. */
  problem(): string | null {
    const on = this.rows.filter((r) => r.enabled);
    if (on.length === 0) return 'No parts to flash';
    if (on.some((r) => r.loading)) return 'Parts are still loading';
    const bad = on.find((r) => r.error);
    if (bad) return `Fix the red rows first (${bad.name}: ${bad.error})`;
    const sorted = [...on].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (a.offset + a.data!.length > b.offset) return `${a.name} overlaps ${b.name}`;
    }
    return null;
  }
}

async function checkData(data: Uint8Array, sha256: string | undefined): Promise<string | null> {
  if (data.length === 0) return 'empty file';
  if (!sha256) return null;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>),
  );
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === sha256 ? null : 'sha256 mismatch';
}

function message(err: unknown): string {
  if (err instanceof FetchError || err instanceof ManifestError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
