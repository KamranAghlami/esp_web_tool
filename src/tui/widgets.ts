import type { KeyEvent, MouseEvent } from '../tty/input';
import type { Ctx } from './context';
import { centered } from './layout';
import type { BoxStyle, Rect } from './screen';
import { Attr, type Style } from './style';
import { charWidth, padEnd, stringWidth, truncate } from './width';

/** A widget that can take keyboard focus. */
export interface Focusable {
  render(ctx: Ctx, rect: Rect, focused: boolean): void;
  /** Return true if the key was consumed. */
  handleKey(e: KeyEvent): boolean;
  handlePaste?(text: string): void;
  /** True while the widget wants printable keys (so global hotkeys must not fire). */
  readonly capturesText?: boolean;
}

/** Box with a title set into the top border, e.g. `┌─ Parts ───┐`. */
export function panel(
  ctx: Ctx,
  r: Rect,
  title: string,
  focused: boolean,
  opts: { color?: number; right?: string; kind?: BoxStyle; bg?: number } = {},
): Rect {
  const { screen, theme } = ctx;
  const color = opts.color ?? (focused ? theme.borderFocus : theme.border);
  screen.box(r, { fg: color, bg: opts.bg }, opts.kind);
  if (title && r.w > 6) {
    const t = truncate(title, r.w - 6);
    screen.text(r.x + 2, r.y, ` ${t} `, {
      fg: focused ? color : theme.title,
      bg: opts.bg,
      attrs: focused ? Attr.Bold : 0,
    });
  }
  if (opts.right && r.w > stringWidth(title) + stringWidth(opts.right) + 10) {
    const s = ` ${opts.right} `;
    screen.text(r.x + r.w - 2 - stringWidth(s), r.y, s, { fg: theme.dim, bg: opts.bg });
  }
  return { x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) };
}

