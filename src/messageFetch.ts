import { DMChannel, GuildTextBasedChannel, Message } from "discord.js";
import { ConversationMessage } from "./types";

/** Server nickname > global display name > username. */
function displayNameFor(msg: Message): string {
  return msg.member?.displayName ?? msg.author.displayName;
}

/**
 * Fetches the most recent messages in a channel and formats them for Kindroid.
 * Messages written by `botUserId` are labelled {{ai}} so the persona knows
 * they are its own. Mentions are converted to readable names, and messages
 * with no text (e.g. image-only) are skipped.
 */
export async function fetchConversation(
  channel: GuildTextBasedChannel | DMChannel,
  botUserId: string,
  limit = 30
): Promise<ConversationMessage[]> {
  const fetched = await channel.messages.fetch({ limit });

  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((msg) => ({
      username: msg.author.id === botUserId ? "{{ai}}" : displayNameFor(msg),
      text: msg.cleanContent.trim(),
      timestamp: msg.createdAt.toISOString(),
    }))
    .filter((m) => m.text.length > 0);
}
