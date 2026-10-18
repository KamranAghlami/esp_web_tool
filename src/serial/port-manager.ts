/**
 * Single owner of the SerialPort (SPEC §9). M0 covers connect, raw monitor I/O, baud
 * changes and reset/boot signalling; flashing hand-off arrives with esptool-js in M1.
 */

export type PortState = 'unsupported' | 'none' | 'opening' | 'open' | 'error';

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

const ESPRESSIF_VID = 0x303a;
const USB_JTAG_PID = 0x1001;

export class PortManager {
  port: SerialPort | null = null;
  baudRate = 115200;
  state: PortState = serialSupported() ? 'none' : 'unsupported';
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private encoder = new TextEncoder();

  constructor(private events: PortEvents) {
    if (serialSupported()) {
      navigator.serial.addEventListener('disconnect', (e) => {
        if (e.target === this.port) {
          this.port = null;
          this.reader = null;
          this.setState('none', 'device unplugged');
        }
      });
    }
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
    await this.close();
    this.port = port;
    this.baudRate = baudRate;
    this.setState('opening');
    try {
      await port.open({ baudRate, bufferSize: 64 * 1024 });
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

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.port = null;
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
    this.setState('none');
  }

  async setBaud(baudRate: number): Promise<void> {
    const port = this.port;
    this.baudRate = baudRate;
    if (port) await this.open(port, baudRate);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const w = this.port?.writable?.getWriter();
    if (!w) return;
    try {
      await w.write(typeof data === 'string' ? this.encoder.encode(data) : data);
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
