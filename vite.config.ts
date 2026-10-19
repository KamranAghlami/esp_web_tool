import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const base = process.env.BASE_PATH ?? '/';

/** Files in public/ that the page uses (the build doesn't list them). */
const PUBLIC_FILES = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'schema/v1.json'];

/**
 * Emits sw.js with every file of this build precached (SPEC §1: works offline after load;
 * §4.1 installable). The cache is named after the commit, so a deploy replaces it. Pages are
 * network-first (a new deploy shows up at once), files cache-first (their names are hashed).
 * Only same-origin GETs are handled: fetches of manifests and firmware pass straight through.
 */
function serviceWorker(): Plugin {
  return {
    name: 'esp-web-tool-sw',
    apply: 'build',
    // After everything is written: CSS and the final chunk names are only known by then.
    writeBundle(options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      const precache = [base, ...[...files, ...PUBLIC_FILES].map((f) => base + f)];
      writeFileSync(
        join(options.dir!, 'sw.js'),
        `const CACHE = ${JSON.stringify(`esp-web-tool-${gitSha()}`)};
const BASE = ${JSON.stringify(base)};
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(BASE, copy));
          return res;
        })
        .catch(() => caches.match(BASE, { ignoreVary: true })),
    );
    return;
  }
  // Module scripts and crossorigin styles carry an Origin header the precache requests
  // didn't; servers that send Vary: Origin would make them miss.
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req)));
});
`,
      );
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; CI sets BASE_PATH accordingly.
  base,
  plugins: [serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha()),
  },
  resolve: {
    alias: {
      // @xterm/headless 6.0.0 declares a "module" entry that is not shipped.
      '@xterm/headless': fileURLToPath(
        new URL('./node_modules/@xterm/headless/lib-headless/xterm-headless.mjs', import.meta.url),
      ),
    },
  },
  // Most of the bundle is xterm.js (page terminal + headless monitor terminal).
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 800 },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
