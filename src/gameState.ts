import { initDb, isDbReady, pool } from "./db";

/**
 * Saved state for the story games (adventures, mysteries, logbooks, scenes,
 * secret files) — one active game per channel/thread. Kept in the database
 * so games survive restarts; in memory only without one.
 */

export type GameKind = "adventure" | "mystery" | "secretfile" | "logbook" | "scene";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Game<T = any> {
  id: number;
  botId: string;
  channelId: string;
  kind: GameKind;
  data: T;
  /** When the game next needs attention (vote ends, idle timeout...). */
  deadline: Date | null;
}

const memory = new Map<number, Game>();
let memoryId = 1;

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

function fromRow<T>(r: Record<string, unknown>): Game<T> {
  return {
    id: Number(r.id),
    botId: String(r.bot_id),
    channelId: String(r.channel_id),
    kind: r.kind as GameKind,
    data: (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as T,
    deadline: r.deadline ? new Date(r.deadline as string) : null,
  };
}

/** The active game in a channel (any kind), or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGame<T = any>(botId: string, channelId: string): Promise<Game<T> | null> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      "SELECT * FROM game_state WHERE bot_id = $1 AND channel_id = $2 AND active ORDER BY id DESC LIMIT 1",
      [botId, channelId]
    );
    return rows[0] ? fromRow<T>(rows[0]) : null;
  }
  for (const g of memory.values()) {
    if (g.botId === botId && g.channelId === channelId) return g as Game<T>;
  }
  return null;
}

export async function createGame<T>(
  botId: string,
  channelId: string,
  kind: GameKind,
  data: T,
  deadline: Date | null
): Promise<Game<T>> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      `INSERT INTO game_state (bot_id, channel_id, kind, data, deadline) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
      [botId, channelId, kind, JSON.stringify(data), deadline?.toISOString() ?? null]
    );
    return fromRow<T>(rows[0]);
  }
  const game: Game<T> = { id: memoryId++, botId, channelId, kind, data, deadline };
  memory.set(game.id, game as Game);
  return game;
}

export async function saveGame<T>(game: Game<T>): Promise<void> {
  if (pool && (await useDb())) {
    await pool.query("UPDATE game_state SET data = $2::jsonb, deadline = $3, updated_at = now() WHERE id = $1", [
      game.id,
      JSON.stringify(game.data),
      game.deadline?.toISOString() ?? null,
    ]);
    return;
  }
  memory.set(game.id, game as Game);
}

export async function endGame(game: Game<unknown>): Promise<void> {
  if (pool && (await useDb())) {
    await pool.query("UPDATE game_state SET active = false, updated_at = now() WHERE id = $1", [game.id]);
    return;
  }
  memory.delete(game.id);
}

/** Active games whose deadline has passed. */
export async function dueGames(botId: string): Promise<Game[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      "SELECT * FROM game_state WHERE bot_id = $1 AND active AND deadline IS NOT NULL AND deadline <= now() LIMIT 20",
      [botId]
    );
    return rows.map((r: Record<string, unknown>) => fromRow(r));
  }
  const now = Date.now();
  return [...memory.values()].filter((g) => g.botId === botId && g.deadline && g.deadline.getTime() <= now);
}

/** Paused adventures (kept so "continue the adventure" can pick them up). */
export async function findPausedAdventure<T>(botId: string, channelId: string): Promise<Game<T> | null> {
  const game = await getGame<T>(botId, channelId);
  return game && game.kind === "adventure" ? game : null;
}

// ---------- resident characters ----------

export interface Character {
  name: string;
  classKey: string;
  trait: string | null;
}

const memoryCharacters = new Map<string, Character>();

export async function getCharacter(botId: string, userId: string): Promise<Character | null> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ name: string; class: string; trait: string | null }>(
      "SELECT name, class, trait FROM asylum_characters WHERE bot_id = $1 AND user_id = $2",
      [botId, userId]
    );
    return rows[0] ? { name: rows[0].name, classKey: rows[0].class, trait: rows[0].trait } : null;
  }
  return memoryCharacters.get(`${botId}:${userId}`) ?? null;
}

export async function setCharacter(botId: string, userId: string, c: Character): Promise<void> {
  memoryCharacters.set(`${botId}:${userId}`, c);
  if (pool && (await useDb())) {
    await pool.query(
      `INSERT INTO asylum_characters (bot_id, user_id, name, class, trait) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bot_id, user_id) DO UPDATE SET name = EXCLUDED.name, class = EXCLUDED.class, trait = EXCLUDED.trait`,
      [botId, userId, c.name, c.classKey, c.trait]
    );
  }
}
