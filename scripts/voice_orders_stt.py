#!/usr/bin/env python3
"""Resident Whisper worker for voice orders.

Loads the model once, then serves JSON-line requests on stdin:
    {"id": "1", "wav": "/path/rec.wav", "prompt": "AKS.7, 쿠엔"}
and answers one JSON line per request on stdout:
    {"id": "1", "ok": true, "text": "..."}   or   {"id": "1", "ok": false, "text": "", "error": "..."}
Prints {"ready": true} once the model is loaded.

Env: VOICE_ORDERS_STT_MODEL (default "small").
"""

from __future__ import annotations

import json
import os
import platform
import sys


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model(name: str):
    from faster_whisper import WhisperModel

    # Same device/compute choice as whisper_transcribe.py.
    compute_type = "int8" if platform.machine() == "arm64" else "float16"
    try:
        return WhisperModel(name, device="cpu", compute_type=compute_type)
    except Exception:
        return WhisperModel(name, device="cpu", compute_type="int8")


def load_audio(path: str):
    """Our recordings are 16 kHz mono PCM16 WAV: read them with the stdlib so
    decoding does not depend on PyAV (version mismatches break av.open). Any
    other file is passed through as a path."""
    import wave

    try:
        import numpy as np

        with wave.open(path, "rb") as w:
            if w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                pcm = w.readframes(w.getnframes())
                return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    except (wave.Error, EOFError, ImportError):
        pass
    return path


def main() -> int:
    try:
        model = load_model(os.environ.get("VOICE_ORDERS_STT_MODEL", "small"))
    except ImportError:
        sys.stderr.write("faster_whisper is not installed. Run: pip install faster-whisper\n")
        return 2
    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            segments, _info = model.transcribe(
                load_audio(req["wav"]),
                language="ko",
                vad_filter=True,
                initial_prompt=req.get("prompt") or None,
            )
            text = " ".join((s.text or "").strip() for s in segments).strip()
            emit({"id": req_id, "ok": True, "text": text})
        except Exception as e:  # keep serving after a bad request
            emit({"id": req_id, "ok": False, "text": "", "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
