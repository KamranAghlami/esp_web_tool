import type { Terminal } from '@xterm/xterm';
import type { Disposable, Tty } from './tty';

/** The page's xterm.js terminal, seen by the app as a plain TTY. */
export class XtermTty implements Tty {
  constructor(private term: Terminal) {}

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    this.term.write(data);
  }

  onData(listener: (data: string) => void): Disposable {
    return this.term.onData(listener);
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable {
    return this.term.onResize(listener);
  }
}
