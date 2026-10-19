#!/usr/bin/env node
/**
 * Turns ESP-IDF's build/flasher_args.json into an esp-web-tool.json (docs/producer.md).
 *
 *   node flasher-args-to-manifest.mjs build/flasher_args.json [--out dist] [--name "My FW"]
 *       [--version 1.2.0] [--id esp32s3] [--lock] [--flat]
 *
 * Copies the binaries next to the manifest (with --flat, by file name only, which is what
 * release assets need), and writes each part's sha256.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input) {
  console.error('usage: flasher-args-to-manifest.mjs build/flasher_args.json [--out dir] ...');
  process.exit(2);
}

const build = dirname(resolve(input));
const fa = JSON.parse(readFileSync(input, 'utf8'));
const out = resolve(opt('out', 'dist'));
const flat = args.includes('--flat');
const chipArg = String(fa.extra_esptool_args?.chip ?? '');
// esptool's "esp32s3" → "ESP32-S3"
const chip = chipArg.toUpperCase().replace(/^ESP32(?=[A-Z])/, 'ESP32-') || undefined;
const app = fa.app?.file ? basename(fa.app.file, '.bin') : 'firmware';

mkdirSync(out, { recursive: true });
const parts = Object.entries(fa.flash_files ?? {})
  .map(([offset, file]) => {
    const data = readFileSync(join(build, file));
    const path = flat ? basename(file) : file;
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(join(build, file), join(out, path));
    return {
      path,
      offset,
      sha256: createHash('sha256').update(data).digest('hex'),
      ...(args.includes('--lock') ? { locked: true } : {}),
    };
  })
  .sort((a, b) => parseInt(a.offset, 16) - parseInt(b.offset, 16));

const fs = fa.flash_settings ?? {};
const manifest = {
  $schema: 'https://kamranaghlami.github.io/esp_web_tool/schema/v1.json',
  manifestVersion: 1,
  name: opt('name', app),
  ...(opt('version') ? { version: opt('version') } : {}),
  sets: [
    {
      id: opt('id', chipArg || 'default'),
      name: chip ?? app,
      ...(chip ? { chip } : {}),
      flash: { mode: fs.flash_mode, freq: fs.flash_freq, size: fs.flash_size },
      parts,
    },
  ],
};
writeFileSync(join(out, 'esp-web-tool.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${join(out, 'esp-web-tool.json')}: ${parts.length} parts`);
