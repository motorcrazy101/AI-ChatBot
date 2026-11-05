import { Client, EmbedBuilder, Message } from "discord.js";
import { addAffection } from "./affection";
import { anilist, plainText } from "./anilist";
import { wardenFor } from "./asylum";
import { logBotPost } from "./chatLog";
import { EMBED_COLOR, Feature, pick, replyPlain, truncate } from "./featureKit";
import { createGame, endGame, Game, getGame, saveGame } from "./gameState";
import { fetchGameChannel, guildOf, storyText } from "./storyKit";
import { BotConfig } from "./types";

/**
 * The Warden's Secret File — 20 Questions with a secret anime character.
 *   "aurora open the secret file" (or "20 questions")
 *   Then anyone asks yes/no questions ("is it a girl?") or guesses ("is it Levi?").
 *   "aurora give up" reveals it.
 */

const MAX_QUESTIONS = 20;
const IDLE_MINUTES = 30;

const START =
  /\b(?:start|play|open|new|begin)\s+(?:the\s+|a\s+)?(?:warden'?s\s+)?(?:secret\s+file|20\s*questions|twenty questions)\b/i;
const GIVE_UP = /\b(?:give up|i give up|we give up|reveal (?:it|the file)|tell us who it is)\b/i;
const QUESTION_START =
  /^(?:is|are|does|do|did|has|have|can|could|was|were|will|would|should|am)\b/i;

export interface SecretFileData {
  name: string;
  series: string;
  gender: string | null;
  description: string;
  image: string | null;
  questions: number;
  log: string[];
}

const BACKUP_CHARACTERS: Omit<SecretFileData, "questions" | "log">[] = [
  { name: "Naruto Uzumaki", series: "Naruto", gender: "Male", description: "A loud, determined ninja who wants to become Hokage.", image: null },
  { name: "Levi Ackerman", series: "Attack on Titan", gender: "Male", description: "A short, deadly captain obsessed with cleanliness.", image: null },
  { name: "Frieren", series: "Frieren: Beyond Journey's End", gender: "Female", description: "An elf mage who outlives her companions.", image: null },
  { name: "Monkey D. Luffy", series: "One Piece", gender: "Male", description: "A rubber-bodied pirate captain who loves meat.", image: null },
  { name: "Gojo Satoru", series: "Jujutsu Kaisen", gender: "Male", description: "A blindfolded, overwhelmingly strong sorcerer teacher.", image: null },
  { name: "Mikasa Ackerman", series: "Attack on Titan", gender: "Female", description: "A fiercely loyal soldier with a red scarf.", image: null },
  { name: "Anya Forger", series: "Spy x Family", gender: "Female", description: "A little girl who can secretly read minds.", image: null },
  { name: "Light Yagami", series: "Death Note", gender: "Male", description: "A genius student with a notebook that kills.", image: null },
  { name: "Nezuko Kamado", series: "Demon Slayer", gender: "Female", description: "A demon girl with a bamboo muzzle who protects humans.", image: null },
  { name: "Edward Elric", series: "Fullmetal Alchemist", gender: "Male", description: "A short alchemist with an automail arm.", image: null },
];

async function pickCharacter(): Promise<Omit<SecretFileData, "questions" | "log">> {
  try {
    const page = 1 + Math.floor(Math.random() * 6);
    const data = await anilist<{
      Page: {
        characters: {
          name: { full: string };
          gender: string | null;
          description: string | null;
          image: { large: string | null } | null;
          media: { nodes: { title: { english: string | null; romaji: string | null }; isAdult: boolean }[] };
        }[];
      };
    }>(
      `query ($page: Int) { Page(page: $page, perPage: 50) { characters(sort: FAVOURITES_DESC) {
        name { full } gender description(asHtml: false) image { large }
        media(perPage: 1, sort: POPULARITY_DESC, type: ANIME) { nodes { title { english romaji } isAdult } } } } }`,
      { page }
    );
    const usable = data.Page.characters.filter((c) => c.media.nodes[0] && !c.media.nodes[0].isAdult);
    const c = pick(usable);
    const title = c.media.nodes[0].title;
    return {
      name: c.name.full,
      series: title.english || title.romaji || "an anime",
      gender: c.gender,
      description: truncate(plainText(c.description).replace(/~!|!~/g, ""), 500),
      image: c.image?.large ?? null,
    };
  } catch (err) {
    console.warn("[secret-file] AniList failed, using a backup character:", (err as Error).message);
    return pick(BACKUP_CHARACTERS);
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** True if the guess names the character (first or last name is enough). */
export function isCorrectGuess(guess: string, name: string): boolean {
  const g = normalize(guess);
  const parts = normalize(name).split(" ").filter((p) => p.length >= 3);
  return parts.some((p) => new RegExp(`\\b${p}\\b`).test(g));
}

/** Hides the name/series if Kindroid accidentally says them. */
function redact(text: string, data: SecretFileData): string {
  let out = text;
  for (const word of [...normalize(data.name).split(" "), ...normalize(data.series).split(" ")]) {
    if (word.length < 4) continue;
    out = out.replace(new RegExp(`\\b${word}\\b`, "gi"), "███");
  }
  return out;
}

async function reveal(
  client: Client<true>,
  botConfig: BotConfig,
  game: Game<SecretFileData>,
  winner: { id: string; name: string } | null,
  reason: "won" | "gave up" | "out of questions" | "idle"
): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  await endGame(game);
  if (!channel) return;
  const d = game.data;
  const embed = new EmbedBuilder()
    .setColor(winner ? 0x3ba55d : 0x2b2d31)
    .setTitle(winner ? `🎉 ${winner.name} cracked the Secret File!` : "📁 The Secret File is revealed…")
    .setDescription(
      `It was **${d.name}** from *${d.series}*!\n` +
        (reason === "out of questions" ? `\nYou ran out of ${MAX_QUESTIONS} questions.` : "") +
        (reason === "idle" ? "\nThe file was left unattended, so it closed itself." : "") +
        `\n${d.questions} question${d.questions === 1 ? "" : "s"} asked.`
    );
  if (d.image) embed.setThumbnail(d.image);
  const sent = await channel.send({ embeds: [embed] });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
  if (winner) await addAffection(botConfig.id, winner, "trivia");
}

/** Idle timeout. */
export async function expireSecretFile(client: Client<true>, botConfig: BotConfig, game: Game<SecretFileData>): Promise<void> {
  await reveal(client, botConfig, game, null, "idle");
}

export const secretFileFeature: Feature = async (ctx) => {
  if (START.test(ctx.text)) {
    const existing = await getGame(ctx.botConfig.id, ctx.channel.id);
    if (existing) {
      await replyPlain(ctx, `There's already a ${existing.kind} going on here! Finish it first.`);
      return true;
    }
    const character = await pickCharacter();
    const data: SecretFileData = { ...character, questions: 0, log: [] };
    await createGame(ctx.botConfig.id, ctx.channel.id, "secretfile", data, new Date(Date.now() + IDLE_MINUTES * 60_000));
    const warden = wardenFor(ctx.botConfig.id, guildOf(ctx.channel));
    const intro = await storyText(
      ctx.client,
      ctx.botConfig,
      ctx.channel,
      guildOf(ctx.channel),
      `You've snuck a top-secret file out of ${warden.name}'s office (he's the Warden). It's about a famous anime character. ` +
        "Announce the game in character in under 50 words: everyone gets 20 yes/no questions to guess who's in the file. " +
        "Don't give any hints yet.",
      600
    );
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("📁 The Warden's Secret File")
      .setDescription(
        `A secret anime character is hidden in this file.\nAsk **yes/no questions** (like *is it a girl?*) — you have **${MAX_QUESTIONS}**.\n` +
          "Guess with *is it Levi?* · Say *aurora give up* to reveal it."
      );
    await replyPlain(ctx, intro ?? "Shh… I stole something from the Warden's office 🤫", embed);
    return true;
  }
  return false;
};

/**
 * Questions and guesses in a channel with an open Secret File — these work
 * without saying her name. Returns true if handled.
 */
export async function checkSecretFile(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig,
  game: Game<SecretFileData>,
  text: string,
  user: { id: string; name: string },
  addressed: boolean
): Promise<boolean> {
  const d = game.data;

  if (GIVE_UP.test(text)) {
    await reveal(client, botConfig, game, null, "gave up");
    return true;
  }

  const trimmed = text.trim();
  const isQuestion = QUESTION_START.test(trimmed) && /\?\s*$/.test(trimmed);
  const guessMatch = trimmed.match(/^(?:is it|it'?s|i guess|guess|my guess is|answer:?|is the character)\s+(.+?)[?!.]*$/i);
  if (!isQuestion && !(addressed && guessMatch)) return false;

  // A correct guess wins right away.
  if (guessMatch && isCorrectGuess(guessMatch[1], d.name)) {
    d.questions++;
    await reveal(client, botConfig, game, user, "won");
    return true;
  }

  d.questions++;
  game.deadline = new Date(Date.now() + IDLE_MINUTES * 60_000);
  const channel = await fetchGameChannel(client, game.channelId);
  if (!channel) return false;

  const answer = await storyText(
    client,
    botConfig,
    channel,
    guildOf(channel),
    `You're hosting 20 Questions. The secret character is ${d.name} from ${d.series}` +
      `${d.gender ? ` (${d.gender.toLowerCase()})` : ""}. About them: ${d.description || "a well-known anime character"}. ` +
      `${user.name} asks: "${trimmed}". Answer truthfully with Yes, No, or Sort of, plus at most one short teasing sentence. ` +
      "NEVER say the character's name or the anime's title.",
    300
  );
  const safe = redact(answer ?? "Hmm… sort of? 🤔", d);
  d.log.push(`${trimmed} → ${safe.slice(0, 60)}`);
  await saveGame(game);

  const left = MAX_QUESTIONS - d.questions;
  await message.reply({
    content: `${safe}\n-# 📁 ${left} question${left === 1 ? "" : "s"} left`,
    allowedMentions: { parse: [], repliedUser: false },
  });
  if (left <= 0) await reveal(client, botConfig, game, null, "out of questions");
  return true;
}
