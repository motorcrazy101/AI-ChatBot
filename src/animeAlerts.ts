import axios from "axios";
import { Client, EmbedBuilder } from "discord.js";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";
import { canPostIn, generateReply, ReplyChannel } from "./respond";
import { formatDateTime } from "./time";
import { BotConfig } from "./types";

/**
 * Episode alerts from AniList's free airing schedule:
 *   "aurora tell me when Frieren airs"
 *   "aurora my anime alerts" / "aurora stop alerts for Frieren"
 * When a new episode airs she pings the person in the channel they asked in.
 */

const ANILIST = "https://graphql.anilist.co";
const MAX_ALERTS_PER_USER = 15;

const SUBSCRIBE =
  /\b(?:tell|let|notify|alert|ping|remind|message|dm)\s+me\s+(?:know\s+)?(?:when(?:ever)?|if|once)\s+(.+?)\s+(?:airs?|is airing|comes? out|drops?|releases?|is out|(?:has|gets) a new (?:episode|ep)|new (?:episodes?|eps?) (?:air|come out|drop|release)s?)\b/i;
const SUBSCRIBE_ALT = /\b(?:episode |airing )?alerts? for\s+(.+)$/i;
const LIST = /\bmy (?:anime |episode )?alerts\b|\bwhat (?:anime|shows) am i (?:following|tracking)\b/i;
const STOP =
  /\b(?:stop|cancel|remove|turn off|unsubscribe(?: from)?)\s+(?:my\s+)?(?:anime\s+|episode\s+)?alerts?\s+(?:for|about|on)\s+(.+)$|\bstop (?:telling|alerting|pinging|notifying) me (?:about|when)\s+(.+?)(?:\s+airs?)?$/i;

function cleanTitle(raw: string): string {
  return raw
    .replace(/^(?:the\s+)?(?:new|next|latest)\s+(?:episodes?|eps?)\s+(?:of\s+)?/i, "")
    .replace(/^(?:a\s+)?new\s+/i, "")
    .replace(/\s+anime$/i, "")
    .replace(/["“”?!.]/g, "")
    .trim();
}

export function parseAlertRequest(text: string): { action: "subscribe" | "stop"; title: string } | { action: "list" } | null {
  if (LIST.test(text)) return { action: "list" };
  const stop = text.match(STOP);
  if (stop) return { action: "stop", title: cleanTitle(stop[1] ?? stop[2] ?? "") };
  const sub = text.match(SUBSCRIBE) ?? text.match(SUBSCRIBE_ALT);
  if (sub) {
    const title = cleanTitle(sub[1]);
    if (title && !/^(it|that|this|you|the weather)$/i.test(title)) return { action: "subscribe", title };
  }
  return null;
}

interface AniMedia {
  id: number;
  siteUrl: string;
  status: string;
  episodes: number | null;
  title: { romaji: string | null; english: string | null };
  coverImage?: { large?: string | null };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
}

const MEDIA_FIELDS = "id siteUrl status episodes title { romaji english } coverImage { large } nextAiringEpisode { episode airingAt }";

async function anilist<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { data } = await axios.post(ANILIST, { query, variables }, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    timeout: 12_000,
  });
  if (data?.errors?.length) throw new Error(data.errors[0].message ?? "AniList error");
  return data.data as T;
}

async function findAnime(search: string): Promise<AniMedia | null> {
  const data = await anilist<{ Media: AniMedia | null }>(
    `query ($search: String) { Media(search: $search, type: ANIME, sort: [POPULARITY_DESC]) { ${MEDIA_FIELDS} } }`,
    { search }
  ).catch((err) => {
    if (/not found/i.test((err as Error).message)) return { Media: null };
    throw err;
  });
  return data.Media;
}

