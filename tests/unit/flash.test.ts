import { describe, expect, it } from 'vitest';
import { classify } from '../../src/flash/locate';
import { AccessError, FetchError, type FileHost, type LocalFile } from '../../src/flash/host';
import { parseManifest } from '../../src/flash/manifest';
import { guessOffset, parseOffset } from '../../src/flash/offsets';
import { FlashPlan } from '../../src/flash/plan';

const enc = new TextEncoder();
const bytes = (n: number) => new Uint8Array(n).fill(0xe9);

const OURS = {
  name: 'My FW',
  version: '1.2.0',
  sets: [
    {
      id: 's3',
      name: 'ESP32-S3',
      chip: 'ESP32-S3',
      baudrate: 460800,
      parts: [
        { path: 'bootloader.bin', offset: '0x0', locked: true },
        { path: 'app.bin', offset: 65536 },
      ],
    },
    { id: 'c3', name: 'ESP32-C3', locked: true, parts: [{ path: 'merged.bin', offset: '0' }] },
  ],
};

describe('manifest formats', () => {
  it('reads ours, with locks on parts and whole sets', () => {
    const m = parseManifest(JSON.stringify(OURS));
    expect(m.format).toBe('esp-web-tool');
    expect(m.sets.map((s) => s.parts.map((p) => [p.offset, p.locked]))).toEqual([
      [
        [0, true],
        [0x10000, false],
      ],
      [[0, true]],
    ]);
  });

  it('adapts esp-web-tools manifest.json and ESP-IDF flasher_args.json', () => {
    const ewt = parseManifest(
      JSON.stringify({
        name: 'X',
        builds: [{ chipFamily: 'ESP32-C3', parts: [{ path: 'x.bin', offset: 0 }] }],
      }),
    );
    expect(ewt.sets[0]).toMatchObject({ id: 'esp32-c3', chip: 'ESP32-C3' });
    const idf = parseManifest(
      JSON.stringify({
        flash_files: { '0x0': 'bootloader/bootloader.bin', '0x10000': 'hello.bin' },
        flash_settings: { flash_mode: 'dio', flash_freq: '80m', flash_size: '2MB' },
        extra_esptool_args: { chip: 'esp32s3' },
        app: { file: 'hello.bin' },
      }),
    );
    expect(idf).toMatchObject({ name: 'hello', format: 'flasher_args' });
    expect(idf.sets[0]).toMatchObject({ chip: 'ESP32-S3', flash: { mode: 'dio' } });
    expect(idf.sets[0]!.parts.map((p) => p.offset)).toEqual([0, 0x10000]);
  });

  it('explains what is wrong', () => {
    expect(() => parseManifest('{')).toThrow('not valid JSON');
    expect(() => parseManifest('{"sets":[{"id":"a","parts":[{"path":"x"}]}]}')).toThrow(
      'bad "offset"',
    );
    expect(() => parseManifest('{"hello":1}')).toThrow('unknown format');
  });
});

describe('what the Manifest field points at', () => {
  it('tells GitHub repos from URLs and folder URLs', () => {
    expect(classify('espressif/esp-idf')).toEqual({
      kind: 'github',
      owner: 'espressif',
      repo: 'esp-idf',
      tag: null,
    });
    expect(classify('https://github.com/o/r/releases/tag/v1.0')).toMatchObject({ tag: 'v1.0' });
    expect(classify('https://x.dev/fw/m.json')).toEqual({
      kind: 'url',
      url: 'https://x.dev/fw/m.json',
    });
    // No file named: only our manifest is looked for.
    expect(classify('example.com/fw')).toEqual({
      kind: 'url',
      url: 'https://example.com/fw/esp-web-tool.json',
    });
  });
});

describe('offsets', () => {
  it('parses hex with or without 0x, and guesses from names', () => {
    expect(parseOffset('0x8000')).toBe(0x8000);
    expect(parseOffset('10000')).toBe(0x10000);
    expect(parseOffset('zz')).toBeNull();
    expect(guessOffset('bootloader.bin')).toEqual({ offset: 0, guessed: true });
    expect(guessOffset('partition-table.bin').offset).toBe(0x8000);
    expect(guessOffset('fw.bin', [{ offset: 0x10000, size: 0x18000 }]).offset).toBe(0x30000);
  });
});

/**
 * A fake browser: URL → bytes, queued picker results, and kept handles (plain ids here) that
 * need `requestAccess` again after a "reload" (`forget()`).
 */
