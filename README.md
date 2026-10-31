# Speak

Speak is the canonical cross-platform speech fluency and speaking-assistance product, organized as a Bun monorepo.

The repository still uses the legacy `stutter-tracker` slug and `@stutter-tracker/*` package scope for compatibility. The old `speak` and `speaky` repositories were generic template experiments and are being retired rather than merged into this codebase.

Generic capabilities remain owned by their existing repositories: `audio-analysis` for reusable audio/transcription processing, `nlp-stack` for reusable transcript/language processing, and `moenarch-foundation` for neutral shared contracts. Speak owns product-specific fluency interpretation, personalization, assistance policy, sessions, UX, and product evaluation.

## Workspaces

- `apps/web`: Vite React web app. It uses the configured compute server only under the processing policy below and falls back to browser-local analysis with WebGPU probing when that server is unavailable.
- `apps/desktop`: Tauri 2 desktop app. It keeps the Rust-backed local hardware path for analysis, speaker matching, transcription, and model downloads.
- `apps/mobile`: React Native app built with Expo. It transcribes through a compute server selected under the processing policy below.
- `apps/server`: Bun HTTP compute server with shared analysis, speaker persistence, secured CORS/auth, and native transcription worker delegation.
- `packages/shared`: Shared domain types, model catalogs, fallback analysis, audio resampling, and speaker helpers.
- `packages/compute-client`: Shared HTTP compute client used by web and mobile.

## Commands

- Local web + compute server: `bun run dev`
- Build every workspace with Turborepo: `bun run build`
- Test every testable workspace with Turborepo: `bun run test`
- Format every formattable workspace: `bun run format`
- Check formatting, builds, and tests: `bun run check`
- Web dev/start/build/test: `bun run web`, `bun run start:web`, `bun run build:web`, `bun run test:web`
- Compute server dev/start/build/test: `bun run server`, `bun run start:server`, `bun run build:server`, `bun run test:server`
- Desktop dev/start/build/test: `bun run desktop`, `bun run start:desktop`, `bun run build:desktop`, `bun run test:desktop`
- Mobile start/build/test: `bun run mobile`, `bun run build:mobile`, `bun run test:mobile`
- Artifact status: `bun run artifacts:status`
- Download default local transcription artifact: `bun run artifacts:download`
- Build shared packages: `bun run build:shared`
- Unit tests: `bun run test:unit`
- Integration tests: `bun run test:integration`
- E2E tests: `bun run test:e2e`
- Rust tests: `bun run test:rust`

## Processing Policy

Speech content (audio, transcripts, voiceprints) is processed under one explicit policy from `packages/compute-client`:

- **On this device** (`onDevice`, the client default): no server requests at all. Set `VITE_STUTTER_SERVER_URL=` (empty) for the web app or clear the server URL in the mobile app.
- **Local companion** (`localCompanion`): a server on a loopback address (`localhost`, `127.x.x.x`, `::1`). This is the development default `http://127.0.0.1:8787`.
- **Remote** (`remote`): any other server, including LAN addresses and the Android emulator alias. Nothing is sent until the user consents in the app for that exact URL; the consent covers recordings, transcripts and speaker profiles (voiceprints), which the server may store; changing the URL withdraws consent.

The destination is shown in the app and fixed for a run. If a server fails, analysis falls back to on-device processing; it never switches to another server. The web app's Browser Speech engine uses the browser's speech recognition, which some browsers run in the cloud; it is outside this policy.

Consent: pressing Record is consent to record on this device; on-device recording needs nothing else. Recording other people is different: ticking **Recording other people** keeps Record disabled until the user adds each other person (a short name or label) and confirms each one ("Robin has agreed to be recorded."). Adding another person blocks Record again until they are confirmed too. The list is made per session, is cleared when the recording ends, and each confirmation is stored with the session's capture descriptor (with its label, time and wording), so session history, backups, crash recovery and the evidence export show each participant. Sessions saved before per-participant consent show one entry, "Everyone else (before per-participant consent)". The evidence export names participants only when it includes speaker names; otherwise they are "Participant 1", …. Saved sessions keep transcripts and analyses, not audio, unless the user ticks **Keep audio on this device for review** before saving: then that session's raw capture is stored on this device (in a browser, its IndexedDB; in the desktop app, protected storage) for annotation review (waveform, span looping, review speed). Deleting the session removes it, a restore removes all kept audio, and backups and exports never include it. Data leaving the device is gated by a consent ledger in which every purpose is denied until the user grants it: remote analysis (per exact server URL), clinician sharing, research contribution and model training. The web evidence export requires clinician-sharing consent before downloading a selected report or data file. So does the annotation exchange file, which lets a clinician rater on another device annotate a session and send the revisions back. It holds the transcript (with speaker names), annotation revisions and the validation declaration. It also holds the session's kept audio, but only when that is selected and previewed for that session. It never holds analysis results, conditions, dates or voiceprints. Every file carries the fixed permitted use: review only, no redistribution, no model training. Importing a file never changes or removes local revisions. A session this device does not have becomes a review copy, which has no analysis and is left out of this user's own statistics, corpus and evidence export. Research contribution and model training have no feature yet and stay denied. Each grant, denial and withdrawal is appended with a timestamp. Withdrawing stops future use only: it cannot recall copies a server or person has already received. The web app keeps the ledger in local storage. The mobile app keeps it for the app session, and editing the server URL withdraws consent for the previous URL.

