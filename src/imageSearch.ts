import axios from "axios";
import { Client, EmbedBuilder, Message } from "discord.js";
import { logOutgoing } from "./chatLog";
import { config } from "./config";
import { botDisplayName, generateReply, ReplyChannel, startTyping } from "./respond";
import { BotConfig } from "./types";

/**
 * "Aurora, find me a picture of ..." support.
 *
 *  - Simple anime requests ("an anime girl", "a neko", "anime hug gif") come
 *    from nekos.best: free, no key, safe-for-work anime art only.
 *  - Everything else (and anime requests with specific details, like
 *    "anime girl with silver hair") uses Brave image search with SafeSearch
 *    on. Needs BRAVE_API_KEY.
 *
 * The bot code finds the picture; Kindroid writes a comment to go with it.
 */

const NOUNS = "pic|pics|picture|pictures|image|images|photo|photos|gif|gifs|wallpaper|wallpapers|meme|memes";
const VERBS = "find|show|send|get|give|search|post|grab|drop|pull up|look up";

// "find me a picture of X" / "send a gif of X"
const PATTERN_OF = new RegExp(
  `\\b(?:${VERBS})\\b[^.!?\\n]{0,30}?\\b(${NOUNS})\\b\\s+(?:of|for|with|showing)\\s+([^.!?\\n]+)`,
  "i"
);
// "send me a cat pic" / "find me an anime wallpaper"
const PATTERN_BEFORE = new RegExp(
  `\\b(?:${VERBS})\\b(?:\\s+(?:me|us))?\\s+(?:(?:an|a|some|the|another)\\s+)?([^.!?\\n]{1,60}?)\\s+(${NOUNS})\\b`,
  "i"
);

const FILLER =
  /\b(from|on|off|in|using|via)\s+(google|bing|the internet|the web|online|the net|brave)\b|\b(please|pls|plz|for me|real quick|rn|right now)\b/gi;

/** Requests about the bot herself get a normal chat reply instead (she can't send selfies). */
const SELF_REFERENCES = /^(you|yourself|your\s+\w+|u|ur\s+\w+|a selfie|selfie|yourself\s+.*)$/i;

export interface ImageRequest {
  query: string;
  wantGif: boolean;
}

