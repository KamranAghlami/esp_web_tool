import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/flash/manifest';

describe('tools/flasher-args-to-manifest.mjs', () => {
  it('turns an IDF build into an esp-web-tool.json our parser reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ewt-'));
    const build = join(dir, 'build');
    mkdirSync(join(build, 'bootloader'), { recursive: true });
    const boot = Buffer.from([0xe9, 1, 2, 3]);
    writeFileSync(join(build, 'bootloader', 'bootloader.bin'), boot);
    writeFileSync(join(build, 'hello.bin'), Buffer.from([0xe9, 9, 9]));
    writeFileSync(
      join(build, 'flasher_args.json'),
      JSON.stringify({
        flash_files: { '0x10000': 'hello.bin', '0x0': 'bootloader/bootloader.bin' },
        flash_settings: { flash_mode: 'dio', flash_freq: '80m', flash_size: '4MB' },
        extra_esptool_args: { chip: 'esp32s3' },
        app: { file: 'hello.bin' },
      }),
    );
    const out = join(dir, 'dist');
    execFileSync('node', [
      'tools/flasher-args-to-manifest.mjs',
      join(build, 'flasher_args.json'),
      '--out',
      out,
      '--flat',
      '--lock',
      '--version',
      '1.2.0',
    ]);
    const m = parseManifest(readFileSync(join(out, 'esp-web-tool.json'), 'utf8'));
    expect(m).toMatchObject({ name: 'hello', version: '1.2.0', format: 'esp-web-tool' });
    expect(m.sets[0]).toMatchObject({ id: 'esp32s3', chip: 'ESP32-S3', flash: { mode: 'dio' } });
    expect(m.sets[0]!.parts).toEqual([
      {
        path: 'bootloader.bin',
        offset: 0,
        sha256: createHash('sha256').update(boot).digest('hex'),
        locked: true,
      },
      { path: 'hello.bin', offset: 0x10000, sha256: expect.any(String), locked: true },
    ]);
    expect(readFileSync(join(out, 'bootloader.bin'))).toEqual(boot);
  });

  it('the published JSON Schema is valid JSON with the parts we read', () => {
    const schema = JSON.parse(readFileSync('public/schema/v1.json', 'utf8'));
    expect(schema.required).toEqual(['sets']);
    expect(Object.keys(schema.$defs.part.properties)).toEqual([
      'path',
      'offset',
      'sha256',
      'locked',
    ]);
  });
});
