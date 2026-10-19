import type { FlashPlan, PlanRow } from '../flash/plan';
import { formatOffset } from '../flash/offsets';
import type { KeyEvent } from '../tty/input';
import type { Ctx } from '../tui/context';
import type { Rect } from '../tui/screen';
import { Attr, type Style } from '../tui/style';
import { type Focusable, spinner } from '../tui/widgets';
import { padEnd, stringWidth, truncate } from '../tui/width';
import { formatSize } from './format';

type Notify = (text: string, kind: 'info' | 'warn' | 'error') => void;

/**
 * The editable parts table (SPEC §5.2). Rows are always editable by key or mouse, except
 * those the manifest locks: `a` add, `e`/Enter edit (offset and file, in a dialog), `d`
 * delete, `Space` toggle, `o` grant access to local files. The last row is `+ add part`.
 */
export class PartsTable implements Focusable {
  selected = 0;
  private scroll = 0;
  private lastHeight = 1;
  onNotify?: Notify;
  /** Show what to download by hand (manual assist). */
  onDownloads?: () => void;
  /** Open the part dialog for `row`, or for a new part when null. */
  onEdit?: (row: PlanRow | null) => void;

  constructor(private plan: FlashPlan) {}

  private get rows(): PlanRow[] {
    return this.plan.rows;
  }

  /** The selected row, or null on the `+ add file` line. */
  private get current(): PlanRow | null {
    return this.rows[this.selected] ?? null;
  }

  private locked(row: PlanRow): boolean {
    if (row.locked) this.onNotify?.(`${row.name} is locked by the manifest`, 'warn');
    return row.locked;
  }

  // ---------------------------------------------------------------------------
  // Actions (pickers run synchronously, inside the key press or click)

  add(): void {
    this.onEdit?.(null);
  }

  edit(row: PlanRow): void {
    if (!this.locked(row)) this.onEdit?.(row);
  }

  remove(row: PlanRow): void {
    if (this.locked(row)) return;
    this.plan.deleteRow(row);
    this.selected = Math.min(this.selected, this.rows.length);
  }

  toggle(row: PlanRow): void {
    if (!this.locked(row)) this.plan.toggle(row);
  }

