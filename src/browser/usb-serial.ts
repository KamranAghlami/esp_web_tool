import type { SerialProvider } from '../serial/port-manager';

const ESPRESSIF = 0x303a;
const WCH = 0x1a86;
const CH343_PID = 0x55d3;
/** Bridges that speak their own vendor protocol, which no WebUSB driver here implements. */
const UNSUPPORTED: Record<number, string> = { 0x10c4: 'CP210x', 0x0403: 'FTDI' };

const isCdc = (d: USBDevice) =>
  d.configuration?.interfaces.some((i) => i.alternate.interfaceClass === 0x02) ??
  d.deviceClass === 0x02;

/**
 * navigator.serial for browsers without Web Serial but with WebUSB (most Android phones,
 * SPEC §4.1): CDC-ACM devices go through Google's web-serial-polyfill (native-USB ESP32s,
 * CH9102/CH343), CH340 through esptool-js's driver. CP210x and FTDI can't work this way and
 * say so. Port objects are kept per USB device, so disconnect events match the open port.
 */
export class UsbSerial extends EventTarget implements SerialProvider {
  private ports = new Map<USBDevice, SerialPort>();

  constructor() {
    super();
    navigator.usb.addEventListener('disconnect', (e) => {
      const port = this.ports.get(e.device);
      if (port) this.emit('disconnect', port);
    });
    navigator.usb.addEventListener('connect', (e) => {
      void this.wrap(e.device).then(
        (port) => this.emit('connect', port),
        () => {},
      );
    });
  }

  private emit(type: 'connect' | 'disconnect', port: SerialPort): void {
    const e = new Event(type);
    Object.defineProperty(e, 'target', { value: port });
    this.dispatchEvent(e);
  }

  /** Called synchronously from input: requestDevice needs the user gesture. */
  requestPort(): Promise<SerialPort> {
    return navigator.usb
      .requestDevice({
        filters: [
          { classCode: 0x02 },
          { vendorId: ESPRESSIF },
          { vendorId: WCH },
          ...Object.keys(UNSUPPORTED).map((v) => ({ vendorId: Number(v) })),
        ],
      })
      .then((device) => this.wrap(device));
  }

  async getPorts(): Promise<SerialPort[]> {
    const devices = await navigator.usb.getDevices();
    const ports = await Promise.all(devices.map((d) => this.wrap(d).catch(() => null)));
    return ports.filter((p): p is SerialPort => p !== null);
  }

  private async wrap(device: USBDevice): Promise<SerialPort> {
    const known = this.ports.get(device);
    if (known) return known;
    const bridge = UNSUPPORTED[device.vendorId];
    if (bridge)
      throw new Error(
        `${bridge} bridges need Web Serial, which this browser lacks. Native-USB boards and CH340/CH9102 bridges work here`,
      );
    let port: SerialPort;
    if (device.vendorId === WCH && device.productId !== CH343_PID && !isCdc(device)) {
      const { WebUSBSerialPort } = await import('esptool-js');
      port = new WebUSBSerialPort(device).asSerialPort();
    } else {
      const { SerialPort: CdcPort } = await import('web-serial-polyfill');
      port = new CdcPort(device) as unknown as SerialPort;
    }
    this.ports.set(device, port);
    return port;
  }
}
