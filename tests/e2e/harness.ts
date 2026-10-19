import { expect, type Page } from '@playwright/test';
import { md5 } from '../../src/flash/md5';
import { createFakeEsp } from '../fake-esp';
import { installFakeFiles } from './fake-files';
import { installFakeSerial } from './fake-serial';

export interface ReadyInfo {
  /** navigator.userActivation.isActive when this report was sent. */
  active: boolean;
  cols: number;
  rows: number;
  /** The terminal's screen element, in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Loads the app with the fake serial port and waits until it is running.
 *
 * Careful with user activation: Playwright grants the page a user gesture whenever it
 * evaluates script there, which includes page.evaluate(), exposeBinding() and page.goto()
 * itself. That activation lasts Chrome's 5 s lifespan. So the page reports to the test
 * over the network (a fetch to a URL caught by page.route), which evaluates nothing.
 * With `settle`, openApp also waits until the activation from loading has expired, so a
 * later key press or click is the only possible source of activation.
 */
export async function openApp(
  page: Page,
  opts: { settle?: boolean; url?: string } = {},
): Promise<ReadyInfo> {
  const settle = opts.settle ?? false;
  let resolveReady!: (info: ReadyInfo) => void;
  const ready = new Promise<ReadyInfo>((r) => (resolveReady = r));
  await page.route('**/__harness/ready?**', (route) => {
    const info = JSON.parse(new URL(route.request().url()).searchParams.get('d')!) as ReadyInfo;
    if (!settle || !info.active) resolveReady(info);
    return route.fulfill({ status: 204 });
  });
  // The simulated chip and its MD5 are self-contained functions, injected as source.
  await page.addInitScript({
    content: `window.__md5 = ${md5.toString()};\nwindow.__createFakeEsp = ${createFakeEsp.toString()};`,
  });
  await page.addInitScript(installFakeSerial);
  await page.addInitScript(installFakeFiles);
  // Hermetic: the GitHub API answers 404 unless a test routes it (later routes win).
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' }),
  );
  await page.addInitScript((settle: boolean) => {
    const timer = setInterval(() => {
      const term = (window as any).__espwt?.term;
      if (!term) return;
      const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const info = {
        active: navigator.userActivation.isActive,
        cols: term.cols,
        rows: term.rows,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
      void fetch('/__harness/ready?d=' + encodeURIComponent(JSON.stringify(info)));
      if (!settle || !info.active) clearInterval(timer);
    }, 200);
  }, settle);
  await page.goto(opts.url ?? '/');
  return ready;
}

/** The terminal's visible text, one string per row: exactly what the user sees. */
export async function screenText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (window as any).__espwt.term;
    const b = term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    }
    return out;
  });
}

export async function expectOnScreen(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => (await screenText(page)).join('\n'), { timeout: 5000 })
    .toContain(text);
}

/** Pixel center of a terminal cell, from geometry reported at startup (no page evaluation). */
export function cellCenter(info: ReadyInfo, col: number, row: number): { x: number; y: number } {
  const { rect, cols, rows } = info;
  return {
    x: rect.x + ((col + 0.5) * rect.width) / cols,
    y: rect.y + ((row + 0.5) * rect.height) / rows,
  };
}
