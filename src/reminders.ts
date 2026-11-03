import { Client, EmbedBuilder } from "discord.js";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";
import { canPostIn, generateReply, ReplyChannel } from "./respond";
import { addDays, describeDuration, formatDateTime, zonedParts, zonedTimeToDate } from "./time";
import { BotConfig } from "./types";

/**
 * "aurora remind me in 2 hours to take out the trash"
 * "aurora remind me tomorrow at 9am to call mom"
 * "aurora my reminders" / "aurora cancel reminder 3"
 * Saved in the reminders table so they survive restarts (memory only without a database).
 */

const MAX_PER_USER = 10;
const MAX_DAYS_AHEAD = 365;

const TRIGGER = /\bremind me\b/i;
const LIST = /\b(?:my reminders|what are my reminders|(?:list|show)(?: me)? (?:my )?reminders)\b/i;
const CANCEL = /\b(?:cancel|delete|remove|forget|stop)\s+(?:my\s+)?reminder\s*#?(\d+)\b/i;

const UNIT_MS: [RegExp, number][] = [
  [/^(s|secs?|seconds?)$/i, 1_000],
  [/^(m|mins?|minutes?)$/i, 60_000],
  [/^(h|hrs?|hours?)$/i, 3_600_000],
  [/^(d|days?)$/i, 86_400_000],
  [/^(w|wks?|weeks?)$/i, 604_800_000],
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function amount(word: string): number {
  if (/^(a|an|one)$/i.test(word)) return 1;
  return Number.parseFloat(word);
}
function unitMs(unit: string): number | null {
  return UNIT_MS.find(([pattern]) => pattern.test(unit))?.[1] ?? null;
}

export type ParsedReminder = { due: Date; task: string } | { error: string };

/** Reads the time and task out of a "remind me ..." message. */
export function parseReminder(text: string, now: Date = new Date()): ParsedReminder | null {
  const index = text.search(TRIGGER);
  if (index === -1) return null;
  let rest = text.slice(index).replace(TRIGGER, " ");
  let due: Date | null = null;

  // Relative: "in 2 hours", "in an hour and 30 minutes", "in half an hour"
  const half = rest.match(/\bin\s+half\s+an?\s+hour\b/i);
  const relative = rest.match(
    /\bin\s+(an?|one|\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\b(?:\s+and\s+(an?|one|\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b)?/i
  );
  if (half) {
    due = new Date(now.getTime() + 30 * 60_000);
    rest = rest.replace(half[0], " ");
  } else if (relative) {
    let ms = amount(relative[1]) * (unitMs(relative[2]) ?? 0);
    if (relative[3] && relative[4]) ms += amount(relative[3]) * (unitMs(relative[4]) ?? 0);
    if (ms > 0) due = new Date(now.getTime() + ms);
    rest = rest.replace(relative[0], " ");
  } else {
    // Absolute: "at 5pm", "tomorrow at 9", "tonight", "on friday at noon"
    const dayWord = rest.match(/\b(today|tonight|tomorrow|tmrw|tmr)\b/i);
    const weekday = rest.match(/\b(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    const clock = rest.match(
      /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\W|$)|\bat\s+(\d{1,2}):(\d{2})\b|\bat\s+(\d{1,2})\b(?!\s*(?:min|hour|day|week))|\b(?:at\s+)?(noon|midnight)\b/i
    );
    if (!dayWord && !weekday && !clock) return { error: "no-time" };

    const today = zonedParts(now);
    let hour = 9;
    let minute = 0;
    let ambiguous = false;
    if (clock) {
      if (clock[1]) {
        hour = Number(clock[1]) % 12;
        minute = Number(clock[2] ?? 0);
        if (/^p/i.test(clock[3])) hour += 12;
      } else if (clock[4]) {
        hour = Number(clock[4]);
        minute = Number(clock[5]);
      } else if (clock[6]) {
        hour = Number(clock[6]);
        ambiguous = hour >= 1 && hour <= 11;
      } else if (clock[7]) {
        hour = /noon/i.test(clock[7]) ? 12 : 0;
      }
      if (hour > 23 || minute > 59) return { error: "bad-time" };
      rest = rest.replace(clock[0], " ");
    } else if (dayWord && /tonight/i.test(dayWord[1])) {
      hour = 20;
    }
    if (dayWord && /tonight/i.test(dayWord[1]) && ambiguous) {
      hour += 12;
      ambiguous = false;
    }

    let offsetDays = 0;
    if (dayWord && /^(tomorrow|tmrw|tmr)$/i.test(dayWord[1])) offsetDays = 1;
    if (weekday) {
      const target = WEEKDAYS.indexOf(weekday[1].toLowerCase());
      const current = WEEKDAYS.findIndex((d) => d.startsWith(today.weekday));
      offsetDays = (target - current + 7) % 7;
    }
    if (dayWord) rest = rest.replace(dayWord[0], " ");
    if (weekday) rest = rest.replace(weekday[0], " ");

    const at = (h: number, extraDays: number) => {
      const [y, m, d] = addDays(today.year, today.month, today.day, offsetDays + extraDays);
      return zonedTimeToDate(y, m, d, h, minute);
    };
    due = at(hour, 0);
    // "at 5" with no am/pm: pick whichever 5 o'clock comes next.
    if (ambiguous && due <= now) {
      const pm = at(hour + 12, 0);
      if (pm > now) due = pm;
    }
    // A time that already passed today means tomorrow (or next week for a weekday).
    if (due <= now) due = at(hour, weekday ? 7 : 1);
  }

  if (!due) return { error: "no-time" };
  if (due.getTime() - now.getTime() < 10_000) return { error: "too-soon" };
  if (due.getTime() - now.getTime() > MAX_DAYS_AHEAD * 86_400_000) return { error: "too-far" };

  const task = rest
    .replace(/\b(please|pls|plz)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(to|that|about|of|for|i need to|i have to|i gotta|i should)\s+/i, "")
    .replace(/^(to|that|about)\s+/i, "")
    .replace(/[\s,.!?]+$/, "")
    .replace(/^[\s,]+/, "")
    .trim();
  return { due, task: task || "(you didn't say what!)" };
}

// ---------- storage ----------

interface Reminder {
  id: number;
  botId: string;
  userId: string;
  userName: string;
  guildId: string | null;
  channelId: string;
  dueAt: Date;
  text: string;
  createdAt: Date;
}

const memory: Reminder[] = [];
let memoryId = 1;

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

function fromRow(r: Record<string, unknown>): Reminder {
  return {
    id: Number(r.id),
    botId: String(r.bot_id),
    userId: String(r.user_id),
    userName: String(r.user_name),
    guildId: r.guild_id ? String(r.guild_id) : null,
    channelId: String(r.channel_id),
    dueAt: new Date(r.due_at as string),
    text: String(r.text),
    createdAt: new Date(r.created_at as string),
  };
}

async function addReminder(r: Omit<Reminder, "id" | "createdAt">): Promise<number> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reminders (bot_id, user_id, user_name, guild_id, channel_id, due_at, text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [r.botId, r.userId, r.userName, r.guildId, r.channelId, r.dueAt.toISOString(), r.text]
    );
    return Number(rows[0].id);
  }
  const id = memoryId++;
  memory.push({ ...r, id, createdAt: new Date() });
  return id;
}

async function userReminders(botId: string, userId: string): Promise<Reminder[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      `SELECT * FROM reminders WHERE bot_id = $1 AND user_id = $2 AND NOT delivered ORDER BY due_at`,
      [botId, userId]
    );
    return rows.map(fromRow);
  }
  return memory.filter((r) => r.botId === botId && r.userId === userId).sort((a, b) => +a.dueAt - +b.dueAt);
}

