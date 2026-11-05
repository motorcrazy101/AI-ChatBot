import { Client, EmbedBuilder, Message } from "discord.js";
import {
  CLASSES,
  findClass,
  findPack,
  PACKS,
  rollD20,
  rollResult,
  RollResult,
  StoryPack,
  TONE_GUIDE,
} from "./asylum";
import { logBotPost } from "./chatLog";
import { EMBED_COLOR, Feature, FeatureContext, pick, replyPlain, truncate } from "./featureKit";
import { createGame, endGame, Game, getCharacter, getGame, saveGame, setCharacter } from "./gameState";
import { ReplyChannel } from "./respond";
import { fetchGameChannel, guildOf, listWords, openThread, storyText } from "./storyKit";
import { BotConfig } from "./types";

/**
 * Choose-your-own-adventure in the Anime Asylum.
 *   "aurora start an adventure" (random pack) / "aurora start an adventure: haunted east wing"
 *   Members vote with 🇦 🇧 🇨 reactions (or by typing A/B/C); a d20 decides how it goes.
 *   "aurora pause the adventure" / "aurora continue the adventure" / "aurora end the adventure"
 *   "aurora adventure status" / "aurora adventure packs"
 *   Characters: "aurora create my character: Rin the Escape Artist" / "aurora my character"
 *   In DMs it's a solo adventure: just reply A, B or C.
 */

const OPTION_EMOJIS = ["🇦", "🇧", "🇨"];
const LETTERS = ["A", "B", "C"];
const DEFAULT_VOTE_SECONDS = 120;
const SCENES = 6;
const MAX_ENERGY = 5;

interface Choice {
  scene: number;
  option: string;
  roll: number;
  bonus: number;
  result: RollResult;
  effect: string;
}

export interface AdventureData {
  pack: string;
  mode: "group" | "solo";
  starterId: string;
  guildId: string | null;
  scene: number;
  energy: number;
  inventory: string[];
  log: Choice[];
  options: string[];
  messageId: string | null;
  /** userId -> option index (typed votes) */
  votes: Record<string, number>;
  status: "voting" | "paused";
  lastNarration: string;
  idleRounds: number;
  voteSeconds: number;
  /** Characters of everyone who has voted so far: userId -> "Rin the Escape Artist" */
  party: Record<string, string>;
}

const START =
  /\b(?:start|begin|play|run|launch|new|do)\s+(?:an?\s+|the\s+|another\s+)?(solo\s+)?(?:asylum\s+)?(?:text\s+)?(?:adventure|story|quest|campaign)\b[\s:,-]*(.*)$/i;
const PACK_LIST = /\b(?:adventure|story)\s+(?:packs|list|options)\b|\bwhat (?:adventures|stories) (?:are there|can we play)\b/i;
const END = /\b(?:end|stop|quit|cancel|finish)\s+(?:the\s+|this\s+|our\s+)?(?:adventure|story)\b/i;
const PAUSE = /\bpause\s+(?:the\s+|this\s+|our\s+)?(?:adventure|story)\b/i;
const CONTINUE = /\b(?:continue|resume|unpause)\s+(?:the\s+|this\s+|our\s+)?(?:adventure|story)\b/i;
const STATUS = /\b(?:adventure|story)\s+(?:status|info|stats)\b|\b(?:our|party)\s+(?:energy|inventory|items)\b/i;
const MAKE_CHARACTER = /\b(?:create|make|set|change|build)\s+(?:a\s+|my\s+)(?:asylum\s+)?character\b[\s:,-]*(.*)$/i;
const SHOW_CHARACTER = /\b(?:show|what'?s|whats|see|who'?s|whos)\s+my\s+character\b|^my character[?!.]*$/i;
const CLASS_LIST = /\b(?:character|resident)\s+classes\b|\bwhat classes\b/i;
const LETTER_VOTE = /^\s*(?:option\s*|choice\s*|i (?:pick|choose|vote)\s*)?\(?([abc])\)?[\s.!]*$/i;

const packOf = (data: AdventureData): StoryPack => PACKS.find((p) => p.key === data.pack) ?? PACKS[0];

// ---------- characters ----------

