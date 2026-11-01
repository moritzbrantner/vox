//! Desktop speaking-workflow budgets on real recordings (vox#43; see
//! `docs/benchmarks/runtime-budgets.md`). Prints one JSON report on stdout.
//!
//! workflow-bench --hypotheses <asr-eval run.json> --root <dir holding audio16k/> \
//!   [--limit N] [--store <dir>]
//!
//! Each hypothesis item without a noise subset is one recording: its 16 kHz WAV and its
//! transcript. Run it through `scripts/runtime-budgets.ts`, which also runs the browser harness,
//! compares the deterministic counters with the committed baseline and reports timings.

use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::Value;
use stutter_tracker_lib::workflow_bench::{read_wav, run, Options, Recording};

fn main() -> ExitCode {
    match main_inner() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn main_inner() -> Result<(), String> {
    let mut hypotheses = None;
    let mut root = None;
    let mut limit = usize::MAX;
    let mut store = std::env::temp_dir().join(format!("vox-workflow-bench-{}", std::process::id()));
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        let mut value = || args.next().ok_or(format!("{argument} requires a value"));
        match argument.as_str() {
            "--hypotheses" => hypotheses = Some(PathBuf::from(value()?)),
            "--root" => root = Some(PathBuf::from(value()?)),
            "--limit" => limit = value()?.parse().map_err(|_| "--limit must be a number")?,
            "--store" => store = PathBuf::from(value()?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let hypotheses = hypotheses.ok_or("--hypotheses is required")?;
    let root = root.ok_or("--root is required")?;
    let run_file: Value = serde_json::from_str(
        &std::fs::read_to_string(&hypotheses).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let chunk_seconds = run_file["chunkSeconds"].as_f64().unwrap_or(8.0);
    // Each recording's audio is read when its workflow starts, so only one capture is resident.
    let recordings = run_file["items"]
        .as_array()
        .ok_or("hypotheses have no items")?
        .iter()
        .filter(|item| !item["subset"].as_str().unwrap_or("").contains("noise"))
        .take(limit)
        .map(|item| {
            let id = item["item"].as_str().ok_or("item without id")?.to_string();
            let (sample_rate, samples) =
                read_wav(&root.join("audio16k").join(format!("{id}.wav")))?;
            let segments = item["segments"]
                .as_array()
                .ok_or("item without segments")?
                .iter()
                .map(|segment| {
                    (
                        segment["text"].as_str().unwrap_or_default().to_string(),
                        segment["startSeconds"].as_f64().unwrap_or(0.0),
                        segment["endSeconds"].as_f64().unwrap_or(0.0),
                    )
                })
                .collect();
            Ok(Recording {
                id,
                sample_rate,
                samples,
                segments,
            })
        });
    let report = run(
        recordings,
        &Options {
            chunk_seconds,
            store_root: store,
        },
    )?;
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|error| error.to_string())?
    );
    Ok(())
}
