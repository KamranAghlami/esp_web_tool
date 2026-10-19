import type { ChipInfo } from '../flash/chip';
import type { EspSession } from '../flash/esp';
import type { PortManager } from '../serial/port-manager';

export type JobKind = 'flash' | 'erase' | 'dump' | 'identify';

/** A running job, drawn as the Flash pane's progress line. */
export interface JobState {
  kind: JobKind;
  /** What is happening now: `Connecting`, `Erasing`, `app.bin`… */
  step: string;
  /** Overall share done (0–1), or null while it can't be told (connecting, erasing). */
  fraction: number | null;
  /** Bytes done and in all, for the rate. */
  bytes: number;
  total: number;
  /** When the current step started (ms), for the rate. */
  since: number;
}

export interface JobResult {
  kind: JobKind;
  ok: boolean;
  text: string;
}

export interface JobHost {
  ports: PortManager;
  /** esptool's own messages (Connecting…, Chip is…) go to the monitor pane. */
  log(text: string): void;
  changed(): void;
  now(): number;
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** esptool errors, with the hint for the common cases (SPEC §5.6). */
export function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to connect/i.test(msg))
    return "Couldn't reach the bootloader: hold BOOT, tap RESET, release BOOT, then try again";
  if (/MD5 of file does not match/i.test(msg))
    return 'Verify failed: what was read back differs. Try a lower flash baud';
  if (/timed? ?out/i.test(msg)) return `${msg}. Try a lower flash baud, or another cable`;
  if (/NetworkError|device has been lost|disconnected/i.test(msg))
    return 'The board went away (unplugged, or it reset on its own)';
  return msg;
}

/**
 * Runs flasher jobs one at a time (SPEC §5.6, §9): borrow the port from the monitor, open an
 * esptool session (reset into the bootloader, detect the chip), do the job, close, and give
 * the port back to the monitor, reset into the app when asked.
 */
export class JobRunner {
  state: JobState | null = null;
  /** The last finished job, shown in the progress line until the next one. */
  last: JobResult | null = null;
  /** What the last session found; cleared when the port changes. */
  chip: ChipInfo | null = null;
  private session: EspSession | null = null;
  private cancelled = false;

  constructor(private host: JobHost) {}

  get running(): boolean {
    return this.state !== null;
  }

  /** Move to the next step of the running job. */
  step(step: string, fraction: number | null, total = 0): void {
    if (!this.state) return;
    Object.assign(this.state, { step, fraction, bytes: 0, total, since: this.host.now() });
    this.host.changed();
  }

  progress(fraction: number, bytes: number): void {
    if (!this.state) return;
    this.state.fraction = fraction;
    this.state.bytes = bytes;
    this.host.changed();
  }

  /**
   * `body` gets the open session and returns the summary for the progress line. `release`
   * says how the monitor takes the port back afterwards (reset into the app, at which baud).
   */
  async run(
    kind: JobKind,
    flashBaud: number,
    release: { reset: boolean; baudRate?: () => number | undefined },
    body: (s: EspSession) => Promise<string>,
  ): Promise<JobResult> {
    const { ports } = this.host;
    this.cancelled = false;
    this.last = null;
    this.state = {
      kind,
      step: 'Connecting',
      fraction: null,
      bytes: 0,
      total: 0,
      since: this.host.now(),
    };
    this.host.changed();
    let result: JobResult;
    try {
      const { EspSession } = await import('../flash/esp');
      const port = await ports.acquire();
      try {
        this.session = await EspSession.connect(port, flashBaud, (t) => this.host.log(t));
        this.chip = this.session.info;
        this.host.changed();
        if (this.cancelled) throw new JobCancelled();
        result = { kind, ok: true, text: await body(this.session) };
      } finally {
        await this.session?.close();
        this.session = null;
        this.step('Back to the monitor', null);
        await ports.release({ reset: release.reset, baudRate: release.baudRate?.() });
      }
    } catch (err) {
      const text = this.cancelled || err instanceof JobCancelled ? 'Cancelled' : explain(err);
      result = { kind, ok: false, text };
    }
    this.state = null;
    this.last = result;
    this.host.changed();
    return result;
  }

  /** Stop the running job: closing the port makes its pending command fail. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.session?.close();
  }

  /** Throw if the job was cancelled while waiting (e.g. on a confirmation). */
  checkCancelled(): void {
    if (this.cancelled) throw new JobCancelled();
  }
}
