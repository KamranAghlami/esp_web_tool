/**
 * Synthetic ESP-IDF-style log output, so the monitor can be tried (and load-tested) without a
 * device. Not real data: every line comes from the tables below.
 */

const TAGS = ['wifi', 'main', 'esp_netif', 'httpd', 'nvs', 'phy_init', 'sensor', 'ota', 'heap'];
const MESSAGES: [level: 'I' | 'W' | 'E' | 'D', text: string][] = [
  ['I', 'connected to AP, rssi=-58'],
  ['I', 'got ip: 192.168.1.42'],
  ['I', 'free heap: 214332 bytes'],
  ['D', 'polling sensor bus'],
  ['I', 'temperature=23.4C humidity=41%'],
  ['W', 'retrying in 500 ms'],
  ['I', 'request GET /status 200'],
  ['E', 'read timeout on i2c port 0'],
  ['I', 'partition ota_0 marked valid'],
];
const COLOR = { I: '\x1b[0;32m', W: '\x1b[0;33m', E: '\x1b[0;31m', D: '' };

export const BOOT_BANNER = [
  'ESP-ROM:esp32s3-20210327',
  'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)',
  'mode:DIO, clock div:1',
  'entry 0x403c98d0',
  '\x1b[0;32mI (24) boot: ESP-IDF v5.5 2nd stage bootloader\x1b[0m',
  '\x1b[0;32mI (31) boot: chip revision: v0.2\x1b[0m',
  '\x1b[0;32mI (312) cpu_start: Starting scheduler.\x1b[0m',
  '\x1b[2m(demo stream: synthetic output, no device attached)\x1b[0m',
  '',
].join('\r\n');

export class DemoStream {
  private t = 312;
  private i = 0;

  /** Produce roughly `bytes` worth of log lines. */
  next(bytes: number): string {
    let out = '';
    while (out.length < bytes) {
      const [level, text] = MESSAGES[this.i++ % MESSAGES.length]!;
      const tag = TAGS[(this.i * 7) % TAGS.length]!;
      this.t += 3 + (this.i % 17);
      const reset = COLOR[level] ? '\x1b[0m' : '';
      out += `${COLOR[level]}${level} (${this.t}) ${tag}: ${text}${reset}\r\n`;
    }
    return out;
  }
}
