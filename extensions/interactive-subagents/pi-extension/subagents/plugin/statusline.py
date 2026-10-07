# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///

"""Publish Claude Code's cumulative status-line cost for the Pi footer."""

import json
import math
import os
import sys
import tempfile
from pathlib import Path


VERSION = 1
SOURCE = "claude-code-statusline"


def main() -> None:
    usage_file = os.environ.get("PI_CLAUDE_USAGE_FILE")
    if not usage_file:
        return

    temporary = None
    try:
        payload = json.load(sys.stdin)
        session_id = payload.get("session_id")
        cost_data = payload.get("cost")
        cost = cost_data.get("total_cost_usd") if isinstance(cost_data, dict) else None
        if (
            not isinstance(session_id, str)
            or not session_id
            or isinstance(cost, bool)
            or not isinstance(cost, (int, float))
            or not math.isfinite(cost)
            or cost < 0
        ):
            return

        destination = Path(usage_file)
        destination.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "version": VERSION,
            "source": SOURCE,
            "estimated": True,
            "cost": cost,
            "costAvailable": True,
            "inputTokens": None,
            "outputTokens": None,
            "cacheReadTokens": None,
            "cacheWriteTokens": None,
            "sessionId": session_id,
        }
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=destination.name + ".tmp-",
            delete=False,
        ) as output:
            temporary = output.name
            json.dump(record, output, separators=(",", ":"))
            output.write("\n")
        os.replace(temporary, destination)
        temporary = None
    except Exception:
        # Status-line commands must not interfere with the interactive child.
        pass
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


if __name__ == "__main__":
    main()
