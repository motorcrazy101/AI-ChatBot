import { Client, EmbedBuilder } from "discord.js";
import { addAffection } from "./affection";
import { logBotPost } from "./chatLog";
import { config } from "./config";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain } from "./featureKit";
import { canPostIn, generateReply, ReplyChannel, sendText } from "./respond";
import { getSettings, saveSettings } from "./settings";
import { daysInMonth, minutesOfDay, MONTHS, zonedParts } from "./time";
import { BotConfig } from "./types";

/**
 * "aurora my birthday is May 5" — she remembers and wishes you a happy
 * birthday on the day (in the server's birthday channel, or by DM).
 */

const SET = /\bmy (?:birthday|bday|b-day|birth day)(?:\s+is(?:\s+on)?|'s(?:\s+on)?|\s+falls on|\s+on|:)\s+(.+)/i;
const ASK =
  /\b(?:(?:when|what)(?:'s|s| is| was)?\s+my\s+(?:birthday|bday|b-day)|(?:do|did) you (?:know|remember|recall) (?:when |what )?my (?:birthday|bday|b-day)(?: is)?|my (?:birthday|bday)\s*\?|remember my (?:birthday|bday)\s*\?)/i;
const FORGET = /\b(?:forget|delete|remove) my (?:birthday|bday)\b/i;

const MONTH_LOOKUP: Record<string, number> = {};
MONTHS.forEach((name, i) => {
  MONTH_LOOKUP[name.toLowerCase()] = i + 1;
  MONTH_LOOKUP[name.slice(0, 3).toLowerCase()] = i + 1;
});
MONTH_LOOKUP.sept = 9;

/** Reads dates like "May 5", "5th of May", "5 May", "5/5" (month/day), "12-25". */
export function parseBirthday(text: string): { month: number; day: number } | null {
  const t = text.toLowerCase().replace(/[,.]/g, " ");
  const names = Object.keys(MONTH_LOOKUP).join("|");
  const valid = (month: number, day: number) =>
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month) ? { month, day } : null;

  let m = t.match(new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) return valid(MONTH_LOOKUP[m[1]], Number(m[2]));
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${names})\\b`));
  if (m) return valid(MONTH_LOOKUP[m[2]], Number(m[1]));
  m = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?\b/);
  if (m) return valid(Number(m[1]), Number(m[2])); // US style: month/day
  return null;
}

const label = (month: number, day: number) => `${MONTHS[month - 1]} ${day}`;

// ---------- storage ----------

interface Birthday {
  userId: string;
  userName: string;
  month: number;
  day: number;
  lastWishedYear: number | null;
}

const memory = new Map<string, Birthday>(); // botId:userId

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

async function saveBirthday(botId: string, b: Birthday): Promise<void> {
  memory.set(`${botId}:${b.userId}`, b);
  if (pool && (await useDb())) {
    await pool.query(
      `INSERT INTO birthdays (bot_id, user_id, user_name, month, day, last_wished_year)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bot_id, user_id) DO UPDATE
         SET user_name = EXCLUDED.user_name, month = EXCLUDED.month, day = EXCLUDED.day,
             last_wished_year = EXCLUDED.last_wished_year`,
      [botId, b.userId, b.userName, b.month, b.day, b.lastWishedYear]
    );
  }
}

async function getBirthday(botId: string, userId: string): Promise<Birthday | null> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      "SELECT user_id, user_name, month, day, last_wished_year FROM birthdays WHERE bot_id = $1 AND user_id = $2",
      [botId, userId]
    );
    if (rows[0]) return toBirthday(rows[0]);
  }
  return memory.get(`${botId}:${userId}`) ?? null;
}

async function deleteBirthday(botId: string, userId: string): Promise<boolean> {
  const had = memory.delete(`${botId}:${userId}`);
  if (pool && (await useDb())) {
    const result = await pool.query("DELETE FROM birthdays WHERE bot_id = $1 AND user_id = $2", [botId, userId]);
    return (result.rowCount ?? 0) > 0 || had;
  }
  return had;
}

function toBirthday(r: Record<string, unknown>): Birthday {
  return {
    userId: String(r.user_id),
    userName: String(r.user_name),
    month: Number(r.month),
    day: Number(r.day),
    lastWishedYear: r.last_wished_year === null || r.last_wished_year === undefined ? null : Number(r.last_wished_year),
  };
}

export async function allBirthdays(botId: string): Promise<Birthday[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      "SELECT user_id, user_name, month, day, last_wished_year FROM birthdays WHERE bot_id = $1 ORDER BY month, day",
      [botId]
    );
    return rows.map(toBirthday);
  }
  return [...memory.entries()]
    .filter(([k]) => k.startsWith(`${botId}:`))
    .map(([, b]) => b)
    .sort((a, b) => a.month - b.month || a.day - b.day);
}

// ---------- chat feature ----------

export const birthdayFeature: Feature = async (ctx) => {
  if (FORGET.test(ctx.text)) {
    const removed = await deleteBirthday(ctx.botConfig.id, ctx.user.id);
    await replyPlain(ctx, removed ? "Okay, I forgot your birthday 🥲" : "I didn't have your birthday saved.");
    return true;
  }

  if (ASK.test(ctx.text)) {
    const saved = await getBirthday(ctx.botConfig.id, ctx.user.id);
    if (!saved) {
      await replyPlain(ctx, "You haven't told me yet! Say something like *my birthday is May 5*.");
      return true;
    }
    const date = label(saved.month, saved.day);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription(`🎂 ${ctx.user.name}'s birthday: **${date}**`);
    await replyInCharacter(
      ctx,
      `${ctx.user.name} asked if you remember their birthday. You DO remember: it's ${date}. ` +
        `Tell them it's ${date} in character, in one short sentence. Don't say you forgot.`,
      { embed, fallback: `Of course! It's ${date} 🎂`, logExtra: `[birthday] ${date}` }
    );
    return true;
  }

  const set = ctx.text.match(SET);
  if (!set) return false;
  const date = parseBirthday(set[1]);
  if (!date) {
    // "my birthday is coming up!" isn't a date — just chat normally.
    const mentionsMonth = Object.keys(MONTH_LOOKUP).some((m) => new RegExp(`\\b${m}\\b`, "i").test(set[1]));
    if (!/\d/.test(set[1]) && !mentionsMonth) return false;
    await replyPlain(ctx, "I couldn't figure out that date 🤔 Try *my birthday is May 5* or *my birthday is 5/5*.");
    return true;
  }

  const existing = await getBirthday(ctx.botConfig.id, ctx.user.id);
  const sameDate = existing && existing.month === date.month && existing.day === date.day;
  await saveBirthday(ctx.botConfig.id, {
    userId: ctx.user.id,
    userName: ctx.user.name,
    month: date.month,
    day: date.day,
    lastWishedYear: sameDate ? existing.lastWishedYear : null,
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`🎂 Birthday saved: **${label(date.month, date.day)}**`)
    .setFooter({ text: isDbReady() ? "Say \"forget my birthday\" to remove it" : "Note: no database, so this is lost if the bot restarts" });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} just told you their birthday is ${label(date.month, date.day)}. ` +
      "React in character in one short sentence, promising to remember it.",
    { embed, fallback: "Saved! I'll remember 🎂", logExtra: `[birthday] ${label(date.month, date.day)}` }
  );
  return true;
};

// ---------- wishing ----------

async function wish(client: Client<true>, botConfig: BotConfig, b: Birthday): Promise<boolean> {
  const channels = getSettings(botConfig.id).birthdayChannels;
  const targets: ReplyChannel[] = [];

  for (const [guildId, channelId] of Object.entries(channels)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const member = await guild.members.fetch(b.userId).catch(() => null);
    if (!member) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isTextBased() && canPostIn(channel as ReplyChannel)) targets.push(channel as ReplyChannel);
  }
  if (targets.length === 0) {
    // No birthday channel in a shared server: wish them by DM instead.
    const user = await client.users.fetch(b.userId).catch(() => null);
    const dm = user ? await user.createDM().catch(() => null) : null;
    if (dm) targets.push(dm);
  }
  if (targets.length === 0) return false;

  for (const channel of targets) {
    let text = `Happy birthday, ${b.userName}! 🎉`;
    try {
      const reply = await generateReply(
        client,
        botConfig,
        channel,
        {
          username: "Server",
          text: `(Today is ${b.userName}'s birthday! Wish them a happy birthday in character — make it warm and special, 2-3 sentences.)`,
        },
        { id: b.userId, name: b.userName }
      );
      if (reply) text = reply;
    } catch (err) {
      console.warn(`[${botConfig.id}] Birthday message from Kindroid failed:`, (err as Error).message);
    }
    const embed = new EmbedBuilder()
      .setColor(0xff7ab6)
      .setTitle(`🎂 Happy Birthday, ${b.userName}! 🎉`.slice(0, 256));
    const sent = await channel.send({
      content: `<@${b.userId}> ${text}`.slice(0, 2000),
      embeds: [embed],
      allowedMentions: { users: [b.userId] },
    });
    await sent.react("🎂").catch(() => undefined);
    logBotPost(botConfig.id, client.user.displayName, sent, "birthday");
  }
  await addAffection(botConfig.id, { id: b.userId, name: b.userName }, "birthday");
  return true;
}

