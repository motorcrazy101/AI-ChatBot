import { EmbedBuilder } from "discord.js";
import { addAffection, AffectionChange } from "./affection";
import { EMBED_COLOR, Feature, replyInCharacter } from "./featureKit";
import { liftMood } from "./mood";
import { zonedParts } from "./time";

/**
 * Gifts: "aurora here's a cookie 🍪", "aurora I got you a plushie",
 * "*hands aurora a boba*". She has favorites and things she dislikes,
 * and gifts raise affection (up to 3 gifts per person per day).
 */

const PATTERNS = [
  /\b(?:here'?s|here is|here are)\s+(?:a|an|some|ur|your|a little)\s+([^.!?\n,]{2,40}?)(?:\s+for (?:you|u|ya))?\s*(?:[.!?\n,]|$)/i,
  /\bi (?:got|brought|made|bought|baked|picked|found|have) (?:you|u|ya) (?:a|an|some|this|these|a little)?\s*([^.!?\n,]{2,40}?)\s*(?:[.!?\n,]|$)/i,
  /\*\s*(?:gives?|hands?|offers?|tosses?|passes?|gifts?|slides?)\s+(?:you|u|her|aurora|over)?\s*(?:a|an|some|the|a little)?\s*([^*\n]{2,40}?)\s*(?:to (?:you|u|her|aurora))?\s*\*/i,
  /\b(?:a|an|some)\s+([^.!?\n,]{2,30}?)\s+for (?:you|u|ya)\b/i,
];

/** Things that come after "here's a..." but aren't gifts. */
const NOT_GIFTS =
  /^(question|thought|idea|tip|link|picture|pic|photo|meme|video|song|story|joke|fact|reminder|hint|clue|update|list|summary|secret|warning|problem|test|challenge)s?\b/i;

const LOVES = [
  "plush", "plushie", "stuffed", "teddy", "cookie", "cake", "cupcake", "boba", "bubble tea", "milk tea", "chocolate",
  "candy", "manga", "figure", "figurine", "flower", "rose", "bouquet", "mochi", "ramen", "pocky", "kitten", "puppy",
  "hoodie", "blanket", "dango", "onigiri", "strawberr", "ice cream", "donut", "doughnut", "matcha", "poster", "hug",
];
const DISLIKES = [
  "bug", "spider", "cockroach", "broccoli", "coal", "rock", "sock", "trash", "garbage", "homework", "celery",
  "mushroom", "olive", "brussels", "worm", "slime", "tax", "bill", "onion", "raw fish",
];

export type Taste = "loved" | "liked" | "disliked";

export function parseGift(text: string): string | null {
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const gift = match[1]
      .replace(/\s+(?:lol|lmao|haha+|hehe+|xd|lmfao|rn|ok)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (gift.length < 2 || NOT_GIFTS.test(gift)) continue;
    if (/^(you|u|me|this|that|it|thing|the)$/i.test(gift)) continue;
    return gift;
  }
  return null;
}

export function tasteFor(gift: string): Taste {
  const g = gift.toLowerCase();
  if (DISLIKES.some((d) => g.includes(d))) return "disliked";
  if (LOVES.some((l) => g.includes(l))) return "loved";
  return "liked";
}

/** person -> gifts given today (only 3 a day raise affection). */
const giftsToday = new Map<string, { date: string; count: number }>();

export const giftFeature: Feature = async (ctx) => {
  const gift = parseGift(ctx.text);
  if (!gift) return false;

  const taste = tasteFor(gift);
  const key = `${ctx.botConfig.id}:${ctx.user.id}`;
  const today = zonedParts().date;
  const count = giftsToday.get(key)?.date === today ? giftsToday.get(key)!.count : 0;
  giftsToday.set(key, { date: today, count: count + 1 });
  const counts = count < 3;

  let change: AffectionChange | null = null;
  if (counts && taste !== "disliked") {
    change = await addAffection(ctx.botConfig.id, ctx.user, taste === "loved" ? "gift-loved" : "gift");
    liftMood(ctx.botConfig.id, taste === "loved" ? 5 : 2);
  }

  const reaction =
    taste === "loved"
      ? "You LOVE this kind of gift — react with genuine delight."
      : taste === "liked"
        ? "It's a nice gift — react warmly."
        : "You really don't like this gift — react in character (grossed out, dramatic or politely horrified), but stay fond of them.";
  const label =
    taste === "loved"
      ? `💖 She loved it!${change ? " (+5 affection)" : ""}`
      : taste === "liked"
        ? `😊 She liked it!${change ? " (+2 affection)" : ""}`
        : "😖 Not her favorite…";

  const embed = new EmbedBuilder()
    .setColor(taste === "disliked" ? 0x8a8a8a : taste === "loved" ? 0xff7ab6 : EMBED_COLOR)
    .setDescription(`🎁 **${ctx.user.name}** gave ${ctx.botName}: **${gift}**\n${label}`)
    .setFooter({ text: counts ? "Gifts raise affection (up to 3 a day)" : "That's a lot of gifts today! (no more affection today)" });

  await replyInCharacter(ctx, `${ctx.user.name} just gave you a gift: ${gift}. ${reaction} Keep it short.`, {
    embed,
    fallback: taste === "disliked" ? "…oh. Um. Thanks?" : "For me?! Thank you!! 💕",
    logExtra: `[gift] ${gift} (${taste})`,
  });

  if (change && change.after.level > change.before.level) {
    await ctx.channel
      .send({
        content: `${change.after.emoji} **${ctx.user.name}** and **${ctx.botName}** are now **${change.after.name}s**!`,
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }
  return true;
};
