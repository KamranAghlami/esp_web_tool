---
name: dev-environment
description: The main dev box is a 1-core VM without a GPU; browser perf numbers measured there are a worst case
metadata:
  type: project
---

As of 2026-10-17, the machine at `~/projects/esp_web_tool` is a 1-vCPU VM with a virtio GPU (no hardware acceleration), and Node was not installed system-wide.

**Why:** headless-Chromium measurements there (about 10 fps / about 120 KiB/s for the monitor flood, with software paint dominating) say little about real desktops. WebGL there is software-only.

**How to apply:** treat e2e perf thresholds as smoke tests, and confirm real throughput on a desktop with a GPU. Don't install Node into the system: use a user-local or scratch copy, following the user's no-system-modification rule for Python. See [[playwright-user-activation]] for the other e2e gotcha.

On 2026-10-19 the VM's load average sat at 10–15 for minutes with nothing of ours running (host contention). Every local e2e test then timed out in `openApp`, while the same commit passed on GitHub's runners. Check `uptime` before chasing a local e2e failure; also, a `cmd | grep | head` pipeline hides the test exit code, so check `$?` (or the summary line) before committing on the strength of a run.
