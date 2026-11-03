import { Message } from "discord.js";
import { logOutgoing } from "./chatLog";
import { Feature, replyPlain } from "./featureKit";
import { callKindroidAI } from "./kindroidAPI";
import { sendText, startTyping } from "./respond";

/**
 * "aurora what did I miss?" — she reads the chat since your last message
 * (up to 100 messages back) and catches you up in her own words.
 */

const TRIGGER =
  /\b(what (?:did|have) i miss(?:ed)?|what'?d i miss|whatd i miss|catch me up|fill me in|tl;?dr|summar(?:y|ize|ise)\b[^?!.]*\b(?:chat|convo|conversation|channel))\b/i;
const MAX_TRANSCRIPT_CHARS = 3500;

export function isCatchUpRequest(text: string): boolean {
  return TRIGGER.test(text);
}

function nameOf(msg: Message): string {
  return msg.member?.displayName ?? msg.author.displayName;
}

export const catchUpFeature: Feature = async (ctx) => {
  if (!isCatchUpRequest(ctx.text)) return false;
  if (ctx.channel.isDMBased()) {
    await replyPlain(ctx, "It's just us in here — you haven't missed anything 😄");
    return true;
  }

  const stopTyping = startTyping(ctx.channel, ctx.botConfig.id);
  try {
    const fetched = await ctx.channel.messages.fetch({ limit: 100, before: ctx.message.id });
    const history = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Everything after this person's last message (or the last 50 if they haven't talked lately).
    let start = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].author.id === ctx.user.id) {
        start = i;
        break;
      }
    }
    const missed = start >= 0 ? history.slice(start + 1) : history.slice(-50);
    const lines = missed
      .map((m) => {
        const who = m.author.id === ctx.client.user.id ? ctx.botName : nameOf(m);
        const text = m.cleanContent.trim() || (m.attachments.size ? "[sent a picture/file]" : "");
        return text ? `${who}: ${text.replace(/\s+/g, " ").slice(0, 200)}` : "";
      })
      .filter(Boolean);

    if (lines.length < 3) {
      stopTyping();
      await replyPlain(ctx, "You didn't miss much — it's been pretty quiet! 😌");
      return true;
    }

    // Keep the most recent lines that fit.
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      total += lines[i].length + 1;
      if (total > MAX_TRANSCRIPT_CHARS) break;
      kept.unshift(lines[i]);
    }

    const result = await callKindroidAI(
      ctx.botConfig.sharedAiCode,
      [
        { username: ctx.user.name, text: ctx.message.cleanContent },
        {
          username: "Server",
          text:
            `(${ctx.user.name} was away and wants to know what they missed. Here are the ${kept.length} messages ` +
            `they missed in #${ctx.channel.name}:\n${kept.join("\n")}\n\n` +
            `Catch ${ctx.user.name} up in character: a short, fun summary of the main things that happened and who said what. ` +
            "Only use what's in these messages.)",
        },
      ],
      ctx.botConfig.enableFilter
    );
    stopTyping();

    if (result.type !== "success") {
      await replyPlain(ctx, "My brain's a bit overloaded right now — ask me again in a minute!");
      return true;
    }
    const sent = await sendText(ctx.channel, result.reply, { replyTo: ctx.message });
    for (const post of sent) logOutgoing(ctx.botConfig.id, ctx.botName, post, ctx.message);
    return true;
  } finally {
    stopTyping();
  }
};
