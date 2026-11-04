import { initDb, isDbReady, pool } from "./db";

/**
 * Affection levels: she quietly earns points with each person who talks to
 * her, and gets friendlier as the level goes up. Saved in user_affection
 * (in memory only if there's no database).
 */

export interface Level {
  level: number;
  name: string;
  emoji: string;
  minPoints: number;
  /** How she should treat someone at this level (sent to Kindroid as a hint). */
  tone: string;
}

export const LEVELS: Level[] = [
  { level: 0, name: "Stranger", emoji: "🤝", minPoints: 0, tone: "polite and friendly, but you don't know them well yet" },
  { level: 1, name: "Acquaintance", emoji: "🙂", minPoints: 10, tone: "friendly and starting to warm up to them" },
  { level: 2, name: "Friend", emoji: "😊", minPoints: 40, tone: "warm and playful — they're your friend" },
  { level: 3, name: "Close Friend", emoji: "💛", minPoints: 120, tone: "very warm, teasing and comfortable — they're a close friend" },
  { level: 4, name: "Best Friend", emoji: "💖", minPoints: 300, tone: "openly affectionate, with inside-joke energy — they're one of your best friends" },
  { level: 5, name: "Soulmate", emoji: "💞", minPoints: 700, tone: "deeply fond and devoted — they're one of your very favorite people" },
];

/** Seconds between points from chatting, so spamming doesn't level you up. */
const CHAT_POINT_COOLDOWN_MS = 60_000;

interface AffectionRecord {
  userName: string;
  points: number;
  messages: number;
  triviaWins: number;
  lastChatPointAt: number;
  /** Days in a row they said good morning/night. */
  streak: number;
  bestStreak: number;
  /** "YYYY-MM-DD" of their last check-in. */
  lastCheckin: string | null;
}

const cache = new Map<string, AffectionRecord>();
const key = (botId: string, userId: string) => `${botId}:${userId}`;

export function levelFor(points: number): Level {
  let result = LEVELS[0];
  for (const level of LEVELS) if (points >= level.minPoints) result = level;
  return result;
}

export function nextLevel(level: Level): Level | null {
  return LEVELS[level.level + 1] ?? null;
}

async function load(botId: string, userId: string, userName: string): Promise<AffectionRecord> {
  const k = key(botId, userId);
  const cached = cache.get(k);
  if (cached) return cached;

  const record: AffectionRecord = {
    userName,
    points: 0,
    messages: 0,
    triviaWins: 0,
    lastChatPointAt: 0,
    streak: 0,
    bestStreak: 0,
    lastCheckin: null,
  };
  await initDb();
  if (pool && isDbReady()) {
    try {
      const { rows } = await pool.query<{
        points: number;
        messages: number;
        trivia_wins: number;
        streak: number;
        best_streak: number;
        last_checkin: string | null;
      }>(
        `SELECT points, messages, trivia_wins, streak, best_streak, last_checkin
           FROM user_affection WHERE bot_id = $1 AND user_id = $2`,
        [botId, userId]
      );
      if (rows[0]) {
        record.points = rows[0].points;
        record.messages = rows[0].messages;
        record.triviaWins = rows[0].trivia_wins;
        record.streak = rows[0].streak ?? 0;
        record.bestStreak = rows[0].best_streak ?? 0;
        record.lastCheckin = rows[0].last_checkin ?? null;
      }
    } catch (err) {
      console.error("[affection] Could not load:", (err as Error).message);
    }
  }
  cache.set(k, record);
  return record;
}

async function save(botId: string, userId: string, record: AffectionRecord): Promise<void> {
  if (!pool || !isDbReady()) return;
  try {
    await pool.query(
      `INSERT INTO user_affection
         (bot_id, user_id, user_name, points, messages, trivia_wins, streak, best_streak, last_checkin, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (bot_id, user_id) DO UPDATE
         SET user_name = EXCLUDED.user_name, points = EXCLUDED.points, messages = EXCLUDED.messages,
             trivia_wins = EXCLUDED.trivia_wins, streak = EXCLUDED.streak, best_streak = EXCLUDED.best_streak,
             last_checkin = EXCLUDED.last_checkin, updated_at = now()`,
      [
        botId,
        userId,
        record.userName,
        record.points,
        record.messages,
        record.triviaWins,
        record.streak,
        record.bestStreak,
        record.lastCheckin,
      ]
    );
  } catch (err) {
    console.error("[affection] Could not save:", (err as Error).message);
  }
}

export interface AffectionChange {
  before: Level;
  after: Level;
  points: number;
}

/**
 * Adds points for a user. Chat messages give 1 point at most once a minute;
 * other events (trivia wins etc.) pass their own amount.
 */
