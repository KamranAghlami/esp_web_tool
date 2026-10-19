import { describe, expect, it } from 'vitest';
import { SessionLog, stripAnsi } from '../../src/monitor/session-log';
import { clock, Timestamper } from '../../src/monitor/timestamps';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('timestamps', () => {
  it('stamps each line once, at its first byte, across chunks', () => {
    let t = new Date(2026, 0, 1, 12, 34, 56, 789).getTime();
    const s = new Timestamper(() => t);
    const out = [s.push(enc.encode('I (1) a\r\nI (2')), s.push(enc.encode(') b\r\n\r\n'))];
    t += 1;
    out.push(s.push(enc.encode('x')));
    const text = stripAnsi(out.map((b) => dec.decode(b)).join(''));
    expect(text).toBe('12:34:56.789 I (1) a\r\n12:34:56.789 I (2) b\r\n\r\n12:34:56.790 x');
    expect(clock(0)).toMatch(/^\d\d:\d\d:\d\d\.000$/);
  });
});

describe('session log', () => {
  it('keeps the newest output within its cap, plain or with ANSI', () => {
    const log = new SessionLog(10);
    log.push('\x1b[0;32mI (1) ok\x1b[0m\r\n');
    log.push('second\r\n');
    expect(log.text(false)).toBe('second\n'); // the first chunk went over the cap
    const all = new SessionLog();
    all.push('\x1b[0;31mE (5) bad\x1b[0m\r\n');
    expect(all.text(true)).toContain('\x1b[0;31m');
    expect(all.text(false)).toBe('E (5) bad\n');
  });
});
