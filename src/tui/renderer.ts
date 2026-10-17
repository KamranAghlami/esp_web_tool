import { CONT, Screen } from './screen';
import { sgr } from './style';

export interface CursorState {
  visible: boolean;
  x: number;
  y: number;
}

/**
 * Turns successive Screens into the minimal-ish ANSI needed to update a terminal:
 * only changed cells are written, cursor moves are skipped for contiguous runs, and
 * SGR is only emitted when the style changes.
 */
export class Renderer {
  private prev: Screen | null = null;

  /** Forget the previous frame so the next render repaints everything (e.g. after resize). */
  invalidate(): void {
    this.prev = null;
  }

  render(next: Screen, cursor: CursorState): string {
    const prev =
      this.prev && this.prev.cols === next.cols && this.prev.rows === next.rows ? this.prev : null;
    let out = '\x1b[?25l';
    if (!prev) out += '\x1b[0m\x1b[2J';

    // Terminal state as far as we know it; -1 means unknown.
    let cx = -1;
    let cy = -1;
    let style = prev ? '' : '\x1b[0m';

    const { cols, rows } = next;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const ch = next.chars[i]!;
        if (ch === CONT) continue;
        const wide = x + 1 < cols && next.chars[i + 1] === CONT;
        if (prev && sameCell(prev, next, i) && (!wide || sameCell(prev, next, i + 1))) continue;

        if (cx !== x || cy !== y) {
          out += `\x1b[${y + 1};${x + 1}H`;
        }
        const s = sgr(next.fg[i]!, next.bg[i]!, next.attrs[i]!);
        if (s !== style) {
          out += s;
          style = s;
        }
        out += ch;
        const nx = x + (wide ? 2 : 1);
        // Writing into the last column leaves the cursor in a pending-wrap state; don't trust it.
        if (nx >= cols) {
          cx = -1;
          cy = -1;
        } else {
          cx = nx;
          cy = y;
        }
      }
    }

    out += '\x1b[0m';
    if (cursor.visible) out += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;

    this.prev = snapshot(next);
    return out;
  }
}

function sameCell(a: Screen, b: Screen, i: number): boolean {
  return (
    a.chars[i] === b.chars[i] &&
    a.fg[i] === b.fg[i] &&
    a.bg[i] === b.bg[i] &&
    a.attrs[i] === b.attrs[i]
  );
}

function snapshot(s: Screen): Screen {
  const c = new Screen(s.cols, s.rows);
  c.chars = s.chars.slice();
  c.fg = s.fg.slice();
  c.bg = s.bg.slice();
  c.attrs = s.attrs.slice();
  return c;
}
