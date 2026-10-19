import type { Terminal } from '@xterm/xterm';

/** Finger travel (in rows) per ms that still counts as a fling when the finger lifts. */
const FLING_MIN = 0.002;

/**
 * Touch for the terminal (SPEC §4.1). xterm.js barely handles touch, so taps and swipes on its
 * element become the SGR mouse sequences the app already parses: a tap is a click at the cell,
 * a vertical swipe is the wheel (with momentum after a fling). Touches don't focus xterm's
 * textarea, so taps never pop the soft keyboard up; the app asks for it when it wants text.
 */
export function attachTouch(el: HTMLElement, term: Terminal, input: (data: string) => void): void {
  const geometry = () => {
    const r = el.querySelector('.xterm-screen')!.getBoundingClientRect();
    return { r, cw: r.width / term.cols, ch: r.height / term.rows };
  };
  const cellAt = (t: Touch) => {
    const { r, cw, ch } = geometry();
    const clamp = (v: number, max: number) => Math.max(1, Math.min(max, v));
    return {
      x: clamp(Math.floor((t.clientX - r.left) / cw) + 1, term.cols),
      y: clamp(Math.floor((t.clientY - r.top) / ch) + 1, term.rows),
    };
  };
  const wheel = (up: boolean, c: { x: number; y: number }) =>
    input(`\x1b[<${up ? 64 : 65};${c.x};${c.y}M`);

  let start: { y: number; t: number; cell: { x: number; y: number } } | null = null;
  let lastY = 0;
  let lastT = 0;
  let carry = 0;
  let velocity = 0; // rows per ms, positive = finger moving down
  let moved = false;
  let fling: ReturnType<typeof setInterval> | null = null;

  const stopFling = () => {
    if (fling) clearInterval(fling);
    fling = null;
  };

  el.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      stopFling();
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      start = { y: t.clientY, t: e.timeStamp, cell: cellAt(t) };
      lastY = t.clientY;
      lastT = e.timeStamp;
      carry = 0;
      velocity = 0;
      moved = false;
    },
    { passive: false },
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!start || !t) return;
      const { ch } = geometry();
      if (!moved && Math.abs(t.clientY - start.y) < ch * 0.6) return;
      moved = true;
      // Content follows the finger: moving down scrolls back (wheel up).
      carry += (t.clientY - lastY) / ch;
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity = 0.7 * velocity + 0.3 * ((t.clientY - lastY) / ch / dt);
      lastY = t.clientY;
      lastT = e.timeStamp;
      while (Math.abs(carry) >= 1) {
        wheel(carry > 0, start.cell);
        carry -= Math.sign(carry);
      }
    },
    { passive: false },
  );

  el.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      if (!start) return;
      const s = start;
      start = null;
      if (!moved) {
        input(`\x1b[<0;${s.cell.x};${s.cell.y}M\x1b[<0;${s.cell.x};${s.cell.y}m`);
        return;
      }
      if (Math.abs(velocity) < FLING_MIN) return;
      // Momentum: keep scrolling, slowing down each frame.
      let v = velocity;
      let acc = 0;
      fling = setInterval(() => {
        acc += v * 16;
        while (Math.abs(acc) >= 1) {
          wheel(acc > 0, s.cell);
          acc -= Math.sign(acc);
        }
        v *= 0.92;
        if (Math.abs(v) < FLING_MIN) stopFling();
      }, 16);
    },
    { passive: false },
  );
}

/** A touch-first device (phone, tablet): gets the extra-keys bar and keyboard handling. */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}
