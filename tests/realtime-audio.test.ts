import { describe, expect, it } from "vitest";
import { RealtimeCallAudio } from "../src/realtime-audio.js";

const hd = { encoding: "L16", sample_rate: 16000, channels: 1 };

describe("call audio negotiation", () => {
  it("bridges negotiated HD PCM in both directions at the correct duration", () => {
    const audio = new RealtimeCallAudio();
    audio.configure(hd);
    expect(audio.bytesPerSecond).toBe(32000);
    const input = audio.inputAudio(Buffer.alloc(3200));
    expect(input.length).toBeGreaterThan(4600);
    expect(input.length).toBeLessThanOrEqual(4800);
    const output = Buffer.concat([audio.outputAudio(Buffer.alloc(4800)), audio.finishOutput()]);
    expect(output).toEqual(Buffer.alloc(3200));
  });
  it.each([undefined, { encoding: "PCMU", sample_rate: 8000, channels: 1 }])("supports old call endpoints with format %j", (format) => {
    const audio = new RealtimeCallAudio();
    audio.configure(format);
    expect(audio.bytesPerSecond).toBe(8000);
    expect(audio.inputAudio(Buffer.alloc(800, 255)).every((byte) => byte === 0)).toBe(true);
    expect(Buffer.concat([audio.outputAudio(Buffer.alloc(4800)), audio.finishOutput()])).toEqual(Buffer.alloc(800, 255));
  });
  it("rejects unsupported descriptors rather than playing the wrong codec", () => {
    const audio = new RealtimeCallAudio();
    expect(() => audio.configure({ encoding: "L16", sample_rate: 8000, channels: 1 })).toThrow("Unsupported call audio format");
    expect(() => audio.configure({ ...hd, channels: 2 })).toThrow();
  });
  it("discards interrupted response history", () => {
    const audio = new RealtimeCallAudio();
    audio.configure(hd);
    audio.outputAudio(Buffer.alloc(4800, 63));
    audio.clearOutput();
    expect(Buffer.concat([audio.outputAudio(Buffer.alloc(4800)), audio.finishOutput()])).toEqual(Buffer.alloc(3200));
  });
});
