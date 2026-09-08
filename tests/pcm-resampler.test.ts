import { describe, expect, it } from "vitest";
import { Pcm16Resampler } from "../src/pcm-resampler.js";

function tone(rate: number, frequency: number, seconds = 0.1): Buffer {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), i * 2);
  return pcm;
}
function convert(input: Buffer, from: number, to: number, chunk = input.length): Buffer {
  const resampler = new Pcm16Resampler(from, to);
  const pieces: Buffer[] = [];
  for (let i = 0; i < input.length; i += chunk) pieces.push(resampler.process(input.subarray(i, i + chunk)));
  pieces.push(resampler.flush());
  return Buffer.concat(pieces);
}
function rms(pcm: Buffer): number {
  let sum = 0;
  const start = 100, end = pcm.length / 2 - 100;
  for (let i = start; i < end; i++) sum += pcm.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / (end - start));
}

describe("streaming PCM16 resampler", () => {
  it.each([[16000, 24000], [24000, 16000], [8000, 24000], [24000, 8000]])("preserves duration and byte-fragmented phase %i to %i", (from, to) => {
    const input = tone(from, 1000);
    const whole = convert(input, from, to);
    expect(whole.length).toBe(Math.round(input.length / 2 * to / from) * 2);
    expect(convert(input, from, to, 137)).toEqual(whole);
    expect(rms(whole)).toBeGreaterThan(8000);
    expect(rms(whole)).toBeLessThan(9000);
  });
  it("retains wideband speech frequencies and suppresses downsampling aliases", () => {
    expect(rms(convert(tone(24000, 6000), 24000, 16000))).toBeGreaterThan(7800);
    expect(rms(convert(tone(24000, 10000), 24000, 16000))).toBeLessThan(150);
  });
  it("reset and flush isolate responses including incomplete samples", () => {
    const converter = new Pcm16Resampler(24000, 16000);
    converter.process(tone(24000, 1000));
    converter.process(Buffer.from([255]));
    converter.reset();
    const silence = Buffer.alloc(4800);
    expect(Buffer.concat([converter.process(silence), converter.flush()])).toEqual(Buffer.alloc(3200));
    expect(Buffer.concat([converter.process(silence), converter.flush()])).toEqual(Buffer.alloc(3200));
  });
});
