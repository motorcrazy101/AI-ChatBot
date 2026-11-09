import axios from "axios";
import { EmbedBuilder, Message } from "discord.js";
import { EMBED_COLOR, Feature, FeatureContext, pick, replyInCharacter, replyPlain } from "./featureKit";
import { isOwner } from "./memory";
import { getSettings } from "./settings";

/**
 * Anime reaction GIFs (free, safe-for-work: nekos.best + waifu.pics).
 *
 *  Friendly  — anyone: "aurora hug @Lilly", "aurora pat me", "aurora dance", "aurora hug Lilly for me"
 *  Intimate  — kiss, peck, lick, bite: OFF unless the owner turns them on
 *  Mean      — slap, punch, kick, yeet, shoot: only the owner + people they grant;
 *              Aurora uses them herself ONLY when someone is mean to her.
 *
 * She also returns roleplay actions (*hugs aurora*) and sometimes adds a
 * reaction GIF to her chat replies.
 */

export type GifGroup = "friendly" | "intimate" | "mean";

export interface GifAction {
  key: string;
  group: GifGroup;
  /** nekos.best category, or waifu.pics category when `waifu` is set. */
  category: string;
  waifu?: boolean;
  /** waifu.pics category to fall back to if nekos.best is down. */
  backup?: string;
  /** True if it's done TO someone ("hugs Lilly"); false for reactions ("is laughing"). */
  targeted: boolean;
  /** "hugs" → "Aurora hugs Lilly" */
  verb: string;
  /** "is laughing" → "Aurora is laughing" (also used when there's no target) */
  self: string;
  emoji: string;
  /** Words people use to ask for it. */
  words: string[];
}

const A = (a: GifAction) => a;

