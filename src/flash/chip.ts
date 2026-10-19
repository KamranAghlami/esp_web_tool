/**
 * Chip facts and helpers that don't need esptool-js, which is loaded only when a job runs
 * (`src/flash/esp.ts`).
 */

/** What the bootloader tells us about the chip (SPEC §5.1), shown in the status line. */
export interface ChipInfo {
  /** esptool's family name, e.g. `ESP32-S3`; compared with a set's `chip`. */
  name: string;
  /** e.g. `ESP32-S3 (QFN56) (revision v0.2)`. */
  description: string;
  features: string[];
  crystalMHz: number | null;
  mac: string | null;
  /** e.g. `4MB`; null if the flash ID couldn't be mapped. */
  flashSize: string | null;
  bootloaderOffset: number;
  /** Secure download mode: no register reads, no stub. */
  secure: boolean;
}

/** `4MB` → bytes. */
export function sizeBytes(size: string | null): number | null {
  const m = size && /^(\d+)(KB|MB)$/.exec(size);
  return m ? Number(m[1]) * (m[2] === 'KB' ? 1024 : 1024 * 1024) : null;
}

/** Same family, ignoring case and punctuation: `esp32s3` matches `ESP32-S3`. */
export const sameChip = (a: string, b: string) =>
  a.replace(/[^a-z0-9]/gi, '').toLowerCase() === b.replace(/[^a-z0-9]/gi, '').toLowerCase();
