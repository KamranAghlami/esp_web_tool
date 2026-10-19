import {
  defaultRelease,
  listReleases,
  manifestAsset,
  RELEASES_PER_PAGE,
  type Release,
  viaProxy,
} from './github';
import { AccessError, FetchError, type FileHost, type LocalFile, type LocalFolder } from './host';
import { classify } from './locate';
import {
  MANIFEST_NAME,
  ManifestError,
  type Manifest,
  parseManifest,
  type PlanSet,
} from './manifest';
import { sameChip } from './chip';
import { guessOffset } from './offsets';

/** One row of the parts table. */
export interface PlanRow {
  id: number;
  enabled: boolean;
  offset: number;
  /** Offset came from the file name and may be wrong (bootloader before chip detection). */
  offsetGuessed: boolean;
  name: string;
  /**
   * Where the data comes from: a path (relative to the manifest, or a URL on any host), or a
   * file the user picked. Neither when a picked file couldn't be kept across a reload.
   */
  path: string | null;
  file: LocalFile | null;
  locked: boolean;
  sha256?: string;
  data: Uint8Array | null;
  loading: boolean;
  /** Why the file can't be used; red in the table, and flashing is refused. */
  error: string | null;
  /** Where to download it by hand when it can't be fetched (manual assist, SPEC §7.4). */
  download?: string;
}

/** `manual`: the manifest must be downloaded by hand (no asset proxy). */
export type PlanStatus = { kind: 'idle' | 'loading' | 'ok' | 'error' | 'manual'; text: string };

/** A file to download by hand and then drop or pick (manual assist, SPEC §7.4). */
export interface Download {
  name: string;
  url: string;
}

/** A new or edited part's source: a typed path or URL, or a picked file. */
export type PartSource = { path: string } | { file: LocalFile };

/**
 * Everything needed to bring a plan back after a reload (SPEC §10), kept in IndexedDB:
 * structured-clonable, with file and folder handles in place of the files. Part data is not
 * kept; it is read again.
 */
export interface SavedPlan {
  base:
    | { kind: 'url'; url: string }
    | { kind: 'file'; name: string; file: unknown; folder: unknown }
    | null;
  manifest: Manifest | null;
  setIndex: number;
  releases: Release[] | null;
  releaseIndex: number;
  status: PlanStatus;
  pendingManifest?: Download | null;
  rows: {
    enabled: boolean;
    offset: number;
    offsetGuessed: boolean;
    name: string;
    path: string | null;
    file: unknown;
    locked: boolean;
    sha256?: string;
  }[];
}

/** Where relative part paths resolve. */
type Base =
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: LocalFile; folder: LocalFolder | null }
  | null;

const NEEDS_FOLDER = 'needs folder access (o)';
const NEEDS_ACCESS = 'needs permission again (o)';
const NOT_KEPT = 'not kept after reload: pick it again (e)';
const MANUAL = 'download it, then drop it here (m)';
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const decoder = new TextDecoder();

/**
 * Where a part's path points. URLs may be on any host; with a URL manifest, relative and
 * root paths resolve against it. With a local manifest, relative paths are in its folder, and
 * absolute disk paths can't be read by a page at all.
 */
