import {
  Client,
  DMChannel,
  GuildTextBasedChannel,
  Message,
  MessageMentionOptions,
  PermissionFlagsBits,
} from "discord.js";
import { affectionNote } from "./affection";
import { config } from "./config";
import { callKindroidAI } from "./kindroidAPI";
import { longTermNote, othersNote } from "./longTermMemory";
import { memoryNote } from "./memory";
import { activityNote, holidayNote, moodNote } from "./mood";
import { fetchConversation } from "./messageFetch";
import { getSettings } from "./settings";
import { sleepNote } from "./sleep";
import { BotConfig, ConversationMessage, ReplyLength } from "./types";

/** Shared helpers for anything that makes the bot talk. */

export type ReplyChannel = GuildTextBasedChannel | DMChannel;

const DISCORD_MAX_LENGTH = 2000;
const TYPING_REFRESH_MS = 8000; // Discord's typing indicator lasts ~10s

/** Splits a long reply into Discord-sized pieces, preferring line/word breaks. */
export function splitMessage(text: string, max = DISCORD_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Shows "Bot is typing..." until the returned stop function is called. */
export function startTyping(channel: ReplyChannel, botId: string): () => void {
  const send = () =>
    channel.sendTyping().catch((err) =>
      console.warn(`[${botId}] Failed to send typing indicator:`, err.message)
    );
  void send();
  const interval = setInterval(send, TYPING_REFRESH_MS);
  return () => clearInterval(interval);
}

/** Can the bot read and post in this channel? */
export function canPostIn(channel: ReplyChannel): boolean {
  if (channel.isDMBased()) return true;
  const me = channel.guild.members.me;
  if (!me) return false;
  const permissions = channel.permissionsFor(me);
  return !!permissions?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    channel.isThread()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
  ]);
}

/**
 * Asks Kindroid for a message based on the channel's recent history.
 * `extra` is added to the end of the conversation (used for welcomes,
 * scheduled posts and features). `forUser` adds mood hints (sleepy at
 * night, affection level). Returns null when Kindroid is rate limiting.
 */
export async function generateReply(
  client: Client<true>,
  botConfig: BotConfig,
  channel: ReplyChannel,
  extra?: ConversationMessage,
  forUser?: { id: string; name: string },
  extraNotes: string[] = []
): Promise<string | null> {
  const conversation = await fetchConversation(channel, client.user.id, config.contextMessageLimit);
  const length = getSettings(botConfig.id).replyLength;

  // Background she should "just know": owner-set facts about people in this
  // conversation, plus long-term memory of the person she's talking to.
  const background = [
    memoryNote(botConfig.id, extra ? [...conversation, extra] : conversation, forUser),
    forUser ? await longTermNote(botConfig.id, forUser, channel.isDMBased()) : null,
    // Birthdays and notes of anyone named in the last few messages ("what does Douche like?").
    await othersNote(
      botConfig.id,
      [...conversation.slice(-6), ...(extra ? [extra] : [])].map((m) => m.text).join("\n"),
      forUser?.id,
      getSettings(botConfig.id).nicknames
    ),
  ].filter(Boolean);

  // What they're playing/listening to right now (needs the Presence Intent).
  const presence =
    forUser && !channel.isDMBased()
      ? channel.guild.presences.cache.get(forUser.id) ?? channel.guild.members.cache.get(forUser.id)?.presence
      : null;

  // How to reply: length, mood, holidays, sleepy at night, how close she is with this person.
  const style = [
    LENGTH_HINTS[length],
    moodNote(botConfig.id),
    holidayNote(),
    forUser ? sleepNote(botConfig.id) : null,
    forUser ? affectionNote(botConfig.id, forUser) : null,
    forUser ? activityNote(presence, forUser.name) : null,
    ...extraNotes,
  ].filter(Boolean);

  // Background goes just BEFORE the latest message, so she answers the
  // person (not the note) while knowing all of it.
  if (background.length) {
    const note = { username: "Server", text: `(${background.join(" ")})` };
    if (conversation.length > 0) conversation.splice(conversation.length - 1, 0, note);
    else conversation.push(note);
  }
  if (extra) {
    conversation.push({ ...extra, text: style.length ? `${extra.text} (${style.join(" ")})` : extra.text });
  } else if (style.length && conversation.length > 0) {
    // Tuck the style hints into the background note right before the last message.
    const before = conversation[conversation.length - 2];
    if (before && before.username === "Server" && background.length) {
      before.text = `${before.text.slice(0, -1)} ${style.join(" ")})`;
    } else {
      conversation.splice(conversation.length - 1, 0, { username: "Server", text: `(${style.join(" ")})` });
    }
  }
  if (conversation.length === 0) return null;

  const result = await callKindroidAI(botConfig.sharedAiCode, conversation, botConfig.enableFilter);
  return result.type === "success" ? shortenReply(result.reply, LENGTH_LIMITS[length]) : null;
}

/** Asked of Kindroid for each reply length setting. */
const LENGTH_HINTS: Record<ReplyLength, string | null> = {
  short: "Keep your reply short: 1 to 3 sentences, like a quick Discord message.",
  medium: "Keep your reply fairly brief: one short paragraph at most.",
  long: null,
  off: null,
};

/** Hard character limits, used if Kindroid still writes too much. */
export const LENGTH_LIMITS: Record<ReplyLength, number> = {
  short: 450,
  medium: 900,
  long: 1800,
  off: 0,
};

/**
 * Trims a reply to about `max` characters, ending at the end of a full
 * sentence (or action) so she never stops mid-word. 0 = no limit.
 */
export function shortenReply(text: string, max: number): string {
  if (!max || text.length <= max) return text;
  const window = text.slice(0, max);

  // Last place a sentence, *action*, or line ends.
  let cut = -1;
  const ending = /[.!?…~)](?=\s|$)|\*(?=\s|$)|\n/g;
  let match: RegExpExecArray | null;
  while ((match = ending.exec(window)) !== null) cut = match.index + (match[0] === "\n" ? 0 : 1);

  let result = cut >= max * 0.4 ? window.slice(0, cut) : `${window.slice(0, window.lastIndexOf(" ")).trimEnd()}…`;
  result = result.trimEnd();
  // Don't leave an *action* half-open.
  if ((result.match(/\*/g) ?? []).length % 2 === 1) result += "*";
  return result;
}

/**
 * Sends text to a channel, split into Discord-sized messages.
 * The first piece is a reply to `replyTo` when given. Only `pingUserId`
 * (if any) can be pinged — never @everyone, @here or roles.
 */
export async function sendText(
  channel: ReplyChannel,
  text: string,
  options: { replyTo?: Message; pingUserId?: string } = {}
): Promise<Message[]> {
  const allowedMentions: MessageMentionOptions = {
    parse: [],
    repliedUser: true,
    users: options.pingUserId ? [options.pingUserId] : [],
  };

  const sent: Message[] = [];
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && options.replyTo) {
      const reply: Message = await options.replyTo.reply({ content: chunks[i], allowedMentions });
      sent.push(reply);
    } else {
      const post: Message = await channel.send({ content: chunks[i], allowedMentions });
      sent.push(post);
    }
  }
  return sent;
}

/** The bot's name as people see it in this server. */
export function botDisplayName(client: Client<true>, channel: ReplyChannel): string {
  if (!channel.isDMBased()) {
    return channel.guild.members.me?.displayName ?? client.user.displayName;
  }
  return client.user.displayName;
}

export function randomPercent(chance: number): boolean {
  return Math.random() * 100 < chance;
}
