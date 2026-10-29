//! Runs and scores the held-out ASR challenge set (vox#26) on locally held audio.
//!
//! bun run benchmark:asr transcribe --manifest docs/benchmarks/asr-challenge-set.json \
//!   --root ~/.cache/uclass --model base.en --chunk-seconds 8 --out base.en.json
//! bun run benchmark:asr score --manifest docs/benchmarks/asr-challenge-set.json \
//!   --root ~/.cache/uclass --baseline base.en.json --candidate large-v3-turbo.json --out report.json
//!
//! Transcription goes through the product's whisper.cpp path (`transcribe_audio_impl`), one call
//! per chunk exactly as recording (8 s) and the post-session reference transcript (30 s) do.
//! Hypotheses and reports contain corpus text: keep them next to the corpus, outside git.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use sha2::{Digest, Sha256};
use stutter_tracker_lib::transcription::{
    transcribe_audio_impl, whisper_cpp_model_path, TranscribeAudioRequest, TranscriptionProvider,
};

#[allow(dead_code)]
#[path = "../asr_bench.rs"]
mod asr_bench;

use asr_bench::{
    add_noise, compare_runs, ChallengeItem, ChallengeManifest, HypothesisItem, HypothesisRun,
    HypothesisSegment,
};

const USAGE: &str = "usage:\n  asr-eval transcribe --manifest <json> --root <dir> --model <whisper.cpp model> [--chunk-seconds 30] [--subset <id>]... [--limit N] --out <hypotheses.json>\n  asr-eval score --manifest <json> --root <dir> --baseline <hypotheses.json> --candidate <hypotheses.json> [--examples 20] --out <report.json>";

const SAMPLE_RATE: u32 = 16_000;

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Args {
    manifest: Option<PathBuf>,
    root: Option<PathBuf>,
    model: Option<String>,
    chunk_seconds: f64,
    subsets: Vec<String>,
    limit: Option<usize>,
    baseline: Option<PathBuf>,
    candidate: Option<PathBuf>,
    examples: usize,
    out: Option<PathBuf>,
}

fn run(args: Vec<String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let command = args.next().ok_or(USAGE)?;
    let mut parsed = Args {
        chunk_seconds: 30.0,
        examples: 20,
        ..Args::default()
    };
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))
        };
        match flag.as_str() {
            "--manifest" => parsed.manifest = Some(PathBuf::from(value()?)),
            "--root" => parsed.root = Some(PathBuf::from(value()?)),
            "--model" => parsed.model = Some(value()?),
            "--chunk-seconds" => {
                parsed.chunk_seconds = value()?
                    .parse()
                    .ok()
                    .filter(|seconds: &f64| *seconds >= 1.0)
                    .ok_or("--chunk-seconds must be at least 1")?
            }
            "--subset" => parsed.subsets.push(value()?),
            "--limit" => {
                parsed.limit = Some(
                    value()?
                        .parse()
                        .ok()
                        .filter(|limit| *limit > 0)
                        .ok_or("--limit must be a positive integer")?,
                )
            }
            "--baseline" => parsed.baseline = Some(PathBuf::from(value()?)),
            "--candidate" => parsed.candidate = Some(PathBuf::from(value()?)),
            "--examples" => {
                parsed.examples = value()?
                    .parse()
                    .map_err(|_| "--examples must be a number")?
            }
            "--out" => parsed.out = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    let manifest_path = parsed.manifest.clone().ok_or(USAGE)?;
    let root = parsed.root.clone().ok_or(USAGE)?;
    let out = parsed.out.clone().ok_or(USAGE)?;
    let manifest: ChallengeManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
    let output = match command.as_str() {
        "transcribe" => serde_json::to_string_pretty(&transcribe(&manifest, &root, &parsed)?),
        "score" => {
            let read_run = |path: &Option<PathBuf>| -> Result<HypothesisRun, String> {
                let path = path.as_ref().ok_or(USAGE)?;
                serde_json::from_str(
                    &fs::read_to_string(path)
                        .map_err(|error| format!("{}: {error}", path.display()))?,
                )
                .map_err(|error| format!("{}: {error}", path.display()))
            };
            let baseline = read_run(&parsed.baseline)?;
            let candidate = read_run(&parsed.candidate)?;
            let reference = |item: &ChallengeItem| -> Result<String, String> {
                let bytes = read_verified(&root, &item.reference, &item.reference_sha256)?;
                // UCLASS files are Latin-1.
                Ok(String::from_utf8(bytes.clone())
                    .unwrap_or_else(|_| bytes.iter().map(|byte| char::from(*byte)).collect()))
            };
            let name = manifest_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let report = compare_runs(
                &name,
                &manifest,
                &baseline,
                &candidate,
                &reference,
                parsed.examples,
            )?;
            print_summary(&report);
            serde_json::to_string_pretty(&report)
        }
        other => return Err(format!("unknown command {other}\n{USAGE}")),
    }
    .map_err(|error| error.to_string())?;
    fs::write(&out, output + "\n").map_err(|error| format!("{}: {error}", out.display()))?;
    eprintln!("wrote {}", out.display());
    Ok(())
}

