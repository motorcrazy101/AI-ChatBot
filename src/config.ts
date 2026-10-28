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
  };
}

export const config = loadConfig();