export const ACTIONS: GifAction[] = [
  // ----- friendly, done to someone -----
  A({ key: "hug", group: "friendly", category: "hug", backup: "hug", targeted: true, verb: "hugs", self: "wants a hug", emoji: "🤗", words: ["hug", "hugs", "glomp"] }),
  A({ key: "pat", group: "friendly", category: "pat", backup: "pat", targeted: true, verb: "pats", self: "wants headpats", emoji: "🫳", words: ["pat", "pats", "headpat", "headpats", "pet"] }),
  A({ key: "poke", group: "friendly", category: "poke", backup: "poke", targeted: true, verb: "pokes", self: "is poking around", emoji: "👉", words: ["poke", "pokes"] }),
  A({ key: "cuddle", group: "friendly", category: "cuddle", backup: "cuddle", targeted: true, verb: "cuddles", self: "wants cuddles", emoji: "🥰", words: ["cuddle", "cuddles", "snuggle", "snuggles"] }),
  A({ key: "bonk", group: "friendly", category: "bonk", waifu: true, targeted: true, verb: "bonks", self: "is ready to bonk", emoji: "🔨", words: ["bonk", "bonks"] }),
  A({ key: "wave", group: "friendly", category: "wave", backup: "wave", targeted: true, verb: "waves at", self: "waves", emoji: "👋", words: ["wave", "waves", "wave at", "wave to"] }),
  A({ key: "highfive", group: "friendly", category: "highfive", backup: "highfive", targeted: true, verb: "high-fives", self: "wants a high five", emoji: "🙌", words: ["high five", "high-five", "highfive", "high fives"] }),
  A({ key: "handshake", group: "friendly", category: "handshake", targeted: true, verb: "shakes hands with", self: "offers a handshake", emoji: "🤝", words: ["handshake", "shake hands with", "shake hands"] }),
  A({ key: "handhold", group: "friendly", category: "handhold", backup: "handhold", targeted: true, verb: "holds hands with", self: "wants to hold hands", emoji: "🫱", words: ["hold hands with", "hold hands", "handhold", "hold hand"] }),
  A({ key: "feed", group: "friendly", category: "feed", targeted: true, verb: "feeds", self: "is sharing snacks", emoji: "🍙", words: ["feed", "feeds"] }),
  A({ key: "tickle", group: "friendly", category: "tickle", targeted: true, verb: "tickles", self: "is feeling ticklish", emoji: "🤭", words: ["tickle", "tickles"] }),
  A({ key: "wink", group: "friendly", category: "wink", backup: "wink", targeted: true, verb: "winks at", self: "winks", emoji: "😉", words: ["wink", "winks", "wink at"] }),
  A({ key: "baka", group: "friendly", category: "baka", targeted: true, verb: "calls out", self: "says BAKA!", emoji: "😜", words: ["baka", "call baka"] }),
  A({ key: "stare", group: "friendly", category: "stare", targeted: true, verb: "stares at", self: "is staring", emoji: "👀", words: ["stare", "stare at", "stares at"] }),
  A({ key: "thumbsup", group: "friendly", category: "thumbsup", targeted: true, verb: "gives a thumbs up to", self: "gives a thumbs up", emoji: "👍", words: ["thumbs up", "thumbsup"] }),

  // ----- friendly reactions -----
  A({ key: "nom", group: "friendly", category: "nom", backup: "nom", targeted: false, verb: "noms on snacks with", self: "is nomming", emoji: "😋", words: ["nom", "eat", "noms"] }),
  A({ key: "run", group: "friendly", category: "run", targeted: false, verb: "runs from", self: "is running away", emoji: "🏃", words: ["run", "run away"] }),
  A({ key: "lurk", group: "friendly", category: "lurk", targeted: false, verb: "lurks behind", self: "is lurking", emoji: "🫥", words: ["lurk"] }),
  A({ key: "cry", group: "friendly", category: "cry", backup: "cry", targeted: false, verb: "cries on", self: "is crying", emoji: "😭", words: ["cry"] }),
  A({ key: "blush", group: "friendly", category: "blush", backup: "blush", targeted: false, verb: "blushes at", self: "is blushing", emoji: "😳", words: ["blush"] }),
  A({ key: "laugh", group: "friendly", category: "laugh", targeted: false, verb: "laughs at", self: "is laughing", emoji: "😂", words: ["laugh", "laugh at"] }),
  A({ key: "dance", group: "friendly", category: "dance", backup: "dance", targeted: false, verb: "dances with", self: "is dancing", emoji: "💃", words: ["dance", "dance with"] }),
  A({ key: "happy", group: "friendly", category: "happy", backup: "happy", targeted: false, verb: "is happy with", self: "is happy", emoji: "😊", words: ["happy", "be happy"] }),
  A({ key: "sleep", group: "friendly", category: "sleep", targeted: false, verb: "falls asleep on", self: "is sleeping", emoji: "😴", words: ["sleep", "go to sleep", "nap"] }),
  A({ key: "smug", group: "friendly", category: "smug", backup: "smug", targeted: false, verb: "looks smug at", self: "is feeling smug", emoji: "😏", words: ["smug", "be smug"] }),
  A({ key: "smile", group: "friendly", category: "smile", backup: "smile", targeted: false, verb: "smiles at", self: "is smiling", emoji: "😊", words: ["smile", "smile at"] }),
  A({ key: "facepalm", group: "friendly", category: "facepalm", targeted: false, verb: "facepalms at", self: "facepalms", emoji: "🤦", words: ["facepalm"] }),
  A({ key: "shrug", group: "friendly", category: "shrug", targeted: false, verb: "shrugs at", self: "shrugs", emoji: "🤷", words: ["shrug"] }),
  A({ key: "bored", group: "friendly", category: "bored", targeted: false, verb: "is bored of", self: "is bored", emoji: "🙄", words: ["bored", "be bored"] }),
  A({ key: "yawn", group: "friendly", category: "yawn", targeted: false, verb: "yawns at", self: "is yawning", emoji: "🥱", words: ["yawn"] }),
  A({ key: "think", group: "friendly", category: "think", targeted: false, verb: "thinks about", self: "is thinking", emoji: "🤔", words: ["think"] }),
  A({ key: "pout", group: "friendly", category: "pout", targeted: false, verb: "pouts at", self: "is pouting", emoji: "😤", words: ["pout", "pout at"] }),
  A({ key: "nope", group: "friendly", category: "nope", targeted: false, verb: "says nope to", self: "says nope", emoji: "🙅", words: ["nope"] }),
  A({ key: "nod", group: "friendly", category: "nod", targeted: false, verb: "nods at", self: "nods", emoji: "🙆", words: ["nod", "nod at"] }),

  // ----- intimate (off by default) -----
  A({ key: "kiss", group: "intimate", category: "kiss", backup: "kiss", targeted: true, verb: "kisses", self: "blows a kiss", emoji: "💋", words: ["kiss", "kisses", "smooch"] }),
  A({ key: "peck", group: "intimate", category: "peck", targeted: true, verb: "gives a little peck to", self: "gives a little peck", emoji: "😚", words: ["peck", "pecks"] }),
  A({ key: "lick", group: "intimate", category: "lick", waifu: true, targeted: true, verb: "licks", self: "licks", emoji: "👅", words: ["lick", "licks"] }),
  A({ key: "bite", group: "intimate", category: "bite", backup: "bite", targeted: true, verb: "bites", self: "bites", emoji: "🦷", words: ["bite", "bites", "nibble"] }),

  // ----- mean (owner + granted only; Aurora only in self-defense) -----
  A({ key: "slap", group: "mean", category: "slap", backup: "slap", targeted: true, verb: "slaps", self: "slaps the air", emoji: "👋", words: ["slap", "slaps", "smack"] }),
  A({ key: "punch", group: "mean", category: "punch", targeted: true, verb: "punches", self: "throws a punch", emoji: "👊", words: ["punch", "punches"] }),
  A({ key: "kick", group: "mean", category: "kick", backup: "kick", targeted: true, verb: "kicks", self: "kicks the air", emoji: "🦵", words: ["kick", "kicks"] }),
  A({ key: "yeet", group: "mean", category: "yeet", backup: "yeet", targeted: true, verb: "yeets", self: "yeets something", emoji: "🌀", words: ["yeet", "yeets"] }),
  A({ key: "shoot", group: "mean", category: "shoot", targeted: true, verb: "finger-guns", self: "goes pew pew", emoji: "🔫", words: ["shoot", "shoots", "pew pew at"] }),
];

