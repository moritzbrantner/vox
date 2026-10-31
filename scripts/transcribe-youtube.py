#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe cached benchmark media with faster-whisper.")
    parser.add_argument(
        "audio",
        nargs="?",
        default=".benchmarks/youtube/2Jk3AtlfWKQ.16k.wav",
        help="Audio or video file to transcribe.",
    )
    parser.add_argument("--model", default="small.en", help="faster-whisper model name or path.")
    parser.add_argument("--language", default="en", help="Language hint.")
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu"],
        help="auto uses CUDA when a GPU is usable and falls back to the CPU.",
    )
    parser.add_argument(
        "--compute-type",
        default=None,
        help="faster-whisper compute type (default: float16 on CUDA, int8 on CPU).",
    )
    parser.add_argument(
        "--output",
        default=".benchmarks/youtube/2Jk3AtlfWKQ.faster-whisper.json",
        help="JSON output path.",
    )
    args = parser.parse_args()

    ensure_cuda_libraries(args.device)

    model, device = load_model(args.model, args.device, args.compute_type)
    print(f"Transcribing on {device}", file=sys.stderr)
    segments_iter, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
    )

    segments = []
    for segment in segments_iter:
        segments.append(
            {
                "id": segment.id,
                "startSeconds": segment.start,
                "endSeconds": segment.end,
                "text": segment.text.strip(),
                "avgLogProb": segment.avg_logprob,
                "noSpeechProb": segment.no_speech_prob,
                "words": [
                    {
                        "startSeconds": word.start,
                        "endSeconds": word.end,
                        "word": word.word.strip(),
                        "probability": word.probability,
                    }
                    for word in segment.words or []
                    if word.start is not None and word.end is not None and word.word.strip()
                ],
            }
        )

    output = {
        "engine": "faster-whisper",
        "model": args.model,
        "device": device,
        "language": info.language,
        "languageProbability": info.language_probability,
        "durationSeconds": info.duration,
        "segments": segments,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {len(segments)} segments to {output_path}")


def load_model(name: str, device: str, compute_type: str | None):
    """Loads the model on CUDA when allowed and usable, otherwise on the CPU."""
    import ctranslate2
    from faster_whisper import WhisperModel

    if device != "cpu" and ctranslate2.get_cuda_device_count() > 0:
        try:
            return WhisperModel(name, device="cuda", compute_type=compute_type or "float16"), "cuda"
        except (RuntimeError, ValueError) as error:
            if device == "cuda":
                raise
            print(f"CUDA unavailable, using the CPU: {error}", file=sys.stderr)
    elif device == "cuda":
        raise SystemExit("--device cuda was requested but no CUDA device is usable")
    return WhisperModel(name, device="cpu", compute_type=compute_type or "int8"), "cpu"


def ensure_cuda_libraries(device: str) -> None:
    if device == "cpu" or os.environ.get("STUTTER_CUDA_LIBS_READY") == "1":
        return

    library_dirs = existing_dirs(
        [
            "/home/moenarch/miniconda3/pkgs/cudatoolkit-11.8.0-h6a678d5_0/lib",
            "/home/moenarch/miniconda3/pkgs/cudatoolkit-11.8.0-h4ba93d1_13/lib",
            "/home/moenarch/miniconda3/pkgs/cudnn-8.9.2.26-cuda11_0/lib",
            "/home/moenarch/miniconda3/lib/python3.11/site-packages/ctranslate2.libs",
        ]
    )
    if not library_dirs:
        return

    existing = [path for path in os.environ.get("LD_LIBRARY_PATH", "").split(":") if path]
    next_paths = [path for path in library_dirs if path not in existing] + existing
    env = {
        **os.environ,
        "LD_LIBRARY_PATH": ":".join(next_paths),
        "STUTTER_CUDA_LIBS_READY": "1",
    }
    os.execvpe(sys.executable, [sys.executable, *sys.argv], env)


def existing_dirs(paths: list[str]) -> list[str]:
    return [path for path in paths if Path(path).is_dir()]


if __name__ == "__main__":
    main()