Local storage protection: the desktop app encrypts sessions, voiceprints, settings, capture checkpoints, the corpus and kept audio with a key held in the operating system's credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service), and moves data earlier builds left unencrypted into it on first start. A browser keeps them unencrypted in its profile storage. The mobile app keeps no sessions and deletes each recording after upload. What each platform protects against, and what it does not, is in [docs/protected-storage.md](docs/protected-storage.md); the app shows the same disclosure.

## Compute Setup

The default compute URL is the local companion `http://127.0.0.1:8787`.

Known speaker profiles are persisted by the server when `DATABASE_URL` or `POSTGRES_URL` points at a Postgres database. The server creates the `known_speakers` table on first use. Without a database URL, the server writes a local JSON speaker store at `.stutter-tracker/server-speakers.json` by default. Override that path with `STUTTER_SPEAKER_STORE_PATH`.

For local development, run:

```sh
bun run dev
```

This starts the compute server on `http://127.0.0.1:8787` and the web app on `http://127.0.0.1:1421`, with the web app pointed at the local server.

Optional local overrides:

```sh
STUTTER_SERVER_PORT=8788 STUTTER_WEB_PORT=3000 bun run dev
```

For the web app, override it with:

```sh
VITE_STUTTER_SERVER_URL=http://host:8787 bun run web
```

For the mobile app, edit the server URL in the app UI. Android emulators usually need the host loopback alias instead of `127.0.0.1`.

The compute server delegates native transcription to the Rust worker used by the desktop app. The worker also measures the audio sent with `/analysis` (the audio-analysis capture kernel, as in native analysis), so server reports carry `captureMetrics` for the capture-quality gate. Without a working worker, analysis still runs, and its capture quality is reported as not checked. In local development the server falls back to running:

```sh
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin compute-worker
```

For production, build the worker and point the server at it:

```sh
cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml --bin compute-worker
STUTTER_NATIVE_WORKER=/absolute/path/to/compute-worker bun run server
```

### Public Compute Deployment

The server is permissive only for loopback local development. When `HOST` is not loopback, `NODE_ENV=production`, or `STUTTER_PUBLIC_READY=1`, the server requires explicit security configuration:

```sh
HOST=0.0.0.0 \
STUTTER_PUBLIC_READY=1 \
STUTTER_API_TOKEN=replace-with-a-long-random-token \
STUTTER_ALLOWED_ORIGINS=https://app.example.com \
STUTTER_NATIVE_WORKER=/absolute/path/to/compute-worker \
bun run server
```

Clients send the token as `Authorization: Bearer <token>`. The web app reads `VITE_STUTTER_API_TOKEN`; the mobile app has an API token field in the UI. A `VITE_*` value is bundled into the web app and visible to anyone who loads it, so it is not a secret and cannot secure a shared multi-user service; treat it as protection for a single trusted user only. Public-ready CORS uses the configured origin allowlist and never emits wildcard origins.

Deployment boundary:

