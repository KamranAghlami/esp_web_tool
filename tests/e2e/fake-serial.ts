/**
 * Injected before the app loads: replaces navigator.serial with a fake device that behaves
 * like Chrome's gate: requestPort() rejects unless the page has transient user activation.
 * Everything written to the port is recorded in window.__serialWritten and echoed back.
 */
export function installFakeSerial(): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const w = window as unknown as {
    __serialWritten: string;
    __serialRequests: { activation: boolean }[];
    __serialEmit: (s: string) => void;
  };
  w.__serialWritten = '';
  w.__serialRequests = [];

  class FakePort extends EventTarget {
    readable: ReadableStream<Uint8Array> | null = null;
    writable: WritableStream<Uint8Array> | null = null;
    private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

    getInfo() {
      return { usbVendorId: 0x303a, usbProductId: 0x1001 };
    }

    async open(_opts: { baudRate: number }) {
      this.readable = new ReadableStream<Uint8Array>({
        start: (c) => {
          this.ctrl = c;
          c.enqueue(enc.encode('I (312) main: hello from fake port\r\n'));
        },
      });
      this.writable = new WritableStream<Uint8Array>({
        write: (chunk) => {
          const s = dec.decode(chunk);
          w.__serialWritten += s;
          this.ctrl?.enqueue(enc.encode(s.replace(/\n/g, '\r\n')));
        },
      });
      w.__serialEmit = (s) => this.ctrl?.enqueue(enc.encode(s));
    }

    async setSignals() {}

    async close() {
      this.readable = null;
      this.writable = null;
    }
  }

  class FakeSerial extends EventTarget {
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
      return Promise.resolve(new FakePort());
    }

    async getPorts() {
      return [];
    }
  }

  Object.defineProperty(navigator, 'serial', { value: new FakeSerial(), configurable: true });
}
