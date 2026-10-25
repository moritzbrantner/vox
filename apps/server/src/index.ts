import {
  type AnalyzeSpeechRequest,
  type SpeakerProfile,
  type TranscribeAudioRequest,
  type TranscribeAudioResult,
  type TranscriptionEngineId,
  cosine,
  fallbackAnalyze,
  fallbackEmbedding,
  SHARED_ANALYSIS_VERSION,
  staticModelStatuses,
} from "@stutter-tracker/shared";
import type { Server } from "bun";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseServerConfig, type ServerConfig } from "./config";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readFormDataWithLimit,
  readJson,
  type ResponseHeaders,
} from "./http";
import { createNativeWorker, type NativeWorker } from "./native-worker";
import { createSpeakerStore, type SpeakerStore } from "./speakers";
import {
  normalizeSpeakerProfileId,
  validateAnalyzeSpeechRequest,
  validateMeasuredCaptureMetrics,
  validateCreateSpeakerProfileRequest,
  validateDownloadModelRequest,
  validateIdentifySpeakerRequest,
  validateSpeakerProfilesBody,
  validateTranscribeAudioRequest,
  validateTranscribeAudioFileForm,
  validateTranscriptionModelsRequest,
} from "./validation";

export const ANALYZER_ALGORITHM_HEADER = "x-analyzer-algorithm";
export const ANALYZER_VERSION_HEADER = "x-analyzer-version";
const SERVER_ANALYZER_ALGORITHM = "shared-fallback";

export type ComputeServerDeps = {
  config: ServerConfig;
  speakerStore: SpeakerStore;
  nativeWorker: NativeWorker;
};

export type RequestHooks = {
  /** Called right before a native worker starts for this request. */
  workerStarting?: () => void;
};

