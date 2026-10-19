import { type ChipInfo, sameChip, sizeBytes } from './chip';
import { formatOffset } from './offsets';
import type { FlashPlan } from './plan';

export interface Checks {
  /** Flashing can't start. */
  errors: string[];
  /** Flashing needs a confirmation first. */
  warnings: string[];
}

const IMAGE_MAGIC = 0xe9;

/**
 * The checks before a flash (SPEC §5.5). Without `chip` only the plan itself is checked; once
 * the bootloader has answered, the chip-dependent ones run too (size, family, bootloader offset).
 */
export function checkPlan(plan: FlashPlan, chip?: ChipInfo): Checks {
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = plan.problem();
  if (problem) return { errors: [problem], warnings };
  const on = plan.rows.filter((r) => r.enabled);

  const flash = chip ? sizeBytes(chip.flashSize) : null;
  for (const r of on) {
    const end = r.offset + r.data!.length;
    if (flash !== null && end > flash)
      errors.push(`${r.name} ends at ${formatOffset(end)}, past the ${chip!.flashSize} flash`);
    if (r.offset % 0x1000)
      warnings.push(`${r.name} at ${formatOffset(r.offset)} is not 4 KiB aligned`);
    const boot = chip ? r.offset === chip.bootloaderOffset : /bootloader/i.test(r.name);
    if ((boot || r.offset === 0x10000) && r.data![0] !== IMAGE_MAGIC)
      warnings.push(`${r.name} at ${formatOffset(r.offset)} has no image header (0xE9)`);
    if (chip && /bootloader/i.test(r.name) && r.offset !== chip.bootloaderOffset)
      warnings.push(
        `${r.name} is at ${formatOffset(r.offset)}, but ${chip.name} boots from ${formatOffset(chip.bootloaderOffset)}`,
      );
  }
  const want = plan.set?.chip;
  if (chip && want && !sameChip(want, chip.name))
    warnings.push(`The set is for ${want}, but the chip is ${chip.name}`);
  return { errors, warnings };
}
