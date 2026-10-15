import { OpendrsError } from "../domain/types.js";

export function parseScoreArg(flag: string, value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new OpendrsError(`${flag} must be a number between 0 and 1, got '${value}'`, "usage");
  }
  return n;
}

export function parsePositiveInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new OpendrsError(`${flag} must be a positive integer, got '${value}'`, "usage");
  return n;
}

export const pct = (x: number | undefined) => (x === undefined ? "n/a" : `${(x * 100).toFixed(1)} %`);
