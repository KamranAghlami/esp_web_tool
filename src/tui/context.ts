import type { MouseEvent } from '../tty/input';
import type { CursorState } from './renderer';
import { contains, type Rect, type Screen } from './screen';
import type { Theme } from './theme';

export type MouseHandler = (e: MouseEvent) => void;

/**
 * Clickable regions registered while drawing; the last one drawn on top wins. The region that
 * takes a button press also gets the drags and the release that follow (pointer capture).
 */
export class HitMap {
  private hits: { rect: Rect; fn: MouseHandler; owner: unknown }[] = [];
  private captured: MouseHandler | null = null;

  /** `owner` is the widget that should get focus when this region is clicked. */
  add(rect: Rect, fn: MouseHandler, owner?: unknown): void {
    this.hits.push({ rect, fn, owner });
  }

  /** Called every frame; a capture in progress survives it. */
  clear(): void {
    this.hits = [];
  }

  /** Runs the topmost handler under the pointer and returns its owner (if any). */
  dispatch(e: MouseEvent): { hit: boolean; owner: unknown } {
    if (this.captured && (e.action === 'drag' || e.action === 'up')) {
      const fn = this.captured;
      if (e.action === 'up') this.captured = null;
      fn(e);
      return { hit: true, owner: undefined };
    }
    if (e.action === 'down') this.captured = null;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]!;
      if (contains(h.rect, e.x, e.y)) {
        if (e.action === 'down') this.captured = h.fn;
        h.fn(e);
        return { hit: true, owner: h.owner };
      }
    }
    return { hit: false, owner: undefined };
  }
}

/** Everything a widget needs while drawing one frame. */
export interface Ctx {
  screen: Screen;
  hits: HitMap;
  theme: Theme;
  cursor: CursorState;
  /** Milliseconds, for spinners and blinking. */
  now: number;
  /** Ask for another frame (used by animations). */
  invalidate(): void;
}
