# Interactive subagents

This repository contains a customized fork of [Eero Alvar's pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is itself a fork of [HazAT's pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).

Spawn Pi agents in Herdr tabs while the parent session keeps working. Child results return to the parent asynchronously as steer messages. Use this when a task can run independently without blocking the parent.

## Requirements

This extension requires [Herdr](https://herdr.dev/) to create agent panes. Use it through this repository's Pi package or a local checkout; tailor enabled extensions with `pi config` or package filtering in the [root README](../../README.md#using). For an editable local checkout, use `/reload` after changing the extension or agent profiles.

The bundled `worker` profile needs Pi's `codemode` tool. The bundled `worker` and `scout` profiles also need the local [`ast_grep` extension](../ast-grep/README.md). Herdr passes launch arguments directly; it does not need tmux, psmux, or a Bash launch shell. Restricted children load Herdr's reporter explicitly because `--no-extensions` disables global extension discovery.

## Use it

Call `subagent({ agent, task, name?, model?, cwd? })` or run `/subagent <agent> <task>`. Spawns are asynchronous. Names are unique within the parent session, including finished agents: omitted names get a unique default; explicit duplicates are rejected. Use `subagent_message({ name, message, intent? })` to steer a running agent or resume a finished one, and `subagents_list()` to list available profiles. A finished agent can resume only while its registered session exists; its saved tools, model, prompt, and working directory are reused.

`intent` may be `task`, `context`, or `reply`; omit it for the existing automatic steer/resume behavior. `task` replaces the child's current assignment in full (rather than accumulating corrections); `context` adds information and `reply` answers the child. Context and replies target a running child only, while a task can steer a running child or resume a finished one. For example, `subagent_message({ name: "api", message: "Implement the bounded API change and report files and checks.", intent: "task" })` assigns/replaces its brief; `subagent_message({ name: "api", message: "Use the existing response shape.", intent: "context" })` adds context, and `subagent_message({ name: "api", message: "Yes, that scope is approved.", intent: "reply" })` answers it. A saved brief is a record of the assignment, not proof that the child complied.

Completion notices and questions are recorded in a per-parent mailbox before delivery and acknowledged from the parent transcript. Pending notices replay after reload or idle retries without extra recap turns. Delivery is at-least-once, not exactly-once; stable delivery IDs suppress a replay when the parent transcript already contains the result. The extension persists versioned run metadata and reattaches observers to confirmed-live Herdr children after startup/reload. A run left in the middle of launch, an unreadable record, or an unavailable Herdr status remains UNKNOWN and cannot be resumed automatically; a single missing agent-list entry is not proof that a delayed launch has stopped. Existing registry records remain readable, but legacy running entries without metadata are not guessed back into watchers or resumed.

Pi child transcripts have an exclusive ownership sidecar before launch/resume. It remains in place while the child may still be alive, including when the parent shuts down; stale ownership is reclaimed only after the recorded owner is safely recoverable and Herdr confirms the child is absent. Registry updates are serialized across processes. A stale registry lock or uncertain ownership fails closed and may require manual inspection. If result storage fails, delivery falls back to a non-recoverable direct send and logs a warning. A child that disappears without a completion signal is reported as having an unconfirmed outcome.

Children can use `ask_question()` to pause for a parent reply. Herdr keeps their work visible in tabs or nested splits. Inside a child, press Ctrl+Alt+O to show or hide its identity and available-tools panel; it starts hidden. In full mode, the parent widget can also show compact live counts: `↳ N` for a child's active direct children and `● C/T` for its non-deleted TODO tasks. These optional counts disappear when unavailable or stale; they do not replace the child's lifecycle status.

For reliable delegation, make each task self-contained: state the goal, bounded scope/ownership, relevant context, permissions, completion criteria, and concise return format. Use short assignment names, echoed in findings when helpful. Run independent tasks in parallel; keep nesting shallow and avoid repeated status or review requests. Ask only about material scope, correctness, permission, or cost decisions; otherwise use reasonable scoped assumptions. Ask blocked agents for useful partial findings and the smallest next step. Children should distinguish completed, partial, blocked, or failed work and give concise evidence, check results, and any unverified or live-check status. For reviewable implementation work, use a ready-for-review handoff: the worker finishes, reports scope, files, checks, and limitations in its final response, then stops editing; wait for that completed handoff before assigning a reviewer, and avoid concurrent edits to the reviewed scope. If scope or files change, re-establish the handoff before relying on the review. This is a shared-worktree convention, not an enforced snapshot.

Children run with the tools allowed by their profile. `subagent_agents` controls which profiles a child may spawn. Only profiles that grant that access can spawn more agents.

## Agent profiles

Bundled profiles are `scout`, `worker`, `tasker`, `architect`, `writer`, `gh-scout`, `researcher`, `cc-worker`, and `cc-reviewer`. Project profiles in `.pi/agents/` override user profiles in `~/.pi/agent/agents/`, which override bundled profiles.

| Profile | Default model | Purpose |
| --- | --- | --- |
| `scout` | `openai/gpt-6-luna` | Read-only local exploration and structural search |
| `worker` | `openai/gpt-6-luna` | Implementation, with `scout` as its only child profile |
| `tasker` | `openai/gpt-6-luna` | Tiny, well-specified edits, commands and lookups; low thinking, no children |
| `architect` | `openai/gpt-6-luna` | Read-only design decisions and actionable plans; no shell or children |
| `writer` | `openai/gpt-6-luna` | Scoped prose drafting/editing; no shell or children |
| `gh-scout` | `openai/gpt-6-luna` | Read-only GitHub inspection with `gh` |
| `researcher` | `openai/gpt-6-luna` | Web research without local GitHub clones |
| `cc-worker` | `claude-opus-5-5` | Claude Code implementation |
| `cc-reviewer` | `claude-opus-5-5` | Read-only Claude Code review with triggering cases and refutation |

Set `githubClone.enabled` to `false` in the active `pi-web-access` `web-search.json` to disable local repository clones. For GitHub repository inspection, researchers ask the parent to delegate to `gh-scout`. That profile has only [`gh_readonly`](../gh-readonly/README.md), a standalone, shell-free, allowlisted GitHub CLI extension; it cannot clone repositories or use general shell/local-file tools. Install `gh` and authenticate outside the agent before accessing private repositories.

Use `tasker` for a small explicit job rather than a complex feature. `architect` returns a plan, not authorization to implement it. `writer` changes only authorized prose files and flags missing facts instead of inventing them. The new roles do not delegate; choose their use explicitly. Prompt adaptations and their upstream license are recorded in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

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

For a Claude Code profile, set `cli: claude`. Its `model` and optional `effort` fields are passed to Claude Code as `--model` and `--effort`; `thinking` applies to Pi profiles, not Claude Code. Claude Code documents effort values `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode` (availability depends on the model; `ultracode` requires Claude Code v2.1.203 or later). See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

Claude Code children can receive `subagent_message` steers and return results. The bundled plugin also exposes `mcp__plugin_pi-auto-exit_pi__ask_question`, a freeform child-to-parent question bridge. It uses per-run sidecars and keeps the child open until the parent replies. The launch explicitly allows only this MCP tool; other actions still use Claude's `auto` permission mode. The plugin requires `uv` on `PATH`. The footer shows Claude Code's `cost.total_cost_usd` estimate live: Claude refreshes its status line at session start and after assistant messages (debounced), and the footer polls sidecars about once per second. Live snapshots report cost only; token/cache totals come from final `cost-state` records because status-line `current_usage` is not cumulative. The estimate is written atomically; after exit, a valid final `cost-state` replaces it, while an absent or unusable final record leaves the latest live estimate intact. If Claude explicitly reports an unknown model cost, the footer preserves that unknown result rather than showing an older number. These are Claude Code list-price estimates, not provider-billed charges. `/clear` resets Claude's session cost, so this per-launch sidecar does not preserve spend from before a manual clear. Claude Code launches use `--permission-mode auto` rather than bypassing permission prompts; availability depends on Claude Code's account, model, and organization settings.

## Configuration

Copy `config.json.example` to `config.json` in this extension directory. It is gitignored. The supported options are:

```json
{
  "status": { "enabled": true, "mode": "minimal" },
  "limits": { "maxConcurrent": 4 },
  "proactiveCompaction": { "enabled": true, "thresholdPercent": 70 }
}
```

`limits.maxConcurrent` defaults to 4 and must be a positive integer. It caps one root parent's delegation tree, including startup, resumed children and nested launches. At capacity, launches fail clearly rather than queue; steering an existing child does not consume another slot. Unknown starts keep their slots until exit is confirmed, so a stale guard or unresolved run can require inspection. Existing children from before this change should be restarted to inherit the shared tree budget.

Status controls the agent-state display. `mode` is `minimal` (the default: one compact active-count line) or `full` (the per-agent widget); `enabled` still controls status detail/notifications. Proactive compaction applies to Pi children, not the parent or Claude CLI agents. If compaction fails or is interrupted, the child stays open; send a follow-up to continue from its checkpoint.

## Tests

Run these from the repository root in a normal shell, not a restricted child session:

```sh
npm test                 # Unit tests; no Herdr panes or model calls
npm run test:surface     # Herdr pane and command tests; live Herdr checks, no model calls
npm run test:integration # Pi/LLM lifecycle tests; live checks and may incur API costs
```

## License

MIT
