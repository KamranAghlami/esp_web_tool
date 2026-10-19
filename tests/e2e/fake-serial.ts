/**
 * Injected before the app loads: replaces navigator.serial with a fake device that behaves
 * like Chrome's gate: requestPort() rejects unless the page has transient user activation.
 *
 * Behind the port sits the simulated ESP32-S3 (tests/fake-esp.ts, injected by the harness as
 * `window.__createFakeEsp`): its app echoes input, and esptool-js can flash it. Test hooks:
 * - `__serialWritten`: text written while the app runs; `__serialEmit(s)`: device output
 * - `__serialSignals`: control-line changes as "DTR,RTS" pairs of 0/1
 * - `__serialOpen`: the options of each open(); `__esp`: the simulated chip
 * - `__serialUnplug()` / `__serialReplug()`: the board goes away / comes back (as a new port)
 */
export function installFakeSerial(): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  type Esp = {
    write(b: Uint8Array): void;
    signals(dtr: boolean, rts: boolean): void;
    output: (b: Uint8Array) => void;
    mode: string;
  };
  const w = window as unknown as {
    __serialWritten: string;
    __serialRequests: { activation: boolean }[];
    __serialEmit: (s: string) => void;
    __serialSignals: string[];
    __serialOpen: Record<string, unknown>[];
    __serialUnplug: () => void;
    __serialReplug: () => void;
    __esp: Esp;
    __md5: (b: Uint8Array) => string;
    __createFakeEsp: (
      md5: (b: Uint8Array) => string,
      inflate: (b: Uint8Array) => Promise<Uint8Array>,
    ) => Esp;
  };
  w.__serialOpen = [];
  w.__serialWritten = '';
  w.__serialSignals = [];
  w.__serialRequests = [];

  const inflate = async (data: Uint8Array) => {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const esp = w.__createFakeEsp(w.__md5, inflate);
  w.__esp = esp;

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null;
    writable: WritableStream<Uint8Array> | null = null;
    gone = false;
    private dtr = false;
    private rts = false;

    getInfo() {
      return { usbVendorId: 0x303a, usbProductId: 0x1001 };
    }

    async open(opts: Record<string, unknown>) {
      if (this.gone) throw new DOMException('The device has been lost.', 'NetworkError');
      if (this.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
      w.__serialOpen.push(opts);
      this.readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          esp.output = (b) => {
            try {
              c.enqueue(b);
            } catch {
              // closed
            }
          };
          if (esp.mode === 'app') c.enqueue(enc.encode('I (312) main: hello from fake port\r\n'));
        },
      });
      this.writable = new WritableStream<Uint8Array>({
        write: (chunk) => {
          if (esp.mode === 'app') w.__serialWritten += dec.decode(chunk);
          esp.write(chunk);
        },
      });
      w.__serialEmit = (s) => esp.output(enc.encode(s));
    }

    async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
      this.dtr = s.dataTerminalReady ?? this.dtr;
      this.rts = s.requestToSend ?? this.rts;
      w.__serialSignals.push(`${+this.dtr},${+this.rts}`);
      esp.signals(this.dtr, this.rts);
    }

    async close() {
      this.readable = null;
      this.writable = null;
      esp.output = () => {};
    }
  }

  class FakeSerial extends EventTarget {
    private port: FakePort | null = null;

    requestPort(): Promise<FakePort> {
      const activation = navigator.userActivation.isActive;
      w.__serialRequests.push({ activation });
      if (!activation) {
        return Promise.reject(
          new DOMException(
            'Must be handling a user gesture to show a permission request.',
            'SecurityError',
          ),
        );
      }
      this.port ??= new FakePort();
      return Promise.resolve(this.port);
    }

    async getPorts() {
      return this.port && !this.port.gone ? [this.port] : [];
    }

    unplug() {
      const port = this.port;
      if (!port) return;
      port.gone = true;
      void port.close();
      const e = new Event('disconnect');
      Object.defineProperty(e, 'target', { value: port });
      this.dispatchEvent(e);
    }

    /** A re-enumerated device is a new SerialPort object with the same ids. */
    replug() {
      const port = new FakePort();
      this.port = port;
      const e = new Event('connect');
      Object.defineProperty(e, 'target', { value: port });
      this.dispatchEvent(e);
    }
  }

  const serial = new FakeSerial();
  w.__serialUnplug = () => serial.unplug();
  w.__serialReplug = () => serial.replug();
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
}
