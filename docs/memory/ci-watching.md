---
name: ci-watching
description: How to wait for a GitHub Actions run; gh run list --commit needs the full SHA
metadata:
  type: reference
---

`gh run list --commit <sha>` didn't match short SHAs here: a watcher looping on `--commit a27d1ad` never saw the finished run. Pass the full hash (`git rev-parse HEAD`), or poll `gh run list --limit 1 --json headSha,status`.

**Why:** three watchers in one session hung forever and the user had to say "CI is finished".

**How to apply:** when waiting on CI after a push, resolve the full SHA first; a run ends with check → build-pages → deploy-pages.
