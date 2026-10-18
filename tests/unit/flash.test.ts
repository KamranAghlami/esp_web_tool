import { describe, expect, it } from 'vitest';
import { classify } from '../../src/flash/locate';
import { FetchError, type FileHost, type LocalFile } from '../../src/flash/host';
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
      candidates: ['https://x.dev/fw/m.json'],
    });
    expect(classify('example.com/fw')).toEqual({
      kind: 'url',
      candidates: [
        'https://example.com/fw/esp-web-tool.json',
        'https://example.com/fw/manifest.json',
        'https://example.com/fw/flasher_args.json',
      ],
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

/** A fake browser: URL → bytes, plus queued picker results. */
function fakeHost(urls: Record<string, Uint8Array>) {
  const picks: LocalFile[][] = [];
  let folder: Record<string, Uint8Array> | null = null;
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
  };
  return {
    host,
    pick: (...files: LocalFile[]) => picks.push(files),
    grant: (files: Record<string, Uint8Array>) => (folder = files),
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
    expect([plan.toggle(locked), plan.deleteRow(locked), plan.setOffset(locked, 4)]).toEqual([
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
    expect(plan.needsFolder).toBe(true);
    grant({ 'bootloader.bin': bytes(10), 'app.bin': bytes(20) });
    plan.grantFolder();
    await settle();
    await settle();
    expect(plan.rows.map((r) => r.data?.length)).toEqual([10, 20]);
    expect(plan.needsFolder).toBe(false);
  });

  it('adds local files with guessed offsets and catches overlaps', async () => {
    const { host, pick } = fakeHost({});
    const plan = new FlashPlan(host, () => {});
    pick(file('bootloader.bin', bytes(0x9000)), file('my-app.bin', bytes(0x100)));
    plan.addFiles();
    await settle();
    await settle();
    expect(plan.rows.map((r) => [r.name, r.offset, r.offsetGuessed])).toEqual([
      ['bootloader.bin', 0, true],
      ['my-app.bin', 0x10000, false],
    ]);
    plan.setOffset(plan.rows[1]!, 0x8000);
    expect(plan.problem()).toBe('bootloader.bin overlaps my-app.bin');
  });

  it('says when GitHub release files need the asset proxy', async () => {
    const host: FileHost = {
      ...fakeHost({}).host,
      fetchJson: async () => [
        {
          tag_name: 'v2',
          prerelease: true,
          assets: [],
        },
        {
          tag_name: 'v1',
          assets: [
            {
              name: 'esp-web-tool.json',
              browser_download_url: 'https://github.com/o/r/releases/download/v1/esp-web-tool.json',
            },
          ],
        },
      ],
    };
    const plan = new FlashPlan(host, () => {});
    await plan.load('o/r');
    expect(plan.release?.tag).toBe('v1'); // latest full release, not the pre-release
    expect(plan.status.text).toMatch(/need the asset proxy/);
  });
});