function fakeHost(urls: Record<string, Uint8Array>) {
  const picks: LocalFile[][] = [];
  let folder: Record<string, Uint8Array> | null = null;
  const disk = new Map<string, Uint8Array>();
  const allowed = new Set<string>();
  const kept = (id: string): LocalFile => ({
    name: id,
    handle: id,
    read: async () => {
      if (!allowed.has(id)) throw new AccessError('needs permission again');
      return disk.get(id)!;
    },
  });
  const host: FileHost = {
    pickFiles: () => Promise.resolve(picks.shift() ?? []),
    pickFolder: () =>
      Promise.resolve(
        folder && {
          name: 'fw',
          read: async (p: string) => {
            const b = folder![p];
            if (!b) throw new FetchError('not found in fw/');
            return b;
          },
        },
      ),
    fetchBytes: async (url) => {
      const b = urls[url];
      if (!b) throw new FetchError('not found (404)');
      return b;
    },
    fetchJson: async () => {
      throw new FetchError('no network in tests');
    },
    restoreFile: (h) => (typeof h === 'string' && disk.has(h) ? kept(h) : null),
    restoreFolder: () => null,
    requestAccess: async (handles) => handles.forEach((h) => allowed.add(h as string)),
    save: () => {},
  };
  return {
    host,
    pick: (...files: LocalFile[]) => picks.push(files),
    grant: (files: Record<string, Uint8Array>) => (folder = files),
    /** A picked file with a handle, as Chrome gives them. */
    keep: (id: string, data: Uint8Array) => (disk.set(id, data), allowed.add(id), kept(id)),
    forget: () => allowed.clear(),
  };
}

