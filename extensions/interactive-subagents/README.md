# Interactive subagents

This repository contains a customized fork of [Amos Blomqvist's pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is itself a fork of [HazAT's pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).

Spawn Pi agents in Herdr tabs while the parent session keeps working. Child results return to the parent asynchronously as steer messages. Use this when a task can run independently without blocking the parent.

## Requirements

This extension requires [Herdr](https://herdr.dev/) to create agent panes. Use it through this repository's Pi package or a local checkout; tailor enabled extensions with `pi config` or package filtering in the [root README](../../README.md#using). For an editable local checkout, use `/reload` after changing the extension or agent profiles.

The bundled `worker` profile needs Pi's `codemode` tool. The bundled `worker` and `scout` profiles also need the local [`ast_grep` extension](../ast-grep/README.md). Herdr passes launch arguments directly; it does not need tmux, psmux, or a Bash launch shell. Restricted children load Herdr's reporter explicitly because `--no-extensions` disables global extension discovery.

## Use it

Call `subagent({ agent, task, name?, model?, cwd? })` or run `/subagent <agent> <task>`. Spawns are asynchronous. Names are unique within the parent session, including finished agents: omitted names get a unique default; explicit duplicates are rejected. Use `subagent_message({ name, message, intent? })` to steer a running agent or resume a finished one, and `subagents_list()` to list available profiles. A finished agent can resume only while its registered session exists; its saved tools, model, prompt, and working directory are reused.

`intent` may be `task`, `context`, or `reply`; omit it for the existing automatic steer/resume behavior. `task` replaces the child's current assignment in full (rather than accumulating corrections); `context` adds information and `reply` answers the child. Context and replies target a running child only, while a task can steer a running child or resume a finished one. For example, `subagent_message({ name: "api", message: "Implement the bounded API change and report files and checks.", intent: "task" })` assigns/replaces its brief; `subagent_message({ name: "api", message: "Use the existing response shape.", intent: "context" })` adds context, and `subagent_message({ name: "api", message: "Yes, that scope is approved.", intent: "reply" })` answers it. A saved brief is a record of the assignment, not proof that the child complied.

Children can use `ask_question()` to pause for a parent reply. Herdr keeps their work visible in tabs or nested splits. Inside a child, press Ctrl+Alt+O to show or hide its identity and available-tools panel; it starts hidden. The parent widget can also show compact live counts: `↳ N` for a child's active direct children and `● C/T` for its non-deleted TODO tasks. These optional counts disappear when unavailable or stale; they do not replace the child's lifecycle status.

For reliable delegation, make each task self-contained: state the goal, bounded scope/ownership, relevant context, permissions, completion criteria, and concise return format. Use short assignment names, echoed in findings when helpful. Run independent tasks in parallel; keep nesting shallow and avoid repeated status or review requests. Ask only about material scope, correctness, permission, or cost decisions; otherwise use reasonable scoped assumptions. Ask blocked agents for useful partial findings and the smallest next step. Children should distinguish completed, partial, blocked, or failed work and give concise evidence, check results, and any unverified or live-check status. For reviewable implementation work, use a ready-for-review handoff: the worker finishes, reports scope, files, checks, and limitations in its final response, then stops editing; wait for that completed handoff before assigning a reviewer, and avoid concurrent edits to the reviewed scope. If scope or files change, re-establish the handoff before relying on the review. This is a shared-worktree convention, not an enforced snapshot.

Children run with the tools allowed by their profile. `subagent_agents` controls which profiles a child may spawn. Only profiles that grant that access can spawn more agents.

## Agent profiles

Bundled profiles are `scout`, `worker`, `gh-scout`, and `researcher`. Project profiles in `.pi/agents/` override user profiles in `~/.pi/agent/agents/`, which override bundled profiles.

| Profile | Default model | Purpose |
| --- | --- | --- |
| `scout` | `openai/gpt-6-luna` | Read-only local exploration and structural search |
| `worker` | `openai/gpt-6-luna` | Implementation, with `scout` as its only child profile |
| `gh-scout` | `openai/gpt-6-luna` | Read-only GitHub inspection with `gh` |
| `researcher` | `openai/gpt-6-luna` | Web research |

Set `model` in profile frontmatter to customize a profile's default. The `model` argument can override it for one spawn. For example:

```markdown
---
name: my-agent
description: Handles one task
tools: read, edit, safe_bash
model: openai/gpt-6-luna
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

Run these from the repository root in a normal shell, not a restricted child session:

```sh
npm test                 # Unit tests; no Herdr panes or model calls
npm run test:surface     # Herdr pane and command tests; live Herdr checks, no model calls
npm run test:integration # Pi/LLM lifecycle tests; live checks and may incur API costs
```

## License

MIT
