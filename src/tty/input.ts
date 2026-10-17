/**
 * Parses terminal input (what xterm.js emits from onData) into key, mouse and paste events,
 * the same way a TUI running in a real terminal parses stdin.
 */

export interface KeyEvent {
  type: 'key';
  /** Printable character ('a', 'A', ' ', 'é') or a named key ('enter', 'up', 'f1', ...). */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The exact bytes received, for passing straight through to a serial device. */
  raw: string;
}

export type MouseAction = 'down' | 'up' | 'drag' | 'move' | 'wheelup' | 'wheeldown';

export interface MouseEvent {
  type: 'mouse';
  action: MouseAction;
  /** 0 left, 1 middle, 2 right. */
  button: number;
  /** 0-based cell coordinates. */
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface PasteEvent {
  type: 'paste';
  text: string;
}

export type InputEvent = KeyEvent | MouseEvent | PasteEvent;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12',
};

const CSI_LETTER: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

function key(name: string, raw: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { type: 'key', name, ctrl: false, alt: false, shift: false, raw, ...mods };
}

/** xterm-style modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4). */
function modifiers(param: string | undefined): Pick<KeyEvent, 'ctrl' | 'alt' | 'shift'> {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

/** A single byte that is not part of an escape sequence. */
function plainKey(ch: string, raw: string, alt = false): KeyEvent {
  const code = ch.charCodeAt(0);
  switch (ch) {
    case '\r':
    case '\n':
      return key('enter', raw, { alt });
    case '\t':
      return key('tab', raw, { alt });
    case '\x7f':
    case '\b':
      return key('backspace', raw, { alt });
    case '\x1b':
      return key('escape', raw, { alt });
    case '\x00':
      return key(' ', raw, { ctrl: true, alt });
  }
  if (code >= 1 && code <= 26) {
    return key(String.fromCharCode(code + 96), raw, { ctrl: true, alt });
  }
  if (code >= 28 && code <= 31) {
    // Ctrl+\ Ctrl+] Ctrl+^ Ctrl+_
    return key(String.fromCharCode(code + 64), raw, { ctrl: true, alt });
  }
  const shift = ch !== ch.toLowerCase();
  return key(ch, raw, { alt, shift });
}

export class InputParser {
  private pasting: string | null = null;

  /** Feed one chunk from the terminal; returns the events it contained. */
  feed(data: string): InputEvent[] {
    const events: InputEvent[] = [];
    let i = 0;

    while (i < data.length) {
      if (this.pasting !== null) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          this.pasting += data.slice(i);
          return events;
        }
        events.push({ type: 'paste', text: this.pasting + data.slice(i, end) });
        this.pasting = null;
        i = end + PASTE_END.length;
        continue;
      }

      if (data.startsWith(PASTE_START, i)) {
        this.pasting = '';
        i += PASTE_START.length;
        continue;
      }

      const ch = data[i]!;
      if (ch !== '\x1b') {
        // Keep surrogate pairs together so one emoji is one key.
        const cp = data.codePointAt(i)!;
        const s = String.fromCodePoint(cp);
        events.push(plainKey(s, s));
        i += s.length;
        continue;
      }

      const next = data[i + 1];
      if (next === undefined) {
        events.push(key('escape', ch));
        i += 1;
      } else if (next === '[') {
        i = this.csi(data, i, events);
      } else if (next === 'O' && i + 2 < data.length) {
        const final = data[i + 2]!;
        const raw = data.slice(i, i + 3);
        events.push(key(CSI_LETTER[final] ?? `ss3-${final}`, raw));
        i += 3;
      } else if (next === '\x1b') {
        events.push(key('escape', ch));
        i += 1;
      } else {
        // ESC prefix = Alt.
        const cp = data.codePointAt(i + 1)!;
        const s = String.fromCodePoint(cp);
        events.push(plainKey(s, ch + s, true));
        i += 1 + s.length;
      }
    }
    return events;
  }

  private csi(data: string, start: number, events: InputEvent[]): number {
    let j = start + 2;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      j++;
    }
    if (j >= data.length) {
      // Incomplete sequence: report it as a lone Escape plus literal text rather than swallowing it.
      events.push(key('escape', '\x1b'));
      return start + 1;
    }
    const final = data[j]!;
    const params = data.slice(start + 2, j);
    const raw = data.slice(start, j + 1);
    const next = j + 1;

    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const mouse = parseSgrMouse(params.slice(1), final === 'M');
      if (mouse) events.push(mouse);
      return next;
    }

    const parts = params.split(';');
    if (final === '~') {
      const name = CSI_TILDE[parts[0] ?? ''];
      events.push(key(name ?? `csi-${params}~`, raw, modifiers(parts[1])));
    } else if (final === 'Z') {
      events.push(key('tab', raw, { shift: true }));
    } else if (CSI_LETTER[final]) {
      events.push(key(CSI_LETTER[final], raw, modifiers(parts[1])));
    } else if (final === 'I' || final === 'O') {
      // Focus in/out reports; ignored.
    } else {
      events.push(key(`csi-${params}${final}`, raw));
    }
    return next;
  }
}

function parseSgrMouse(params: string, pressed: boolean): MouseEvent | null {
  const [b, x, y] = params.split(';').map(Number);
  if (b === undefined || x === undefined || y === undefined || [b, x, y].some(Number.isNaN)) {
    return null;
  }
  const mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) };
  const button = b & 3;
  let action: MouseAction;
  if (b & 64) action = button === 0 ? 'wheelup' : 'wheeldown';
  else if (b & 32) action = button === 3 ? 'move' : 'drag';
  else action = pressed ? 'down' : 'up';
  return { type: 'mouse', action, button, x: x - 1, y: y - 1, ...mods };
}
