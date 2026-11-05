import { EmbedBuilder } from "discord.js";
import { getAffection, getStreak, nextLevel, progressBar } from "./affection";
import { animeAlertFeature } from "./animeAlerts";
import { animeFeature } from "./anime";
import { birthdayFeature } from "./birthdays";
import { catchUpFeature } from "./catchUp";
import { EMBED_COLOR, Feature, FeatureContext, replyInCharacter } from "./featureKit";
import { gameFeatures } from "./games";
import { giftFeature } from "./gifts";
import { pollFeature } from "./polls";
import { recommendationFeature } from "./recommendations";
import { reminderFeature } from "./reminders";
import { rememberFeature } from "./rememberFeature";
import { storyFeatures } from "./storyGames";
import { watchlistFeature } from "./watchlist";
import { weatherFeature } from "./weather";

/** "aurora what's my level?" — shows your affection level with her. */
const LEVEL = /\b(?:what'?s|whats|what is|show(?: me)?|check)\s+(?:my|our)\s+(?:affection|level|friendship(?: level)?|relationship(?: level)?|bond|streak)\b|\bhow close are we\b/i;

const levelFeature: Feature = async (ctx) => {
  if (!LEVEL.test(ctx.text)) return false;
  const a = await getAffection(ctx.botConfig.id, ctx.user);
  const streak = await getStreak(ctx.botConfig.id, ctx.user);
  const next = nextLevel(a.level);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${a.level.emoji} ${ctx.user.name} & ${ctx.botName}: ${a.level.name}`)
    .setDescription(
      `${progressBar(a.points)}\n` +
        (next ? `Next: **${next.emoji} ${next.name}**` : "You've reached the top level 💞") +
        `\n\n💬 ${a.messages} messages · 🧠 ${a.triviaWins} trivia wins` +
        `\n🔥 Greeting streak: ${streak.streak} day${streak.streak === 1 ? "" : "s"} (best ${streak.best})`
    );
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked how close the two of you are. You'd call them a "${a.level.name.toLowerCase()}". ` +
      "Answer in character in one or two sentences.",
    { embed, fallback: `We're ${a.level.name}s! ${a.level.emoji}` }
  );
  return true;
};

/**
 * Checked in order for messages addressed to her. The first feature that
 * recognizes the message handles it; otherwise she just chats.
 * (Picture search is checked separately, right after these.)
 */
const FEATURES: Feature[] = [
  animeAlertFeature, // before reminders: "remind me when Frieren airs"
  reminderFeature,
  birthdayFeature,
  rememberFeature,
  ...storyFeatures,
  levelFeature,
  weatherFeature,
  catchUpFeature,
  pollFeature,
  giftFeature,
  ...gameFeatures,
  watchlistFeature,
  recommendationFeature,
  animeFeature,
];

export async function runFeatures(ctx: FeatureContext): Promise<boolean> {
  for (const feature of FEATURES) {
    if (await feature(ctx)) return true;
  }
  return false;
}
