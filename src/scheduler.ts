import { Client } from "discord.js";
import { logBotPost } from "./chatLog";
import { config } from "./config";
import { botDisplayName, canPostIn, generateReply, ReplyChannel, sendText } from "./respond";
import { getSettings, saveSettings } from "./settings";
import { BotConfig, ScheduleDays, ScheduledPost } from "./types";

/** Scheduled posts, e.g. a good-morning message every day at 8:00. */

const CHECK_EVERY_MS = 20_000;

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const WEEKENDS = ["sat", "sun"];

export const DAY_LABELS: Record<ScheduleDays, string> = {
  daily: "every day",
  weekdays: "weekdays (Mon–Fri)",
  weekends: "weekends (Sat–Sun)",
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

/** Current date, time and weekday in the bot's TIMEZONE. */
function nowInTimezone(): { date: string; time: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: get("weekday").toLowerCase().slice(0, 3),
  };
}

function runsToday(days: ScheduleDays, weekday: string): boolean {
  if (days === "daily") return true;
  if (days === "weekdays") return WEEKDAYS.includes(weekday);
  if (days === "weekends") return WEEKENDS.includes(weekday);
  return days === weekday;
}

/**
 * Reads times like "8am", "8:30 pm", "08:00" or "20:30".
 * Returns 24-hour "HH:MM", or null if it can't be understood.
 */
export function parseTime(input: string): string | null {
  const match = input.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.replace(/\./g, "");
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "20:30" -> "8:30 PM" */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export async function runScheduledPost(
  client: Client<true>,
  botConfig: BotConfig,
  post: ScheduledPost
): Promise<void> {
  const fetched = await client.channels.fetch(post.channelId).catch(() => null);
  if (!fetched || !fetched.isTextBased() || fetched.isDMBased()) {
    console.warn(`[${botConfig.id}] Scheduled post #${post.id}: channel ${post.channelId} not found`);
    return;
  }
  const channel = fetched as ReplyChannel;
  if (!canPostIn(channel)) {
    console.warn(`[${botConfig.id}] Scheduled post #${post.id}: no permission to post in channel ${post.channelId}`);
    return;
  }

  const reply = await generateReply(client, botConfig, channel, {
    username: "Server",
    text: post.prompt,
  });
  if (!reply) return;

  const sent = await sendText(channel, reply);
  const name = botDisplayName(client, channel);
  for (const message of sent) logBotPost(botConfig.id, name, message, "scheduled");
}

/** Checks every 20 seconds for scheduled posts that are due. */
export function startScheduler(client: Client, botConfig: BotConfig): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!client.isReady()) return;
    const now = nowInTimezone();
    const settings = getSettings(botConfig.id);

    const due = settings.schedules.filter(
      (post) =>
        post.time === now.time && post.lastRunDate !== now.date && runsToday(post.days, now.weekday)
    );
    if (due.length === 0) return;

    for (const post of due) post.lastRunDate = now.date;
    void saveSettings(botConfig.id);

    for (const post of due) {
      runScheduledPost(client, botConfig, post).catch((err) =>
        console.error(`[${botConfig.id}] Scheduled post #${post.id} failed:`, err)
      );
    }
  }, CHECK_EVERY_MS);
  timer.unref();
  return timer;
}
