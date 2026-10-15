/**
 * computePeaksFromPCM — extracts per-100ms peak amplitudes from a
 * PCM16LE Buffer. Drives the floating recorder waveform.
 *
 * Boundary math regressions are easy to introduce here (off-by-one on
 * the window slide, wrong byte/sample conversion, partial-window leak)
 * so this test pins the expected behaviour.
 */
import { describe, it, expect } from "vitest";
import { computePeaksFromPCM } from "../src/hostPlugin.js";

/** Build a PCM16LE buffer from an array of int16 sample values. */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("computePeaksFromPCM", () => {
  it("returns one peak per fully-filled window, dropping any partial tail", () => {
    // window = 4 samples → 8 bytes. 10 samples in → exactly 2 full windows + 2 leftover.
    const buf = pcm([100, 200, 300, 400,  50, 150, 250, 350,  10, 20]);
    const peaks = computePeaksFromPCM(buf, 4);
    expect(peaks).toHaveLength(2);
  });

  it("normalises peak to [0, 1] against int16 range (32768)", () => {
    // Peak of 32768 (max-magnitude negative sample) → ~1.0.
    const buf = pcm([0, -32768, 0, 0]);
    const peaks = computePeaksFromPCM(buf, 4);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBeCloseTo(1.0, 5);
  });

  it("uses absolute value (negative peak is treated like positive)", () => {
    const buf = pcm([0, 0, -10000, 0]);
    const peaks = computePeaksFromPCM(buf, 4);
    expect(peaks[0]).toBeCloseTo(10000 / 32768, 5);
  });

  it("returns empty array for buffer shorter than one window", () => {
    const buf = pcm([1, 2, 3]); // 3 samples < 4-sample window
    expect(computePeaksFromPCM(buf, 4)).toEqual([]);
  });

  it("returns empty array for an empty buffer", () => {
    expect(computePeaksFromPCM(Buffer.alloc(0), 4)).toEqual([]);
  });

  it("returns empty array for non-positive or non-finite window sizes", () => {
    const buf = pcm([1, 2, 3, 4]);
    expect(computePeaksFromPCM(buf, 0)).toEqual([]);
    expect(computePeaksFromPCM(buf, -1)).toEqual([]);
    expect(computePeaksFromPCM(buf, Number.NaN)).toEqual([]);
    expect(computePeaksFromPCM(buf, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("silent buffer produces zero peaks (per window) — not empty", () => {
    const buf = pcm([0, 0, 0, 0,  0, 0, 0, 0]);
    const peaks = computePeaksFromPCM(buf, 4);
    expect(peaks).toEqual([0, 0]);
  });

  it("100ms @ 16kHz mono = 1600 samples = 3200 bytes per window", () => {
    // Sanity check the production parameters: a 1-second buffer at 16kHz
    // mono should produce exactly 10 peak windows of 100ms each.
    const samples = new Array(16_000).fill(0).map((_, i) => (i % 2 ? 5000 : -5000));
    const buf = pcm(samples);
    const peaks = computePeaksFromPCM(buf, 1600);
    expect(peaks).toHaveLength(10);
    for (const p of peaks) expect(p).toBeCloseTo(5000 / 32768, 5);
  });

  it("partial trailing samples are not consumed (caller's accumulator owns them)", () => {
    // 5 samples with window=4 → 1 full window, 1 sample remainder.
    // computePeaksFromPCM only reports the full window; the caller is
    // responsible for buffering byte 4×2..end for the next call.
    const buf = pcm([0, 0, 100, 0,  9999]);
    const peaks = computePeaksFromPCM(buf, 4);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBeCloseTo(100 / 32768, 5);
  });
});

describe("computePeaksFromPCM — ring buffer integration shape", () => {
  it("calling repeatedly with non-aligned chunks drops trailing partials each call", () => {
    // Reflects how stdout's `data` events arrive — Node may split a
    // Python publish across multiple chunks. Each call to
    // computePeaksFromPCM only consumes whole windows; the caller MUST
    // re-buffer the trailing partial. Verify the per-call boundary.
    const a = pcm([0, 100, 0, 0,  1000, 2000, 3000]); // 7 samples = 1 full window of 4 + 3 trailing
    const b = pcm([4000,  0, 0, 0, 0,  500, 600]);     // start with that 4th sample to complete the second window
    const aPeaks = computePeaksFromPCM(a, 4);
    expect(aPeaks).toHaveLength(1);
    // If caller naively concatenates leftover (3 from a) + b (7) = 10 samples
    // → 2 full windows. Verify computePeaks consumes exactly 2.
    const leftover = a.subarray(4 * 2);
    const merged = Buffer.concat([leftover, b]);
    const mergedPeaks = computePeaksFromPCM(merged, 4);
    expect(mergedPeaks).toHaveLength(2);
  });
});