- **One token is one trust domain.** The server has no user accounts or per-user resource isolation: every holder of the token can read and overwrite every stored speaker profile (voiceprint) and use the transcription worker. Run one server per trusted user; a shared multi-user public service needs real per-user authentication and isolation, which this server does not provide.
- **Transport.** The server speaks plain HTTP. Off the loopback interface, put it behind a TLS-terminating reverse proxy; never send the token or audio over plain HTTP across a network.
- **Limits.** JSON bodies are capped by `STUTTER_MAX_BODY_BYTES` and whole upload bodies by `STUTTER_MAX_AUDIO_BYTES` plus a small multipart allowance; bytes are counted while reading, so chunked bodies without `Content-Length` are bounded too. At most `STUTTER_MAX_CONCURRENT_JOBS` (default 2) native worker processes run at once; further worker requests fail with `server_busy` (503) before their body is read, instead of queueing. Worker jobs time out (10 seconds for model listing, 10 minutes for transcription, 1 hour for model downloads); the listener's idle timeout still bounds the upload and is lifted only once the worker starts, so these limits apply. A client disconnect kills the job's worker process group, including `ffmpeg` and Whisper children (`SIGKILL` after 2 seconds if it ignores `SIGTERM`), and its job slot is released only once the worker has exited.
- **What the server keeps.** Uploaded audio exists only in a per-request temporary directory under `STUTTER_UPLOAD_TMP_DIR`, removed after success, failure or cancellation (a crash or `SIGKILL` can leave a `stutter-upload-*` directory behind; clean that directory on restart). Transcripts and analysis results are returned, not stored. Speaker profiles (voiceprints) are persisted in Postgres or the JSON speaker store until deleted: `DELETE /speakers?id=<id>` removes one and `DELETE /speakers?all=1` removes all (both require the token in public-ready mode; in loopback mode a browser request must come from a loopback or allowed origin). Removing a known speaker in the web app deletes it on the selected server too and says when only the local copy could be removed. The server logs only its startup configuration, never request contents, and public-ready error responses do not echo worker output.

Optional server settings:

```sh
STUTTER_MAX_BODY_BYTES=25mb
STUTTER_MAX_AUDIO_BYTES=50mb
STUTTER_MAX_CONCURRENT_JOBS=2
STUTTER_UPLOAD_TMP_DIR=/tmp
STUTTER_FFMPEG_BIN=ffmpeg
STUTTER_SPEAKER_STORE_PATH=/var/lib/stutter-tracker/speakers.json
DATABASE_URL=postgres://user:pass@host:5432/db
```

Mobile and other non-browser clients can upload recorded audio with
`POST /transcriptions/file`. The server stores uploads in a temporary directory,
delegates to the native worker, and deletes the temporary file after success,
failure or cancellation. Non-WAV uploads for `whisperCpp` are normalized with `ffmpeg`; set
`STUTTER_FFMPEG_BIN` if the binary is not on `PATH`.

## Desktop Rust Dependencies

The desktop crate now follows the extracted capability owners instead of the monolithic `rust-packages` Git revision. Registry coordinates remain the distribution contract; ordinary cross-repository development uses the exact local source graph declared in `.coding-tooling.source-deps.json`.

Keep `stutter-tracker`, `audio-analysis`, `nlp-stack`, `moenarch-foundation`, and `coding-tooling` as sibling repositories/worktrees. The outer coding workspace should place each source repository at the exact revision declared by Stutter Tracker, then activate it with:

```sh
bash scripts/source-deps activate
bash scripts/source-deps status
```

Local-only source mode validates every sibling `HEAD`. Missing or mismatched source fails explicitly and never falls back to authenticated Git. Normal feature development therefore does not require a private-repository token or upstream package publication.

When source work is complete, remove the generated Cargo override with:

```sh
bash scripts/source-deps deactivate
```

The generated `.cargo/config.toml` is local development state and must not be committed. The committed Cargo lockfile remains part of the reproducible distribution graph and should be regenerated deliberately when registry coordinates change.

## Artifacts

Generated build output, benchmark media, model caches, recordings, exports, and partial downloads are ignored by Git. Keep source code, configuration, lockfiles, and small app assets in the repository; put heavyweight runtime artifacts under ignored artifact/cache directories.

The desktop app downloads missing whisper.cpp models on demand before transcription and reuses cached models afterward. To prepare local artifacts explicitly, run:

```sh
bun run artifacts:status
bun run artifacts:download -- small.en
```

`bun run artifacts:download` is idempotent and defaults to `base.en`. Use `bun run artifacts:download:all` only when you intentionally want every supported whisper.cpp model cached locally.

### GPU transcription

The whisper.cpp engine uses the GPU when one is usable and falls back to the CPU. The GPU path runs the [native-whisperx](https://github.com/moritzbrantner/native-whisperx) CLI on CUDA (`STUTTER_NATIVE_WHISPERX_BIN`, else `native-whisperx` on `PATH`, built with `--features cuda`, at or after native-whisperx a53b2c7); it fetches the same Whisper checkpoint from Hugging Face. The process starts one `native-whisperx serve` child on its first GPU chunk and keeps it, so the model loads once rather than for every chunk. When the binary is missing, has no CUDA, or finds no GPU, transcription runs on whisper.cpp on the CPU, and the reason is logged. **CPU only** in the header turns the GPU path off. The backend and device of each transcript are recorded in its provenance and shown in the header and the transcript revisions panel. Only NVIDIA GPUs are used for now: native-whisperx has no Vulkan or Metal backend, and whisper.cpp in audio-analysis is built for the CPU. The compute server's worker follows the same rules.

## Notes

The app tracks speech patterns for personal review and is not a diagnostic tool.
