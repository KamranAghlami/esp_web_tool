import { describe, expect, it } from 'vitest';
import { InputParser, type KeyEvent } from '../../src/tty/input';

const parse = (s: string) => new InputParser().feed(s);
const key = (s: string) => parse(s)[0] as KeyEvent;

describe('InputParser keys', () => {
  it('parses printable characters, including astral code points', () => {
    expect(parse('aZ😀').map((e) => (e as KeyEvent).name)).toEqual(['a', 'Z', '😀']);
    expect(key('Z').shift).toBe(true);
  });

  it('maps control bytes', () => {
    expect(key('\r').name).toBe('enter');
    expect(key('\t').name).toBe('tab');
    expect(key('\x7f').name).toBe('backspace');
    expect(key('\x01')).toMatchObject({ name: 'a', ctrl: true });
    expect(key('\x1d')).toMatchObject({ name: ']', ctrl: true });
    expect(key('\x1b').name).toBe('escape');
  });

  it('treats an ESC prefix as Alt', () => {
    expect(key('\x1bx')).toMatchObject({ name: 'x', alt: true, raw: '\x1bx' });
  });

  it('parses CSI and SS3 sequences with modifiers', () => {
    expect(key('\x1b[A').name).toBe('up');
    expect(key('\x1bOB').name).toBe('down');
    expect(key('\x1b[1;5C')).toMatchObject({ name: 'right', ctrl: true });
    expect(key('\x1b[1;2D')).toMatchObject({ name: 'left', shift: true });
    expect(key('\x1b[3~').name).toBe('delete');
    expect(key('\x1b[6~').name).toBe('pagedown');
    expect(key('\x1b[15~').name).toBe('f5');
    expect(key('\x1b[Z')).toMatchObject({ name: 'tab', shift: true });
    expect(key('\x1bOP').name).toBe('f1');
  });

  it('keeps the raw bytes for pass-through', () => {
    expect(parse('a\x1b[A\r').map((e) => (e as KeyEvent).raw)).toEqual(['a', '\x1b[A', '\r']);
  });
});

describe('InputParser mouse', () => {
  it('parses SGR mouse press, release, drag and wheel', () => {
    expect(parse('\x1b[<0;10;5M')[0]).toMatchObject({
      type: 'mouse',
      action: 'down',
      button: 0,
      x: 9,
      y: 4,
    });
    expect(parse('\x1b[<0;10;5m')[0]).toMatchObject({ action: 'up' });
    expect(parse('\x1b[<32;11;5M')[0]).toMatchObject({ action: 'drag' });
    expect(parse('\x1b[<64;1;1M')[0]).toMatchObject({ action: 'wheelup' });
    expect(parse('\x1b[<65;1;1M')[0]).toMatchObject({ action: 'wheeldown' });
    expect(parse('\x1b[<16;1;1M')[0]).toMatchObject({ ctrl: true });
  });
});

describe('InputParser paste', () => {
  it('collects bracketed paste, also across chunks', () => {
    const p = new InputParser();
    expect(p.feed('x\x1b[200~hello ')).toEqual([expect.objectContaining({ name: 'x' })]);
    expect(p.feed('world\x1b[201~y')).toEqual([
      { type: 'paste', text: 'hello world' },
      expect.objectContaining({ name: 'y' }),
    ]);
  });

  it('does not interpret escape sequences inside a paste', () => {
    expect(parse('\x1b[200~\x1b[A\x03\x1b[201~')).toEqual([{ type: 'paste', text: '\x1b[A\x03' }]);
  });
});
