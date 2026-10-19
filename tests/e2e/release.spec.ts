import { expect, type Page, test } from '@playwright/test';
import { expectOnScreen, openApp, screenText } from './harness';

/** GitHub releases without the asset proxy: notes, manual assist, deep links (SPEC §7, §10). */

const dl = (n: string) => `https://github.com/o/r/releases/download/v1/${n}`;
const RELEASES = [
  {
    tag_name: 'v1',
    name: 'First',
    body: '## Changes\n- faster boot',
    published_at: '2026-10-01T00:00:00Z',
    assets: [{ name: 'esp-web-tool.json', browser_download_url: dl('esp-web-tool.json') }],
  },
];
const MANIFEST = {
  name: 'Rel',
  sets: [
    { id: 'a', name: 'A', parts: [{ path: 'app.bin', offset: '0x10000' }] },
    {
      id: 'b',
      name: 'B',
      parts: [
        { path: 'boot.bin', offset: 0 },
        { path: 'app.bin', offset: '0x10000' },
      ],
    },
  ],
};

async function routeGitHub(page: Page): Promise<void> {
  await page.route('https://api.github.com/repos/o/r/releases**', (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(RELEASES),
    }),
  );
}

async function loadRepo(page: Page): Promise<void> {
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('o/r');
  await page.keyboard.press('Enter');
  await expectOnScreen(page, '↓ v1: download esp-web-tool.json, then drop it here (m)');
}

test.describe('releases', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await routeGitHub(page);
  });

  test('notes, and manual assist with the file picker', async ({ page }) => {
    await loadRepo(page);
    await page.keyboard.press('n');
    await expectOnScreen(page, '- faster boot');
    await page.keyboard.press('Escape');

    await page.keyboard.press('m');
    await expectOnScreen(page, '↗ esp-web-tool.json');
    await page.evaluate(
      (text) => (window as any).__picks.push([{ name: 'esp-web-tool.json', text }]),
      JSON.stringify(MANIFEST),
    );
    await page.keyboard.press('p');
    await expectOnScreen(page, 'Rel · 2 sets');
    await expectOnScreen(page, 'download it, then drop it here (m)');

    await page.keyboard.press('m');
    await expectOnScreen(page, '↗ app.bin');
    await page.evaluate(() =>
      (window as any).__picks.push([{ name: 'app.bin', size: 2048 }, { name: 'other.bin' }]),
    );
    await page.keyboard.press('p');
    await expectOnScreen(page, '1 matched by name, 1 added as new part');
    await expectOnScreen(page, '2.0 KiB');
  });

  test('files dropped onto the page are matched by name', async ({ page }) => {
    await loadRepo(page);
    const drop = (files: { name: string; text: string }[]) =>
      page.evaluate((files) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(new File([f.text], f.name));
        for (const type of ['dragenter', 'drop'])
          document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true }));
      }, files);
    await drop([{ name: 'esp-web-tool.json', text: JSON.stringify(MANIFEST) }]);
    await expectOnScreen(page, 'Rel · 2 sets');
    await drop([{ name: 'app.bin', text: 'x'.repeat(100) }]);
    await expectOnScreen(page, '1 matched by name');
    expect((await screenText(page)).join('\n')).not.toContain('download it, then drop');
  });

  test('a deep link picks the release, the set and the bauds', async ({ page }) => {
    await page.goto('/?repo=o/r&tag=v1&set=b&baud=460800&monitor=74880');
    await expectOnScreen(page, 'Release');
    await page.evaluate(
      (text) => (window as any).__picks.push([{ name: 'esp-web-tool.json', text }]),
      JSON.stringify(MANIFEST),
    );
    await page.keyboard.press('m');
    await page.keyboard.press('p');
    await expectOnScreen(page, 'boot.bin'); // set B
    await expectOnScreen(page, '460800 ▾');
    const baud = await page.evaluate(() => (window as any).__espwt.app.ports.baudRate);
    expect(baud).toBe(74880);
  });
});