export function createComputeRequestHandler(deps: ComputeServerDeps) {
  const jobs = createJobLimiter(deps.config.maxConcurrentJobs);

  /**
   * Measures the request audio with the audio-analysis capture kernel in the native worker, the
   * same measurement native analysis reports. Without a usable measurement (no audio, a busy or
   * failing worker) the report carries none, and clients show the capture as unchecked.
   */
  const measureCapture = async (
    body: AnalyzeSpeechRequest,
    signal: AbortSignal,
    hooks: RequestHooks,
  ) => {
    if (!body.samples?.length || !body.sampleRate) return undefined;
    const { samples, sampleRate } = body;
    try {
      const measured = await jobs.run(() => {
        hooks.workerStarting?.();
        return deps.nativeWorker.captureMetrics({ samples, sampleRate }, signal);
      });
      const metrics = validateMeasuredCaptureMetrics(measured);
      if (!metrics) console.warn("native worker returned invalid capture metrics");
      return metrics ?? undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        `capture metrics unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  return async function fetch(request: Request, hooks: RequestHooks = {}): Promise<Response> {
    const cors = corsHeaders(deps.config, request);
    if (cors instanceof Response) {
      return cors;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      authorize(deps.config, request);
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(
          deps.config.publicReady ? { ok: true } : { ok: true, service: "stutter-tracker-compute" },
          200,
          cors,
        );
      }

      if (request.method === "POST" && url.pathname === "/analysis") {
        const body = validateAnalyzeSpeechRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        const report = fallbackAnalyze(body, "computeServer");
        const captureMetrics = await measureCapture(body, request.signal, hooks);
        // Saved sessions record which analyzer produced a report.
        return jsonResponse(captureMetrics ? { ...report, captureMetrics } : report, 200, {
          ...cors,
          [ANALYZER_ALGORITHM_HEADER]: SERVER_ANALYZER_ALGORITHM,
          [ANALYZER_VERSION_HEADER]: SHARED_ANALYSIS_VERSION,
        });
      }

      if (request.method === "GET" && url.pathname === "/speakers") {
        return jsonResponse({ speakers: await deps.speakerStore.list() }, 200, cors);
      }

      if (request.method === "PUT" && url.pathname === "/speakers") {
        const speakers = validateSpeakerProfilesBody(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse({ speakers: await deps.speakerStore.upsertMany(speakers) }, 200, cors);
      }

      // The id travels as a query parameter: as a path segment, ids such as "." or ".." would be
      // normalized away by URL parsing. Deleting everything needs an explicit all=1.
      if (request.method === "DELETE" && url.pathname === "/speakers") {
        const originalId = url.searchParams.get("id");
        if (originalId !== null && originalId !== "") {
          const id = normalizeSpeakerProfileId(originalId);
          if (!id) throw new HttpError("invalid_request", "speaker id must not be blank", 400);
          if (!(await deps.speakerStore.delete(id))) {
            // A specific code, so clients can tell a missing profile from a missing route.
            return errorResponse("speaker_not_found", "speaker profile not found", 404, cors);
          }
          return jsonResponse({ deleted: 1 }, 200, cors);
        }
        if (url.searchParams.get("all") === "1") {
          return jsonResponse({ deleted: await deps.speakerStore.deleteAll() }, 200, cors);
        }
        throw new HttpError("invalid_request", "pass ?id=<speaker id> or ?all=1", 400);
      }

      if (request.method === "POST" && url.pathname === "/speakers/profile") {
        const body = validateCreateSpeakerProfileRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(createSpeakerProfile(body), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/speakers/identify") {
        const body = validateIdentifySpeakerRequest(
          await readJson(request, deps.config.maxBodyBytes),
        );
        return jsonResponse(identifySpeaker(body), 200, cors);
      }

      // Worker routes take a job slot before reading their body, so excess clients fail fast
      // instead of buffering uploads, and the listener's idle timeout stays in force while the
      // body arrives. It is lifted only when the worker actually starts.
      const runWorker = <T>(work: () => Promise<T>) => {
        hooks.workerStarting?.();
        return work();
      };

      if (request.method === "POST" && url.pathname === "/transcriptions/models") {
        return jsonResponse(
          await jobs.run(async () => {
            const body = validateTranscriptionModelsRequest(
              await readJson(request, deps.config.maxBodyBytes),
            );
            if (body.provider === "browser") {
              return { provider: body.provider, models: staticModelStatuses(body.provider) };
            }
            return runWorker(() =>
              deps.nativeWorker.transcriptionModels(body.provider, request.signal),
            );
          }),
          200,
          cors,
        );
      }

      if (request.method === "POST" && url.pathname === "/transcriptions") {
        return jsonResponse(
          await jobs.run(async () => {
            const body = validateTranscribeAudioRequest(
              await readJson(request, deps.config.maxBodyBytes),
              Math.floor(deps.config.maxBodyBytes / 4),
            );
            return runWorker(() => deps.nativeWorker.transcribeAudio(body, request.signal));
          }),
          200,
          cors,
        );
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/file") {
        const result = await jobs.run(async () => {
          const form = validateTranscribeAudioFileForm(
            await readFormDataWithLimit(request, deps.config.maxAudioBytes),
          );
          const uploadDir = await mkdtemp(join(deps.config.uploadTmpDir, "stutter-upload-"));
          const uploadPath = join(uploadDir, safeUploadName(form.audio.name));
          try {
            await writeFile(uploadPath, Buffer.from(await form.audio.arrayBuffer()));
            return await runWorker(() =>
              deps.nativeWorker.transcribeAudioFile(
                {
                  path: uploadPath,
                  provider: form.provider,
                  model: form.model,
                  language: form.language,
                  ffmpegBin: deps.config.ffmpegBin,
                },
                request.signal,
              ),
            );
          } finally {
            await rm(uploadDir, { recursive: true, force: true });
          }
        });
        return jsonResponse(withValidatedCaptureMetrics(result), 200, cors);
      }

      if (request.method === "POST" && url.pathname === "/transcriptions/models/download") {
        return jsonResponse(
          await jobs.run(async () => {
            const body = validateDownloadModelRequest(
              await readJson(request, deps.config.maxBodyBytes),
            );
            return runWorker(() =>
              deps.nativeWorker.downloadTranscriptionModel(
                body.provider,
                body.model,
                request.signal,
              ),
            );
          }),
          200,
          cors,
        );
      }

      return errorResponse("not_found", "not found", 404, cors);
    } catch (error) {
      return handleError(deps.config, error, cors);
    }
  };
}

/**
 * Bun closes a connection that sends no response bytes for `idleTimeout` (10 s by default) and
 * aborts `request.signal`. Worker jobs run for minutes and are bounded by the worker's own
 * timeouts, so the idle timeout is lifted once the worker starts; until then (while the body
 * arrives) it applies. A real client disconnect still aborts the signal.
 */
export function withWorkerTimeouts(
  handler: (request: Request, hooks: RequestHooks) => Promise<Response>,
) {
  return (request: Request, server: Pick<Server<unknown>, "timeout">) =>
    handler(request, { workerStarting: () => server.timeout(request, 0) });
}

// Every route that spawns a native worker shares one bound, so a client cannot queue
// unbounded processes; excess requests fail fast instead of waiting.
function createJobLimiter(maxConcurrentJobs: number) {
  let active = 0;
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrentJobs) {
        throw new HttpError("server_busy", "compute server is busy; retry later", 503);
      }
      active += 1;
      try {
        return await job();
      } finally {
        active -= 1;
      }
    },
  };
}

/**
 * The worker's measurement of an uploaded file, validated field by field like the analysis
 * route's. A missing or malformed measurement never fails the transcription; clients then show
 * the capture as unchecked.
 */
function withValidatedCaptureMetrics(result: TranscribeAudioResult): TranscribeAudioResult {
  const { captureMetrics: measured, ...transcription } = result;
  if (measured === undefined || measured === null) {
    // The worker exits successfully when it cannot measure the file and its stderr is only read
    // on failure, so this is the server's record that the upload stays unchecked.
    console.warn(
      "native worker did not measure the uploaded file; its capture quality is unchecked",
    );
    return transcription;
  }
  const captureMetrics = validateMeasuredCaptureMetrics(measured);
  if (!captureMetrics) {
    console.warn("native worker returned invalid capture metrics for an uploaded file");
    return transcription;
  }
  return { ...transcription, captureMetrics };
}

function safeUploadName(filename: string) {
  const suffix = filename
    .split(".")
    .at(-1)
    ?.replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return `audio-${crypto.randomUUID()}${suffix ? `.${suffix}` : ""}`;
}

export function startComputeServer(config = parseServerConfig()) {
  const speakerStore = createSpeakerStore({
    databaseUrl: config.databaseUrl,
    filePath: config.speakerStorePath,
  });
  const nativeWorker = createNativeWorker(config);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: withWorkerTimeouts(createComputeRequestHandler({ config, speakerStore, nativeWorker })),
  });
  console.log(`stutter-tracker compute server listening on http://${config.host}:${server.port}`);
  if (!config.databaseUrl) {
    console.warn(`DATABASE_URL is not set; speaker profiles use ${config.speakerStorePath}`);
  }
  if (!config.nativeWorker) {
    console.warn("STUTTER_NATIVE_WORKER is not set; using cargo-run native worker fallback.");
  }
  return server;
}

if (import.meta.main) {
  startComputeServer();
}

function createSpeakerProfile(body: {
  id?: string;
  label: string;
  samples: number[];
  sampleRate: number;
}): SpeakerProfile {
  return {
    id: body.id ?? crypto.randomUUID(),
    label: body.label.trim() || "Speaker",
    embeddings: [fallbackEmbedding(body.samples)],
    sampleRate: body.sampleRate,
    sampleCount: body.samples.length,
  };
}

function identifySpeaker(body: {
  samples: number[];
  speakers: SpeakerProfile[];
  threshold?: number;
  maxResults?: number;
}) {
  const current = fallbackEmbedding(body.samples);
  const matches = body.speakers
    .map((speaker) => ({
      speakerId: speaker.id,
      label: speaker.label,
      score: Math.max(...speaker.embeddings.map((embedding) => cosine(current, embedding))),
    }))
    .filter((match) => match.score >= (body.threshold ?? 0.82))
    .sort((left, right) => right.score - left.score)
    .slice(0, body.maxResults ?? 3);
  return { bestMatch: matches[0], matches, isMatch: Boolean(matches[0]) };
}

function isLoopbackOrigin(origin: string) {
  try {
    const host = new URL(origin).hostname;
    // The whole 127.0.0.0/8 range is loopback, as in the client's local-companion policy.
    return (
      host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

function corsHeaders(config: ServerConfig, request: Request): ResponseHeaders | Response {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-expose-headers": `${ANALYZER_ALGORITHM_HEADER}, ${ANALYZER_VERSION_HEADER}`,
    vary: "Origin",
  };
  if (!origin) {
    return headers;
  }

  const allowed =
    config.allowedOrigins.includes(origin) ||
    (!config.publicReady && config.allowedOrigins.includes("*")) ||
    (!config.publicReady && config.allowedOrigins.length === 0);
  if (!allowed) {
    return errorResponse("forbidden_origin", "origin is not allowed", 403, headers);
  }
  // Loopback mode accepts any origin without a token, so destructive requests from a browser must
  // come from a loopback page or an explicitly allowed origin; any website could otherwise erase
  // the stored voiceprints. Non-browser clients send no Origin and are unaffected.
  const destructive =
    request.method === "DELETE" ||
    (request.method === "OPTIONS" &&
      request.headers.get("access-control-request-method")?.toUpperCase() === "DELETE");
  if (destructive && !config.allowedOrigins.includes(origin) && !isLoopbackOrigin(origin)) {
    return errorResponse(
      "forbidden_origin",
      "deleting requires a loopback or explicitly allowed origin",
      403,
      headers,
    );
  }

  return {
    ...headers,
    "access-control-allow-origin": origin,
  };
}

function authorize(config: ServerConfig, request: Request) {
  const url = new URL(request.url);
  if (!config.publicReady || (request.method === "GET" && url.pathname === "/health")) {
    return;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (
    !authorization.startsWith(prefix) ||
    !tokenEquals(authorization.slice(prefix.length), config.apiToken)
  ) {
    throw new HttpError("unauthorized", "authorization bearer token is invalid", 401);
  }
}

function tokenEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function handleError(config: ServerConfig, error: unknown, headers: ResponseHeaders) {
  if (error instanceof HttpError) {
    return errorResponse(error.code, error.message, error.status, headers);
  }
  const message = config.publicReady
    ? "internal server error"
    : error instanceof Error
      ? error.message
      : String(error);
  return errorResponse("internal_error", message, 500, headers);
}

export type { AnalyzeSpeechRequest, TranscribeAudioRequest, TranscriptionEngineId };
