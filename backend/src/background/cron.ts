/**
 * Owned by Task 2-d. 5-field cron matcher — port of croniter/Vixie cron semantics
 * used by celery beat's crontab schedules (background/celery/tasks/beat_schedule.py
 * builds `crontab(hour=0, minute=0, day_of_week=0)`-style schedules; onyx-ts stores
 * equivalent 5-field cron strings in the recurring_task table).
 *
 * Field order: minute hour day-of-month month day-of-week (0-59, 0-23, 1-31, 1-12, 0-6).
 * Supported syntax per field: star (any), star with step (e.g. star-slash-15),
 * single values, ranges (a-b), ranges with step (a-b-slash-n), lists (a,b,c),
 * and single-value steps (a-slash-n, treated as a-max/n, as croniter does).
 * Day-of-week: 0-6 with 7 accepted and normalized to Sunday (0).
 * Vixie rule preserved: when BOTH day-of-month and day-of-week are restricted
 * (not a full `*`), the day matches if EITHER field matches.
 */
import { getLogger } from "../utils/logger";

const logger = getLogger("background.cron");

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0-6; 7 == Sunday)
];

const ITEM_RE = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function parseField(field: string, index: number): Set<number> {
  const [min, max] = FIELD_BOUNDS[index];
  const allowed = new Set<number>();
  const parts = field.split(",");
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(`invalid cron field ${index + 1}: '${field}'`);
  }
  for (const part of parts) {
    const match = ITEM_RE.exec(part);
    if (!match) {
      throw new Error(`invalid cron field ${index + 1}: '${field}' (bad item '${part}')`);
    }
    const star = match[0] === "*" || match[0].startsWith("*/");
    const startStr = match[1];
    const endStr = match[2];
    const stepStr = match[3];

    let start: number;
    let end: number;
    if (star) {
      start = min;
      end = max;
    } else {
      start = Number(startStr);
      end = endStr !== undefined ? Number(endStr) : start;
      if (start < min || start > max) {
        throw new Error(`invalid cron field ${index + 1}: value ${start} out of range [${min}, ${max}]`);
      }
      if (end < min || end > max) {
        throw new Error(`invalid cron field ${index + 1}: value ${end} out of range [${min}, ${max}]`);
      }
      if (end < start) {
        throw new Error(`invalid cron field ${index + 1}: range ${start}-${end} is reversed`);
      }
    }
    if (stepStr !== undefined && Number(stepStr) < 1) {
      throw new Error(`invalid cron field ${index + 1}: step must be >= 1`);
    }
    const step = stepStr !== undefined ? Number(stepStr) : 1;
    for (let v = start; v <= end; v += step) {
      // dow 7 == Sunday == 0 (port of Vixie normalization)
      allowed.add(index === 4 && v === 7 ? 0 : v);
    }
  }
  return allowed;
}

function fieldIsUnrestricted(field: string, min: number, max: number): boolean {
  // A bare `*` (optionally with step 1 over the whole range) is unrestricted.
  return field.trim() === "*" || field.trim() === `*/1`;
}

/**
 * Whether `date` matches the 5-field cron expression (local time of `date`,
 * matching croniter's default behavior for celery beat schedules).
 * Throws on malformed cron strings — callers in the scheduler loop catch this
 * so one bad row can never kill the scheduler.
 */
export function cronMatches(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields, got ${fields.length}: '${cron}'`);
  }
  const sets = fields.map((f, i) => parseField(f, i));
  const restricted = fields.map((f, i) => {
    const [min, max] = FIELD_BOUNDS[i];
    return !fieldIsUnrestricted(f, min, max);
  });

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0 = Sunday, already matches normalized dow set

  if (!sets[0].has(minute)) return false;
  if (!sets[1].has(hour)) return false;
  if (!sets[3].has(month)) return false;

  const domMatch = sets[2].has(dom);
  const dowMatch = sets[4].has(dow);
  if (restricted[2] && restricted[4]) {
    // Vixie cron: both day fields restricted -> union semantics.
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Debug helper: human-readable summary of a cron expression (used in logs).
 */
export function describeCron(cron: string): string {
  try {
    const fields = cron.trim().split(/\s+/);
    const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
    return fields.map((f, i) => `${names[i]}=${parseField(f, i).size > 0 ? f : "?"}`).join(" ");
  } catch (err) {
    logger.warning("describeCron: invalid expression", { cron, error: String(err) });
    return cron;
  }
}
