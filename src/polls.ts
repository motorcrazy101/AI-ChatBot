import { Client, EmbedBuilder } from "discord.js";
import { logBotPost } from "./chatLog";
import { initDb, isDbReady, pool } from "./db";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain, truncate } from "./featureKit";
import { generateReply, ReplyChannel } from "./respond";
import { BotConfig } from "./types";

/**
 * "aurora poll: pizza or tacos?" / "aurora poll best girl? Frieren, Fern, Stark for 2 hours"
 * Members vote with reactions; when time's up she announces the winner.
 */

const TRIGGER = /^(?:(?:make|start|create|run|do)\s+(?:a\s+|us\s+a\s+)?)?poll\b\s*[:\-–]?\s*([\s\S]+)$/i;
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 7 * 24 * 60;

export interface ParsedPoll {
  question: string;
  options: string[];
  minutes: number;
}

export function parsePoll(text: string): ParsedPoll | { error: string } | null {
  const match = text.match(TRIGGER);
  if (!match) return null;
  let body = match[1].trim();

  // "for 2 hours" / "for 30 minutes" / "for 1 day"
  let minutes = DEFAULT_MINUTES;
  const duration = body.match(/\b(?:for|lasting|ends? in)\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i);
  if (duration) {
    const n = Number.parseFloat(duration[1]);
    const unit = duration[2].toLowerCase();
    minutes = unit.startsWith("d") ? n * 1440 : unit.startsWith("h") ? n * 60 : n;
    body = body.replace(duration[0], " ").trim();
  }
  minutes = Math.round(Math.min(Math.max(minutes, 1), MAX_MINUTES));

  let question = "";
  let rest = body;
  const q = body.lastIndexOf("?");
  if (q !== -1) {
    question = body.slice(0, q + 1).trim();
    rest = body.slice(q + 1).trim();
  }

  const split = (s: string) =>
    s
      .split(/\s*(?:,|\||\/|\bor\b|\bvs\.?\b)\s*/i)
      .map((o) => o.replace(/^[\s:\-–]+|[\s.!]+$/g, "").trim())
      .filter(Boolean);

  let options = split(rest);
  if (options.length < 2 && question) {
    // "pizza or tacos?" — the options are inside the question
    const inside = split(question.replace(/\?$/, ""));
    if (inside.length >= 2) {
      options = inside;
      question = "Which one?";
    } else if (options.length === 0) {
      options = ["Yes", "No"];
    }
  }
  if (!question) question = "Which one?";
  if (options.length < 2) return { error: "Give me at least 2 options! Like: *poll: pizza or tacos?*" };
  if (options.length > NUMBER_EMOJIS.length) return { error: `That's too many options — ${NUMBER_EMOJIS.length} max.` };
  return { question: truncate(question, 250), options: options.map((o) => truncate(o, 80)), minutes };
}

// ---------- storage ----------

interface Poll {
  id: number;
  botId: string;
  channelId: string;
  messageId: string;
  question: string;
  options: string[];
  endsAt: Date;
}
const memory: Poll[] = [];
let memoryId = 1;

async function useDb(): Promise<boolean> {
  await initDb();
  return !!pool && isDbReady();
}

async function savePoll(p: Omit<Poll, "id">): Promise<void> {
  if (pool && (await useDb())) {
    await pool.query(
      "INSERT INTO polls (bot_id, channel_id, message_id, question, options, ends_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [p.botId, p.channelId, p.messageId, p.question, JSON.stringify(p.options), p.endsAt.toISOString()]
    );
    return;
  }
  memory.push({ ...p, id: memoryId++ });
}

async function takeEnded(botId: string): Promise<Poll[]> {
  if (pool && (await useDb())) {
    const { rows } = await pool.query(
      `UPDATE polls SET closed = true
        WHERE id IN (SELECT id FROM polls WHERE bot_id = $1 AND NOT closed AND ends_at <= now() LIMIT 10)
        RETURNING *`,
      [botId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      botId: r.bot_id,
      channelId: r.channel_id,
      messageId: r.message_id,
      question: r.question,
      options: Array.isArray(r.options) ? r.options : JSON.parse(r.options),
      endsAt: new Date(r.ends_at),
    }));
  }
  const now = Date.now();
  const ended = memory.filter((p) => p.botId === botId && p.endsAt.getTime() <= now);
  for (const p of ended) memory.splice(memory.indexOf(p), 1);
  return ended;
}

