"""Persist Claude's final response for the Pi subagent watcher."""

import json
import os
import sys
from pathlib import Path


def main() -> None:
    sentinel_path = os.environ.get("PI_CLAUDE_SENTINEL")
    if not sentinel_path:
        return

    try:
        payload = json.load(sys.stdin)
        if payload.get("stop_hook_active"):
            return

        transcript_path = payload.get("transcript_path")
        if not isinstance(transcript_path, str) or not Path(transcript_path).is_file():
            return

        sentinel = Path(sentinel_path)
        sentinel.with_name(sentinel.name + ".transcript").write_text(
            transcript_path + "\n", encoding="utf-8"
        )

        user_message_count = 0
        with open(transcript_path, encoding="utf-8") as transcript:
            for line in transcript:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = entry.get("message", {}).get("content")
                if entry.get("type") == "user" and isinstance(content, str):
                    user_message_count += 1

        pending_path = os.environ.get("PI_CLAUDE_PENDING_FILE") or sentinel_path + ".pending"
        if Path(pending_path).exists():
            return

        # Auto-exit agents complete after any assistant turn, including turns
        # after parent steering. Interactive agents only signal an autonomous
        # first turn.
        if os.environ.get("PI_CLAUDE_AUTO_EXIT") == "1" or user_message_count == 1:
            result = payload.get("last_assistant_message")
            if not isinstance(result, str):
                result = ""
            sentinel.write_text(result + "\n", encoding="utf-8")
    except Exception as error:
        # Stop hooks must never block Claude Code when input or filesystem state
        # is invalid, but report failures so the parent can diagnose a missing
        # completion signal.
        print(f"[interactive-subagents] Stop hook failed: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
