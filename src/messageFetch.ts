import { DMChannel, GuildTextBasedChannel, Message } from "discord.js";
import { ConversationMessage } from "./types";

/** How many of the newest messages may look up an older message they reply to. */
const REPLY_LOOKUPS = 3;
const REPLY_SNIPPET_CHARS = 150;

/** Server nickname > global display name > username. */
function displayNameFor(msg: Message): string {
  return msg.member?.displayName ?? msg.author.displayName;
}

/**
 * Fetches the most recent messages in a channel and formats them for Kindroid.
 * Messages written by `botUserId` are labelled {{ai}} so the persona knows
 * they are its own. Mentions are converted to readable names, and messages
 * with no text (e.g. image-only) are skipped.
 *
 * When a message is a Discord reply, it's prefixed with what it replies to,
 * e.g. (replying to your earlier message: "…"), so she has the context.
 */
export async function fetchConversation(
  channel: GuildTextBasedChannel | DMChannel,
  botUserId: string,
  limit = 30
): Promise<ConversationMessage[]> {
  const fetched = await channel.messages.fetch({ limit });
  const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const byId = new Map(sorted.map((m) => [m.id, m]));
  const newest = new Set(sorted.slice(-REPLY_LOOKUPS).map((m) => m.id));

  /** What a reply is replying to, or "" if it isn't a reply / can't be found. */
  async function replyContext(msg: Message, index: number): Promise<string> {
    const refId = msg.reference?.messageId;
    if (!refId || (msg.reference?.channelId && msg.reference.channelId !== channel.id)) return "";
    // Her own replies don't need it (and she might start copying the format),
    // and replying to the message right above is already obvious.
    if (msg.author.id === botUserId || sorted[index - 1]?.id === refId) return "";

    // Use the copy we already have; only look up older messages for the newest few.
    let ref: Message | null = byId.get(refId) ?? null;
    if (!ref && newest.has(msg.id)) {
      ref = await channel.messages.fetch(refId).catch(() => null);
    }
    if (!ref) return "";

    const who =
      ref.author.id === botUserId
        ? "your earlier message"
        : ref.author.id === msg.author.id
          ? "their own earlier message"
          : `${displayNameFor(ref)}'s message`;
    const raw = ref.cleanContent.replace(/\s+/g, " ").trim();
    const snippet = raw
      ? `"${raw.length > REPLY_SNIPPET_CHARS ? `${raw.slice(0, REPLY_SNIPPET_CHARS - 1)}…` : raw}"`
      : "[a picture or file]";
    return `(replying to ${who}: ${snippet}) `;
  }

  const messages = await Promise.all(
    sorted.map(async (msg, index) => {
      const text = msg.cleanContent.trim();
      return {
        username: msg.author.id === botUserId ? "{{ai}}" : displayNameFor(msg),
        text: text ? `${await replyContext(msg, index)}${text}` : "",
        timestamp: msg.createdAt.toISOString(),
      };
    })
  );
  return messages.filter((m) => m.text.length > 0);
}