async function refreshAnime(ids: number[]): Promise<AniMedia[]> {
  const data = await anilist<{ Page: { media: AniMedia[] } }>(
    `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
    { ids }
  );
  return data.Page.media;
}

const titleOf = (m: AniMedia) => m.title.english || m.title.romaji || "that anime";

// ---------- storage (needs the database) ----------

interface Alert {
  id: number;
  userId: string;
  userName: string;
  channelId: string;
  anilistId: number;
  title: string;
  siteUrl: string | null;
  nextEpisode: number | null;
}

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

function toAlert(r: Record<string, unknown>): Alert {
  return {
    id: Number(r.id),
    userId: String(r.user_id),
    userName: String(r.user_name),
    channelId: String(r.channel_id),
    anilistId: Number(r.anilist_id),
    title: String(r.title),
    siteUrl: r.site_url ? String(r.site_url) : null,
    nextEpisode: r.next_episode === null || r.next_episode === undefined ? null : Number(r.next_episode),
  };
}

// ---------- feature ----------

export const animeAlertFeature: Feature = async (ctx) => {
  const request = parseAlertRequest(ctx.text);
  if (!request) return false;

  if (!pool || !(await useDb())) {
    await replyPlain(ctx, "Episode alerts need my database connected — ask the server owner to set it up 😣");
    return true;
  }

  if (request.action === "list") {
    const { rows } = await pool.query(
      "SELECT * FROM anime_alerts WHERE bot_id = $1 AND user_id = $2 ORDER BY next_airing_at NULLS LAST",
      [ctx.botConfig.id, ctx.user.id]
    );
    if (rows.length === 0) {
      await replyPlain(ctx, "You're not following any anime yet. Try *tell me when Frieren airs*!");
      return true;
    }
    const lines = rows.map((r) => {
      const at = r.next_airing_at ? formatDateTime(new Date(r.next_airing_at)) : "date not announced";
      return `📺 **${r.title}** — ep ${r.next_episode ?? "?"} · ${at}`;
    });
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`📺 ${ctx.user.name}'s episode alerts`)
      .setDescription(lines.join("\n").slice(0, 4000))
      .setFooter({ text: "Stop one with: stop alerts for <title>" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (request.action === "stop") {
    const result = await pool.query(
      "DELETE FROM anime_alerts WHERE bot_id = $1 AND user_id = $2 AND title ILIKE $3",
      [ctx.botConfig.id, ctx.user.id, `%${request.title}%`]
    );
    await replyPlain(
      ctx,
      result.rowCount ? `🔕 Okay, no more alerts for **${request.title}**.` : `You don't have alerts for "${request.title}".`
    );
    return true;
  }

  // subscribe
  let media: AniMedia | null;
  try {
    media = await findAnime(request.title);
  } catch (err) {
    console.warn("[anime-alerts] AniList failed:", (err as Error).message);
    await replyPlain(ctx, "I can't reach the anime schedule right now 😣 Try again in a bit.");
    return true;
  }
  if (!media) {
    await replyPlain(ctx, `I couldn't find an anime called "${request.title}" 🤔`);
    return true;
  }
  const title = titleOf(media);
  if (!media.nextAiringEpisode) {
    const why =
      media.status === "FINISHED"
        ? "it already finished airing"
        : media.status === "NOT_YET_RELEASED"
          ? "it doesn't have an air date yet"
          : "there's no upcoming episode scheduled right now";
    await replyPlain(ctx, `I can't set an alert for **${title}** — ${why}.`);
    return true;
  }

  const { rows: existing } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM anime_alerts WHERE bot_id = $1 AND user_id = $2",
    [ctx.botConfig.id, ctx.user.id]
  );
  if (Number(existing[0]?.count ?? 0) >= MAX_ALERTS_PER_USER) {
    await replyPlain(ctx, `You're already following ${MAX_ALERTS_PER_USER} shows! Stop one first (*my anime alerts* to see them).`);
    return true;
  }

  const next = media.nextAiringEpisode;
  const airsAt = new Date(next.airingAt * 1000);
  await pool.query(
    `INSERT INTO anime_alerts (bot_id, user_id, user_name, channel_id, anilist_id, title, site_url, next_episode, next_airing_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (bot_id, user_id, anilist_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, next_episode = EXCLUDED.next_episode,
           next_airing_at = EXCLUDED.next_airing_at, user_name = EXCLUDED.user_name`,
    [ctx.botConfig.id, ctx.user.id, ctx.user.name, ctx.channel.id, media.id, title, media.siteUrl, next.episode, airsAt.toISOString()]
  );

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`🔔 Alert set: ${truncate(title, 200)}`)
    .setURL(media.siteUrl)
    .setDescription(`Episode **${next.episode}** airs <t:${next.airingAt}:F> (<t:${next.airingAt}:R>)`)
    .setFooter({ text: "Schedule from AniList · stop with: stop alerts for <title>" });
  if (media.coverImage?.large) embed.setThumbnail(media.coverImage.large);

  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked you to tell them when new episodes of "${title}" air. Episode ${next.episode} airs on ` +
      `${formatDateTime(airsAt)}. Promise in character (one short sentence) that you'll ping them.`,
    { embed, fallback: `I'll ping you when ${title} airs! 📺`, logExtra: `[anime alert] ${title} ep ${next.episode}` }
  );
  return true;
};

// ---------- checking for new episodes ----------

