# My Pi setup

A personal [Pi](https://pi.dev/) setup for [Herdr](https://herdr.dev/), inspired by [Eero Alvar's pi-config](https://github.com/amosblomqvist/pi-config).

## Install

Requires Node.js 22.19+, the `@earendil-works` Pi distribution, and Herdr.

1. Back up `~/.pi/agent`, then copy `extensions/` into `~/.pi/agent/extensions/`. Optionally copy `AGENTS.md` for writing preferences and merge defaults from [settings.example.json](settings.example.json) into `~/.pi/agent/settings.json`.
2. Install extension dependencies:

   ```sh
   cd ~/.pi/agent/extensions/ast-grep
   npm ci --ignore-scripts --omit=peer
   cd ../interactive-subagents
   npm ci --ignore-scripts
   ```

3. Install the supporting packages and Herdr integration:

   ```sh
   pi install npm:@juicesharp/rpiv-ask-user-question@2.12.0
   pi install npm:pi-web-access@0.35.0
   pi install npm:pi-codemode-compact@0.1.1
   herdr integration install pi
   herdr integration status
   ```

4. Choose [agent profile models](extensions/interactive-subagents/README.md#agent-profiles) you can access, authenticate through Pi, and restart Pi inside Herdr. GitHub exploration also requires an authenticated `gh` CLI.

## How it fits together

> [!WARNING]
> Be mindful, interactive subagents may require manual input in WSL. The orchestrator will see this as subagents stalling.

[Interactive subagents](extensions/interactive-subagents/README.md) delegate work to scout, worker, GitHub, and researcher profiles in Herdr panes. Scouts and workers use [ast-grep](extensions/ast-grep/README.md) for structural code search; workers use codemode, and researchers use web access. The question package lets Pi ask structured questions. Herdr installs and manages its own agent-state reporter.

[Prompt snippets](extensions/prompt-snippets/README.md) add optional instructions to your next message, including delegation and orchestration modes. Select them with `Alt+S` or `/snippets`. The usage footer displays session usage, with formatting helpers in `extensions/lib/`.