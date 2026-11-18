import { Client, EmbedBuilder, Message } from "discord.js";
import { airingLine, airingOn } from "./airing";
import { wardenFor } from "./asylum";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { pick, truncate } from "./featureKit";
import { prescriptionFor } from "./fun";
import { allKnownBirthdays } from "./longTermMemory";
import { isOwner } from "./memory";
import { currentMood, holidayToday } from "./mood";
import { awardMilestones, incrementStat } from "./residentsData";
import { canPostIn, generateReply, ReplyChannel } from "./respond";
import { getSettings, saveSettings } from "./settings";
import { inRange } from "./sleep";
import { addDays, formatClock, minutesOfDay, MONTHS, zonedParts } from "./time";
import { BotConfig } from "./types";

/**
 * Daily Asylum life (each turned on per server with /aurora asylum):
 *   📰 The Asylum Gazette — every morning: mood, holiday, birthdays, anime airing today,
 *      question of the day, the Warden's notice and Nurse Mochi's prescription
 *   📔 Aurora's diary — every night, a diary entry about what actually happened in chat
 *   🌙 Lights-out — an announcement at her bedtime, then the Warden's night patrol
 *      may "catch" people chatting after curfew (just for fun, with a leaderboard)
 */

const PATROL_CHANCE = 0.2;

const QUESTIONS = [
  "Which anime character would survive longest in the Asylum?",
  "What's an anime you'd erase from your memory just to watch again?",
  "Sub or dub — and defend your answer.",
  "Which anime opening lives in your head rent-free?",
  "If you could live in one anime world, which one?",
  "Who's the most overrated anime character? (Be brave.)",
  "What anime made you cry the hardest?",
  "Which anime food would you eat first?",
  "Best anime villain of all time?",
  "What's your comfort anime?",
  "Which anime deserves a season 2 RIGHT NOW?",
  "Pick an anime character to be your roommate in the Asylum.",
  "What's the first anime you ever watched?",
  "Which anime has the best soundtrack?",
  "Who would win: your favorite protagonist vs. the Warden?",
  "What anime trope do you secretly love?",
  "What anime trope do you hate the most?",
  "Which anime would make the best real-life theme park?",
  "Manga or anime — which do you prefer?",
  "What's an underrated anime everyone should watch?",
  "Which anime character has the best fashion sense?",
  "If you had a Death Note… just kidding. What's your favorite anime power?",
  "Which anime friendship is the best?",
  "Which anime would you show to someone who's never watched anime?",
  "Who's your favorite side character?",
  "What's the most chaotic anime you've ever watched?",
  "Which studio do you trust the most?",
  "What's the best anime movie?",
  "Which anime had the best ending? Which had the worst?",
  "Which anime character would you trust to plan an Asylum escape?",
  "Which seasonal anime are you watching right now?",
  "What's an anime you dropped and regret dropping?",
  "Which anime has the best fight scene?",
  "What anime would you rewatch with the whole server?",
  "Who is the best anime mentor?",
  "Which anime character would be the worst Asylum roommate?",
  "If your life was an anime, what genre would it be?",
  "What's your favorite anime ending song?",
  "Which anime made you laugh the most?",
  "Which anime couple is the best? (Or is it a ship war?)",
];

const NOTICES = [
  "Running in the halls is still forbidden. Yes, even for Naruto runners.",
  "Contraband snacks found in Room 214 have been confiscated. They were delicious.",
  "The rec room TV remote has gone missing again. The Warden is watching.",
  "Reminder: lights-out is at 11. The night patrol has new flashlights.",
  "Whoever keeps playing the same opening on repeat at 3 AM: the Warden knows.",
  "The library of forbidden manga is closed for 'inspection'. The Warden is reading volume 12.",
  "Cosplay in the cafeteria is allowed. Cosplay as the Warden is NOT.",
  "Residents caught arguing about sub vs. dub will share a room for a week.",
  "The rooftop is off-limits after dark. The stars are not that pretty. (They are.)",
  "Pudding cups are limited to two per resident. You know who you are.",
  "The East Wing remains locked. No, you can't 'just peek'.",
  "Good behavior this week may result in a movie night. Bad behavior results in filler episodes.",
  "Laundry room ghost sightings must be reported to the Warden, not posted as memes.",
  "Anyone found spoiling the latest episode will be sent to the Basement Ward.",
];

