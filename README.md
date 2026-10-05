# My Pi config

A personal [Pi](https://pi.dev/) setup for [Herdr](https://herdr.dev/), inspired by [Eero Alvar's pi-config](https://github.com/amosblomqvist/pi-config).

https://github.com/user-attachments/assets/2096be3f-fff2-42a2-9fae-401083126e11

## Using

```sh
pi install git:github.com/trumully/pi-config
```

Tailor the config with `pi config` or [package filtering](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/coding-agent/docs/packages.md#package-filtering).

## Extensions

| Extension | Description |
| --- | --- |
| [`ast-grep`](extensions/ast-grep/README.md) | Structural code search. |
| [`prompt-snippets`](extensions/prompt-snippets/README.md) | Add reusable instructions to a message. |
| [`interactive-subagents`](extensions/interactive-subagents/README.md) | Delegate work to agents in Herdr panes. |
| [`usage-footer`](extensions/usage-footer/index.ts) | Display session usage. |

## Community packages

| Package | Description |
| --- | --- |
| [rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | Structured question tool. |
| [pi-web-access](https://www.npmjs.com/package/pi-web-access) | Web access for researcher profiles. |
| [pi-codemode-compact](https://www.npmjs.com/package/pi-codemode-compact) | Compaction support for Pi's codemode. |

## Workflow

[Interactive subagents](extensions/interactive-subagents/README.md) delegate bounded work to scout, worker, and researcher profiles. Scouts and workers use [ast-grep](extensions/ast-grep/README.md); workers use codemode, and researchers use web access. [Prompt snippets](extensions/prompt-snippets/README.md) add optional instructions to your next message. Open their menu with `Alt+S` or `/snippets`.
