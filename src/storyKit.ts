import { ChannelType, Client, Guild, Message } from "discord.js";
import { WORLD, wardenDescription, wardenFor } from "./asylum";
import { generateReply, ReplyChannel, shortenReply, startTyping } from "./respond";
import { BotConfig } from "./types";

/** Shared helpers for the Asylum story games. */

/**
 * Has Kindroid write story text set in the Anime Asylum (with the owner as
 * the Warden). Longer than normal chat; trimmed to `maxChars` at a sentence.
 */
export async function storyText(
  client: Client<true>,
  botConfig: BotConfig,
  channel: ReplyChannel,
  guild: Guild | null,
  instruction: string,
  maxChars = 1500
): Promise<string | null> {
  const warden = wardenFor(botConfig.id, guild);
  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const reply = await generateReply(
      client,
      botConfig,
      channel,
      { username: "Server", text: `(${WORLD} ${wardenDescription(warden)} ${instruction})` },
      undefined,
      [],
      "off"
    );
    return reply ? shortenReply(reply, maxChars) : null;
  } catch (err) {
    console.warn(`[${botConfig.id}] Story text failed:`, (err as Error).message);
    return null;
  } finally {
    stopTyping();
  }
}

/**
 * Starts a thread on `message` for a game (so it doesn't flood the channel).
 * Falls back to the channel itself in DMs, inside threads, or without permission.
 */
export async function openThread(message: Message, name: string): Promise<ReplyChannel> {
  const channel = message.channel;
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    try {
      const thread = await message.startThread({ name: name.slice(0, 100), autoArchiveDuration: 1440 });
      return thread as ReplyChannel;
    } catch (err) {
      console.warn("[story] Could not create a thread, using the channel:", (err as Error).message);
    }
  }
  return channel as ReplyChannel;
}

export function guildOf(channel: ReplyChannel): Guild | null {
  return channel.isDMBased() ? null : channel.guild;
}

/** Fetches a game's channel/thread again later (for timers). */
export async function fetchGameChannel(client: Client<true>, channelId: string): Promise<ReplyChannel | null> {
  const fetched = await client.channels.fetch(channelId).catch(() => null);
  if (!fetched || !fetched.isTextBased() || !("send" in fetched)) return null;
  return fetched as ReplyChannel;
}

/** "a, b and c" */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
