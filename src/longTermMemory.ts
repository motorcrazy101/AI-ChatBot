import { config } from "./config";
import { initDb, isDbReady, pool } from "./db";
import { MONTHS } from "./time";

/**
 * Long-term memory for each person she talks to:
 *  - notes they asked her to remember ("aurora remember that I love cats")
 *  - their birthday
 *  - bits of past conversations with them (from the chat log), so she can
 *    recall things from other days and channels.
 * Needs the database; without it this quietly does nothing.
 */

export const MAX_NOTES_PER_USER = 20;
export const MAX_NOTE_LENGTH = 200;
const HISTORY_LINES = 12;
const HISTORY_CHARS = 1200;
/** Messages newer than this are already in the normal chat context. */
const HISTORY_SKIP_MINUTES = 30;

async function db(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

// ---------- notes people ask her to remember ----------

export interface UserNote {
  id: number;
  note: string;
  createdAt: Date;
}

export async function addUserNote(
  botId: string,
  user: { id: string; name: string },
  note: string
): Promise<number | null> {
  if (!pool || !(await db())) return null;
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO user_notes (bot_id, user_id, user_name, note) VALUES ($1, $2, $3, $4) RETURNING id",
    [botId, user.id, user.name, note.slice(0, MAX_NOTE_LENGTH)]
  );
  // Keep only the newest notes per person.
  await pool.query(
    `DELETE FROM user_notes WHERE bot_id = $1 AND user_id = $2 AND id NOT IN (
       SELECT id FROM user_notes WHERE bot_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3)`,
    [botId, user.id, MAX_NOTES_PER_USER]
  );
  return Number(rows[0].id);
}

export async function getUserNotes(botId: string, userId: string): Promise<UserNote[]> {
  if (!pool || !(await db())) return [];
  const { rows } = await pool.query<{ id: string; note: string; created_at: Date }>(
    "SELECT id, note, created_at FROM user_notes WHERE bot_id = $1 AND user_id = $2 ORDER BY created_at",
    [botId, userId]
  );
  return rows.map((r) => ({ id: Number(r.id), note: r.note, createdAt: new Date(r.created_at) }));
}

export async function deleteUserNotes(botId: string, userId: string, noteId?: number): Promise<number> {
  if (!pool || !(await db())) return 0;
  const result = noteId
    ? await pool.query("DELETE FROM user_notes WHERE bot_id = $1 AND user_id = $2 AND id = $3", [botId, userId, noteId])
    : await pool.query("DELETE FROM user_notes WHERE bot_id = $1 AND user_id = $2", [botId, userId]);
  return result.rowCount ?? 0;
}

export async function getBirthdayText(botId: string, userId: string): Promise<string | null> {
  if (!pool || !(await db())) return null;
  const { rows } = await pool.query<{ month: number; day: number }>(
    "SELECT month, day FROM birthdays WHERE bot_id = $1 AND user_id = $2",
    [botId, userId]
  );
  return rows[0] ? `${MONTHS[rows[0].month - 1]} ${rows[0].day}` : null;
}

// ---------- past conversations ----------

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: config.timezone });

/**
 * The last few things said between her and this person, from before the
 * current conversation. In a server, DMs are left out so private chats
 * never leak into public channels.
 */
