#!/usr/bin/env python3
"""Word-level transcription for the audio-edit-point workflow.

Runs faster-whisper on a media file and prints a JSON transcription with
word-level timestamps to stdout. Consumed by the Node MCP server
(src/utils/speechAnalysis.ts) to compute speech-based edit points.

Usage:
    python whisper_transcribe.py <audio_path> [--model base] [--language ko]

Output (stdout, JSON):
    {"success": true, "language": "ko", "duration": 123.4,
     "segments": [{"start": .., "end": .., "text": "..",
                   "words": [{"word": "..", "start": .., "end": ..}]}]}
"""

from __future__ import annotations

import argparse
import json
import platform
import sys


def transcribe(audio_path: str, model_name: str, language: str) -> dict:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {
            "success": False,
            "error": "faster_whisper is not installed. Run: pip install faster-whisper",
        }

    # Match the existing agent pipeline: int8 on Apple Silicon, else float16/CPU.
    device = "cpu"
    compute_type = "int8" if platform.machine() == "arm64" else "float16"
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception:
        compute_type = "int8"
        model = WhisperModel(model_name, device="cpu", compute_type=compute_type)

    kwargs = {"word_timestamps": True, "vad_filter": True}
    if language and language.lower() != "auto":
        kwargs["language"] = language

    segments_iter, info = model.transcribe(audio_path, **kwargs)

    segments = []
    for seg in segments_iter:
        entry = {
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": (seg.text or "").strip(),
        }
        if seg.words:
            entry["words"] = [
                {
                    "word": (w.word or "").strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "prob": round(getattr(w, "probability", 1.0) or 1.0, 3),
                }
                for w in seg.words
                if w.start is not None and w.end is not None
            ]
        segments.append(entry)

    return {
        "success": True,
        "language": info.language,
        "duration": round(info.duration, 3) if info.duration else 0,
        "segments": segments,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Word-level Whisper transcription")
    parser.add_argument("audio_path", help="Absolute path to the media file")
    parser.add_argument("--model", default="base", help="Whisper model size (tiny/base/small/medium/large-v3)")
    parser.add_argument("--language", default="ko", help="Language code, or 'auto' to detect")
    args = parser.parse_args()

    try:
        result = transcribe(args.audio_path, args.model, args.language)
    except Exception as e:  # noqa: BLE001
        result = {"success": False, "error": f"transcription failed: {e}"}

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
