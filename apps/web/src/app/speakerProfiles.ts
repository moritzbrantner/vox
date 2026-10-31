import { appStorage } from "../storage/protectedStorage";
// Voiceprints: enrollment and identification calls, and where profiles are stored.
import { invoke } from "@tauri-apps/api/core";
import {
  type SpeakerIdentification,
  type SpeakerProfile,
  type TranscriptSegment,
  type Voiceprint,
} from "../types";
import { SPEAKERS_KEY, VOICE_KEY, computeClient, isDesktopApp } from "./config";

export async function createSpeakerProfile(
  id: string | undefined,
  label: string,
  samples: number[],
  sampleRate: number,
): Promise<SpeakerProfile> {
  if (!isDesktopApp()) {
    return computeClient.createSpeakerProfile({ id, label, samples, sampleRate });
  }
  return invoke<SpeakerProfile>("create_speaker_profile", {
    request: { id, label, samples: decimate(samples), sampleRate },
  });
}

export async function identifySpeaker(
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
): Promise<SpeakerIdentification> {
  if (!speakers.length) {
    return { matches: [], isMatch: false };
  }
  if (!isDesktopApp()) {
    return computeClient.identifySpeaker({
      samples,
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    });
  }
  return invoke<SpeakerIdentification>("identify_speaker", {
    request: {
      samples: decimate(samples),
      sampleRate,
      speakers,
      threshold: 0.82,
      maxResults: 3,
    },
  });
}

export async function identifyTranscriptSpeakers(
  segments: TranscriptSegment[],
  samples: number[],
  sampleRate: number,
  speakers: SpeakerProfile[],
) {
  if (!speakers.length) {
    return segments;
  }
  return Promise.all(
    segments.map(async (segment) => {
      const start = Math.max(0, Math.floor(segment.startSeconds * sampleRate));
      const end = Math.min(samples.length, Math.ceil(segment.endSeconds * sampleRate));
      if (end - start < sampleRate / 4) {
        return segment;
      }
      try {
        const result = await identifySpeaker(samples.slice(start, end), sampleRate, speakers);
        const match = result.bestMatch;
        if (!match) {
          return segment;
        }
        return {
          ...segment,
          speakerId: match.speakerId,
          speakerLabel: match.label,
          speakerScore: match.score,
        };
      } catch {
        return segment;
      }
    }),
  );
}

function decimate(samples: number[]) {
  const maxSamples = 96_000;
  if (samples.length <= maxSamples) {
    return samples;
  }
  const step = Math.ceil(samples.length / maxSamples);
  const result: number[] = [];
  for (let index = 0; index < samples.length; index += step) {
    result.push(samples[index]);
  }
  return result;
}

export function removeLocalSpeakerCopy(id: string) {
  const raw = appStorage().getItem(SPEAKERS_KEY);
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? "[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Corrupt payloads contain no usable local profiles; do not block server deletion.
    stored = [];
  }
  if (Array.isArray(stored)) {
    const kept = stored.filter(
      (candidate: unknown) =>
        !(
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          typeof candidate.id === "string" &&
          speakerProfileStorageId(candidate.id) === speakerProfileStorageId(id)
        ),
    );
    if (kept.length !== stored.length) {
      appStorage().setItem(SPEAKERS_KEY, JSON.stringify(kept));
    }
  }
  // The pre-profile key belongs only to this profile. Absent copies need no write.
  if (id === "legacy-speaker" && appStorage().getItem(VOICE_KEY) !== null) {
    appStorage().removeItem(VOICE_KEY);
  }
}

/** `isStale` turns true after a removal, so the snapshot taken at start is not re-uploaded. */
export async function loadPersistedSpeakerProfiles(
  isStale: () => boolean = () => false,
  migrate: (profiles: SpeakerProfile[]) => Promise<SpeakerProfile[]> = savePersistedSpeakerProfiles,
  fallbackToLocal = true,
): Promise<SpeakerProfile[]> {
  const localSpeakers = loadSpeakerProfiles();
  if (isDesktopApp()) {
    try {
      const speakers = await invoke<SpeakerProfile[]>("load_speaker_profiles");
      if (speakers.length) {
        return normalizeSpeakerProfiles(speakers);
      }
      if (localSpeakers.length && !isStale()) {
        return migrate(localSpeakers);
      }
      return [];
    } catch (error) {
      if (!fallbackToLocal) throw error;
      return localSpeakers;
    }
  }

  try {
    const speakers = await computeClient.listSpeakerProfiles();
    if (speakers.length) {
      return normalizeSpeakerProfiles(speakers);
    }
    if (localSpeakers.length && !isStale()) {
      return migrate(localSpeakers);
    }
    return [];
  } catch (error) {
    if (!fallbackToLocal) throw error;
    return localSpeakers;
  }
}

export async function savePersistedSpeakerProfiles(
  speakers: SpeakerProfile[],
): Promise<SpeakerProfile[]> {
  const normalized = normalizeSpeakerProfiles(speakers);
  if (isDesktopApp()) {
    return invoke<SpeakerProfile[]>("save_speaker_profiles", { speakers: normalized });
  }
  if (computeClient.destination.kind !== "server") {
    // No permitted server: voiceprints stay in this browser.
    appStorage().setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
  try {
    return await computeClient.saveSpeakerProfiles(normalized);
  } catch {
    appStorage().setItem(SPEAKERS_KEY, JSON.stringify(normalized));
    return normalized;
  }
}

export function loadSpeakerProfiles(): SpeakerProfile[] {
  try {
    const speakers = JSON.parse(appStorage().getItem(SPEAKERS_KEY) ?? "[]") as SpeakerProfile[];
    if (Array.isArray(speakers) && speakers.length > 0) {
      return normalizeSpeakerProfiles(speakers);
    }
    const legacy = JSON.parse(appStorage().getItem(VOICE_KEY) ?? "null") as Voiceprint | null;
    if (legacy?.embedding?.length) {
      return [
        {
          id: "legacy-speaker",
          label: "Enrolled speaker",
          embeddings: [legacy.embedding],
          sampleRate: legacy.sampleRate,
          sampleCount: legacy.sampleCount,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/** Native IDs are opaque; only browser/server IDs use the server's canonical form. */
function speakerProfileStorageId(id: string) {
  return isDesktopApp() ? id : id.trim().slice(0, 120);
}

function normalizeSpeakerProfiles(speakers: SpeakerProfile[]) {
  const normalized = new Map<string, SpeakerProfile>();
  for (const speaker of speakers) {
    if (
      typeof speaker.id === "string" &&
      speaker.id.trim().length > 0 &&
      typeof speaker.label === "string" &&
      speaker.label.trim().length > 0 &&
      Array.isArray(speaker.embeddings) &&
      speaker.embeddings.length > 0
    ) {
      const id = speakerProfileStorageId(speaker.id);
      normalized.set(id, { ...speaker, id, label: speaker.label.trim() });
    }
  }
  return [...normalized.values()];
}
