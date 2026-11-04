# My Pi config

A personal [Pi](https://pi.dev/) setup for [Herdr](https://herdr.dev/), inspired by [Eero Alvar's pi-config](https://github.com/amosblomqvist/pi-config).

https://github.com/user-attachments/assets/2096be3f-fff2-42a2-9fae-401083126e11

## Using

```sh
pi install git:github.com/trumully/pi-config
```

Tailor the config with `pi config` or [package filtering](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/coding-agent/docs/packages.md#package-filtering).

## Prerequisites

Interactive subagents require Herdr. Start Pi inside `herdr-app` with `hc` on PATH, or inside legacy Herdr with its `herdr` CLI available.

Some bundled agent profiles need extra tools; see their definitions for details. Claude Code agents need [uv](https://docs.astral.sh/uv/getting-started/installation/).

## Extensions

| Extension | Description |
| --- | --- |
| [`ast-grep`](extensions/ast-grep/README.md) | Structural code search. |
| [`gh-readonly`](extensions/gh-readonly/README.md) | Read-only GitHub CLI inspection without a shell or local clone. |
| [`git-readonly`](extensions/git-readonly/README.md) | Local Git status, diffs, commits, and history without shell access. |
| [`prompt-snippets`](extensions/prompt-snippets/README.md) | Add reusable instructions to a message. |
| [`interactive-subagents`](extensions/interactive-subagents/README.md) | Delegate work to agents in Herdr panes. |
| [`usage-footer`](extensions/usage-footer/index.ts) | Display session usage. |

## Community packages

These packages are pinned dependencies and load with the Git-installed config; no separate `pi install` commands are needed. Use `pi config` to disable any you do not want. If you previously installed one separately, remove that standalone package entry to avoid loading it twice.

After changes have been pushed to this repository, update an existing installation with:

```sh
pi update git:github.com/trumully/pi-config
```

Restart Pi after updating. `settings.example.json` is a reference, not a settings file automatically applied by the package.

| Package | Description |
| --- | --- |
| [`rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | Structured question tool. |
| [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) | Web access for researcher profiles. |
| [`pi-codemode-compact`](https://www.npmjs.com/package/pi-codemode-compact) | Compact display of codemode calls and results (not context compaction). |
| [`rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) | Session-local task list for multistep work. |

## Workflow

Use [interactive subagents](extensions/interactive-subagents/README.md) to delegate focused tasks and [prompt snippets](extensions/prompt-snippets/README.md) to add reusable instructions to your messages. Open the snippets menu with `Alt+S` or `/snippets`.

Keep small, known-file changes in the main session. Delegate when a self-contained job isolates substantial reading, enables independent work, or needs a different permitted toolset. Keep tightly dependent steps together.

| Task | Starting point |
| --- | --- |
| Quick lookup, small edit, or simple command | Main session |
| Unfamiliar code or independent code questions | Delegate exploration with targeted `scout` assignments; parent implements |
| Local diffs/history or remote GitHub inspection | `gh-scout`, with `git_readonly` for local Git and `gh_readonly` for GitHub |
| External documentation or factual research | `researcher` returns cited findings; parent saves any note |
| Bounded design decision | `architect` returns a plan, not permission to implement |
| Independent implementation with clear file ownership | Orchestrator mode with a `worker` |
| Substantial or risky completed change | Independent review after the worker stops editing |

Use Delegate exploration as the lighter assisted workflow. Choose Orchestrator mode when implementation genuinely splits into independent jobs, not simply because the task is large. Give each child a bounded question and request a compact answer with evidence and limits. Verify the critical findings rather than repeating the investigation.

Profile files choose the CLI and model intentionally. Use `subagents_list({ name: "gh-scout" })` to inspect the winning definition and shadowed files before changing a bundled profile. User and project overrides remain in control.
