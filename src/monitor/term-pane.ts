import { Terminal, type IBufferCell } from '@xterm/headless';
import type { Rect, Screen } from '../tui/screen';
import { Attr, DEFAULT, rgb } from '../tui/style';

/**
 * A terminal inside the terminal: device output is parsed by a headless xterm sized to the
 * pane, and each frame its visible cells are copied into our Screen (as tmux does).
 */
export class TermPane {
  readonly term: Terminal;
  private cell: IBufferCell | undefined;
  private pending = 0;
  /** Bytes written so far, for throughput readouts. */
  bytesIn = 0;

  constructor(cols = 80, rows = 24, scrollback = 10_000) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback,
      // ESP-IDF can be configured to emit bare LF; make it behave like CRLF.
      convertEol: true,
      allowProposedApi: true,
    });
  }

  write(data: string | Uint8Array, onParsed?: () => void): void {
    this.bytesIn += data.length;
    this.pending++;
    this.term.write(data, () => {
      this.pending--;
      onParsed?.();
    });
  }

  /** Writes still waiting to be parsed. */
  get backlog(): number {
    return this.pending;
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, cols);
    rows = Math.max(1, rows);
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  /** Scrolled away from the bottom (scroll lock). */
  get scrolledBack(): boolean {
    const b = this.term.buffer.active;
    return b.viewportY < b.baseY;
  }

  scroll(lines: number): void {
    this.term.scrollLines(lines);
  }

  scrollToBottom(): void {
    this.term.scrollToBottom();
  }

  clear(): void {
    this.term.reset();
  }

  /** Copy the visible viewport into `screen` at `r`. */
  blit(screen: Screen, r: Rect): void {
    const buf = this.term.buffer.active;
    const h = Math.min(r.h, this.term.rows);
    const w = Math.min(r.w, this.term.cols);
    for (let row = 0; row < h; row++) {
      const line = buf.getLine(buf.viewportY + row);
      const y = r.y + row;
      for (let col = 0; col < w; col++) {
        const x = r.x + col;
        const cell = line?.getCell(col, this.cell);
        if (!cell) {
          screen.set(x, y, ' ');
          continue;
        }
        this.cell = cell;
        const width = cell.getWidth();
        if (width === 0) continue; // right half of a wide char, written with its left half
        let attrs = 0;
        if (cell.isBold()) attrs |= Attr.Bold;
        if (cell.isDim()) attrs |= Attr.Dim;
        if (cell.isItalic()) attrs |= Attr.Italic;
        if (cell.isUnderline()) attrs |= Attr.Underline;
        if (cell.isInverse()) attrs |= Attr.Inverse;
        const fg = cell.isFgDefault()
          ? DEFAULT
          : cell.isFgRGB()
            ? rgb(cell.getFgColor())
            : cell.getFgColor();
        const bg = cell.isBgDefault()
          ? DEFAULT
          : cell.isBgRGB()
            ? rgb(cell.getBgColor())
            : cell.getBgColor();
        const ch = cell.getChars() || ' ';
        screen.set(x, y, ch, { fg, bg, attrs }, width === 2 && col + 1 < w ? 2 : 1);
      }
    }
  }

  /** Viewport as plain text (tests). */
  viewportText(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let row = 0; row < this.term.rows; row++) {
      out.push(buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '');
    }
    return out;
  }
}
