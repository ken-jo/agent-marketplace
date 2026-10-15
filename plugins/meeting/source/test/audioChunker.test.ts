/**
 * Cutting host-captured audio into chunks.
 *
 * The rules moved here from the recorder renderer unchanged, so the cases
 * below are about the rules rather than about the port: when a cut happens,
 * what a forced cut leaves behind for the next one, and whether the timestamps
 * a chunk carries actually describe the audio inside it.
 *
 * That last one is the quiet one. A chunk with wrong `startSec`/`endSec` still
 * transcribes fine and lands in the transcript at the wrong time, which reads
 * as a transcription problem for as long as nobody checks the arithmetic.
 */
import { describe, expect, it } from "vitest";
import { createAudioChunker } from "../src/hostPlugin.js";

const RATE = 16_000;
/** Frame length the plugin asks the host for. */
const FRAME_MS = 50;
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000;

/** One frame of int16 PCM, every sample the same value. */
function frame(value = 1000, samples = FRAME_SAMPLES): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true);
  return bytes;
}

const LOUD = 0.5;
const QUIET = 0.001;

/** Feed `count` frames and collect whatever chunks came out. */
function feed(
  chunker: ReturnType<typeof createAudioChunker>,
  count: number,
  peak: number,
  value = 1000,
) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(...chunker.push(frame(value), peak));
  return out;
}

describe("createAudioChunker", () => {
  it("does not cut before the minimum, however quiet it gets", () => {
    const chunker = createAudioChunker(RATE);
    // 1s of silence: well past the 0.5s silence tail, well short of the 2s
    // minimum. Cutting here would ship a chunk of nothing.
    expect(feed(chunker, 20, QUIET)).toEqual([]);
  });

  it("cuts on trailing silence once past the minimum, and consumes everything", () => {
    const chunker = createAudioChunker(RATE);
    feed(chunker, 40, LOUD);            // 2s of speech — at the minimum
    const chunks = feed(chunker, 10, QUIET);  // 0.5s of silence — the tail

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks[0]!.endSec).toBeCloseTo(2.5, 5);
    // A silence cut consumes the whole buffer, so the next chunk starts where
    // this one ended rather than repeating its tail.
    const next = feed(chunker, 40, LOUD);
    expect(next).toEqual([]);
    expect(chunker.final()!.startSec).toBeCloseTo(2.5, 5);
  });

  it("force-cuts at the maximum and leaves the overlap for the next chunk", () => {
    const chunker = createAudioChunker(RATE);
    const chunks = feed(chunker, 120, LOUD);  // 6s with no pause at all

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.endSec).toBeCloseTo(6, 5);
    // The next chunk RE-INCLUDES the last half second. A forced cut lands
    // mid-syllable, and the overlap is what lets the pipeline stitch the word
    // back together — so the next chunk must start BEFORE this one ended.
    const final = chunker.final()!;
    expect(final.startSec).toBeCloseTo(5.5, 5);
  });

  it("carries as many bytes as its timestamps claim", () => {
    const chunker = createAudioChunker(RATE);
    feed(chunker, 40, LOUD);
    const [chunk] = feed(chunker, 10, QUIET);

    // Two bytes per sample. A chunk whose duration and byte count disagree
    // transcribes fine and lands at the wrong time in the transcript, which
    // reads as an STT problem for as long as nobody checks this.
    const seconds = chunk!.endSec - chunk!.startSec;
    expect(chunk!.pcm16leMono.byteLength).toBe(Math.round(seconds * RATE) * 2);
  });

  it("preserves the samples byte for byte, little-endian", () => {
    const chunker = createAudioChunker(RATE);
    feed(chunker, 40, LOUD, -1234);
    const [chunk] = feed(chunker, 10, QUIET, -1234);

    // A sign or endianness mistake here is silence-shaped noise, not an error.
    expect(chunk!.pcm16leMono.readInt16LE(0)).toBe(-1234);
    expect(chunk!.pcm16leMono.readInt16LE(chunk!.pcm16leMono.byteLength - 2)).toBe(-1234);
  });

  it("hands back the tail on final(), then nothing", () => {
    const chunker = createAudioChunker(RATE);
    feed(chunker, 20, LOUD);            // 1s — below the minimum

    const tail = chunker.final()!;
    expect(tail.endSec).toBeCloseTo(1, 5);
    // Without this the last second of every meeting would be dropped, because
    // a recording rarely ends on a chunk boundary.
    expect(chunker.final()).toBeNull();
  });

  it("resets the silence run when sound returns", () => {
    const chunker = createAudioChunker(RATE);
    feed(chunker, 40, LOUD);
    feed(chunker, 8, QUIET);            // 0.4s — not yet a tail
    feed(chunker, 1, LOUD);             // someone speaks again
    const chunks = feed(chunker, 8, QUIET);  // 0.4s again — still not a tail

    // Two short pauses are not one long one. Without the reset, a chunk would
    // be cut in the middle of the sentence that resumed.
    expect(chunks).toEqual([]);
  });

  it("accepts a frame whose bytes are not two-aligned in their buffer", () => {
    const chunker = createAudioChunker(RATE);
    // A `Uint8Array` decoded from base64 can start at any offset. Reading it
    // as an `Int16Array` view would throw on an odd one; the DataView path
    // does not, and this is the case that proves which one is in use.
    const backing = new Uint8Array(FRAME_SAMPLES * 2 + 1);
    const view = new DataView(backing.buffer, 1, FRAME_SAMPLES * 2);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) view.setInt16(i * 2, 777, true);
    const misaligned = new Uint8Array(backing.buffer, 1, FRAME_SAMPLES * 2);

    expect(() => chunker.push(misaligned, LOUD)).not.toThrow();
    expect(chunker.final()!.pcm16leMono.readInt16LE(0)).toBe(777);
  });
});
