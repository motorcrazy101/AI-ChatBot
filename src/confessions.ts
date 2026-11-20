import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Message,
  MessageFlags,
} from "discord.js";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { isOwner, ownerIds } from "./memory";
import { canPostIn, generateReply, ReplyChannel } from "./respond";
import { getSettings } from "./settings";
import { zonedParts } from "./time";
import { BotConfig } from "./types";

/**
 * Anonymous confessions: members DM her "confess: ..." and it's posted
 * without their name in the server's confession channel. By default the
 * owner gets a DM with Approve / Reject buttons first.
 * (Members don't see who sent it; the owner reviewing it can.)
 */

const TRIGGER = /^\s*(?:confess(?:ion)?|anon(?:ymous)?(?: confession)?)\s*[:\-–]\s*([\s\S]+)$/i;
const MAX_LENGTH = 1000;
const MAX_PER_DAY = 3;

interface Confession {
  id: number;
  botId: string;
  guildId: string;
  userId: string;
  text: string;
  status: "pending" | "posted" | "rejected" | "revoked";
  number?: number;
  /** Where the posted confession is, so it can be taken down again. */
  channelId?: string | null;
  messageId?: string | null;
}

const memory = new Map<number, Confession>();
let memoryId = 1;
const perDay = new Map<string, { date: string; count: number }>();

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

async function save(c: Omit<Confession, "id">): Promise<number> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO confessions (bot_id, guild_id, user_id, text, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [c.botId, c.guildId, c.userId, c.text, c.status]
    );
    return Number(rows[0].id);
  }
  const id = memoryId++;
  memory.set(id, { ...c, id });
  return id;
}

async function load(id: number): Promise<Confession | null> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query("SELECT * FROM confessions WHERE id = $1", [id]);
    const r = rows[0];
    return r ? fromRow(r) : null;
  }
  return memory.get(id) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRow(r: any): Confession {
  return {
    id: Number(r.id),
    botId: r.bot_id,
    guildId: r.guild_id,
    userId: r.user_id,
    text: r.text,
    status: r.status,
    number: r.number ?? undefined,
    channelId: r.channel_id ?? null,
    messageId: r.message_id ?? null,
  };
}

/** A posted confession by its public number in a server. */
async function loadByNumber(botId: string, guildId: string, number: number): Promise<Confession | null> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      "SELECT * FROM confessions WHERE bot_id = $1 AND guild_id = $2 AND number = $3 ORDER BY id DESC LIMIT 1",
      [botId, guildId, number]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
  return [...memory.values()].find((c) => c.botId === botId && c.guildId === guildId && c.number === number) ?? null;
}

async function savePostedMessage(c: Confession, channelId: string, messageId: string): Promise<void> {
  c.channelId = channelId;
  c.messageId = messageId;
  if (memory.has(c.id)) memory.set(c.id, c);
  if (pool && (await useDb())) {
    await pool.query("UPDATE confessions SET channel_id = $2, message_id = $3 WHERE id = $1", [c.id, channelId, messageId]);
  }
}

async function markRevoked(c: Confession): Promise<void> {
  c.status = "revoked";
  if (memory.has(c.id)) memory.set(c.id, c);
  if (pool && (await useDb())) await pool.query("UPDATE confessions SET status = 'revoked' WHERE id = $1", [c.id]);
}

/**
 * Takes a posted confession down: deletes the post and marks it revoked.
 * Returns a message for the owner.
 */
