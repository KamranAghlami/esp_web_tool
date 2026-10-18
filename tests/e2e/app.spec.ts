import { expect, type Page, test } from '@playwright/test';
import { cellCenter, expectOnScreen, openApp, type ReadyInfo, screenText } from './harness';

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

/** Cell (col, row) where `text` first appears on screen. */
async function find(page: Page, text: string): Promise<{ col: number; row: number }> {
  const lines = await screenText(page);
  const row = lines.findIndex((l) => l.includes(text));
  expect(row, `"${text}" on screen`).toBeGreaterThanOrEqual(0);
  return { col: lines[row]!.indexOf(text), row };
}

async function clickText(page: Page, info: ReadyInfo, text: string): Promise<void> {
  await expectOnScreen(page, text);
  const { col, row } = await find(page, text);
  const p = cellCenter(info, col, row);
  await page.mouse.click(p.x, p.y);
}

test.describe('app', () => {
  let info: ReadyInfo;
  test.beforeEach(async ({ page }) => {
    info = await openApp(page);
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

  test('device colors and plain ESP-IDF log levels are colored', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() =>
      (window as any).__serialEmit(
        '\x1b[0;31mE (1) boom: device red\x1b[0m\r\nE (2) boom: plain red\r\n' +
          'W (3) hmm: plain yellow\r\nnot a log line\r\n',
      ),
    );
    await expectOnScreen(page, 'not a log line');
    const fgOf = (text: string) =>
      page.evaluate((text) => {
        const term = (window as any).__espwt.term;
        const b = term.buffer.active;
        for (let y = 0; y < term.rows; y++) {
          const line = b.getLine(y);
          const x = line.translateToString(true).indexOf(text);
          if (x >= 0) {
            const cell = line.getCell(x);
            return cell.isFgDefault() ? 'default' : cell.getFgColor();
          }
        }
        return 'missing';
      }, text);
    expect(await fgOf('E (1) boom')).toBe(1);
    expect(await fgOf('E (2) boom')).toBe(1);
    expect(await fgOf('W (3) hmm')).toBe(3);
    expect(await fgOf('not a log line')).toBe('default');
  });

  test('boot mode uses the USB-Serial/JTAG sequence on Espressif native USB', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('b');
    await expectOnScreen(page, 'Boot mode sequence sent (USB-JTAG)');
    // Idle, strap IO0 (DTR), then reset through (1,1) so the strap is latched, release.
    expect(await page.evaluate(() => (window as any).__serialSignals)).toEqual([
      '0,0',
      '1,0',
      '1,1',
      '0,1',
      '0,0',
    ]);
  });

  test('Ctrl+A opens the monitor menu in live mode, and ? there opens the help', async ({
    page,
  }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');
    await expectOnScreen(page, 'Monitor · Ctrl-A');
    await expectOnScreen(page, 'Boot (download) mode');
    await page.keyboard.press('?');
    await expectOnScreen(page, 'Help · Esc to close');
  });

  test('baud and data format are picked from Ctrl+A settings with a way back', async ({ page }) => {
    await page.keyboard.press('2');
    await page.keyboard.press('Control+a');
    await expectOnScreen(page, 'Settings: 115200 8N1 LF ▸');
    await page.keyboard.press('s');
    await page.keyboard.press('b');
    await expectOnScreen(page, '‹ Back');
    await expectOnScreen(page, 'Baud rate');
    await page.keyboard.press('Escape'); // back to Settings, not closed
    await expectOnScreen(page, 'Baud: 115200 ▸');
    await page.keyboard.press('b');
    await clickText(page, info, '460800');
    await expect.poll(async () => (await screenText(page)).join()).not.toContain('‹ Back');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('s');
    await page.keyboard.press('f');
    await clickText(page, info, '8E1');
    await page.keyboard.press('c');
    await expectOnScreen(page, '@ 460800 8E1');
    expect(await page.evaluate(() => (window as any).__serialOpen.at(-1))).toMatchObject({
      baudRate: 460800,
      dataBits: 8,
      parity: 'even',
      stopBits: 1,
    });
    // The flash pane's baud opens its list straight away, and takes focus.
    await clickText(page, info, '921600 ▾');
    await expectOnScreen(page, 'Flash baud');
    await clickText(page, info, '1500000');
    await expectOnScreen(page, '1500000 ▾');
    await page.keyboard.press('Enter'); // focused, so Enter reopens the list
    await expectOnScreen(page, 'Flash baud');
  });

  test('the title and version open the repository and its releases', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__opened = [];
      window.open = ((url: string) => void (window as any).__opened.push(url)) as any;
    });
    await clickText(page, info, 'ESP Web Tool');
    await clickText(page, info, 'v0.1.0');
    expect(await page.evaluate(() => (window as any).__opened)).toEqual([
      'https://github.com/KamranAghlami/esp_web_tool',
      'https://github.com/KamranAghlami/esp_web_tool/releases/tag/v0.1.0',
    ]);
  });

  test('dragging in the monitor selects buffer text and copies it', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__copied = [];
      navigator.clipboard.writeText = async (t: string) => void (window as any).__copied.push(t);
    });
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() => (window as any).__serialEmit('first line\r\nsecond line\r\n'));
    await expectOnScreen(page, 'second line');
    const a = await find(page, 'hello from fake port');
    const b = await find(page, 'second line');
    const from = cellCenter(info, a.col + 'hello '.length, a.row);
    const to = cellCenter(info, b.col + 'second'.length - 1, b.row);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => (window as any).__copied))
      .toEqual(['from fake port\nfirst line\nsecond']);
    await expectOnScreen(page, 'Copied');
  });

  test('double click selects a word, triple click a line, never the pane border', async ({
    page,
  }) => {
    await page.evaluate(() => {
      (window as any).__copied = [];
      navigator.clipboard.writeText = async (t: string) => void (window as any).__copied.push(t);
    });
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() => (window as any).__serialEmit('W (5) sensor: retrying in 500 ms\r\n'));
    await expectOnScreen(page, 'retrying in 500 ms');
    const at = await find(page, 'W (5) sensor');
    const copied = () => page.evaluate(() => (window as any).__copied.at(-1));

    const word = cellCenter(info, at.col + 'W (5) '.length + 2, at.row);
    await page.mouse.dblclick(word.x, word.y);
    await expect.poll(copied).toBe('sensor:');

    // "W" is the first cell of the pane, right after the border: the border stays out.
    const first = cellCenter(info, at.col, at.row);
    await page.mouse.dblclick(first.x, first.y);
    await expect.poll(copied).toBe('W');

    await page.mouse.click(word.x, word.y, { clickCount: 3 });
    await expect.poll(copied).toBe('W (5) sensor: retrying in 500 ms');
  });

  test('status line shows rx and tx rates while connected', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await expectOnScreen(page, '/s · tx ');
  });

  test('settings are remembered across reloads, and per USB device', async ({ page }) => {
    // Monitor defaults and flash options stick in this browser.
    await page.keyboard.press('2');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('h'); // colors off
    await page.keyboard.press('Control+a');
    await page.keyboard.press('s');
    await page.keyboard.press('b');
    await clickText(page, info, '74880');
    await page.reload();
    await expectOnScreen(page, 'ESP Web Tool');
    await page.keyboard.press('2');
    await page.keyboard.press('Control+a');
    await expectOnScreen(page, 'Settings: 74880 8N1 LF ▸');
    expect(await page.evaluate(() => (window as any).__espwt.app.monitor.colorize)).toBe(false);
    await page.keyboard.press('Escape');

    // The fake device (303a:1001) gets 230400 while connected...
    await page.keyboard.press('c');
    await expectOnScreen(page, '@ 74880 8N1');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('s');
    await page.keyboard.press('b');
    await clickText(page, info, '230400');
    await expectOnScreen(page, '@ 230400 8N1');
    await page.keyboard.press('c'); // disconnect
    await expectOnScreen(page, 'not connected');
    // ...and keeps it after a reload, whatever the default is meanwhile.
    await page.reload();
    await expectOnScreen(page, 'ESP Web Tool');
    await page.keyboard.press('c');
    await expectOnScreen(page, '@ 230400 8N1');
    await expectOnScreen(page, 'remembered settings');
  });

  test('help scrolls with the mouse wheel', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 480 });
    await page.keyboard.press('?');
    await expectOnScreen(page, 'Help · Esc to close');
    await expectOnScreen(page, 'Anywhere');
    const { col, row } = await find(page, 'Help · Esc');
    const p = cellCenter(info, col, row + 3);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await screenText(page)).join('\n')).not.toContain('Anywhere');
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

  test('M0 spike: demo flood keeps the UI responsive', async ({ page }) => {
    await page.goto('/?demo=flood');
    await expectOnScreen(page, 'demo:flood');
    await page.waitForTimeout(3000);
    const stats = await page.evaluate(() => (window as any).__espwt.app.stats);
    console.log(
      `demo flood: ${stats.fps} fps, ${(stats.rxPerSec / 1024).toFixed(0)} KiB/s into the monitor`,
    );
    // Smoke thresholds only: headless Chromium paints in software, so this measures a worst
    // case (see SPEC §14, M0 findings). The JS pipeline itself is benchmarked in term-pane.test.ts.
    expect(stats.rxPerSec).toBeGreaterThan(50 * 1024);
    expect(stats.fps).toBeGreaterThanOrEqual(5);
  });
});