  // ---------------------------------------------------------------------------
  // Drawing

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    let body = r;
    const access = this.plan.access;
    const downloads = !access && this.plan.downloads.length > 0;
    if (downloads) {
      const msg = '↓ Release files: download them, then drop or pick them (m, or click)';
      screen.text(r.x, r.y, truncate(msg, r.w), { fg: theme.warn });
      ctx.hits.add({ x: r.x, y: r.y, w: r.w, h: 1 }, (e) => {
        if (e.action === 'down') this.onDownloads?.();
      });
      body = { ...r, y: r.y + 1, h: r.h - 1 };
    } else if (access) {
      const msg =
        access === 'folder'
          ? '! Parts sit next to the manifest: o (or click) to grant its folder'
          : '! Local files need your permission again: o (or click) to allow';
      screen.text(r.x, r.y, truncate(msg, r.w), { fg: theme.warn });
      ctx.hits.add({ x: r.x, y: r.y, w: r.w, h: 1 }, (e) => {
        if (e.action === 'down') this.plan.grantAccess();
      });
      body = { ...r, y: r.y + 1, h: r.h - 1 };
    }
    const count = this.rows.length + 1; // + the add line
    this.lastHeight = Math.max(1, body.h);
    this.selected = Math.max(0, Math.min(this.selected, count - 1));
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + body.h) this.scroll = this.selected - body.h + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, count - body.h));

    for (let line = 0; line < body.h; line++) {
      const i = this.scroll + line;
      if (i >= count) break;
      const y = body.y + line;
      const sel = i === this.selected;
      const bg = sel ? (focused ? theme.selBg : theme.inputBg) : undefined;
      screen.fill({ x: body.x, y, w: body.w, h: 1 }, ' ', { bg });
      const row = this.rows[i];
      if (row) this.drawRow(ctx, row, { x: body.x, y, w: body.w, h: 1 }, sel, focused, bg);
      else this.drawAddLine(ctx, { x: body.x, y, w: body.w, h: 1 }, sel, bg);
    }
    if (this.rows.length === 0 && body.h > 3) {
      const hint = 'No parts yet: load a manifest above, or add parts (a)';
      screen.text(body.x + 2, body.y + 2, truncate(hint, body.w - 2), { fg: theme.dim });
    }
    ctx.hits.add(
      body,
      (e) => {
        if (e.action === 'wheelup') this.selected = Math.max(0, this.selected - 3);
        else if (e.action === 'wheeldown') this.selected = Math.min(count - 1, this.selected + 3);
        else if (e.action === 'down') {
          const i = this.scroll + (e.y - body.y);
          if (i < count) this.selected = i;
        }
      },
      this,
    );
  }

  /** `▶ [x] 0x010000  my-fw.bin ……… 1.2 MiB ✕`, with click zones per column. */
  private drawRow(
    ctx: Ctx,
    row: PlanRow,
    r: Rect,
    sel: boolean,
    focused: boolean,
    bg: number | undefined,
  ): void {
    const { screen, theme } = ctx;
    const base: Style = { fg: sel && focused ? theme.selFg : theme.fg, bg };
    const dim: Style = { fg: theme.dim, bg };
    const red: Style = { fg: theme.error, bg };
    // Narrow (phones): sizes only on the selected row; errors and loading always show.
    const narrow = r.w < 50;
    const right = row.loading
      ? `${spinner(ctx)} loading`
      : row.error
        ? row.error
        : narrow && !sel
          ? ''
          : formatSize(row.data?.length ?? 0);
    const del = sel && !row.locked ? ' ✕' : '';
    const rightW = right ? Math.min(Math.max(10, stringWidth(right)), Math.floor(r.w / 2)) : 0;
    let x = r.x;
    screen.text(x, r.y, sel ? '▶' : ' ', base);
    x += 2;
    const box = row.enabled ? '[x]' : '[ ]';
    screen.text(x, r.y, box, row.locked ? dim : base);
    const boxX = x;
    x += 4;
    const offX = x;
    x = screen.text(x, r.y, formatOffset(row.offset), row.locked ? dim : base);
    if (row.offsetGuessed) screen.text(x, r.y, '?', { fg: theme.warn, bg, attrs: Attr.Bold });
    x = offX + 10;
    const nameW = Math.max(4, r.x + r.w - x - rightW - 1 - stringWidth(del));
    const tag = row.locked ? ' (locked)' : '';
    const name = truncate(row.name, Math.max(1, nameW - stringWidth(tag)));
    let nx = screen.text(x, r.y, name, row.error ? red : base);
    screen.text(nx, r.y, tag, dim);
    nx = x + nameW;
    screen.text(nx + 1, r.y, padEnd(truncate(right, rightW), rightW), row.error ? red : dim);
    if (del) screen.text(r.x + r.w - 2, r.y, del, red);

    const at = (x0: number, w: number, fn: () => void) =>
      ctx.hits.add(
        { x: x0, y: r.y, w, h: 1 },
        (e) => {
          if (e.action !== 'down') return;
          this.selected = this.rows.indexOf(row);
          fn();
        },
        this,
      );
    at(boxX, 3, () => this.toggle(row));
    // A click on the selected row's offset or name edits it; on another row it just selects.
    at(offX, nameW + 10, () => sel && this.edit(row));
    if (del) at(r.x + r.w - 2, 2, () => this.remove(row));
  }

  private drawAddLine(ctx: Ctx, r: Rect, sel: boolean, bg: number | undefined): void {
    const { screen, theme } = ctx;
    screen.text(r.x, r.y, sel ? '▶' : ' ', { fg: theme.fg, bg });
    screen.text(r.x + 2, r.y, '+ add part', { fg: sel ? theme.accent : theme.dim, bg });
    ctx.hits.add({ x: r.x, y: r.y, w: 12, h: 1 }, (e) => e.action === 'down' && this.add(), this);
  }

  // ---------------------------------------------------------------------------
  // Keys

  handleKey(e: KeyEvent): boolean {
    const count = this.rows.length + 1;
    const page = Math.max(1, this.lastHeight - 1);
    const row = this.current;
    switch (e.name) {
      case 'up':
      case 'k':
        this.selected = Math.max(0, this.selected - 1);
        return true;
      case 'down':
      case 'j':
        this.selected = Math.min(count - 1, this.selected + 1);
        return true;
      case 'pageup':
        this.selected = Math.max(0, this.selected - page);
        return true;
      case 'pagedown':
        this.selected = Math.min(count - 1, this.selected + page);
        return true;
      case 'home':
      case 'g':
        this.selected = 0;
        return true;
      case 'end':
      case 'G':
        this.selected = count - 1;
        return true;
      case 'a':
        this.add();
        return true;
      case 'o':
        this.plan.grantAccess();
        return true;
      case 'enter':
        if (row) this.edit(row);
        else this.add();
        return true;
    }
    if (!row) return false;
    switch (e.name) {
      case ' ':
        this.toggle(row);
        return true;
      case 'e':
        this.edit(row);
        return true;
      case 'd':
      case 'delete':
        this.remove(row);
        return true;
    }
    return false;
  }
}
