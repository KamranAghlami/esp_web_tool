import { DEFAULT, type Style } from './style';
import { charWidth } from './width';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BOX = {
  light: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
} as const;

export type BoxStyle = keyof typeof BOX;

/** Marks the right half of a wide character. */
export const CONT = '';

/**
 * A grid of cells. Widgets draw into it; the renderer diffs consecutive frames.
 * Drawing is clipped to `clip`, which widgets narrow with `withClip`.
 */
export class Screen {
  chars: string[];
  fg: Int32Array;
  bg: Int32Array;
  attrs: Uint8Array;
  private clip: Rect;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    const n = cols * rows;
    this.chars = new Array<string>(n).fill(' ');
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.attrs = new Uint8Array(n);
    this.clip = { x: 0, y: 0, w: cols, h: rows };
  }

  clear(style: Style = {}): void {
    this.chars.fill(' ');
    this.fg.fill(style.fg ?? DEFAULT);
    this.bg.fill(style.bg ?? DEFAULT);
    this.attrs.fill(style.attrs ?? 0);
  }

  /** Run `draw` with drawing restricted to `r` (intersected with the current clip). */
  withClip(r: Rect, draw: () => void): void {
    const prev = this.clip;
    const x0 = Math.max(prev.x, r.x);
    const y0 = Math.max(prev.y, r.y);
    const x1 = Math.min(prev.x + prev.w, r.x + r.w);
    const y1 = Math.min(prev.y + prev.h, r.y + r.h);
    this.clip = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    try {
      draw();
    } finally {
      this.clip = prev;
    }
  }

  private inClip(x: number, y: number): boolean {
    const c = this.clip;
    return x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h;
  }

  /** Set one cell. Overwriting either half of a wide character blanks the other half. */
  set(x: number, y: number, ch: string, style: Style = {}, width = 1): void {
    if (!this.inClip(x, y) || (width === 2 && !this.inClip(x + 1, y))) return;
    const i = y * this.cols + x;
    this.breakWide(x, y);
    if (width === 2) this.breakWide(x + 1, y);
    this.chars[i] = ch;
    this.fg[i] = style.fg ?? DEFAULT;
    this.bg[i] = style.bg ?? DEFAULT;
    this.attrs[i] = style.attrs ?? 0;
    if (width === 2) {
      this.chars[i + 1] = CONT;
      this.fg[i + 1] = this.fg[i]!;
      this.bg[i + 1] = this.bg[i]!;
      this.attrs[i + 1] = this.attrs[i]!;
    }
  }

  private breakWide(x: number, y: number): void {
    const i = y * this.cols + x;
    if (this.chars[i] === CONT && x > 0) this.chars[i - 1] = ' ';
    else if (x + 1 < this.cols && this.chars[i + 1] === CONT) this.chars[i + 1] = ' ';
  }

  /** Restyle the cells in `r` without changing their characters; unset fields are kept. */
  paint(r: Rect, style: Style): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!this.inClip(x, y)) continue;
        const i = y * this.cols + x;
        if (style.fg !== undefined) this.fg[i] = style.fg;
        if (style.bg !== undefined) this.bg[i] = style.bg;
        if (style.attrs !== undefined) this.attrs[i] = style.attrs;
      }
    }
  }

  /** Write text starting at (x, y); returns the column after the last character written. */
  text(x: number, y: number, s: string, style: Style = {}, maxWidth = Infinity): number {
    let cx = x;
    const limit = x + maxWidth;
    for (const ch of s) {
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) continue;
      if (cx + w > limit) break;
      this.set(cx, y, ch, style, w);
      cx += w;
    }
    return cx;
  }

  fill(r: Rect, ch = ' ', style: Style = {}): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, ch, style);
    }
  }

  hline(x: number, y: number, w: number, ch = '─', style: Style = {}): void {
    for (let i = 0; i < w; i++) this.set(x + i, y, ch, style);
  }

  vline(x: number, y: number, h: number, ch = '│', style: Style = {}): void {
    for (let i = 0; i < h; i++) this.set(x, y + i, ch, style);
  }

  box(r: Rect, style: Style = {}, kind: BoxStyle = 'light'): void {
    if (r.w < 2 || r.h < 2) return;
    const b = BOX[kind];
    const right = r.x + r.w - 1;
    const bottom = r.y + r.h - 1;
    this.set(r.x, r.y, b.tl, style);
    this.set(right, r.y, b.tr, style);
    this.set(r.x, bottom, b.bl, style);
    this.set(right, bottom, b.br, style);
    this.hline(r.x + 1, r.y, r.w - 2, b.h, style);
    this.hline(r.x + 1, bottom, r.w - 2, b.h, style);
    this.vline(r.x, r.y + 1, r.h - 2, b.v, style);
    this.vline(right, r.y + 1, r.h - 2, b.v, style);
  }

  /** Read back a row as plain text (tests and debugging). */
  rowText(y: number): string {
    let s = '';
    for (let x = 0; x < this.cols; x++) s += this.chars[y * this.cols + x];
    return s;
  }
}

export function inset(r: Rect, n = 1): Rect {
  return { x: r.x + n, y: r.y + n, w: Math.max(0, r.w - 2 * n), h: Math.max(0, r.h - 2 * n) };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}
