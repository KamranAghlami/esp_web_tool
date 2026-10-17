---
name: github-release-cors
description: GitHub release asset downloads are CORS-blocked in browsers; the releases API is not
metadata:
  type: project
---

Verified 2026-10-17: `api.github.com` releases listing sends `ACAO: *`, but release asset downloads (both `browser_download_url` and the API asset endpoint) redirect to `release-assets.githubusercontent.com`, which sends no ACAO header (and returns 405 on preflight). `raw.githubusercontent.com` and `*.github.io` do send `ACAO: *`.

**Why:** the whole "pick a GitHub release and flash it" flow depends on this; see SPEC §7.4.
**How to apply:** never assume a browser `fetch` of a release asset works. Go through the fetcher strategies (direct → proxy → manual assist). Re-check if GitHub changes its asset hosting.
