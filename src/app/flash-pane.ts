import type { FileHost } from '../flash/host';
import { FlashPlan, type SavedPlan } from '../flash/plan';
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
import type { JobRunner } from './jobs';
import { PartsTable } from './parts-table';

export { formatSize } from './format';

export const BAUD_RATES = [115200, 230400, 460800, 921600, 1500000, 2000000] as const;

/** What is kept per device across reloads (IndexedDB, SPEC §10). */
export interface SavedFlash {
  v: 1;
  /** The Manifest field's text. */
  field: string;
  plan: SavedPlan;
}

export const isSavedFlash = (v: unknown): v is SavedFlash =>
  typeof v === 'object' && v !== null && (v as SavedFlash).v === 1;

/**
 * The Flash pane (SPEC §5.2): one Manifest field (URL, folder URL, owner/repo, or a picked
 * file), Release and Set pickers when they apply, the editable parts table, and the options.
 */
export class FlashPane {
  readonly plan: FlashPlan;
  readonly manifest = new TextInput('', 'URL or owner/repo · Enter: a file');
  /** Indices into plan.releases / plan.manifest.sets. */
  readonly release: Select<number>;
  readonly set: Select<number>;
  readonly parts: PartsTable;
  readonly baud = new Select(BAUD_RATES, BAUD_RATES.indexOf(921600));
  readonly eraseAll = new Checkbox('Erase all');
  readonly verify = new Checkbox('Verify', true);
  readonly resetAfter = new Checkbox('Reset after', true);

  /** The flasher jobs, for the progress line (set by the App). */
  jobs: JobRunner | null = null;
  /** Enter was pressed in the Manifest field. */
  onSubmitted?: () => void;
  /** The release notes (`n`) and the manual-assist downloads (`m`) were clicked. */
  onNotes?: () => void;
  onDownloads?: () => void;

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

  save(): SavedFlash {
    return { v: 1, field: this.manifest.value, plan: this.plan.save() };
  }

  restore(saved: SavedFlash): void {
    this.manifest.setValue(saved.field);
    this.plan.restore(saved.plan);
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

  render(ctx: Ctx, r: Rect, focus: Focusable | null): void {
    const { screen, theme } = ctx;
    const plan = this.plan;
    const f = (w: Focusable) => w === focus;
    // Phones (SPEC §4.1): no field label, and the options take two rows.
    const narrow = r.w < 60;
    const [fieldRow, pickRow, statusRow, partsRect, , optsRow, progRow] = rows(r, [
      1,
      1,
      1,
      { flex: 1 },
      narrow ? 0 : 1,
      narrow ? 2 : 1,
      1,
    ]);

    // Manifest [ … ] Open…
    const label = narrow ? 0 : 10;
    if (!narrow) screen.text(fieldRow!.x + 1, fieldRow!.y, 'Manifest', { fg: theme.dim });
    const open = ' Open… ';
    const fieldX = fieldRow!.x + label;
    const fieldW = Math.max(8, fieldRow!.x + fieldRow!.w - fieldX - stringWidth(open) - 2);
    this.manifest.render(ctx, { x: fieldX, y: fieldRow!.y, w: fieldW, h: 1 }, f(this.manifest));
    const ox = fieldX + fieldW + 1;
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
      x += this.release.width + 1;
      if (plan.release?.body.trim()) {
        const notes = ' Notes ';
        screen.text(x, pickRow!.y, notes, { fg: theme.accent, bg: theme.inputBg });
        ctx.hits.add({ x, y: pickRow!.y, w: notes.length, h: 1 }, (e) => {
          if (e.action === 'down') this.onNotes?.();
        });
        x += notes.length;
      }
      x += 1;
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
      const icon =
        st.kind === 'loading'
          ? `${spinner(ctx)} `
          : st.kind === 'error'
            ? '✗ '
            : st.kind === 'manual'
              ? '↓ '
              : '';
      const color = {
        error: theme.error,
        ok: theme.fg,
        manual: theme.warn,
        loading: theme.dim,
        idle: theme.dim,
      }[st.kind];
      screen.text(statusRow!.x + 1, statusRow!.y, truncate(icon + st.text, statusRow!.w - 2), {
        fg: color,
      });
      // Manual assist: the status line opens the list of files to download.
      if (st.kind === 'manual')
        ctx.hits.add(statusRow!, (e) => e.action === 'down' && this.onDownloads?.());
    }

    const on = plan.rows.filter((p) => p.enabled).length;
    const red = plan.rows.some((p) => p.enabled && p.error);
    const inner = panel(ctx, partsRect!, 'Parts', f(this.parts), {
      right: `${on}/${plan.rows.length}`,
      color: red ? theme.error : undefined,
    });
    this.parts.render(ctx, inner, f(this.parts));

    // The options flow on, wrapping to the next row when the pane is narrow.
    const o = optsRow!;
    let y = o.y;
    x = o.x + 1;
    screen.text(x, y, 'Baud', { fg: theme.dim });
    x += 5;
    this.baud.render(ctx, { x, y, w: this.baud.width, h: 1 }, f(this.baud));
    x += this.baud.width + 2;
    for (const cb of [this.eraseAll, this.verify, this.resetAfter]) {
      if (x + cb.width > o.x + o.w) {
        if (y + 1 >= o.y + o.h) break;
        y++;
        x = o.x + 1;
      }
      cb.render(ctx, { x, y, w: cb.width, h: 1 }, f(cb));
      x += cb.width + 2;
    }

    this.renderProgress(ctx, progRow!);
  }

  /** The running job (step, bar, %, rate), else how the last one ended, else a hint. */
  private renderProgress(ctx: Ctx, r: Rect): void {
    const { screen, theme } = ctx;
    const job = this.jobs?.state;
    const last = this.jobs?.last;
    const w = r.w - 2;
    if (!job) {
      if (last) {
        const [mark, color] = last.ok ? ['✓ ', theme.ok] : ['✗ ', theme.error];
        screen.text(r.x + 1, r.y, truncate(mark + last.text, w), { fg: color });
      } else {
        const hint = 'F flash · E erase · D dump · i chip info';
        screen.text(r.x + 1, r.y, truncate(hint, w), { fg: theme.dim });
      }
      return;
    }
    const nameW = Math.min(22, Math.floor(r.w / 3));
    screen.text(r.x + 1, r.y, padEnd(truncate(job.step, nameW), nameW), { fg: theme.fg });
    const secs = (ctx.now - job.since) / 1000;
    const rate = job.bytes && secs > 0.3 ? `${formatSize(job.bytes / secs)}/s` : '';
    const pct = job.fraction === null ? '' : `${Math.floor(job.fraction * 100)}%`.padStart(4);
    const tail = [pct, rate].filter(Boolean).join('  ');
    const barW = Math.max(4, r.w - nameW - 4 - stringWidth(tail));
    if (job.fraction === null) {
      screen.text(r.x + 2 + nameW, r.y, spinner(ctx), { fg: theme.accent });
    } else {
      progressBar(ctx, r.x + 2 + nameW, r.y, barW, job.fraction, {
        fg: theme.ok,
        bg: theme.inputBg,
      });
    }
    screen.text(r.x + 3 + nameW + barW, r.y, tail, { fg: theme.fg, attrs: Attr.Bold });
    ctx.invalidate();
  }
}