export async function addAffection(
  botId: string,
  user: { id: string; name: string },
  reason: "chat" | "trivia" | "birthday" | "streak" | "gift" | "gift-loved"
): Promise<AffectionChange> {
  const record = await load(botId, user.id, user.name);
  record.userName = user.name;
  const before = levelFor(record.points);

  if (reason === "chat") {
    record.messages++;
    const now = Date.now();
    if (now - record.lastChatPointAt >= CHAT_POINT_COOLDOWN_MS) {
      record.points += 1;
      record.lastChatPointAt = now;
    }
  } else if (reason === "trivia") {
    record.points += 5;
    record.triviaWins++;
  } else if (reason === "birthday") {
    record.points += 10;
  } else if (reason === "gift-loved") {
    record.points += 5;
  } else {
    record.points += 2; // streak check-in or a regular gift
  }

  void save(botId, user.id, record);
  return { before, after: levelFor(record.points), points: record.points };
}

export async function getAffection(
  botId: string,
  user: { id: string; name: string }
): Promise<{ level: Level; points: number; messages: number; triviaWins: number }> {
  const record = await load(botId, user.id, user.name);
  return {
    level: levelFor(record.points),
    points: record.points,
    messages: record.messages,
    triviaWins: record.triviaWins,
  };
}

/** Hint for Kindroid about how close she is with this person (only once loaded). */
export function affectionNote(botId: string, user: { id: string; name: string }): string | null {
  const record = cache.get(key(botId, user.id));
  if (!record) return null;
  const level = levelFor(record.points);
  return `Don't mention this directly, but you'd describe ${user.name} as a "${level.name.toLowerCase()}", so be ${level.tone}.`;
}

/** Top users by affection, for /aurora stats. */
export async function topAffection(
  botId: string,
  limit: number
): Promise<{ userId: string; userName: string; points: number; triviaWins: number }[]> {
  await initDb();
  if (pool && isDbReady()) {
    const { rows } = await pool.query<{ user_id: string; user_name: string; points: number; trivia_wins: number }>(
      `SELECT user_id, user_name, points, trivia_wins FROM user_affection
        WHERE bot_id = $1 AND points > 0 ORDER BY points DESC LIMIT $2`,
      [botId, limit]
    );
    return rows.map((r) => ({ userId: r.user_id, userName: r.user_name, points: r.points, triviaWins: r.trivia_wins }));
  }
  return [...cache.entries()]
    .filter(([k, r]) => k.startsWith(`${botId}:`) && r.points > 0)
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, limit)
    .map(([k, r]) => ({ userId: k.split(":")[1], userName: r.userName, points: r.points, triviaWins: r.triviaWins }));
}

/** A little text progress bar, e.g. ▰▰▰▱▱▱▱▱▱▱ */
export function progressBar(points: number): string {
  const level = levelFor(points);
  const next = nextLevel(level);
  if (!next) return "▰▰▰▰▰▰▰▰▰▰ MAX";
  const filled = Math.floor(((points - level.minPoints) / (next.minPoints - level.minPoints)) * 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${points}/${next.minPoints}`;
}

// ---------- daily good morning / good night streaks ----------

const GREETING = /\b(good\s*morning|g'?morning|mornin'?|gm|good\s*night|goodnight|g'?night|night night|nighty night|gn|good\s*evening|good\s*afternoon)\b/i;
const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

export function isGreeting(text: string): boolean {
  return GREETING.test(text);
}

export interface CheckIn {
  /** False if they already checked in today (no change). */
  counted: boolean;
  streak: number;
  bestStreak: number;
  milestone: boolean;
  /** Their old streak, if it just broke. */
  broken: number;
}

/**
 * Counts a good morning / good night toward their daily streak (once a day).
 * `today` and `yesterday` are "YYYY-MM-DD" in the bot's time zone.
 */
export async function checkIn(
  botId: string,
  user: { id: string; name: string },
  today: string,
  yesterday: string
): Promise<CheckIn> {
  const record = await load(botId, user.id, user.name);
  if (record.lastCheckin === today) {
    return { counted: false, streak: record.streak, bestStreak: record.bestStreak, milestone: false, broken: 0 };
  }
  const continuing = record.lastCheckin === yesterday;
  const broken = !continuing && record.streak > 1 ? record.streak : 0;
  record.streak = continuing ? record.streak + 1 : 1;
  record.bestStreak = Math.max(record.bestStreak, record.streak);
  record.lastCheckin = today;
  record.userName = user.name;
  record.points += 2;
  void save(botId, user.id, record);
  return {
    counted: true,
    streak: record.streak,
    bestStreak: record.bestStreak,
    milestone: MILESTONES.includes(record.streak),
    broken,
  };
}

export async function getStreak(botId: string, user: { id: string; name: string }): Promise<{ streak: number; best: number; last: string | null }> {
  const record = await load(botId, user.id, user.name);
  return { streak: record.streak, best: record.bestStreak, last: record.lastCheckin };
}
