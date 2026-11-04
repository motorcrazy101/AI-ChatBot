import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Message,
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
  status: "pending" | "posted" | "rejected";
  number?: number;
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
    return r
      ? { id: Number(r.id), botId: r.bot_id, guildId: r.guild_id, userId: r.user_id, text: r.text, status: r.status }
      : null;
  }
  return memory.get(id) ?? null;
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
    .setFooter({ text: `DM ${client.user.displayName} "confess: ..." to send your own` });
  const sent = await channel.send({ content: comment?.slice(0, 1800) ?? "", embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
  return true;
}

async function tellConfessor(client: Client<true>, userId: string, text: string): Promise<void> {
  const user = await client.users.fetch(userId).catch(() => null);
  await user?.send(text).catch(() => undefined);
}

/**
 * Handles "confess: ..." in a DM. Returns true if the message was a confession.
 */
export async function handleConfessionDm(message: Message, client: Client<true>, botConfig: BotConfig): Promise<boolean> {
  const match = message.content.match(TRIGGER);
  if (!match) return false;

  const text = match[1].trim().slice(0, MAX_LENGTH);
  if (text.length < 3) {
    await message.reply("Tell me what you want to confess! Like: `confess: I've never watched Naruto`").catch(() => undefined);
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
  const match = interaction.customId.match(/^confess:(approve|reject):(\d+)$/);
  if (!match) return false;
  if (!isOwner(botConfig.id, interaction.user.id)) {
    await interaction.reply({ content: "🔒 Only the bot owner can review confessions.", ephemeral: true });
    return true;
  }

  const confession = await load(Number(match[2]));
  if (!confession || confession.botId !== botConfig.id) {
    await interaction.update({ content: "This confession no longer exists.", components: [] });
    return true;
  }
  if (confession.status !== "pending") {
    await interaction.update({ content: `Already ${confession.status}.`, components: [] });
    return true;
  }

  if (match[1] === "approve") {
    const ok = await post(client, botConfig, confession);
    if (ok) {
      await interaction.update({ content: "✅ Approved and posted.", components: [] });
    } else {
      await interaction.reply({
        content: "⚠️ Couldn't post it — is the confession channel still set, and can she post there?",
        ephemeral: true,
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
