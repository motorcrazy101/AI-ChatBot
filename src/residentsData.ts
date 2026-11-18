import { EmbedBuilder } from "discord.js";
import { initDb, isDbReady, pool } from "./db";
import type { ReplyChannel } from "./respond";

/**
 * Asylum residents: room assignments, per-person counters (stats) and
 * achievement badges. Saved in the database (memory only without one).
 */

export const WARDS = ["East Wing", "West Wing", "Night Ward", "Rooftop Ward", "Garden Ward", "Library Wing", "Basement Ward"];

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

// ---------- rooms ----------

export interface Room {
  room: number;
  ward: string;
}

const memoryRooms = new Map<string, Room>();

/** Their room, assigning one the first time. `isNew` is true when just assigned. */
export async function getOrAssignRoom(botId: string, userId: string): Promise<Room & { isNew: boolean }> {
  const key = `${botId}:${userId}`;
  const cached = memoryRooms.get(key);
  if (cached) return { ...cached, isNew: false };

  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ room: number; ward: string }>(
      "SELECT room, ward FROM residents WHERE bot_id = $1 AND user_id = $2",
      [botId, userId]
    );
    if (rows[0]) {
      memoryRooms.set(key, rows[0]);
      return { ...rows[0], isNew: false };
    }
  }
  const room: Room = {
    room: 100 + Math.floor(Math.random() * 300),
    ward: WARDS[Math.floor(Math.random() * WARDS.length)],
  };
  memoryRooms.set(key, room);
  if (pool && (await useDb())) {
    await pool.query(
      "INSERT INTO residents (bot_id, user_id, room, ward) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [botId, userId, room.room, room.ward]
    );
  }
  return { ...room, isNew: true };
}

/** Their room if they have one (doesn't assign). */
export function knownRoom(botId: string, userId: string): Room | null {
  return memoryRooms.get(`${botId}:${userId}`) ?? null;
}

// ---------- stats ----------

const memoryStats = new Map<string, number>();

export async function incrementStat(botId: string, userId: string, key: string, by = 1): Promise<number> {
  const mkey = `${botId}:${userId}:${key}`;
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ value: number }>(
      `INSERT INTO user_stats (bot_id, user_id, key, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id, user_id, key) DO UPDATE SET value = user_stats.value + EXCLUDED.value
       RETURNING value`,
      [botId, userId, key, by]
    );
    memoryStats.set(mkey, rows[0].value);
    return rows[0].value;
  }
  const value = (memoryStats.get(mkey) ?? 0) + by;
  memoryStats.set(mkey, value);
  return value;
}