// ---------- feature ----------

export const pollFeature: Feature = async (ctx) => {
  const parsed = parsePoll(ctx.text);
  if (!parsed) return false;
  if ("error" in parsed) {
    await replyPlain(ctx, parsed.error);
    return true;
  }

  const endsAt = new Date(Date.now() + parsed.minutes * 60_000);
  const unix = Math.floor(endsAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📊 ${parsed.question}`)
    .setDescription(
      `${parsed.options.map((o, i) => `${NUMBER_EMOJIS[i]} ${o}`).join("\n")}\n\nVote with the reactions! Ends <t:${unix}:R>.`
    )
    .setFooter({ text: `Poll by ${ctx.user.name}` });

  const sent = await replyInCharacter(
    ctx,
    `${ctx.user.name} asked you to run a poll: "${parsed.question}" Options: ${parsed.options.join(", ")}. ` +
      "Announce it excitedly in character in one short sentence (don't vote yourself).",
    { embed, fallback: "📊 Poll time! Vote below!", logExtra: `[poll] ${parsed.question} ${parsed.options.join(" / ")}` }
  );
  for (let i = 0; i < parsed.options.length; i++) {
    await sent.react(NUMBER_EMOJIS[i]).catch(() => undefined);
  }
  await savePoll({
    botId: ctx.botConfig.id,
    channelId: ctx.channel.id,
    messageId: sent.id,
    question: parsed.question,
    options: parsed.options,
    endsAt,
  });
  return true;
};

// ---------- closing polls ----------

async function closePoll(client: Client<true>, botConfig: BotConfig, poll: Poll): Promise<void> {
  const fetched = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!fetched || !fetched.isTextBased() || !("messages" in fetched)) return;
  const channel = fetched as ReplyChannel;
  const message = await channel.messages.fetch(poll.messageId).catch(() => null);
  if (!message) return;

  const votes = poll.options.map((option, i) => {
    const reaction = message.reactions.cache.get(NUMBER_EMOJIS[i]);
    const count = Math.max(0, (reaction?.count ?? 0) - (reaction?.me ? 1 : 0));
    return { option, count };
  });
  const total = votes.reduce((sum, v) => sum + v.count, 0);
  const top = Math.max(...votes.map((v) => v.count));
  const winners = votes.filter((v) => v.count === top && top > 0).map((v) => v.option);

  const resultText = votes.map((v) => `${v.option}: ${v.count}`).join(", ");
  const outcome =
    total === 0
      ? "Nobody voted at all."
      : winners.length > 1
        ? `It's a tie between ${winners.join(" and ")}.`
        : `The winner is ${winners[0]}.`;

  let text = total === 0 ? "Nobody voted… 🥲" : `📊 Poll's over! ${outcome}`;
  try {
    const reply = await generateReply(client, botConfig, channel, {
      username: "Server",
      text: `(Your poll "${poll.question}" just ended. Results: ${resultText}. ${outcome} Announce the result in character, 1-2 sentences.)`,
    });
    if (reply) text = reply;
  } catch {
    // keep the plain text
  }

  const bars = votes
    .map((v) => {
      const share = total ? v.count / total : 0;
      const filled = Math.round(share * 10);
      return `${winners.includes(v.option) ? "🏆" : "▫️"} **${v.option}** ${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${v.count} (${Math.round(share * 100)}%)`;
    })
    .join("\n");
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📊 Results: ${poll.question}`.slice(0, 256))
    .setDescription(`${bars}\n\n${total} vote${total === 1 ? "" : "s"} · [original poll](${message.url})`);
  const sent = await channel.send({ content: text.slice(0, 1800), embeds: [embed], allowedMentions: { parse: [] } });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
}

/** Every 30 seconds: close polls whose time is up. */
export function startPollLoop(client: Client, botConfig: BotConfig): void {
  let running = false;
  setInterval(() => {
    if (!client.isReady() || running) return;
    running = true;
    takeEnded(botConfig.id)
      .then((ended) =>
        Promise.all(
          ended.map((p) =>
            closePoll(client, botConfig, p).catch((err) => console.error(`[${botConfig.id}] Closing poll failed:`, err))
          )
        )
      )
      .catch((err) => console.error(`[${botConfig.id}] Poll check failed:`, (err as Error).message))
      .finally(() => {
        running = false;
      });
  }, 30_000).unref();
}