export async function revokeConfession(client: Client<true>, c: Confession): Promise<string> {
  if (c.status === "revoked") {
    // Already revoked, but the post might still be up (e.g. an older confession): try again.
    const removed = c.number ? await findAndDeletePost(client, c) : false;
    return removed
      ? `🗑️ Found Confession #${c.number} and deleted its post.`
      : `Confession #${c.number ?? c.id} was already revoked, and I couldn't find its post anymore.`;
  }
  if (c.status !== "posted") return `Confession #${c.number ?? c.id} was never posted (it's ${c.status}).`;
  let deleted = false;
  if (c.channelId && c.messageId) {
    const channel = (await client.channels.fetch(c.channelId).catch(() => null)) as ReplyChannel | null;
    const message = channel && "messages" in channel ? await channel.messages.fetch(c.messageId).catch(() => null) : null;
    if (message) deleted = await message.delete().then(() => true).catch(() => false);
  }
  // Older confessions (posted before revoking existed) don't have their post saved,
  // so look for "Anonymous Confession #N" in the confession channel instead.
  if (!deleted && c.number) deleted = await findAndDeletePost(client, c);
  await markRevoked(c);
  return deleted
    ? `🗑️ Confession #${c.number ?? c.id} was revoked and its post was deleted.`
    : `🗑️ Confession #${c.number ?? c.id} was revoked, but I couldn't delete the post (it may already be gone). Delete it by hand if it's still there.`;
}

/** Searches the last 500 messages of the confession channel for this confession's post. */
async function findAndDeletePost(client: Client<true>, c: Confession): Promise<boolean> {
  const channelId = c.channelId ?? getSettings(c.botId).confessionChannels[c.guildId];
  if (!channelId) return false;
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as ReplyChannel | null;
  if (!channel || !("messages" in channel)) return false;
  const title = `Anonymous Confession #${c.number}`;
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) return false;
    for (const message of batch.values()) {
      if (message.author.id !== client.user.id) continue;
      if (message.embeds.some((e) => e.title?.endsWith(title))) {
        return message.delete().then(() => true).catch(() => false);
      }
    }
    before = batch.last()?.id;
  }
  return false;
}

/** /aurora confessions revoke <number> (owner only). */
export async function revokeConfessionByNumber(client: Client<true>, botId: string, guildId: string, number: number): Promise<string> {
  const c = await loadByNumber(botId, guildId, number);
  if (!c) return `I couldn't find confession #${number} in this server.`;
  return revokeConfession(client, c);
}

/** Marks it posted/rejected; returns the public confession number when posted. */
async function setStatus(c: Confession, status: "posted" | "rejected"): Promise<number> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ number: number }>(
      `UPDATE confessions SET status = $2,
         number = CASE WHEN $2 = 'posted'
           THEN (SELECT COALESCE(MAX(number), 0) + 1 FROM confessions WHERE bot_id = $3 AND guild_id = $4)
           ELSE number END
       WHERE id = $1 RETURNING number`,
      [c.id, status, c.botId, c.guildId]
    );
    return rows[0]?.number ?? c.id;
  }
  c.status = status;
  memory.set(c.id, c);
  if (status === "posted") {
    c.number = [...memory.values()].filter((x) => x.guildId === c.guildId && x.status === "posted").length;
  }
  return c.number ?? c.id;
}

