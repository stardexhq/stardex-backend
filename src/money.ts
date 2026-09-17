/**
 * Amounts move between the API and the database as exact integers (BigInt)
 * in the asset's smallest unit. Classic assets use 7 decimal places.
 */

export const CLASSIC_DECIMALS = 7;
const SCALE = 10n ** BigInt(CLASSIC_DECIMALS);

/** Parse a decimal amount like "12.5" into units. Returns null if invalid or not positive. */
export function toUnits(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text.trim());
  if (!match) return null;
  const units = BigInt(match[1]) * SCALE + BigInt((match[2] ?? "").padEnd(CLASSIC_DECIMALS, "0"));
  return units > 0n ? units : null;
}

/** Format units as a decimal string with 7 places, e.g. 50000000 -> "5.0000000". */
export function fromUnits(units: bigint | string): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(CLASSIC_DECIMALS, "0")}`;
}

/**
 * Format a stored amount for `asset`. Classic assets get 7 decimal places;
 * custom Soroban tokens (identified by contract id) have unknown decimals, so
 * their raw units are returned unchanged.
 */
export function formatAmount(units: string, asset: string): string {
  return asset === "native" || asset.includes(":") ? fromUnits(units) : units;
}
