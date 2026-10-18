import type { FileHost } from '../flash/host';
import { FlashPlan } from '../flash/plan';
import type { Ctx } from '../tui/context';
import { rows } from '../tui/layout';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import {
  Checkbox,
  type Focusable,
  panel,
  progressBar,
  Select,
  spinner,
  TextInput,
} from '../tui/widgets';
import { padEnd, stringWidth, truncate } from '../tui/width';
import { formatSize } from './format';
import { PartsTable } from './parts-table';

export { formatSize } from './format';

export const BAUD_RATES = [115200, 230400, 460800, 921600, 1500000, 2000000] as const;

interface SimRun {
  start: number;
  /** Bytes per millisecond. */
  rate: number;
  total: number;
}

/**
 * The Flash pane (SPEC §5.2): one Manifest field (URL, folder URL, owner/repo, or a picked
 * file), Release and Set pickers when they apply, the editable parts table, and the options.
 */
export class FlashPane {
  readonly plan: FlashPlan;
  readonly manifest = new TextInput('', 'URL, folder URL or owner/repo · Enter when empty: a file');
  /** Indices into plan.releases / plan.manifest.sets. */
  readonly release: Select<number>;
  readonly set: Select<number>;
  readonly parts: PartsTable;
  readonly baud = new Select(BAUD_RATES, BAUD_RATES.indexOf(921600));
  readonly eraseAll = new Checkbox('Erase all');
  readonly verify = new Checkbox('Verify', true);
  readonly resetAfter = new Checkbox('Reset after', true);

  private sim: SimRun | null = null;
  onSimDone?: () => void;
  /** Enter was pressed in the Manifest field. */
  onSubmitted?: () => void;

  constructor(host: FileHost, onChange: () => void, proxy?: string) {
    const plan = (this.plan = new FlashPlan(host, onChange, proxy));
    this.parts = new PartsTable(plan);
    this.release = new Select<number>([], 0, (i) => {
      const r = plan.releases?.[i];
      return r ? `${r.tag}${r.prerelease ? ' (pre)' : ''}` : '—';
    });
    this.set = new Select<number>([], 0, (i) => plan.manifest?.sets[i]?.name ?? '—');
    // Enter: an empty field opens the file picker; the picked file's name re-reads it.
    this.manifest.onSubmit = (value) => {
      const v = value.trim();
      if (!v) plan.openFile();
      else if (v === plan.localName) plan.reload();
      else void plan.load(v);
      this.onSubmitted?.();
    };
    plan.onFile = (name) => this.manifest.setValue(name);
    plan.onSet = (set) => {
      if (set.eraseAll !== undefined) this.eraseAll.checked = set.eraseAll;
      const i = BAUD_RATES.indexOf(set.baudrate as (typeof BAUD_RATES)[number]);
      if (i >= 0) this.baud.index = i;
    };
  }

  /** Focus order; the pickers only exist when there is something to pick. */
  focusables(): Focusable[] {
    const pickers: Focusable[] = [];
    if (this.plan.releases?.length) pickers.push(this.release);
    if ((this.plan.manifest?.sets.length ?? 0) > 1) pickers.push(this.set);
    return [
      this.manifest,
      ...pickers,
      this.parts,
      this.baud,
      this.eraseAll,
      this.verify,
      this.resetAfter,
    ];
  }

  get running(): boolean {
    return this.sim !== null;
  }

  /** M0 only: animate a flash run without touching a device. */
  simulate(now: number): void {
    const total = this.plan.rows
      .filter((p) => p.enabled)
      .reduce((n, p) => n + (p.data?.length ?? 0), 0);
    // Roughly what esptool achieves at 921600 baud with compression.
    this.sim = { start: now, rate: 0.6 * 1024, total };
  }

