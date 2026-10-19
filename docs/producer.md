# Publishing firmware for ESP Web Tool

How a firmware repo makes its builds flashable from ESP Web Tool (SPEC §6, §12). Two ways, which can be combined:

1. **Release assets**: `esp-web-tool.json` and the binaries attached to each GitHub release. Users enter `owner/repo`; the tool lists the releases. Until the asset proxy exists (SPEC §7.4), the files are downloaded by hand and dropped onto the tool (manual assist), because GitHub serves release files without CORS headers.
2. **A Pages mirror**: the same files copied into the repo's GitHub Pages site (CORS-enabled). Users enter the folder URL (`https://owner.github.io/repo/fw/v1.2.0`) or a deep link, and everything loads directly, no proxy and no manual steps.

## The manifest

`esp-web-tool.json` lists flash sets; each set is the parts for one board or chip. The schema is published at `https://kamranaghlami.github.io/esp_web_tool/schema/v1.json` (point `$schema` at it for editor completion). A minimal one:

```json
{
  "$schema": "https://kamranaghlami.github.io/esp_web_tool/schema/v1.json",
  "manifestVersion": 1,
  "name": "My Firmware",
  "version": "1.2.0",
  "sets": [
    {
      "id": "esp32s3",
      "name": "ESP32-S3",
      "chip": "ESP32-S3",
      "parts": [
        { "path": "bootloader.bin", "offset": "0x0", "sha256": "…" },
        { "path": "partition-table.bin", "offset": "0x8000", "sha256": "…" },
        { "path": "my-fw.bin", "offset": "0x10000", "sha256": "…" }
      ]
    }
  ]
}
```

- `path` is relative to the manifest (in a release: another asset of the same release), or a full `https://` URL.
- `sha256` is checked before flashing.
- `locked: true` on a part, or on a set, stops users from deleting, editing or disabling those rows.
- With several sets, the one whose `chip` matches the connected chip is selected.

## Generating it from an ESP-IDF build

`idf.py build` writes `build/flasher_args.json`. The converter in this repo turns it into a manifest and copies the binaries next to it:

```sh
node tools/flasher-args-to-manifest.mjs build/flasher_args.json \
  --out dist --flat --version 1.2.0 --name "My Firmware" --lock
```

- `--flat`: binaries by file name only (release assets can't have folders).
- `--id`: the set id (default: the chip, e.g. `esp32s3`).
- `--lock`: lock every part.

ESP Web Tool also reads `flasher_args.json` directly (by URL or as a picked file), but without names, sha256 or locks.

## A release workflow

```yaml
# .github/workflows/release.yml
name: release
on:
  release:
    types: [published]
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: espressif/esp-idf-ci-action@v1
        with:
          esp_idf_version: v5.4
          target: esp32s3
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Manifest
        run: |
          curl -fsSLO https://raw.githubusercontent.com/KamranAghlami/esp_web_tool/main/tools/flasher-args-to-manifest.mjs
          node flasher-args-to-manifest.mjs build/flasher_args.json \
            --out dist --flat --version "${GITHUB_REF_NAME#v}" --name "${{ github.event.repository.name }}"
      - name: Attach to the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "$GITHUB_REF_NAME" dist/* --clobber
```

For several chips, build once per target (a matrix) and merge the sets into one manifest before uploading; each set needs its own `id` and binary names that don't collide (e.g. `--out dist/esp32s3` and prefixed file names).

### Optional: the Pages mirror

Add a job that copies `dist/` into the Pages site under `fw/<tag>/`. Then this link flashes the release with no manual steps:

```
https://kamranaghlami.github.io/esp_web_tool/?manifest=https://<owner>.github.io/<repo>/fw/<tag>/
```

## Deep links

- `?manifest=<URL, folder URL or owner/repo>`, or `?repo=owner/repo&tag=v1.2.0`
- `&set=<id>` preselects a set; `&baud=921600` the flash baud; `&monitor=115200` the monitor baud

The tool never flashes from a link alone; the user confirms with `F` and `y`.
