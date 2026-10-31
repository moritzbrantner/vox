import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { type SpeakerMatch, type SpeakerProfile } from "../../types";
import { SPEAKER_LOAD_GRACE_MS, computeClient, isDesktopApp } from "../config";
import { errorMessage } from "../errors";
import {
  createSpeakerProfile,
  loadPersistedSpeakerProfiles,
  loadSpeakerProfiles,
  removeLocalSpeakerCopy,
  savePersistedSpeakerProfiles,
} from "../speakerProfiles";
import type { useWorkspace } from "./useWorkspace";

type SpeakerProfilesDeps = Pick<
  ReturnType<typeof useWorkspace>,
  "setMessage" | "sampleRateRef" | "samplesRef"
>;

/** Voiceprints: startup load, enrollment, removal and the current speaker match. */
export function useSpeakerProfiles({ setMessage, sampleRateRef, samplesRef }: SpeakerProfilesDeps) {
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>(() => loadSpeakerProfiles());

  const [failedSpeakerDeletions, setFailedSpeakerDeletions] = useState<SpeakerProfile[]>([]);
  const [pendingSpeakerDeletionIds, setPendingSpeakerDeletionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Removal waits for the startup load, which could otherwise restore or re-upload a removed
  // voiceprint from its earlier snapshot.
  const [speakersReady, setSpeakersReady] = useState(false);
  // Counts removals, so a slow startup load can tell its snapshot is stale.
  const speakerRemovalsRef = useRef(0);
  const speakerEnrollmentsRef = useRef(0);
  const removedSpeakerIdsRef = useRef(new Set<string>());
  const reloadSpeakersRef = useRef<(() => void) | null>(null);
  const speakerMutationTailRef = useRef<Promise<unknown>>(Promise.resolve());

  const [isEnrolling, setIsEnrolling] = useState(false);

  const [speakerLabel, setSpeakerLabel] = useState("");

  const [speakerMatch, setSpeakerMatch] = useState<SpeakerMatch | null>(null);

  const speakersRef = useRef<SpeakerProfile[]>(speakers);
  const speakerMatchRef = useRef<SpeakerMatch | null>(speakerMatch);
  const speakerMatchInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    const readyTimer = setTimeout(() => setSpeakersReady(true), SPEAKER_LOAD_GRACE_MS);
    const hydrate = (fallbackToLocal = false) => {
      const request = ++latestRequest;
      const removalsAtStart = speakerRemovalsRef.current;
      const enrollmentsAtStart = speakerEnrollmentsRef.current;
      const isStale = () =>
        cancelled ||
        request !== latestRequest ||
        speakerRemovalsRef.current !== removalsAtStart ||
        speakerEnrollmentsRef.current !== enrollmentsAtStart;
      loadPersistedSpeakerProfiles(
        isStale,
        (profiles) =>
          queueSpeakerMutation(async () => {
            if (isStale()) return [];
            return savePersistedSpeakerProfiles(
              profiles.filter((profile) => !removedSpeakerIdsRef.current.has(profile.id)),
            );
          }),
        fallbackToLocal,
      )
        .then((persistedSpeakers) => {
          if (!isStale()) {
            const next = persistedSpeakers.filter(
              (profile) => !removedSpeakerIdsRef.current.has(profile.id),
            );
            speakersRef.current = next;
            setSpeakers(next);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(readyTimer);
          if (!cancelled) setSpeakersReady(true);
        });
    };
    reloadSpeakersRef.current = () => hydrate();
    hydrate(true);
    return () => {
      cancelled = true;
      reloadSpeakersRef.current = null;
    };
  }, []);

  useEffect(() => {
    speakersRef.current = speakers;
  }, [speakers]);

  useEffect(() => {
    speakerMatchRef.current = speakerMatch;
  }, [speakerMatch]);

  async function saveSpeakerProfile() {
    if (samplesRef.current.length < sampleRateRef.current) {
      setMessage("Record a short sample first");
      return;
    }
    const label = speakerLabel.trim() || `Speaker ${speakersRef.current.length + 1}`;
    const existing = speakersRef.current.find(
      (speaker) => speaker.label.toLowerCase() === label.toLowerCase(),
    );
    setIsEnrolling(true);
    setMessage("Enrolling speaker");
    try {
      const result = await createSpeakerProfile(
        existing?.id,
        label,
        samplesRef.current.slice(-sampleRateRef.current * 12),
        sampleRateRef.current,
      );
      // Same queue as removals, built from the latest list when it runs, so an enrollment
      // cannot write back a profile removed while it was being created.
      const persisted = await queueSpeakerMutation(async () => {
        const latest = speakersRef.current;
        if (existing && !latest.some((speaker) => speaker.id === existing.id)) {
          throw new Error(
            "This voiceprint was removed while enrollment was pending. Enroll again to create a new profile.",
          );
        }
        const next =
          existing && latest.some((speaker) => speaker.id === existing.id)
            ? latest.map((speaker) =>
                speaker.id === existing.id
                  ? {
                      ...speaker,
                      label: result.label,
                      embeddings: [...speaker.embeddings, ...result.embeddings],
                      sampleCount: speaker.sampleCount + result.sampleCount,
                      sampleRate: result.sampleRate,
                    }
                  : speaker,
              )
            : [...latest, result];
        const saved = await savePersistedSpeakerProfiles(next);
        speakerEnrollmentsRef.current += 1;
        if (saved.some((speaker) => speaker.id === result.id)) {
          removedSpeakerIdsRef.current.delete(result.id);
        }
        speakersRef.current = saved;
        return saved;
      });
      setSpeakers(persisted);
      setSpeakerLabel("");
      setMessage(`${result.label} enrolled`);
    } catch (error) {
      setMessage(`Enrollment failed: ${errorMessage(error)}`);
    } finally {
      setIsEnrolling(false);
    }
  }

  // Removing a voiceprint deletes the local copy and, when a server holds it, the server copy;
  // the message says which happened. Removals run one at a time from the latest list.
  function removeSpeakerProfile(speaker: SpeakerProfile) {
    if (!window.confirm(`Remove the voiceprint for ${speaker.label}?`)) {
      return Promise.resolve();
    }
    speakerRemovalsRef.current += 1;
    return queueSpeakerMutation(() => removeSpeakerLocally(speaker)).then((removed) => {
      if (!removed) {
        speakerRemovalsRef.current -= 1;
        reloadSpeakersRef.current?.();
        return;
      }
      removedSpeakerIdsRef.current.add(speaker.id);
      reloadSpeakersRef.current?.();
      // Remote deletion remains outside the queue so a stalled server does not block local changes.
      return deleteSpeakerRemotely(speaker);
    });
  }

  function queueSpeakerMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = speakerMutationTailRef.current.then(mutation);
    speakerMutationTailRef.current = operation.catch(() => undefined);
    return operation;
  }

  /** Removes the local copies; resolves true when the speaker is gone locally. */
  async function removeSpeakerLocally(speaker: SpeakerProfile): Promise<boolean> {
    const remaining = speakersRef.current.filter((candidate) => candidate.id !== speaker.id);
    // Browser-storage copies go first (on desktop they are what the profile was migrated from),
    // so a failure leaves the profile listed and removable.
    try {
      removeLocalSpeakerCopy(speaker.id);
    } catch (error) {
      setMessage(`Could not remove ${speaker.label} from this browser: ${errorMessage(error)}`);
      return false;
    }
    let next = remaining;
    if (isDesktopApp()) {
      try {
        next = await invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: remaining });
      } catch (error) {
        setMessage(`Could not remove ${speaker.label}: ${errorMessage(error)}`);
        return false;
      }
    }
    speakersRef.current = next;
    setSpeakers(next);
    if (speakerMatchRef.current?.speakerId === speaker.id) {
      speakerMatchRef.current = null;
      setSpeakerMatch(null);
    }
    if (isDesktopApp()) {
      setMessage(`Removed ${speaker.label}`);
    }
    return true;
  }

  async function deleteSpeakerRemotely(speaker: SpeakerProfile) {
    if (isDesktopApp()) {
      return;
    }
    setPendingSpeakerDeletionIds((ids) => new Set([...ids, speaker.id]));
    try {
      const result = await computeClient.deleteSpeakerProfile(speaker.id);
      if (result !== "noServer") {
        setFailedSpeakerDeletions((profiles) =>
          profiles.filter((profile) => profile.id !== speaker.id),
        );
        reloadSpeakersRef.current?.();
      }
      setMessage(
        result === "noServer"
          ? // No server is permitted now; one used under earlier consent may still hold a copy.
            `Removed ${speaker.label} from this device. No compute server is selected now; if you sent it to one earlier, delete it there too.`
          : `Removed ${speaker.label} here and from the compute server`,
      );
    } catch (error) {
      setFailedSpeakerDeletions((profiles) => [
        ...profiles.filter((profile) => profile.id !== speaker.id),
        speaker,
      ]);
      setMessage(
        `Removed ${speaker.label} on this device only; deleting it from the compute server failed (${errorMessage(error)})`,
      );
    } finally {
      setPendingSpeakerDeletionIds((ids) => {
        const next = new Set(ids);
        next.delete(speaker.id);
        return next;
      });
    }
  }

  return {
    speakers,
    failedSpeakerDeletions,
    pendingSpeakerDeletionIds,
    speakersReady,
    isEnrolling,
    speakerLabel,
    setSpeakerLabel,
    speakerMatch,
    setSpeakerMatch,
    speakersRef,
    speakerMatchRef,
    speakerMatchInFlightRef,
    saveSpeakerProfile,
    removeSpeakerProfile,
    deleteSpeakerRemotely,
  };
}