  render(ctx: Ctx, r: Rect, focus: Focusable | null): void {
    const { screen, theme } = ctx;
    const plan = this.plan;
    const f = (w: Focusable) => w === focus;
    const [fieldRow, pickRow, statusRow, partsRect, , optsRow, progRow] = rows(r, [
      1,
      1,
      1,
      { flex: 1 },
      1,
      1,
      1,
    ]);

    // Manifest [ … ] Open…
    screen.text(fieldRow!.x + 1, fieldRow!.y, 'Manifest', { fg: theme.dim });
    const open = ' Open… ';
    const fieldW = Math.max(8, fieldRow!.w - 11 - stringWidth(open) - 1);
    this.manifest.render(
      ctx,
      { x: fieldRow!.x + 10, y: fieldRow!.y, w: fieldW, h: 1 },
      f(this.manifest),
    );
    const ox = fieldRow!.x + 10 + fieldW + 1;
    screen.text(ox, fieldRow!.y, open, { fg: theme.fg, bg: theme.inputBg });
    ctx.hits.add(
      { x: ox, y: fieldRow!.y, w: stringWidth(open), h: 1 },
      (e) => e.action === 'down' && plan.openFile(),
      this.manifest,
    );

    // Release ▾  Set ▾ (only when there is a choice)
    let x = pickRow!.x + 1;
    if (plan.releases?.length) {
      this.release.values = plan.releases.map((_, i) => i);
      this.release.index = Math.max(0, plan.releaseIndex);
      x = screen.text(x, pickRow!.y, 'Release ', { fg: theme.dim });
      this.release.render(ctx, { x, y: pickRow!.y, w: this.release.width, h: 1 }, f(this.release));
      x += this.release.width + 2;
    }
    const sets = plan.manifest?.sets ?? [];
    if (sets.length > 1) {
      this.set.values = sets.map((_, i) => i);
      this.set.index = plan.setIndex;
      x = screen.text(x, pickRow!.y, 'Set ', { fg: theme.dim });
      const w = Math.min(this.set.width, pickRow!.x + pickRow!.w - x);
      this.set.render(ctx, { x, y: pickRow!.y, w, h: 1 }, f(this.set));
    }

    // Status of the manifest: name and sets, an error, or what is loading.
    const st = plan.status;
    if (st.text) {
      const icon = st.kind === 'loading' ? `${spinner(ctx)} ` : st.kind === 'error' ? '✗ ' : '';
      const color = st.kind === 'error' ? theme.error : st.kind === 'ok' ? theme.fg : theme.dim;
      screen.text(statusRow!.x + 1, statusRow!.y, truncate(icon + st.text, statusRow!.w - 2), {
        fg: color,
      });
    }

    const on = plan.rows.filter((p) => p.enabled).length;
    const red = plan.rows.some((p) => p.enabled && p.error);
    const inner = panel(ctx, partsRect!, 'Parts', f(this.parts), {
      right: `${on}/${plan.rows.length}`,
      color: red ? theme.error : undefined,
    });
    this.parts.render(ctx, inner, f(this.parts));

    x = optsRow!.x + 1;
    screen.text(x, optsRow!.y, 'Baud', { fg: theme.dim });
    x += 5;
    this.baud.render(ctx, { x, y: optsRow!.y, w: this.baud.width, h: 1 }, f(this.baud));
    x += this.baud.width + 2;
    for (const cb of [this.eraseAll, this.verify, this.resetAfter]) {
      if (x + cb.width > optsRow!.x + optsRow!.w) break;
      cb.render(ctx, { x, y: optsRow!.y, w: cb.width, h: 1 }, f(cb));
      x += cb.width + 2;
    }

    this.renderProgress(ctx, progRow!);
  }

  private renderProgress(ctx: Ctx, r: Rect): void {
    const { screen, theme } = ctx;
    if (!this.sim) {
      screen.text(
        r.x + 1,
        r.y,
        'Ready.  F starts a simulated run (no device writes yet)',
        { fg: theme.dim },
        r.w - 2,
      );
      return;
    }
    const done = Math.min(this.sim.total, (ctx.now - this.sim.start) * this.sim.rate);
    // Find the part currently being "written".
    let acc = 0;
    let current = '';
    for (const p of this.plan.rows.filter((p) => p.enabled)) {
      current = p.name;
      const size = p.data?.length ?? 0;
      if (done < acc + size) break;
      acc += size;
    }
    const frac = this.sim.total ? done / this.sim.total : 1;
    const pct = `${Math.floor(frac * 100)}%`.padStart(4);
    const rate = `${formatSize(this.sim.rate * 1000)}/s`;
    const nameW = Math.min(22, Math.floor(r.w / 3));
    screen.text(r.x + 1, r.y, padEnd(truncate(current, nameW), nameW), { fg: theme.fg });
    const barW = Math.max(4, r.w - nameW - 2 - pct.length - rate.length - 4);
    progressBar(ctx, r.x + 2 + nameW, r.y, barW, frac, { fg: theme.ok, bg: theme.inputBg });
    screen.text(r.x + 3 + nameW + barW, r.y, `${pct}  ${rate}`, { fg: theme.fg, attrs: Attr.Bold });
    if (done >= this.sim.total) {
      this.sim = null;
      this.onSimDone?.();
    }
    ctx.invalidate();
  }
}
