"""Clear the pending question marker when the parent replies."""

import os
import sys
from pathlib import Path

pending_path = os.environ.get("PI_CLAUDE_PENDING_FILE")
if pending_path:
    try:
        Path(pending_path).unlink(missing_ok=True)
    except OSError as error:
        print(f"[interactive-subagents] Could not clear pending question: {error}", file=sys.stderr)