export function parseCharacter(text: string, fallbackName: string): { name: string; classKey: string; trait: string | null } | null {
  const cls = findClass(text);
  if (!cls) return null;
  const named = text.match(/\b(?:named|called|name is|name's|i'?m)\s+([A-Za-z][\w'-]{0,20})/i);
  const leading = text.match(/^([A-Z][\w'-]{0,20})\b/);
  let name = named?.[1] ?? leading?.[1] ?? fallbackName;
  if (findClass(name) || /^(the|a|an)$/i.test(name)) name = fallbackName;
  const trait = text.match(/\b(?:who|that|with|and)\s+(.{3,80})$/i)?.[1]?.replace(/[.!]+$/, "") ?? null;
  return { name, classKey: cls.key, trait };
}

function characterLabel(c: { name: string; classKey: string }): string {
  const cls = CLASSES.find((k) => k.key === c.classKey);
  return cls ? `${c.name} the ${cls.name}` : c.name;
}

async function characterFeature(ctx: FeatureContext): Promise<boolean> {
  if (CLASS_LIST.test(ctx.text)) {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("🏥 Asylum resident classes")
      .setDescription(CLASSES.map((c) => `${c.emoji} **${c.name}** — good at ${c.perk}`).join("\n"))
      .setFooter({ text: "Make yours: create my character: Rin the Escape Artist" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  if (SHOW_CHARACTER.test(ctx.text)) {
    const c = await getCharacter(ctx.botConfig.id, ctx.user.id);
    if (!c) {
      await replyPlain(ctx, "You don't have a character yet! Try: *create my character: Rin the Escape Artist*");
      return true;
    }
    const cls = CLASSES.find((k) => k.key === c.classKey);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${cls?.emoji ?? "🏥"} ${characterLabel(c)}`)
      .setDescription(`${cls ? `Good at ${cls.perk}.` : ""}${c.trait ? `\nTrait: ${c.trait}` : ""}`);
    await replyPlain(ctx, "", embed);
    return true;
  }

  const make = ctx.text.match(MAKE_CHARACTER);
  if (!make) return false;
  const parsed = parseCharacter(make[1] ?? "", ctx.user.name);
  if (!parsed) {
    await replyPlain(
      ctx,
      `Pick a class: ${CLASSES.map((c) => `${c.emoji} ${c.name}`).join(", ")}.\nExample: *create my character: Rin the Escape Artist who hoards pudding*`
    );
    return true;
  }
  await setCharacter(ctx.botConfig.id, ctx.user.id, parsed);
  const cls = CLASSES.find((k) => k.key === parsed.classKey)!;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${cls.emoji} New resident: ${characterLabel(parsed)}`)
    .setDescription(`Good at ${cls.perk} (+3 on rolls for matching choices).${parsed.trait ? `\nTrait: ${parsed.trait}` : ""}`);
  await replyPlain(ctx, "Welcome to the Asylum! 🏥", embed);
  return true;
}

// ---------- scenes ----------

/** Pulls "A) …", "B) …", "C) …" lines out of the narration. */
export function parseOptions(text: string): { narration: string; options: string[] } {
  const options: string[] = [];
  const keep: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]\s*)?(?:\*\*)?\s*[([]?([ABC1-3])[)\].:]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/i);
    if (m && options.length < 3) options.push(m[2].replace(/\*\*/g, "").trim());
    else keep.push(line);
  }
  return { narration: keep.join("\n").trim(), options };
}

const FALLBACK_OPTIONS = ["Sneak ahead carefully", "Search the area for something useful", "Cause a distraction"];

async function partyText(data: AdventureData, botId: string): Promise<string> {
  const names = Object.values(data.party);
  if (names.length) return listWords(names);
  const starter = await getCharacter(botId, data.starterId);
  return starter ? characterLabel(starter) : "a small group of residents";
}

async function postScene(
  client: Client<true>,
  botConfig: BotConfig,
  channel: ReplyChannel,
  game: Game<AdventureData>,
  happened: string | null
): Promise<void> {
  const data = game.data;
  const pack = packOf(data);
  const final = data.scene >= SCENES || data.energy <= 0;
  const party = await partyText(data, botConfig.id);

  const instruction = final
    ? `You're narrating the FINAL scene of the Asylum adventure "${pack.name}". ${pack.premise} Goal: ${pack.goal} ` +
      `${TONE_GUIDE[pack.tone]} Party: ${party}. ${happened ?? ""} ` +
      (data.energy <= 0
        ? "The party ran out of energy: the Warden catches them and hands out a legendary timeout. Make it a funny/dramatic bad ending."
        : "Give the story a satisfying ending where they reach the goal.") +
      " Narrate it in under 150 words. No choices."
    : `You're narrating scene ${data.scene} of ${SCENES} of the Asylum adventure "${pack.name}". ${pack.premise} ` +
      `Goal: ${pack.goal} ${TONE_GUIDE[pack.tone]} Party: ${party}. Energy ${data.energy}/${MAX_ENERGY}. ` +
      `Inventory: ${data.inventory.length ? data.inventory.join(", ") : "nothing yet"}. ` +
      `${happened ?? "This is the opening scene: set the mood and the first problem."} ` +
      "Narrate what happens next in under 120 words, then end with exactly three choices on separate lines, " +
      "formatted 'A) …', 'B) …', 'C) …' (each under 12 words).";

  const text = await storyText(client, botConfig, channel, guildOf(channel), instruction, 1800);
  const { narration, options } = parseOptions(text ?? "");
  data.lastNarration = narration || (final ? "And so the night ended…" : "The halls are quiet… too quiet.");

  if (final) {
    const won = data.energy > 0;
    const embed = new EmbedBuilder()
      .setColor(won ? 0x3ba55d : 0xed4245)
      .setTitle(`${pack.emoji} ${pack.name} — ${won ? "The End 🏁" : "Caught by the Warden! 🚨"}`)
      .setDescription(truncate(data.lastNarration, 4000))
      .setFooter({ text: `${data.log.length} choices · ⚡ ${Math.max(0, data.energy)}/${MAX_ENERGY} · 🎒 ${data.inventory.join(", ") || "empty"}` });
    const sent = await channel.send({ embeds: [embed] });
    logBotPost(botConfig.id, client.user.displayName, sent, "game");
    await endGame(game);
    return;
  }

  data.options = options.length >= 2 ? options.slice(0, 3) : FALLBACK_OPTIONS;
  data.votes = {};
  const solo = data.mode === "solo";
  const ends = new Date(Date.now() + data.voteSeconds * 1000);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${pack.emoji} ${pack.name} — Scene ${data.scene}/${SCENES}`)
    .setDescription(truncate(data.lastNarration, 3500))
    .addFields({
      name: solo ? "What do you do? (reply A, B or C)" : "What do we do?",
      value: data.options.map((o, i) => `${OPTION_EMOJIS[i]} ${o}`).join("\n"),
    })
    .setFooter({
      text:
        `⚡ Energy ${data.energy}/${MAX_ENERGY} · 🎒 ${data.inventory.join(", ") || "empty"}` +
        (solo ? "" : ` · vote with the reactions or type A/B/C`),
    });
  if (!solo) embed.addFields({ name: "Voting ends", value: `<t:${Math.floor(ends.getTime() / 1000)}:R>`, inline: true });

  const sent = await channel.send({ embeds: [embed] });
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
  if (!solo) for (let i = 0; i < data.options.length; i++) await sent.react(OPTION_EMOJIS[i]).catch(() => undefined);

  data.messageId = sent.id;
  data.status = "voting";
  game.deadline = solo ? null : ends;
  await saveGame(game);
}

/** Counts the votes (reactions + typed letters), rolls the dice and moves the story on. */
export async function resolveAdventure(client: Client<true>, botConfig: BotConfig, game: Game<AdventureData>): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  if (!channel) {
    await endGame(game);
    return;
  }
  const data = game.data;
  const tally = data.options.map(() => 0);
  const voters: Record<number, string[]> = {};

  for (const [userId, idx] of Object.entries(data.votes)) {
    if (idx < tally.length) {
      tally[idx]++;
      (voters[idx] ??= []).push(userId);
    }
  }
  if (data.mode === "group" && data.messageId) {
    const message = await channel.messages.fetch(data.messageId).catch(() => null);
    if (message) {
      for (let i = 0; i < data.options.length; i++) {
        const reaction = message.reactions.cache.get(OPTION_EMOJIS[i]);
        if (!reaction) continue;
        const users = await reaction.users.fetch().catch(() => null);
        for (const user of users?.values() ?? []) {
          if (user.bot || data.votes[user.id] !== undefined) continue;
          tally[i]++;
          (voters[i] ??= []).push(user.id);
        }
      }
    }
  }

  const total = tally.reduce((a, b) => a + b, 0);
  if (total === 0) {
    data.idleRounds++;
    if (data.idleRounds >= 2) {
      data.status = "paused";
      game.deadline = null;
      await saveGame(game);
      await channel.send("⏸️ Nobody voted, so the adventure is **paused**. Say *aurora continue the adventure* to pick it back up!");
      return;
    }
  } else {
    data.idleRounds = 0;
  }

  // Winner (ties and no-votes are decided by fate).
  const best = Math.max(...tally);
  const winners = tally.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  const chosen = pick(winners);
  const option = data.options[chosen];

  // Remember everyone who voted as part of the party.
  for (const userId of Object.values(voters).flat()) {
    if (data.party[userId]) continue;
    const c = await getCharacter(botConfig.id, userId);
    const member = channel.isDMBased() ? null : channel.guild.members.cache.get(userId);
    data.party[userId] = c ? characterLabel(c) : member?.displayName ?? "a resident";
  }

  // Dice: +3 if someone who picked this option has a class that's good at it.
  const natural = rollD20();
  let bonus = 0;
  let bonusBy = "";
  for (const userId of voters[chosen] ?? [data.starterId]) {
    const c = await getCharacter(botConfig.id, userId);
    const cls = c && CLASSES.find((k) => k.key === c.classKey);
    if (cls && cls.skills.some((s) => option.toLowerCase().includes(s))) {
      bonus = 3;
      bonusBy = `${c!.name} the ${cls.name}`;
      break;
    }
  }
  const result = rollResult(natural + bonus, natural);

  const pack = packOf(data);
  let effect = "";
  if (result === "critical fail") {
    data.energy -= 2;
    effect = "It goes horribly wrong (-2 energy).";
  } else if (result === "fail") {
    data.energy -= 1;
    effect = "It doesn't go well (-1 energy).";
  } else if (result === "mixed") {
    effect = "It sort of works, with a complication.";
  } else {
    const found = pack.items.filter((i) => !data.inventory.includes(i));
    const gotItem = found.length > 0 && (result === "critical success" || Math.random() < 0.45);
    if (gotItem) data.inventory.push(pick(found));
    if (result === "critical success") data.energy = Math.min(MAX_ENERGY, data.energy + 1);
    effect =
      (result === "critical success" ? "It goes perfectly (+1 energy)!" : "It works!") +
      (gotItem ? ` They found ${data.inventory[data.inventory.length - 1]}.` : "");
  }
  data.log.push({ scene: data.scene, option, roll: natural, bonus, result, effect });

  const rollLine =
    `🎲 **${LETTERS[chosen]}) ${option}** — rolled **${natural}**${bonus ? ` +${bonus} (${bonusBy})` : ""} → **${result}**` +
    `${total ? ` (${tally[chosen]} vote${tally[chosen] === 1 ? "" : "s"})` : " (nobody voted — fate decided)"}`;
  await channel.send({ content: rollLine, allowedMentions: { parse: [] } }).catch(() => undefined);

  data.scene++;
  const happened =
    `What just happened: the party chose "${option}" and rolled ${natural + bonus} on a d20 (${result}). ${effect}` +
    (bonusBy ? ` ${bonusBy}'s skills helped.` : "") +
    " Narrate that outcome first.";
  await postScene(client, botConfig, channel, game, happened);
}

// ---------- feature ----------

async function startAdventure(ctx: FeatureContext, rest: string, solo: boolean): Promise<void> {
  const existing = await getGame<AdventureData>(ctx.botConfig.id, ctx.channel.id);
  if (existing) {
    await replyPlain(ctx, `There's already a ${existing.kind} going on here! End it first.`);
    return;
  }
  const pack = findPack(rest) ?? pick(PACKS);
  const minutes = rest.match(/\b(\d{1,2})\s*(?:min|minute)s?\b/i);
  const voteSeconds = minutes ? Math.min(Math.max(Number(minutes[1]), 1), 30) * 60 : DEFAULT_VOTE_SECONDS;
  const mode: "group" | "solo" = solo || ctx.channel.isDMBased() ? "solo" : "group";

  const intro = await ctx.message.reply({
    content:
      `${pack.emoji} **${pack.name}** is starting!` +
      (mode === "group" ? " Everyone can vote on what happens next. 🎲" : " It's just you and me… reply A, B or C. 🎲"),
    allowedMentions: { parse: [], repliedUser: false },
  });
  const channel = mode === "group" ? await openThread(intro, `${pack.emoji} ${pack.name}`) : ctx.channel;

  const starterChar = await getCharacter(ctx.botConfig.id, ctx.user.id);
  const data: AdventureData = {
    pack: pack.key,
    mode,
    starterId: ctx.user.id,
    guildId: ctx.message.guildId,
    scene: 1,
    energy: MAX_ENERGY,
    inventory: [],
    log: [],
    options: [],
    messageId: null,
    votes: {},
    status: "voting",
    lastNarration: "",
    idleRounds: 0,
    voteSeconds,
    party: { [ctx.user.id]: starterChar ? characterLabel(starterChar) : ctx.user.name },
  };
  const game = await createGame(ctx.botConfig.id, channel.id, "adventure", data, null);
  await postScene(ctx.client, ctx.botConfig, channel, game, null);
}

export const adventureFeature: Feature = async (ctx) => {
  if (await characterFeature(ctx)) return true;

  if (PACK_LIST.test(ctx.text)) {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("🏥 Asylum adventures")
      .setDescription(PACKS.map((p) => `${p.emoji} **${p.name}** (${p.tone}) — ${p.premise}`).join("\n\n"))
      .setFooter({ text: "Start one: start an adventure: haunted east wing (or just 'start an adventure' for a surprise)" });
    await replyPlain(ctx, "", embed);
    return true;
  }

  const start = ctx.text.match(START);
  if (start) {
    await startAdventure(ctx, start[2] ?? "", !!start[1]);
    return true;
  }

  const isEnd = END.test(ctx.text);
  const isPause = PAUSE.test(ctx.text);
  const isContinue = CONTINUE.test(ctx.text);
  const isStatus = STATUS.test(ctx.text);
  if (!isEnd && !isPause && !isContinue && !isStatus) return false;

  const game = await getGame<AdventureData>(ctx.botConfig.id, ctx.channel.id);
  if (!game || game.kind !== "adventure") {
    await replyPlain(ctx, "There's no adventure running here. Start one with *start an adventure*!");
    return true;
  }
  const data = game.data;
  const pack = packOf(data);

  if (isEnd) {
    await endGame(game);
    await replyPlain(ctx, `🛑 **${pack.name}** has ended. Thanks for playing!`);
    return true;
  }
  if (isPause) {
    data.status = "paused";
    game.deadline = null;
    await saveGame(game);
    await replyPlain(ctx, "⏸️ Adventure paused. Say *aurora continue the adventure* whenever you're ready.");
    return true;
  }
  if (isStatus) {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${pack.emoji} ${pack.name} — Scene ${data.scene}/${SCENES}${data.status === "paused" ? " (paused)" : ""}`)
      .setDescription(
        `⚡ Energy: ${"⚡".repeat(Math.max(0, data.energy))}${"▫️".repeat(Math.max(0, MAX_ENERGY - data.energy))}\n` +
          `🎒 Inventory: ${data.inventory.join(", ") || "empty"}\n` +
          `👥 Party: ${Object.values(data.party).join(", ") || "—"}\n\n` +
          (data.log.length
            ? data.log.map((c) => `Scene ${c.scene}: ${c.option} — 🎲 ${c.roll}${c.bonus ? `+${c.bonus}` : ""} (${c.result})`).join("\n")
            : "No choices made yet.")
      );
    await replyPlain(ctx, "", embed);
    return true;
  }

  // continue: recap, then the current scene again
  if (data.status !== "paused") {
    await replyPlain(ctx, "The adventure is already running — vote on the choices above!");
    return true;
  }
  const recap = await storyText(
    ctx.client,
    ctx.botConfig,
    ctx.channel,
    guildOf(ctx.channel),
    `Give a short, dramatic "Previously, in the Asylum…" recap (under 80 words) of the adventure "${pack.name}". ` +
      `Choices so far: ${data.log.map((c) => `${c.option} (${c.result})`).join("; ") || "none yet"}. ` +
      `Last scene: ${truncate(data.lastNarration, 400)}`,
    900
  );
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("📼 Previously, in the Asylum…")
    .setDescription(recap ?? data.lastNarration);
  await ctx.channel.send({ embeds: [embed] });
  data.idleRounds = 0;
  await postScene(
    ctx.client,
    ctx.botConfig,
    ctx.channel,
    game,
    "The adventure resumes after a break: pick up exactly where the last scene left off."
  );
  return true;
};

/**
 * Typed votes ("A", "b", "option C") in a channel with an adventure.
 * Returns true if the message was a vote.
 */
export async function checkAdventureVote(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig,
  game: Game<AdventureData>
): Promise<boolean> {
  const match = message.content.match(LETTER_VOTE);
  if (!match || game.data.status !== "voting") return false;
  const idx = LETTERS.indexOf(match[1].toUpperCase());
  if (idx >= game.data.options.length) return false;

  if (game.data.mode === "solo") {
    if (message.author.id !== game.data.starterId) return false;
    game.data.votes = { [message.author.id]: idx };
    await resolveAdventure(client, botConfig, game);
    return true;
  }
  game.data.votes[message.author.id] = idx;
  await saveGame(game);
  await message.react("✅").catch(() => undefined);
  return true;
}