/** Works out whether a message is asking for a picture, and of what. */
export function parseImageRequest(text: string): ImageRequest | null {
  let noun: string;
  let raw: string;

  const of = text.match(PATTERN_OF);
  const before = of ? null : text.match(PATTERN_BEFORE);
  if (of) {
    noun = of[1];
    raw = of[2];
  } else if (before) {
    raw = before[1];
    noun = before[2];
  } else {
    return null;
  }

  const query = raw
    .replace(FILLER, " ")
    .replace(/[,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(an|a|some|the|another|me|us)\s+/i, "")
    .replace(/^(an|a|some|the|another)\s+/i, "")
    .slice(0, 100)
    .trim();

  if (!query || SELF_REFERENCES.test(query)) return null;
  const isMeme = /^memes?$/i.test(noun) && !/\bmemes?\b/i.test(query);
  return {
    query: isMeme ? `${query} meme` : query,
    wantGif: /^gifs?$/i.test(noun) || /\bgifs?\b/i.test(query),
  };
}

// ---------- anime (nekos.best) ----------

const ANIME_WORDS = [
  "anime", "manga", "waifu", "husbando", "neko", "nekomimi", "catgirl", "cat girl",
  "kitsune", "foxgirl", "fox girl", "chibi", "kemonomimi",
];
const IMAGE_CATEGORIES: [string, string[]][] = [
  ["husbando", ["husbando", "guy", "guys", "boy", "boys", "man", "men", "dude", "male", "bishounen", "boyfriend"]],
  ["kitsune", ["kitsune", "fox", "foxgirl", "fox girl"]],
  ["neko", ["neko", "nekomimi", "catgirl", "cat girl", "cat"]],
  ["waifu", ["waifu", "girl", "girls", "chick", "chicks", "gal", "lady", "woman", "women", "girlfriend"]],
];
const GIF_CATEGORIES = [
  "baka", "bite", "blush", "bored", "cry", "cuddle", "dance", "facepalm", "feed", "handhold",
  "handshake", "happy", "highfive", "hug", "kick", "kiss", "laugh", "lurk", "nod", "nom", "nope",
  "pat", "peck", "poke", "pout", "punch", "run", "shrug", "slap", "sleep", "smile", "smug",
  "stare", "think", "thumbsup", "tickle", "wave", "wink", "yawn", "yeet",
];
/** Words that don't make a request "specific". */
const GENERIC = new Set([
  "a", "an", "the", "some", "of", "with", "and", "random", "cute", "pretty", "cool", "nice",
  "beautiful", "hot", "kawaii", "good", "funny", "picture", "pic", "image", "photo", "gif",
  "gifs", "wallpaper", "art", "style", "character", "another", "new", "any",
]);

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word}($|[^a-z])`, "i").test(text);
}

function isAnimeRequest(query: string): boolean {
  return ANIME_WORDS.some((w) => hasWord(query, w));
}

/** Picks a nekos.best category, or null if the request is too specific for it. */
function animeCategory(request: ImageRequest): string | null {
  const q = request.query.toLowerCase();
  const gif = GIF_CATEGORIES.find((c) => hasWord(q, c) || hasWord(q, `${c}s`) || hasWord(q, `${c}ing`));
  const image = IMAGE_CATEGORIES.find(([, words]) => words.some((w) => hasWord(q, w)));

  // Is there anything left once the category/anime/generic words are removed?
  const known = new Set<string>([...GENERIC, ...ANIME_WORDS, ...GIF_CATEGORIES]);
  for (const [, words] of IMAGE_CATEGORIES) words.forEach((w) => known.add(w));
  const leftover = q
    .split(/[^a-z0-9']+/)
    .filter((w) => w && !known.has(w) && !known.has(w.replace(/(s|ing)$/, "")));
  if (leftover.length > 0) return null;

  if (gif) return gif;
  if (request.wantGif) return null;
  return image ? image[0] : "waifu";
}

interface FoundImage {
  url: string;
  title?: string;
  pageUrl?: string;
  credit?: string;
}

async function searchAnime(category: string): Promise<FoundImage | null> {
  const { data } = await axios.get(`https://nekos.best/api/v2/${category}`, {
    params: { amount: 1 },
    timeout: 10_000,
  });
  const item = data?.results?.[0];
  if (!item?.url) return null;
  const credit = item.artist_name
    ? `Art by ${item.artist_name}`
    : item.anime_name
      ? `From ${item.anime_name}`
      : "via nekos.best";
  return { url: item.url, pageUrl: item.source_url || item.artist_href || undefined, credit };
}

// ---------- web (Brave) ----------

const braveKey = process.env.BRAVE_API_KEY?.trim() ?? "";
const dailyLimit = Number.parseInt(process.env.IMAGE_SEARCH_DAILY_LIMIT ?? "", 10) || 50;
let searchesToday = 0;
let searchDay = "";

/** Recently posted images per channel, so she doesn't repeat herself. */
const recentImages = new Map<string, string[]>();

function underDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== searchDay) {
    searchDay = today;
    searchesToday = 0;
  }
  return searchesToday < dailyLimit;
}

function looksLikeImageFile(url: string): boolean {
  return /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
}

