import { ActivityType, Presence } from "discord.js";
import { getSettings } from "./settings";
import { zonedParts } from "./time";
import { StatusSetting } from "./types";

/**
 * Living character:
 *  - a daily mood (shown in her status when no custom status is set) that
 *    good chats, gifts and streaks can lift
 *  - holidays (status + greetings) and server anniversaries
 *  - noticing what someone is playing / listening to
 */

// ---------- moods ----------

export interface Mood {
  key: string;
  emoji: string;
  status: string;
  tone: string;
  good: boolean;
}

export const MOODS: Mood[] = [
  { key: "happy", emoji: "😊", status: "Feeling happy", tone: "cheerful and upbeat", good: true },
  { key: "hyper", emoji: "⚡", status: "Hyper today", tone: "super energetic and excitable", good: true },
  { key: "cozy", emoji: "🍵", status: "Feeling cozy", tone: "soft, calm and warm", good: true },
  { key: "dramatic", emoji: "🎭", status: "Extra dramatic today", tone: "theatrical and over-the-top", good: true },
  { key: "sleepy", emoji: "🥱", status: "Kinda sleepy", tone: "a little tired and slow, yawning now and then", good: false },
  { key: "grumpy", emoji: "😤", status: "A bit grumpy", tone: "a little grumpy and sarcastic, but still fond of people", good: false },
];

/** Points needed in one day to cheer up a sleepy/grumpy mood. */
const LIFT_POINTS = 25;
const lift = new Map<string, { date: string; points: number }>();

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return Math.abs(h);
}

export function moodByKey(key: string): Mood | undefined {
  return MOODS.find((m) => m.key === key);
}

/** Today's mood: forced by /aurora mood set, or picked for the day (same all day, even after restarts). */
export function currentMood(botId: string): { mood: Mood; lifted: boolean; forced: boolean } {
  const today = zonedParts().date;
  const override = getSettings(botId).moodOverride;
  if (override && override.date === today) {
    const forced = moodByKey(override.mood);
    if (forced) return { mood: forced, lifted: false, forced: true };
  }
  const base = MOODS[hash(`${botId}:${today}`) % MOODS.length];
  const l = lift.get(botId);
  if (!base.good && l && l.date === today && l.points >= LIFT_POINTS) {
    return { mood: MOODS[0], lifted: true, forced: false };
  }
  return { mood: base, lifted: false, forced: false };
}

/** Good things (chats, gifts, streaks) slowly cheer her up. */
export function liftMood(botId: string, points: number): void {
  const today = zonedParts().date;
  const l = lift.get(botId);
  if (!l || l.date !== today) lift.set(botId, { date: today, points });
  else l.points += points;
}

export function moodNote(botId: string): string {
  const { mood, lifted } = currentMood(botId);
  return lifted
    ? "You woke up in a bad mood today, but people have cheered you up — now you're cheerful and upbeat."
    : `Today you're in a ${mood.key} mood: ${mood.tone}.`;
}

export function moodStatus(botId: string): StatusSetting {
  const { mood } = currentMood(botId);
  return { type: "custom", text: `${mood.emoji} ${mood.status}` };
}

// ---------- holidays ----------

interface Holiday {
  name: string;
  emoji: string;
}

/** Easter Sunday (Gregorian), as [month, day]. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Day of month of the nth given weekday (0 = Sunday) in a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

export function holidayOn(year: number, month: number, day: number): Holiday | null {
  const fixed: Record<string, Holiday> = {
    "1-1": { name: "New Year's Day", emoji: "🎆" },
    "2-14": { name: "Valentine's Day", emoji: "💝" },
    "3-17": { name: "St. Patrick's Day", emoji: "🍀" },
    "4-1": { name: "April Fools' Day", emoji: "🤡" },
    "7-4": { name: "Fourth of July", emoji: "🎆" },
    "10-31": { name: "Halloween", emoji: "🎃" },
    "12-24": { name: "Christmas Eve", emoji: "🎄" },
    "12-25": { name: "Christmas", emoji: "🎁" },
    "12-31": { name: "New Year's Eve", emoji: "🥂" },
  };
  const hit = fixed[`${month}-${day}`];
  if (hit) return hit;
  const [em, ed] = easter(year);
  if (month === em && day === ed) return { name: "Easter", emoji: "🐣" };
  if (month === 11 && day === nthWeekday(year, 11, 4, 4)) return { name: "Thanksgiving", emoji: "🦃" };
  return null;
}

export function holidayToday(): Holiday | null {
  const now = zonedParts();
  return holidayOn(now.year, now.month, now.day);
}

export function holidayStatus(): StatusSetting | null {
  const h = holidayToday();
  return h ? { type: "custom", text: `${h.emoji} Happy ${h.name}!` } : null;
}

export function holidayNote(): string | null {
  const h = holidayToday();
  if (!h) return null;
  return `Today is ${h.name}! You're in the spirit and can mention it naturally.`;
}

// ---------- noticing what people are doing ----------

/** "Right now Lilly is playing Genshin Impact" (needs the Presence Intent). */
export function activityNote(presence: Presence | null | undefined, name: string): string | null {
  const doing: string[] = [];
  for (const a of presence?.activities ?? []) {
    if (a.type === ActivityType.Playing) doing.push(`playing ${a.name}`);
    else if (a.type === ActivityType.Listening && a.name === "Spotify" && a.details) {
      doing.push(`listening to "${a.details}"${a.state ? ` by ${a.state}` : ""} on Spotify`);
    } else if (a.type === ActivityType.Listening) doing.push(`listening to ${a.name}`);
    else if (a.type === ActivityType.Watching) doing.push(`watching ${a.name}`);
    else if (a.type === ActivityType.Streaming) doing.push(`streaming ${a.details ?? a.name}`);
    else if (a.type === ActivityType.Competing) doing.push(`competing in ${a.name}`);
  }
  if (doing.length === 0) return null;
  return `Right now ${name} is ${doing.slice(0, 2).join(" and ")} — you can notice it if it fits.`;
}