async function cancelReminder(botId: string, userId: string, id: number): Promise<boolean> {
  if (pool && (await useDb())) {
    const result = await pool.query(
      `DELETE FROM reminders WHERE id = $1 AND bot_id = $2 AND user_id = $3 AND NOT delivered`,
      [id, botId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }
  const index = memory.findIndex((r) => r.id === id && r.botId === botId && r.userId === userId);
  if (index === -1) return false;
  memory.splice(index, 1);
  return true;
}

/** Takes reminders that are due (and marks them delivered so they only fire once). */
async function takeDue(botId: string): Promise<Reminder[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      `UPDATE reminders SET delivered = true
        WHERE id IN (SELECT id FROM reminders
                      WHERE bot_id = $1 AND NOT delivered AND due_at <= now()
                      ORDER BY due_at LIMIT 20)
        RETURNING *`,
      [botId]
    );
    return rows.map(fromRow);
  }
  const now = Date.now();
  const due = memory.filter((r) => r.botId === botId && r.dueAt.getTime() <= now);
  for (const r of due) memory.splice(memory.indexOf(r), 1);
  return due;
}

// ---------- chat feature ----------

const ERRORS: Record<string, string> = {
  "no-time": "When should I remind you? Try *remind me in 2 hours to…* or *remind me tomorrow at 9am to…*",
  "bad-time": "That time doesn't look right 🤔 Try something like *at 5pm* or *at 17:30*.",
  "too-soon": "That's basically right now 😄 Give me at least a few seconds!",
  "too-far": `I can only remember things up to ${MAX_DAYS_AHEAD} days ahead.`,
};

