/** Stateful mono PCM16LE resampling with a windowed-sinc anti-alias filter. */
export class Pcm16Resampler {
  private samples: number[] = [];
  private offset = 0;
  private total = 0;
  private produced = 0;
  private pendingByte: number | undefined;
  private readonly radius = 32;

  constructor(private readonly inputRate: number, private readonly outputRate: number) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) {
      throw new Error("Audio sample rates must be positive integers");
    }
  }

  process(chunk: Buffer): Buffer {
    let i = 0;
    if (this.pendingByte !== undefined && chunk.length) {
      const value = this.pendingByte | (chunk[0]! << 8);
      this.samples.push(value >= 32768 ? value - 65536 : value);
      this.total++;
      this.pendingByte = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) {
      this.samples.push(chunk.readInt16LE(i));
      this.total++;
    }
    if (i < chunk.length) this.pendingByte = chunk[i];
    return this.render(false);
  }

  /** Finish one response; no audio history carries into the next response. */
  flush(): Buffer {
    const result = this.render(true);
    this.reset();
    return result;
  }

  reset(): void {
    this.samples = [];
    this.offset = this.total = this.produced = 0;
    this.pendingByte = undefined;
  }

  private render(final: boolean): Buffer {
    const out: number[] = [];
    const count = Math.round(this.total * this.outputRate / this.inputRate);
    const cutoff = Math.min(1, this.outputRate / this.inputRate) * 0.94;
    while (this.produced < count) {
      const position = this.produced * this.inputRate / this.outputRate;
      if (!final && Math.floor(position) + this.radius >= this.total) break;
      let value = 0;
      let weight = 0;
      for (let index = Math.ceil(position - this.radius); index <= Math.floor(position + this.radius); index++) {
        const distance = index - position;
        const x = Math.PI * distance * cutoff;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius);
        const coefficient = sinc * window * cutoff;
        const bounded = Math.max(0, Math.min(this.total - 1, index));
        value += (this.samples[bounded - this.offset] ?? 0) * coefficient;
        weight += coefficient;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(value / weight))));
      this.produced++;
    }
    const keepFrom = Math.max(0, Math.floor(this.produced * this.inputRate / this.outputRate) - this.radius);
    const discard = Math.min(this.samples.length, keepFrom - this.offset);
    if (discard > 0) {
      this.samples.splice(0, discard);
      this.offset += discard;
    }
    const result = Buffer.alloc(out.length * 2);
    out.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
  }
}
