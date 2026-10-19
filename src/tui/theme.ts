import type { ITheme } from '@xterm/xterm';
import { rgb } from './style';

/** UI colors (as Screen color numbers) plus the xterm theme the page terminal uses. */
export interface Theme {
  fg: number;
  dim: number;
  border: number;
  borderFocus: number;
  borderLive: number;
  title: number;
  accent: number;
  ok: number;
  warn: number;
  error: number;
  selBg: number;
  selFg: number;
  inputBg: number;
  keyFg: number;
  barBg: number;
  xterm: ITheme;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

const C = {
  bg: 0x0d1117,
  fg: 0xc9d1d9,
  dim: 0x6e7681,
  border: 0x30363d,
  cyan: 0x58c4dc,
  green: 0x7ee787,
  amber: 0xe3b341,
  red: 0xff7b72,
  selBg: 0x1f3a52,
  inputBg: 0x161b22,
};

export const darkTheme: Theme = {
  fg: rgb(C.fg),
  dim: rgb(C.dim),
  border: rgb(C.border),
  borderFocus: rgb(C.cyan),
  borderLive: rgb(C.amber),
  title: rgb(0xe6edf3),
  accent: rgb(C.cyan),
  ok: rgb(C.green),
  warn: rgb(C.amber),
  error: rgb(C.red),
  selBg: rgb(C.selBg),
  selFg: rgb(0xffffff),
  inputBg: rgb(C.inputBg),
  keyFg: rgb(C.amber),
  barBg: rgb(C.inputBg),
  xterm: {
    background: hex(C.bg),
    foreground: hex(C.fg),
    cursor: hex(C.cyan),
    cursorAccent: hex(C.bg),
    selectionBackground: '#3b5070',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
};

const L = {
  bg: 0xffffff,
  fg: 0x1f2328,
  dim: 0x6e7781,
  border: 0xd0d7de,
  blue: 0x0969da,
  green: 0x1a7f37,
  amber: 0x9a6700,
  red: 0xcf222e,
  selBg: 0xddf4ff,
  inputBg: 0xf6f8fa,
};

/** For `prefers-color-scheme: light` (SPEC §4 Visual style), GitHub's light palette. */
export const lightTheme: Theme = {
  fg: rgb(L.fg),
  dim: rgb(L.dim),
  border: rgb(L.border),
  borderFocus: rgb(L.blue),
  borderLive: rgb(L.amber),
  title: rgb(0x1f2328),
  accent: rgb(L.blue),
  ok: rgb(L.green),
  warn: rgb(L.amber),
  error: rgb(L.red),
  selBg: rgb(L.selBg),
  selFg: rgb(L.fg),
  inputBg: rgb(L.inputBg),
  keyFg: rgb(L.amber),
  barBg: rgb(L.inputBg),
  xterm: {
    background: hex(L.bg),
    foreground: hex(L.fg),
    cursor: hex(L.blue),
    cursorAccent: hex(L.bg),
    selectionBackground: '#b6e3ff',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
};