function dateLabel(): string {
  const now = zonedParts();
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(now.year, now.month - 1, now.day, 12))
  );
  return `${weekday}, ${MONTHS[now.month - 1]} ${now.day}`;
}

/** Same pick for everyone all day. */
function dailyPick<T>(list: T[], salt: string): T {
  const date = zonedParts().date;
  let h = 0;
  for (const c of `${salt}${date}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

async function fetchChannel(client: Client<true>, id: string): Promise<ReplyChannel | null> {
  const channel = (await client.channels.fetch(id).catch(() => null)) as ReplyChannel | null;
  if (!channel || !("send" in channel) || !canPostIn(channel)) return null;
  return channel;
}

async function aiLine(client: Client<true>, botConfig: BotConfig, channel: ReplyChannel, instruction: string, length: "short" | "off" = "short"): Promise<string | null> {
  try {
    return await generateReply(client, botConfig, channel, { username: "Server", text: `(${instruction})` }, undefined, [], length);
  } catch (err) {
    console.warn(`[${botConfig.id}] Daily post text failed:`, (err as Error).message);
    return null;
  }
}

// ---------- 📰 the Gazette ----------

export async function postGazette(client: Client<true>, botConfig: BotConfig, channel: ReplyChannel): Promise<void> {
  const now = zonedParts();
  const guild = "guild" in channel ? channel.guild : null;
  const { mood } = currentMood(botConfig.id);
  const holiday = holidayToday();
  const warden = wardenFor(botConfig.id, guild);

  const birthdays = (await allKnownBirthdays(botConfig.id).catch(() => []))
    .filter((b) => b.month === now.month && b.day === now.day)
    .filter((b) => !guild || guild.members.cache.has(b.userId))
    .map((b) => guild?.members.cache.get(b.userId)?.displayName ?? b.userName);

  let airing = "The schedule office is closed today (couldn't reach AniList).";
  try {
    const items = await airingOn(0, 5);
    airing = items.length ? items.map(airingLine).join("\n") : "Nothing big airing today — rewatch day!";
  } catch {
    /* keep the fallback */
  }

  const question = dailyPick(QUESTIONS, "q");
  const notice = dailyPick(NOTICES, "n");
  const rx = prescriptionFor("server", now.date);

  const intro = await aiLine(
    client,
    botConfig,
    channel,
    `Write a short good-morning greeting (1-2 sentences) to open today's edition of "The Asylum Gazette", the Anime Asylum's ` +
      `morning newsletter. Today you're feeling ${mood.tone}.${holiday ? ` It's ${holiday.name}!` : ""}` +
      (birthdays.length ? ` It's ${birthdays.join(" and ")}'s birthday today.` : "")
  );

  const embed = new EmbedBuilder()
    .setColor(0xf4d58d)
    .setTitle(`📰 The Asylum Gazette — ${dateLabel()}`)
    .setDescription(truncate(intro ?? "Good morning, residents! Rise and shine — the Asylum awaits. ☀️", 1000))
    .addFields(
      { name: "🌡️ Aurora's mood", value: `${mood.emoji} ${mood.status}`, inline: true },
      { name: "📅 Today", value: holiday ? `${holiday.emoji} ${holiday.name}` : "Just a regular Asylum day", inline: true },
      { name: "🎂 Birthdays", value: birthdays.length ? birthdays.map((n) => `🎉 ${n}`).join("\n") : "None today", inline: true },
      { name: "📺 Airing today", value: truncate(airing, 1000) },
      { name: "❓ Question of the day", value: question },
      { name: `📢 Notice from ${warden.name}, the Warden`, value: notice },
      { name: "💊 Nurse Mochi's prescription", value: `${rx.dose}. ${rx.directions}` }
    )
    .setFooter({ text: "Just for fun · Nurse Mochi is not a real nurse 💕" });
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "daily");
}

