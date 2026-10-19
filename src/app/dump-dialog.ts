import { parseOffset } from '../flash/offsets';
import type { KeyEvent } from '../tty/input';
import type { Ctx } from '../tui/context';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import { dialog, TextInput } from '../tui/widgets';
import { stringWidth, truncate } from '../tui/width';

type Field = 'offset' | 'size' | 'read' | 'cancel';
const ORDER: Field[] = ['offset', 'size', 'read', 'cancel'];

/**
 * The Dump flash dialog (`D`, SPEC §4): a region to read, or the whole flash when the size is
 * left empty. Enter reads, Esc cancels; the file is saved when the read is done.
 */
export class DumpDialog {
  readonly offset = new TextInput('0x0');
  readonly size = new TextInput('', 'whole flash');
  focus: Field = 'size';

  constructor(
    private start: (offset: number, size: number | null) => void,
    private close: () => void,
    private notify: (text: string) => void,
  ) {}

  submit(): void {
    const offset = parseOffset(this.offset.value.trim() || '0');
    const sizeText = this.size.value.trim();
    const size = sizeText ? parseOffset(sizeText) : null;
    if (offset === null) {
      this.notify(`Not a hex offset: ${this.offset.value}`);
      this.focus = 'offset';
    } else if (sizeText && !size) {
      this.notify(`Not a hex size: ${sizeText}`);
      this.focus = 'size';
    } else {
      this.close();
      this.start(offset, size);
    }
  }

  private activate(f: Field): void {
    if (f === 'cancel') this.close();
    else this.submit();
  }

  handleKey(e: KeyEvent): void {
    const i = ORDER.indexOf(this.focus);
    const move = (d: number) => (this.focus = ORDER[(i + d + ORDER.length) % ORDER.length]!);
    if (e.name === 'escape') this.close();
    else if (e.name === 'tab') move(e.shift ? -1 : 1);
    else if (e.name === 'down') move(1);
    else if (e.name === 'up') move(-1);
    else if (e.name === 'enter') this.activate(this.focus);
    else if (this.focus === 'offset') this.offset.handleKey(e);
    else if (this.focus === 'size') this.size.handleKey(e);
    else if (e.name === ' ') this.activate(this.focus);
  }

  handlePaste(text: string): void {
    if (this.focus === 'offset') this.offset.handlePaste(text);
    if (this.focus === 'size') this.size.handlePaste(text);
  }

  clicked(owner: unknown): void {
    if (owner === this.offset) this.focus = 'offset';
    else if (owner === this.size) this.focus = 'size';
  }

  render(ctx: Ctx, within: Rect): void {
    const { screen, theme } = ctx;
    const inner = dialog(ctx, 'Dump flash', Math.min(56, within.w - 2), 9, undefined, within);
    const bg = theme.inputBg;
    const x = inner.x + 2;
    const fx = x + 8;
    const field = (label: string, input: TextInput, y: number, f: Field, tip: string) => {
      screen.text(x, y, label, { fg: theme.dim, bg });
      ctx.hits.add({ x: fx, y, w: 14, h: 1 }, (e) => {
        if (e.action === 'down') this.focus = f;
      });
      input.render(ctx, { x: fx, y, w: 14, h: 1 }, this.focus === f);
      screen.text(fx + 15, y, truncate(tip, inner.x + inner.w - fx - 16), { fg: theme.dim, bg });
    };
    field('Offset', this.offset, inner.y + 1, 'offset', 'hex');
    field('Size', this.size, inner.y + 3, 'size', 'hex; empty: to the end');
    const button = (bx: number, y: number, text: string, f: Field) => {
      const t = ` ${text} `;
      const on = this.focus === f;
      screen.text(bx, y, t, {
        fg: on ? theme.selFg : theme.fg,
        bg: on ? theme.selBg : theme.border,
        attrs: on ? Attr.Bold : 0,
      });
      ctx.hits.add({ x: bx, y, w: stringWidth(t), h: 1 }, (e) => {
        if (e.action !== 'down') return;
        this.focus = f;
        this.activate(f);
      });
      return bx + stringWidth(t);
    };
    const by = inner.y + inner.h - 2;
    const bx = inner.x + Math.floor((inner.w - 18) / 2);
    button(button(bx, by, 'Read', 'read') + 2, by, 'Cancel', 'cancel');
  }
}
