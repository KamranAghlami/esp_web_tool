import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { expectOnScreen, openApp, screenText } from './harness';

/** The flasher against the simulated ESP32-S3 behind the fake port (tests/fake-esp.ts). */

const image = (n: number, seed: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * seed + (i >> 5)) & 0xff;
  b[0] = 0xe9;
  return b;
};
const BOOT = image(9000, 3);
const APP = image(150_000, 7);
const md5 = (b: Buffer | Uint8Array) => createHash('md5').update(b).digest('hex');

async function waitOnScreen(page: Page, text: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await screenText(page)).join('\n'), { timeout }).toContain(text);
}

async function loadManifest(page: Page, sets: unknown[]): Promise<void> {
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://fw.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'esp-web-tool.json')
      return route.fulfill({ headers: cors, body: JSON.stringify({ name: 'Real', sets }) });
    return route.fulfill({ headers: cors, body: name === 'app.bin' ? APP : BOOT });
  });
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('fw.test/real');
  await page.keyboard.press('Enter');
  await expectOnScreen(page, 'Real');
}

const S3_SET = {
  id: 's3',
  name: 'S3',
  chip: 'ESP32-S3',
  parts: [
    { path: 'bootloader.bin', offset: 0 },
    { path: 'app.bin', offset: '0x10000' },
  ],
};

test.describe('flasher', () => {
  test.describe.configure({ timeout: 90_000 });
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await expectOnScreen(page, 'ESP Web Tool');
  });

  test('F flashes and verifies, then the monitor gets the port back', async ({ page }) => {
    await loadManifest(page, [S3_SET]);
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.keyboard.press('F');
    await expectOnScreen(page, '2 parts');
    await page.keyboard.press('y');
    await waitOnScreen(page, 'Flashed 2 parts');
    await expectOnScreen(page, 'verified');
    // The chip is in the status line, and esptool's log is in the monitor.
    await expectOnScreen(page, 'CHIP ESP32-S3');
    await expectOnScreen(page, 'MAC 34:85:18:aa:bb:cc');
    await expectOnScreen(page, 'Chip is ESP32-S3');
    const flashed = await page.evaluate(
      ({ at, n }) => {
        const w = window as any;
        return w.__md5(w.__esp.flash.subarray(at, at + n));
      },
      { at: 0x10000, n: APP.length },
    );
    expect(flashed).toBe(md5(APP));
    // Reset after: the app boots and the monitor is open again.
    await expect.poll(() => page.evaluate(() => (window as any).__esp.boots)).toBe(1);
    await expectOnScreen(page, '● 303a:1001 @ 115200');
  });

  test('a set made for another chip is swapped for the right one', async ({ page }) => {
    await loadManifest(page, [{ ...S3_SET, id: 'c3', name: 'C3', chip: 'ESP32-C3' }, S3_SET]);
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.keyboard.press('F');
    await page.keyboard.press('y');
    await waitOnScreen(page, 'the ESP32-S3 set is now selected');
    await page.keyboard.press('F');
    await page.keyboard.press('y');
    await waitOnScreen(page, 'Flashed 2 parts');
  });

  test('E erases only after y; Enter does not confirm it', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() => (window as any).__esp.flash.fill(0, 0, 16));
    await page.keyboard.press('E');
    await expectOnScreen(page, "This can't be undone");
    await page.keyboard.press('Enter');
    await expectOnScreen(page, "This can't be undone");
    await page.keyboard.press('y');
    await waitOnScreen(page, 'Erased the 4MB flash');
    expect(await page.evaluate(() => (window as any).__esp.flash[0])).toBe(0xff);
  });

  test('D dumps a region to a file', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() => (window as any).__esp.flash.set([1, 2, 3, 4], 0x1000));
    await page.keyboard.press('D');
    await expectOnScreen(page, 'Dump flash');
    await page.keyboard.press('Shift+Tab'); // the offset
    await page.keyboard.press('Control+u');
    await page.keyboard.type('1000');
    await page.keyboard.press('Tab');
    await page.keyboard.type('0x2000');
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('esp32-s3-348518aabbcc-0x001000-0x002000.bin');
    const data = readFileSync(await file.path());
    expect(data.length).toBe(0x2000);
    expect([...data.subarray(0, 5)]).toEqual([1, 2, 3, 4, 0xff]);
    await waitOnScreen(page, 'Saved esp32-s3-');
  });

  test('i reads the chip details', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'i to detect');
    await page.keyboard.press('i');
    await waitOnScreen(page, 'CHIP ESP32-S3');
    await expectOnScreen(page, 'FLASH 4MB');
  });

  test('a board that goes away and comes back is reopened', async ({ page }) => {
    await page.keyboard.press('c');
    await expectOnScreen(page, 'hello from fake port');
    await page.evaluate(() => (window as any).__serialUnplug());
    await expectOnScreen(page, 'waiting for it');
    await page.evaluate(() => (window as any).__serialReplug());
    await expectOnScreen(page, 'Reconnected 303a:1001');
    await expectOnScreen(page, '● 303a:1001 @ 115200');
  });
});