export async function getStats(botId: string, userId: string): Promise<Record<string, number>> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ key: string; value: number }>(
      "SELECT key, value FROM user_stats WHERE bot_id = $1 AND user_id = $2",
      [botId, userId]
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  const out: Record<string, number> = {};
  for (const [k, v] of memoryStats) {
    const prefix = `${botId}:${userId}:`;
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** Top people for one stat (e.g. "curfew" catches). */
export async function topStat(botId: string, key: string, limit = 10): Promise<{ userId: string; value: number }[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ user_id: string; value: number }>(
      "SELECT user_id, value FROM user_stats WHERE bot_id = $1 AND key = $2 AND value > 0 ORDER BY value DESC LIMIT $3",
      [botId, key, limit]
    );
    return rows.map((r) => ({ userId: r.user_id, value: r.value }));
  }
  return [...memoryStats.entries()]
    .filter(([k]) => k.startsWith(`${botId}:`) && k.endsWith(`:${key}`))
    .map(([k, value]) => ({ userId: k.split(":")[1], value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// ---------- achievements ----------

export interface Achievement {
  key: string;
  emoji: string;
  name: string;
  how: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { key: "resident", emoji: "🏥", name: "New Resident", how: "got your Asylum room" },
  { key: "birthday", emoji: "🎂", name: "Birthday on File", how: "told her your birthday" },
  { key: "streak7", emoji: "🔥", name: "Dedicated", how: "greeted her 7 days in a row" },
  { key: "streak30", emoji: "🌟", name: "Devoted", how: "greeted her 30 days in a row" },
  { key: "trivia1", emoji: "🧠", name: "Smarty Pants", how: "won your first trivia question" },
  { key: "trivia10", emoji: "🏆", name: "Trivia Champ", how: "won 10 trivia questions" },
  { key: "gifts10", emoji: "🎁", name: "Gift Giver", how: "gave her 10 gifts" },
  { key: "escaped", emoji: "🏃", name: "Escaped the Asylum", how: "survived an adventure to the end" },
  { key: "detective", emoji: "🕵️", name: "Master Detective", how: "voted for the right culprit in a mystery" },
  { key: "filecracker", emoji: "📁", name: "File Cracker", how: "cracked the Warden's Secret File" },
  { key: "caught1", emoji: "🚨", name: "Caught Red-Handed", how: "got caught by the night patrol" },
  { key: "caught10", emoji: "🦉", name: "Night Owl Menace", how: "got caught after curfew 10 times" },
  { key: "bestfriend", emoji: "💖", name: "Inner Circle", how: "became one of her best friends" },
];

export const achievementByKey = (key: string) => ACHIEVEMENTS.find((a) => a.key === key);

const memoryAchievements = new Map<string, Set<string>>();

export async function getAchievements(botId: string, userId: string): Promise<string[]> {
  const key = `${botId}:${userId}`;
  if (pool && (await useDb())) {
    const { rows } = await pool.query<{ key: string }>(
      "SELECT key FROM achievements WHERE bot_id = $1 AND user_id = $2 ORDER BY earned_at",
      [botId, userId]
    );
    return rows.map((r) => r.key);
  }
  return [...(memoryAchievements.get(key) ?? [])];
}

/**
 * Gives an achievement (once). If `channel` is given, announces it there.
 * Returns true if it was newly earned.
 */
export async function award(
  botId: string,
  user: { id: string; name: string },
  key: string,
  channel?: ReplyChannel | null
): Promise<boolean> {
  const achievement = achievementByKey(key);
  if (!achievement) return false;
  const known = memoryAchievements.get(`${botId}:${user.id}`);
  if (known?.has(key)) return false;
  let isNew: boolean;
  if (pool && (await useDb())) {
    const result = await pool.query(
      "INSERT INTO achievements (bot_id, user_id, key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [botId, user.id, key]
    );
    isNew = (result.rowCount ?? 0) > 0;
    const set = known ?? new Set<string>();
    set.add(key);
    memoryAchievements.set(`${botId}:${user.id}`, set);
  } else {
    const set = memoryAchievements.get(`${botId}:${user.id}`) ?? new Set<string>();
    isNew = !set.has(key);
    set.add(key);
    memoryAchievements.set(`${botId}:${user.id}`, set);
  }
  if (isNew && channel) {
    const embed = new EmbedBuilder()
      .setColor(0xffb020)
      .setDescription(`🏅 **Achievement unlocked!** ${user.name} earned ${achievement.emoji} **${achievement.name}** — ${achievement.how}.`);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  return isNew;
}

/** Awards milestones for a counter, e.g. trivia wins 1 and 10. */
export async function awardMilestones(
  botId: string,
  user: { id: string; name: string },
  value: number,
  milestones: [number, string][],
  channel?: ReplyChannel | null
): Promise<void> {
  for (const [at, key] of milestones) {
    if (value >= at) await award(botId, user, key, channel);
  }
}

/** Awards one achievement to several people (by id), naming them from the server. */
export async function awardMany(
  botId: string,
  userIds: string[],
  key: string,
  channel: ReplyChannel,
  nameOf: (id: string) => string
): Promise<void> {
  for (const id of userIds) await award(botId, { id, name: nameOf(id) }, key, channel);
}
