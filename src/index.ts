import { config } from "./config";
import { initializeAllBots, shutdownAllBots } from "./discordManager";
import { closeChatLog, initChatLog } from "./chatLog";

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down...`);
  await shutdownAllBots();
  await closeChatLog();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

async function main(): Promise<void> {
  console.log(`Found ${config.bots.length} bot configuration(s)`);
  await initChatLog();
  const started = await initializeAllBots(config.bots);

  if (started === 0) {
    console.error("No bots could log in. Check your BOT_TOKEN values.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error during startup:", error);
  process.exit(1);
});
