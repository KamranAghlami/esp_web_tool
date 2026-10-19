import { expect, test } from '@playwright/test';
import { screenText } from './harness';

/**
 * Installable, and usable offline once loaded (SPEC §1, M5). No harness here: Playwright's
 * request routing and service workers don't mix.
 */
test.use({ serviceWorkers: 'allow' });

test('the service worker caches the app, which then opens offline', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__espwt?.term);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')!.getAttribute('href')!;
    return (await fetch(href)).json();
  });
  expect(manifest).toMatchObject({ name: 'ESP Web Tool', display: 'standalone' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    // Controlled from now on (clients.claim), so the reload goes through it.
    if (!navigator.serviceWorker.controller)
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
  });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => (window as any).__espwt?.term);
  await expect.poll(async () => (await screenText(page)).join('\n')).toContain('ESP Web Tool');
  await context.setOffline(false);
});
