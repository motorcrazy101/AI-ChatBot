import { Client, EmbedBuilder } from "discord.js";
import { CASES, shuffle, SUSPECTS, wardenFor } from "./asylum";
import { logBotPost } from "./chatLog";
import { EMBED_COLOR, Feature, FeatureContext, pick, replyPlain, truncate } from "./featureKit";
import { createGame, endGame, Game, getGame, saveGame } from "./gameState";
import { fetchGameChannel, guildOf, openThread, storyText } from "./storyKit";
import { BotConfig } from "./types";

/**
 * Asylum Mystery — a whodunit hosted by Aurora (she plays every suspect).
 *   "aurora start a mystery"
 *   "aurora ask Mimi where she was last night" / "aurora search the laundry room"
 *   "aurora case file" / "aurora start the vote" / "aurora give up on the mystery"
 */

const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
const VOTE_SECONDS = 120;

const SIGNATURES: Record<string, { item: string; hint: string }> = {
  Mimi: { item: "a sparkly pink hair ribbon", hint: "someone in a frilly costume" },
  Kaito: { item: "a crumpled energy-drink can", hint: "someone yawning and clutching a game controller" },
  "Nurse Mochi": { item: "a pink sticky note in very neat handwriting", hint: "someone in soft-soled nurse shoes" },
  Tanuki: { item: "muddy boot prints with leaves stuck in them", hint: "someone smelling of fresh soil" },
  Yuki: { item: "a page torn out of a notebook", hint: "someone scribbling in a notebook in the dark" },
  "Professor Bento": { item: "a lecture handout titled 'The 47 Types of Tsundere'", hint: "someone muttering about anime tropes" },
  "Auntie Udon": { item: "a ladle that smells faintly of broth", hint: "someone smelling of udon broth" },
  Ren: { item: "a cracked guitar pick", hint: "someone humming a rock song" },
};
const MOTIVES = [
  "wanted it for a secret cosplay project",
  "was getting revenge for an unfair timeout",
  "wanted to throw a secret midnight party",
  "was trying to impress someone special",
  "lost a bet and had no choice",
  "thought it would be the funniest prank of the year",
];
const ACTIVITIES = [
  "watching anime in the rec room", "reading manga in the library", "doing laundry", "sleeping (supposedly)",
  "practicing in the courtyard", "getting a snack in the cafeteria", "stargazing on the rooftop",
];

interface MysterySuspect {
  name: string;
  emoji: string;
  personality: string;
  alibi: string;
  saw: string;
}

export interface MysteryData {
  caseIndex: number;
  suspects: MysterySuspect[];
  culprit: number;
  motive: string;
  /** place -> clue text */
  clues: { place: string; text: string; real: boolean }[];
  found: number[];
  status: "investigating" | "voting";
  voteMessageId: string | null;
  questions: number;
}

const START = /\b(?:start|begin|play|new|open|solve)\s+(?:an?\s+|the\s+|another\s+)?(?:asylum\s+)?(?:murder\s+)?mystery\b/i;
const ASK = /\b(?:ask|question|interrogate|talk to|speak (?:to|with))\s+(.+?)(?:\s+(?:about|where|what|why|if|whether|did|who|when|how)\b(.*)|[,:]\s*(.*)|\?\s*$|$)/i;
const SEARCH = /\b(?:search|investigate|check|inspect|look (?:in|around|at|through))\s+(?:the\s+)?(.+?)[?.!]*$/i;
const CASE_FILE = /\b(?:case file|clues so far|the clues|our clues|evidence|list (?:the )?suspects|who are the suspects)\b/i;
const VOTE = /\b(?:start the vote|vote now|time to vote|let'?s vote|i accuse|we accuse|accuse)\b/i;
const GIVE_UP = /\b(?:give up|end|stop)\s+(?:on\s+)?(?:the\s+)?mystery\b|\bsolve it for us\b/i;

function caseOf(data: MysteryData) {
  return CASES[data.caseIndex] ?? CASES[0];
}

function newMystery(): MysteryData {
  const caseIndex = Math.floor(Math.random() * CASES.length);
  const c = CASES[caseIndex];
  const cast = shuffle(SUSPECTS).slice(0, 4);
  const culprit = Math.floor(Math.random() * cast.length);
  const crimePlace = c.places[0];
  const places = shuffle(c.places);

  const suspects: MysterySuspect[] = cast.map((s, i) => {
    const activity = pick(ACTIVITIES);
    const other = cast[(i + 1) % cast.length];
    return {
      ...s,
      alibi: i === culprit ? `claims they were ${activity} all night (a LIE — they were near ${crimePlace})` : `was ${activity}`,
      saw:
        i === culprit
          ? "will try to blame someone else, but slips up if pressed"
          : i === (culprit + 1) % cast.length
            ? `saw ${SIGNATURES[cast[culprit].name]?.hint ?? "someone suspicious"} near ${crimePlace} around midnight`
            : `noticed ${other.name} acting a little weird (but ${other.name === cast[culprit].name ? "that's important" : "it's nothing"})`,
    };
  });

  const culpritSig = SIGNATURES[cast[culprit].name];
  const herring = cast[(culprit + 2) % cast.length];
  const clues = [
    { text: `${culpritSig?.item ?? "a strange clue"} was found at the scene`, real: true },
    { text: `a witness remembers ${culpritSig?.hint ?? "someone suspicious"} sneaking around after lights-out`, real: true },
    { text: `the sign-in sheet shows nobody was actually ${suspects[culprit].alibi.split(" (")[0].replace(/^claims they were /, "")}`, real: true },
    { text: `${SIGNATURES[herring.name]?.item ?? "an odd object"} — but it looks like it's been here for days`, real: false },
  ];
  return {
    caseIndex,
    suspects,
    culprit,
    motive: pick(MOTIVES),
    clues: clues.map((cl, i) => ({ ...cl, place: places[i % places.length] })),
    found: [],
    status: "investigating",
    voteMessageId: null,
    questions: 0,
  };
}

function caseFile(data: MysteryData, title: string): EmbedBuilder {
  const c = caseOf(data);
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`🕵️ ${title}`)
    .setDescription(
      `**The crime:** ${c.crime}.\n\n` +
        `**Suspects:**\n${data.suspects.map((s, i) => `${NUMBER_EMOJIS[i]} ${s.emoji} **${s.name}** — ${s.personality}`).join("\n")}\n\n` +
        `**Places to search:** ${c.places.join(", ")}\n\n` +
        `**Clues found:** ${data.found.length ? data.found.map((i) => `\n🔎 ${data.clues[i].text} (${data.clues[i].place})`).join("") : "none yet"}`
    )
    .setFooter({ text: "ask <suspect> … · search <place> · case file · start the vote" });
}

