import { Client, EmbedBuilder } from "discord.js";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, replyPlain, truncate } from "./featureKit";
import { isOwner } from "./memory";
import { parseReminder } from "./reminders";
import { canPostIn, ReplyChannel } from "./respond";
import { describeDuration, formatDateTime } from "./time";
import { BotConfig } from "./types";

/**
 * Watch parties:
 *   "aurora watch party friday 8pm frieren"  → posts an event, react 🍿 to join
 *   "aurora upcoming watch parties" / "aurora cancel watch party 3"
 * Everyone who reacted 🍿 gets pinged when it starts.
 */

const POPCORN = "🍿";
const START = /^(?:start|plan|host|schedule|make|set\s+up|create)?\s*(?:an?\s+)?watch\s*party\b[\s:,-]*(.*)$/i;
const LIST = /\b(?:upcoming|list|show|any|next)\s+(?:the\s+)?watch\s*part(?:y|ies)\b|\bwatch\s*parties\b/i;
const CANCEL = /\b(?:cancel|delete|remove|stop)\s+(?:the\s+)?watch\s*party\s*#?(\d+)?/i;

interface WatchParty {
  id: number;
  botId: string;
  guildId: string | null;
  channelId: string;
  messageId: string | null;
  title: string;
  hostId: string;
  hostName: string;
  startsAt: Date;
  done: boolean;
}

const memory: WatchParty[] = [];
let nextMemoryId = 1;

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

type Row = {
  id: string;
  bot_id: string;
  guild_id: string | null;
  channel_id: string;
  message_id: string | null;
  title: string;
  host_id: string;
  host_name: string;
  starts_at: Date;
  done: boolean;
};
const fromRow = (r: Row): WatchParty => ({
  id: Number(r.id),
  botId: r.bot_id,
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  title: r.title,
  hostId: r.host_id,
  hostName: r.host_name,
  startsAt: new Date(r.starts_at),
  done: r.done,
});

async function addParty(p: Omit<WatchParty, "id" | "done">): Promise<WatchParty> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<Row>(
      `INSERT INTO watch_parties (bot_id, guild_id, channel_id, message_id, title, host_id, host_name, starts_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.botId, p.guildId, p.channelId, p.messageId, p.title, p.hostId, p.hostName, p.startsAt]
    );
    return fromRow(rows[0]);
  }
  const party = { ...p, id: nextMemoryId++, done: false };
  memory.push(party);
  return party;
}

async function setMessageId(id: number, messageId: string): Promise<void> {
  const m = memory.find((p) => p.id === id);
  if (m) m.messageId = messageId;
  if (pool && (await useDb())) await pool.query("UPDATE watch_parties SET message_id = $2 WHERE id = $1", [id, messageId]);
}

async function markDone(id: number): Promise<void> {
  const m = memory.find((p) => p.id === id);
  if (m) m.done = true;
  if (pool && (await useDb())) await pool.query("UPDATE watch_parties SET done = true WHERE id = $1", [id]);
}

async function upcoming(botId: string, guildId: string | null): Promise<WatchParty[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<Row>(
      "SELECT * FROM watch_parties WHERE bot_id = $1 AND NOT done AND guild_id IS NOT DISTINCT FROM $2 ORDER BY starts_at LIMIT 10",
      [botId, guildId]
    );
    return rows.map(fromRow);
  }
  return memory.filter((p) => p.botId === botId && !p.done && p.guildId === guildId).sort((a, b) => +a.startsAt - +b.startsAt);
}

async function dueParties(botId: string): Promise<WatchParty[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<Row>("SELECT * FROM watch_parties WHERE bot_id = $1 AND NOT done AND starts_at <= now()", [botId]);
    return rows.map(fromRow);
  }
  return memory.filter((p) => p.botId === botId && !p.done && p.startsAt.getTime() <= Date.now());
}

/** "friday 8pm frieren" → { due, title } using the reminder time parser. */
export function parseWatchParty(rest: string): { due: Date; title: string } | { error: string } {
  const parsed = parseReminder(`remind me ${rest}`);
  if (!parsed) return { error: "no-time" };
  if ("error" in parsed) return parsed;
  const title = parsed.task
    .replace(/^(?:to\s+)?(?:watch(?:ing)?\s+|for\s+|of\s+)?/i, "")
    .replace(/^(?:the\s+)?(?:new\s+)?episode\s+of\s+/i, "")
    .trim();
  return { due: parsed.due, title: title && !title.startsWith("(") ? title : "a surprise anime" };
}

function partyEmbed(p: WatchParty): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`🍿 Watch Party #${p.id}: ${truncate(p.title, 200)}`)
    .setDescription(
      `**When:** ${formatDateTime(p.startsAt)} (<t:${Math.floor(p.startsAt.getTime() / 1000)}:R>)\n` +
        `**Host:** ${p.hostName}\n\nReact with ${POPCORN} to get pinged when it starts!`
    )
    .setFooter({ text: `Cancel with: cancel watch party ${p.id}` });
}