export const actionByKey = (key: string) => ACTIONS.find((a) => a.key === key);

/** Every word form, longest first so "hold hands with" beats "hold hands". */
const WORD_INDEX: { word: string; action: GifAction }[] = ACTIONS.flatMap((action) =>
  action.words.map((word) => ({ word, action }))
).sort((a, b) => b.word.length - a.word.length);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- fetching GIFs ----------

export interface Gif {
  url: string;
  credit?: string;
}

export async function fetchGif(action: GifAction): Promise<Gif | null> {
  const nekos = async () => {
    const { data } = await axios.get(`https://nekos.best/api/v2/${action.category}`, { timeout: 8_000 });
    const r = data?.results?.[0];
    return r?.url ? { url: r.url as string, credit: r.anime_name ? `From ${r.anime_name}` : undefined } : null;
  };
  const waifu = async (category: string) => {
    const { data } = await axios.get(`https://api.waifu.pics/sfw/${category}`, { timeout: 8_000 });
    return data?.url ? { url: data.url as string } : null;
  };
  try {
    return action.waifu ? await waifu(action.category) : await nekos();
  } catch (err) {
    console.warn(`[gifs] ${action.key} GIF failed (${(err as Error).message})`);
    if (!action.waifu && action.backup) return waifu(action.backup).catch(() => null);
    return null;
  }
}

