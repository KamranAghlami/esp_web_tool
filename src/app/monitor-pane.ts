import { TermPane } from '../monitor/term-pane';
import type { KeyEvent } from '../tty/input';
import type { Ctx } from '../tui/context';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import type { Focusable } from '../tui/widgets';

export const LINE_ENDINGS = [
  { label: 'LF', value: '\n' },
  { label: 'CR', value: '\r' },
  { label: 'CRLF', value: '\r\n' },
] as const;

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
  private hasOutput = false;

  get lineEnding(): (typeof LINE_ENDINGS)[number] {
    return LINE_ENDINGS[this.eol]!;
  }

  write(data: string | Uint8Array, onParsed: () => void): void {
    this.hasOutput = true;
    this.pane.write(data, onParsed);
  }

  clear(): void {
    this.pane.clear();
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
        ['D', 'start a demo stream'],
      ];
      const top = r.y + Math.max(0, Math.floor((r.h - lines.length) / 2));
      const left = r.x + Math.max(1, Math.floor((r.w - 26) / 2));
      lines.forEach(([k, text], i) => {
        if (k) screen.text(left, top + i, k, { fg: theme.keyFg, attrs: Attr.Bold });
        screen.text(k ? left + 3 : left, top + i, text, { fg: k ? theme.fg : theme.dim });
      });
    } else {
      this.pane.blit(screen, r);
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

    ctx.hits.add(
      r,
      (e) => {
        if (e.action === 'wheelup') this.pane.scroll(-3);
        else if (e.action === 'wheeldown') this.pane.scroll(3);
      },
      this,
    );
  }

  handleKey(e: KeyEvent): boolean {
    const rows = this.pane.term.rows;
    switch (e.name) {
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
