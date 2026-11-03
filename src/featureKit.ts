import { Client, EmbedBuilder, Message } from "discord.js";
import { logOutgoing } from "./chatLog";
import { generateReply, ReplyChannel, splitMessage, startTyping } from "./respond";
import { BotConfig } from "./types";

/** Shared pieces for the "aurora, do X" features (weather, games, reminders...). */

export interface FeatureContext {
  message: Message;
  channel: ReplyChannel;
  client: Client<true>;
  botConfig: BotConfig;
  /** Her name as shown in this server. */
  botName: string;
  /** The person talking to her. */
  user: { id: string; name: string };
  /** The message text with her name / @mention taken out. */
  text: string;
}

/** A feature returns true if it handled the message (so normal chat is skipped). */
export type Feature = (ctx: FeatureContext) => Promise<boolean>;

export const EMBED_COLOR = 0x6d4aff;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "aurora, what's the weather" -> "what's the weather" */
export function stripBotName(text: string, names: string[]): string {
  let result = text;
  for (const name of names.filter(Boolean)) {
    result = result.replace(
      new RegExp(`@?(?<![\\p{L}\\p{N}_])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "giu"),
      " "
    );
  }
  return result
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;!-]+/, "")
    .replace(/^(hey|hi|yo|ok|okay|please|pls)\b[\s,!.]*/i, "")
    .trim();
}

/**
 * Has Kindroid write a short in-character message for `instruction`
 * (e.g. "Tell them it's 72°F and sunny"), then replies with it plus an
 * optional embed. If Kindroid fails or is busy, `fallback` is used instead.
 */
export async function replyInCharacter(
  ctx: FeatureContext,
  instruction: string,
  options: { embed?: EmbedBuilder; fallback: string; logExtra?: string; pingUser?: boolean }
): Promise<Message> {
  const stopTyping = startTyping(ctx.channel, ctx.botConfig.id);
  let text = options.fallback;
  try {
    const reply = await generateReply(
      ctx.client,
      ctx.botConfig,
      ctx.channel,
      { username: "Server", text: `(${instruction})` },
      ctx.user
    );
    if (reply) text = reply;
  } catch (err) {
    console.warn(`[${ctx.botConfig.id}] In-character reply failed, using fallback:`, (err as Error).message);
  } finally {
    stopTyping();
  }

  const content = splitMessage(text, options.embed ? 1900 : 2000)[0] ?? options.fallback;
  const sent = await ctx.message.reply({
    content,
    embeds: options.embed ? [options.embed] : [],
    allowedMentions: { parse: [], repliedUser: true },
  });
  logOutgoing(
    ctx.botConfig.id,
    ctx.botName,
    sent,
    ctx.message,
    options.logExtra ? `${content}\n${options.logExtra}` : content
  );
  return sent;
}

/** Plain (not AI-written) reply, for errors and quick confirmations. */
export async function replyPlain(ctx: FeatureContext, content: string, embed?: EmbedBuilder): Promise<Message> {
  const sent = await ctx.message.reply({
    content,
    embeds: embed ? [embed] : [],
    allowedMentions: { parse: [], repliedUser: true },
  });
  logOutgoing(ctx.botConfig.id, ctx.botName, sent, ctx.message);
  return sent;
}

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
