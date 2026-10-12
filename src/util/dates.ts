const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_AGO = /^(\d+)daysAgo$/;

/** A date accepted by the tools: YYYY-MM-DD, `today`, `yesterday` or `NdaysAgo` (GA4 syntax). */
export const DATE_HELP = 'YYYY-MM-DD, "today", "yesterday" or "NdaysAgo" (e.g. "28daysAgo")';

export function isValidDateExpression(value: string): boolean {
  return ISO_DATE.test(value) || value === 'today' || value === 'yesterday' || DAYS_AGO.test(value);
}

/** Resolves a date expression to YYYY-MM-DD (UTC). Needed for Search Console, which has no relative dates. */
export function resolveDate(value: string, now: Date = new Date()): string {
  if (ISO_DATE.test(value)) return value;
  let offset: number;
  if (value === 'today') offset = 0;
  else if (value === 'yesterday') offset = 1;
  else {
    const match = DAYS_AGO.exec(value);
    if (!match) throw new Error(`Invalid date "${value}". Use ${DATE_HELP}.`);
    offset = Number(match[1]);
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The period of equal length immediately before [start, end]. */
export function previousPeriod(start: string, end: string): { startDate: string; endDate: string } {
  const length = daysBetweenInclusive(start, end);
  return { startDate: shiftDate(start, -length), endDate: shiftDate(start, -1) };
}
