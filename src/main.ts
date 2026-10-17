import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { App } from './app/app';
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

  const refit = () => fit.fit();
  new ResizeObserver(refit).observe(host);
  refit();

  const app = new App({ tty: new XtermTty(term) });
  app.start();
  term.focus();

  // Handle for e2e tests and debugging in the console.
  Object.assign(window, { __espwt: { app, term } });
}

void main();
