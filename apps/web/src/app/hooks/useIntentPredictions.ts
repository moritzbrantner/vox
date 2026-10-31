import { hashKey, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isScoreWithheld } from "../../audio/captureQuality";
import { fallbackPredictSpeakerIntent, predictSpeakerIntentWithFallback } from "../speakerIntent";
import type { useWorkspace } from "./useWorkspace";
import type { useSessionLibrary } from "./useSessionLibrary";

type IntentPredictionsDeps = Pick<
  ReturnType<typeof useWorkspace>,
  "segments" | "report" | "interimText" | "transcript"
> &
  Pick<ReturnType<typeof useSessionLibrary>, "sessions">;

/** Speaker intent predictions for the current transcript. */
export function useIntentPredictions({
  segments,
  report,
  interimText,
  transcript,
  sessions,
}: IntentPredictionsDeps) {
  const intentPredictionRequest = useMemo(
    () => ({
      segments,
      sessions,
      // Events of a capture that failed the quality gate are not evidence to predict from.
      events: isScoreWithheld(report) ? [] : (report.events ?? []),
      partialText: [transcript, interimText].filter(Boolean).join(" ").trim(),
      maxContexts: 6,
      maxPredictions: 4,
      phraseTokens: 4,
    }),
    [segments, sessions, report, transcript, interimText],
  );
  // The key holds every saved session; see the same hash in useLiveAnalysis.
  const intentQueryHash = useMemo(
    () => hashKey(["intent-predictions", intentPredictionRequest]),
    [intentPredictionRequest],
  );
  const intentPredictionsQuery = useQuery({
    queryKey: ["intent-predictions", intentPredictionRequest],
    queryHash: intentQueryHash,
    queryFn: () => predictSpeakerIntentWithFallback(intentPredictionRequest),
    staleTime: 1_000,
  });
  const intentPredictions =
    intentPredictionsQuery.data ?? fallbackPredictSpeakerIntent(intentPredictionRequest);

  return { intentPredictions };
}
