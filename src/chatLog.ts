import { Message } from "discord.js";
import { isDbReady, pool } from "./db";

/**
 * Saves every conversation the bot takes part in to the chat_logs table:
 * the message that triggered it ("incoming") and its replies ("outgoing").
 * Also prints a short line to the Railway logs. Logging never breaks replies.
 */

function displayName(msg: Message): string {
  return msg.member?.displayName ?? msg.author.displayName;
}

function channelName(msg: Message): string | null {
  return "name" in msg.channel && typeof msg.channel.name === "string" ? msg.channel.name : null;
}

interface LogEntry {
  botId: string;
  botName: string;
  direction: "incoming" | "outgoing";
  /** The message being logged (the user's message, or the bot's reply). */
  message: Message;
  /** The person the bot is talking with. */
  user: { id: string; name: string };
  content: string;
}

async function save(entry: LogEntry): Promise<void> {
  const { message } = entry;
  const where = message.inGuild() ? `#${channelName(message) ?? message.channelId}` : "DM";
  const arrow =
    entry.direction === "incoming"
      ? `${entry.user.name} → ${entry.botName}`
      : `${entry.botName} → ${entry.user.name}`;
  console.log(`[chat] [${where}] ${arrow}: ${entry.content.slice(0, 200)}`);

  if (!pool || !isDbReady()) return;
  try {
    await pool.query(
      `INSERT INTO chat_logs
         (bot_id, bot_name, direction, is_dm, guild_id, guild_name,
          channel_id, channel_name, user_id, user_name, message_id, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.botId,
        entry.botName,
        entry.direction,
        !message.inGuild(),
        message.guildId,
        message.guild?.name ?? null,
        message.channelId,
        channelName(message),
        entry.user.id,
        entry.user.name,
        message.id,
        entry.content,
      ]
    );
  } catch (err) {
    console.error("[chat-log] Failed to save message:", (err as Error).message);
  }
}

/** Log the message a user sent that the bot is responding to. */
export function logIncoming(botId: string, botName: string, message: Message): void {
  void save({
    botId,
    botName,
    direction: "incoming",
    message,
    user: { id: message.author.id, name: displayName(message) },
    content: message.cleanContent,
  });
}

/** Log a reply the bot sent back to `userMessage`'s author. */
export function logOutgoing(
  botId: string,
  botName: string,
  reply: Message,
  userMessage: Message
): void {
  void save({
    botId,
    botName,
    direction: "outgoing",
    message: reply,
    user: { id: userMessage.author.id, name: displayName(userMessage) },
    content: reply.content,
  });
}

/** Log a post the bot made on its own (chime-in, welcome, scheduled post). */
export function logBotPost(
  botId: string,
  botName: string,
  post: Message,
  kind: "chime-in" | "welcome" | "scheduled"
): void {
  void save({
    botId,
    botName,
    direction: "outgoing",
    message: post,
    user: { id: "0", name: `(${kind})` },
    content: post.content,
  });
}
