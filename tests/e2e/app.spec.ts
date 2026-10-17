import { expect, type Page, test } from '@playwright/test';
import { cellCenter, expectOnScreen, openApp, screenText } from './harness';

const spikeOf = (page: Page) => page.evaluate(() => (window as any).__espwt.app.spike);

/**
 * M0 spike (SPEC §3.1): requestPort() must be called while the key press or click that
 * triggered it is still a user activation. The fake port enforces this like Chrome does.
 * These tests wait for the page to have no activation, then evaluate nothing in it before
 * the input under test (see harness.ts), so the input is the only possible source.
 */
test.describe('M0 spike: requestPort() from terminal input', () => {
  test.describe.configure({ timeout: 30_000 });

  test('works from a key press', async ({ page }) => {
    const info = await openApp(page, { settle: true });
    expect(info.active).toBe(false);
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await expectOnScreen(page, '303a:1001 @ 115200');
    expect(await spikeOf(page)).toEqual([
      expect.objectContaining({ trigger: 'key', userActivation: true, result: 'granted' }),
    ]);
  });

  test('works from a mouse click on the key bar', async ({ page }) => {
    const info = await openApp(page, { settle: true });
    expect(info.active).toBe(false);
    // The key bar is the second-to-last row and starts with "c Connect" at column 2.
    const p = cellCenter(info, 4, info.rows - 2);
    await page.mouse.click(p.x, p.y);
    await expectOnScreen(page, 'hello from fake port');
    expect(await spikeOf(page)).toEqual([
      expect.objectContaining({ trigger: 'mouse', userActivation: true, result: 'granted' }),
    ]);
  });

  test('harness check: the fake rejects calls without a gesture', async ({ page }) => {
    // Same app code path, triggered from a timer once the load-time activation has expired.
    let resolveSpike!: (s: unknown) => void;
    const reported = new Promise((r) => (resolveSpike = r));
    await page.route('**/__harness/spike?**', (route) => {
      resolveSpike(JSON.parse(new URL(route.request().url()).searchParams.get('d')!));
      return route.fulfill({ status: 204 });
    });
    await page.addInitScript(() => {
      const timer = setInterval(() => {
        const app = (window as any).__espwt?.app;
        if (!app || navigator.userActivation.isActive) return;
        clearInterval(timer);
        app['toggleConnect']();
        setTimeout(() => {
          void fetch('/__harness/spike?d=' + encodeURIComponent(JSON.stringify(app.spike)));
        }, 300);
      }, 100);
    });
    await openApp(page);
    expect(await reported).toEqual([
      expect.objectContaining({
        userActivation: false,
        result: 'error',
        detail: expect.stringContaining('SecurityError'),
      }),
    ]);
  });
});

test.describe('app', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await expectOnScreen(page, 'ESP Web Tool');
  });

  test('renders the split layout inside the terminal', async ({ page }) => {
    const text = (await screenText(page)).join('\n');
    expect(text).toContain('Flash');
    expect(text).toContain('Monitor');
    expect(text).toContain('Parts · example');
    expect(text).toContain('not connected');
  });

  test('live monitor sends keystrokes to the device and leaves with Ctrl+]', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.keyboard.press('Enter');
    await expectOnScreen(page, 'LIVE');
    await page.keyboard.type('help');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__serialWritten)).toBe('help\n');
    await page.keyboard.press('Control+BracketRight');
    await expect.poll(async () => (await screenText(page)).join('\n')).not.toContain('LIVE');
  });

  test('device ANSI colors reach the screen', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() =>
      (window as any).__serialEmit('\x1b[0;31mE (1) boom: red line\x1b[0m\r\n'),
    );
    await expectOnScreen(page, 'E (1) boom: red line');
    const isRed = await page.evaluate(() => {
      const term = (window as any).__espwt.term;
      const b = term.buffer.active;
      for (let y = 0; y < term.rows; y++) {
        const line = b.getLine(y);
        const x = line.translateToString(true).indexOf('E (1) boom');
        if (x >= 0) {
          const cell = line.getCell(x);
          return cell.isFgPalette() && cell.getFgColor() === 1;
        }
      }
      return false;
    });
    expect(isRed).toBe(true);
  });

  test('help overlay opens and closes', async ({ page }) => {
    await page.keyboard.press('?');
    await expectOnScreen(page, 'Help · Esc to close');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await screenText(page)).join('\n'))
      .not.toContain('Help · Esc to close');
  });

  test('text input captures hotkeys while focused', async ({ page }) => {
    await page.keyboard.press('s'); // source → GitHub
    await expectOnScreen(page, 'Repo');
    await page.keyboard.press('Tab'); // focus the repo field
    await page.keyboard.type('espressif/esp-idf');
    await expectOnScreen(page, 'espressif/esp-idf');
    // "c" and "f" were typed into the field, not treated as Connect/Flash.
    const spike = await page.evaluate(() => (window as any).__espwt.app.spike);
    expect(spike).toEqual([]);
  });

  test('narrow terminals show one pane, tiny ones a notice', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    // Wait for the re-layout: the Monitor pane (and its placeholder) disappears.
    await expect
      .poll(async () => (await screenText(page)).join('\n'))
      .not.toContain('No device connected');
    await expectOnScreen(page, 'Flash');
    await page.keyboard.press('2');
    await expectOnScreen(page, 'No device connected');
    await page.setViewportSize({ width: 400, height: 300 });
    await expectOnScreen(page, 'Terminal too small');
  });

  test('quit drops back to the fake shell and restarts on a key', async ({ page }) => {
    await page.keyboard.press('q');
    await expectOnScreen(page, '[esp-web-tool exited]');
    await expectOnScreen(page, '$ esp-web-tool');
    await page.keyboard.press('x');
    await expectOnScreen(page, 'Parts · example');
  });

  test('M0 spike: demo flood keeps the UI responsive', async ({ page }) => {
    await page.keyboard.press('D');
    await page.keyboard.press('D');
    await expectOnScreen(page, 'demo:flood');
    await page.waitForTimeout(3000);
    const stats = await page.evaluate(() => (window as any).__espwt.app.stats);
    console.log(
      `demo flood: ${stats.fps} fps, ${(stats.bytesPerSec / 1024).toFixed(0)} KiB/s into the monitor`,
    );
    // Smoke thresholds only: headless Chromium paints in software, so this measures a worst
    // case (see SPEC §14, M0 findings). The JS pipeline itself is benchmarked in term-pane.test.ts.
    expect(stats.bytesPerSec).toBeGreaterThan(50 * 1024);
    expect(stats.fps).toBeGreaterThanOrEqual(5);
  });
});