async function notify(client: Client<true>, botConfig: BotConfig, alert: Alert, media: AniMedia | undefined): Promise<void> {
  const fetched = await client.channels.fetch(alert.channelId).catch(() => null);
  let channel: ReplyChannel | null =
    fetched && fetched.isTextBased() && "send" in fetched ? (fetched as ReplyChannel) : null;
  if (channel && !canPostIn(channel)) channel = null;
  if (!channel) {
    const user = await client.users.fetch(alert.userId).catch(() => null);
    channel = user ? await user.createDM().catch(() => null) : null;
  }
  if (!channel) return;

  const episode = alert.nextEpisode ?? "a new";
  let text = `Episode ${episode} of **${alert.title}** just aired! 📺`;
  try {
    const reply = await generateReply(
      client,
      botConfig,
      channel,
      {
        username: "Server",
        text: `(Episode ${episode} of the anime "${alert.title}" just came out. Tell ${alert.userName} excitedly in character, 1-2 short sentences. No spoilers.)`,
      },
      { id: alert.userId, name: alert.userName }
    );
    if (reply) text = reply;
  } catch {
    // keep the plain text
  }
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📺 ${truncate(alert.title, 200)} — Episode ${episode} is out!`)
    .setURL(alert.siteUrl ?? media?.siteUrl ?? null);
  if (media?.coverImage?.large) embed.setThumbnail(media.coverImage.large);
  const sent = await channel.send({
    content: `<@${alert.userId}> ${text}`.slice(0, 2000),
    embeds: [embed],
    allowedMentions: { users: [alert.userId] },
  });
  logBotPost(botConfig.id, client.user.displayName, sent, "reminder");
}

async function checkAlerts(client: Client<true>, botConfig: BotConfig): Promise<void> {
  if (!pool || !(await useDb())) return;
  const { rows } = await pool.query(
    "SELECT * FROM anime_alerts WHERE bot_id = $1 AND next_airing_at IS NOT NULL AND next_airing_at <= now() LIMIT 100",
    [botConfig.id]
  );
  if (rows.length === 0) return;
  const due: Alert[] = rows.map((r: Record<string, unknown>) => toAlert(r));

  const ids = [...new Set(due.map((a) => a.anilistId))];
  const fresh = await refreshAnime(ids).catch((err) => {
    console.warn("[anime-alerts] Refresh failed:", (err as Error).message);
    return null;
  });
  if (!fresh) return; // try again next time
  const byId = new Map(fresh.map((m) => [m.id, m]));

  for (const alert of due) {
    const media = byId.get(alert.anilistId);
    if (!media) continue; // not in AniList's answer this time; try again later
    const next = media.nextAiringEpisode;
    const alertEpisode = alert.nextEpisode ?? 0;
    const nowSec = Date.now() / 1000;

    const recheckLater = (episode: number) =>
      pool!.query("UPDATE anime_alerts SET next_episode = $2, next_airing_at = now() + interval '1 hour' WHERE id = $1", [
        alert.id,
        episode,
      ]);
    const ping = () =>
      notify(client, botConfig, alert, media).catch((err) => console.error(`[${botConfig.id}] Episode alert failed:`, err));

    if (!next) {
      // Finished airing: that was the last episode.
      await ping();
      await pool.query("DELETE FROM anime_alerts WHERE id = $1", [alert.id]);
    } else if (next.episode > alertEpisode) {
      // Our episode aired and AniList already shows the next one.
      await ping();
      await pool.query("UPDATE anime_alerts SET next_episode = $2, next_airing_at = $3 WHERE id = $1", [
        alert.id,
        next.episode,
        new Date(next.airingAt * 1000).toISOString(),
      ]);
    } else if (next.episode === alertEpisode && next.airingAt > nowSec) {
      // Delayed: just update the time, no ping yet.
      await pool.query("UPDATE anime_alerts SET next_airing_at = $2 WHERE id = $1", [
        alert.id,
        new Date(next.airingAt * 1000).toISOString(),
      ]);
    } else if (next.episode === alertEpisode) {
      // Aired on schedule, but AniList hasn't moved on yet.
      await ping();
      await recheckLater(alertEpisode + 1);
    } else {
      // AniList is behind us; look again in an hour without pinging.
      await recheckLater(alertEpisode);
    }
  }
}

/** Every 5 minutes: ping people about episodes that just aired. */
export function startAnimeAlertLoop(client: Client, botConfig: BotConfig): void {
  let running = false;
  setInterval(() => {
    if (!client.isReady() || running) return;
    running = true;
    checkAlerts(client, botConfig)
      .catch((err) => console.error(`[${botConfig.id}] Anime alert check failed:`, (err as Error).message))
      .finally(() => {
        running = false;
      });
  }, 5 * 60_000).unref();
}
