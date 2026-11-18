import { EmbedBuilder } from "discord.js";
import { Feature, replyInCharacter, replyPlain } from "./featureKit";
import { getSettings } from "./settings";
import { zonedParts } from "./time";

/**
 * Small just-for-fun features:
 *   Ship-o-meter:  "aurora ship Lilly and Rin" (off unless an admin turns it on)
 *   Nurse Mochi's prescription: "aurora my prescription" / "aurora daily prescription"
 *   (anime-themed jokes — never real medical or mental-health advice)
 */

/** Small stable hash so the same input always gives the same answer. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- ship-o-meter ----------

const SHIP = /^(?:can\s+you\s+)?ship\s+(.+?)\s+(?:and|&|with|x|\+)\s+(.+?)[?!.]*$/i;

function cleanName(raw: string): string {
  return raw.replace(/^@/, "").replace(/[*_~`]/g, "").trim();
}

export function shipName(a: string, b: string): string {
  const first = a.replace(/\s.*$/, "");
  const second = b.replace(/\s.*$/, "");
  return first.slice(0, Math.ceil(first.length / 2)) + second.slice(Math.floor(second.length / 2));
}

export function shipScore(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return hash(`${x}|${y}`) % 101;
}

function shipVerdict(score: number): string {
  if (score >= 90) return "💞 Canon. The manga ending writes itself.";
  if (score >= 75) return "💖 Main-couple energy.";
  if (score >= 55) return "💛 Slow burn… very slow… 200 episodes slow.";
  if (score >= 35) return "🤝 Strong 'best friends who bicker' vibes.";
  if (score >= 15) return "😬 The fandom would riot.";
  return "🧊 Rivals at best. Maybe enemies.";
}

const shipFeature: Feature = async (ctx) => {
  const match = ctx.text.match(SHIP);
  if (!match) return false;
  if (!getSettings(ctx.botConfig.id).shipEnabled) {
    await replyPlain(ctx, "The Ship-o-meter is switched off in this asylum 🚢🔒");
    return true;
  }
  const me = (n: string) => (/^(?:me|myself|i)$/i.test(n) ? ctx.user.name : n);
  const a = me(cleanName(match[1]));
  const b = me(cleanName(match[2]));
  if (!a || !b || a.length > 40 || b.length > 40) return false;
  const score = shipScore(a, b);
  const filled = Math.round(score / 10);
  const embed = new EmbedBuilder()
    .setColor(0xff7ab6)
    .setTitle(`🚢 Ship-o-meter: ${a} × ${b}`)
    .setDescription(`**${shipName(a, b)}**\n${"💗".repeat(filled)}${"🤍".repeat(10 - filled)} **${score}%**\n${shipVerdict(score)}`)
    .setFooter({ text: "Just for fun — the Ship-o-meter is never wrong (it's always wrong)" });
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked you to ship ${a} and ${b}. The Ship-o-meter says ${score}% (${shipVerdict(score)}). ` +
      "React in one playful sentence, like a fangirl reading the result. Keep it light and wholesome.",
    { embed, fallback: `The meter has spoken: ${score}%! 🚢`, logExtra: `[ship] ${a} x ${b} ${score}%` }
  );
  return true;
};

// ---------- Nurse Mochi's prescription ----------

const PRESCRIPTION = /\b(?:my\s+|daily\s+|today'?s\s+|a\s+|give\s+me\s+(?:a|my)\s+)prescription\b|^prescription[?!.]*$|\bnurse\s+mochi\b/i;

const DOSES = [
  "one (1) episode of a slice-of-life anime",
  "two (2) cups of tea, sipped dramatically",
  "a 20-minute nap like a sleepy anime cat",
  "one (1) opening theme, sung loudly, no skipping",
  "three (3) mochi, shared with a friend",
  "a rewatch of your comfort anime's best episode",
  "one (1) training montage (a short walk counts)",
  "a glass of water, chugged like a shonen protagonist",
  "five (5) minutes of staring out the window like a main character",
  "one (1) bowl of instant ramen, eaten with honor",
  "a compliment for someone in the server",
  "one (1) Studio Ghibli soundtrack",
  "a stretch break worthy of a magical girl transformation",
  "one (1) chapter of a manga you've been putting off",
];

const DIRECTIONS = [
  "Take with snacks.",
  "Do not operate a giant robot afterwards.",
  "Side effects may include yelling at cliffhangers.",
  "Must be taken before lights-out.",
  "Best taken with a dramatic hair flip.",
  "Repeat until vibes improve.",
  "Do not mix with filler arcs.",
  "If symptoms persist, watch the OVA.",
];

const DIAGNOSES = [
  "a mild case of Main Character Syndrome",
  "chronic 'one more episode'-itis",
  "acute waifu/husbando attachment",
  "Seasonal Anime Withdrawal",
  "Cliffhanger Fever",
  "a severe lack of mochi",
  "Plot Armor Deficiency",
  "Overpowered Protagonist Complex",
  "Opening-Theme Earworm Disorder",
];

export function prescriptionFor(userId: string, date: string): { diagnosis: string; dose: string; directions: string } {
  const h = hash(`${userId}|${date}`);
  return {
    diagnosis: DIAGNOSES[h % DIAGNOSES.length],
    dose: DOSES[(h >>> 8) % DOSES.length],
    directions: DIRECTIONS[(h >>> 16) % DIRECTIONS.length],
  };
}

export function prescriptionEmbed(name: string, rx: ReturnType<typeof prescriptionFor>): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x7fd8be)
    .setTitle(`💊 Nurse Mochi's Prescription for ${name}`)
    .setDescription(`**Diagnosis:** ${rx.diagnosis}\n**Prescribed:** ${rx.dose}\n**Directions:** ${rx.directions}`)
    .setFooter({ text: "Just a joke from the Asylum nurse — not real medical advice 💕" });
}

const prescriptionFeature: Feature = async (ctx) => {
  if (!PRESCRIPTION.test(ctx.text)) return false;
  const rx = prescriptionFor(ctx.user.id, zonedParts().date);
  await replyInCharacter(
    ctx,
    `${ctx.user.name} asked for Nurse Mochi's daily prescription (a silly Asylum joke, NOT medical advice). ` +
      `Their joke diagnosis: ${rx.diagnosis}; prescribed: ${rx.dose}. Hand it over in one playful sentence.`,
    { embed: prescriptionEmbed(ctx.user.name, rx), fallback: "Nurse Mochi has spoken! 💊", logExtra: `[prescription] ${rx.dose}` }
  );
  return true;
};

export const funFeatures: Feature[] = [shipFeature, prescriptionFeature];
