import { config } from "./config";

/** Date/time helpers that work in the bot's TIMEZONE (default America/Los_Angeles). */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: string; // "mon".."sun"
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM"
}

export function zonedParts(date: Date = new Date(), timeZone: string = config.timezone): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: get("weekday").toLowerCase().slice(0, 3),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** How far the time zone is ahead of UTC at `date`, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const actual = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - actual;
}

/** Turns a wall-clock time in the bot's time zone into a real Date. */
export function zonedTimeToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string = config.timezone
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), timeZone);
  let result = guess - first;
  const second = offsetMs(new Date(result), timeZone);
  if (second !== first) result = guess - second; // daylight-saving edge
  return new Date(result);
}

/** Adds days to a calendar date (handles month/year rollover). */
export function addDays(year: number, month: number, day: number, days: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** "20:30" -> "8:30 PM" */
export function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** e.g. "Tue, Nov 3 at 5:00 PM" in the bot's time zone. */
export function formatDateTime(date: Date): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day} at ${formatClock(zonedParts(date).time)}`;
}

/** e.g. "2 hours", "3 days", "a minute" — rough, for chat. */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "a few seconds";
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "a day" : `${days} days`;
}

/** Minutes since midnight for "HH:MM". */
export function minutesOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function daysInMonth(month: number): number {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}
