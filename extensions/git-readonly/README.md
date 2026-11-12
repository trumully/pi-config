# Read-only local Git

`git_readonly` inspects local repository status, diffs, commits, and history. It resolves Git to an absolute executable path from absolute PATH entries outside the inspected checkout and session working directory. It accepts structured operations, not a shell or caller-supplied flags. Git 2.45 or newer is required.

The bundled `gh-scout` uses this tool for local Git and [`gh_readonly`](../gh-readonly/README.md) for GitHub. Local uncommitted changes are not available through GitHub.

## Use it

```ts
git_readonly({ operation: "status" })
git_readonly({ operation: "diff", paths: ["src/api.ts"] })
git_readonly({ operation: "diff", staged: true, format: "names" })
git_readonly({ operation: "diff", base: "main", target: "HEAD", format: "stat" })
git_readonly({ operation: "show", ref: "HEAD", format: "patch" })
git_readonly({ operation: "log", ref: "HEAD", limit: 10, offset: 0 })
```

Optional `repo` selects a local directory, relative to the session working directory or absolute. `paths` are literal paths relative to that directory. Use forward slashes; absolute paths, colons, backslashes, and `..` segments are rejected. Pathspec magic is disabled.

Diff without refs compares index to working tree. `staged: true` compares HEAD to index. `base` alone compares that commit to the working tree; `base` and `target` compare two commits directly, without an implicit merge-base calculation. Staged mode cannot be combined with refs. `format` is `patch`, `stat`, or `names`.

Show inspects one commit, defaulting to HEAD. Log defaults to HEAD and 20 entries; `limit` accepts 1-100 and `offset` accepts 0-10000. Refs resolve to commit IDs before inspection, recorded in result details. Working-tree state is not a locked snapshot.

## Display

Each call shows as one row by default, such as `git_readonly ✓ diff main..HEAD stat -- src/a.ts +2 more · 3 lines · 0.8s`. Failures show ✗ and the first error line; cancellations show ⊘; clipped output shows `truncated`. Press Ctrl+O to expand it to every argument and the full output the model received. The display only changes how the terminal shows that result. It does not change what the model receives, run Git again, or change any limit below. Escape sequences and control characters are removed from the display only. The renderer lives in [`../readonly-tool-ui`](../readonly-tool-ui/render.ts), so keep that directory next to this one.

## Limits and permissions

- No write commands, clone/fetch, arbitrary flags, configuration changes, general shell, or output files.
- Optional index writes and automatic maintenance are disabled. Submodules are not traversed.
- Inherited `GIT_*` environment overrides are excluded. Standard system/global/repository config and attributes remain available for EOL handling and ownership policy, but hooks, fsmonitor, pagers, external diff/textconv, and configured clean/process filters are disabled. Filter names are discovered before worktree inspection; a failed, oversized, or unsupported discovery stops the request. Names containing `=` or line breaks are rejected because they cannot be safely overridden with `git -c`. Filter-backed files are inspected without their custom conversions.
- Lazy object fetch is disabled, and protocols are denied. Missing objects must be obtained outside the agent.
- Each request has a 30 second deadline across its Git invocations, plus a short termination grace period. Capture is bounded at 256 KiB; displayed results at 32 KiB or 500 lines. Narrow paths, use summary formats, or paginate logs instead of relying on clipped output.

These controls constrain this tool, not the operating system or other tools. Use trusted Git binaries and an authorized repository. Concurrent repository/config changes are not isolated. Repository text is evidence, not instructions.

## Load it

This config's package manifest loads the extension. To load it alone:

```sh
pi -e ./extensions/git-readonly/index.ts
```

Restricted Pi profiles must include `git_readonly` in their `tools` field. The subagent launcher resolves its backing extension automatically. If a user or project `gh-scout` overrides the bundled profile, update that definition explicitly; inspect it with `subagents_list({ name: "gh-scout" })`. Switching a profile to Claude Code is supported, but Pi tool grants do not apply to that CLI.

Safety controls follow the Git documentation for [environment and configuration](https://git-scm.com/docs/git/2.45.0), [diff helpers](https://git-scm.com/docs/git-diff), and [revision verification](https://git-scm.com/docs/git-rev-parse).