function findSuspect(data: MysteryData, text: string): number {
  const t = text.toLowerCase();
  return data.suspects.findIndex(
    (s) => t.includes(s.name.toLowerCase()) || s.name.toLowerCase().split(" ").some((part) => part.length > 2 && t.includes(part))
  );
}

async function reveal(client: Client<true>, botConfig: BotConfig, game: Game<MysteryData>, votedFor: number | null): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  await endGame(game);
  if (!channel) return;
  const data = game.data;
  const culprit = data.suspects[data.culprit];
  const warden = wardenFor(botConfig.id, guildOf(channel));
  const correct = votedFor === data.culprit;
  const outcome =
    votedFor === null
      ? "The residents gave up."
      : correct
        ? `The residents correctly accused ${culprit.name}!`
        : `The residents accused ${data.suspects[votedFor].name}, but they were WRONG.`;
  const text = await storyText(
    client,
    botConfig,
    channel,
    guildOf(channel),
    `Narrate the dramatic reveal of the Asylum mystery "${caseOf(data).title}" in under 120 words. ${outcome} ` +
      `${warden.name} (the Warden) arrives and reveals the truth: the culprit was ${culprit.name}, who ${data.motive}. ` +
      `${correct ? "Celebrate the detectives." : "Tease the residents a little."}`,
    1500
  );
  const embed = new EmbedBuilder()
    .setColor(correct ? 0x3ba55d : 0xed4245)
    .setTitle(`${correct ? "✅ Case solved!" : votedFor === null ? "📁 Case closed" : "❌ Wrong suspect!"} — ${caseOf(data).title}`)
    .setDescription(truncate(text ?? `It was ${culprit.name} all along! They ${data.motive}.`, 3500))
    .addFields({ name: "The culprit", value: `${culprit.emoji} **${culprit.name}** — ${data.motive}` });
  const sent = await channel.send({ embeds: [embed] });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
}

/** Called when the vote timer ends. */
export async function resolveMysteryVote(client: Client<true>, botConfig: BotConfig, game: Game<MysteryData>): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  let votedFor: number | null = null;
  if (channel && game.data.voteMessageId) {
    const message = await channel.messages.fetch(game.data.voteMessageId).catch(() => null);
    if (message) {
      const counts = game.data.suspects.map((_, i) => {
        const r = message.reactions.cache.get(NUMBER_EMOJIS[i]);
        return Math.max(0, (r?.count ?? 0) - (r?.me ? 1 : 0));
      });
      const best = Math.max(...counts);
      if (best > 0) votedFor = pick(counts.map((c, i) => (c === best ? i : -1)).filter((i) => i >= 0));
    }
  }
  await reveal(client, botConfig, game, votedFor);
}

