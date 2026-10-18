import { describe, expect, it } from 'vitest';
import { PortManager } from '../../src/serial/port-manager';

function managerWith(usbVendorId: number, usbProductId: number) {
  const log: string[] = [];
  const port = {
    getInfo: () => ({ usbVendorId, usbProductId }),
    setSignals: async (s: SerialOutputSignals) =>
      void log.push(`${+!!s.dataTerminalReady},${+!!s.requestToSend}`),
  };
  const pm = new PortManager({ onData: () => {}, onState: () => {} });
  pm.port = port as unknown as SerialPort;
  return { pm, log };
}

describe('PortManager boot sequences (DTR,RTS)', () => {
  it('uses the classic auto-reset sequence on USB-UART bridges', async () => {
    const { pm, log } = managerWith(0x10c4, 0xea60); // CP210x
    expect(pm.usbJtag).toBe(false);
    await pm.enterBootloader();
    expect(log).toEqual(['0,1', '1,0', '0,0']);
  });

  it('straps before reset on Espressif USB-Serial/JTAG', async () => {
    const { pm, log } = managerWith(0x303a, 0x1001);
    expect(pm.usbJtag).toBe(true);
    await pm.enterBootloader();
    expect(log).toEqual(['0,0', '1,0', '1,1', '0,1', '0,0']);
  });

  it('resets with DTR low so the chip boots its app', async () => {
    const { pm, log } = managerWith(0x303a, 0x1001);
    await pm.reset();
    expect(log).toEqual(['0,0', '0,1', '0,0']);
  });
});