/** Eighth-block progress bar; `fraction` in [0, 1]. */
export function progressBar(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  fraction: number,
  style: Style,
): void {
  const blocks = ' ▏▎▍▌▋▊▉█';
  const f = Math.min(1, Math.max(0, fraction));
  const eighths = Math.round(f * w * 8);
  for (let i = 0; i < w; i++) {
    const n = Math.min(8, Math.max(0, eighths - i * 8));
    ctx.screen.set(x + i, y, blocks[n]!, { fg: style.fg, bg: style.bg });
  }
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

let stillSpinners = false;

/** `prefers-reduced-motion`: spinners stand still (SPEC §4, accessibility). */
export function setReducedMotion(on: boolean): void {
  stillSpinners = on;
}

export function spinner(ctx: Ctx): string {
  if (stillSpinners) return '…';
  ctx.invalidate();
  return SPINNER[Math.floor(ctx.now / 80) % SPINNER.length]!;
}

export function isPrintable(e: KeyEvent): boolean {
  return !e.ctrl && !e.alt && [...e.name].length === 1 && charWidth(e.name.codePointAt(0)!) > 0;
}

// ---------------------------------------------------------------------------

export class ListView<T> implements Focusable {
  selected = 0;
  private scroll = 0;
  private lastHeight = 1;

  constructor(
    public items: T[],
    private renderItem: (item: T, width: number) => string,
    public onActivate?: (item: T, index: number) => void,
  ) {}

  get current(): T | undefined {
    return this.items[this.selected];
  }

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    this.lastHeight = Math.max(1, r.h);
    this.clamp();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + r.h) this.scroll = this.selected - r.h + 1;

    for (let row = 0; row < r.h; row++) {
      const idx = this.scroll + row;
      const item = this.items[idx];
      if (item === undefined) break;
      const sel = idx === this.selected;
      const style: Style = sel
        ? { fg: focused ? theme.selFg : theme.fg, bg: focused ? theme.selBg : theme.inputBg }
        : { fg: theme.fg };
      const marker = sel ? '▶' : ' ';
      screen.text(r.x, r.y + row, padEnd(`${marker}${this.renderItem(item, r.w - 1)}`, r.w), style);
    }

    if (this.items.length > r.h && r.w > 0) {
      // Scrollbar thumb in the rightmost column.
      const thumb = Math.max(1, Math.floor((r.h * r.h) / this.items.length));
      const top = Math.floor(((r.h - thumb) * this.scroll) / Math.max(1, this.items.length - r.h));
      for (let i = 0; i < r.h; i++) {
        screen.set(r.x + r.w - 1, r.y + i, i >= top && i < top + thumb ? '┃' : '│', {
          fg: theme.border,
        });
      }
    }

    ctx.hits.add(r, (e) => this.handleMouse(e, r), this);
  }

  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
  }

  handleKey(e: KeyEvent): boolean {
    const page = Math.max(1, this.lastHeight - 1);
    switch (e.name) {
      case 'up':
      case 'k':
        this.selected--;
        break;
      case 'down':
      case 'j':
        this.selected++;
        break;
      case 'pageup':
        this.selected -= page;
        break;
      case 'pagedown':
        this.selected += page;
        break;
      case 'home':
      case 'g':
        this.selected = 0;
        break;
      case 'end':
      case 'G':
        this.selected = this.items.length - 1;
        break;
      case 'enter': {
        const item = this.current;
        if (item !== undefined) this.onActivate?.(item, this.selected);
        return true;
      }
      default:
        return false;
    }
    this.clamp();
    return true;
  }

  private handleMouse(e: MouseEvent, r: Rect): void {
    if (e.action === 'wheelup') this.selected = Math.max(0, this.selected - 3);
    else if (e.action === 'wheeldown')
      this.selected = Math.min(this.items.length - 1, this.selected + 3);
    else if (e.action === 'down') {
      const idx = this.scroll + (e.y - r.y);
      if (idx < this.items.length) {
        if (idx === this.selected && this.current !== undefined)
          this.onActivate?.(this.current, idx);
        this.selected = idx;
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class TextInput implements Focusable {
  readonly capturesText = true;
  private cursor: number;
  private scroll = 0;

  constructor(
    public value = '',
    public placeholder = '',
    public onSubmit?: (value: string) => void,
  ) {
    this.cursor = [...value].length;
  }

  /** Replace the text, with the cursor at the end. */
  setValue(value: string): void {
    this.value = value;
    this.cursor = [...value].length;
  }

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    const chars = [...this.value];
    const inner = Math.max(1, r.w - 2);
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor - this.scroll >= inner) this.scroll = this.cursor - inner + 1;

    const bracket = { fg: focused ? theme.borderFocus : theme.border };
    screen.text(r.x, r.y, '[', bracket);
    screen.text(r.x + r.w - 1, r.y, ']', bracket);
    const field = { x: r.x + 1, y: r.y, w: inner, h: 1 };
    screen.fill(field, ' ', { bg: theme.inputBg });
    if (chars.length === 0 && !focused) {
      screen.text(field.x, field.y, truncate(this.placeholder, inner), {
        fg: theme.dim,
        bg: theme.inputBg,
      });
    } else {
      screen.text(
        field.x,
        field.y,
        chars.slice(this.scroll).join(''),
        { fg: theme.fg, bg: theme.inputBg },
        inner,
      );
    }
    if (focused) {
      ctx.cursor.visible = true;
      ctx.cursor.x = field.x + stringWidth(chars.slice(this.scroll, this.cursor).join(''));
      ctx.cursor.y = field.y;
    }
    ctx.hits.add(
      field,
      (e) => {
        if (e.action === 'down')
          this.cursor = Math.min(chars.length, this.scroll + (e.x - field.x));
      },
      this,
    );
  }

  handleKey(e: KeyEvent): boolean {
    const chars = [...this.value];
    if (isPrintable(e)) {
      chars.splice(this.cursor++, 0, e.name);
    } else if (e.ctrl && e.name === 'u') {
      chars.splice(0, this.cursor);
      this.cursor = 0;
    } else if (e.ctrl && e.name === 'w') {
      let i = this.cursor;
      while (i > 0 && chars[i - 1] === ' ') i--;
      while (i > 0 && chars[i - 1] !== ' ') i--;
      chars.splice(i, this.cursor - i);
      this.cursor = i;
    } else {
      switch (e.name) {
        case 'backspace':
          if (this.cursor > 0) chars.splice(--this.cursor, 1);
          break;
        case 'delete':
          chars.splice(this.cursor, 1);
          break;
        case 'left':
          this.cursor = Math.max(0, this.cursor - 1);
          break;
        case 'right':
          this.cursor = Math.min(chars.length, this.cursor + 1);
          break;
        case 'home':
          this.cursor = 0;
          break;
        case 'end':
          this.cursor = chars.length;
          break;
        case 'enter':
          this.onSubmit?.(this.value);
          return true;
        default:
          if (e.ctrl && e.name === 'a') this.cursor = 0;
          else if (e.ctrl && e.name === 'e') this.cursor = chars.length;
          else return false;
      }
    }
    this.value = chars.join('');
    return true;
  }

  handlePaste(text: string): void {
    const chars = [...this.value];
    const ins = [...text.replace(/[\r\n]+/g, ' ')];
    chars.splice(this.cursor, 0, ...ins);
    this.cursor += ins.length;
    this.value = chars.join('');
  }
}

// ---------------------------------------------------------------------------

export class Checkbox implements Focusable {
  constructor(
    public label: string,
    public checked = false,
  ) {}

  get width(): number {
    return stringWidth(this.label) + 4;
  }

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    const box = this.checked ? '[x]' : '[ ]';
    const style = focused ? { fg: theme.selFg, bg: theme.selBg } : { fg: theme.fg };
    screen.text(r.x, r.y, `${box} ${this.label}`, style, r.w);
    ctx.hits.add(
      { x: r.x, y: r.y, w: Math.min(r.w, this.width), h: 1 },
      (e) => {
        if (e.action === 'down') this.checked = !this.checked;
      },
      this,
    );
  }

  handleKey(e: KeyEvent): boolean {
    if (e.name === ' ' || e.name === 'enter') {
      this.checked = !this.checked;
      return true;
    }
    return false;
  }
}

