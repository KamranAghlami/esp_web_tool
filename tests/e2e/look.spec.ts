import { expect, test } from '@playwright/test';
import { expectOnScreen, openApp } from './harness';

/** The theme follows the system unless set (SPEC §4, M5). */
test.use({ colorScheme: 'light' });

test('light when the system is, and dark when chosen in Settings', async ({ page }) => {
  await openApp(page);
  const bg = () => page.evaluate(() => (window as any).__espwt.term.options.theme.background);
  await expect.poll(bg).toBe('#ffffff');
  await page.keyboard.press('s');
  await expectOnScreen(page, 'Theme: auto ▸');
  await page.keyboard.press('t');
  await page.keyboard.press('End'); // Dark
  await page.keyboard.press('Enter');
  await expect.poll(bg).toBe('#0d1117');
  await page.reload();
  await expect.poll(bg).toBe('#0d1117'); // remembered
});
