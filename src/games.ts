import axios from "axios";
import { Client, EmbedBuilder, Message } from "discord.js";
import { addAffection } from "./affection";
import { logBotPost } from "./chatLog";
import { EMBED_COLOR, Feature, pick, replyInCharacter, replyPlain } from "./featureKit";
import { generateReply, ReplyChannel } from "./respond";
import { BotConfig } from "./types";

/** Mini-games: trivia, would-you-rather, truth or dare and the magic 8-ball. */

// ---------- 8-ball ----------

const EIGHT_BALL = /\b(?:magic\s*)?8\s*-?\s*ball\b[\s,:]*(.*)$/i;
const EIGHT_BALL_ANSWERS = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.",
  "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.",
  "Signs point to yes.", "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
  "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.",
  "My sources say no.", "Outlook not so good.", "Very doubtful.",
];

const eightBall: Feature = async (ctx) => {
  const match = ctx.text.match(EIGHT_BALL);
  if (!match) return false;
  const question = match[1].trim();
  if (!question) {
    await replyPlain(ctx, "🎱 Ask it a question! Like: *8ball will I pass my test?*");
    return true;
  }
  const answer = pick(EIGHT_BALL_ANSWERS);
  const embed = new EmbedBuilder()
    .setColor(0x111111)
    .setTitle("🎱 Magic 8-Ball")
    .addFields({ name: "Question", value: question.slice(0, 1000) }, { name: "Answer", value: `**${answer}**` });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked the magic 8-ball "${question}". You shook it and it said "${answer}". ` +
      "Reveal the answer dramatically in character in 1-2 sentences, keeping the 8-ball's answer exactly the same.",
    { embed, fallback: "*shakes the 8-ball*", logExtra: `[8ball] ${answer}` }
  );
  return true;
};

// ---------- would you rather ----------

const WOULD_YOU_RATHER = /\b(?:would you rather|wyr)\b/i;
const WYR_QUESTIONS: [string, string][] = [
  ["be able to fly", "be invisible"],
  ["live in an anime world", "have one anime power in the real world"],
  ["never use social media again", "never watch another movie or show"],
  ["have unlimited pizza", "have unlimited sushi"],
  ["always be 10 minutes late", "always be 20 minutes early"],
  ["talk to animals", "speak every human language"],
  ["live without music", "live without video games"],
  ["be a famous streamer", "be a famous musician"],
  ["have a pet dragon", "have a pet phoenix"],
  ["only eat sweet food", "only eat salty food"],
  ["be stuck in a horror movie", "be stuck in a romance movie"],
  ["know the ending of every show", "never be able to finish a show"],
  ["always have to sing instead of talk", "always have to dance when you walk"],
  ["live by the beach", "live in the mountains"],
  ["have super speed", "have super strength"],
  ["be the funniest person in the room", "be the smartest person in the room"],
  ["give up coffee forever", "give up chocolate forever"],
  ["explore space", "explore the deep ocean"],
  ["have a rewind button for your life", "have a pause button for your life"],
  ["fight one horse-sized duck", "fight a hundred duck-sized horses"],
  ["read minds", "see the future"],
  ["be a wizard", "be a superhero"],
  ["always say what you think", "never speak again"],
  ["time travel to the past", "time travel to the future"],
  ["be a cat", "be a dog"],
  ["have no internet for a month", "have no phone for a month"],
  ["be the main character", "be the cool side character"],
  ["live in a big city", "live in a cozy small town"],
  ["win the lottery", "live twice as long"],
  ["have a personal chef", "have a personal driver"],
  ["only watch anime", "never watch anime again"],
  ["be able to teleport", "be able to stop time"],
  ["sleep in a treehouse", "sleep in a castle"],
  ["have glowing hair", "have glowing eyes"],
  ["know every language", "play every instrument"],
  ["be a famous voice actor", "be a famous mangaka"],
  ["live without snacks", "live without naps"],
  ["host a game show", "be a contestant on one"],
  ["be a vampire", "be a werewolf"],
  ["have a theme song that plays when you walk in", "have a laugh track for everything you say"],
];

const wouldYouRather: Feature = async (ctx) => {
  // "would you rather X or Y?" is them asking HER — let normal chat answer that.
  if (!WOULD_YOU_RATHER.test(ctx.text) || /\bor\b/i.test(ctx.text.replace(WOULD_YOU_RATHER, ""))) return false;
  const [a, b] = pick(WYR_QUESTIONS);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("🤔 Would you rather...")
    .setDescription(`🅰️ ${a}\n\n**— or —**\n\n🅱️ ${b}`)
    .setFooter({ text: "Vote with 🅰️ or 🅱️" });
  const sent = await replyInCharacter(
    ctx,
    `${ctx.user.name} wants to play would-you-rather. The question is: would you rather ${a}, or ${b}? ` +
      "Ask it in character in 1-2 sentences and say which one you'd pick.",
    { embed, fallback: "Ooh, okay, here's one!", logExtra: `[would you rather] ${a} OR ${b}` }
  );
  await sent.react("🅰️").catch(() => undefined);
  await sent.react("🅱️").catch(() => undefined);
  return true;
};

// ---------- truth or dare ----------

const TRUTH_OR_DARE = /^(?:(?:let'?s )?play |i (?:pick|choose|want|say) |give me an? |gimme an? |(?:another|new) )?(truth or dare|truth|dare)(?: please| pls)?[\s?!.]*$/i;
const TRUTHS = [
  "What's the most embarrassing thing you've ever said to a crush?",
  "What's a show or anime you secretly love but would never admit to?",
  "What's the weirdest thing you've ever eaten?",
  "Who in this server would you call first in a zombie apocalypse?",
  "What's the last thing you searched on your phone?",
  "What's a habit you have that nobody knows about?",
  "What's the most childish thing you still do?",
  "What's your most embarrassing nickname?",
  "What's the biggest lie you've told to get out of plans?",
  "If you could swap lives with anyone in this server for a day, who would it be?",
  "What's your guilty-pleasure song?",
  "What's the dumbest way you've ever hurt yourself?",
  "What's something you pretended to understand but didn't?",
  "Who was your first fictional crush?",
  "What's the longest you've gone without showering?",
  "What's the most cringe thing you posted online?",
  "What's a weird fear you have?",
  "What's the worst gift you've ever received?",
  "What's the pettiest thing you've ever done?",
  "What's one thing you'd change about yourself if you could?",
  "What's the most trouble you got into as a kid?",
  "What's your most-used emoji and why?",
  "Have you ever fallen asleep somewhere really awkward?",
  "What's the strangest dream you remember?",
  "What's a secret talent you have?",
  "What's the last thing that made you cry?",
  "Which character are you most like, honestly?",
  "What's your worst cooking disaster?",
  "What's the most money you've spent on something useless?",
  "What's something you're proud of that you never get to brag about?",
];
const DARES = [
  "Change your nickname to something the next person picks for 1 hour.",
  "Send the 5th picture in your camera roll (keep it appropriate!).",
  "Type your next three messages with your eyes closed.",
  "Talk like a pirate for the next 10 minutes.",
  "Give a dramatic anime-villain monologue in chat.",
  "Compliment every person who's been active in chat today.",
  "Use only emojis for your next 5 messages.",
  "Share your most-played song right now.",
  "Write a short poem about the person above you.",
  "Change your status to something embarrassing for 30 minutes.",
  "Describe your day as if it were an anime opening.",
  "Do your best impression of another server member (in text).",
  "Send a voice message singing one line of any song.",
  "Tell a joke — and it has to be terrible.",
  "Let someone pick your profile picture for an hour.",
  "Confess your love to a random object near you, in chat.",
  "Write a one-sentence horror story.",
  "Reply to the next 3 messages with only 'uwu'.",
  "Rate everyone's profile picture out of 10.",
  "Speak in third person for the next 10 minutes.",
  "Post the last meme you saved.",
  "Make up a new word and use it in a sentence.",
  "Describe your crush using only food emojis (no names!).",
  "Hype up the next person who talks like they just won a championship.",
  "Write a fake movie title about your life.",
  "Start every message with 'Ladies and gentlemen' for 10 minutes.",
  "Tell everyone your most unpopular opinion.",
  "Draw something with your eyes closed and post it.",
  "Name your top 3 anime characters and defend your picks.",
  "Do 10 jumping jacks and report back.",
];

const truthOrDare: Feature = async (ctx) => {
  const match = ctx.text.match(TRUTH_OR_DARE);
  if (!match) return false;
  const choice = match[1].toLowerCase() === "truth or dare" ? pick(["truth", "dare"]) : match[1].toLowerCase();
  const prompt = choice === "truth" ? pick(TRUTHS) : pick(DARES);
  const embed = new EmbedBuilder()
    .setColor(choice === "truth" ? 0x4a8cff : 0xff4a6d)
    .setTitle(choice === "truth" ? "🫣 Truth" : "😈 Dare")
    .setDescription(prompt);
  await replyInCharacter(
    ctx,
    `You're playing truth or dare with ${ctx.user.name} and it's a ${choice}: "${prompt}". ` +
      "Give it to them in character in 1-2 sentences, keeping the question/dare the same.",
    { embed, fallback: choice === "truth" ? "Truth it is!" : "Dare it is! 😈", logExtra: `[${choice}] ${prompt}` }
  );
  return true;
};

// ---------- trivia ----------

const TRIVIA_START =
  /\b(?:let'?s play|play|start|do|another|new|give (?:me|us) an?|ask (?:me|us) an?|one more)\s+(?:an?\s+)?(?:anime\s+|manga\s+)?trivia\b|\btrivia (?:time|question|game)\b|\bquiz (?:me|us)\b|\bquiz time\b|^(?:anime\s+|manga\s+)?trivia[\s?!.]*$/i;
const TRIVIA_SECONDS = 30;
const LETTERS = ["A", "B", "C", "D"];
const ANIME_CATEGORY = 31; // Open Trivia DB: "Entertainment: Japanese Anime & Manga"

interface TriviaGame {
  botConfig: BotConfig;
  client: Client<true>;
  channel: ReplyChannel;
  botName: string;
  question: string;
  answer: string;
  answerLetter: string;
  guessed: Set<string>;
  timer: NodeJS.Timeout;
}

/** One trivia question at a time per channel. */
const activeTrivia = new Map<string, TriviaGame>();
let lastTriviaFetch = 0;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

async function fetchQuestion(anime: boolean): Promise<{ question: string; answer: string; options: string[]; category: string; difficulty: string } | null> {
  // Open Trivia DB allows one request every 5 seconds.
  const wait = 5_100 - (Date.now() - lastTriviaFetch);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastTriviaFetch = Date.now();

  const { data } = await axios.get("https://opentdb.com/api.php", {
    params: { amount: 1, type: "multiple", encode: "url3986", ...(anime ? { category: ANIME_CATEGORY } : {}) },
    timeout: 10_000,
  });
  const q = data?.response_code === 0 ? data.results?.[0] : null;
  if (!q) return null;
  const answer = decode(q.correct_answer);
  const options = [answer, ...q.incorrect_answers.map(decode)].sort(() => Math.random() - 0.5);
  return {
    question: decode(q.question),
    answer,
    options,
    category: decode(q.category),
    difficulty: decode(q.difficulty),
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function announce(game: TriviaGame, instruction: string, fallback: string): Promise<void> {
  let text = fallback;
  try {
    const reply = await generateReply(game.client, game.botConfig, game.channel, {
      username: "Server",
      text: `(${instruction})`,
    });
    if (reply) text = reply;
  } catch {
    // keep the fallback
  }
  const sent = await game.channel.send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
  logBotPost(game.botConfig.id, game.botName, sent, "game");
}

const triviaStart: Feature = async (ctx) => {
  if (!TRIVIA_START.test(ctx.text)) return false;
  if (activeTrivia.has(ctx.channel.id)) {
    await replyPlain(ctx, "There's already a trivia question going — answer that one first! 😤");
    return true;
  }

  const anime = /\banime|manga\b/i.test(ctx.text);
  const q = await fetchQuestion(anime).catch((err) => {
    console.warn("[trivia] Open Trivia DB failed:", (err as Error).message);
    return null;
  });
  if (!q) {
    await replyPlain(ctx, "My trivia cards got shuffled into the void 😵 Try again in a few seconds!");
    return true;
  }

  const answerLetter = LETTERS[q.options.indexOf(q.answer)];
  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle("🧠 Trivia time!")
    .setDescription(`**${q.question}**\n\n${q.options.map((o, i) => `**${LETTERS[i]})** ${o}`).join("\n")}`)
    .setFooter({ text: `${q.category} · ${q.difficulty} · Reply with A, B, C or D — ${TRIVIA_SECONDS} seconds!` });

  await replyInCharacter(
    ctx,
    `You're hosting a trivia question for the chat (don't reveal or hint at the answer): "${q.question}". ` +
      "Introduce it excitedly in character in one short sentence.",
    { embed, fallback: "Trivia time! 🧠", logExtra: `[trivia] ${q.question} (answer: ${q.answer})` }
  );

  const game: TriviaGame = {
    botConfig: ctx.botConfig,
    client: ctx.client,
    channel: ctx.channel,
    botName: ctx.botName,
    question: q.question,
    answer: q.answer,
    answerLetter,
    guessed: new Set(),
    timer: setTimeout(() => {
      if (activeTrivia.get(ctx.channel.id) !== game) return;
      activeTrivia.delete(ctx.channel.id);
      void announce(
        game,
        `Nobody got the trivia question "${q.question}" in time. The answer was ${answerLetter}) ${q.answer}. ` +
          "Announce it in character in 1-2 sentences.",
        `⏰ Time's up! The answer was **${answerLetter}) ${q.answer}**.`
      ).catch((err) => console.error("[trivia] Timeout message failed:", err));
    }, TRIVIA_SECONDS * 1000),
  };
  activeTrivia.set(ctx.channel.id, game);
  return true;
};

