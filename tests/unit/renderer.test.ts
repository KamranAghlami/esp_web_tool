import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { Renderer } from '../../src/tui/renderer';
import { CONT, Screen } from '../../src/tui/screen';
import { Attr, DEFAULT, rgb } from '../../src/tui/style';

/** Feed ANSI into a real (headless) xterm and wait until it is parsed. */
function apply(term: Terminal, ansi: string): Promise<void> {
  return new Promise((resolve) => term.write(ansi, resolve));
}

/** What the terminal shows, cell by cell, in the same form as a Screen. */
function readTerminal(term: Terminal) {
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const chars: string[] = [];
  const attrs: number[] = [];
  const fg: number[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(y)!;
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      chars.push(cell.getWidth() === 0 ? CONT : cell.getChars() || ' ');
      attrs.push((cell.isBold() ? Attr.Bold : 0) | (cell.isInverse() ? Attr.Inverse : 0));
      fg.push(
        cell.isFgDefault() ? DEFAULT : cell.isFgRGB() ? rgb(cell.getFgColor()) : cell.getFgColor(),
      );
    }
  }
  return { chars, attrs, fg };
}

function expectMatches(term: Terminal, s: Screen): void {
  const t = readTerminal(term);
  expect(t.chars).toEqual(s.chars);
  expect(t.fg).toEqual(Array.from(s.fg));
  expect(t.attrs).toEqual(Array.from(s.attrs).map((a) => a & (Attr.Bold | Attr.Inverse)));
}

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('Renderer', () => {
  it('paints a full frame that the terminal reproduces exactly', async () => {
    const term = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
    const s = new Screen(30, 6);
    s.box({ x: 0, y: 0, w: 30, h: 6 }, { fg: rgb(0x58c4dc) });
    s.text(2, 0, ' Parts ', { attrs: Attr.Bold });
    s.text(2, 2, 'bootloader.bin', { fg: 2 });
    s.text(2, 3, '全角 wide', { fg: 11, attrs: Attr.Inverse });
    await apply(term, new Renderer().render(s, { visible: false, x: 0, y: 0 }));
    expectMatches(term, s);
  });

  it('stays in sync over many random incremental frames', async () => {
    const cols = 40;
    const rows = 12;
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const r = new Renderer();
    const rand = rng(42);
    const glyphs = ['a', 'b', '─', '│', '█', '▌', '●', '全', '界', ' '];
    let s = new Screen(cols, rows);

    for (let frame = 0; frame < 60; frame++) {
      const next = new Screen(cols, rows);
      // Start from the previous frame's content, then mutate a few spots.
      next.chars = s.chars.slice();
      next.fg = s.fg.slice();
      next.attrs = s.attrs.slice();
      for (let k = 0; k < 15; k++) {
        const x = Math.floor(rand() * cols);
        const y = Math.floor(rand() * rows);
        const ch = glyphs[Math.floor(rand() * glyphs.length)]!;
        const wide = ch === '全' || ch === '界';
        next.set(
          x,
          y,
          ch,
          { fg: Math.floor(rand() * 16), attrs: rand() < 0.3 ? Attr.Bold : 0 },
          wide ? 2 : 1,
        );
      }
      await apply(term, r.render(next, { visible: false, x: 0, y: 0 }));
      expectMatches(term, next);
      s = next;
    }
  });

  it('only emits changed cells on an incremental frame', () => {
    const r = new Renderer();
    const a = new Screen(20, 3);
    a.text(0, 0, 'hello world');
    r.render(a, { visible: false, x: 0, y: 0 });
    const b = new Screen(20, 3);
    b.text(0, 0, 'hello there');
    const out = r.render(b, { visible: false, x: 0, y: 0 });
    expect(out).toContain('there');
    expect(out).not.toContain('hello');
  });

  it('shows the cursor where requested', async () => {
    const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
    await apply(term, new Renderer().render(new Screen(10, 3), { visible: true, x: 4, y: 2 }));
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([4, 2]);
  });
});

describe('Screen', () => {
  it('blanks the other half when a wide character is overwritten', () => {
    const s = new Screen(6, 1);
    s.text(0, 0, '全');
    expect(s.chars.slice(0, 2)).toEqual(['全', CONT]);
    s.set(1, 0, 'x');
    expect(s.chars.slice(0, 2)).toEqual([' ', 'x']);
  });

  it('clips drawing', () => {
    const s = new Screen(10, 2);
    s.withClip({ x: 2, y: 0, w: 3, h: 1 }, () => s.text(0, 0, 'abcdefgh'));
    expect(s.rowText(0)).toBe('  cde     ');
    expect(s.rowText(1)).toBe('          ');
  });
});
