import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; CI sets BASE_PATH accordingly.
  base: process.env.BASE_PATH ?? '/',
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