export const watchPartyFeature: Feature = async (ctx) => {
  const botId = ctx.botConfig.id;
  const guildId = ctx.message.guildId;

  const cancel = ctx.text.match(CANCEL);
  if (cancel) {
    const list = await upcoming(botId, guildId);
    const party = cancel[1] ? list.find((p) => p.id === Number(cancel[1])) : list.find((p) => p.hostId === ctx.user.id);
    if (!party) {
      await replyPlain(ctx, "I couldn't find that watch party 🤔 Say *upcoming watch parties* to see the numbers.");
      return true;
    }
    if (party.hostId !== ctx.user.id && !isOwner(botId, ctx.user.id)) {
      await replyPlain(ctx, `Only ${party.hostName} (the host) or the Warden can cancel that one!`);
      return true;
    }
    await markDone(party.id);
    await replyPlain(ctx, `🍿 Watch Party #${party.id} (**${party.title}**) is cancelled.`);
    return true;
  }

  if (LIST.test(ctx.text)) {
    const list = await upcoming(botId, guildId);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("🍿 Upcoming watch parties")
      .setDescription(
        list.map((p) => `**#${p.id}** ${truncate(p.title, 80)} — ${formatDateTime(p.startsAt)} (host: ${p.hostName})`).join("\n") ||
          "None planned yet! Start one: *watch party friday 8pm Frieren*"
      );
    await replyPlain(ctx, "", embed);
    return true;
  }

  const start = ctx.text.match(START);
  if (!start) return false;
  if (!ctx.message.inGuild()) {
    await replyPlain(ctx, "Watch parties are for servers! Start one in a channel 🍿");
    return true;
  }
  const parsed = parseWatchParty(start[1] ?? "");
  if ("error" in parsed) {
    await replyPlain(ctx, "When is it? Try: *watch party friday 8pm Frieren* or *watch party tonight at 9 Dandadan* 🍿");
    return true;
  }
  const party = await addParty({
    botId,
    guildId,
    channelId: ctx.channel.id,
    messageId: null,
    title: parsed.title,
    hostId: ctx.user.id,
    hostName: ctx.user.name,
    startsAt: parsed.due,
  });
  const sent = await ctx.message.reply({
    content: `🍿 **${ctx.user.name}** is hosting a watch party in ${describeDuration(parsed.due.getTime() - Date.now())}!`,
    embeds: [partyEmbed(party)],
    allowedMentions: { parse: [], repliedUser: false },
  });
  logBotPost(botId, ctx.botName, sent, "game");
  await sent.react(POPCORN).catch(() => undefined);
  await setMessageId(party.id, sent.id);
  return true;
};

async function startParty(client: Client<true>, botConfig: BotConfig, p: WatchParty): Promise<void> {
  await markDone(p.id);
  const channel = (await client.channels.fetch(p.channelId).catch(() => null)) as ReplyChannel | null;
  if (!channel || !("send" in channel) || !canPostIn(channel)) return;
  let ids = new Set<string>([p.hostId]);
  if (p.messageId) {
    const msg = await channel.messages.fetch(p.messageId).catch(() => null);
    const users = await msg?.reactions.cache.get(POPCORN)?.users.fetch().catch(() => null);
    if (users) for (const u of users.values()) if (!u.bot) ids.add(u.id);
  }
  ids = new Set([...ids].slice(0, 50));
  const pings = [...ids].map((id) => `<@${id}>`).join(" ");
  const sent = await channel
    .send({
      content: `🍿 **Watch party time!** **${p.title}** is starting now — grab your snacks!\n${pings}`,
      allowedMentions: { users: [...ids] },
    })
    .catch(() => null);
  if (sent) logBotPost(botConfig.id, client.user.displayName, sent, "reminder");
}

export function startWatchPartyLoop(client: Client<true>, botConfig: BotConfig): void {
  const tick = async () => {
    try {
      for (const p of await dueParties(botConfig.id)) await startParty(client, botConfig, p);
    } catch (err) {
      console.error(`[${botConfig.id}] Watch party loop failed:`, (err as Error).message);
    }
  };
  setInterval(tick, 30_000);
  void tick();
}
