import axios from "axios";
import { EmbedBuilder } from "discord.js";
import { anilist, describeError, plainText } from "./anilist";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";

/**
 * "aurora tell me about Frieren" — real info from MyAnimeList via Jikan
 * (free, no key), with her opinion written by Kindroid.
 */

const LOOKUP =
  /\b(tell me about|what do you think (?:of|about)|what'?s your (?:take|opinion) on|(?:your )?thoughts on|info (?:on|about)|look up|have you (?:ever )?(?:watched|seen|read)|should i (?:watch|read)|is it worth watching|rate)\s+(.+)/i;
/** Verbs that only make sense for a show/manga, so no "anime" word is needed. */
const MEDIA_VERBS = /^(have you|should i|rate|is it worth)/i;
const NOT_A_TITLE = /^(you|yourself|your|me|my|myself|him|her|them|us|it|this|that|what|how|why|when|where|who|the weather|weather|a picture|pictures?)\b/i;

export interface AnimeRequest {
  query: string;
  kind: "anime" | "manga";
  /** True when it's clearly about a show (said "anime", "have you watched"...). */
  explicit: boolean;
}

export function parseAnimeRequest(text: string): AnimeRequest | null {
  const match = text.match(LOOKUP);
  if (!match) return null;
  const verb = match[1];
  let raw = match[2].trim();

  const mentionsManga = /\bmanga\b|\bread\b/i.test(`${verb} ${raw}`);
  const mentionsAnime = /\b(anime|show|series)\b/i.test(raw);

  raw = raw
    .replace(/[?!.]+$/, "")
    .replace(/\b(is it|any|actually|really)\s+(good|worth (?:it|watching|reading))\b.*$/i, "")
    .replace(/\b(worth (?:it|watching|reading)|any good|please|pls)\b.*$/i, "")
    .replace(/^(the\s+)?(anime|manga|show|series)\s+(called\s+)?/i, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+(anime|manga|series|show)$/i, "")
    .replace(/["“”]/g, "")
    .trim();

  if (!raw || raw.length > 80 || NOT_A_TITLE.test(raw)) return null;
  return {
    query: raw,
    kind: mentionsManga ? "manga" : "anime",
    explicit: mentionsAnime || mentionsManga || MEDIA_VERBS.test(verb),
  };
}

export interface JikanEntry {
  mal_id: number;
  url: string;
  title: string;
  title_english?: string | null;
  title_synonyms?: string[];
  titles?: { title: string }[];
  type?: string | null;
  episodes?: number | null;
  chapters?: number | null;
  volumes?: number | null;
  status?: string | null;
  score?: number | null;
  rank?: number | null;
  members?: number | null;
  synopsis?: string | null;
  year?: number | null;
  aired?: { string?: string };
  published?: { string?: string };
  genres?: { name: string }[];
  studios?: { name: string }[];
  images?: { jpg?: { image_url?: string; large_image_url?: string } };
  /** Where the info came from (MyAnimeList normally, AniList as the backup). */
  source?: "MyAnimeList" | "AniList";
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Does the search text clearly name this entry? (Used when they didn't say "anime".) */
function strongMatch(query: string, entry: JikanEntry): boolean {
  const q = normalize(query);
  const variants = [
    entry.title,
    entry.title_english ?? "",
    ...(entry.title_synonyms ?? []),
    ...(entry.titles ?? []).map((t) => t.title),
  ].filter(Boolean);
  return variants.some((v) => {
    const full = normalize(v);
    const beforeSubtitle = normalize(v.split(/[:\-–(]/)[0]);
    return q === full || q === beforeSubtitle;
  });
}

function pickResult(request: AnimeRequest, results: JikanEntry[]): JikanEntry | null {
  const strong = results.find((r) => strongMatch(request.query, r));
  if (strong) {
    // Without an "anime" hint, only accept fairly well-known shows.
    if (!request.explicit && (strong.members ?? 0) < 20_000) return null;
    return strong;
  }
  return request.explicit ? results[0] ?? null : null;
}

async function searchJikan(request: AnimeRequest): Promise<JikanEntry | null> {
  const { data } = await axios.get(`https://api.jikan.moe/v4/${request.kind}`, {
    params: { q: request.query, limit: 10, sfw: true, order_by: "members", sort: "desc" },
    timeout: 12_000,
  });
  const results: JikanEntry[] = Array.isArray(data?.data) ? data.data : [];
  return pickResult(request, results.map((r) => ({ ...r, source: "MyAnimeList" as const })));
}

const ANILIST_STATUS: Record<string, string> = {
  FINISHED: "Finished",
  RELEASING: "Currently Airing",
  NOT_YET_RELEASED: "Not yet released",
  CANCELLED: "Cancelled",
  HIATUS: "On hiatus",
};

interface AniListMedia {
  idMal: number | null;
  siteUrl: string;
  format: string | null;
  episodes: number | null;
  chapters: number | null;
  volumes: number | null;
  status: string | null;
  averageScore: number | null;
  popularity: number | null;
  description: string | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  genres: string[] | null;
  isAdult: boolean;
  synonyms: string[] | null;
  title: { romaji: string | null; english: string | null };
  studios: { nodes: { name: string }[] } | null;
  coverImage: { large: string | null } | null;
}

/** Backup search on AniList, converted to the same shape as MyAnimeList results. */
async function searchAniList(request: AnimeRequest): Promise<JikanEntry | null> {
  const data = await anilist<{ Page: { media: AniListMedia[] } }>(
    `query ($search: String, $type: MediaType) {
      Page(perPage: 10) {
        media(search: $search, type: $type, isAdult: false, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          idMal siteUrl format episodes chapters volumes status averageScore popularity
          description(asHtml: false) seasonYear startDate { year } genres isAdult synonyms
          title { romaji english } studios(isMain: true) { nodes { name } } coverImage { large }
        }
      }
    }`,
    { search: request.query, type: request.kind === "manga" ? "MANGA" : "ANIME" }
  );
  const results: JikanEntry[] = (data.Page?.media ?? []).map((m) => {
    const year = m.seasonYear ?? m.startDate?.year ?? null;
    return {
      mal_id: m.idMal ?? 0,
      url: m.siteUrl,
      title: m.title.romaji ?? m.title.english ?? request.query,
      title_english: m.title.english,
      title_synonyms: m.synonyms ?? [],
      type: m.format,
      episodes: m.episodes,
      chapters: m.chapters,
      volumes: m.volumes,
      status: m.status ? ANILIST_STATUS[m.status] ?? m.status : null,
      score: m.averageScore ? m.averageScore / 10 : null,
      rank: null,
      members: m.popularity,
      synopsis: plainText(m.description),
      year,
      aired: { string: year ? String(year) : undefined },
      published: { string: year ? String(year) : undefined },
      genres: (m.genres ?? []).map((name) => ({ name })),
      studios: m.studios?.nodes ?? [],
      images: { jpg: { large_image_url: m.coverImage?.large ?? undefined } },
      source: "AniList" as const,
    };
  });
  return pickResult(request, results);
}

/** MyAnimeList (via Jikan) first; if that's down or busy, AniList. */
export async function search(request: AnimeRequest): Promise<JikanEntry | null> {
  try {
    return await searchJikan(request);
  } catch (err) {
    console.warn(`[anime] MyAnimeList (Jikan) failed (${describeError(err)}), trying AniList…`);
    return await searchAniList(request);
  }
}

export const animeFeature: Feature = async (ctx) => {
  const request = parseAnimeRequest(ctx.text);
  if (!request) return false;

  let entry: JikanEntry | null;
  try {
    entry = await search(request);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    console.warn(`[anime] MyAnimeList and AniList both failed (${describeError(err)})`);
    if (!request.explicit) return false; // probably not about an anime anyway; just chat
    await replyPlain(
      ctx,
      status === 429
        ? "The anime databases are busy right now — ask me again in a few seconds!"
        : "I can't reach the anime databases right now 😣 Try again in a bit."
    );
    return true;
  }

  if (!entry) {
    if (!request.explicit) return false; // e.g. "tell me about your day" → normal chat
    await replyPlain(ctx, `I couldn't find a ${request.kind} called "${request.query}" 🤔`);
    return true;
  }

  const name = entry.title_english || entry.title;
  const isManga = request.kind === "manga";
  const length = isManga
    ? [entry.volumes ? `${entry.volumes} volumes` : "", entry.chapters ? `${entry.chapters} chapters` : ""]
        .filter(Boolean)
        .join(", ") || "Ongoing"
    : entry.episodes
      ? `${entry.episodes} episode${entry.episodes === 1 ? "" : "s"}`
      : "Unknown";
  const when = (isManga ? entry.published?.string : entry.aired?.string) || (entry.year ? String(entry.year) : "Unknown");
  const genres = (entry.genres ?? []).map((g) => g.name).join(", ") || "—";
  const score = entry.score ? `⭐ ${entry.score.toFixed(2)}${entry.rank ? ` (#${entry.rank})` : ""}` : "Not rated yet";
  const synopsis = (entry.synopsis ?? "No synopsis available.").replace(/\[Written by MAL Rewrite\]/g, "").trim();

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(truncate(name, 256))
    .setURL(entry.url)
    .setDescription(truncate(synopsis, 400))
    .addFields(
      { name: "Score", value: score, inline: true },
      { name: isManga ? "Length" : "Episodes", value: length, inline: true },
      { name: "Status", value: entry.status || "Unknown", inline: true },
      { name: isManga ? "Published" : "Aired", value: truncate(when, 100), inline: true },
      { name: "Genres", value: truncate(genres, 200), inline: true }
    )
    .setFooter({ text: `${entry.source ?? "MyAnimeList"} · ${entry.type ?? request.kind}` });
  if (entry.title_english && entry.title_english !== entry.title) {
    embed.setAuthor({ name: truncate(entry.title, 200) });
  }
  const image = entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url;
  if (image) embed.setThumbnail(image);

  const studios = (entry.studios ?? []).map((s) => s.name).join(", ");
  const facts =
    `"${name}" (${entry.type ?? request.kind}), ${entry.source ?? "MyAnimeList"} score ${entry.score ?? "n/a"}` +
    `${entry.rank ? `, ranked #${entry.rank}` : ""}, ${length}, ${entry.status ?? "status unknown"}, ` +
    `aired/published ${when}, genres: ${genres}${studios ? `, studio: ${studios}` : ""}. ` +
    `Synopsis: ${truncate(synopsis, 600)}`;

  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked about this ${request.kind}. Real info: ${facts} ` +
      "Give your in-character take on it in 2-3 sentences. Stick to these facts; don't invent plot details.",
    { embed, fallback: `Here's what I found about **${name}**!`, logExtra: `[anime] ${name} — ${entry.url}` }
  );
  return true;
};
