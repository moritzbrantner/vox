// Entry of `bench/runtime-budgets.html`, driven by `scripts/runtime-budgets.ts` in a real browser.
// Recordings are fetched from `/__uclass/<id>.wav`, which the driver serves from the local corpus.
import { type BenchRecording, runBrowserWorkflows } from "./runtimeBudgets";

type Item = { id: string; segments: BenchRecording["segments"] };

function readWav(buffer: ArrayBuffer): { sampleRate: number; samples: Float32Array } {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (tag(offset) === "data") {
      const count = Math.floor(size / 2 / channels);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          sum += view.getInt16(offset + 8 + (index * channels + channel) * 2, true) / 32_768;
        }
        samples[index] = sum / channels;
      }
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV without data");
}

declare global {
  interface Window {
    voxBench: {
      run(items: Item[], chunkSeconds: number): ReturnType<typeof runBrowserWorkflows>;
    };
    /** Exposed by the driver: records CPU and heap metrics at a workflow boundary. */
    voxBenchMark?: (name: string) => Promise<void>;
  }
}

window.voxBench = {
  run(items, chunkSeconds) {
    return runBrowserWorkflows(
      items.length,
      async (index) => {
        const item = items[index];
        const response = await fetch(`/__uclass/${encodeURIComponent(item.id)}.wav`);
        if (!response.ok) throw new Error(`no audio for ${item.id}`);
        return { id: item.id, segments: item.segments, ...readWav(await response.arrayBuffer()) };
      },
      { chunkSeconds, mark: (name) => window.voxBenchMark?.(name) },
    );
  },
};
