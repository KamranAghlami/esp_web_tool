import { describe, expect, it } from 'vitest';
import { LogColorizer } from '../../src/monitor/log-color';

const enc = new TextEncoder();
const dec = new TextDecoder();

function run(chunks: string[]): string {
  const c = new LogColorizer();
  return chunks.map((s) => dec.decode(c.push(enc.encode(s)))).join('');
}

describe('LogColorizer', () => {
  it('colors plain E/W/I lines and leaves the rest alone', () => {
    expect(run(['E (1) a: x\r\nW (2) b: y\r\nI (3) c: z\r\nD (4) d: w\r\nplain\r\n'])).toBe(
      '\x1b[0;31mE (1) a: x\x1b[0m\r\n' +
        '\x1b[0;33mW (2) b: y\x1b[0m\r\n' +
        '\x1b[0;32mI (3) c: z\x1b[0m\r\n' +
        'D (4) d: w\r\nplain\r\n',
    );
  });

  it('does not touch lines the firmware already colored', () => {
    const line = '\x1b[0;32mI (3) c: z\x1b[0m\r\n';
    expect(run([line])).toBe(line);
  });

  it('handles prefixes and line ends split across chunks', () => {
    expect(run(['E', ' ', '(1) x\r', '\nI (2', ') y\n'])).toBe(
      '\x1b[0;31mE (1) x\x1b[0m\r\n\x1b[0;32mI (2) y\x1b[0m\n',
    );
  });

  it('only matches at the start of a line', () => {
    expect(run(['x E (1) y\r\nEND\r\nI(1)\r\n'])).toBe('x E (1) y\r\nEND\r\nI(1)\r\n');
  });

  it('releases a held prefix on flush', () => {
    const c = new LogColorizer();
    expect(c.push(enc.encode('E'))).toHaveLength(0);
    expect(c.holding).toBe(true);
    expect(dec.decode(c.flush())).toBe('E');
    expect(dec.decode(c.push(enc.encode(' (1) typed')))).toBe(' (1) typed');
  });
});
