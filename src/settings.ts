import { config } from "./config";
import { initDb, isDbReady, pool } from "./db";
import { BotSettings } from "./types";

/**
 * Per-bot settings changed with slash commands (quiet channels, blocklist,
 * chime-ins, reactions, welcome channels, scheduled posts, status).
 * Saved in the bot_settings table so they survive restarts. Without a
 * database they live in memory only and reset when the bot restarts.
 */

const DEFAULT_EMOJIS = ["❤️", "😂", "👀", "😊", "🔥", "🥺"];

function defaults(): BotSettings {
  return {
    quietChannels: [],
    blockedUsers: [],
    chimeChannels: [],
    chimeChance: config.defaultChimeChance,
    reactionChance: config.defaultReactionChance,
    reactionEmojis: [...DEFAULT_EMOJIS],
    welcomeChannels: {},
    schedules: [],
    nextScheduleId: 1,
    status: null,
  };
}

const store = new Map<string, BotSettings>();
let loadedPromise: Promise<void> = Promise.resolve();

export function getSettings(botId: string): BotSettings {
  let settings = store.get(botId);
  if (!settings) {
    settings = defaults();
    store.set(botId, settings);
  }
  return settings;
}

/** Loads saved settings for all bots (call once at startup). */
export function loadAllSettings(botIds: string[]): Promise<void> {
  loadedPromise = (async () => {
    const hasDb = await initDb();
    if (!hasDb || !pool) return;
    try {
      const { rows } = await pool.query<{ bot_id: string; data: Partial<BotSettings> }>(
        "SELECT bot_id, data FROM bot_settings WHERE bot_id = ANY($1)",
        [botIds]
      );
      for (const row of rows) {
        store.set(row.bot_id, { ...defaults(), ...row.data });
      }
      console.log(`[settings] Loaded saved settings for ${rows.length} bot(s)`);
    } catch (err) {
      console.error("[settings] Could not load saved settings:", (err as Error).message);
    }
  })();
  return loadedPromise;
}

/** Resolves once saved settings have been loaded (or loading failed). */
export function settingsLoaded(): Promise<void> {
  return loadedPromise;
}

/** Change settings and save them. */
export async function updateSettings(
  botId: string,
  change: (settings: BotSettings) => void
): Promise<BotSettings> {
  const settings = getSettings(botId);
  change(settings);
  await saveSettings(botId);
  return settings;
}

export async function saveSettings(botId: string): Promise<void> {
  if (!pool || !isDbReady()) return;
  try {
    await pool.query(
      `INSERT INTO bot_settings (bot_id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (bot_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [botId, JSON.stringify(getSettings(botId))]
    );
  } catch (err) {
    console.error(`[settings] Could not save settings for ${botId}:`, (err as Error).message);
  }
}

/** Adds `value` to the list if missing, removes it if `add` is false. Returns true if anything changed. */
export function toggleInList(list: string[], value: string, add: boolean): boolean {
  const index = list.indexOf(value);
  if (add && index === -1) {
    list.push(value);
    return true;
  }
  if (!add && index !== -1) {
    list.splice(index, 1);
    return true;
  }
  return false;
}
