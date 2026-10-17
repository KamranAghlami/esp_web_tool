---
name: playwright-user-activation
description: Playwright grants the page user activation on evaluate/exposeBinding/goto, so gesture tests need special care
metadata:
  type: project
---

Verified 2026-10-17 (Playwright 1.64, headless Chromium): every Playwright call that evaluates script in the page gives it transient user activation, which lasts Chrome's 5 s lifespan. That includes `page.evaluate`, `expect.poll` over evaluate, `exposeBinding`, serializing console-message arguments, and `page.goto` itself (about 1 s after load). A page reload keeps the activation too.

**Why:** a test that checks "requestPort() works from a key press" passes even if the key press did nothing, because the activation came from the harness. This hid a broken test until activation was logged over time.

**How to apply:** for gesture-sensitive e2e tests, use `openApp(page, { settle: true })` in `tests/e2e/harness.ts`. It waits until the page reports `isActive === false`, and the page reports only through `fetch` to URLs caught by `page.route`, never through bindings or the console. Evaluate nothing between that point and the input under test. Related: [[github-release-cors]] (another browser constraint that shapes the design).
