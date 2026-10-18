import { describe, expect, it } from 'vitest';
import {
  defaultDeviceSettings,
  defaultSettings,
  MAX_DEVICES,
  parseSettings,
  rememberDevice,
  SettingsStore,
} from '../../src/app/settings';

class MemoryStore {
  map = new Map<string, string>();
  writes = 0;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.writes++;
    this.map.set(k, v);
  }
}

describe('settings', () => {
  it('round-trips through the store and writes only on change', () => {
    const mem = new MemoryStore();
    const store = new SettingsStore(mem);
    const s = store.load();
    expect(s).toEqual(defaultSettings());
    store.save(s);
    expect(mem.writes).toBe(0);
    s.last.monitor.baud = 460800;
    s.last.flash.manifest = 'espressif/esp-idf';
    rememberDevice(s.devices, '303a:1001', s.last);
    store.save(s);
    expect(mem.writes).toBe(1);
    expect(new SettingsStore(mem).load()).toEqual(s);
  });

  it('copies a device snapshot, so later edits to `last` do not leak into it', () => {
    const s = defaultSettings();
    rememberDevice(s.devices, '303a:1001', s.last);
    s.last.flash.manifest = 'changed';
    expect(s.devices['303a:1001']!.flash.manifest).toBe('');
  });

  it('falls back to defaults for junk, field by field', () => {
    expect(parseSettings('not json')).toEqual(defaultSettings());
    const s = parseSettings(
      JSON.stringify({
        last: {
          flash: { manifest: 'a/b', repo: 'old field', baud: 123, verify: false },
          monitor: { baud: -5, format: '9X9', eol: 7, colorize: false },
        },
        devices: { 'bad key': {}, '10c4:ea60': { monitor: { baud: 74880, format: '7E1' } } },
      }),
    );
    const d = defaultDeviceSettings();
    expect(s.last.flash).toEqual({ ...d.flash, manifest: 'a/b', verify: false });
    expect(s.last.monitor).toEqual({ ...d.monitor, colorize: false });
    expect(Object.keys(s.devices)).toEqual(['10c4:ea60']);
    expect(s.devices['10c4:ea60']!.monitor).toMatchObject({ baud: 74880, format: '7E1' });
  });

  it('keeps the most recently used devices', () => {
    const devices = {};
    const d = defaultDeviceSettings();
    for (let i = 0; i < MAX_DEVICES + 3; i++) {
      rememberDevice(devices, `303a:${i.toString(16).padStart(4, '0')}`, d);
    }
    rememberDevice(devices, '303a:0005', d); // used again
    const keys = Object.keys(devices);
    expect(keys).toHaveLength(MAX_DEVICES);
    expect(keys).not.toContain('303a:0000');
    expect(keys.at(-1)).toBe('303a:0005');
  });

  it('survives a store that throws', () => {
    const store = new SettingsStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    const s = store.load();
    s.last.monitor.baud = 9600;
    expect(() => store.save(s)).not.toThrow();
  });
});
