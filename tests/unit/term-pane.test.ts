import { describe, expect, it } from 'vitest';
import { DemoStream } from '../../src/monitor/demo';
import { TermPane } from '../../src/monitor/term-pane';
import { Renderer } from '../../src/tui/renderer';
import { Screen } from '../../src/tui/screen';

const flush = (p: TermPane) => new Promise<void>((resolve) => p.write('', resolve));

describe('TermPane', () => {
  it('blits device output with ANSI colors into the screen', async () => {
    const pane = new TermPane(30, 4);
    pane.write('\x1b[0;32mI (1) main: ok\x1b[0m\nplain');
    await flush(pane);
    const s = new Screen(40, 6);
    pane.blit(s, { x: 5, y: 1, w: 30, h: 4 });
    expect(s.rowText(1).slice(5, 19)).toBe('I (1) main: ok');
    expect(s.fg[1 * 40 + 5]).toBe(2); // palette green
    expect(s.rowText(2).slice(5, 10)).toBe('plain');
  });

  it('keeps scrollback and reports scroll lock', async () => {
    const pane = new TermPane(20, 3);
    pane.write(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
    await flush(pane);
    expect(pane.viewportText()).toEqual(['line 7', 'line 8', 'line 9']);
    pane.scroll(-2);
    expect(pane.scrolledBack).toBe(true);
    expect(pane.viewportText()[0]).toBe('line 5');
  });

  /**
   * M0 spike (SPEC §14): can the monitor keep up with a saturated 2 Mbaud link (~200 KB/s)?
   * Simulates 2 s of traffic delivered in 50 ms chunks, blitting + diffing a frame per chunk.
   */
  it('parses, blits and renders 2 Mbaud worth of logs faster than real time', async () => {
    const cols = 120;
    const rows = 50;
    const pane = new TermPane(cols, rows);
    const demo = new DemoStream();
    const renderer = new Renderer();
    const chunks = 40;
    const perChunk = 10_000;

    const t0 = performance.now();
    for (let i = 0; i < chunks; i++) {
      await new Promise<void>((resolve) => pane.write(demo.next(perChunk), resolve));
      const s = new Screen(cols + 2, rows + 2);
      pane.blit(s, { x: 1, y: 1, w: cols, h: rows });
      renderer.render(s, { visible: false, x: 0, y: 0 });
    }
    const ms = performance.now() - t0;
    const kbPerSec = (chunks * perChunk) / 1024 / (ms / 1000);
    console.log(
      `monitor pipeline: ${(chunks * perChunk) / 1024} KiB in ${ms.toFixed(0)} ms → ${kbPerSec.toFixed(0)} KiB/s`,
    );
    // Real time would be 2000 ms; require a comfortable margin even on slow CI runners.
    expect(ms).toBeLessThan(1500);
  });
});
