#!/usr/bin/env python3
"""Download SEP-28k audio and cut its clips, outside the repository.

Equivalent to the dataset's own `download_audio.py` + `extract_clips.py`
(apple/ml-stuttering-events-dataset), which no longer run on current numpy
(multi-character `loadtxt` delimiter). Standard library plus `curl` and
`ffmpeg` only.

Use is limited to personal, non-commercial evaluation of this project's
detector (see the SEP-28k dataset card in
apps/desktop/src-tauri/STUTTER_BENCH.md). Never commit or redistribute the
audio or the clips.

    python3 -I scripts/sep28k-download.py --dir ~/.cache/sep28k

`--dir` must contain SEP-28k_episodes.csv and SEP-28k_labels.csv from the
dataset repository. Clips are written to `<dir>/clips/<Show>/<EpId>/
<Show>_<EpId>_<ClipId>.wav` (the layout `stutter-eval --clips` expects).
Episodes whose URL no longer resolves are listed in `<dir>/missing-episodes.txt`.
The script is resumable: finished episodes are skipped.

With `--speakers`, SEP-28k-E's `SEP-28k-Extended_clips.csv` (th-nuernberg/
ml-stuttering-events-dataset-extended, CC BY-NC 4.0) in `--dir` is turned into
the runner's inputs: `<dir>/speakers.csv` (`clipId,speakerId`; commas and quotes
in names are replaced because the runner reads unquoted CSV) and
`<dir>/labels-with-speaker.csv`, the SEP-28k label rows that SEP-28k-E assigns a
speaker (the runner only partitions when every scored clip has one). SEP-28k-E
speakers come from clustering, not manual verification.
"""

import argparse
import concurrent.futures
import csv
import os
import pathlib
import subprocess
import sys
import wave

SAMPLE_RATE = 16000


def read_episodes(path):
    episodes = []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle, skipinitialspace=True):
            if not row:
                continue
            # name, episode slug, url, show abbreviation, episode index
            url, show, ep_id = row[2].strip(), row[-2].strip(), row[-1].strip()
            episodes.append((show, ep_id, url))
    return episodes


def read_clips(path):
    clips = {}
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle, skipinitialspace=True):
            key = (row["Show"].strip(), row["EpId"].strip())
            clips.setdefault(key, []).append(
                (row["ClipId"].strip(), int(row["Start"]), int(row["Stop"]))
            )
    return clips


def process_episode(root, show, ep_id, url, clips, keep_wavs):
    clip_dir = root / "clips" / show / ep_id
    done_marker = clip_dir / ".complete"
    if done_marker.exists():
        return show, ep_id, "skipped"
    work = root / "wavs" / show
    work.mkdir(parents=True, exist_ok=True)
    raw = work / f"{ep_id}.download"
    wav = work / f"{ep_id}.wav"
    if not wav.exists():
        result = subprocess.run(
            ["curl", "-sfL", "--retry", "2", "--max-time", "1800", "-o", str(raw), url],
            check=False,
        )
        if result.returncode != 0 or not raw.exists() or raw.stat().st_size < 10_000:
            raw.unlink(missing_ok=True)
            return show, ep_id, f"download failed (curl {result.returncode})"
        result = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw),
             "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(wav)],
            check=False,
        )
        raw.unlink(missing_ok=True)
        if result.returncode != 0:
            wav.unlink(missing_ok=True)
            return show, ep_id, "decode failed"
    clip_dir.mkdir(parents=True, exist_ok=True)
    with wave.open(str(wav), "rb") as source:
        if source.getframerate() != SAMPLE_RATE or source.getnchannels() != 1:
            return show, ep_id, "unexpected wav format"
        total = source.getnframes()
        for clip_id, start, stop in clips:
            if start >= total:
                continue
            source.setpos(start)
            frames = source.readframes(min(stop, total) - start)
            with wave.open(str(clip_dir / f"{show}_{ep_id}_{clip_id}.wav"), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(source.getsampwidth())
                out.setframerate(SAMPLE_RATE)
                out.writeframes(frames)
    done_marker.touch()
    if not keep_wavs:
        wav.unlink(missing_ok=True)
    return show, ep_id, "ok"


def write_speaker_inputs(root):
    speakers = {}
    with open(root / "SEP-28k-Extended_clips.csv", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            speaker = row["speaker"].strip().replace(",", ";").replace('"', "")
            if speaker:
                key = f'{row["Show"].strip()}:{row["EpId"].strip()}:{row["ClipId"].strip()}'
                speakers[key] = speaker
    with open(root / "speakers.csv", "w", newline="", encoding="utf-8") as out:
        out.write("clipId,speakerId\n")
        for key in sorted(speakers):
            out.write(f"{key},{speakers[key]}\n")
    kept = dropped = 0
    with open(root / "SEP-28k_labels.csv", encoding="utf-8") as source, open(
        root / "labels-with-speaker.csv", "w", encoding="utf-8"
    ) as out:
        out.write(source.readline())
        for line in source:
            show, ep_id, clip_id = (field.strip() for field in line.split(",")[:3])
            if f"{show}:{ep_id}:{clip_id}" in speakers:
                out.write(line)
                kept += 1
            else:
                dropped += 1
    print(f"{len(speakers)} clips mapped to {len(set(speakers.values()))} speakers; "
          f"{kept} label rows kept, {dropped} without a speaker dropped", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", required=True, type=pathlib.Path)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--keep-wavs", action="store_true",
                        help="keep the full 16 kHz episode WAVs after cutting clips")
    parser.add_argument("--speakers", action="store_true",
                        help="only write the SEP-28k-E speaker mapping and filtered labels")
    args = parser.parse_args()
    root = args.dir.expanduser().resolve()
    if args.speakers:
        write_speaker_inputs(root)
        return
    episodes = read_episodes(root / "SEP-28k_episodes.csv")
    clips = read_clips(root / "SEP-28k_labels.csv")
    missing = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [
            pool.submit(process_episode, root, show, ep_id, url,
                        clips.get((show, ep_id), []), args.keep_wavs)
            for show, ep_id, url in episodes
            if clips.get((show, ep_id))
        ]
        for future in concurrent.futures.as_completed(futures):
            show, ep_id, status = future.result()
            print(f"{show} {ep_id}: {status}", flush=True)
            if status not in ("ok", "skipped"):
                missing.append(f"{show}\t{ep_id}\t{status}")
    (root / "missing-episodes.txt").write_text("\n".join(sorted(missing)) + "\n")
    print(f"{len(futures) - len(missing)} of {len(futures)} episodes available", file=sys.stderr)


if __name__ == "__main__":
    main()