// ---------- 📔 the diary ----------

async function todaysChat(botId: string, guildId: string): Promise<string> {
  await initDb();
  if (!pool || !isDbReady()) return "";
  const { rows } = await pool.query<{ user_name: string; channel_name: string | null; content: string }>(
    `SELECT user_name, channel_name, content FROM chat_logs
      WHERE bot_id = $1 AND guild_id = $2 AND NOT is_dm AND direction = 'incoming' AND created_at > now() - interval '18 hours'
      ORDER BY created_at DESC LIMIT 120`,
    [botId, guildId]
  );
  return rows
    .reverse()
    .filter((r) => r.content && !r.user_name.startsWith("("))
    .map((r) => `${r.user_name}: ${truncate(r.content.replace(/\s+/g, " "), 140)}`)
    .join("\n")
    .slice(-3500);
}

export async function postDiary(client: Client<true>, botConfig: BotConfig, channel: ReplyChannel): Promise<void> {
  const guildId = "guild" in channel ? channel.guild.id : null;
  const chat = guildId ? await todaysChat(botConfig.id, guildId) : "";
  const { mood } = currentMood(botConfig.id);
  const text = await aiLine(
    client,
    botConfig,
    channel,
    `Write tonight's entry in your private diary ("Dear diary, …"), as yourself, in first person, 80-150 words. ` +
      `Today you were feeling ${mood.tone}. ` +
      (chat
        ? `Here's what people said in the server today (you saw all of it):\n${chat}\n` +
          "Mention 2-4 real moments or people from that, with your honest feelings. Keep it kind and playful — no secrets from DMs, nothing embarrassing."
        : "It was a quiet day in the Asylum. Write about that.") +
      " End with a sleepy sign-off.",
    "off"
  );
  const embed = new EmbedBuilder()
    .setColor(0xb39ddb)
    .setTitle(`📔 ${client.user.displayName}'s Diary — ${dateLabel()}`)
    .setDescription(truncate(text ?? "Dear diary… today was a blur. I'll write more tomorrow. 😴", 1500))
    .setFooter({ text: "Written before bed · don't tell anyone you read this 🤫" });
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "daily");
}

// ---------- 🌙 lights-out & night patrol ----------

/** The date the current night started (yesterday if it's after midnight). */
function nightDate(botId: string): string | null {
  const { bedtime, wake } = getSettings(botId).sleep;
  const now = zonedParts();
  const minutes = minutesOfDay(now.time);
  if (!inRange(minutes, minutesOfDay(bedtime), minutesOfDay(wake))) return null;
  if (minutes >= minutesOfDay(bedtime)) return now.date;
  const [y, m, d] = addDays(now.year, now.month, now.day, -1);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export async function postLightsOut(client: Client<true>, botConfig: BotConfig, channel: ReplyChannel): Promise<void> {
  const guild = "guild" in channel ? channel.guild : null;
  const warden = wardenFor(botConfig.id, guild);
  const { wake } = getSettings(botConfig.id).sleep;
  const text = await aiLine(
    client,
    botConfig,
    channel,
    `It's lights-out in the Anime Asylum. Announce it to the residents in 1-2 sentences, sleepy and playful. ` +
      `Warn them that ${warden.name} (the Warden) is starting the night patrol, so anyone still chatting might get caught.`
  );
  const embed = new EmbedBuilder()
    .setColor(0x1f2a44)
    .setTitle("🌙 Lights out, residents!")
    .setDescription(
      `${truncate(text ?? "Lights out, everyone! Sweet dreams… 😴", 800)}\n\n` +
        `🔦 **The Warden's night patrol is on until ${formatClock(wake)}.** Anyone chatting after curfew might get caught!`
    )
    .setFooter({ text: "Most caught after curfew: say \"curfew leaderboard\"" });
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "daily");
}