export function gifEmbed(action: GifAction, actor: string, target: string | null, gif: Gif): EmbedBuilder {
  const title = target ? `${actor} ${action.verb} ${target}! ${action.emoji}` : `${actor} ${action.self} ${action.emoji}`;
  const embed = new EmbedBuilder()
    .setColor(action.group === "mean" ? 0xed4245 : action.group === "intimate" ? 0xff7ab6 : EMBED_COLOR)
    .setTitle(title.slice(0, 256))
    .setImage(gif.url);
  if (gif.credit) embed.setFooter({ text: gif.credit.slice(0, 200) });
  return embed;
}

// ---------- permissions ----------

export function canUseMean(botId: string, userId: string): boolean {
  return isOwner(botId, userId) || getSettings(botId).gifs.meanAccess.includes(userId);
}

export function groupAllowed(botId: string, action: GifAction): boolean {
  if (action.group === "intimate") return getSettings(botId).gifs.intimate;
  return true;
}

// ---------- commands: "aurora hug @Lilly" ----------

export interface GifCommand {
  action: GifAction;
  /** Raw target text ("@Lilly", "me", "douche"), or null for "aurora dance". */
  target: string | null;
  /** "aurora hug Lilly for me" → the person asking does it. */
  forMe: boolean;
}

const POLITE = /^(?:please\s+|pls\s+|can you\s+|could you\s+|would you\s+|go\s+|now\s+)+/i;
const FOR_ME = /\s+(?:for me|from me|for us|from us)$/i;

export function parseGifCommand(text: string): GifCommand | null {
  let t = text
    .trim()
    .replace(/[\s.!?~]+$/, "")
    .replace(/\s+(?:please|pls|plz|rn|now)$/i, "")
    .replace(POLITE, "");

  // "give Lilly a hug" / "give me a high five"
  const give = t.match(/^give\s+(.+?)\s+(?:a|an|some|big|little|\s)+(hug|pat|headpat|cuddle|high five|high-five|highfive|bonk|poke|handshake|kiss|peck|tickle|thumbs up|wink|slap|punch|kick)s?$/i);
  if (give) {
    const entry = WORD_INDEX.find((w) => w.word.toLowerCase() === give[2].toLowerCase());
    if (entry) t = `${entry.word} ${give[1]}`;
  }

  const forMe = FOR_ME.test(t);
  t = t.replace(FOR_ME, "").trim();

  for (const { word, action } of WORD_INDEX) {
    const m = t.match(new RegExp(`^${escapeRegex(word)}(?:\\s+(.*))?$`, "i"));
    if (!m) continue;
    const rest = (m[1] ?? "").trim();
    if (!rest) return { action, target: null, forMe };
    // Reactions only take a target with their "at/with" form; otherwise it's just chat.
    if (!action.targeted && !/\s(at|with|to|on)$/.test(word) && !/^(?:at|with|on)\s/i.test(rest)) return null;
    const target = rest.replace(/^(?:at|with|to|on)\s+/i, "");
    // "kick off the movie", "pat the cat", "throw a party" — not commands.
    if (/^(?:off|out|up|down|over|around|the|a|an|it|this|that|some|of|about|in)\b/i.test(target)) return null;
    // Long sentences aren't commands ("think about what you said yesterday").
    if (target.split(/\s+/).length > 4 && !target.startsWith("@")) return null;
    return { action, target, forMe };
  }
  return null;
}