const file = (name: string, data: Uint8Array): LocalFile => ({ name, read: async () => data });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('FlashPlan', () => {
  it('finds the manifest in a folder URL and marks unreadable parts red', async () => {
    const { host } = fakeHost({
      'https://x.dev/fw/esp-web-tool.json': enc.encode(JSON.stringify(OURS)),
      'https://x.dev/fw/bootloader.bin': bytes(100),
    });
    const plan = new FlashPlan(host, () => {});
    await plan.load('x.dev/fw');
    await settle();
    expect(plan.status).toMatchObject({ kind: 'ok', text: 'My FW 1.2.0 · 2 sets (esp-web-tool)' });
    expect(plan.rows.map((r) => [r.name, r.error])).toEqual([
      ['bootloader.bin', null],
      ['app.bin', 'not found (404)'],
    ]);
    expect(plan.problem()).toMatch(/^Fix the red rows first \(app\.bin/);
    // The red row can be fixed by hand: it isn't locked.
    expect(plan.toggle(plan.rows[1]!)).toBe(true);
    expect(plan.problem()).toBeNull();
    // Locked rows refuse every edit.
    const locked = plan.rows[0]!;
    expect([plan.toggle(locked), plan.deleteRow(locked), plan.editRow(locked, 4, null)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('needs the folder of a local manifest before reading its parts', async () => {
    const { host, grant } = fakeHost({});
    const plan = new FlashPlan(host, () => {});
    await plan.loadFile(file('esp-web-tool.json', enc.encode(JSON.stringify(OURS))));
    await settle();
    expect(plan.localName).toBe('esp-web-tool.json');
    expect(plan.access).toBe('folder');
    grant({ 'bootloader.bin': bytes(10), 'app.bin': bytes(20) });
    plan.grantAccess();
    await settle();
    await settle();
    expect(plan.rows.map((r) => r.data?.length)).toEqual([10, 20]);
    expect(plan.access).toBeNull();
  });

  it('adds local files with guessed offsets and catches overlaps', async () => {
    const { host } = fakeHost({});
    const plan = new FlashPlan(host, () => {});
    plan.addPart({ file: file('bootloader.bin', bytes(0x9000)) }, null);
    await settle();
    plan.addPart({ file: file('my-app.bin', bytes(0x100)) }, null);
    await settle();
    expect(plan.rows.map((r) => [r.name, r.offset, r.offsetGuessed])).toEqual([
      ['bootloader.bin', 0, true],
      ['my-app.bin', 0x10000, false],
    ]);
    plan.editRow(plan.rows[1]!, 0x8000, null);
    expect(plan.problem()).toBe('bootloader.bin overlaps my-app.bin');
  });

  it('reads parts from URLs on any host, and typed paths or URLs', async () => {
    const { host } = fakeHost({
      'https://x.dev/fw/m.json': enc.encode(
        JSON.stringify({
          sets: [
            {
              id: 'a',
              parts: [
                { path: 'https://cdn.other.net/boot.bin', offset: 0 },
                { path: '/root.bin', offset: 0x8000 },
              ],
            },
          ],
        }),
      ),
      'https://cdn.other.net/boot.bin': bytes(16),
      'https://x.dev/root.bin': bytes(16),
      'https://x.dev/fw/extra.bin': bytes(16),
    });
    const plan = new FlashPlan(host, () => {});
    await plan.load('https://x.dev/fw/m.json');
    await settle();
    expect(plan.rows.map((r) => r.error)).toEqual([null, null]);
    // A typed relative path resolves against the manifest; editing the file drops its hash.
    plan.addPart({ path: 'extra.bin' }, 0x10000);
    const row = plan.rows[0]!;
    row.sha256 = 'ab';
    plan.editRow(row, 0, { path: 'missing.bin' });
    await settle();
    expect(plan.rows.map((r) => [r.name, r.error])).toEqual([
      ['missing.bin', 'not found (404)'],
      ['root.bin', null],
      ['extra.bin', null],
    ]);
    expect(row.sha256).toBeUndefined();

    // Without a manifest, a relative path has nothing to resolve against.
    const bare = new FlashPlan(host, () => {});
    bare.addPart({ path: 'fw.bin' }, null);
    bare.addPart({ path: 'x.dev/fw/extra.bin' }, null);
    await settle();
    expect(bare.rows.map((r) => r.error)).toEqual([
      'relative to no manifest: type a URL or Browse (e)',
      null,
    ]);
  });

  it('keeps everything across a reload; kept files need permission again', async () => {
    const { host, keep, forget } = fakeHost({
      'https://x.dev/fw/esp-web-tool.json': enc.encode(JSON.stringify(OURS)),
      'https://x.dev/fw/bootloader.bin': bytes(100),
      'https://x.dev/fw/app.bin': bytes(200),
    });
    const plan = new FlashPlan(host, () => {});
    await plan.load('x.dev/fw');
    plan.selectSet(0);
    plan.toggle(plan.rows[1]!);
    plan.addPart({ file: keep('mine.bin', bytes(30)) }, 0x200000);
    plan.addPart({ file: file('no-handle.bin', bytes(30)) }, 0x300000);
    await settle();
    const saved = structuredClone(plan.save()); // must survive IndexedDB

    forget();
    const again = new FlashPlan(host, () => {});
    again.restore(saved);
    await settle();
    expect(again.status.text).toBe('My FW 1.2.0 · 2 sets (esp-web-tool)');
    expect(again.rows.map((r) => [r.name, r.enabled, r.offset, r.error])).toEqual([
      ['bootloader.bin', true, 0, null],
      ['app.bin', false, 0x10000, null],
      ['mine.bin', true, 0x200000, 'needs permission again (o)'],
      ['no-handle.bin', true, 0x300000, 'not kept after reload: pick it again (e)'],
    ]);
    expect(again.access).toBe('again');
    again.grantAccess();
    await settle();
    await settle();
    expect(again.rows[2]!.data?.length).toBe(30);
  });

  it('without the asset proxy, release files are downloaded by hand and matched by name', async () => {
    const dl = (n: string) => `https://github.com/o/r/releases/download/v1/${n}`;
    const manifest = {
      name: 'Rel',
      sets: [
        {
          id: 'a',
          parts: [
            { path: 'boot.bin', offset: 0, locked: true },
            { path: 'app.bin', offset: 0x10000 },
          ],
        },
      ],
    };
    const host: FileHost = {
      ...fakeHost({}).host,
      fetchJson: async () => [
        { tag_name: 'v2', prerelease: true, assets: [] },
        {
          tag_name: 'v1',
          body: '## Changes',
          assets: [{ name: 'esp-web-tool.json', browser_download_url: dl('esp-web-tool.json') }],
        },
      ],
    };
    const plan = new FlashPlan(host, () => {});
    await plan.load('o/r');
    expect(plan.release?.tag).toBe('v1'); // latest full release, not the pre-release
    expect(plan.release?.body).toBe('## Changes');
    expect(plan.status.kind).toBe('manual');
    expect(plan.downloads).toEqual([{ name: 'esp-web-tool.json', url: dl('esp-web-tool.json') }]);

    // The downloaded manifest stands for the release: its parts are release files too.
    await plan.takeFiles([file('esp-web-tool.json', enc.encode(JSON.stringify(manifest)))]);
    await settle();
    expect(plan.releases).not.toBeNull();
    expect(plan.downloads.map((d) => d.url)).toEqual([dl('boot.bin'), dl('app.bin')]);
    expect(plan.rows.every((r) => r.error === 'download it, then drop it here (m)')).toBe(true);

    const res = await plan.takeFiles([
      file('app.bin', bytes(64)),
      file('boot.bin', bytes(32)),
      file('extra.bin', bytes(16)),
    ]);
    await settle();
    expect(res).toEqual({ matched: 2, added: 1 });
    expect(plan.rows.map((r) => [r.name, r.locked, r.data?.length, r.error])).toEqual([
      ['boot.bin', true, 32, null],
      ['app.bin', false, 64, null],
      ['extra.bin', false, 16, null],
    ]);
    expect(plan.downloads).toEqual([]);
  });

  it('a deep-linked set is selected when the manifest loads', async () => {
    const { host } = fakeHost({
      'https://x.dev/fw/esp-web-tool.json': enc.encode(JSON.stringify(OURS)),
    });
    const plan = new FlashPlan(host, () => {});
    plan.wantSet = 'c3';
    await plan.load('x.dev/fw');
    expect(plan.set?.id).toBe('c3');
  });
});