const PUNISHMENTS = [
  "has been sentenced to rewatch every filler episode of Naruto",
  "must write \"I will respect lights-out\" 100 times on the chalkboard",
  "has lost pudding privileges for a day",
  "has been assigned laundry duty in the haunted laundry room",
  "must sing the Asylum anthem at breakfast",
  "is on hallway-mopping duty with a toothbrush",
  "has been confined to their room with only a dub of their least favorite anime",
  "must give the Warden their best snack as a fine",
  "has been sent to bed with a stern look and a glass of warm milk",
  "must do 10 dramatic anime pose push-ups",
];

const caughtTonight = new Map<string, string>(); // botId:userId -> night date

/**
 * The night patrol: during lights-out, people chatting in a server with curfew
 * on might get "caught" (at most once per person per night). Not the Warden.
 */
export async function nightPatrol(message: Message, client: Client<true>, botConfig: BotConfig, user: { id: string; name: string }): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  const settings = getSettings(botConfig.id);
  if (!settings.daily.curfewChannels[message.guildId]) return;
  if (isOwner(botConfig.id, user.id)) return;
  const night = nightDate(botConfig.id);
  if (!night) return;
  const key = `${botConfig.id}:${user.id}`;
  if (caughtTonight.get(key) === night) return;
  if (Math.random() >= PATROL_CHANCE) return;
  caughtTonight.set(key, night);

  const warden = wardenFor(botConfig.id, message.guild);
  const total = await incrementStat(botConfig.id, user.id, "curfew");
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚨 Caught by the Warden's night patrol!")
    .setDescription(
      `🔦 **${user.name}** was caught chatting after lights-out by ${warden.name}, the Warden.\n` +
        `They ${pick(PUNISHMENTS)}.`
    )
    .setFooter({ text: `Times caught: ${total} · "curfew leaderboard" for the hall of shame` });
  const sent = await message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
  if (sent) logBotPost(botConfig.id, client.user.displayName, sent, "daily");
  await awardMilestones(botConfig.id, user, total, [[1, "caught1"], [10, "caught10"]], message.channel as ReplyChannel);
}

// ---------- the daily loop ----------

/** True if `time` ("HH:MM") was reached within the last 15 minutes. */
function justReached(time: string, now: string): boolean {
  const diff = minutesOfDay(now) - minutesOfDay(time);
  return diff >= 0 && diff < 15;
}

async function dailyTick(client: Client<true>, botConfig: BotConfig): Promise<void> {
  const settings = getSettings(botConfig.id);
  const d = settings.daily;
  const now = zonedParts();
  let changed = false;

  for (const [guildId, channelId] of Object.entries(d.gazetteChannels)) {
    if (d.lastGazette[guildId] === now.date || !justReached(d.gazetteTime, now.time)) continue;
    d.lastGazette[guildId] = now.date;
    changed = true;
    const channel = await fetchChannel(client, channelId);
    if (channel) await postGazette(client, botConfig, channel).catch((e) => console.error(`[${botConfig.id}] Gazette failed:`, e));
  }

  for (const [guildId, channelId] of Object.entries(d.diaryChannels)) {
    if (d.lastDiary[guildId] === now.date || !justReached(d.diaryTime, now.time)) continue;
    d.lastDiary[guildId] = now.date;
    changed = true;
    const channel = await fetchChannel(client, channelId);
    if (channel) await postDiary(client, botConfig, channel).catch((e) => console.error(`[${botConfig.id}] Diary failed:`, e));
  }

  const night = nightDate(botConfig.id);
  if (night && justReached(settings.sleep.bedtime, now.time)) {
    for (const [guildId, channelId] of Object.entries(d.curfewChannels)) {
      if (d.lastCurfew[guildId] === night) continue;
      d.lastCurfew[guildId] = night;
      changed = true;
      const channel = await fetchChannel(client, channelId);
      if (channel) await postLightsOut(client, botConfig, channel).catch((e) => console.error(`[${botConfig.id}] Lights-out failed:`, e));
    }
  }

  if (changed) await saveSettings(botConfig.id);
}

export function startDailyLoop(client: Client<true>, botConfig: BotConfig): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dailyTick(client, botConfig);
    } catch (err) {
      console.error(`[${botConfig.id}] Daily loop failed:`, (err as Error).message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, 60_000);
  void tick();
}