/** Inline choice: `(•) Files  ( ) GitHub  ( ) URL`; arrows or space change it. */
export class RadioGroup<T extends string> implements Focusable {
  constructor(
    public options: readonly { value: T; label: string }[],
    public value: T,
    public onChange?: (value: T) => void,
  ) {}

  private set(i: number): void {
    const n = this.options.length;
    const opt = this.options[((i % n) + n) % n]!;
    if (opt.value !== this.value) {
      this.value = opt.value;
      this.onChange?.(opt.value);
    }
  }

  private get index(): number {
    return this.options.findIndex((o) => o.value === this.value);
  }

  cycle(): void {
    this.set(this.index + 1);
  }

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    let x = r.x;
    this.options.forEach((o, i) => {
      const on = o.value === this.value;
      const text = `(${on ? '•' : ' '}) ${o.label}`;
      const style: Style =
        on && focused ? { fg: theme.selFg, bg: theme.selBg } : { fg: on ? theme.accent : theme.fg };
      const end = screen.text(x, r.y, text, style, r.x + r.w - x);
      ctx.hits.add(
        { x, y: r.y, w: end - x, h: 1 },
        (e) => {
          if (e.action === 'down') this.set(i);
        },
        this,
      );
      x = end + 2;
    });
  }

  handleKey(e: KeyEvent): boolean {
    if (e.name === 'left' || e.name === 'h') this.set(this.index - 1);
    else if (e.name === 'right' || e.name === 'l' || e.name === ' ') this.set(this.index + 1);
    else return false;
    return true;
  }
}

