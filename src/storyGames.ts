import { Client, Message } from "discord.js";
import { AdventureData, adventureFeature, checkAdventureVote, resolveAdventure } from "./adventure";
import { Feature } from "./featureKit";
import { dueGames, Game, getGame } from "./gameState";
import { addLogbookLine, expireLogbook, LogbookData, logbookFeature } from "./logbook";
import { MysteryData, mysteryFeature, resolveMysteryVote } from "./mystery";
import { expireScene, replyInScene, SceneData, sceneFeature } from "./scenes";
import { checkSecretFile, expireSecretFile, SecretFileData, secretFileFeature } from "./secretFile";
import { BotConfig } from "./types";

/** All the Asylum story games, for the feature router. */
export const storyFeatures: Feature[] = [
  adventureFeature,
  mysteryFeature,
  secretFileFeature,
  logbookFeature,
  sceneFeature,
];

/**
 * Messages in a channel/thread with a running game, even when nobody says her
 * name: adventure votes ("B"), Secret File questions, logbook lines and
 * roleplay replies. Returns true if the game handled the message.
 */
export async function handleStoryMessage(
  message: Message,
  client: Client<true>,
  botConfig: BotConfig,
  user: { id: string; name: string },
  botName: string,
  text: string,
  addressed: boolean
): Promise<boolean> {
  if (message.author.bot) return false;
  const game = await getGame(botConfig.id, message.channelId);
  if (!game) return false;

  switch (game.kind) {
    case "adventure":
      return checkAdventureVote(message, client, botConfig, game as Game<AdventureData>);
    case "secretfile":
      return checkSecretFile(message, client, botConfig, game as Game<SecretFileData>, text, user, addressed);
    case "logbook":
      // "aurora close the logbook" goes to the feature; everything else is a new line.
      if (addressed && /\b(?:close|finish|end|submit|wrap up)\b/i.test(text)) return false;
      return addLogbookLine(message, client, botConfig, game as Game<LogbookData>, user.name);
    case "scene":
      if (addressed && /\b(?:end|stop|finish|close)\s+(?:the\s+|this\s+)?(?:scene|roleplay|rp)\b/i.test(text)) return false;
      return replyInScene(message, client, botConfig, game as Game<SceneData>, user, botName);
    default:
      return false; // mysteries are played by talking to her ("aurora ask Mimi…")
  }
}

/** Every 10 seconds: close votes and wrap up games that went quiet. */
export function startStoryLoop(client: Client, botConfig: BotConfig): void {
  let running = false;
  setInterval(() => {
    if (!client.isReady() || running) return;
    running = true;
    dueGames(botConfig.id)
      .then(async (games) => {
        for (const game of games) {
          try {
            if (game.kind === "adventure") await resolveAdventure(client, botConfig, game as Game<AdventureData>);
            else if (game.kind === "mystery") await resolveMysteryVote(client, botConfig, game as Game<MysteryData>);
            else if (game.kind === "secretfile") await expireSecretFile(client, botConfig, game as Game<SecretFileData>);
            else if (game.kind === "logbook") await expireLogbook(client, botConfig, game as Game<LogbookData>);
            else if (game.kind === "scene") await expireScene(client, botConfig, game as Game<SceneData>);
          } catch (err) {
            console.error(`[${botConfig.id}] Story game ${game.kind} #${game.id} failed:`, err);
          }
        }
      })
      .catch((err) => console.error(`[${botConfig.id}] Story loop failed:`, (err as Error).message))
      .finally(() => {
        running = false;
      });
  }, 10_000).unref();
}
