/**
 * Colors plain ESP-IDF log lines by level, as `idf.py monitor` does. Recent ESP-IDF builds
 * leave CONFIG_LOG_COLORS off and rely on the monitor for this. Lines that already carry
 * their own escape codes start with ESC, so they never match and pass through untouched.
 *
 * Works on raw bytes as they arrive: a line's first three bytes ("E (") are held until the
 * level is known, and `flush()` releases them if the device goes quiet mid-prefix.
 */

const ESC_COLOR: Record<number, Uint8Array> = {
  0x45: bytes('\x1b[0;31m'), // E
  0x57: bytes('\x1b[0;33m'), // W
  0x49: bytes('\x1b[0;32m'), // I
};
const RESET = bytes('\x1b[0m');
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const PAREN = 0x28;
/** D and V lines are recognised (so they are not mistaken for text) but left uncolored. */
const LEVELS = new Set([0x45, 0x57, 0x49, 0x44, 0x56]);

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export class LogColorizer {
  private lineStart = true;
  private colored = false;
  private held: number[] = [];

  /** Bytes waiting for the rest of a line prefix. */
  get holding(): boolean {
    return this.held.length > 0;
  }

  push(input: Uint8Array): Uint8Array {
    // Worst case: every byte ends a colored line and gets a reset in front of it.
    const out = new Uint8Array(input.length * (RESET.length + 1) + 16);
    let n = 0;
    const put = (b: Uint8Array | number[]) => {
      out.set(b, n);
      n += b.length;
    };

    for (const b of input) {
      if (b === CR || b === LF) {
        if (this.held.length) put(this.release());
        if (this.colored) {
          put(RESET);
          this.colored = false;
        }
        out[n++] = b;
        this.lineStart = true;
        continue;
      }
      if (!this.lineStart) {
        out[n++] = b;
        continue;
      }
      this.held.push(b);
      const [level, space, paren] = this.held;
      const ok =
        LEVELS.has(level!) &&
        (space === undefined || space === SPACE) &&
        (paren === undefined || paren === PAREN);
      if (!ok) {
        put(this.release());
        this.lineStart = false;
      } else if (this.held.length === 3) {
        const color = ESC_COLOR[level!];
        if (color) {
          put(color);
          this.colored = true;
        }
        put(this.release());
        this.lineStart = false;
      }
    }
    return out.subarray(0, n);
  }

  /** Release a held prefix as plain text (the device paused mid-line). */
  flush(): Uint8Array {
    if (!this.held.length) return new Uint8Array(0);
    this.lineStart = false;
    return Uint8Array.from(this.release());
  }

  reset(): void {
    this.lineStart = true;
    this.colored = false;
    this.held = [];
  }

  private release(): number[] {
    const h = this.held;
    this.held = [];
    return h;
  }
}