function locate(path: string, base: Base): { url: string } | { local: string } | { error: string } {
  const p = path.trim();
  if (/^https?:\/\//i.test(p)) return { url: p };
  if (p.startsWith('//')) return { url: `https:${p}` };
  if (base?.kind === 'url') {
    try {
      return { url: new URL(p, base.url).href };
    } catch {
      return { error: 'not a valid path' };
    }
  }
  if (/^([a-z]:[\\/]|[\\/~])/i.test(p))
    return { error: "disk paths can't be read: Browse for it (e)" };
  if (base?.kind === 'file') return { local: p.replace(/\\/g, '/') };
  // Typed without a manifest: `example.com/fw.bin` is a URL.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?\//.test(p)) return { url: `https://${p}` };
  return { error: 'relative to no manifest: type a URL or Browse (e)' };
}

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
  /** The listed repo, for loading more releases. */
  private repo: { owner: string; repo: string } | null = null;
  status: PlanStatus = { kind: 'idle', text: '' };
  /** The picked manifest file's name, shown in the field while it is the source. */
  localName: string | null = null;
  /** A set id to select when a manifest loads (the `&set=` deep link), used once. */
  wantSet: string | null = null;
  /** A release's manifest that has to be downloaded by hand first (no asset proxy). */
  pendingManifest: Download | null = null;
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

  /** Everything waiting to be downloaded by hand: the manifest, or red parts (SPEC §7.4). */
  get downloads(): Download[] {
    if (this.pendingManifest) return [this.pendingManifest];
    return this.rows.flatMap((r) =>
      r.error === MANUAL && r.download ? [{ name: baseName(r.download), url: r.download }] : [],
    );
  }

  /**
   * What `o` would grant: the folder of a local manifest (its relative parts can't be read
   * until then), or permission again for files and folders kept across a reload.
   */
  get access(): 'folder' | 'again' | null {
    if (this.rows.some((r) => r.error === NEEDS_FOLDER)) return 'folder';
    if (this.rows.some((r) => r.error === NEEDS_ACCESS)) return 'again';
    return null;
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
    this.pendingManifest = null;
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
      this.repo = { owner: target.owner, repo: target.repo };
      const i = defaultRelease(releases, target.tag);
      if (i < 0) return this.fail(`${target.owner}/${target.repo} has no releases`);
      await this.loadRelease(i, gen);
      return;
    }

    const url = target.url;
    this.setStatus('loading', `Reading ${url}…`);
    try {
      const m = parseManifest(decoder.decode(await this.host.fetchBytes(url)));
      if (gen === this.gen) this.apply(m, { kind: 'url', url });
    } catch (err) {
      if (gen === this.gen) this.fail(`${baseName(new URL(url).pathname)}: ${message(err)}`);
    }
  }

  /** A full page was listed, so there may be older releases. */
  get moreReleases(): boolean {
    return (this.releases?.length ?? 0) % RELEASES_PER_PAGE === 0 && this.releases!.length > 0;
  }

  /** The next page of releases, appended to the list. */
  async loadMoreReleases(): Promise<void> {
    if (!this.releases || !this.repo) return;
    const page = this.releases.length / RELEASES_PER_PAGE + 1;
    try {
      const more = await listReleases(this.host, this.repo.owner, this.repo.repo, page);
      this.releases.push(...more);
      this.onChange();
    } catch (err) {
      this.fail(`GitHub: ${message(err)}`);
    }
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
      return this.fail(`Release ${r.tag} has no ${MANIFEST_NAME}`);
    }
    const url = viaProxy(asset.url, this.proxy);
    if (!url) {
      // No proxy: the manifest is downloaded by hand and dropped or picked (manual assist).
      this.clearManifest();
      this.pendingManifest = { name: asset.name, url: asset.url };
      return this.setStatus('manual', `${r.tag}: download ${asset.name}, then drop it here (m)`);
    }
    this.pendingManifest = null;
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
    // A release's manifest downloaded by hand stands for that release: its parts are still
    // the release's files (to download by hand too), and the field keeps the repo.
    const pending = this.pendingManifest;
    const fromRelease = pending !== null && file.name === pending.name;
    if (!fromRelease) this.releases = null;
    this.setStatus('loading', `Reading ${file.name}…`);
    try {
      const m = parseManifest(decoder.decode(await file.read()));
      if (gen !== this.gen) return;
      this.pendingManifest = null;
      if (fromRelease) {
        this.apply(m, { kind: 'url', url: pending.url });
        return;
      }
      this.localName = file.name;
      this.onFile?.(file.name);
      this.apply(m, { kind: 'file', file, folder: null });
    } catch (err) {
      if (gen === this.gen) this.fail(`${file.name}: ${message(err)}`);
    }
  }

  /**
   * Files the user dropped or picked (manual assist, SPEC §7.4): the release's manifest
   * first, then parts matched to rows by file name (sha256 still checked); anything else is
   * added as a new part, and another `.json` loads as the manifest.
   */
  async takeFiles(files: LocalFile[]): Promise<{ matched: number; added: number }> {
    let rest = files;
    const manifest =
      files.find((f) => f.name === this.pendingManifest?.name) ??
      (files.length === 1 && /\.json$/i.test(files[0]!.name) ? files[0] : undefined);
    if (manifest) {
      await this.loadFile(manifest);
      rest = files.filter((f) => f !== manifest);
    }
    let matched = manifest ? 1 : 0;
    let added = 0;
    for (const file of rest) {
      const row = this.rows.find(
        (r) => !r.data && !r.file && r.path !== null && baseName(r.path) === file.name,
      );
      if (row) {
        row.file = file;
        this.readRow(row);
        matched++;
      } else {
        this.addPart({ file }, null);
        added++;
      }
    }
    this.onChange();
    return { matched, added };
  }

  /** Re-read the current source (Enter on an unchanged field). */
  reload(): void {
    if (this.base?.kind === 'file') void this.loadFile(this.base.file);
  }

  /**
   * `o`: the folder picker for a local manifest's parts, or permission again for what was
   * kept across a reload. Must run synchronously from input.
   */
  grantAccess(): void {
    const base = this.base;
    if (this.access === 'folder' && base?.kind === 'file') {
      void this.host.pickFolder(base.file).then((folder) => {
        if (!folder || this.base !== base) return;
        base.folder = folder;
        for (const row of this.rows) if (row.error === NEEDS_FOLDER) this.readRow(row);
        this.onChange();
      });
      return;
    }
    const waiting = this.rows.filter((r) => r.error === NEEDS_ACCESS);
    const handles = new Set<unknown>();
    for (const row of waiting) {
      const h = row.file ? row.file.handle : base?.kind === 'file' ? base.folder?.handle : null;
      if (h) handles.add(h);
    }
    if (!handles.size) return;
    void this.host.requestAccess([...handles]).then(
      () => waiting.forEach((row) => this.readRow(row)),
      () => {},
    );
  }

  private apply(m: Manifest, base: Base): void {
    this.manifest = m;
    this.base = base;
    const wanted = this.wantSet ? m.sets.findIndex((s) => s.id === this.wantSet) : -1;
    this.wantSet = null;
    this.setIndex = Math.max(0, wanted);
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
      file: null,
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
    for (const row of this.rows) this.readRow(row);
  }

  private clearManifest(): void {
    this.manifest = null;
    this.base = null;
    this.rows = [];
  }

  private fail(text: string): void {
    this.setStatus('error', text);
  }

  /** Read a row's data from its file or path; the row turns red if it can't be. */
  private readRow(row: PlanRow): void {
    const fail = (why: string) => this.settle(row, Promise.reject(new FetchError(why)));
    row.download = undefined;
    if (row.file) return this.settle(row, row.file.read());
    if (row.path === null) return fail(NOT_KEPT);
    const base = this.base;
    const at = locate(row.path, base);
    if ('error' in at) return fail(at.error);
    if ('local' in at) {
      const folder = base?.kind === 'file' ? base.folder : null;
      return folder ? this.settle(row, folder.read(at.local)) : fail(NEEDS_FOLDER);
    }
    const url = new URL(at.url).hostname === 'github.com' ? viaProxy(at.url, this.proxy) : at.url;
    if (!url) {
      row.download = at.url;
      return fail(MANUAL);
    }
    this.settle(row, this.host.fetchBytes(url));
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
      (err: unknown) => done(null, err instanceof AccessError ? NEEDS_ACCESS : message(err)),
    );
  }

  // ---------------------------------------------------------------------------
  // Editing (SPEC §5.2): always possible, except on rows the manifest locks.

  /** File picker for parts. Must run synchronously from a key press or click. */
  browse(multiple: boolean): Promise<LocalFile[]> {
    return this.host.pickFiles({ multiple });
  }

  /** Add a part; a null offset is guessed from the name (after the parts already there). */
  addPart(source: PartSource, offset: number | null): PlanRow {
    const name = 'file' in source ? source.file.name : baseName(source.path);
    const guess = guessOffset(
      name,
      this.rows.map((r) => ({ offset: r.offset, size: r.data?.length ?? 0 })),
    );
    const row: PlanRow = {
      id: this.nextId++,
      enabled: true,
      offset: offset ?? guess.offset,
      offsetGuessed: offset === null && guess.guessed,
      name,
      path: 'path' in source ? source.path.trim() : null,
      file: 'file' in source ? source.file : null,
      locked: false,
      data: null,
      loading: true,
      error: null,
    };
    this.rows.push(row);
    this.readRow(row);
    this.onChange();
    return row;
  }

  /** Change a row's offset and, given a source, its file. False when the row is locked. */
  editRow(row: PlanRow, offset: number, source: PartSource | null): boolean {
    if (row.locked) return false;
    row.offset = offset;
    row.offsetGuessed = false;
    if (source) {
      row.name = 'file' in source ? source.file.name : baseName(source.path);
      row.path = 'path' in source ? source.path.trim() : null;
      row.file = 'file' in source ? source.file : null;
      row.sha256 = undefined; // the manifest's hash was for the old file
      this.readRow(row);
    }
    this.onChange();
    return true;
  }

  deleteRow(row: PlanRow): boolean {
    if (row.locked) return false;
    this.rows = this.rows.filter((r) => r !== row);
    this.onChange();
    return true;
  }

  toggle(row: PlanRow): boolean {
    if (row.locked) return false;
    row.enabled = !row.enabled;
    this.onChange();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Kept across reloads (SPEC §10)

  save(): SavedPlan {
    const b = this.base;
    return {
      base:
        b?.kind === 'url'
          ? { kind: 'url', url: b.url }
          : b?.kind === 'file'
            ? { kind: 'file', name: b.file.name, file: b.file.handle, folder: b.folder?.handle }
            : null,
      manifest: this.manifest,
      setIndex: this.setIndex,
      releases: this.releases,
      releaseIndex: this.releaseIndex,
      status: this.status,
      pendingManifest: this.pendingManifest,
      rows: this.rows.map((r) => ({
        enabled: r.enabled,
        offset: r.offset,
        offsetGuessed: r.offsetGuessed,
        name: r.name,
        path: r.path,
        file: r.file?.handle,
        locked: r.locked,
        sha256: r.sha256,
      })),
    };
  }

  /**
   * Bring back a saved plan and read its parts again. Kept local files and folders turn into
   * "needs permission again (o)" rows until the user allows them (`grantAccess`).
   */
  restore(saved: SavedPlan): void {
    this.gen++;
    const restoreFile = (h: unknown) => (h ? this.host.restoreFile(h) : null);
    const b = saved.base;
    this.manifest = saved.manifest;
    this.setIndex = saved.setIndex;
    this.releases = saved.releases;
    this.releaseIndex = saved.releaseIndex;
    this.status = saved.status.kind === 'loading' ? { kind: 'idle', text: '' } : saved.status;
    this.pendingManifest = saved.pendingManifest ?? null;
    this.localName = b?.kind === 'file' ? b.name : null;
    this.base =
      b?.kind === 'url'
        ? { kind: 'url', url: b.url }
        : b?.kind === 'file'
          ? {
              kind: 'file',
              file: restoreFile(b.file) ?? lostFile(b.name),
              folder: b.folder ? this.host.restoreFolder(b.folder) : null,
            }
          : null;
    this.rows = saved.rows.map((r) => ({
      ...r,
      id: this.nextId++,
      file: restoreFile(r.file),
      data: null,
      loading: true,
      error: null,
    }));
    for (const row of this.rows) this.readRow(row);
    this.onChange();
  }

  // ---------------------------------------------------------------------------
  // The detected chip (SPEC §5.2, §6)

  /** The set made for `chip`, or -1 when none (or several) say so. */
  setFor(chip: string): number {
    const sets = this.manifest?.sets ?? [];
    const hits = sets.flatMap((s, i) => (s.chip && sameChip(s.chip, chip) ? [i] : []));
    return hits.length === 1 ? hits[0]! : -1;
  }

  /** Guessed bootloader offsets become the chip's real one. */
  applyChip(bootloaderOffset: number): void {
    for (const row of this.rows) {
      if (row.offsetGuessed && /bootloader/i.test(row.name)) {
        row.offset = bootloaderOffset;
        row.offsetGuessed = false;
      }
    }
    this.onChange();
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

/** A picked manifest that couldn't be kept (no handle in this browser). */
const lostFile = (name: string): LocalFile => ({
  name,
  read: () => Promise.reject(new FetchError(`${name} was not kept: open it again`)),
});

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
