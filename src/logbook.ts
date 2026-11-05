import { Client, EmbedBuilder, Message } from "discord.js";
import { wardenFor } from "./asylum";
import { logBotPost } from "./chatLog";
import { EMBED_COLOR, Feature, replyPlain, truncate } from "./featureKit";
import { createGame, endGame, Game, getGame, saveGame } from "./gameState";
import { fetchGameChannel, guildOf, openThread, storyText } from "./storyKit";
import { BotConfig } from "./types";

/**
 * The Asylum Logbook — a story chain written as tonight's incident report.
 *   "aurora open the logbook"  → a thread where everyone adds one line at a time
 *   Aurora adds a twist every few lines; "aurora close the logbook" posts the full report
 *   and the Warden's verdict.
 */

const TWIST_EVERY = 4;
const MAX_LINES = 30;
const MAX_LINE_LENGTH = 250;
const IDLE_MINUTES = 30;

const START = /\b(?:open|start|begin|new)\s+(?:the\s+|an?\s+)?(?:asylum\s+)?(?:logbook|log book|incident report|story chain)\b/i;
const CLOSE = /\b(?:close|finish|end|submit|wrap up)\s+(?:the\s+)?(?:logbook|log book|incident report|story chain|log|report)\b/i;

export interface LogbookData {
  number: number;
  lines: { author: string; text: string; bot: boolean }[];
}

function compile(data: LogbookData): string {
  return data.lines.map((l) => (l.bot ? `🌀 ${l.text}` : `**${l.author}:** ${l.text}`)).join("\n");
}

async function closeLogbook(client: Client<true>, botConfig: BotConfig, game: Game<LogbookData>): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  await endGame(game);
  if (!channel) return;
  const data = game.data;
  if (data.lines.filter((l) => !l.bot).length === 0) {
    await channel.send("📓 The logbook was closed with no entries. The Warden is suspicious of how quiet tonight was… 🤨");
    return;
  }
  const warden = wardenFor(botConfig.id, guildOf(channel));
  const verdict = await storyText(
    client,
    botConfig,
    channel,
    guildOf(channel),
    `Tonight's Asylum incident report is finished:\n${truncate(compile(data), 2000)}\n` +
      `Write ${warden.name}'s (the Warden's) verdict on the report in character, under 60 words — dramatic, funny, ` +
      "and hand out a silly punishment or reward.",
    700
  );
  const embed = new EmbedBuilder()
    .setColor(0x8b5e3c)
    .setTitle(`📓 Asylum Incident Report #${data.number}`)
    .setDescription(truncate(compile(data), 3800))
    .addFields({ name: `🔏 ${warden.name}'s verdict`, value: truncate(verdict ?? "Report received. Everyone is on dish duty.", 1000) })
    .setFooter({ text: `${data.lines.filter((l) => !l.bot).length} entries` });
  const sent = await channel.send({ embeds: [embed] });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
}

export async function expireLogbook(client: Client<true>, botConfig: BotConfig, game: Game<LogbookData>): Promise<void> {
  await closeLogbook(client, botConfig, game);
}

export const logbookFeature: Feature = async (ctx) => {
  if (START.test(ctx.text)) {
    const existing = await getGame(ctx.botConfig.id, ctx.channel.id);
    if (existing) {
      await replyPlain(ctx, `There's already a ${existing.kind} going on here! Finish it first.`);
      return true;
    }
    const number = 100 + Math.floor(Math.random() * 900);
    const intro = await ctx.message.reply({
      content: `📓 **Asylum Incident Report #${number}** is open! Head into the thread and add one line at a time.`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    const channel = await openThread(intro, `📓 Incident Report #${number}`);
    const opening = await storyText(
      ctx.client,
      ctx.botConfig,
      channel,
      guildOf(channel),
      "Write the FIRST line of tonight's Asylum incident report: one or two sentences describing something odd that " +
        "just happened after lights-out. Leave it open so others can continue the story.",
      400
    );
    const first = opening ?? "11:58 PM — A strange thud was heard from the laundry room.";
    const data: LogbookData = { number, lines: [{ author: ctx.botName, text: first, bot: true }] };
    await createGame(ctx.botConfig.id, channel.id, "logbook", data, new Date(Date.now() + IDLE_MINUTES * 60_000));
    const embed = new EmbedBuilder()
      .setColor(0x8b5e3c)
      .setTitle(`📓 Incident Report #${number}`)
      .setDescription(`🌀 ${first}\n\nEveryone: add **one line** each to continue the report. I'll throw in twists!\nSay *aurora close the logbook* when it's done.`);
    await channel.send({ embeds: [embed] });
    return true;
  }

  if (CLOSE.test(ctx.text)) {
    const game = await getGame<LogbookData>(ctx.botConfig.id, ctx.channel.id);
    if (!game || game.kind !== "logbook") return false;
    await closeLogbook(ctx.client, ctx.botConfig, game);
    return true;
  }
  return false;
};

/** Every message in a logbook thread becomes the next line. */
export async function addLogbookLine(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig,
  game: Game<LogbookData>,
  authorName: string
): Promise<boolean> {
  const text = message.cleanContent.trim();
  if (!text || CLOSE.test(text)) return false;
  const data = game.data;
  data.lines.push({ author: authorName, text: text.slice(0, MAX_LINE_LENGTH), bot: false });
  game.deadline = new Date(Date.now() + IDLE_MINUTES * 60_000);
  await message.react("✍️").catch(() => undefined);

  const human = data.lines.filter((l) => !l.bot).length;
  if (human >= MAX_LINES) {
    await saveGame(game);
    await closeLogbook(client, botConfig, game);
    return true;
  }
  if (human % TWIST_EVERY === 0) {
    const channel = await fetchGameChannel(client, game.channelId);
    if (channel) {
      const twist = await storyText(
        client,
        botConfig,
        channel,
        guildOf(channel),
        `Here's tonight's incident report so far:\n${truncate(compile(data), 1500)}\n` +
          "Add ONE new line (one or two sentences) with a surprising twist that keeps the story going.",
        400
      );
      if (twist) {
        data.lines.push({ author: "twist", text: twist, bot: true });
        await channel.send(`🌀 ${twist}`);
      }
    }
  }
  await saveGame(game);
  return true;
}
