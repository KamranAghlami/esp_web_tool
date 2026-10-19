import { devices, expect, type Page, test } from '@playwright/test';
import { expectOnScreen, openApp, screenText } from './harness';

/** The compact layout and touch input on an emulated Pixel 7 (SPEC §4.1). */
test.use({ ...devices['Pixel 7'] });

/**
 * Tap the terminal cell where `text` is shown (its first character, plus `dx`). The lowest
 * match wins: key labels live in the bottom rows.
 */
async function tapText(page: Page, text: string, dx = 0): Promise<void> {
  await expectOnScreen(page, text);
  const lines = await screenText(page);
  const row = lines.findLastIndex((l) => l.includes(text));
  const col = lines[row]!.indexOf(text) + dx;
  const p = await page.evaluate(
    ({ col, row }) => {
      const term = (window as any).__espwt.term;
      const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {
        x: r.x + ((col + 0.5) * r.width) / term.cols,
        y: r.y + ((row + 0.5) * r.height) / term.rows,
      };
    },
    { col, row },
  );
  await page.touchscreen.tap(p.x, p.y);
}

test.describe('phone', () => {
  test('compact layout with tabs, a short status line and the extra-keys bar', async ({ page }) => {
    const info = await openApp(page);
    expect(info.cols).toBeGreaterThanOrEqual(40);
    expect(info.cols).toBeLessThan(80);
    await expectOnScreen(page, '1 Flash');
    await expectOnScreen(page, '2 Monitor');
    await expectOnScreen(page, '○ not connected · c');
    const text = (await screenText(page)).join('\n');
    expect(text).not.toContain('Terminal too small');
    for (const key of ['Esc', 'Tab', 'Ctrl', '^A', '^]', 'kbd']) expect(text).toContain(key);

    // A tap on the other tab switches panes.
    await tapText(page, '2 Monitor', 2);
    await expectOnScreen(page, 'connect a serial port');
  });

  test('taps connect, go live, and the extra keys type for the device', async ({ page }) => {
    await openApp(page, { settle: true });
    await tapText(page, 'c Connect');
    await expectOnScreen(page, 'hello from fake port');
    await tapText(page, '⏎ Monitor'); // live: the soft keyboard is asked for
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    await tapText(page, '^A');
    await expectOnScreen(page, 'Monitor · Ctrl-A');
    await tapText(page, 'Esc');
    await expect
      .poll(async () => (await screenText(page)).join('\n'))
      .not.toContain('Monitor · Ctrl-A');
    await tapText(page, 'Ctrl');
    await page.keyboard.type('c'); // Ctrl armed: this is ^C
    await expect.poll(() => page.evaluate(() => (window as any).__serialWritten)).toBe('\x03');
    await tapText(page, '^]');
    await expectOnScreen(page, 'c Disconnect');
  });

  test('help stacks each key over its description', async ({ page }) => {
    await openApp(page);
    await tapText(page, '? Help');
    await expectOnScreen(page, 'Help · Esc to close');
    const lines = await screenText(page);
    const i = lines.findIndex((l) => /│\s+Tab \/ Shift-Tab\s+│/.test(l));
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toContain('move focus between widgets');
  });
});
