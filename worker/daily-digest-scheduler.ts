import { DurableObject } from "cloudflare:workers";
import { easternDate, runScheduledDigest, type OutlookDigestEnv } from "./outlook-digest";

const SCHEDULER_NAME = "daily-yield-weekday-digest";
const RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

type SchedulerState = {
  intendedAt: number;
  intendedDate: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
};

function calendarParts(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("The scheduler received an invalid Eastern date.");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function easternFiveAm(date: string) {
  const target = calendarParts(date);
  const targetWallTime = Date.UTC(target.year, target.month - 1, target.day, 5, 0);
  let timestamp = targetWallTime;
  // Resolve an America/New_York wall-clock time without hard-coding an offset.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = easternDate(new Date(timestamp));
    const actual = calendarParts(observed.date);
    const observedWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, Number(observed.hour), Number(observed.minute));
    const delta = targetWallTime - observedWallTime;
    if (delta === 0) break;
    timestamp += delta;
  }
  return timestamp;
}

function nextCalendarDate(date: string) {
  const { year, month, day } = calendarParts(date);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function weekday(date: string) {
  const { year, month, day } = calendarParts(date);
  const value = new Date(Date.UTC(year, month - 1, day, 12, 0)).getUTCDay();
  return value >= 1 && value <= 5;
}

function dueAt(nowMs: number) {
  let date = easternDate(new Date(nowMs)).date;
  for (;;) {
    const target = easternFiveAm(date);
    // Keep a missed weekday available for repair through the existing 6 AM cron.
    if (weekday(date) && (target > nowMs || nowMs - target <= 2 * 60 * 60_000)) return { date, target };
    date = nextCalendarDate(date);
  }
}

export class DailyDigestScheduler extends DurableObject<OutlookDigestEnv> {
  async ensureScheduled(nowMs = Date.now()) {
    const currentAlarm = await this.ctx.storage.getAlarm();
    const state = await this.ctx.storage.get<SchedulerState>("state");
    if (currentAlarm !== null && currentAlarm > nowMs - 60_000 && state) return this.status();

    const due = dueAt(nowMs);
    const nextState: SchedulerState = { intendedAt: due.target, intendedDate: due.date, attempts: 0 };
    await this.ctx.storage.put("state", nextState);
    await this.ctx.storage.setAlarm(Math.max(due.target, nowMs + 100));
    return this.status();
  }

  async status() {
    const [state, alarmAt] = await Promise.all([
      this.ctx.storage.get<SchedulerState>("state"),
      this.ctx.storage.getAlarm(),
    ]);
    return state ? { ...state, alarmAt } : { intendedAt: null, intendedDate: null, attempts: 0, alarmAt };
  }

  async alarm() {
    const state = await this.ctx.storage.get<SchedulerState>("state");
    if (!state) {
      await this.ensureScheduled(Date.now());
      return;
    }

    const attempts = state.attempts + 1;
    await this.ctx.storage.put("state", { ...state, attempts, lastAttemptAt: Date.now(), lastError: undefined } satisfies SchedulerState);
    try {
      const result = await runScheduledDigest(this.env, state.intendedAt);
      if (!result.skippedBySchedule && result.failed === 0) {
        const next = dueAt(Math.max(Date.now(), state.intendedAt + 60_000));
        await this.ctx.storage.put("state", { intendedAt: next.target, intendedDate: next.date, attempts: 0 } satisfies SchedulerState);
        await this.ctx.storage.setAlarm(next.target);
        return;
      }
      const error = result.skippedBySchedule ? "The scheduled digest was outside its delivery window." : "One or more subscriber deliveries failed.";
      await this.retry({ ...state, attempts, lastAttemptAt: Date.now(), lastError: error });
    } catch (error) {
      await this.retry({ ...state, attempts, lastAttemptAt: Date.now(), lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async retry(state: SchedulerState) {
    const delay = RETRY_DELAYS_MS[Math.min(state.attempts - 1, RETRY_DELAYS_MS.length - 1)];
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + delay);
    console.error(JSON.stringify({ event: "daily_yield_alarm_retry", intendedDate: state.intendedDate, attempts: state.attempts, error: state.lastError }));
  }
}

export function dailyDigestSchedulerName() {
  return SCHEDULER_NAME;
}
