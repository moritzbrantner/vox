import type { TranscriptSegment } from "@stutter-tracker/shared";
import { Fragment } from "react";

export const TIMING_NOT_ALIGNED = "timing not aligned";

/**
 * The verbatim transcript inline. Consecutive unaligned segments (vox#26, owner answer Q4 A) get
 * a muted dotted underline and one "timing not aligned" mark, never a time.
 */
export function TranscriptText({ segments }: { segments: TranscriptSegment[] }) {
  const runs: { unaligned: boolean; text: string }[] = [];
  for (const segment of segments) {
    const unaligned = segment.alignment === "unaligned";
    const last = runs.at(-1);
    if (last && last.unaligned === unaligned) {
      last.text = `${last.text} ${segment.text}`;
    } else {
      runs.push({ unaligned, text: segment.text });
    }
  }
  return (
    <>
      {runs.map((run, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          {run.unaligned ? (
            <span data-alignment="unaligned">
              <span className="underline decoration-[#9aa59f] decoration-dotted underline-offset-4">
                {run.text}
              </span>{" "}
              <span className="align-middle text-xs whitespace-nowrap text-[#7b8780]">
                ({TIMING_NOT_ALIGNED})
              </span>
            </span>
          ) : (
            run.text
          )}
        </Fragment>
      ))}
    </>
  );
}