export const reminderFeature: Feature = async (ctx) => {
  const cancel = ctx.text.match(CANCEL);
  if (cancel) {
    const ok = await cancelReminder(ctx.botConfig.id, ctx.user.id, Number(cancel[1]));
    await replyPlain(ctx, ok ? `🗑️ Reminder #${cancel[1]} cancelled.` : `You don't have a reminder #${cancel[1]}.`);
    return true;
  }

  if (LIST.test(ctx.text)) {
    const list = await userReminders(ctx.botConfig.id, ctx.user.id);
    if (list.length === 0) {
      await replyPlain(ctx, "You don't have any reminders right now. Try *remind me in 1 hour to…*");
      return true;
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("⏰ Your reminders")
      .setDescription(list.map((r) => `**#${r.id}** · ${formatDateTime(r.dueAt)} — ${truncate(r.text, 120)}`).join("\n"))
      .setFooter({ text: "Cancel one with: cancel reminder <number>" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  const parsed = parseReminder(ctx.text);
  if (!parsed) return false;
  if ("error" in parsed) {
    await replyPlain(ctx, ERRORS[parsed.error] ?? ERRORS["no-time"]);
    return true;
  }

  const existing = await userReminders(ctx.botConfig.id, ctx.user.id);
  if (existing.length >= MAX_PER_USER) {
    await replyPlain(ctx, `You already have ${MAX_PER_USER} reminders! Cancel one first (*my reminders* to see them).`);
    return true;
  }

  const id = await addReminder({
    botId: ctx.botConfig.id,
    userId: ctx.user.id,
    userName: ctx.user.name,
    guildId: ctx.message.guildId,
    channelId: ctx.channel.id,
    dueAt: parsed.due,
    text: parsed.task,
  });

  const when = formatDateTime(parsed.due);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`⏰ **Reminder #${id}** · ${when} (in ${describeDuration(parsed.due.getTime() - Date.now())})\n> ${truncate(parsed.task, 300)}`)
    .setFooter({ text: isDbReady() ? "Cancel with: cancel reminder " + id : "Note: no database, so this is lost if the bot restarts" });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked you to remind them to "${parsed.task}" on ${when}. ` +
      "Confirm in character in one short sentence that you'll remind them.",
    { embed, fallback: "Got it, I'll remind you!", logExtra: `[reminder #${id}] ${when}: ${parsed.task}` }
  );
  return true;
};

// ---------- delivery ----------

async function deliver(client: Client<true>, botConfig: BotConfig, reminder: Reminder): Promise<void> {
  let channel: ReplyChannel | null = null;
  const fetched = await client.channels.fetch(reminder.channelId).catch(() => null);
  if (fetched && fetched.isTextBased() && "send" in fetched) {
    const candidate = fetched as ReplyChannel;
    if (canPostIn(candidate)) channel = candidate;
  }
  if (!channel) {
    const user = await client.users.fetch(reminder.userId).catch(() => null);
    channel = user ? await user.createDM().catch(() => null) : null;
  }
  if (!channel) {
    console.warn(`[${botConfig.id}] Could not deliver reminder #${reminder.id}: no channel`);
    return;
  }

  const lateMs = Date.now() - reminder.dueAt.getTime();
  const ago = describeDuration(Date.now() - reminder.createdAt.getTime());
  let text = `⏰ Reminder: ${reminder.text}`;
  try {
    const reply = await generateReply(
      client,
      botConfig,
      channel,
      {
        username: "Server",
        text:
          `(It's time to remind ${reminder.userName} to "${reminder.text}" — they asked you ${ago} ago` +
          `${lateMs > 10 * 60_000 ? `, and you're ${describeDuration(lateMs)} late, so apologize` : ""}. ` +
          "Remind them in character in 1-2 short sentences.)",
      },
      { id: reminder.userId, name: reminder.userName }
    );
    if (reply) text = reply;
  } catch (err) {
    console.warn(`[${botConfig.id}] Reminder message from Kindroid failed:`, (err as Error).message);
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`⏰ **Reminder #${reminder.id}**\n> ${truncate(reminder.text, 300)}`)
    .setFooter({ text: `Set ${ago} ago` });
  const sent = await channel.send({
    content: `<@${reminder.userId}> ${text}`.slice(0, 2000),
    embeds: [embed],
    allowedMentions: { users: [reminder.userId] },
  });
  logBotPost(botConfig.id, client.user.displayName, sent, "reminder");
}

/** Checks for due reminders every 15 seconds. */
export function startReminderLoop(client: Client, botConfig: BotConfig): void {
  let running = false;
  setInterval(() => {
    if (!client.isReady() || running) return;
    running = true;
    takeDue(botConfig.id)
      .then((due) =>
        Promise.all(
          due.map((r) =>
            deliver(client, botConfig, r).catch((err) =>
              console.error(`[${botConfig.id}] Reminder #${r.id} failed:`, err)
            )
          )
        )
      )
      .catch((err) => console.error(`[${botConfig.id}] Reminder check failed:`, (err as Error).message))
      .finally(() => {
        running = false;
      });
  }, 15_000).unref();
}
