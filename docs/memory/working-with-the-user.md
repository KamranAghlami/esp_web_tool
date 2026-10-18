---
name: working-with-the-user
description: How the user iterates on this project — rapid UI feedback in short messages, decisions must land in the spec
metadata:
  type: feedback
---

The user tests each push on their laptop (Chrome on macOS, GPU renderer) and sends terse, rapid-fire UI feedback, often several messages while a turn is still running. They expect every decision to end up in the repo docs (asked explicitly on 2026-10-18: "update md files with decisions we took along the way").

**Why:** the spec (`docs/SPEC.md`) is the source of truth and the user works across machines; decisions that only live in chat get lost.

**How to apply:** after each batch of feedback, update SPEC.md (the relevant section plus a dated line in §14 "M0 findings"/passes) and `docs/CLAUDE.md` conventions in the same commit as the code. Ask before guessing on ambiguous product calls (AskUserQuestion worked well); state assumptions when acting without asking. Verify visually with Playwright screenshots, but remember the dev VM has no GPU ([[dev-environment]]) and can't reproduce macOS/GPU-only issues — ask for a screenshot.
