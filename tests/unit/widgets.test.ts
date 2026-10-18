import { describe, expect, it } from 'vitest';
import type { KeyEvent, MouseEvent } from '../../src/tty/input';
import { HitMap, type Ctx } from '../../src/tui/context';
import { cols, rows } from '../../src/tui/layout';
import { Screen } from '../../src/tui/screen';
import { darkTheme } from '../../src/tui/theme';
import { ListView, Menu, TextInput } from '../../src/tui/widgets';
import { padEnd, stringWidth, truncate } from '../../src/tui/width';

const k = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({
  type: 'key',
  name,
  ctrl: false,
  alt: false,
  shift: false,
  raw: name,
  ...mods,
});

function ctx(w = 40, h = 10): Ctx {
  return {
    screen: new Screen(w, h),
    hits: new HitMap(),
    theme: darkTheme,
    cursor: { visible: false, x: 0, y: 0 },
    now: 0,
    invalidate: () => {},
  };
}

describe('layout', () => {
  it('splits fixed and flex sizes exactly', () => {
    const r = { x: 0, y: 0, w: 100, h: 10 };
    const parts = cols(r, [10, { flex: 1 }, { flex: 2 }]);
    expect(parts.map((p) => p.w)).toEqual([10, 30, 60]);
    expect(parts.map((p) => p.x)).toEqual([0, 10, 40]);
    expect(rows(r, [1, { flex: 1 }, 1]).map((p) => p.h)).toEqual([1, 8, 1]);
  });
});

describe('width helpers', () => {
  it('counts wide characters as two columns', () => {
    expect(stringWidth('ab全')).toBe(4);
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(padEnd('ab', 4)).toBe('ab  ');
  });
});

describe('TextInput', () => {
  it('edits like a readline field', () => {
    const t = new TextInput();
    for (const ch of 'hello world') t.handleKey(k(ch));
    t.handleKey(k('w', { ctrl: true }));
    expect(t.value).toBe('hello ');
    t.handleKey(k('home'));
    t.handleKey(k('>'));
    expect(t.value).toBe('>hello ');
    t.handlePaste('a\nb');
    expect(t.value).toBe('>a bhello ');
  });

  it('places the terminal cursor when focused', () => {
    const c = ctx();
    const t = new TextInput('abc');
    t.render(c, { x: 5, y: 2, w: 20, h: 1 }, true);
    expect(c.cursor).toEqual({ visible: true, x: 5 + 1 + 3, y: 2 });
  });
});

describe('ListView', () => {
  it('moves, scrolls and activates', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item ${i}`);
    let activated = '';
    const list = new ListView(
      items,
      (s) => s,
      (s) => (activated = s),
    );
    const c = ctx();
    list.render(c, { x: 0, y: 0, w: 20, h: 5 }, true);
    list.handleKey(k('G'));
    list.render(c, { x: 0, y: 0, w: 20, h: 5 }, true);
    expect(c.screen.rowText(4)).toContain('item 19');
    list.handleKey(k('k'));
    list.handleKey(k('enter'));
    expect(activated).toBe('item 18');
  });
});

const m = (action: MouseEvent['action'], x: number, y: number): MouseEvent => ({
  type: 'mouse',
  action,
  button: 0,
  x,
  y,
  ctrl: false,
  alt: false,
  shift: false,
});

describe('Menu', () => {
  it('draws items, picks by key or click, and closes first', () => {
    const log: string[] = [];
    const menu = new Menu(
      'Pick',
      [
        { key: 'a', label: 'Alpha', action: () => log.push('alpha') },
        { key: '^A', label: 'Ctrl thing', checked: true, action: () => log.push('ctrl') },
      ],
      { x: 30, y: 0 },
      () => log.push('close'),
    );
    const c = ctx();
    menu.render(c);
    const rows = Array.from({ length: 5 }, (_, y) => c.screen.rowText(y));
    expect(rows.join('\n')).toContain('a   Alpha');
    expect(rows.join('\n')).toContain('✓ ^A  Ctrl thing');
    expect(menu.selected).toBe(1); // starts on the checked item
    menu.handleKey(k('a', { ctrl: true }));
    expect(log).toEqual(['close', 'ctrl']);
    const y = rows.findIndex((r) => r.includes('Alpha'));
    c.hits.dispatch(m('down', rows[y]!.indexOf('Alpha'), y));
    expect(log).toEqual(['close', 'ctrl', 'close', 'alpha']);
  });
});

describe('HitMap', () => {
  it('sends drags and the release to the region that took the press', () => {
    const hits = new HitMap();
    const seen: string[] = [];
    hits.add({ x: 0, y: 0, w: 5, h: 1 }, (e) => seen.push(`left:${e.action}`));
    hits.add({ x: 5, y: 0, w: 5, h: 1 }, (e) => seen.push(`right:${e.action}`));
    hits.dispatch(m('down', 1, 0));
    hits.clear(); // a frame in between keeps the capture
    hits.add({ x: 5, y: 0, w: 5, h: 1 }, (e) => seen.push(`right:${e.action}`));
    hits.dispatch(m('drag', 7, 0));
    hits.dispatch(m('up', 7, 0));
    hits.dispatch(m('down', 7, 0));
    expect(seen).toEqual(['left:down', 'left:drag', 'left:up', 'right:down']);
  });
});