async function post(client: Client<true>, botConfig: BotConfig, c: Confession): Promise<boolean> {
  const channelId = getSettings(botConfig.id).confessionChannels[c.guildId];
  const guild = client.guilds.cache.get(c.guildId);
  if (!channelId || !guild) return false;
  const channel = (await guild.channels.fetch(channelId).catch(() => null)) as ReplyChannel | null;
  if (!channel || !channel.isTextBased() || !canPostIn(channel)) return false;

  const number = await setStatus(c, "posted");
  let comment: string | null = null;
  try {
    comment = await generateReply(client, botConfig, channel, {
      username: "Server",
      text:
        `(An anonymous confession was just posted: "${c.text.slice(0, 500)}". ` +
        "React to it briefly in character, one or two sentences. Never guess who wrote it.)",
    });
  } catch {
    // post without a comment
  }
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`🤫 Anonymous Confession #${number}`)
    .setDescription(c.text)
    .setFooter({ text: `DM ${client.user.displayName} "I want to confess" to send your own` });
  const sent = await channel.send({ content: comment?.slice(0, 1800) ?? "", embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
  c.number = number;
  await savePostedMessage(c, channel.id, sent.id);
  return true;
}

async function tellConfessor(client: Client<true>, userId: string, text: string): Promise<void> {
  const user = await client.users.fetch(userId).catch(() => null);
  await user?.send(text).catch(() => undefined);
}

/**
 * Handles "confess: ..." in a DM. Returns true if the message was a confession.
 */
/** "I want to confess" → her next DM from them is the confession (for 10 minutes). */
const START =
  /\b(?:i\s+(?:want|wanna|would like|need|have)\s+to\s+(?:confess|make a confession)|i(?:'d| would)\s+like\s+to\s+confess|i\s+have\s+(?:a\s+confession|something\s+to\s+confess)|can\s+i\s+(?:confess|make\s+a\s+confession)|confession\s+time)\b[\s,:\-–]*(?:something|smth|sum|anything)?[\s,:\-–]*(?:that\s+)?([\s\S]*)$/i;
const CANCEL = /^\s*(?:cancel|nevermind|never\s*mind|nvm|stop|forget it|no|nah)\b[\s.!]*$/i;
const WAIT_MS = 10 * 60_000;
const waiting = new Map<string, number>(); // botId:userId -> expires at

/** Detects a confession and what it says; "" means "waiting for them to say it". */
function confessionText(message: Message, botId: string): string | null {
  const key = `${botId}:${message.author.id}`;
  const content = message.content.trim();

  const expires = waiting.get(key);
  if (expires && expires > Date.now()) {
    waiting.delete(key);
    return CANCEL.test(content) ? "\u0000cancel" : content;
  }
  waiting.delete(key);

  const direct = content.match(TRIGGER);
  if (direct) return direct[1].trim();

  const start = content.match(START);
  if (start) {
    const rest = start[1].replace(/^[?.!\s]+|[?\s]+$/g, "").trim();
    if (rest.length >= 3) return rest; // "I want to confess that I ..." — all in one message
    waiting.set(key, Date.now() + WAIT_MS);
    return "";
  }
  return null;
}

export async function handleConfessionDm(message: Message, client: Client<true>, botConfig: BotConfig): Promise<boolean> {
  const found = confessionText(message, botConfig.id);
  if (found === null) return false;

  if (found === "\u0000cancel") {
    await message.reply("Okay, cancelled — nothing was sent 🤐").catch(() => undefined);
    return true;
  }
  if (found === "" && Object.keys(getSettings(botConfig.id).confessionChannels).length === 0) {
    waiting.delete(`${botConfig.id}:${message.author.id}`);
    await message.reply("Confessions aren't turned on in any server we share yet 🤫").catch(() => undefined);
    return true;
  }
  if (found === "") {
    await message
      .reply(
        "🤫 Okay, I'm listening… Send me your confession as your **next message** and I'll post it anonymously. " +
          "(Say \"cancel\" to stop.)"
      )
      .catch(() => undefined);
    return true;
  }

  const text = found.slice(0, MAX_LENGTH);
  if (text.length < 3) {
    waiting.set(`${botConfig.id}:${message.author.id}`, Date.now() + WAIT_MS);
    await message.reply("Hm? Tell me what you want to confess — just send it as your next message 🤫").catch(() => undefined);
    return true;
  }

  // Which server? The first one that has confessions on and that they're in.
  const channels = getSettings(botConfig.id).confessionChannels;
  let guildId: string | null = null;
  for (const id of Object.keys(channels)) {
    const guild = client.guilds.cache.get(id);
    if (guild && (await guild.members.fetch(message.author.id).catch(() => null))) {
      guildId = id;
      break;
    }
  }
  if (!guildId) {
    await message.reply("Confessions aren't turned on in any server we share yet 🤫").catch(() => undefined);
    return true;
  }

  const today = zonedParts().date;
  const key = `${botConfig.id}:${message.author.id}`;
  const used = perDay.get(key)?.date === today ? perDay.get(key)!.count : 0;
  if (used >= MAX_PER_DAY) {
    await message.reply(`That's ${MAX_PER_DAY} confessions today already! Try again tomorrow 🤐`).catch(() => undefined);
    return true;
  }
  perDay.set(key, { date: today, count: used + 1 });

  const settings = getSettings(botConfig.id);
  const confession: Omit<Confession, "id"> = {
    botId: botConfig.id,
    guildId,
    userId: message.author.id,
    text,
    status: "pending",
  };
  const id = await save(confession);
  const saved: Confession = { ...confession, id };

  if (!settings.confessionApproval) {
    const ok = await post(client, botConfig, saved);
    await message
      .reply(ok ? "🤫 Posted anonymously! Nobody in the server will see it was you." : "I couldn't post it right now 😣")
      .catch(() => undefined);
    return true;
  }

  // Ask the owner(s) to approve.
  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle("🤫 New confession waiting for approval")
    .setDescription(text)
    .addFields({ name: "From", value: `<@${message.author.id}> (only you can see this)` })
    .setFooter({ text: `Server: ${client.guilds.cache.get(guildId)?.name ?? guildId} · #${id}` });
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`confess:approve:${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`confess:reject:${id}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );
  let delivered = 0;
  for (const ownerId of ownerIds(botConfig.id)) {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    // The cast works around two copies of Discord's type definitions being
    // installed at slightly different versions; the data itself is identical.
    const sent = await owner?.send({ embeds: [embed], components: [buttons.toJSON() as never] }).catch(() => null);
    if (sent) delivered++;
  }
  await message
    .reply(
      delivered
        ? "🤫 Got it! It'll be posted anonymously once it's approved. Members won't see it was you (the server owner reviewing it can)."
        : "I couldn't reach the owner to approve it right now 😣 Try again later."
    )
    .catch(() => undefined);
  return true;
}

/** Approve / Reject buttons on the owner's approval DM. */
export async function handleConfessionButton(
  interaction: ButtonInteraction,
  client: Client<true>,
  botConfig: BotConfig
): Promise<boolean> {
  const match = interaction.customId.match(/^confess:(approve|reject|revoke):(\d+)$/);
  if (!match) return false;
  if (!isOwner(botConfig.id, interaction.user.id)) {
    await interaction.reply({ content: "🔒 Only the bot owner can review confessions.", flags: MessageFlags.Ephemeral });
    return true;
  }

  const confession = await load(Number(match[2]));
  if (!confession || confession.botId !== botConfig.id) {
    await interaction.update({ content: "This confession no longer exists.", components: [] });
    return true;
  }
  if (match[1] === "revoke") {
    const result = await revokeConfession(client, confession);
    await interaction.update({ content: result, components: [] });
    return true;
  }
  if (confession.status !== "pending") {
    await interaction.update({ content: `Already ${confession.status}.`, components: [] });
    return true;
  }

  if (match[1] === "approve") {
    const ok = await post(client, botConfig, confession);
    if (ok) {
      const revoke = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`confess:revoke:${confession.id}`).setLabel("Revoke (take it down)").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        content: `✅ Approved and posted as **Confession #${confession.number ?? confession.id}**. Approved by mistake? Press Revoke.`,
        components: [revoke.toJSON() as never],
      });
    } else {
      await interaction.reply({
        content: "⚠️ Couldn't post it — is the confession channel still set, and can she post there?",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (ok) await tellConfessor(client, confession.userId, "🤫 Your confession was posted anonymously!");
  } else {
    await setStatus(confession, "rejected");
    await interaction.update({ content: "❌ Rejected — it won't be posted.", components: [] });
    await tellConfessor(client, confession.userId, "Your confession wasn't approved this time 🤐");
  }
  return true;
}
