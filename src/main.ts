import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { App, type DemoMode } from './app/app';
import { browserFiles } from './browser/files';
import { indexedDbStore } from './browser/plan-store';
import { darkTheme } from './tui/theme';
import { XtermTty } from './tty/xterm-tty';

const FONT = '"JetBrains Mono", ui-monospace, monospace';

/**
 * Software WebGL (SwiftShader, llvmpipe: headless browsers, VMs, blocklisted GPUs) is several
 * times slower than xterm's DOM renderer, so only use WebGL when a real GPU backs it.
 */
function hasHardwareWebgl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(name);
  } catch {
    return false;
  }
}

/** Clipboard API first; if it is refused (permissions, unfocused document), execCommand. */
async function copyText(text: string, refocus: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    refocus();
    if (!ok) throw err;
  }
}

/** `?manifest=` (or `?repo=`) fills the Manifest field and loads it. */
function manifestFromUrl(): string | undefined {
  const q = new URLSearchParams(location.search);
  return q.get('manifest') ?? q.get('repo') ?? undefined;
}

/** `?demo` starts the synthetic log stream, `?demo=flood` at about 2 Mbaud. */
function demoFromUrl(): DemoMode {
  const v = new URLSearchParams(location.search).get('demo');
  return v === null ? 'off' : v === 'flood' ? 'flood' : 'normal';
}

/** Reading `localStorage` itself throws when site data is blocked. */
function localStorageOrNone(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // xterm measures the font when it opens; make sure the web font is ready first.
  await Promise.all([
    document.fonts.load(`14px ${FONT}`),
    document.fonts.load(`bold 14px ${FONT}`),
  ]).catch(() => {});

  const term = new Terminal({
    fontFamily: FONT,
    fontSize: 14,
    lineHeight: 1,
    theme: darkTheme.xterm,
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 0,
    customGlyphs: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    // xterm's right-click word selection (on by default on macOS) sees the screen as one text,
    // so pane borders join words. The monitor has its own double-click selection instead.
    rightClickSelectsWord: false,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon());

  const host = document.getElementById('terminal')!;
  term.open(host);
  // ?renderer=dom|webgl forces a renderer; by default WebGL is used only when GPU-backed.
  const forced = new URLSearchParams(location.search).get('renderer');
  if (forced === 'webgl' || (forced !== 'dom' && hasHardwareWebgl())) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL: xterm keeps its DOM renderer.
    }
  }

  // Terminal-style clipboard: Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') {
      if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
      e.preventDefault();
      return false;
    }
    // Let the browser fire its paste event, which xterm turns into bracketed paste.
    return e.code !== 'KeyV';
  });

  term.onTitleChange((t) => (document.title = t));

  const refit = () => {
    fit.fit();
    // The app draws whole frames; never leave the view scrolled away from them.
    term.scrollToBottom();
  };
  new ResizeObserver(refit).observe(host);
  // A face that finishes loading later (first visit, empty cache) can change the cell size.
  document.fonts.addEventListener('loadingdone', refit);
  refit();

  const app = new App({
    tty: new XtermTty(term),
    openUrl: (url) => window.open(url, '_blank', 'noopener'),
    copy: (text) => copyText(text, () => term.focus()),
    storage: localStorageOrNone(),
    plans: indexedDbStore(),
    demo: demoFromUrl(),
    files: browserFiles,
    assetProxy: import.meta.env.VITE_ASSET_PROXY as string | undefined,
    manifest: manifestFromUrl(),
  });
  app.start();
  term.focus();

  // Handle for e2e tests and debugging in the console.
  Object.assign(window, { __espwt: { app, term } });
}

void main();
