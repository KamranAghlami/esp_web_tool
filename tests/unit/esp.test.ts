import { describe, expect, it } from 'vitest';
import { sameChip, sizeBytes } from '../../src/flash/chip';
import { EspSession } from '../../src/flash/esp';
import { md5 } from '../../src/flash/md5';
import { FakeEspPort } from '../fake-port';

const image = (n: number, seed: number) => {
  const d = new Uint8Array(n).map((_, i) => (i * seed + (i >> 7)) & 0xff);
  d[0] = 0xe9;
  return d;
};

describe('EspSession against a simulated ESP32-S3', () => {
  it('detects the chip, writes and verifies, reads back, erases', async () => {
    const port = new FakeEspPort();
    const log: string[] = [];
    const s = await EspSession.connect(port as unknown as SerialPort, 921600, (t) => log.push(t));
    expect(s.info).toMatchObject({
      name: 'ESP32-S3',
      flashSize: '4MB',
      mac: '34:85:18:aa:bb:cc',
      bootloaderOffset: 0,
      secure: false,
    });
    expect(port.esp.mode).toBe('stub');
    expect(port.opens).toEqual([115200, 921600]); // ROM baud, then raised

    const app = image(70_000, 7);
    const data = image(5000, 13);
    const progress: number[] = [];
    await s.write(
      [
        { name: 'app.bin', offset: 0x10000, data: app },
        { name: 'data.bin', offset: 0x200000, data },
      ],
      { verify: true, onProgress: (i, f) => progress.push(i + f) },
    );
    expect(md5(port.esp.flash.subarray(0x10000, 0x10000 + app.length))).toBe(md5(app));
    expect(progress.at(-1)).toBe(2);

    const back = await s.read(0x200000, data.length, () => {});
    expect(back).toEqual(data);

    await s.erase();
    expect(port.esp.flash.subarray(0x10000, 0x10010).every((b) => b === 0xff)).toBe(true);
    await s.close();
    expect(port.readable).toBeNull();
    expect(log.join('')).toContain('Chip is ESP32-S3');
  }, 30_000);

  it('helps with sizes and chip names', () => {
    expect(sizeBytes('4MB')).toBe(4 * 1024 * 1024);
    expect(sizeBytes('512KB')).toBe(512 * 1024);
    expect(sizeBytes(null)).toBeNull();
    expect(sameChip('esp32s3', 'ESP32-S3')).toBe(true);
    expect(sameChip('ESP32-C3', 'ESP32-S3')).toBe(false);
  });
});
