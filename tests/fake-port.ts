import { md5 } from '../src/flash/md5';
import { createFakeEsp, type FakeEsp } from './fake-esp';

/** Inflate zlib data with the platform's DecompressionStream (Node and Chrome). */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A Web Serial port in Node, wired to a simulated ESP32-S3 (unit tests of the flasher). */
export class FakeEspPort {
  readonly esp: FakeEsp = createFakeEsp(md5, inflate);
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens: number[] = [];
  private dtr = false;
  private rts = false;

  constructor(private info = { usbVendorId: 0x303a, usbProductId: 0x1001 }) {}

  getInfo() {
    return this.info;
  }

  async open(opts: { baudRate: number }) {
    if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
    this.opens.push(opts.baudRate);
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.esp.output = (b) => {
          try {
            c.enqueue(b);
          } catch {
            // closed
          }
        };
      },
      cancel: () => {
        this.esp.output = () => {};
      },
    });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => this.esp.write(chunk) });
  }

  async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
    this.dtr = s.dataTerminalReady ?? this.dtr;
    this.rts = s.requestToSend ?? this.rts;
    this.esp.signals(this.dtr, this.rts);
  }

  async close() {
    this.readable = null;
    this.writable = null;
    this.esp.output = () => {};
  }
}