/** ` 921600 ▾ ` value picker: Enter, Space or a click opens the full list (`onOpen`). */
export class Select<T> implements Focusable {
  onOpen?: () => void;

  constructor(
    public values: readonly T[],
    public index: number,
    private format: (v: T) => string = String,
  ) {}

  get value(): T {
    return this.values[this.index]!;
  }

  private get label(): string {
    return ` ${this.format(this.value)} ▾ `;
  }

  get width(): number {
    return stringWidth(this.label);
  }

  render(ctx: Ctx, r: Rect, focused: boolean): void {
    const { screen, theme } = ctx;
    const style = focused
      ? { fg: theme.selFg, bg: theme.selBg }
      : { fg: theme.fg, bg: theme.inputBg };
    screen.text(r.x, r.y, this.label, style, r.w);
    ctx.hits.add(
      { x: r.x, y: r.y, w: Math.min(r.w, this.width), h: 1 },
      (e) => e.action === 'down' && this.onOpen?.(),
      this,
    );
  }

  handleKey(e: KeyEvent): boolean {
    if (e.name !== 'enter' && e.name !== ' ') return false;
    this.onOpen?.();
    return true;
  }
}

// ---------------------------------------------------------------------------

export interface MenuItem {
  /** Shortcut, e.g. 'r' or '^A' (Ctrl+A). */
  key?: string;
  label: string;
  checked?: boolean;
  action: () => void;
}

export interface MenuOptions {
  /** Center on this area (the pane the menu belongs to); the whole screen without one. */
  within?: Rect;
  /** Makes this a submenu: adds a `‹ Back` row, and Esc and Backspace go back. */
  onBack?: () => void;
}

/** Modal pop-up list, used for the Ctrl+A menu, its submenus and dropdowns. */
export class Menu {
  selected: number;
  readonly items: MenuItem[];
  private scroll = 0;

  constructor(
    public title: string,
    items: MenuItem[],
    private onClose: () => void,
    private opts: MenuOptions = {},
  ) {
    const back = opts.onBack;
    this.items = back ? [{ label: '‹ Back', action: back }, ...items] : items;
    // A choice list starts on the current value, an action menu at the top.
    this.selected = Math.max(
      0,
      this.items.findIndex((i) => i.checked),
    );
  }

  render(ctx: Ctx): void {
    const { screen, theme } = ctx;
    const keyW = Math.max(0, ...this.items.map((i) => stringWidth(i.key ?? '')));
    const labelW = Math.max(...this.items.map((i) => stringWidth(i.label)));
    // │ ✓ key  label │
    const w = Math.min(
      screen.cols,
      Math.max(stringWidth(this.title) + 6, 4 + 2 + (keyW ? keyW + 2 : 0) + labelW),
    );
    const h = Math.min(this.items.length + 2, screen.rows);
    const c = centered(this.opts.within ?? { x: 0, y: 0, w: screen.cols, h: screen.rows }, w, h);
    // Keep it on screen when it is bigger than the pane.
    const r = {
      x: Math.max(0, Math.min(c.x, screen.cols - w)),
      y: Math.max(0, Math.min(c.y, screen.rows - h)),
      w,
      h,
    };

    ctx.hits.add({ x: 0, y: 0, w: screen.cols, h: screen.rows }, (e) => {
      if (e.action === 'down') this.onClose();
      else this.handleMouse(e);
    });
    screen.fill(r, ' ', { bg: theme.inputBg });
    const inner = panel(ctx, r, this.title, true, {
      color: theme.borderFocus,
      kind: 'rounded',
      bg: theme.inputBg,
    });

    const visible = inner.h;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
    for (let row = 0; row < visible; row++) {
      const i = this.scroll + row;
      const item = this.items[i];
      if (!item) break;
      const sel = i === this.selected;
      const bg = sel ? theme.selBg : theme.inputBg;
      const line = { x: inner.x, y: inner.y + row, w: inner.w, h: 1 };
      screen.fill(line, ' ', { bg });
      let cx = screen.text(line.x + 1, line.y, item.checked ? '✓' : ' ', { fg: theme.ok, bg });
      cx++;
      if (keyW) {
        screen.text(cx, line.y, item.key ?? '', { fg: theme.keyFg, bg, attrs: Attr.Bold });
        cx += keyW + 2;
      }
      screen.text(
        cx,
        line.y,
        item.label,
        { fg: sel ? theme.selFg : theme.fg, bg },
        inner.x + inner.w - cx,
      );
      ctx.hits.add(line, (e) => {
        if (e.action === 'down') this.choose(i);
        else this.handleMouse(e);
      });
    }
  }

