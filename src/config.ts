import dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

const DEFAULT_ERROR_MESSAGE =
  "The Asylum Warden put a gag in her mouth. Please contact the Asylum Warden (SelfCenteredDouchebag) if this response pops up!";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Ignoring invalid ${name}="${raw}", using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function percentFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    console.warn(`Ignoring invalid ${name}="${raw}" (must be 0-100), using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Reads "HH:MM" (24-hour) times like SLEEP_BEDTIME=23:00. */
function clockFromEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    console.warn(`Ignoring invalid ${name}="${raw}" (use 24-hour HH:MM), using ${fallback}`);
    return fallback;
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(`Config error: ${message}`);
  process.exit(1);
}

/**
 * Reads SHARED_AI_CODE_N / BOT_TOKEN_N pairs starting at N=1 and stops at the
 * first number where both are missing. A half-filled pair is a config error.
 */
function loadBotConfigs(): BotConfig[] {
  const configs: BotConfig[] = [];

  for (let i = 1; ; i++) {
    const sharedAiCode = process.env[`SHARED_AI_CODE_${i}`]?.trim();
    const botToken = process.env[`BOT_TOKEN_${i}`]?.trim();

    if (!sharedAiCode && !botToken) break;
    if (!sharedAiCode || !botToken) {
      fail(`Bot ${i} needs both SHARED_AI_CODE_${i} and BOT_TOKEN_${i}`);
    }

    configs.push({
      id: `bot${i}`,
      discordBotToken: botToken,
      sharedAiCode,
      enableFilter: process.env[`ENABLE_FILTER_${i}`]?.trim().toLowerCase() === "true",
      defaultStatus: process.env[`BOT_STATUS_${i}`]?.trim() ?? "",
    });
  }

  return configs;
}

function loadConfig() {
  const kindroidUrl = process.env.KINDROID_INFER_URL?.trim();
  const kindroidApiKey = process.env.KINDROID_API_KEY?.trim();
  if (!kindroidUrl) fail("KINDROID_INFER_URL is missing");
  if (!kindroidApiKey) fail("KINDROID_API_KEY is missing");

  const bots = loadBotConfigs();
  if (bots.length === 0) {
    fail("No bots configured. Set at least SHARED_AI_CODE_1 and BOT_TOKEN_1");
  }

  let timezone = process.env.TIMEZONE?.trim() || "America/Los_Angeles";
  if (!validTimezone(timezone)) {
    console.warn(`Unknown TIMEZONE "${timezone}", using America/Los_Angeles`);
    timezone = "America/Los_Angeles";
  }

  return {
    kindroidUrl,
    kindroidApiKey,
    bots,
    /** Message shown in Discord when something goes wrong. */
    errorMessage: process.env.ERROR_MESSAGE?.trim() || DEFAULT_ERROR_MESSAGE,
    /** How many recent messages are sent to Kindroid as context. */
    contextMessageLimit: Math.min(intFromEnv("CONTEXT_MESSAGE_LIMIT", 30), 100),
    /** Max consecutive bot-to-bot messages in a channel before bots go quiet. */
    maxBotChain: intFromEnv("MAX_BOT_CHAIN", 3),
    /** Kindroid request timeout. */
    requestTimeoutMs: intFromEnv("KINDROID_TIMEOUT_MS", 60_000),
    /** Time zone for scheduled posts and the chat log viewer. */
    timezone,
    /** Starting values for settings that can be changed later with commands. */
    defaultChimeChance: percentFromEnv("CHIME_CHANCE", 5),
    defaultReactionChance: percentFromEnv("REACTION_CHANCE", 10),
    /** Minimum minutes between random chime-ins in the same channel. */
    chimeCooldownMinutes: intFromEnv("CHIME_COOLDOWN_MINUTES", 10),
    /** Password for the chat log web page. Page is off when not set. */
    logViewerPassword: process.env.LOG_VIEWER_PASSWORD?.trim() || "",
    port: intFromEnv("PORT", 8080),
    /** Sleep schedule defaults (can be changed with /aurora sleep). */
    sleepEnabled: (process.env.SLEEP_SCHEDULE?.trim().toLowerCase() ?? "on") !== "off",
    sleepBedtime: clockFromEnv("SLEEP_BEDTIME", "23:00"),
    sleepWake: clockFromEnv("SLEEP_WAKE", "07:00"),
    /** Time of day birthday wishes go out. */
    birthdayTime: clockFromEnv("BIRTHDAY_TIME", "09:00"),
    /** "fahrenheit" or "celsius". */
    weatherUnits: process.env.WEATHER_UNITS?.trim().toLowerCase() === "celsius" ? "celsius" : "fahrenheit",
    /** Default reply length: short, medium, long or off (change with /aurora length). */
    replyLength: (["short", "medium", "long", "off"].includes(process.env.REPLY_LENGTH?.trim().toLowerCase() ?? "")
      ? process.env.REPLY_LENGTH!.trim().toLowerCase()
      : "short") as "short" | "medium" | "long" | "off",
    /** Extra Discord user IDs allowed to manage memories (the bot's owner always can). */
    ownerIds: (process.env.OWNER_IDS ?? "")
      .split(/[\s,]+/)
      .filter((id) => /^\d{15,25}$/.test(id)),
    /** Used when someone asks "what's the weather?" without a place. */
    weatherDefaultLocation: process.env.WEATHER_LOCATION?.trim() || "",
  };
}

export const config = loadConfig();
