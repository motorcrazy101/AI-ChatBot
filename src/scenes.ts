import { Client, Message } from "discord.js";
import { LOCATIONS, wardenDescription, wardenFor, WORLD } from "./asylum";
import { logBotPost, logOutgoing } from "./chatLog";
import { Feature, pick, replyPlain } from "./featureKit";
import { createGame, endGame, Game, getGame, saveGame } from "./gameState";
import { generateReply, sendText, startTyping } from "./respond";
import { fetchGameChannel, guildOf, openThread, storyText } from "./storyKit";
import { BotConfig } from "./types";

/**
 * Roleplay scenes set in the Asylum:
 *   "aurora let's roleplay in the cafeteria" / "aurora roleplay we got sent to the Warden's office"
 * Opens a thread where she answers EVERY message in character (no need to say her name).
 * "aurora end the scene" finishes it; it also ends after 30 quiet minutes.
 */

const IDLE_MINUTES = 30;
const START =
  /^(?:(?:let'?s|lets|can we|wanna|want to|start an?|start)\s+)?(?:do\s+an?\s+)?(?:roleplay|role-play|role play|rp)\b(?:\s+(?:scene|session))?[\s:,-]*(.*)$/i;
const END = /\b(?:end|stop|finish|close)\s+(?:the\s+|this\s+)?(?:scene|roleplay|role-play|rp)\b/i;

export interface SceneData {
  scenario: string;
  starterId: string;
}

async function finishScene(client: Client<true>, botConfig: BotConfig, game: Game<SceneData>, idle: boolean): Promise<void> {
  const channel = await fetchGameChannel(client, game.channelId);
  await endGame(game);
  if (!channel) return;
  const closing = await storyText(
    client,
    botConfig,
    channel,
    guildOf(channel),
    `The roleplay scene "${game.data.scenario}" is ending${idle ? " because everyone went quiet" : ""}. ` +
      "Write a short in-character closing line (under 40 words).",
    400
  );
  const sent = await channel.send(`🎬 ${closing ?? "And… scene!"}\n-# The scene has ended.`);
  logBotPost(botConfig.id, client.user.displayName, sent, "game");
}

export async function expireScene(client: Client<true>, botConfig: BotConfig, game: Game<SceneData>): Promise<void> {
  await finishScene(client, botConfig, game, true);
}

export const sceneFeature: Feature = async (ctx) => {
  if (END.test(ctx.text)) {
    const game = await getGame<SceneData>(ctx.botConfig.id, ctx.channel.id);
    if (!game || game.kind !== "scene") return false;
    await finishScene(ctx.client, ctx.botConfig, game, false);
    return true;
  }

  const start = ctx.text.match(START);
  if (!start) return false;
  const existing = await getGame(ctx.botConfig.id, ctx.channel.id);
  if (existing) {
    await replyPlain(ctx, `There's already a ${existing.kind} going on here! Finish it first.`);
    return true;
  }
  const rest = (start[1] ?? "").replace(/^(?:with me|together)\b\s*/i, "").replace(/[.!?]+$/, "").trim();
  const scenario = rest || `hanging out in ${pick(LOCATIONS)}`;

  const intro = await ctx.message.reply({
    content: `🎭 **Scene:** ${scenario}\nJoin the thread — I'll reply to everyone in character. Say *aurora end the scene* to finish.`,
    allowedMentions: { parse: [], repliedUser: false },
  });
  const channel = await openThread(intro, `🎭 ${scenario}`);
  await createGame<SceneData>(
    ctx.botConfig.id,
    channel.id,
    "scene",
    { scenario, starterId: ctx.user.id },
    new Date(Date.now() + IDLE_MINUTES * 60_000)
  );
  const opening = await storyText(
    ctx.client,
    ctx.botConfig,
    channel,
    guildOf(channel),
    `Start a roleplay scene set in the Asylum: "${scenario}", with ${ctx.user.name}. Set the scene in character ` +
      "(under 70 words) and give them something to react to. Stay in the scene from now on.",
    900
  );
  const sent = await channel.send(opening ?? "*looks around* So… here we are. 👀");
  logBotPost(ctx.botConfig.id, ctx.botName, sent, "game");
  return true;
};

/** In a scene thread she answers every message in character. */
export async function replyInScene(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig,
  game: Game<SceneData>,
  user: { id: string; name: string },
  botName: string
): Promise<boolean> {
  if (END.test(message.content)) return false; // let the end command handle it
  const channel = await fetchGameChannel(client, game.channelId);
  if (!channel) return false;
  game.deadline = new Date(Date.now() + IDLE_MINUTES * 60_000);
  await saveGame(game);

  const warden = wardenFor(botConfig.id, guildOf(channel));
  const stopTyping = startTyping(channel, botConfig.id);
  try {
    const reply = await generateReply(
      client,
      botConfig,
      channel,
      undefined,
      user,
      [`You're in a roleplay scene: "${game.data.scenario}". ${WORLD} ${wardenDescription(warden)} Stay in the scene and keep it going.`],
      "medium"
    );
    stopTyping();
    if (!reply) return true;
    const sent = await sendText(channel, reply, { replyTo: message });
    for (const post of sent) logOutgoing(botConfig.id, botName, post, message);
  } finally {
    stopTyping();
  }
  return true;
}
