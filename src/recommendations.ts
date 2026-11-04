import axios from "axios";
import { EmbedBuilder } from "discord.js";
import { search } from "./anime";
import { EMBED_COLOR, Feature, pick, replyInCharacter, replyPlain, truncate } from "./featureKit";

/**
 * Anime recommendations from MyAnimeList (via Jikan, free):
 *   "aurora recommend me something like Frieren"
 *   "aurora recommend a romance anime"
 *   "aurora what anime should I watch?"
 */

const LIKE =
  /\b(?:recommend|suggest)(?:\s+(?:me|us))?(?:\s+(?:an?|some|any))?(?:\s+(?:good|new|cool|great))?(?:\s+(?:anime|shows?|series|manga|something|stuff))?\s+(?:like|similar to)\s+(.+)$|\b(?:anime|shows?|series|something) (?:like|similar to)\s+(.+)$/i;
const GENRE =
  /\b(?:recommend|suggest)(?:\s+(?:me|us))?(?:\s+(?:an?|some|any))?(?:\s+(?:good|new|cool|great))?\s+([a-z\- ]{3,30}?)\s+(?:anime|show|series)s?\b/i;
const GENERIC =
  /\b(?:recommend|suggest)(?:\s+(?:me|us))?\s+(?:an?\s+|some\s+)?(?:good\s+)?(?:anime|shows?)\b|\bwhat (?:anime|show) should (?:i|we) watch\b|\b(?:any|got any) (?:anime )?recommendations\b/i;

const GENRES: Record<string, number> = {
  action: 1, adventure: 2, comedy: 4, mystery: 7, drama: 8, fantasy: 10, horror: 14, romance: 22,
  "sci-fi": 24, scifi: 24, "sci fi": 24, sports: 30, sport: 30, supernatural: 37, "slice of life": 36,
  suspense: 41, isekai: 62, mecha: 18, music: 19, psychological: 40, school: 23, "romcom": 4,
  "rom com": 4, "romantic comedy": 4, thriller: 41, cozy: 36, wholesome: 36,
};

interface Rec {
  title: string;
  url: string;
  image?: string;
  note?: string;
}

async function jikan(path: string, params: Record<string, unknown> = {}) {
  const { data } = await axios.get(`https://api.jikan.moe/v4/${path}`, { params, timeout: 12_000 });
  return data;
}

function sample<T>(list: T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

export function parseRecRequest(text: string): { kind: "like"; title: string } | { kind: "genre"; genre: string; id: number } | { kind: "any" } | null {
  const like = text.match(LIKE);
  if (like) {
    const title = (like[1] ?? like[2] ?? "").replace(/[?!.]+$/, "").replace(/\s+(anime|manga)$/i, "").trim();
    if (title && !/^(that|this|it|me|you)$/i.test(title)) return { kind: "like", title };
  }
  const genre = text.match(GENRE);
  if (genre) {
    const name = genre[1].toLowerCase().trim();
    const id = GENRES[name];
    if (id) return { kind: "genre", genre: name, id };
  }
  if (GENERIC.test(text)) return { kind: "any" };
  return null;
}

export const recommendationFeature: Feature = async (ctx) => {
  const request = parseRecRequest(ctx.text);
  if (!request) return false;

  let recs: Rec[] = [];
  let heading = "";
  try {
    if (request.kind === "like") {
      const base = await search({ query: request.title, kind: "anime", explicit: true });
      if (!base) {
        await replyPlain(ctx, `I couldn't find an anime called "${request.title}" 🤔`);
        return true;
      }
      const data = await jikan(`anime/${base.mal_id}/recommendations`);
      const list: { entry: { title: string; url: string; images?: { jpg?: { image_url?: string } } }; votes: number }[] =
        Array.isArray(data?.data) ? data.data : [];
      recs = sample(list.slice(0, 8), 3)
        .sort((a, b) => b.votes - a.votes)
        .map((r) => ({
        title: r.entry.title,
        url: r.entry.url,
        image: r.entry.images?.jpg?.image_url,
        note: `${r.votes} fans recommend it`,
      }));
      heading = `If you liked ${base.title_english || base.title}…`;
    } else if (request.kind === "genre") {
      const data = await jikan("anime", {
        genres: request.id,
        order_by: "score",
        sort: "desc",
        min_score: 7.5,
        sfw: true,
        limit: 25,
      });
      const list: { title: string; title_english?: string | null; url: string; score?: number; images?: { jpg?: { image_url?: string } } }[] =
        Array.isArray(data?.data) ? data.data : [];
      recs = sample(list, 3).map((a) => ({
        title: a.title_english || a.title,
        url: a.url,
        image: a.images?.jpg?.image_url,
        note: a.score ? `⭐ ${a.score}` : undefined,
      }));
      heading = `Top ${request.genre} picks`;
    } else {
      const data = await jikan("top/anime", { filter: "airing", limit: 25, sfw: true });
      const list: { title: string; title_english?: string | null; url: string; score?: number; images?: { jpg?: { image_url?: string } } }[] =
        Array.isArray(data?.data) ? data.data : [];
      recs = sample(list, 3).map((a) => ({
        title: a.title_english || a.title,
        url: a.url,
        image: a.images?.jpg?.image_url,
        note: a.score ? `⭐ ${a.score} · airing now` : "airing now",
      }));
      heading = "Popular right now";
    }
  } catch (err) {
    console.warn("[recommendations] Jikan failed:", (err as Error).message);
    await replyPlain(ctx, "I can't reach MyAnimeList right now 😣 Try again in a bit.");
    return true;
  }

  if (recs.length === 0) {
    await replyPlain(ctx, "I couldn't find any good recommendations for that 🤔");
    return true;
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📺 ${truncate(heading, 240)}`)
    .setDescription(recs.map((r, i) => `**${i + 1}. [${truncate(r.title, 100)}](${r.url})**${r.note ? ` — ${r.note}` : ""}`).join("\n"))
    .setFooter({ text: "From MyAnimeList · ask again for different picks" });
  const thumb = pick(recs).image;
  if (thumb) embed.setThumbnail(thumb);

  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked for anime recommendations (${heading}). Your picks are: ${recs.map((r) => r.title).join(", ")}. ` +
      "Pitch them in character in 1-3 sentences — say which one you'd watch first. Don't invent plot details.",
    { embed, fallback: "Ooh, try these!", logExtra: `[recommendations] ${recs.map((r) => r.title).join(" / ")}` }
  );
  return true;
};