export const mysteryFeature: Feature = async (ctx: FeatureContext) => {
  if (START.test(ctx.text)) {
    const existing = await getGame(ctx.botConfig.id, ctx.channel.id);
    if (existing) {
      await replyPlain(ctx, `There's already a ${existing.kind} going on here! End it first.`);
      return true;
    }
    const data = newMystery();
    const c = caseOf(data);
    const intro = await ctx.message.reply({
      content: `🕵️ **${c.title}** — a new Asylum Mystery has begun!`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    const channel = await openThread(intro, `🕵️ ${c.title}`);
    const game = await createGame(ctx.botConfig.id, channel.id, "mystery", data, null);
    const warden = wardenFor(ctx.botConfig.id, guildOf(channel));
    const opening = await storyText(
      ctx.client,
      ctx.botConfig,
      channel,
      guildOf(channel),
      `Open a whodunit in under 100 words: ${c.crime}. ${warden.name} (the Warden) is furious and has ordered the residents ` +
        `to find the culprit. Introduce the four suspects briefly: ${data.suspects.map((s) => `${s.name} (${s.personality})`).join("; ")}. ` +
        "Don't hint who did it.",
      1500
    );
    const embed = caseFile(data, c.title);
    const sent = await channel.send({ content: truncate(opening ?? `Something terrible has happened: ${c.crime}!`, 1900), embeds: [embed] });
    logBotPost(ctx.botConfig.id, ctx.botName, sent, "game");
    return true;
  }

  const game = await getGame<MysteryData>(ctx.botConfig.id, ctx.channel.id);
  if (!game || game.kind !== "mystery") return false;
  const data = game.data;

  if (GIVE_UP.test(ctx.text)) {
    await reveal(ctx.client, ctx.botConfig, game, null);
    return true;
  }

  if (CASE_FILE.test(ctx.text)) {
    await replyPlain(ctx, "", caseFile(data, `Case file: ${caseOf(data).title}`));
    return true;
  }

  if (VOTE.test(ctx.text)) {
    if (data.status === "voting") {
      await replyPlain(ctx, "The vote is already open — react with the suspect's number!");
      return true;
    }
    const ends = new Date(Date.now() + VOTE_SECONDS * 1000);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("⚖️ Who did it? Vote now!")
      .setDescription(
        `${data.suspects.map((s, i) => `${NUMBER_EMOJIS[i]} ${s.emoji} ${s.name}`).join("\n")}\n\nVoting ends <t:${Math.floor(ends.getTime() / 1000)}:R>.`
      );
    const sent = await ctx.channel.send({ embeds: [embed] });
    for (let i = 0; i < data.suspects.length; i++) await sent.react(NUMBER_EMOJIS[i]).catch(() => undefined);
    data.status = "voting";
    data.voteMessageId = sent.id;
    game.deadline = ends;
    await saveGame(game);
    return true;
  }

  const ask = ctx.text.match(ASK);
  if (ask) {
    const idx = findSuspect(data, ask[1]);
    if (idx === -1) {
      await replyPlain(ctx, `Who? The suspects are ${data.suspects.map((s) => s.name).join(", ")}.`);
      return true;
    }
    const s = data.suspects[idx];
    const question = ctx.text.trim();
    const isCulprit = idx === data.culprit;
    const answer = await storyText(
      ctx.client,
      ctx.botConfig,
      ctx.channel,
      guildOf(ctx.channel),
      `In this mystery (${caseOf(data).crime}), play the suspect ${s.name} — ${s.personality}. ${ctx.user.name} asks them: "${question}". ` +
        `Secret info for ${s.name}: they ${s.alibi}; they ${s.saw}. ` +
        (isCulprit
          ? "They are the culprit: lie and act innocent, but let one small suspicious detail slip."
          : "They're innocent: answer honestly in character.") +
        ` Reply ONLY as ${s.name}, in character, under 60 words. Never state outright who the culprit is.`,
      700
    );
    data.questions++;
    await saveGame(game);
    await replyPlain(ctx, `${s.emoji} **${s.name}:** ${answer ?? "*shrugs nervously* I-I don't know anything!"}`);
    return true;
  }

  const search = ctx.text.match(SEARCH);
  if (search) {
    const where = search[1].toLowerCase();
    const c = caseOf(data);
    const place = c.places.find((p) => p.split(" ").filter((w) => w.length > 3 && w !== "the").some((w) => where.includes(w)));
    if (!place) {
      await replyPlain(ctx, `You can search: ${c.places.join(", ")}.`);
      return true;
    }
    const clueIdx = data.clues.findIndex((cl, i) => cl.place === place && !data.found.includes(i));
    if (clueIdx === -1) {
      await replyPlain(ctx, `🔎 You search ${place}… but there's nothing new here.`);
      return true;
    }
    data.found.push(clueIdx);
    await saveGame(game);
    const clue = data.clues[clueIdx];
    const narration = await storyText(
      ctx.client,
      ctx.botConfig,
      ctx.channel,
      guildOf(ctx.channel),
      `${ctx.user.name} searches ${place} and finds a clue: ${clue.text}. Narrate the discovery in character in under 50 words. Don't say who it points to.`,
      600
    );
    const embed = new EmbedBuilder().setColor(0xffb020).setDescription(`🔎 **Clue found in ${place}:** ${clue.text}`);
    await replyPlain(ctx, narration ?? "Ooh, look at this…", embed);
    return true;
  }

  return false;
};
