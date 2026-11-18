import { EmbedBuilder } from "discord.js";
import { anilist, describeError } from "./anilist";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";
import { addDays, formatClock, zonedParts, zonedTimeToDate } from "./time";

/**
 * "aurora what's airing today?" / "aurora what anime comes out tomorrow?"
 * Uses AniList's airing schedule (free, no key). Also used by the Gazette.
 */

const AIRING = /\b(?:what'?s|whats|what\s+is|what\s+anime\s+(?:is|are)|anything|which\s+anime|what\s+episodes?\s+(?:are|is))\s+(?:(?:airing|coming\s+out|releasing)(?:\s+(?:today|tonight|tomorrow))?|(?:out|on)\s+(?:today|tonight|tomorrow))\b|\b(?:airing|anime)\s+(?:today|tonight|tomorrow|schedule)\b|\bairing\s+schedule\b/i;

export interface AiringItem {
  title: string;
  episode: number;
  airingAt: Date;
  url: string | null;
  popularity: number;
}

interface AiringResponse {
  Page: {
    airingSchedules: {
      episode: number;
      airingAt: number;
      media: { title: { english: string | null; romaji: string | null }; isAdult: boolean; popularity: number | null; siteUrl: string | null };
    }[];
  };
}

const QUERY = `
query ($from: Int, $to: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      episode
      airingAt
      media { title { english romaji } isAdult popularity siteUrl }
    }
  }
}`;

const cache = new Map<string, { at: number; items: AiringItem[] }>();

/** Shows airing on a calendar day in the bot's time zone (0 = today, 1 = tomorrow), most popular first. */
export async function airingOn(dayOffset = 0, limit = 15): Promise<AiringItem[]> {
  const now = zonedParts();
  const [y, m, d] = addDays(now.year, now.month, now.day, dayOffset);
  const [y2, m2, d2] = addDays(now.year, now.month, now.day, dayOffset + 1);
  const from = Math.floor(zonedTimeToDate(y, m, d, 0, 0).getTime() / 1000);
  const to = Math.floor(zonedTimeToDate(y2, m2, d2, 0, 0).getTime() / 1000);
  const key = `${from}`;
  const cached = cache.get(key);
  let items: AiringItem[];
  if (cached && Date.now() - cached.at < 30 * 60_000) {
    items = cached.items;
  } else {
    items = [];
    for (let page = 1; page <= 3; page++) {
      const data = await anilist<AiringResponse>(QUERY, { from: from - 1, to, page });
      const batch = data.Page.airingSchedules;
      for (const s of batch) {
        if (s.media.isAdult) continue;
        items.push({
          title: s.media.title.english ?? s.media.title.romaji ?? "Unknown",
          episode: s.episode,
          airingAt: new Date(s.airingAt * 1000),
          url: s.media.siteUrl,
          popularity: s.media.popularity ?? 0,
        });
      }
      if (batch.length < 50) break;
    }
    cache.set(key, { at: Date.now(), items });
  }
  return [...items]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit)
    .sort((a, b) => a.airingAt.getTime() - b.airingAt.getTime());
}

export function airingLine(item: AiringItem): string {
  const time = formatClock(zonedParts(item.airingAt).time);
  const title = item.url ? `[${truncate(item.title, 60)}](${item.url})` : truncate(item.title, 60);
  return `\`${time.padStart(8)}\` ${title} — ep ${item.episode}`;
}

export const airingFeature: Feature = async (ctx) => {
  const match = ctx.text.match(AIRING);
  if (!match) return false;
  const tomorrow = /tomorrow/i.test(match[0]) || /\btomorrow\b/i.test(ctx.text);
  let items: AiringItem[];
  try {
    items = await airingOn(tomorrow ? 1 : 0);
  } catch (err) {
    console.warn(`[${ctx.botConfig.id}] Airing schedule failed:`, describeError(err));
    await replyPlain(ctx, "I couldn't reach the airing schedule right now 😣 Try again in a bit!");
    return true;
  }
  const day = tomorrow ? "tomorrow" : "today";
  if (items.length === 0) {
    await replyPlain(ctx, `Nothing big is airing ${day}… a perfect excuse for a rewatch? 📺`);
    return true;
  }
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📺 Airing ${day}`)
    .setDescription(items.map(airingLine).join("\n"))
    .setFooter({ text: "Times in the server's time zone · from AniList · \"tell me when <anime> airs\" for alerts" });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked what anime is airing ${day}. Some of the episodes: ${items.slice(0, 6).map((i) => `${i.title} ep ${i.episode}`).join(", ")}. ` +
      "React in one or two short sentences (pick one you're excited about). The full list is shown below your message.",
    { embed, fallback: `Here's what's airing ${day}! 📺`, logExtra: `[airing] ${items.length} shows` }
  );
  return true;
};
