import { LogColorizer } from '../monitor/log-color';
import type { IMarker } from '@xterm/headless';
import { TermPane } from '../monitor/term-pane';
import type { KeyEvent, MouseEvent } from '../tty/input';
import type { Ctx } from '../tui/context';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import type { Focusable } from '../tui/widgets';

const RESET = new TextEncoder().encode('\x1b[0m');
/** Presses closer together than this (on the same cell) count as a double or triple click. */
const MULTI_CLICK_MS = 400;

export const LINE_ENDINGS = [
  { label: 'LF', value: '\n' },
  { label: 'CR', value: '\r' },
  { label: 'CRLF', value: '\r\n' },
] as const;

/** A cell in the monitor's buffer; `line` is relative to the selection's marker. */
interface SelPos {
  line: number;
  col: number;
}

/**
 * Mouse selection, tmux-style: anchored to the buffer (via an xterm marker, which follows
 * scrolling and scrollback trimming), so it stays on the same text while output streams in.
 */
interface Selection {
  ref: IMarker;
  a: SelPos;
  b: SelPos;
  dragging: boolean;
  moved: boolean;
}

/**
 * The monitor's focusable surface. Outside live mode it scrolls the scrollback; in live mode
 * the App sends keystrokes to the device instead of calling handleKey.
 */
export class MonitorPane implements Focusable {
  readonly pane = new TermPane();
  live = false;
  eol = 0;
  /** True when there is something to show (an open port or the demo stream). */
  active = false;
  /** Color plain ESP-IDF log lines by level (Ctrl+A h toggles). */
  colorize = true;
  /** Raw bytes received, before coloring (for the rx rate). */
  bytesIn = 0;
  /** Called with the selected text when a drag selection ends. */
  onCopy?: (text: string) => void;
  private sel: Selection | null = null;
  private lastDown = { t: -Infinity, x: -1, y: -1, count: 0 };
  /** Clock for multi-click detection (injectable for tests). */
  now: () => number = () => performance.now();
  private hasOutput = false;
  private colorizer = new LogColorizer();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private encoder = new TextEncoder();

  get lineEnding(): (typeof LINE_ENDINGS)[number] {
    return LINE_ENDINGS[this.eol]!;
  }

