import type { Rect } from './screen';

/** A fixed number of cells, or a share of what is left after fixed sizes. */
export type Size = number | { flex: number };

function split(total: number, sizes: Size[]): number[] {
  const fixed = sizes.reduce<number>((n, s) => n + (typeof s === 'number' ? s : 0), 0);
  const flexTotal = sizes.reduce<number>((n, s) => n + (typeof s === 'number' ? 0 : s.flex), 0);
  const free = Math.max(0, total - fixed);
  let given = 0;
  let flexSeen = 0;
  return sizes.map((s) => {
    if (typeof s === 'number') return s;
    flexSeen += s.flex;
    // Hand out cumulative rounding so the flex parts add up exactly to `free`.
    const upTo = Math.round((free * flexSeen) / flexTotal);
    const n = upTo - given;
    given = upTo;
    return n;
  });
}

export function rows(r: Rect, sizes: Size[]): Rect[] {
  let y = r.y;
  return split(r.h, sizes).map((h) => {
    const out = { x: r.x, y, w: r.w, h: Math.max(0, Math.min(h, r.y + r.h - y)) };
    y += h;
    return out;
  });
}

export function cols(r: Rect, sizes: Size[]): Rect[] {
  let x = r.x;
  return split(r.w, sizes).map((w) => {
    const out = { x, y: r.y, w: Math.max(0, Math.min(w, r.x + r.w - x)), h: r.h };
    x += w;
    return out;
  });
}

export function centered(outer: Rect, w: number, h: number): Rect {
  const cw = Math.min(w, outer.w);
  const ch = Math.min(h, outer.h);
  return {
    x: outer.x + Math.floor((outer.w - cw) / 2),
    y: outer.y + Math.floor((outer.h - ch) / 2),
    w: cw,
    h: ch,
  };
}
