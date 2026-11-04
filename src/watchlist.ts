import { EmbedBuilder } from "discord.js";
import { search } from "./anime";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, pick, replyInCharacter, replyPlain, truncate } from "./featureKit";

/**
 * A shared watchlist for each server (or each person, in DMs):
 *   "aurora add Chainsaw Man to the watchlist"
 *   "aurora show the watchlist"
 *   "aurora remove Chainsaw Man from the watchlist" / "aurora we watched Chainsaw Man"
 *   "aurora what should we watch tonight?" (picks one from the list)
 */

const MAX_ITEMS = 50;
const LIST_WORD = "(?:watch\\s?-?list|wl)";
const ADD = new RegExp(`\\b(?:add|put)\\s+(.+?)\\s+(?:to|on|in)\\s+(?:the|our|my)?\\s*${LIST_WORD}\\b`, "i");
const REMOVE = new RegExp(`\\b(?:remove|delete|take|cross)\\s+(.+?)\\s+(?:from|off)\\s+(?:of\\s+)?(?:the|our|my)?\\s*${LIST_WORD}\\b`, "i");
const WATCHED = /\bwe (?:watched|finished|saw)\s+(.+?)[.!]*$/i;
const SHOW = new RegExp(
  `\\b(?:show|see|list|check)\\s+(?:me\\s+|us\\s+)?(?:the|our|my)?\\s*${LIST_WORD}\\b|\\bwhat'?s\\s+on\\s+(?:the|our|my)?\\s*${LIST_WORD}\\b|^(?:the\\s+|our\\s+)?${LIST_WORD}[?!.]*$`,
  "i"
);
const PICK = new RegExp(
  `\\b(?:pick|choose|roll)\\s+(?:something|an anime|a show|one|a random one|tonight'?s (?:show|anime|watch))\\s+(?:from|off|on)\\s+(?:the|our|my)?\\s*${LIST_WORD}\\b|\\bwhat should we watch(?: tonight| today| next)?\\b|\\bwatch party pick\\b`,
  "i"
);

type Request =
  | { action: "add" | "remove"; title: string; casual?: boolean }
  | { action: "show" | "pick" };

export function parseWatchlistRequest(text: string): Request | null {
  const add = text.match(ADD);
  if (add) return { action: "add", title: clean(add[1]) };
  const remove = text.match(REMOVE);
  if (remove) return { action: "remove", title: clean(remove[1]) };
  const watched = text.match(WATCHED);
  if (watched) return { action: "remove", title: clean(watched[1]), casual: true };
  if (PICK.test(text)) return { action: "pick" };
  if (SHOW.test(text)) return { action: "show" };
  return null;
}

function clean(title: string): string {
  return title.replace(/["“”]/g, "").replace(/^(the anime|anime)\s+/i, "").trim();
}

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

export const watchlistFeature: Feature = async (ctx) => {
  const request = parseWatchlistRequest(ctx.text);
  if (!request) return false;
  if (!pool || !(await useDb())) {
    await replyPlain(ctx, "The watchlist needs my database connected — ask the server owner to set it up 😣");
    return true;
  }

  // One list per server; in DMs, a personal list.
  const scope = ctx.message.guildId ?? `dm:${ctx.user.id}`;
  const botId = ctx.botConfig.id;
  const listName = ctx.message.guildId ? "the watchlist" : "your watchlist";

  if (request.action === "add") {
    const { rows: countRows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM watchlist WHERE bot_id = $1 AND scope = $2",
      [botId, scope]
    );
    if (Number(countRows[0]?.count ?? 0) >= MAX_ITEMS) {
      await replyPlain(ctx, `The watchlist is full (${MAX_ITEMS} shows)! Remove some first.`);
      return true;
    }
    // Use the official title + link when MyAnimeList knows it.
    const entry = await search({ query: request.title, kind: "anime", explicit: true }).catch(() => null);
    const title = entry ? entry.title_english || entry.title : request.title;
    const result = await pool.query(
      `INSERT INTO watchlist (bot_id, scope, title, url, added_by, added_by_name)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [botId, scope, title, entry?.url ?? null, ctx.user.id, ctx.user.name]
    );
    if (!result.rowCount) {
      await replyPlain(ctx, `**${title}** is already on ${listName}!`);
      return true;
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setDescription(`📝 Added **${entry?.url ? `[${title}](${entry.url})` : title}** to ${listName}`);
    await replyInCharacter(
      ctx,
      `${ctx.user.name} added the anime "${title}" to ${listName}. React in character in one short sentence.`,
      { embed, fallback: `Added ${title}! 📝`, logExtra: `[watchlist +] ${title}` }
    );
    return true;
  }

  if (request.action === "remove") {
    const result = await pool.query<{ title: string }>(
      "DELETE FROM watchlist WHERE bot_id = $1 AND scope = $2 AND title ILIKE $3 RETURNING title",
      [botId, scope, `%${request.title}%`]
    );
    // "we watched a movie yesterday" isn't about the list — just chat.
    if (!result.rows.length && request.casual) return false;
    await replyPlain(
      ctx,
      result.rows.length
        ? `✅ Crossed **${result.rows.map((r) => r.title).join(", ")}** off ${listName}.`
        : `I couldn't find "${request.title}" on ${listName}.`
    );
    return true;
  }

  type Item = { title: string; url: string | null; added_by_name: string };
  const { rows } = await pool.query<Item>(
    "SELECT title, url, added_by_name FROM watchlist WHERE bot_id = $1 AND scope = $2 ORDER BY created_at",
    [botId, scope]
  );
  if (rows.length === 0) {
    await replyPlain(ctx, `${listName[0].toUpperCase()}${listName.slice(1)} is empty! Add something with *add Frieren to the watchlist*.`);
    return true;
  }

  if (request.action === "show") {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`📝 ${ctx.message.guildId ? "Server" : "Your"} watchlist (${rows.length})`)
      .setDescription(
        rows
          .map((r, i) => `${i + 1}. ${r.url ? `[${truncate(r.title, 80)}](${r.url})` : truncate(r.title, 80)} — added by ${r.added_by_name}`)
          .join("\n")
          .slice(0, 4000)
      )
      .setFooter({ text: "Ask \"what should we watch tonight?\" and I'll pick one!" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  // pick
  const choice: Item = pick<Item>(rows);
  const embed = new EmbedBuilder()
    .setColor(0xff7ab6)
    .setTitle("🍿 Tonight's pick")
    .setDescription(`**${choice.url ? `[${choice.title}](${choice.url})` : choice.title}**\n(added by ${choice.added_by_name})`);
  await replyInCharacter(
    ctx,
    `Everyone wants to know what to watch tonight. You picked "${choice.title}" from the watchlist ` +
      `(${rows.length} shows on it). Announce it excitedly in character in 1-2 sentences.`,
    { embed, fallback: `Tonight we're watching ${choice.title}! 🍿`, logExtra: `[watchlist pick] ${choice.title}` }
  );
  return true;
};
