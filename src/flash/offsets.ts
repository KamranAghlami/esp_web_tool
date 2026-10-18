/** Flash offsets: parsing, formatting, and guessing one from a file name (SPEC §5.2). */

/** `0x10000`, `10000` (hex without the prefix) or a non-negative integer; null if invalid. */
export function parseOffset(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,8}$/.test(s)) return null;
  return parseInt(s, 16);
}

export function formatOffset(n: number): string {
  return `0x${n.toString(16).padStart(6, '0')}`;
}

const APP_ALIGN = 0x10000;

/**
 * Offset for a newly added file, from its name. `bootloader*.bin` gets 0x0 until a chip is
 * known (the row is flagged as a guess). Anything unrecognised goes at 0x10000, or at the
 * first 64 KiB boundary after the parts already planned.
 */
export function guessOffset(
  name: string,
  existing: readonly { offset: number; size: number }[] = [],
): { offset: number; guessed: boolean } {
  const n = name.toLowerCase();
  if (n.startsWith('bootloader')) return { offset: 0x0, guessed: true };
  if (/partition.*table|^partitions?\b/.test(n)) return { offset: 0x8000, guessed: false };
  if (n.startsWith('ota_data_initial')) return { offset: 0xd000, guessed: false };
  if (/merged|factory/.test(n)) return { offset: 0x0, guessed: false };
  const end = Math.max(0, ...existing.map((p) => p.offset + p.size));
  const offset = Math.max(APP_ALIGN, Math.ceil(end / APP_ALIGN) * APP_ALIGN);
  return { offset, guessed: false };
}
