#!/usr/bin/env python3
"""Download the UCLASS release 1 challenge-set files and write the vox#26 manifest.

UCLASS (University College London's Archive of Stuttered Speech) is public for research use
(https://www.uclass.psychol.ucl.ac.uk/). Keep the corpus outside the repository and never
commit or redistribute its audio or transcripts; only the manifest (paths and SHA-256 hashes)
and aggregate results are committed.

    python3 -I scripts/uclass-download.py --dir ~/.cache/uclass \
        --manifest docs/benchmarks/asr-challenge-set.json

Downloads, into `--dir/r1/`:
- every orthographic transcript (`Transcript/Flat/Ortho/*.orth`, disfluencies in upper case),
- every time-aligned word grid (`Transcript/TAligned/TextGrid/*.word.grid`),
- the WAV audio of those recordings (`Audio/wav/<id>.wav`),
then converts each WAV to 16 kHz mono with ffmpeg into `--dir/audio16k/<id>.wav`.

The script is resumable (files already present are kept) and makes one request at a time with a
pause between them, because the server blocks bursts. Standard library plus `curl` and `ffmpeg`.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time
import wave

BASE = "https://www.uclass.psychol.ucl.ac.uk"
PAUSE_SECONDS = 2.0
NOISE_SNR_DB = 10.0
NOISE_SEED = 26


def fetch(url, target):
    if target.exists() and target.stat().st_size > 0:
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    result = subprocess.run(
        ["curl", "-sSfL", "--retry", "3", "--retry-delay", "10", "-o", str(partial), url],
        check=False,
    )
    time.sleep(PAUSE_SECONDS)
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        return False
    partial.rename(target)
    return True


def listing(path, suffix):
    # The pages are Latin-1.
    page = subprocess.run(
        ["curl", "-sSfL", f"{BASE}/{path}/"], check=True, capture_output=True
    ).stdout.decode("latin-1")
    time.sleep(PAUSE_SECONDS)
    names = re.findall(r'href="([^"?/:]+)"', page)
    return sorted({name for name in names if name.endswith(suffix)})


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recording_id(name):
    return name.split(".", 1)[0]


def convert(source, target):
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1",
             "-fflags", "+bitexact", str(target)],
            check=True,
        )
    with wave.open(str(target)) as handle:
        return handle.getnframes() / handle.getframerate()


def item(root, rid, reference, reference_format):
    original = root / "r1" / "Audio" / "wav" / f"{rid}.wav"
    audio = root / "audio16k" / f"{rid}.wav"
    duration = convert(original, audio)
    return {
        "id": rid,
        "source": "uclass-r1",
        "audio": str(audio.relative_to(root)),
        "audioSha256": sha256(audio),
        "originalAudioSha256": sha256(original),
        "durationSeconds": round(duration, 3),
        "reference": str(reference.relative_to(root)),
        "referenceSha256": sha256(reference),
        "referenceFormat": reference_format,
        "language": "en",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=pathlib.Path, required=True)
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    args = parser.parse_args()
    root = args.dir.expanduser().resolve()

    ortho_dir = root / "r1" / "Transcript" / "Flat" / "Ortho"
    grid_dir = root / "r1" / "Transcript" / "TAligned" / "TextGrid"
    wav_dir = root / "r1" / "Audio" / "wav"
    orthos = listing("Transcript/Flat/Ortho", ".orth")
    grids = listing("Transcript/TAligned/TextGrid", ".word.grid")
    wavs = set(listing("Audio/wav", ".wav"))
    # Some listed transcripts are not served (404); they are left out.
    orthos = [
        name for name in orthos if fetch(f"{BASE}/Transcript/Flat/Ortho/{name}", ortho_dir / name)
    ]
    grids = [
        name
        for name in grids
        if fetch(f"{BASE}/Transcript/TAligned/TextGrid/{name}", grid_dir / name)
    ]

    missing = []
    available = set()
    for rid in sorted({recording_id(name) for name in orthos + grids}):
        if f"{rid}.wav" not in wavs or not fetch(f"{BASE}/Audio/wav/{rid}.wav", wav_dir / f"{rid}.wav"):
            missing.append(rid)
        else:
            available.add(rid)

    repetitions = [
        item(root, recording_id(name), ortho_dir / name, "verbatimText")
        for name in orthos
        if recording_id(name) in available
    ]
    pauses = [
        item(root, recording_id(name), grid_dir / name, "uclassWordGrid")
        for name in grids
        if recording_id(name) in available
    ]
    ffmpeg = subprocess.run(
        ["ffmpeg", "-version"], check=True, capture_output=True, text=True
    ).stdout.splitlines()[0]
    manifest = {
        "schemaVersion": 1,
        "name": "vox-asr-challenge-set",
        "preprocessing": f"UCLASS WAV converted to 16 kHz mono 16-bit PCM ({ffmpeg})",
        "sources": [
            {
                "id": "uclass-r1",
                "description": "UCLASS release 1: monologues of speakers who stutter, orthographic transcripts with disfluencies in upper case, and time-aligned word grids",
                "url": BASE,
                "terms": "Public for research use; audio and transcripts stay outside the repository",
            }
        ],
        "subsets": [
            {
                "id": "uclass-r1-repetitions",
                "kind": "repetitionsPartialWords",
                "description": "UCLASS release 1 recordings with an orthographic verbatim transcript: word repetitions, part words, prolongations, coded disfluent words and fillers",
                "items": repetitions,
            },
            {
                "id": "uclass-r1-noise",
                "kind": "noise",
                "description": f"Every third recording of the repetitions subset with seeded white noise at {NOISE_SNR_DB:g} dB SNR added before transcription (synthetic degradation of real speech)",
                "noise": {"snrDb": NOISE_SNR_DB, "seed": NOISE_SEED},
                # Every third recording keeps the noisy pass affordable on a CPU.
                "items": repetitions[::3],
            },
            {
                "id": "uclass-r1-long-pauses",
                "kind": "longPauses",
                "description": "UCLASS release 1 recordings with a time-aligned word grid: words hallucinated in annotated silences of at least 1 s, and segment-boundary error",
                "items": pauses,
            },
            {
                "id": "quiet-speech",
                "kind": "quietSpeech",
                "description": "Quiet speech",
                "gap": "UCLASS has no quiet-speech recordings with references; reported gap (owner answer Q1 B)",
            },
            {
                "id": "code-switching",
                "kind": "codeSwitching",
                "description": "Code-switching",
                "gap": "UCLASS is English only; reported gap (owner answer Q1 B)",
            },
            {
                "id": "speaker-changes",
                "kind": "speakerChanges",
                "description": "Speaker changes",
                "gap": "UCLASS recordings are monologues without speaker-change annotation; reported gap (owner answer Q1 B)",
            },
        ],
    }
    if missing:
        manifest["missingRecordings"] = missing
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"{len(repetitions)} transcribed and {len(pauses)} time-aligned recordings; "
        f"{len(missing)} without audio",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
