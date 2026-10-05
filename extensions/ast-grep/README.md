# ast_grep

An original local extension for read-only structural code search in Pi. The `ast_grep` tool takes a structural `pattern` and ast-grep `language`. Optional `path` defaults to the current working directory; `limit` defaults to 20 and accepts 1–50 matches.

The pinned CLI dependency is declared in the repository's [root `package.json`](../../package.json). Load the extension directly with `pi --extension ./extensions/ast-grep`, or use it through this repository's Pi package; tailor enabled extensions with `pi config` or [package filtering](../../README.md#using). The extension resolves the platform-specific binary from its local dependency and runs it without a shell. Searches use ast-grep's hidden-file and ignore-file defaults.
