import {
  Client,
  DMChannel,
  GuildTextBasedChannel,
  Message,
  MessageMentionOptions,
  PermissionFlagsBits,
} from "discord.js";
import { config } from "./config";
import { callKindroidAI } from "./kindroidAPI";
import { fetchConversation } from "./messageFetch";
import { BotConfig, ConversationMessage } from "./types";

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
 * `extra` is added to the end of the conversation (used for welcomes and
 * scheduled posts). Returns null when Kindroid is rate limiting.
 */
export async function generateReply(
  client: Client<true>,
  botConfig: BotConfig,
  channel: ReplyChannel,
  extra?: ConversationMessage
): Promise<string | null> {
  const conversation = await fetchConversation(channel, client.user.id, config.contextMessageLimit);
  if (extra) conversation.push(extra);
  if (conversation.length === 0) return null;

  const result = await callKindroidAI(botConfig.sharedAiCode, conversation, botConfig.enableFilter);
  return result.type === "success" ? result.reply : null;
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
