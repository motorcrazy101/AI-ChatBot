import "./config"; // make sure .env is loaded before DATABASE_URL is read
import { Pool } from "pg";

/**
 * Shared Postgres connection. Turned on by setting DATABASE_URL
 * (on Railway: ${{Postgres.DATABASE_URL}}). Without it the bot still works,
 * but chats aren't saved and /commands settings reset on every restart.
 */

const databaseUrl = process.env.DATABASE_URL?.trim();

export const pool: Pool | null = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 10_000, // give up instead of hanging if the DB is unreachable
    })
  : null;

pool?.on("error", (err) => console.error("[db] Connection error:", err.message));

const SCHEMA = `
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
  CREATE INDEX IF NOT EXISTS chat_logs_time ON chat_logs (created_at);

  CREATE TABLE IF NOT EXISTS bot_settings (
    bot_id     TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

let ready = false;
let initPromise: Promise<boolean> | null = null;

export function isDbReady(): boolean {
  return ready;
}

/** Creates the tables if needed. Safe to call more than once. */
export function initDb(): Promise<boolean> {
  if (!initPromise) {
    initPromise = (async () => {
      if (!pool) {
        console.warn(
          "[db] DATABASE_URL not set — chats will NOT be saved and command settings reset on restart."
        );
        return false;
      }
      try {
        await pool.query(SCHEMA);
        ready = true;
        console.log("[db] Connected to database — chats and settings will be saved.");
        return true;
      } catch (err) {
        console.error(
          "[db] Could not set up database, chats/settings will NOT be saved:",
          (err as Error).message
        );
        return false;
      }
    })();
  }
  return initPromise;
}

export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
}
