import { ESPLoader, type FlashFreqValues, type FlashModeValues, Transport } from 'esptool-js';
import type { ChipInfo } from './chip';
import { md5 } from './md5';

export type { ChipInfo } from './chip';

export interface WritePart {
  name: string;
  offset: number;
  data: Uint8Array;
}

export interface WriteOptions {
  verify: boolean;
  flashMode?: string;
  flashFreq?: string;
  /** Called with the part being written and the share of it done (0–1). */
  onProgress(index: number, fraction: number): void;
}

const FLASH_MODES = ['qio', 'qout', 'dio', 'dout'];
const FLASH_FREQS = ['80m', '60m', '48m', '40m', '30m', '26m', '24m', '20m', '16m', '15m', '12m'];

/**
 * One esptool-js session on a port the PortManager handed over (SPEC §9): reset into the ROM
 * bootloader, detect the chip, load the stub, raise the baud; then write, erase or read; then
 * close. It never resets the chip on close: the port manager does that with its own sequence
 * after reopening the monitor, so the boot log is caught from its first line.
 */
export class EspSession {
  private constructor(
    private loader: ESPLoader,
    private transport: Transport,
    readonly info: ChipInfo,
  ) {}

  /** `log` gets esptool's own messages (Connecting…, Chip is…), for the monitor pane. */
  static async connect(
    port: SerialPort,
    baud: number,
    log: (text: string) => void,
  ): Promise<EspSession> {
    const transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate: baud,
      romBaudrate: 115200,
      terminal: { clean: () => {}, writeLine: (s) => log(`${s}\n`), write: (s) => log(s) },
    });
    try {
      const description = await loader.main('default_reset');
      const chip = loader.chip;
      const secure = loader.secureDownloadMode;
      const info: ChipInfo = {
        name: chip.CHIP_NAME,
        description,
        features: secure ? [] : await chip.getChipFeatures(loader),
        crystalMHz: secure ? null : await chip.getCrystalFreq(loader),
        mac: secure ? null : await chip.readMac(loader),
        flashSize: secure ? null : ((await loader.detectFlashSize()) ?? null),
        bootloaderOffset: chip.BOOTLOADER_FLASH_OFFSET,
        secure,
      };
      return new EspSession(loader, transport, info);
    } catch (err) {
      await transport.disconnect().catch(() => {});
      throw err;
    }
  }

  async write(parts: WritePart[], opts: WriteOptions): Promise<void> {
    const mode = FLASH_MODES.includes(opts.flashMode ?? '') ? opts.flashMode : 'keep';
    const freq = FLASH_FREQS.includes(opts.flashFreq ?? '') ? opts.flashFreq : 'keep';
    await this.loader.writeFlash({
      fileArray: parts.map((p) => ({ data: p.data, address: p.offset })),
      flashMode: mode as FlashModeValues,
      flashFreq: freq as FlashFreqValues,
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      // written/total count compressed bytes, so a fraction is all that is meaningful.
      reportProgress: (i, written, total) => opts.onProgress(i, total ? written / total : 1),
      calculateMD5Hash: opts.verify ? md5 : undefined,
    });
  }

  async erase(): Promise<void> {
    await this.loader.eraseFlash();
  }

  async read(
    offset: number,
    size: number,
    onProgress: (done: number) => void,
  ): Promise<Uint8Array> {
    return this.loader.readFlash(offset, size, (_packet, done) => onProgress(done));
  }

  /** Release the port (also used to abort: pending commands then fail). */
  async close(): Promise<void> {
    await this.transport.disconnect().catch(() => {});
  }
}