/**
 * Checks every message in a channel with an active trivia question.
 * Returns true if the message was a guess (so she doesn't also chat).
 */
export async function checkTriviaAnswer(message: Message, userName: string, botId: string): Promise<boolean> {
  const game = activeTrivia.get(message.channelId);
  if (!game || game.botConfig.id !== botId || message.author.bot) return false;

  const guess = message.cleanContent.trim();
  const letter = guess.match(/^\(?([a-d])\)?[.!]?$/i)?.[1]?.toUpperCase();
  const isAnswerText = normalize(guess) === normalize(game.answer);
  if (!letter && !isAnswerText) return false; // just chatting
  if (game.guessed.has(message.author.id)) return true; // one guess each

  game.guessed.add(message.author.id);
  const correct = isAnswerText || letter === game.answerLetter;
  if (!correct) {
    await message.react("❌").catch(() => undefined);
    return true;
  }

  clearTimeout(game.timer);
  activeTrivia.delete(message.channelId);
  await message.react("✅").catch(() => undefined);
  const change = await addAffection(game.botConfig.id, { id: message.author.id, name: userName }, "trivia");
  await announce(
    game,
    `${userName} got the trivia question right! The answer was ${game.answerLetter}) ${game.answer}. ` +
      "Congratulate them in character in 1-2 sentences.",
    `🎉 **${userName}** got it! The answer was **${game.answerLetter}) ${game.answer}**.`
  );
  if (change.after.level > change.before.level) {
    await game.channel
      .send({
        content: `${change.after.emoji} **${userName}** and **${game.botName}** are now **${change.after.name}s**!`,
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }
  return true;
}

export const gameFeatures: Feature[] = [eightBall, truthOrDare, wouldYouRather, triviaStart];

