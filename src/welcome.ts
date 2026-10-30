import { Client, GuildMember } from "discord.js";
import { logBotPost } from "./chatLog";
import { botDisplayName, canPostIn, generateReply, ReplyChannel, sendText, startTyping } from "./respond";
import { getSettings } from "./settings";
import { BotConfig } from "./types";

/**
 * Greets a new member in the server's welcome channel, in the bot's own voice.
 * Returns false if there is nothing to do (no welcome channel, no permission...).
 */
export async function welcomeMember(
  member: GuildMember,
  client: Client<true>,
  botConfig: BotConfig
): Promise<boolean> {
  const channelId = getSettings(botConfig.id).welcomeChannels[member.guild.id];
  if (!channelId) return false;

  const fetched = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!fetched || !fetched.isTextBased()) return false;
  const channel = fetched as ReplyChannel;
  if (!canPostIn(channel)) return false;

  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const reply = await generateReply(client, botConfig, channel, {
      username: "Server",
      text: `${member.displayName} just joined the server for the first time! Give them a warm welcome.`,
    });
    stopTyping();
    if (!reply) return false;

    const sent = await sendText(channel, `${member} ${reply}`, { pingUserId: member.id });
    const botName = botDisplayName(client, channel);
    for (const post of sent) logBotPost(botConfig.id, botName, post, "welcome");
    return true;
  } finally {
    stopTyping();
  }
}
