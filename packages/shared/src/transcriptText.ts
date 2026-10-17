// Two transcripts with different jobs. The verbatim transcript is the analysis evidence: exactly
// what the recognizer returned, repetitions, fragments and fillers included. The readable
// transcript is a display-only rendering; nothing is ever saved or analyzed from it.
import type { TranscriptSegment } from "./index";

const FILLERS = new Set(["um", "uh", "erm", "hm", "hmm", "äh", "ähm", "eh", "mm"]);

/** The analysis transcript: final and partial segment text exactly as recognized. */
export function verbatimTranscript(segments: TranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join(" ");
}

/**
 * A readable rendering for display only: drops typical fillers, immediately repeated words and
 * sound fragments ("b-b-but" → "but", "wa- water" → "water"). Never feed it to analysis.
 */
export function readableTranscript(segments: TranscriptSegment[]): string {
  const words = verbatimTranscript(segments).split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const bare = normalize(word);
    if (!bare || FILLERS.has(bare)) continue;
    // A trailing-hyphen fragment that starts the next word ("wa-" before "water").
    if (
      word.endsWith("-") &&
      index + 1 < words.length &&
      normalize(words[index + 1]).startsWith(bare)
    )
      continue;
    const cleaned = stripStutteredOnset(word);
    if (kept.length && normalize(kept[kept.length - 1]) === normalize(cleaned)) continue;
    kept.push(cleaned);
  }
  return kept.join(" ");
}

/** "b-b-but" → "but", "w-want" → "want"; hyphenated words like "well-known" stay. */
function stripStutteredOnset(word: string) {
  const match = /^((?:[\p{L}]{1,2}-)+)([\p{L}].*)$/u.exec(word);
  if (!match) return word;
  const fragments = match[1].split("-").filter(Boolean);
  const rest = match[2];
  return fragments.every((fragment) => rest.toLowerCase().startsWith(fragment.toLowerCase()))
    ? rest
    : word;
}

function normalize(word: string) {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}