async function searchWeb(query: string, channelId: string): Promise<FoundImage | null> {
  searchesToday++;
  const { data } = await axios.get("https://api.search.brave.com/res/v1/images/search", {
    params: { q: query, safesearch: "strict", count: 20 },
    headers: { Accept: "application/json", "X-Subscription-Token": braveKey },
    timeout: 15_000,
  });

  const recent = recentImages.get(channelId) ?? [];
  const candidates = (Array.isArray(data?.results) ? data.results : [])
    .map((r: Record<string, any>): FoundImage | null => {
      const original: string | undefined = r?.properties?.url;
      const thumbnail: string | undefined = r?.thumbnail?.src;
      // Prefer the full image when it's a plain image link; otherwise use Brave's copy.
      const url = original && looksLikeImageFile(original) ? original : thumbnail ?? original;
      if (!url) return null;
      return {
        url,
        title: typeof r.title === "string" ? r.title : undefined,
        pageUrl: typeof r.url === "string" ? r.url : undefined,
        credit: typeof r.source === "string" ? r.source : undefined,
      };
    })
    .filter((r: FoundImage | null): r is FoundImage => r !== null)
    .slice(0, 10);

  const fresh = candidates.filter((c: FoundImage) => !recent.includes(c.url));
  const pool = fresh.length ? fresh : candidates;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function remember(channelId: string, url: string): void {
  const list = recentImages.get(channelId) ?? [];
  list.push(url);
  recentImages.set(channelId, list.slice(-20));
}

// ---------- putting it together ----------

type SearchOutcome =
  | { kind: "found"; image: FoundImage }
  | { kind: "none" }
  | { kind: "no-web-search" }
  | { kind: "limit" };

async function findImage(request: ImageRequest, channelId: string): Promise<SearchOutcome> {
  const anime = isAnimeRequest(request.query);
  const category = anime ? animeCategory(request) : null;

  if (category) {
    try {
      const image = await searchAnime(category);
      if (image) return { kind: "found", image };
    } catch (err) {
      console.warn(`[images] nekos.best failed for "${category}":`, (err as Error).message);
    }
  }

  if (!braveKey) return { kind: "no-web-search" };
  if (!underDailyLimit()) return { kind: "limit" };

  const query = request.wantGif && !/\bgifs?\b/i.test(request.query) ? `${request.query} gif` : request.query;
  const image = await searchWeb(query, channelId);
  return image ? { kind: "found", image } : { kind: "none" };
}

/** Finds the picture, gets an in-character comment from Kindroid, and posts both. */
export async function handleImageRequest(
  message: Message,
  channel: ReplyChannel,
  request: ImageRequest,
  client: Client<true>,
  botConfig: BotConfig
): Promise<void> {
  const botName = botDisplayName(client, channel);
  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const outcome = await findImage(request, channel.id);

    if (outcome.kind !== "found") {
      stopTyping();
      const text =
        outcome.kind === "no-web-search"
          ? "I can only find anime pictures right now — web image search isn't set up yet."
          : outcome.kind === "limit"
            ? "I've hit my picture-search limit for today. Ask me again tomorrow!"
            : `I couldn't find a picture of "${request.query}" 😔`;
      const reply = await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: true } });
      logOutgoing(botConfig.id, botName, reply, message);
      return;
    }

    const { image } = outcome;
    remember(channel.id, image.url);

    // Ask Kindroid for a short comment; post the picture even if that fails.
    let comment = "Here you go!";
    try {
      const reply = await generateReply(client, botConfig, channel, {
        username: "Server",
        text:
          `(${botName} found a picture of "${request.query}"${image.title ? ` titled "${image.title}"` : ""} ` +
          `and is sharing it in the chat right now. Write a short, in-character message to go with it. ` +
          `Don't say you can't send pictures.)`,
      });
      if (reply) comment = reply.slice(0, 1800);
    } catch (err) {
      console.warn(`[${botConfig.id}] Comment for image failed:`, (err as Error).message);
    }

    const embed = new EmbedBuilder().setImage(image.url).setColor(0x6d4aff);
    if (image.title) embed.setTitle(image.title.slice(0, 256));
    if (image.pageUrl && /^https?:\/\//.test(image.pageUrl)) embed.setURL(image.pageUrl);
    if (image.credit) embed.setFooter({ text: image.credit.slice(0, 200) });

    stopTyping();
    const reply = await message.reply({
      content: comment,
      embeds: [embed],
      allowedMentions: { parse: [], repliedUser: true },
    });
    logOutgoing(botConfig.id, botName, reply, message, `${comment}\n[image] ${image.url}`);
  } catch (error) {
    console.error(`[${botConfig.id}] Image request failed:`, error);
    await message
      .reply({ content: config.errorMessage, allowedMentions: { parse: [] } })
      .catch(() => undefined);
  } finally {
    stopTyping();
  }
}
