// Speaker intent prediction: the desktop command and its local Markov fallback.
import { invoke } from "@tauri-apps/api/core";
import {
  type SavedSession,
  type SpeakerIntentPrediction,
  type StutterEvent,
  type TranscriptSegment,
} from "../types";
import { isDesktopApp } from "./config";

export type IntentPredictionRequest = {
  segments: TranscriptSegment[];
  sessions: SavedSession[];
  events: StutterEvent[];
  partialText: string;
  maxContexts: number;
  maxPredictions: number;
  phraseTokens: number;
};

export async function predictSpeakerIntentWithFallback(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  try {
    return await predictSpeakerIntent(request);
  } catch {
    return fallbackPredictSpeakerIntent(request);
  }
}

async function predictSpeakerIntent(
  request: IntentPredictionRequest,
): Promise<SpeakerIntentPrediction[]> {
  if (!isDesktopApp()) {
    return fallbackPredictSpeakerIntent(request);
  }
  return invoke<SpeakerIntentPrediction[]>("predict_speaker_intent", { request });
}

type LocalMarkov = {
  order: number;
  transitions: Map<string, Map<string, number>>;
};

type IntentCandidate = Omit<SpeakerIntentPrediction, "id" | "confidence" | "suggestions"> & {
  tokens: string[];
};

