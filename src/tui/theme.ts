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
