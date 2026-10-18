import { formatOffset, parseOffset } from '../flash/offsets';
import type { FlashPlan, PartSource, PlanRow } from '../flash/plan';
import type { LocalFile } from '../flash/host';
import type { KeyEvent } from '../tty/input';
import type { Ctx } from '../tui/context';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import { dialog, TextInput } from '../tui/widgets';
import { stringWidth, truncate } from '../tui/width';

type Field = 'offset' | 'file' | 'browse' | 'save' | 'cancel';
const ORDER: Field[] = ['offset', 'file', 'browse', 'save', 'cancel'];

/**
 * The Edit part / Add part dialog (SPEC §5.2): the offset, and the file as a path (relative to
 * the manifest), a URL on any host, or a local file from Browse…. Enter saves, Esc cancels.
 * In Add mode an empty offset is guessed, and Enter on an empty File field opens the picker.
 */
export class PartEditor {
  readonly offset: TextInput;
  readonly file: TextInput;
  focus: Field;
  /** The picked file, while the File field still shows its name. */
  private picked: LocalFile | null = null;
  private readonly original: string;

  constructor(
    private plan: FlashPlan,
    /** The row being edited; null adds a new part. */
    readonly row: PlanRow | null,
    private close: () => void,
    private notify: (text: string) => void,
  ) {
    this.offset = new TextInput(row ? formatOffset(row.offset) : '', 'auto');
    this.original = row ? (row.path ?? row.name) : '';
    this.file = new TextInput(this.original, 'path or URL · Enter: Browse…');
    this.focus = row ? 'offset' : 'file';
  }

  get title(): string {
    return this.row ? 'Edit part' : 'Add part';
  }

  /** Must run synchronously from a key press or click (it opens the file picker). */
  browse(): void {
    void this.plan.browse(!this.row).then((files) => {
      if (files.length > 1) {
        // Several files at once are added straight away, each at a guessed offset.
        for (const file of files) this.plan.addPart({ file }, null);
        this.close();
      } else if (files[0]) {
        this.picked = files[0];
        this.file.setValue(files[0].name);
        this.focus = 'save';
      }
    });
  }

  save(): void {
    const text = this.offset.value.trim();
    const offset = text ? parseOffset(text) : null;
    if (offset === null && (text || this.row)) {
      this.notify(`Not a hex offset: ${text || '(empty)'}`);
      this.focus = 'offset';
      return;
    }
    const path = this.file.value.trim();
    let source: PartSource | null = null;
    if (this.picked && path === this.picked.name) source = { file: this.picked };
    else if (path && path !== this.original) source = { path };
    if (this.row) {
      this.plan.editRow(this.row, offset!, source);
    } else {
      if (!source) {
        this.notify('Type a path or URL, or Browse… for a file');
        this.focus = 'file';
        return;
      }
      this.plan.addPart(source, offset);
    }
    this.close();
  }

  private activate(f: Field): void {
    if (f === 'browse') this.browse();
    else if (f === 'cancel') this.close();
    else if (f === 'file' && !this.row && !this.file.value.trim()) this.browse();
    else this.save();
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
    else if (this.focus === 'file') {
      this.file.handleKey(e);
      if (this.picked && this.file.value !== this.picked.name) this.picked = null;
    } else if (e.name === ' ') this.activate(this.focus);
  }

  /** A click landed on `owner` (from the hit map): a click in a field focuses it. */
  clicked(owner: unknown): void {
    if (owner === this.offset) this.focus = 'offset';
    else if (owner === this.file) this.focus = 'file';
  }

  handlePaste(text: string): void {
    if (this.focus === 'offset') this.offset.handlePaste(text);
    if (this.focus === 'file') this.file.handlePaste(text);
  }

  render(ctx: Ctx, within: Rect): void {
    const { screen, theme } = ctx;
    const w = Math.min(64, within.w - 2);
    const inner = dialog(ctx, this.title, w, 10, undefined, within);
    const bg = theme.inputBg;
    const x = inner.x + 2;
    const fieldX = x + 8;
    const label = (y: number, text: string) => screen.text(x, y, text, { fg: theme.dim, bg });
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
    // The input's own hit (which places the cursor) sits on top; see clicked().
    const field = (input: TextInput, y: number, w: number, f: Field) => {
      ctx.hits.add({ x: fieldX, y, w, h: 1 }, (e) => {
        if (e.action === 'down') this.focus = f;
      });
      input.render(ctx, { x: fieldX, y, w, h: 1 }, this.focus === f);
    };

    const y0 = inner.y + 1;
    label(y0, 'Offset');
    field(this.offset, y0, 12, 'offset');
    const tip = this.row ? 'hex, e.g. 0x10000' : 'hex; empty: guess from the name';
    screen.text(fieldX + 13, y0, truncate(tip, inner.x + inner.w - fieldX - 14), {
      fg: theme.dim,
      bg,
    });

    label(y0 + 2, 'File');
    const browse = ' Browse… ';
    const fileW = Math.max(10, inner.x + inner.w - fieldX - stringWidth(browse) - 3);
    field(this.file, y0 + 2, fileW, 'file');
    button(fieldX + fileW + 1, y0 + 2, 'Browse…', 'browse');
    const hint = 'a path relative to the manifest, any URL, or Browse…';
    screen.text(fieldX, y0 + 3, truncate(hint, inner.x + inner.w - fieldX - 1), {
      fg: theme.dim,
      bg,
    });

    const by = inner.y + inner.h - 2;
    const bx = inner.x + Math.floor((inner.w - 20) / 2);
    button(button(bx, by, 'Save', 'save') + 2, by, 'Cancel', 'cancel');
  }
}