export function fallbackPredictSpeakerIntent(
  request: IntentPredictionRequest,
): SpeakerIntentPrediction[] {
  const orderTwo = createLocalMarkov(2);
  const orderOne = createLocalMarkov(1);
  for (const document of intentTrainingDocuments(request)) {
    trainLocalMarkov(orderTwo, document);
    trainLocalMarkov(orderOne, document);
  }

  const predictions: SpeakerIntentPrediction[] = [];
  const seen = new Set<string>();
  for (const candidate of intentCandidates(request).slice(0, request.maxContexts * 2)) {
    const suggestions =
      predictLocalIntent(
        orderTwo,
        candidate.tokens,
        request.maxPredictions,
        request.phraseTokens,
      ) ||
      predictLocalIntent(orderOne, candidate.tokens, request.maxPredictions, request.phraseTokens);
    if (!suggestions?.length) {
      continue;
    }
    const key = `${candidate.reason}:${candidate.contextText}:${candidate.triggerText ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    predictions.push({
      id: `intent-${predictions.length + 1}`,
      reason: candidate.reason,
      contextText: candidate.contextText,
      triggerText: candidate.triggerText,
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      speakerId: candidate.speakerId,
      speakerLabel: candidate.speakerLabel,
      confidence: Math.max(...suggestions.map((suggestion) => suggestion.probability)),
      suggestions,
    });
    if (predictions.length >= request.maxContexts) {
      break;
    }
  }
  return predictions;
}

function intentTrainingDocuments(request: IntentPredictionRequest) {
  return [...request.sessions.flatMap((session) => session.segments), ...request.segments]
    .filter((segment) => segment.isFinal)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
}

function intentCandidates(request: IntentPredictionRequest): IntentCandidate[] {
  const candidates: IntentCandidate[] = [];
  const partialTokens = tokenizeIntentText(request.partialText);
  if (partialTokens.length) {
    const latestSegment = request.segments.at(-1);
    candidates.push({
      reason: "currentContext",
      contextText: intentContextText(partialTokens),
      tokens: partialTokens,
      triggerText: null,
      startSeconds: latestSegment?.endSeconds,
      endSeconds: latestSegment?.endSeconds,
      speakerId: latestSegment?.speakerId,
      speakerLabel: latestSegment?.speakerLabel,
    });
  }

  for (const event of [...request.events].reverse()) {
    const segment = nearestIntentSegment(request.segments, event.startSeconds, event.endSeconds);
    if (!segment) {
      continue;
    }
    const segmentTokens = tokenizeIntentText(segment.text);
    const eventTokens = tokenizeIntentText(event.text);
    const tokens =
      prefixForIntentEvent(segmentTokens, eventTokens) ??
      tokensBeforeIntentTime(request.segments, event.startSeconds);
    if (!tokens.length) {
      continue;
    }
    candidates.push({
      reason: intentReasonForKind(event.kind),
      contextText: intentContextText(tokens),
      tokens,
      triggerText: event.text,
      startSeconds: event.startSeconds,
      endSeconds: event.endSeconds,
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
    });
  }
  return candidates;
}

function createLocalMarkov(order: number): LocalMarkov {
  return { order, transitions: new Map() };
}

function trainLocalMarkov(model: LocalMarkov, text: string) {
  const tokens = tokenizeIntentText(text);
  for (let index = model.order; index < tokens.length; index += 1) {
    const key = markovKey(tokens.slice(index - model.order, index));
    const next = model.transitions.get(key) ?? new Map<string, number>();
    next.set(tokens[index], (next.get(tokens[index]) ?? 0) + 1);
    model.transitions.set(key, next);
  }
}

function predictLocalIntent(
  model: LocalMarkov,
  context: string[],
  limit: number,
  phraseTokens: number,
) {
  if (context.length < model.order) {
    return null;
  }
  const key = markovKey(context.slice(-model.order));
  const counts = model.transitions.get(key);
  if (!counts?.size) {
    return null;
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
  return [...counts.entries()]
    .map(([token, count]) => ({
      token,
      count,
      probability: count / total,
      phrase: generateLocalPhrase(model, [...context, token], context.length + phraseTokens)
        .slice(context.length)
        .join(" "),
    }))
    .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token))
    .slice(0, limit);
}

function generateLocalPhrase(model: LocalMarkov, seed: string[], maxTokens: number) {
  const tokens = [...seed];
  while (tokens.length < maxTokens) {
    const counts = model.transitions.get(markovKey(tokens.slice(-model.order)));
    const next = bestLocalNext(counts);
    if (!next) {
      break;
    }
    tokens.push(next);
  }
  return tokens;
}

function bestLocalNext(counts?: Map<string, number>) {
  if (!counts?.size) {
    return null;
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

function markovKey(tokens: string[]) {
  return JSON.stringify(tokens);
}

function tokenizeIntentText(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

function nearestIntentSegment(
  segments: TranscriptSegment[],
  startSeconds: number,
  endSeconds: number,
) {
  return segments
    .filter((segment) => segment.isFinal)
    .sort(
      (left, right) =>
        distanceToIntentSpan(left, startSeconds, endSeconds) -
        distanceToIntentSpan(right, startSeconds, endSeconds),
    )[0];
}

function distanceToIntentSpan(
  segment: TranscriptSegment,
  startSeconds: number,
  endSeconds: number,
) {
  if (segment.startSeconds <= endSeconds && segment.endSeconds >= startSeconds) {
    return 0;
  }
  return segment.endSeconds < startSeconds
    ? startSeconds - segment.endSeconds
    : segment.startSeconds - endSeconds;
}

function prefixForIntentEvent(segmentTokens: string[], eventTokens: string[]) {
  if (!eventTokens.length) {
    return null;
  }
  for (let index = 0; index < segmentTokens.length; index += 1) {
    const matches = eventTokens.every((token, offset) => segmentTokens[index + offset] === token);
    if (matches) {
      return segmentTokens.slice(0, Math.min(segmentTokens.length, index + 1));
    }
  }
  return null;
}

function tokensBeforeIntentTime(segments: TranscriptSegment[], seconds: number) {
  return segments
    .filter((segment) => segment.isFinal && segment.endSeconds <= seconds)
    .flatMap((segment) => tokenizeIntentText(segment.text));
}

function intentContextText(tokens: string[]) {
  return tokens.slice(-5).join(" ");
}

function intentReasonForKind(kind: StutterEvent["kind"]): IntentCandidate["reason"] {
  const reasons = {
    block: "block",
    filler: "filler",
    wordRepetition: "repetition",
    soundRepetition: "repetition",
    prolongation: "prolongation",
  } as const;
  return reasons[kind];
}