/** Once a minute: after BIRTHDAY_TIME, wish everyone whose birthday is today (once a year). */
export function startBirthdayLoop(client: Client, botConfig: BotConfig): void {
  let running = false;
  setInterval(() => {
    if (!client.isReady() || running) return;
    const now = zonedParts();
    if (minutesOfDay(now.time) < minutesOfDay(config.birthdayTime)) return;
    running = true;

    const isLeapYear = (now.year % 4 === 0 && now.year % 100 !== 0) || now.year % 400 === 0;
    allBirthdays(botConfig.id)
      .then(async (list) => {
        for (const b of list) {
          if (b.lastWishedYear === now.year) continue;
          const isToday =
            (b.month === now.month && b.day === now.day) ||
            // Feb 29 birthdays get celebrated on Feb 28 in non-leap years.
            (!isLeapYear && b.month === 2 && b.day === 29 && now.month === 2 && now.day === 28);
          if (!isToday) continue;

          b.lastWishedYear = now.year;
          await saveBirthday(botConfig.id, b);
          await wish(client, botConfig, b).catch((err) =>
            console.error(`[${botConfig.id}] Birthday wish for ${b.userName} failed:`, err)
          );
        }
      })
      .catch((err) => console.error(`[${botConfig.id}] Birthday check failed:`, (err as Error).message))
      .finally(() => {
        running = false;
      });
  }, 60_000).unref();
}

