/**
 * Colors are stored as numbers: DEFAULT, a palette index 0-255, or RGB tagged with RGB_FLAG.
 */
export const DEFAULT = -1;
export const RGB_FLAG = 0x1000000;

export const rgb = (hex: number): number => RGB_FLAG | (hex & 0xffffff);
export const isRgb = (c: number): boolean => c >= RGB_FLAG;

export const Attr = {
  None: 0,
  Bold: 1,
  Dim: 2,
  Italic: 4,
  Underline: 8,
  Inverse: 16,
} as const;

export interface Style {
  fg?: number;
  bg?: number;
  attrs?: number;
}

function colorSgr(c: number, base: 30 | 40): string {
  if (c === DEFAULT) return String(base + 9);
  if (isRgb(c)) {
    const v = c & 0xffffff;
    return `${base + 8};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
  }
  if (c < 8) return String(base + c);
  if (c < 16) return String(base + 60 + c - 8);
  return `${base + 8};5;${c}`;
}

/** A full SGR sequence that sets exactly this style (starting from a reset). */
export function sgr(fg: number, bg: number, attrs: number): string {
  const p = ['0'];
  if (attrs & Attr.Bold) p.push('1');
  if (attrs & Attr.Dim) p.push('2');
  if (attrs & Attr.Italic) p.push('3');
  if (attrs & Attr.Underline) p.push('4');
  if (attrs & Attr.Inverse) p.push('7');
  if (fg !== DEFAULT) p.push(colorSgr(fg, 30));
  if (bg !== DEFAULT) p.push(colorSgr(bg, 40));
  return `\x1b[${p.join(';')}m`;
}