  write(data: string | Uint8Array, onParsed: () => void): void {
    this.hasOutput = true;
    this.bytesIn += data.length;
    if (!this.colorize) {
      this.pane.write(data, onParsed);
      return;
    }
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    this.pane.write(this.colorizer.push(bytes), onParsed);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    // A held line prefix (e.g. the echo of a typed "E") must not wait for the next byte.
    if (this.colorizer.holding) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.pane.write(this.colorizer.flush(), onParsed);
      }, 30);
    }
  }

  /**
   * Our own text in the scrollback (the flasher's log), dimmed so it reads apart from the
   * device's output. Not counted as received bytes.
   */
  note(text: string, onParsed?: () => void): void {
    this.hasOutput = true;
    const body = text.replace(/\r?\n/g, '\r\n');
    this.pane.write(Uint8Array.from([...this.colorizer.flush()]), onParsed);
    this.pane.write(`\x1b[0;90m${body}\x1b[0m`, onParsed);
  }

  toggleColorize(): void {
    // Flush a held prefix and end any color the colorizer started mid-line.
    if (this.colorize) this.pane.write(Uint8Array.from([...this.colorizer.flush(), ...RESET]));
    this.colorizer.reset();
    this.colorize = !this.colorize;
  }

  clear(): void {
    this.clearSelection();
    this.pane.clear();
    this.colorizer.reset();
    this.hasOutput = false;
  }

  render(ctx: Ctx, r: Rect): void {
    const { screen, theme } = ctx;
    this.pane.resize(r.w, r.h);

    if (!this.hasOutput && !this.active) {
      const lines: [string, string][] = [
        ['', 'No device connected.'],
        ['', ''],
        ['c', 'connect a serial port'],
      ];
      const top = r.y + Math.max(0, Math.floor((r.h - lines.length) / 2));
      const left = r.x + Math.max(1, Math.floor((r.w - 26) / 2));
      lines.forEach(([k, text], i) => {
        if (k) screen.text(left, top + i, k, { fg: theme.keyFg, attrs: Attr.Bold });
        screen.text(k ? left + 3 : left, top + i, text, { fg: k ? theme.fg : theme.dim });
      });
    } else {
      this.pane.blit(screen, r);
      this.paintSelection(ctx, r);
      if (this.pane.scrolledBack) {
        const tag = ' ↑ scrollback · G to bottom ';
        screen.text(r.x + r.w - tag.length, r.y, tag, { fg: theme.selFg, bg: theme.selBg });
      } else if (this.live) {
        const b = this.pane.term.buffer.active;
        ctx.cursor.visible = true;
        ctx.cursor.x = r.x + Math.min(b.cursorX, r.w - 1);
        ctx.cursor.y = r.y + Math.min(b.cursorY, r.h - 1);
      }
    }

    ctx.hits.add(r, (e) => this.handleMouse(e, r), this);
  }

  private handleMouse(e: MouseEvent, r: Rect): void {
    switch (e.action) {
      case 'wheelup':
        this.pane.scroll(-3);
        break;
      case 'wheeldown':
        this.pane.scroll(3);
        break;
      case 'down': {
        this.clearSelection();
        if (e.button !== 0 || !this.hasOutput) break;
        const t = this.now();
        const last = this.lastDown;
        const repeat = t - last.t < MULTI_CLICK_MS && e.x === last.x && e.y === last.y;
        const count = repeat ? (last.count % 3) + 1 : 1;
        this.lastDown = { t, x: e.x, y: e.y, count };
        if (count === 1) this.startSelection(e, r);
        else this.selectUnit(e, r, count === 2 ? 'word' : 'line');
        break;
      }
      case 'drag':
        this.extendSelection(e, r);
        break;
      case 'up':
        this.endSelection();
        break;
    }
  }

  get hasSelection(): boolean {
    return this.sel !== null;
  }

  clearSelection(): void {
    this.sel?.ref.dispose();
    this.sel = null;
  }

  /** Absolute buffer line and column under a mouse position, clamped to the pane. */
  private cellAt(e: MouseEvent, r: Rect): { abs: number; col: number } {
    const term = this.pane.term;
    const row = Math.max(0, Math.min(r.h - 1, term.rows - 1, e.y - r.y));
    const col = Math.max(0, Math.min(r.w - 1, term.cols - 1, e.x - r.x));
    return { abs: term.buffer.active.viewportY + row, col };
  }

  private startSelection(e: MouseEvent, r: Rect): void {
    const ref = this.pane.term.registerMarker(0);
    if (!ref) return;
    const { abs, col } = this.cellAt(e, r);
    const pos = { line: abs - ref.line, col };
    this.sel = { ref, a: pos, b: { ...pos }, dragging: true, moved: false };
  }

  /**
   * Double click: the run of non-blank cells under the pointer. Triple click: the whole line.
   * Only buffer cells count, so pane borders and other UI never join a word. Copied at once.
   */
  private selectUnit(e: MouseEvent, r: Rect, unit: 'word' | 'line'): void {
    const term = this.pane.term;
    const ref = term.registerMarker(0);
    if (!ref) return;
    const { abs, col } = this.cellAt(e, r);
    const line = term.buffer.active.getLine(abs);
    if (!line) return ref.dispose();
    let start = 0;
    let end = term.cols - 1;
    if (unit === 'word') {
      const cell = term.buffer.active.getNullCell();
      const isWord = (x: number) => {
        const c = line.getCell(x, cell);
        if (!c) return false;
        if (c.getWidth() === 0) return true; // right half of a wide character
        const ch = c.getChars();
        return ch !== '' && !/\s/.test(ch);
      };
      if (!isWord(col)) return ref.dispose();
      start = col;
      end = col;
      while (start > 0 && isWord(start - 1)) start--;
      while (end < term.cols - 1 && isWord(end + 1)) end++;
    }
    const at = abs - ref.line;
    this.sel = {
      ref,
      a: { line: at, col: start },
      b: { line: at, col: end },
      dragging: false,
      moved: true,
    };
    const text = this.selectedText();
    if (text) this.onCopy?.(text);
    else this.clearSelection();
  }

  private extendSelection(e: MouseEvent, r: Rect): void {
    const sel = this.sel;
    if (!sel?.dragging) return;
    // Dragging past the top or bottom edge scrolls.
    if (e.y < r.y) this.pane.scroll(-1);
    else if (e.y >= r.y + r.h) this.pane.scroll(1);
    const { abs, col } = this.cellAt(e, r);
    sel.b = { line: abs - sel.ref.line, col };
    sel.moved = true;
  }

  private endSelection(): void {
    const sel = this.sel;
    if (!sel?.dragging) return;
    sel.dragging = false;
    const text = this.selectedText();
    if (!sel.moved || !text) {
      this.clearSelection();
      return;
    }
    this.onCopy?.(text);
  }

  /** Selection start and end as absolute buffer positions, in reading order. */
  private range(): [SelPos, SelPos] | null {
    const sel = this.sel;
    if (!sel) return null;
    if (sel.ref.isDisposed) {
      this.sel = null; // the anchored text was trimmed from the scrollback
      return null;
    }
    const a = { line: sel.ref.line + sel.a.line, col: sel.a.col };
    const b = { line: sel.ref.line + sel.b.line, col: sel.b.col };
    return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
  }

  selectedText(): string {
    const range = this.range();
    if (!range) return '';
    const [s, e] = range;
    const buf = this.pane.term.buffer.active;
    let out = '';
    for (let y = s.line; y <= e.line; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      if (y > s.line && !line.isWrapped) out += '\n';
      out += line.translateToString(
        true,
        y === s.line ? s.col : 0,
        y === e.line ? e.col + 1 : undefined,
      );
    }
    return out;
  }

  private paintSelection(ctx: Ctx, r: Rect): void {
    const range = this.range();
    if (!range) return;
    const [s, e] = range;
    const top = this.pane.term.buffer.active.viewportY;
    const w = Math.min(r.w, this.pane.term.cols);
    for (let row = 0; row < r.h; row++) {
      const y = top + row;
      if (y < s.line || y > e.line) continue;
      const c0 = y === s.line ? s.col : 0;
      const c1 = y === e.line ? e.col : w - 1;
      ctx.screen.paint(
        { x: r.x + c0, y: r.y + row, w: c1 - c0 + 1, h: 1 },
        { bg: ctx.theme.selBg },
      );
    }
  }

  handleKey(e: KeyEvent): boolean {
    const rows = this.pane.term.rows;
    switch (e.name) {
      case 'escape':
        if (!this.sel) return false;
        this.clearSelection();
        return true;
      case 'up':
      case 'k':
        this.pane.scroll(-1);
        return true;
      case 'down':
      case 'j':
        this.pane.scroll(1);
        return true;
      case 'pageup':
        this.pane.scroll(-(rows - 1));
        return true;
      case 'pagedown':
        this.pane.scroll(rows - 1);
        return true;
      case 'g':
        this.pane.term.scrollToTop();
        return true;
      case 'G':
      case 'end':
        this.pane.scrollToBottom();
        return true;
    }
    return false;
  }
}