  get isSubmenu(): boolean {
    return this.opts.onBack !== undefined;
  }

  /** Back to the parent menu, or close a top-level menu. */
  back(): void {
    if (this.isSubmenu) this.choose(0);
    else this.onClose();
  }

  private handleMouse(e: MouseEvent): void {
    if (e.action === 'wheelup') this.move(-1);
    else if (e.action === 'wheeldown') this.move(1);
  }

  private move(d: number): void {
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + d));
  }

  private choose(i: number): void {
    const item = this.items[i];
    // Close first, so an item can open another overlay (a submenu, the help).
    this.onClose();
    item?.action();
  }

  /** Modal: every key is consumed. */
  handleKey(e: KeyEvent): boolean {
    const name = e.ctrl ? `^${e.name.toUpperCase()}` : e.name;
    switch (name) {
      case 'up':
      case 'k':
        this.move(-1);
        return true;
      case 'down':
      case 'j':
        this.move(1);
        return true;
      case 'home':
        this.selected = 0;
        return true;
      case 'end':
        this.selected = this.items.length - 1;
        return true;
      case 'enter':
      case ' ':
        this.choose(this.selected);
        return true;
      case 'escape':
      case 'q':
      case 'backspace':
        if (this.isSubmenu || name === 'escape' || name === 'q') this.back();
        return true;
    }
    const i = this.items.findIndex((it) => it.key === name);
    if (i >= 0) this.choose(i);
    return true;
  }
}

// ---------------------------------------------------------------------------

export interface KeyHint {
  key: string;
  label: string;
  action?: () => void;
}

/** Bottom key bar, `c Connect  f Flash ...`; each entry is clickable. */
export function keyBar(ctx: Ctx, r: Rect, hints: KeyHint[]): void {
  const { screen, theme } = ctx;
  let x = r.x;
  for (const h of hints) {
    const w = stringWidth(h.key) + 1 + stringWidth(h.label);
    if (x + w > r.x + r.w) break;
    const start = x;
    x = screen.text(x, r.y, h.key, { fg: theme.keyFg, attrs: Attr.Bold });
    x = screen.text(x + 1, r.y, h.label, { fg: theme.fg });
    if (h.action) {
      const action = h.action;
      ctx.hits.add(
        { x: start, y: r.y, w: x - start, h: 1 },
        (e) => e.action === 'down' && action(),
      );
    }
    x += 2;
  }
}

/**
 * Draws a dialog frame centered on `within` (default: the screen) and returns its inner rect.
 * Clicks outside it are swallowed.
 */
export function dialog(
  ctx: Ctx,
  title: string,
  w: number,
  h: number,
  color?: number,
  within?: Rect,
): Rect {
  const { screen, theme } = ctx;
  const full = { x: 0, y: 0, w: screen.cols, h: screen.rows };
  ctx.hits.add(full, () => {});
  const r = centered(within ?? full, w, h);
  screen.fill(r, ' ', { bg: theme.inputBg });
  const inner = panel(ctx, r, title, true, {
    color: color ?? theme.borderFocus,
    kind: 'rounded',
    bg: theme.inputBg,
  });
  ctx.hits.add(r, () => {});
  return inner;
}
