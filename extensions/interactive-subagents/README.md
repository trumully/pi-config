# Interactive subagents

Spawn Pi agents in Herdr tabs while the parent session keeps working. Child results return to the parent asynchronously as steer messages. Use this when a task can run independently without blocking the parent.

## Requirements and setup

- Node.js 22.19+ and [Herdr](https://herdr.dev/). Development uses Pi 0.99.2; the Pi peer dependency is unpinned.
- Install Herdr's Pi integration once, then check it:

  ```powershell
  herdr integration install pi
  herdr integration status
  ```

- Load this local extension from `~/.pi/agent/extensions/interactive-subagents`. It is not managed by `pi update`. Restart or reload Pi after changing the extension or agent profiles.
- The bundled `worker` profile needs Pi's `codemode` tool. The bundled `worker` and `scout` profiles also need the local [`ast_grep` extension](../ast-grep/README.md).

Herdr creates the agent panes and passes launch arguments directly. It does not need tmux, psmux, or a Bash launch shell. Restricted children load Herdr's reporter explicitly because `--no-extensions` disables global extension discovery.

## Use it

Call `subagent({ agent, task, name?, model?, cwd? })` or run `/subagent <agent> <task>`. Spawns are asynchronous. Use `subagent_message({ name, message })` to steer a running agent or resume a finished one, and `subagents_list()` to list available profiles. A finished agent can resume only while its registered session exists; its saved tools, model, prompt, and working directory are reused.

Children can use `ask_question()` to pause for a parent reply. Herdr keeps their work visible in tabs or nested splits.

Children run with the tools allowed by their profile. `subagent_agents` controls which profiles a child may spawn. Only profiles that grant that access can spawn more agents.

## Agent profiles

Bundled profiles are `scout`, `worker`, `gh-scout`, and `researcher`. Project profiles in `.pi/agents/` override user profiles in `~/.pi/agent/agents/`, which override bundled profiles.

| Profile | Default model | Purpose |
| --- | --- | --- |
| `scout` | `openai-codex/gpt-6-luna` | Read-only local exploration and structural search |
| `worker` | `openai-codex/gpt-6-luna` | Implementation, with `scout` as its only child profile |
| `gh-scout` | `openai-codex/gpt-6-luna` | Read-only GitHub inspection with `gh` |
| `researcher` | `openai-codex/gpt-6-luna` | Web research |

Set `model` in profile frontmatter to customize a profile's default. The `model` argument can override it for one spawn. For example:

```markdown
---
name: my-agent
description: Handles one task
tools: read, edit, safe_bash
model: openai-codex/gpt-6-luna
subagent_agents: scout
auto-exit: true
---
Instructions for this agent.
```

`tools` is an allowlist. `subagent_agents` grants spawning access and limits which profiles can be spawned; omit it to prevent spawning. Other profile options include `cwd`, `thinking`, `skills`, `session-mode`, `system-prompt`, `auto-exit`, and `interactive`.

## Configuration

Copy `config.json.example` to `config.json` in this extension directory. It is gitignored. The supported options are:

```json
{
  "status": { "enabled": true },
  "proactiveCompaction": { "enabled": true, "thresholdPercent": 70 }
}
```

Status controls the agent-state display. Proactive compaction applies to Pi children, not the parent or Claude CLI agents. If compaction fails or is interrupted, the child stays open; send a follow-up to continue from its checkpoint.

## Tests

Install locked dependencies from this directory with `npm ci --ignore-scripts`. Run these from a normal shell, not a restricted child session:

```powershell
npm test                 # Unit tests; no Herdr panes or model calls
npm run test:surface     # Herdr pane and command tests; no model calls
npm run test:integration # Pi/LLM lifecycle tests; may incur API costs
```

## License

MIT
