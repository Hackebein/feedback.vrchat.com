export function parseNonNegativeInt(
  raw: unknown,
  fallback: number,
  max: number,
): number {
  const n =
    typeof raw === "string" || typeof raw === "number"
      ? Number.parseInt(String(raw), 10)
      : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
}

export function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = parseNonNegativeInt(raw, fallback, max);
  return n <= 0 ? fallback : Math.min(n, max);
}
