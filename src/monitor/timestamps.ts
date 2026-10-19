const enc = new TextEncoder();

/** `12:34:56.789` in local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Prefixes each received line with the time its first byte arrived (SPEC §8), dimmed. Runs
 * after the log colorizer, so that one still sees `E (` at the start of a line.
 */
export class Timestamper {
  private atLineStart = true;

  constructor(private now: () => number = () => Date.now()) {}

  push(bytes: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (const b of bytes) {
      if (this.atLineStart && b !== 0x0a && b !== 0x0d) {
        out.push(...enc.encode(`\x1b[0;90m${clock(this.now())}\x1b[0m `));
        this.atLineStart = false;
      }
      out.push(b);
      if (b === 0x0a) this.atLineStart = true;
    }
    return Uint8Array.from(out);
  }

  reset(): void {
    this.atLineStart = true;
  }
}
