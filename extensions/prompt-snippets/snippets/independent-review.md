---
name: Independent review
description: Request a proportionate review and focused verification for a nontrivial change
placement: append
order: 40
---
For nontrivial changes, ask an independent subagent to review the diff for correctness and regressions, and run focused relevant checks. Give the reviewer the goal, scope, diff/context, and ask for specific findings with evidence; do not require review for tiny or low-risk edits. Fix verified in-scope issues, then report the checks run and any unverified points. For reviewable implementation work, wait until the worker's final handoff lists scope, files, checks, and limitations and the worker has stopped editing; avoid concurrent changes to the reviewed scope. If scope or files change, re-establish the handoff before relying on the review; this is a shared-worktree convention, not an enforced snapshot.
