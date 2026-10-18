import type { Ctx } from '../tui/context';
import { rows } from '../tui/layout';
import type { Rect } from '../tui/screen';
import { Attr } from '../tui/style';
import { padEnd } from '../tui/width';
import {
  Checkbox,
  type Focusable,
  ListView,
  panel,
  progressBar,
  RadioGroup,
  Select,
  TextInput,
} from '../tui/widgets';

export type Source = 'files' | 'github' | 'url';

export interface PartRow {
  enabled: boolean;
  offset: number;
  name: string;
  size: number;
}

/** Placeholder plan so the table can be explored before M1 adds real files. */
const EXAMPLE_PARTS: PartRow[] = [
  { enabled: true, offset: 0x0, name: 'bootloader.bin', size: 21_800 },
  { enabled: true, offset: 0x8000, name: 'partition-table.bin', size: 3_072 },
  { enabled: true, offset: 0xd000, name: 'ota_data_initial.bin', size: 8_192 },
  { enabled: true, offset: 0x10000, name: 'my-firmware.bin', size: 1_262_000 },
];

export const BAUD_RATES = [115200, 230400, 460800, 921600, 1500000, 2000000] as const;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

const hex6 = (n: number) => `0x${n.toString(16).padStart(6, '0')}`;

interface SimRun {
  start: number;
  /** Bytes per millisecond. */
  rate: number;
  total: number;
}

export class FlashPane {
  readonly source = new RadioGroup<Source>(
    [
      { value: 'files', label: 'Files' },
      { value: 'github', label: 'GitHub' },
      { value: 'url', label: 'URL' },
    ],
    'files',
  );
  readonly repo = new TextInput('', 'owner/repo or https://github.com/owner/repo');
  readonly url = new TextInput('', 'https://…/esp-web-tool.json');
  readonly parts = new ListView<PartRow>(
    EXAMPLE_PARTS.map((p) => ({ ...p })),
    (p, w) => {
      const box = p.enabled ? '[x]' : '[ ]';
      const size = formatSize(p.size).padStart(10);
      const nameW = Math.max(4, w - 3 - 1 - 8 - 2 - 10 - 1);
      return `${box} ${hex6(p.offset)}  ${padEnd(p.name, nameW)}${size}`;
    },
  );
  readonly baud = new Select(BAUD_RATES, BAUD_RATES.indexOf(921600));
  readonly eraseAll = new Checkbox('Erase all');
  readonly verify = new Checkbox('Verify', true);
  readonly resetAfter = new Checkbox('Reset after', true);

  private sim: SimRun | null = null;
  onSimDone?: () => void;

  constructor() {
    this.parts.onActivate = (p) => (p.enabled = !p.enabled);
  }

  /** Focus order within the pane; the URL/repo field only exists for those sources. */
  focusables(): Focusable[] {
    const input =
      this.source.value === 'github' ? [this.repo] : this.source.value === 'url' ? [this.url] : [];
    return [
      this.source,
      ...input,
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
    const total = this.parts.items.filter((p) => p.enabled).reduce((n, p) => n + p.size, 0);
    // Roughly what esptool achieves at 921600 baud with compression.
    this.sim = { start: now, rate: 0.6 * 1024, total };
  }

  render(ctx: Ctx, r: Rect, focus: Focusable | null): void {
    const { screen, theme } = ctx;
    const f = (w: Focusable) => w === focus;
    const [srcRow, inputRow, , partsRect, , optsRow, progRow] = rows(r, [
      1,
      1,
      1,
      { flex: 1 },
      1,
      1,
      1,
    ]);

    const label = (rect: Rect, text: string) => {
      screen.text(rect.x + 1, rect.y, text, { fg: theme.dim });
      return { x: rect.x + 10, y: rect.y, w: rect.w - 11, h: 1 };
    };

    this.source.render(ctx, label(srcRow!, 'Source'), f(this.source));
    if (this.source.value === 'github') {
      this.repo.render(ctx, label(inputRow!, 'Repo'), f(this.repo));
    } else if (this.source.value === 'url') {
      this.url.render(ctx, label(inputRow!, 'Manifest'), f(this.url));
    } else {
      const hint = 'a add  d delete  e edit offset  o open folder   (M1)';
      screen.text(inputRow!.x + 10, inputRow!.y, hint, { fg: theme.dim }, inputRow!.w - 11);
    }

    const title =
      this.source.value === 'files' ? 'Parts · example' : 'Parts · example (releases land in M3)';
    const inner = panel(ctx, partsRect!, title, f(this.parts), {
      right: `${this.parts.items.filter((p) => p.enabled).length}/${this.parts.items.length}`,
    });
    this.parts.render(ctx, inner, f(this.parts));

    let x = optsRow!.x + 1;
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
        'Ready.  f starts a simulated run (no device writes in M0)',
        { fg: theme.dim },
        r.w - 2,
      );
      return;
    }
    const done = Math.min(this.sim.total, (ctx.now - this.sim.start) * this.sim.rate);
    // Find the part currently being "written".
    let acc = 0;
    let current = '';
    for (const p of this.parts.items.filter((p) => p.enabled)) {
      current = p.name;
      if (done < acc + p.size) break;
      acc += p.size;
    }
    const frac = this.sim.total ? done / this.sim.total : 1;
    const pct = `${Math.floor(frac * 100)}%`.padStart(4);
    const rate = `${formatSize(this.sim.rate * 1000)}/s`;
    const nameW = Math.min(22, Math.floor(r.w / 3));
    screen.text(r.x + 1, r.y, padEnd(current, nameW), { fg: theme.fg });
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
