# gh_readonly

A standalone Pi extension for read-only GitHub inspection through the GitHub CLI. It runs `gh` with a validated argument array, without a shell or local repository clone.

Load it directly with `pi --extension ./extensions/gh-readonly`, or use it through this repository's Pi package. Tailor enabled extensions with `pi config` or [package filtering](../../README.md#using). The bundled `gh-scout` profile uses this same extension; it is not tied to subagents.

## Requirements

Install `gh` on `PATH`. Authenticate outside the agent when required. The tool does not install dependencies, log in, or change credentials or CLI configuration.

## Usage

Pass arguments without the leading `gh` executable:

```js
gh_readonly({ args: ["repo", "view", "OWNER/REPO", "--json", "nameWithOwner,url,defaultBranchRef"] })
gh_readonly({ args: ["pr", "view", "123", "--repo", "OWNER/REPO", "--json", "title,body,state,url"] })
gh_readonly({ args: ["api", "--method", "GET", "repos/OWNER/REPO/git/trees/SHA?recursive=1"] })
```

The tool allows selected repository, PR, issue, release, CI metadata, and search commands. `repo view` requires a positional `OWNER/REPO` (not `--repo`); PR, issue, release, and run commands require `--repo OWNER/REPO`. `repo list --source` is a boolean flag and takes no value. REST requests require an explicit `--method GET` and an explicit relative `repos/OWNER/REPO/...` endpoint. Command and flag allowlists reject everything else.

Result details include `status`, `exitCode` (null when unavailable), `truncated`, and `durationMs`. Execution failures are marked as tool errors, with separate statuses for cancellation, timeout, missing executable, authentication, capture overflow, and other command failures. Nonzero exit output is retained within the same display limits; for example, failed PR checks may still contain useful results. No startup probes or automatic retries run.

## Boundaries

- No write commands, clones, checkouts, artifact downloads, log-cache downloads, login/config changes, browser opening, aliases/extensions, shell pipelines, or file input/output flags.
- No GraphQL, custom headers, arbitrary API hosts, or request bodies. API paths and query strings accept a deliberately limited character set; encoded paths and refs containing slashes are not supported.
- Displayed command output is capped at 32 KiB or 500 lines, plus a truncation notice. Capture stops at 256 KiB. Commands have a 30-second timeout, followed by at most two seconds of termination grace. Cancellation requests termination immediately; already-cancelled calls do not launch `gh`. If process exit cannot be confirmed, the tool reports that instead of waiting indefinitely. This is not a process-tree sandbox.
- List-command `--limit` values are capped at 100; REST requests should use explicit bounded `page`/`per_page` parameters rather than automatic pagination. Overflow messages suggest narrowing with `--json`, `--jq`, or smaller pages. Nothing is cached.
- Repository content is untrusted data, not instructions. Common token formats are redacted, but this is not a general secret scanner or an operating-system sandbox. It relies on the installed `gh` binary, existing credentials, and trusted host configuration.

This extension does not configure `pi-web-access`. Disable that package's local cloning separately with `"githubClone": { "enabled": false }` in its active `web-search.json`.
