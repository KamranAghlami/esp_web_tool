import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  MAX_PORTS,
  parseSettings,
  rememberPort,
  SettingsStore,
  STORAGE_KEY,
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
    s.monitor.baud = 460800;
    s.flash.verify = false;
    rememberPort(s.ports, '303a:1001', { baud: 230400, format: '8E1', eol: 2 });
    store.save(s);
    expect(mem.writes).toBe(1);
    expect(new SettingsStore(mem).load()).toEqual(s);
  });

  it('falls back to defaults for junk, field by field', () => {
    expect(parseSettings('not json')).toEqual(defaultSettings());
    const s = parseSettings(
      JSON.stringify({
        flash: { source: 'github', repo: 'a/b', baud: 123, verify: false },
        monitor: { baud: -5, format: '9X9', eol: 7, colorize: false },
        ports: { 'bad key': { baud: 9600 }, '10c4:ea60': { baud: 74880, format: '7E1' } },
      }),
    );
    expect(s.flash).not.toHaveProperty('repo'); // not remembered (any more)
    expect(s.flash.baud).toBe(921600);
    expect(s.flash.verify).toBe(false);
    expect(s.monitor).toEqual({ baud: 115200, format: '8N1', eol: 0, colorize: false });
    expect(s.ports).toEqual({ '10c4:ea60': { baud: 74880, format: '7E1', eol: 0 } });
  });

  it('keeps the most recently used devices', () => {
    const ports = {};
    for (let i = 0; i < MAX_PORTS + 3; i++) {
      const key = `303a:${i.toString(16).padStart(4, '0')}`;
      rememberPort(ports, key, { baud: 115200, format: '8N1', eol: 0 });
    }
    rememberPort(ports, '303a:0005', { baud: 9600, format: '8N1', eol: 0 }); // used again
    const keys = Object.keys(ports);
    expect(keys).toHaveLength(MAX_PORTS);
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
    s.monitor.baud = 9600;
    expect(() => store.save(s)).not.toThrow();
    expect(STORAGE_KEY).toMatch(/v1$/);
  });
});
