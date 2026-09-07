import { Pcm16Resampler } from "./pcm-resampler.js";

export const INKBOX_HD_AUDIO_FORMAT = "pcm_s16le_16000";

function decodeMulaw(byte: number): number {
  const value = ~byte & 255;
  const sample = ((((value & 15) << 3) + 132) << ((value >> 4) & 7)) - 132;
  return value & 128 ? -sample : sample;
}
function encodeMulaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0;
  const magnitude = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((magnitude >> (exponent + 3)) & 15)) & 255;
}

/** One call's negotiated wire format; the realtime bridge always uses PCM24. */
export class RealtimeCallAudio {
  private hd = true;
  private input = new Pcm16Resampler(16000, 24000);
  private output = new Pcm16Resampler(24000, 16000);

  get bytesPerSecond(): number { return this.hd ? 32000 : 8000; }

  configure(format: unknown): void {
    const descriptor = format as { encoding?: unknown; sample_rate?: unknown; channels?: unknown } | undefined;
    const hd = descriptor?.encoding === "L16" && descriptor.sample_rate === 16000 && descriptor.channels === 1;
    const legacy = !descriptor || (descriptor.encoding === "PCMU" && descriptor.sample_rate === 8000 && descriptor.channels === 1);
    if (!hd && !legacy) throw new Error("Unsupported call audio format");
    this.hd = hd;
    this.input = new Pcm16Resampler(hd ? 16000 : 8000, 24000);
    this.output = new Pcm16Resampler(24000, hd ? 16000 : 8000);
  }

  inputAudio(audio: Buffer): Buffer {
    if (this.hd) return this.input.process(audio);
    const pcm = Buffer.alloc(audio.length * 2);
    audio.forEach((byte, i) => pcm.writeInt16LE(decodeMulaw(byte), i * 2));
    return this.input.process(pcm);
  }

  outputAudio(audio: Buffer): Buffer { return this.encode(this.output.process(audio)); }
  finishOutput(): Buffer { return this.encode(this.output.flush()); }
  clearOutput(): void { this.output.reset(); }

  private encode(pcm: Buffer): Buffer {
    if (this.hd) return pcm;
    const audio = Buffer.alloc(pcm.length / 2);
    for (let i = 0; i < audio.length; i++) audio[i] = encodeMulaw(pcm.readInt16LE(i * 2));
    return audio;
  }
}
