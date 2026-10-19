/** ANSI escape sequences (CSI, OSC, and two-byte ESC), for a plain-text log. */
// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Everything written into the monitor this session (device output as shown, with
 * timestamps and the flasher's notes), for Save log (SPEC §8). Capped: the oldest chunks go
 * first beyond `max` bytes.
 */
export class SessionLog {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private enc = new TextEncoder();

  constructor(private max = 32 * 1024 * 1024) {}

  push(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? this.enc.encode(data) : data.slice();
    this.chunks.push(bytes);
    this.size += bytes.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  /** The log as text: with its escape codes (`ansi`), or plain. */
  text(ansi: boolean): string {
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    const text = new TextDecoder().decode(all);
    return ansi ? text : stripAnsi(text).replace(/\r\n/g, '\n');
  }
}