// ---------- server anniversaries ----------

/** Once a day after BIRTHDAY_TIME: celebrate servers whose creation date is today. */
export function startAnniversaryLoop(client: Client, botConfig: BotConfig): void {
  setInterval(() => {
    if (!client.isReady()) return;
    const now = zonedParts();
    if (minutesOfDay(now.time) < minutesOfDay(config.birthdayTime)) return;
    const settings = getSettings(botConfig.id);

    for (const guild of client.guilds.cache.values()) {
      const created = zonedParts(guild.createdAt);
      const years = now.year - created.year;
      if (years < 1 || created.month !== now.month || created.day !== now.day) continue;
      if (settings.anniversaryPosted[guild.id] === now.year) continue;
      settings.anniversaryPosted[guild.id] = now.year;
      void saveSettings(botConfig.id);

      const channelId =
        settings.birthdayChannels[guild.id] ?? settings.welcomeChannels[guild.id] ?? guild.systemChannelId;
      if (!channelId) continue;
      void (async () => {
        const channel = (await guild.channels.fetch(channelId).catch(() => null)) as ReplyChannel | null;
        if (!channel || !channel.isTextBased() || !canPostIn(channel)) return;
        const reply = await generateReply(client, botConfig, channel, {
          username: "Server",
          text: `(Today is the server "${guild.name}"'s ${years}${ordinal(years)} birthday! Celebrate it with everyone in character, 2-3 sentences.)`,
        }).catch(() => null);
        const sent = await sendText(channel, `🎉 ${reply ?? `Happy ${years}${ordinal(years)} birthday, ${guild.name}!`}`);
        for (const post of sent) logBotPost(botConfig.id, client.user.displayName, post, "birthday");
      })().catch((err) => console.error(`[${botConfig.id}] Anniversary post failed:`, err));
    }
  }, 60_000).unref();
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