/** Turns "@Lilly", "me", "douche", "everyone" into a display name. */
function resolveTarget(ctx: FeatureContext, raw: string | null): { name: string; isBot: boolean } | null {
  if (!raw) return null;
  const mention = [...ctx.message.mentions.users.values()][0];
  if (mention) {
    const member = ctx.message.guild?.members.cache.get(mention.id);
    return { name: member?.displayName ?? mention.displayName, isBot: mention.id === ctx.client.user.id };
  }
  const t = raw.replace(/^@/, "").trim();
  if (/^(me|my\b.*|myself)$/i.test(t)) return { name: ctx.user.name, isBot: false };
  if (/^(yourself|you|urself|u)$/i.test(t)) return { name: ctx.botName, isBot: true };
  if (/^(everyone|everybody|us|all|y'?all|chat)$/i.test(t)) return { name: "everyone", isBot: false };

  // Nicknames from /aurora memory ("douche" → Douchebag)
  const nicknames = getSettings(ctx.botConfig.id).nicknames;
  for (const [userId, names] of Object.entries(nicknames)) {
    if (names.some((n) => n.toLowerCase() === t.toLowerCase())) {
      const member = ctx.message.guild?.members.cache.get(userId);
      if (member) return { name: member.displayName, isBot: false };
    }
  }
  const member = ctx.message.guild?.members.cache.find(
    (m) => m.displayName.toLowerCase() === t.toLowerCase() || m.user.username.toLowerCase() === t.toLowerCase()
  );
  if (member) return { name: member.displayName, isBot: member.id === ctx.client.user.id };
  return { name: t.length > 32 ? `${t.slice(0, 31)}…` : t.replace(/^\w/, (c) => c.toUpperCase()), isBot: false };
}

const MEAN_REFUSALS = [
  "Nope! I'm not doing that, they didn't do anything to me 😤",
  "Absolutely not. The Warden would put ME in timeout for that 😅",
  "Violence?? In this Asylum?? Not on my watch 🙅",
];

export const gifFeature: Feature = async (ctx) => {
  const settings = getSettings(ctx.botConfig.id).gifs;
  if (!settings.enabled) return false;
  const command = parseGifCommand(ctx.text);
  if (!command) return false;
  const { action } = command;

  if (!groupAllowed(ctx.botConfig.id, action)) {
    await replyPlain(ctx, "🙈 Those kinds of GIFs are turned off here.");
    return true;
  }

  const target = resolveTarget(ctx, command.target) ?? (action.targeted ? { name: ctx.user.name, isBot: false } : null);

  if (action.group === "mean" && !canUseMean(ctx.botConfig.id, ctx.user.id)) {
    const friendly = pick(["hug", "bonk", "pat"]);
    await replyInCharacter(
      ctx,
      `${ctx.user.name} asked you to ${action.key} ${target?.name ?? "someone"}, but you refuse — they didn't do anything to you, ` +
        `and only the Warden decides that. Playfully say no in one short sentence and offer a ${friendly} instead.`,
      { fallback: pick(MEAN_REFUSALS) }
    );
    return true;
  }

  const gif = await fetchGif(action);
  if (!gif) {
    await replyPlain(ctx, "My GIF collection isn't loading right now 😣 Try again in a bit!");
    return true;
  }

  const actor = command.forMe ? ctx.user.name : ctx.botName;
  const targetName = target ? (target.isBot && !command.forMe ? "herself" : target.name) : null;
  const embed = gifEmbed(action, actor, targetName, gif);

  const what = targetName ? `${actor} ${action.verb} ${targetName}` : `${actor} ${action.self}`;
  await replyInCharacter(
    ctx,
    command.forMe
      ? `${ctx.user.name} asked you to deliver this for them: ${what} (a GIF shows it). Add one short, playful in-character line.`
      : `${ctx.user.name} asked you to do this: ${what} (a GIF shows it). Add one short, playful in-character line about it.`,
    { embed, fallback: `${action.emoji}`, logExtra: `[gif] ${what}` }
  );
  return true;
};

// ---------- reacting to roleplay and meanness ----------

/** What she'll do back when someone does an action to her. */
const RESPONSES: Record<string, string[]> = {
  hug: ["hug"], cuddle: ["cuddle", "blush"], pat: ["blush", "happy"], poke: ["poke", "pout"], bonk: ["pout", "cry"],
  wave: ["wave"], highfive: ["highfive"], handshake: ["handshake"], handhold: ["blush"], feed: ["nom"],
  tickle: ["laugh"], wink: ["blush"], baka: ["pout", "baka"], stare: ["stare"], thumbsup: ["thumbsup"],
  kiss: ["blush"], peck: ["blush"], lick: ["nope"], bite: ["cry", "pout"],
};

const INSULT_WORDS =
  "stupid|dumb|an idiot|idiot|a moron|moron|ugly|annoying|trash|garbage|a loser|loser|useless|worthless|cringe|a clown|clown|a bitch|bitch|a dumbass|dumbass|the worst|terrible|pathetic";
/** Said straight at her: "shut up", "I hate you", "fuck you"... */
const DIRECT_INSULT = /\b(shut up|stfu|go away|i hate you|hate you|you suck|u suck|fuck you|fuck off|screw you|nobody likes you|get lost)\b/i;
/** "you're so stupid", "ur annoying" */
const YOU_ARE = new RegExp(
  `\\b(?:you(?:'re| are)?|ur|u r|youre)\\s+(?:so\\s+|such\\s+|really\\s+|just\\s+|literally\\s+)*(?:${INSULT_WORDS})\\b`,
  "i"
);

function isInsult(content: string, names: string): boolean {
  if (DIRECT_INSULT.test(content) || YOU_ARE.test(content)) return true;
  // "aurora is so annoying"
  return new RegExp(
    `\\b(?:${names})\\s+(?:is|r|are)\\s+(?:so\\s+|such\\s+|really\\s+|just\\s+)*(?:${INSULT_WORDS})\\b`,
    "i"
  ).test(content);
}

export interface IncomingGifPlan {
  action: GifAction;
  /** Who it's aimed at (null = a reaction with no target). */
  targetName: string | null;
  /** A hint for Kindroid so her words match the GIF. */
  note: string;
}

/**
 * Decides whether to answer with a GIF because of what someone did TO her:
 * "*hugs aurora*" → hug back; insults or "*slaps aurora*" → self-defense.
 */
export function planIncomingGif(
  botId: string,
  content: string,
  botNames: string[],
  user: { id: string; name: string },
  affectionLevel: number
): IncomingGifPlan | null {
  if (!getSettings(botId).gifs.enabled) return null;
  const names = botNames.filter(Boolean).map((n) => escapeRegex(n)).join("|");

  // *slaps aurora* / *hugs you* / *holds hands with aurora* / *gives aurora a hug*
  let did: GifAction | undefined;
  const gives = content.match(
    new RegExp(`\\*\\s*(?:gives?|hands?|offers?)\\s+(?:${names}|you|u|her)\\s+(?:a|an|some|big|little|\\s)*([a-z -]{2,20}?)\\s*\\*`, "i")
  );
  const rp = content.match(new RegExp(`\\*\\s*([a-z][a-z -]{1,25}?)\\s+(?:${names}|you|u|her)\\b[^*]*\\*`, "i"));
  const phrase = (gives?.[1] ?? rp?.[1] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (phrase) {
    // "holds hands with" → "hold hands with", "slaps" → "slap"
    const singular = phrase.replace(/^(\w+?)(?:es|s)\b/, "$1");
    did = WORD_INDEX.find((w) => {
      const word = w.word.toLowerCase();
      return word === phrase || word === singular || `${word}s` === phrase || `${word}es` === phrase;
    })?.action;
  }

  const insulted = isInsult(content, names);
  if ((did && did.group === "mean") || (!did && insulted)) {
    // Someone was mean to her. Good friends get a pout; others might get it back.
    const fightBack = affectionLevel < 3 && Math.random() < 0.6;
    if (fightBack) {
      const action = did && did.group === "mean" ? did : actionByKey(pick(["slap", "punch", "kick", "yeet"]))!;
      return {
        action,
        targetName: user.name,
        note: `${user.name} was mean to you, so you're fighting back with a ${action.key} (a GIF shows it). Be sassy about it.`,
      };
    }
    const action = actionByKey(pick(["cry", "pout"]))!;
    return { action, targetName: null, note: `${user.name} was mean to you and it hurt your feelings (a GIF shows you ${action.key === "cry" ? "crying" : "pouting"}).` };
  }

  if (did) {
    const response = actionByKey(pick(RESPONSES[did.key] ?? ["smile"]));
    if (!response || !groupAllowed(botId, response)) return null;
    return {
      action: response,
      targetName: response.targeted ? user.name : null,
      note: `${user.name} just ${did.verb} you. React to it (a GIF shows you ${response.targeted ? `${response.verb} them back` : response.self}).`,
    };
  }
  return null;
}

// ---------- random reaction GIFs on her replies ----------

const MOODS: [RegExp, string[]][] = [
  [/\b(haha+|lol|lmao|hehe+|pfft)\b|😂|🤣/i, ["laugh"]],
  [/\b(blush(?:es|ing)?|flustered|embarrass\w*)\b|😳|\/\/\//i, ["blush"]],
  [/\b(cr(?:y|ies|ying)|sob(?:s|bing)?|tears|sniff\w*)\b|😭|😢/i, ["cry"]],
  [/\b(yay+|woo+|let'?s go+|so happy|excited)\b|🥳|✨/i, ["happy", "dance"]],
  [/\b(danc(?:e|es|ing)|party)\b|🎉|💃/i, ["dance"]],
  [/\b(yawn\w*|sleepy|tired|zzz)\b|😴|🥱/i, ["yawn", "sleep"]],
  [/\b(heh|obviously|told you|of course)\b|😏/i, ["smug"]],
  [/\b(hmm+|i wonder|thinking)\b|🤔/i, ["think"]],
  [/\b(hi+|hello|hey+|bye+|goodnight|good night|see you)\b|👋/i, ["wave"]],
  [/\b(hmph|pout\w*)\b|😤/i, ["pout"]],
  [/\b(ugh|seriously|facepalm\w*)\b|🤦/i, ["facepalm"]],
  [/\b(idk|whatever|who knows)\b|🤷/i, ["shrug"]],
  [/\b(good job|nice one|well done|proud of you)\b|👍/i, ["thumbsup"]],
];

/** Actions she describes herself doing, like "*hugs you tight*". */
function actionInReply(reply: string): GifAction | undefined {
  for (const m of reply.matchAll(/\*([^*]{2,80})\*/g)) {
    const inner = m[1].toLowerCase();
    for (const { word, action } of WORD_INDEX) {
      if (action.group === "mean") continue;
      if (new RegExp(`\\b${escapeRegex(word)}(?:s|es|ing)?\\b`).test(inner)) return action;
    }
  }
  return undefined;
}

/** Maybe picks a reaction GIF that matches her reply (respects the chance setting). */
export function planReplyGif(botId: string, reply: string, userName: string): IncomingGifPlan | null {
  const settings = getSettings(botId).gifs;
  if (!settings.enabled || Math.random() * 100 >= settings.chance) return null;

  const described = actionInReply(reply);
  if (described && groupAllowed(botId, described)) {
    return { action: described, targetName: described.targeted ? userName : null, note: "" };
  }
  for (const [pattern, keys] of MOODS) {
    if (pattern.test(reply)) {
      const action = actionByKey(pick(keys));
      if (action) return { action, targetName: null, note: "" };
    }
  }
  return null;
}

/** Sends her reply with the GIF attached to the first message. */
export async function replyWithGif(
  message: Message,
  text: string,
  plan: IncomingGifPlan,
  botName: string
): Promise<Message | null> {
  const gif = await fetchGif(plan.action);
  if (!gif) return null;
  const embed = gifEmbed(plan.action, botName, plan.targetName, gif);
  return message.reply({ content: text.slice(0, 2000), embeds: [embed], allowedMentions: { parse: [], repliedUser: true } });
}