async function pastConversation(botId: string, userId: string, includeDms: boolean): Promise<string | null> {
  if (!pool || !(await db())) return null;
  const { rows } = await pool.query<{
    direction: string;
    user_name: string;
    content: string;
    created_at: Date;
    is_dm: boolean;
    channel_name: string | null;
  }>(
    `SELECT direction, user_name, content, created_at, is_dm, channel_name
       FROM chat_logs
      WHERE bot_id = $1 AND user_id = $2
        AND created_at < now() - ($3 || ' minutes')::interval
        ${includeDms ? "" : "AND NOT is_dm"}
      ORDER BY created_at DESC
      LIMIT $4`,
    [botId, userId, String(HISTORY_SKIP_MINUTES), HISTORY_LINES]
  );
  if (rows.length === 0) return null;

  const lines: string[] = [];
  let total = 0;
  for (const r of rows) {
    const where = r.is_dm ? "DM" : `#${r.channel_name ?? "chat"}`;
    const who = r.direction === "incoming" ? r.user_name : "You";
    const text = r.content.replace(/\[image\].*$/s, "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!text) continue;
    const line = `[${dayFormat.format(new Date(r.created_at))}, ${where}] ${who}: ${text}`;
    total += line.length;
    if (total > HISTORY_CHARS) break;
    lines.unshift(line);
  }
  return lines.length ? lines.join(" / ") : null;
}

// ---------- the note handed to Kindroid ----------

/**
 * Everything she should remember about the person she's replying to:
 * their own notes, birthday and bits of past conversations.
 */
export async function longTermNote(
  botId: string,
  user: { id: string; name: string },
  inDm: boolean
): Promise<string | null> {
  try {
    const [notes, birthday, history] = await Promise.all([
      getUserNotes(botId, user.id),
      getBirthdayText(botId, user.id),
      pastConversation(botId, user.id, inDm),
    ]);
    const parts: string[] = [];
    if (birthday) parts.push(`${user.name}'s birthday is ${birthday}.`);
    if (notes.length) parts.push(`${user.name} asked you to remember: ${notes.map((n) => `"${n.note}"`).join("; ")}.`);
    if (history) parts.push(`Earlier conversations with ${user.name} (for memory only): ${history}`);
    return parts.length ? `What you remember about ${user.name}: ${parts.join(" ")}` : null;
  } catch (err) {
    console.warn(`[${botId}] Long-term memory lookup failed:`, (err as Error).message);
    return null;
  }
}

// ---------- other people's birthdays ----------

interface KnownBirthday {
  userId: string;
  userName: string;
  month: number;
  day: number;
}

let birthdayCache: { botId: string; at: number; list: KnownBirthday[] } | null = null;

/** Everyone's saved birthday for this bot (cached for a minute). */
export async function allKnownBirthdays(botId: string): Promise<KnownBirthday[]> {
  if (birthdayCache && birthdayCache.botId === botId && Date.now() - birthdayCache.at < 60_000) {
    return birthdayCache.list;
  }
  if (!pool || !(await db())) return [];
  const { rows } = await pool.query<{ user_id: string; user_name: string; month: number; day: number }>(
    "SELECT user_id, user_name, month, day FROM birthdays WHERE bot_id = $1",
    [botId]
  );
  const list = rows.map((r) => ({ userId: r.user_id, userName: r.user_name, month: r.month, day: r.day }));
  birthdayCache = { botId, at: Date.now(), list };
  return list;
}

export function birthdayLabel(b: { month: number; day: number }): string {
  return `${MONTHS[b.month - 1]} ${b.day}`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsName(text: string, name: string): boolean {
  if (!name.trim()) return false;
  // Also matches "douche's", "douches" and "douches'".
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(name.trim())}(?:'s|’s|s'|s|')?(?![\\p{L}\\p{N}_])`,
    "iu"
  ).test(text);
}

/**
 * Birthdays of other people who are named or @mentioned in the last few
 * messages, so she can answer "when is Douche's birthday?".
 */
export async function othersBirthdayNote(
  botId: string,
  recentText: string,
  speakerId: string | undefined,
  nicknames: Record<string, string[]>
): Promise<string | null> {
  try {
    const list = await allKnownBirthdays(botId);
    const found = list.filter(
      (b) =>
        b.userId !== speakerId &&
        [b.userName, ...(nicknames[b.userId] ?? [])].some((name) => mentionsName(recentText, name))
    );
    if (found.length === 0) return null;
    return `Birthdays you know: ${found.map((b) => `${b.userName}'s birthday is ${birthdayLabel(b)}`).join("; ")}.`;
  } catch {
    return null;
  }
}

/** Call after a birthday is saved or deleted. */
export function clearBirthdayCache(): void {
  birthdayCache = null;
}
