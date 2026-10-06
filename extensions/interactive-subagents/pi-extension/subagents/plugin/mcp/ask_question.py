"""Minimal stdio MCP server that sends a question to the Pi parent."""

import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

SUPPORTED_PROTOCOLS = {
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
}
MAX_QUESTION_LENGTH = 4_000

TOOL = {
    "name": "ask_question",
    "description": (
        "Ask the Pi orchestrator one decision needed to continue. The question is delivered "
        "to the parent; stop and wait for its reply as your next user message."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_QUESTION_LENGTH,
                "description": "The single decision or clarification needed from the Pi parent.",
            }
        },
        "required": ["question"],
        "additionalProperties": False,
    },
}


def write_question(question: str) -> str:
    ask_path = Path(os.environ.get("PI_CLAUDE_ASK_FILE", ""))
    pending_path = Path(os.environ.get("PI_CLAUDE_PENDING_FILE", ""))
    if not ask_path.is_absolute() or not pending_path.is_absolute():
        raise ValueError("Pi question sidecar paths were not provided by the parent")
    if pending_path.parent != ask_path.parent:
        raise ValueError("Pi question sidecars must share a directory")
    if not question.strip():
        raise ValueError("question must not be blank")
    if len(question) > MAX_QUESTION_LENGTH:
        raise ValueError(f"question exceeds {MAX_QUESTION_LENGTH} characters")
    if ask_path.exists():
        raise ValueError("a question is already waiting for the Pi parent")

    question_id = str(uuid.uuid4())
    try:
        # Create the pending marker first so the Stop hook cannot close the
        # worker between the question and its atomic sidecar rename.
        fd = os.open(pending_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as pending:
            pending.write(question_id + "\n")

        temp_path = ask_path.with_name(f"{ask_path.name}.tmp-{os.getpid()}-{question_id}")
        payload = {"id": question_id, "question": question.strip()}
        temp_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temp_path, ask_path)
    except FileExistsError as error:
        raise ValueError("a question is already waiting for the Pi parent") from error
    except Exception:
        try:
            pending_path.unlink()
        except OSError:
            pass
        try:
            temp_path.unlink()
        except (NameError, OSError):
            pass
        raise

    return question_id


def response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def tool_result(text: str, is_error: bool = False) -> dict[str, Any]:
    result = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params")

    if method == "notifications/initialized":
        return None
    if method == "ping":
        return response(request_id, {})
    if method == "initialize":
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        if requested not in SUPPORTED_PROTOCOLS:
            return rpc_error(request_id, -32602, "Unsupported MCP protocol version")
        return response(
            request_id,
            {
                "protocolVersion": requested,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "pi-ask-question", "version": "1.0.0"},
            },
        )
    if method == "tools/list":
        return response(request_id, {"tools": [TOOL]})
    if method == "tools/call":
        if not isinstance(params, dict) or params.get("name") != "ask_question":
            return response(request_id, tool_result("Unknown tool", is_error=True))
        arguments = params.get("arguments")
        question = arguments.get("question") if isinstance(arguments, dict) else None
        if not isinstance(question, str):
            return response(request_id, tool_result("question must be a string", is_error=True))
        try:
            write_question(question)
        except (OSError, ValueError) as error:
            return response(request_id, tool_result(str(error), is_error=True))
        return response(
            request_id,
            tool_result("Question sent to the Pi orchestrator. Stop and wait for its reply as your next user message."),
        )
    if request_id is None:
        return None
    return rpc_error(request_id, -32601, f"Method not found: {method}")


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                if isinstance(request, dict) and "id" in request:
                    print(json.dumps(rpc_error(request.get("id"), -32600, "Invalid JSON-RPC request")), flush=True)
                continue
            result = handle(request)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
        except json.JSONDecodeError:
            print(json.dumps(rpc_error(None, -32700, "Parse error")), flush=True)
        except Exception as error:
            print(f"[pi-ask-question] {error}", file=sys.stderr, flush=True)
            request_id = request.get("id") if isinstance(request, dict) else None
            if request_id is not None:
                print(json.dumps(rpc_error(request_id, -32603, "Internal error")), flush=True)


if __name__ == "__main__":
    main()
