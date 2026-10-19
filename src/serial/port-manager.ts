/**
 * Single owner of the SerialPort (SPEC §9): connect, raw monitor I/O, baud and format
 * changes, reset/boot signalling, lending the port to the flasher (`acquire`/`release`), and
 * following a board that re-enumerates or is plugged back in.
 */

/** `busy`: lent to the flasher; the port stays selected but the monitor is closed. */
export type PortState = 'unsupported' | 'none' | 'opening' | 'open' | 'busy' | 'error';

export interface PortEvents {
  onData(bytes: Uint8Array): void;
  onState(state: PortState, detail?: string): void;
}

export function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function describePort(port: SerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId === undefined) return 'serial port';
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(4, '0');
  return `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sameIds = (a: SerialPortInfo, b: SerialPortInfo) =>
  a.usbVendorId !== undefined &&
  a.usbVendorId === b.usbVendorId &&
  a.usbProductId === b.usbProductId;

/** Frame formats offered in the monitor menu: data bits, parity (N/E/O), stop bits. */
export const FORMATS = ['8N1', '8E1', '8O1', '8N2', '7E1', '7O1', '7N1'] as const;
export type Format = (typeof FORMATS)[number];

const PARITY = { N: 'none', E: 'even', O: 'odd' } as const;

export function formatOptions(f: Format): Pick<SerialOptions, 'dataBits' | 'parity' | 'stopBits'> {
  return {
    dataBits: f[0] === '7' ? 7 : 8,
    parity: PARITY[f[1] as keyof typeof PARITY],
    stopBits: f[2] === '2' ? 2 : 1,
  };
}

/** `8N1   8 data, no parity, 1 stop` (for menus). */
export function describeFormat(f: Format): string {
  const { dataBits, parity, stopBits } = formatOptions(f);
  return `${f}   ${dataBits} data, ${parity === 'none' ? 'no' : parity} parity, ${stopBits} stop`;
}

const ESPRESSIF_VID = 0x303a;
const USB_JTAG_PID = 0x1001;

export class PortManager {
  port: SerialPort | null = null;
  baudRate = 115200;
  format: Format = '8N1';
  state: PortState = serialSupported() ? 'none' : 'unsupported';
  /** Bytes written to the device so far (for the tx rate). */
  bytesOut = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private encoder = new TextEncoder();
  /**
   * The USB ids of a board that went away without the user disconnecting it: when a port
   * with the same ids comes back (a native-USB reset, or a replug), it is reopened.
   */
  private awaiting: SerialPortInfo | null = null;

  constructor(private events: PortEvents) {
    if (!serialSupported()) return;
    navigator.serial.addEventListener('disconnect', (e) => {
      const port = this.port;
      if (!port || e.target !== port) return;
      const info = port.getInfo();
      this.reader = null;
      if (this.state === 'busy') return; // the flasher fails on its own; release() follows the board
      this.port = null;
      this.awaiting = info.usbVendorId === undefined ? null : info;
      this.setState(
        'none',
        this.awaiting ? 'device unplugged, waiting for it' : 'device unplugged',
      );
    });
    navigator.serial.addEventListener('connect', (e) => {
      const port = e.target as SerialPort;
      if (this.awaiting && !this.port && sameIds(port.getInfo(), this.awaiting)) {
        this.awaiting = null;
        void this.open(port).then(
          () => this.events.onState('open', 'reconnected'),
          () => {},
        );
      }
    });
  }

  private setState(s: PortState, detail?: string): void {
    this.state = s;
    this.events.onState(s, detail);
  }

  /**
   * Must be called synchronously from an input handler: requestPort() needs the transient
   * user activation of the key press or click that triggered it (SPEC §3.1).
   */
  request(): Promise<SerialPort> {
    return navigator.serial.requestPort();
  }

  async open(port: SerialPort, baudRate = this.baudRate): Promise<void> {
    await this.close(false);
    this.port = port;
    this.baudRate = baudRate;
    this.setState('opening');
    try {
      await port.open({ baudRate, bufferSize: 64 * 1024, ...formatOptions(this.format) });
    } catch (err) {
      this.port = null;
      this.setState('error', errorText(err));
      throw err;
    }
    this.setState('open');
    this.readLoop = this.pump(port);
  }

  private async pump(port: SerialPort): Promise<void> {
    while (port.readable && this.port === port) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.events.onData(value);
        }
      } catch {
        // A framing/parity/buffer-overrun error ends this reader; loop to get a new one.
      } finally {
        reader.releaseLock();
      }
      if (this.reader !== reader) break; // close() cancelled us
    }
  }

  /** Close the port; `forget` (the user disconnected) also stops waiting for it to return. */
  async close(forget = true): Promise<void> {
    if (forget) this.awaiting = null;
    const port = this.port;
    if (!port) return;
    this.port = null;
    await this.stop(port);
    this.setState('none');
  }

  /** Stop the reader and close the port, keeping it selected. */
  private async stop(port: SerialPort): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    try {
      await reader?.cancel();
    } catch {
      // already gone
    }
    await this.readLoop?.catch(() => {});
    this.readLoop = null;
    try {
      await port.close();
    } catch {
      // already closed or unplugged
    }
  }

  /** Lend the port to the flasher: the monitor stops and the port is closed for it to open. */
  async acquire(): Promise<SerialPort> {
    const port = this.port;
    if (!port || this.state !== 'open') throw new Error('No port is open');
    await this.stop(port);
    this.setState('busy');
    return port;
  }

  /**
   * Take the port back and reopen the monitor, then optionally reset the chip into its app.
   * A native-USB chip may have re-enumerated meanwhile: then the same USB ids are looked up
   * with getPorts() (no gesture needed) for up to `waitMs`.
   */
  async release(opts: { reset: boolean; baudRate?: number; waitMs?: number }): Promise<void> {
    const port = this.port;
    if (!port || this.state !== 'busy') return;
    if (opts.baudRate) this.baudRate = opts.baudRate;
    this.port = null;
    if (!(await this.reopen(port, opts.waitMs ?? 6000))) {
      this.setState('none', 'the board did not come back after flashing');
      return;
    }
    if (opts.reset) await this.reset();
  }

  /** Open `port`, or else a port with its USB ids once one (re)appears. */
  private async reopen(port: SerialPort, waitMs: number): Promise<boolean> {
    const info = port.getInfo();
    const until = Date.now() + waitMs;
    for (let candidates = [port]; ;) {
      for (const p of candidates) {
        try {
          await this.open(p);
          return true;
        } catch {
          // stale object of a re-enumerated device, or not back yet
        }
      }
      if (Date.now() > until || info.usbVendorId === undefined) return false;
      await sleep(250);
      const ports = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
      candidates = ports.filter((p) => sameIds(p.getInfo(), info));
    }
  }

  async setBaud(baudRate: number): Promise<void> {
    const port = this.port;
    this.baudRate = baudRate;
    if (port) await this.open(port, baudRate);
  }

  async setFormat(format: Format): Promise<void> {
    const port = this.port;
    this.format = format;
    if (port) await this.open(port, this.baudRate);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const w = this.port?.writable?.getWriter();
    if (!w) return;
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    this.bytesOut += bytes.length;
    try {
      await w.write(bytes);
    } finally {
      w.releaseLock();
    }
  }

  /**
   * Espressif's built-in USB-Serial/JTAG controller (C3, C5, C6, H2, P4, S3 native USB). It
   * maps DTR/RTS onto reset and boot strapping itself, and needs its own sequences.
   */
  get usbJtag(): boolean {
    const info = this.port?.getInfo();
    return info?.usbVendorId === ESPRESSIF_VID && info.usbProductId === USB_JTAG_PID;
  }

  /** Pulse EN via RTS, leaving the chip running its app. */
  async reset(): Promise<void> {
    if (!this.port) return;
    await this.signals(false, false);
    await this.signals(false, true);
    await sleep(this.usbJtag ? 200 : 100);
    await this.signals(false, false);
  }

  /** Reset into the ROM download mode (the sequences esptool uses). */
  async enterBootloader(): Promise<void> {
    if (!this.port) return;
    if (this.usbJtag) {
      // Strap first, then reset. Go through (1,1) rather than (0,0) so reset is never
      // released with the strap dropped.
      await this.signals(false, false);
      await sleep(100);
      await this.signals(true, false);
      await sleep(100);
      await this.signals(true, true);
      await this.signals(false, true);
      await sleep(100);
      await this.signals(false, false);
      return;
    }
    // Classic two-transistor auto-reset circuit: EN low, then IO0 low as EN is released.
    await this.signals(false, true);
    await sleep(100);
    await this.signals(true, false);
    await sleep(50);
    await this.signals(false, false);
  }

  /** Set both lines in one request, so USB adapters see a single control-line change. */
  private signals(dtr: boolean, rts: boolean): Promise<void> {
    return this.port!.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  }
}

export function errorText(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