fn read_verified(root: &Path, relative: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let path = root.join(relative);
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let actual = hex(&Sha256::digest(&bytes));
    if actual != sha256 {
        return Err(format!(
            "{} has SHA-256 {actual}, the manifest expects {sha256}",
            path.display()
        ));
    }
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn transcribe(
    manifest: &ChallengeManifest,
    root: &Path,
    args: &Args,
) -> Result<HypothesisRun, String> {
    let model = args.model.clone().ok_or(USAGE)?;
    let out = args.out.as_ref().ok_or(USAGE)?;
    let chunk = (args.chunk_seconds * f64::from(SAMPLE_RATE)).round() as usize;
    let threads = std::thread::available_parallelism()
        .ok()
        .map(|threads| threads.get());
    // Resumes an interrupted run of the same model, chunk length and thread count: its items are
    // kept and the file is rewritten after every item.
    let mut run = fs::read_to_string(out)
        .ok()
        .and_then(|text| serde_json::from_str::<HypothesisRun>(&text).ok())
        .filter(|run| {
            run.model == model && run.chunk_seconds == args.chunk_seconds && run.threads == threads
        })
        .unwrap_or_else(|| HypothesisRun {
            engine: "whisperCpp".to_string(),
            model_bytes: whisper_cpp_model_path(&model)
                .ok()
                .and_then(|path| fs::metadata(path).ok())
                .map(|metadata| metadata.len()),
            model: model.clone(),
            language: String::new(),
            chunk_seconds: args.chunk_seconds,
            threads,
            peak_rss_bytes: None,
            items: Vec::new(),
        });
    for subset in &manifest.subsets {
        if !args.subsets.is_empty() && !args.subsets.contains(&subset.id) {
            continue;
        }
        for item in subset.items.iter().take(args.limit.unwrap_or(usize::MAX)) {
            if run.items.iter().any(|done| {
                done.subset == subset.id
                    && done.item == item.id
                    && done.audio_sha256 == item.audio_sha256
            }) {
                continue;
            }
            let bytes = read_verified(root, &item.audio, &item.audio_sha256)?;
            let mut samples =
                read_wav(&bytes).map_err(|error| format!("{}: {error}", item.audio))?;
            if let Some(mix) = subset.noise {
                samples = add_noise(&samples, mix);
            }
            run.language.clone_from(&item.language);
            let started = Instant::now();
            let mut segments = Vec::new();
            for (index, part) in samples.chunks(chunk).enumerate() {
                // The product's transcription rejects anything shorter than 0.5 s.
                if part.len() < SAMPLE_RATE as usize / 2 {
                    continue;
                }
                let offset = (index * chunk) as f64 / f64::from(SAMPLE_RATE);
                let result = transcribe_audio_impl(TranscribeAudioRequest {
                    samples: part.to_vec(),
                    sample_rate: SAMPLE_RATE,
                    provider: TranscriptionProvider::WhisperCpp,
                    model: model.clone(),
                    language: Some(item.language.clone()),
                })
                .map_err(|error| format!("{}/{}: {error}", subset.id, item.id))?;
                segments.extend(
                    result
                        .segments
                        .into_iter()
                        .map(|segment| HypothesisSegment {
                            text: segment.text,
                            start_seconds: offset + segment.start_seconds,
                            end_seconds: offset + segment.end_seconds,
                        }),
                );
            }
            let wall_seconds = started.elapsed().as_secs_f64();
            let audio_seconds = samples.len() as f64 / f64::from(SAMPLE_RATE);
            eprintln!(
                "{model} {}/{}: {audio_seconds:.1} s audio in {wall_seconds:.1} s",
                subset.id, item.id
            );
            run.items.push(HypothesisItem {
                subset: subset.id.clone(),
                item: item.id.clone(),
                audio_sha256: item.audio_sha256.clone(),
                audio_seconds,
                wall_seconds,
                segments,
            });
            run.peak_rss_bytes = run.peak_rss_bytes.max(peak_rss_bytes());
            let partial = out.with_extension("json.part");
            fs::write(
                &partial,
                serde_json::to_string_pretty(&run).map_err(|error| error.to_string())? + "\n",
            )
            .and_then(|()| fs::rename(&partial, out))
            .map_err(|error| format!("{}: {error}", out.display()))?;
        }
    }
    Ok(run)
}

/// 16 kHz mono WAV samples as f32.
fn read_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let mut reader =
        hound::WavReader::new(std::io::Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.channels != 1 {
        return Err(format!(
            "expected 16 kHz mono, found {} Hz with {} channels",
            spec.sample_rate, spec.channels
        ));
    }
    match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string()),
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|sample| sample as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())
        }
    }
}

