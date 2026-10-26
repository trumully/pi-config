#!/usr/bin/env python3
"""Capture microphone audio and stream it through Cactus Whistle.

The extension and helper communicate with newline-delimited JSON on stdin/stdout.
Stdout is reserved for protocol messages; diagnostics go to stderr.
"""

from __future__ import annotations

import json
import queue
import sys
import threading
from typing import Any


SAMPLE_RATE = 16_000
CHUNK_SAMPLES = SAMPLE_RATE

_output_lock = threading.Lock()


def emit(message: dict[str, Any]) -> None:
    with _output_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def main() -> int:
    try:
        import numpy as np
        import soxr
        import sounddevice as sd
        import needle
    except Exception as error:
        emit({"type": "error", "message": f"Cannot load Whistle's Python dependencies: {error}"})
        return 1

    try:
        input_rate = int(sd.query_devices(kind="input")["default_samplerate"])
        resampler = (
            soxr.ResampleStream(input_rate, SAMPLE_RATE, 1, dtype="float32", quality="HQ")
            if input_rate != SAMPLE_RATE
            else None
        )
    except Exception as error:
        emit({"type": "error", "message": f"Cannot open the default microphone: {error}"})
        return 1

    stop_requested = threading.Event()
    callback_lock = threading.Lock()
    audio_queue: queue.Queue[Any] = queue.Queue()
    level_lock = threading.Lock()
    latest_rms = 0.0

    def request_stop() -> None:
        with callback_lock:
            if stop_requested.is_set():
                return
            stop_requested.set()
            if resampler is not None:
                tail = resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True)
                if tail.size:
                    audio_queue.put(np.ascontiguousarray(tail, dtype=np.float32))
            audio_queue.put(None)

    def read_commands() -> None:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("type") == "stop":
                request_stop()
                return
        request_stop()

    command_thread = threading.Thread(target=read_commands, name="whistle-commands", daemon=True)
    command_thread.start()

    emit({"type": "loading"})
    try:
        # Load before opening the mic, so first-run model setup doesn't lose speech.
        whistle = needle.Whistle()
    except Exception as error:
        emit({"type": "error", "message": f"Could not load the Whistle model: {error}"})
        return 1

    if stop_requested.is_set():
        emit({"type": "done"})
        return 0

    def audio_callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
        nonlocal latest_rms
        mic_samples = indata[:, 0].copy()
        with callback_lock:
            if stop_requested.is_set():
                return
            samples = resampler.resample_chunk(mic_samples) if resampler is not None else mic_samples
            if samples.size:
                audio_queue.put(np.ascontiguousarray(samples, dtype=np.float32))
        with level_lock:
            latest_rms = float(np.sqrt(np.mean(mic_samples * mic_samples))) if frames else 0.0

    def audio_chunks():
        pending = np.empty(0, dtype=np.float32)
        while True:
            samples = audio_queue.get()
            if samples is None:
                break
            if pending.size:
                samples = np.concatenate((pending, samples))
            while samples.size >= CHUNK_SAMPLES:
                yield np.ascontiguousarray(samples[:CHUNK_SAMPLES], dtype=np.float32)
                samples = samples[CHUNK_SAMPLES:]
            pending = samples

        if pending.size:
            yield np.ascontiguousarray(pending, dtype=np.float32)

    meter_stop = threading.Event()

    def emit_meter() -> None:
        while not meter_stop.wait(0.08):
            with level_lock:
                rms = latest_rms
            emit({"type": "level", "rms": rms})

    meter_thread = threading.Thread(target=emit_meter, name="whistle-meter", daemon=True)
    try:
        with sd.InputStream(
            samplerate=input_rate,
            channels=1,
            dtype="float32",
            blocksize=0,
            callback=audio_callback,
        ):
            emit({"type": "ready"})
            meter_thread.start()
            for result in whistle.stream(audio_chunks()):
                emit(
                    {
                        "type": "transcript",
                        "text": result.get("text", ""),
                        "pending": result.get("pending", ""),
                    }
                )
        emit({"type": "done"})
        return 0
    except Exception as error:
        emit({"type": "error", "message": f"Whistle dictation failed: {error}"})
        return 1
    finally:
        request_stop()
        meter_stop.set()
        if meter_thread.is_alive():
            meter_thread.join(timeout=0.5)


if __name__ == "__main__":
    raise SystemExit(main())
