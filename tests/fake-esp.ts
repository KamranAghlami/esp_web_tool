/**
 * A simulated ESP32-S3 behind a serial port, for tests without hardware: the app firmware
 * (echoes input, prints a boot log), the ROM download mode and the flasher stub, speaking
 * esptool's SLIP protocol well enough for esptool-js to detect, flash, verify, erase and read.
 *
 * Self-contained on purpose (no imports, no outer references): the e2e harness injects this
 * function's source into the page. `md5` and `inflate` are passed in for the same reason.
 */
export interface FakeEsp {
  /** Bytes from the host. */
  write(bytes: Uint8Array): void;
  /** Control lines as the host set them (DTR = IO0 strap, RTS = EN/reset). */
  signals(dtr: boolean, rts: boolean): void;
  /** Where device output goes; the port wires it to its readable stream. */
  output: (bytes: Uint8Array) => void;
  mode: 'app' | 'rom' | 'stub' | 'reset';
  flash: Uint8Array;
  /** Commands seen (op codes), for assertions. */
  ops: number[];
  /** Resets into the app so far. */
  boots: number;
}

export function createFakeEsp(
  md5: (data: Uint8Array) => string,
  inflate: (data: Uint8Array) => Promise<Uint8Array>,
): FakeEsp {
  const FLASH_SIZE = 4 * 1024 * 1024;
  const SPI_BASE = 0x60002000;
  const enc = new TextEncoder();
  const regs = new Map<number, number>([
    [0x60007044, 0x18aabbcc], // MAC low word: 34:85:18:aa:bb:cc
    [0x60007048, 0x3485],
  ]);
  let rts = false;
  /** IO0 was pulled low (DTR) since reset was last released: the strap the ROM will see. */
  let strap = false;
  let rx: number[] = [];
  let inFrame = false;
  let escaped = false;
  let queue = Promise.resolve();
  let defl: { offset: number; chunks: Uint8Array[] } | null = null;
  let plain: { offset: number; written: number } | null = null;

  const dev: FakeEsp = {
    write,
    signals,
    output: () => {},
    mode: 'app',
    flash: new Uint8Array(FLASH_SIZE).fill(0xff),
    ops: [],
    boots: 0,
  };

  const say = (s: string) => dev.output(enc.encode(s));

  function slip(data: Uint8Array): Uint8Array {
    const out = [0xc0];
    for (const b of data) {
      if (b === 0xc0) out.push(0xdb, 0xdc);
      else if (b === 0xdb) out.push(0xdb, 0xdd);
      else out.push(b);
    }
    out.push(0xc0);
    return new Uint8Array(out);
  }

  const u32 = (d: Uint8Array, i: number) =>
    (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24)) >>> 0;

  function respond(op: number, val: number, data: Uint8Array = new Uint8Array(0)): void {
    // Two status bytes (0 = success) follow the data, as esptool-js expects.
    const body = new Uint8Array(8 + data.length + 2);
    body[0] = 1;
    body[1] = op;
    body[2] = (data.length + 2) & 0xff;
    body[3] = (data.length + 2) >> 8;
    new DataView(body.buffer).setUint32(4, val >>> 0, true);
    body.set(data, 8);
    dev.output(slip(body));
  }

  function signals(d: boolean, r: boolean): void {
    if (d) strap = true;
    const releasing = rts && !r;
    rts = r;
    if (r) {
      dev.mode = 'reset';
      return;
    }
    if (!releasing) return;
    // EN released: download mode if IO0 was pulled low during the sequence (the USB-JTAG
    // one drops DTR one step before releasing reset). Not timed: CI machines are slow.
    const download = strap;
    strap = false;
    if (download) {
      dev.mode = 'rom';
      say(
        'ESP-ROM:esp32s3-20210327\r\nrst:0x15 (USB_UART_CHIP_RESET),boot:0x0 (DOWNLOAD(USB/UART0))\r\nwaiting for download\r\n',
      );
    } else {
      dev.mode = 'app';
      dev.boots++;
      say(
        'ESP-ROM:esp32s3-20210327\r\nrst:0x15 (USB_UART_CHIP_RESET),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n',
      );
      say('I (312) main: hello from fake port\r\n');
    }
  }

  function write(bytes: Uint8Array): void {
    if (dev.mode === 'app') {
      say(new TextDecoder().decode(bytes).replace(/\n/g, '\r\n'));
      return;
    }
    if (dev.mode === 'reset') return;
    for (const b of bytes) {
      if (b === 0xc0) {
        if (inFrame && rx.length) {
          const frame = new Uint8Array(rx);
          queue = queue.then(() => command(frame)).catch(() => {});
        }
        rx = [];
        inFrame = true;
        escaped = false;
      } else if (inFrame) {
        if (escaped) {
          rx.push(b === 0xdc ? 0xc0 : b === 0xdd ? 0xdb : b);
          escaped = false;
        } else if (b === 0xdb) escaped = true;
        else rx.push(b);
      }
    }
  }

  async function finishDefl(): Promise<void> {
    if (!defl) return;
    const total = defl.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of defl.chunks) {
      all.set(c, at);
      at += c.length;
    }
    const data = await inflate(all);
    dev.flash.set(data.subarray(0, FLASH_SIZE - defl.offset), defl.offset);
    defl = null;
  }

  async function command(p: Uint8Array): Promise<void> {
    // Acks from readFlash (4-byte frames) and other noise are not commands.
    if (p.length < 8 || p[0] !== 0) return;
    const op = p[1]!;
    const d = p.subarray(8);
    dev.ops.push(op);
    const stub = dev.mode === 'stub';
    switch (op) {
      case 0x08: // SYNC: the ROM answers eight times
        for (let i = 0; i < (stub ? 1 : 8); i++) respond(op, stub ? 0 : 0x20120707);
        return;
      case 0x0a: {
        // READ_REG
        const addr = u32(d, 0);
        let v = regs.get(addr) ?? 0;
        if (addr === SPI_BASE) v = 0; // SPI_CMD: the user command finished at once
        if (addr === SPI_BASE + 0x58) v = 0x1640ef; // SPI_W0 after RDID: 4 MB flash
        respond(op, v);
        return;
      }
      case 0x09: // WRITE_REG
        regs.set(u32(d, 0), u32(d, 4));
        respond(op, 0);
        return;
      case 0x14: {
        // GET_SECURITY_INFO: flags, crypt count, key purposes, chip id 9 (ESP32-S3), api
        const info = new Uint8Array(20);
        info[12] = 9;
        respond(op, 0, info);
        return;
      }
      case 0x05: // MEM_BEGIN
      case 0x07: // MEM_DATA
      case 0x0b: // SPI_SET_PARAMS
      case 0x0d: // SPI_ATTACH
      case 0x0f: // CHANGE_BAUDRATE
        respond(op, 0);
        return;
      case 0x06: // MEM_END: the stub starts and says hello
        respond(op, 0);
        dev.mode = 'stub';
        dev.output(slip(enc.encode('OHAI')));
        return;
      case 0x02: // FLASH_BEGIN
        plain = { offset: u32(d, 12), written: 0 };
        respond(op, 0);
        return;
      case 0x03: // FLASH_DATA
        if (plain) {
          const block = d.subarray(16);
          dev.flash.set(
            block.subarray(0, FLASH_SIZE - plain.offset - plain.written),
            plain.offset + plain.written,
          );
          plain.written += block.length;
        }
        respond(op, 0);
        return;
      case 0x04: // FLASH_END
        plain = null;
        respond(op, 0);
        return;
      case 0x10: // FLASH_DEFL_BEGIN
        await finishDefl();
        defl = { offset: u32(d, 12), chunks: [] };
        respond(op, 0);
        return;
      case 0x11: // FLASH_DEFL_DATA
        defl?.chunks.push(d.slice(16));
        respond(op, 0);
        return;
      case 0x12: // FLASH_DEFL_END
        await finishDefl();
        respond(op, 0);
        return;
      case 0x13: {
        // SPI_FLASH_MD5: raw digest from the stub, hex text from the ROM
        await finishDefl();
        const addr = u32(d, 0);
        const hex = md5(dev.flash.subarray(addr, addr + u32(d, 4)));
        const raw = new Uint8Array(16);
        for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        respond(op, 0, stub ? raw : enc.encode(hex));
        return;
      }
      case 0xd0: // ERASE_FLASH
        dev.flash.fill(0xff);
        respond(op, 0);
        return;
      case 0xd2: {
        // READ_FLASH: status, then the data in sector-sized packets, then its MD5
        await finishDefl();
        const addr = u32(d, 0);
        const size = u32(d, 4);
        const sector = u32(d, 8);
        respond(op, 0);
        for (let at = 0; at < size; at += sector)
          dev.output(slip(dev.flash.slice(addr + at, addr + Math.min(size, at + sector))));
        const hex = md5(dev.flash.subarray(addr, addr + size));
        const raw = new Uint8Array(16);
        for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        dev.output(slip(raw));
        return;
      }
      default: // unsupported: status 1, error 5 (invalid command)
        dev.output(slip(new Uint8Array([1, op, 2, 0, 0, 0, 0, 0, 1, 5])));
    }
  }

  return dev;
}