/// Peak resident memory of this process (Linux `VmHWM`).
fn peak_rss_bytes() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

fn print_summary(report: &asr_bench::ChallengeReport) {
    let fmt = |value: Option<f64>| value.map_or("-".to_string(), |value| format!("{value:.3}"));
    println!(
        "baseline {} ({} s chunks, RTF {}) vs candidate {} ({} s chunks, RTF {})",
        report.baseline.model,
        report.baseline.chunk_seconds,
        fmt(report.baseline.real_time_factor),
        report.candidate.model,
        report.candidate.chunk_seconds,
        fmt(report.candidate.real_time_factor),
    );
    for subset in &report.subsets {
        match (&subset.baseline, &subset.candidate) {
            (Some(b), Some(c)) => println!(
                "{}: rep+part preservation {} → {}, repeated-word deletion {} → {}, filler {} → {}, fluent WER {} → {}, insertions/100 {} → {}, pause words/min {} → {}, boundary error {} → {}",
                subset.id,
                fmt(b.repetition_and_part_word_preservation),
                fmt(c.repetition_and_part_word_preservation),
                fmt(b.repeated_word_deletion_rate),
                fmt(c.repeated_word_deletion_rate),
                fmt(b.classes.get("filler").and_then(|count| count.rate)),
                fmt(c.classes.get("filler").and_then(|count| count.rate)),
                fmt(b.fluent_word_error_rate),
                fmt(c.fluent_word_error_rate),
                fmt(b.inserted_words_per_100),
                fmt(c.inserted_words_per_100),
                fmt(b.words_in_long_pauses_per_minute),
                fmt(c.words_in_long_pauses_per_minute),
                fmt(b.median_boundary_error_seconds),
                fmt(c.median_boundary_error_seconds),
            ),
            _ => println!(
                "{}: gap ({})",
                subset.id,
                subset.gap.as_deref().unwrap_or("no items")
            ),
        }
    }
    println!(
        "verdict: {} — {}",
        if report.verdict.promoted {
            "promoted"
        } else {
            "not promoted"
        },
        report.verdict.reasons.join("; ")
    );
}
