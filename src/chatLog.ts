import { Message } from "discord.js";
import { Pool } from "pg";

/**
 * Saves every conversation the bot takes part in to Postgres:
 * the message that triggered it ("incoming") and its reply ("outgoing").
 *
 * Turned on by setting DATABASE_URL (on Railway: ${{Postgres.DATABASE_URL}}).
 * If it's missing or the database is down, the bot keeps chatting normally
 * and just prints a warning — logging never breaks replies.
 */

const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : null;
let ready = false;

pool?.on("error", (err) => console.error("[chat-log] Database connection error:", err.message));

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS chat_logs (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    bot_id       TEXT NOT NULL,
    bot_name     TEXT,
    direction    TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    is_dm        BOOLEAN NOT NULL,
    guild_id     TEXT,
    guild_name   TEXT,
    channel_id   TEXT NOT NULL,
    channel_name TEXT,
    user_id      TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    message_id   TEXT,
    content      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_logs_channel_time ON chat_logs (channel_id, created_at);
  CREATE INDEX IF NOT EXISTS chat_logs_user_time ON chat_logs (user_id, created_at);
`;

/** Creates the chat_logs table if needed. Call once at startup. */
export async function initChatLog(): Promise<void> {
  if (!pool) {
    console.warn("[chat-log] DATABASE_URL not set — chats will NOT be saved.");
    return;
  }
  try {
    await pool.query(CREATE_TABLE);
    ready = true;
    console.log("[chat-log] Connected to database — chats will be saved to chat_logs.");
  } catch (err) {
    console.error("[chat-log] Could not set up database, chats will NOT be saved:", (err as Error).message);
  }
}

export async function closeChatLog(): Promise<void> {
  await pool?.end().catch(() => undefined);
}

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

  if (!pool || !ready) return;
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
