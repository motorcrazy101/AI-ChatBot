# Kindroid Discord Multi-Bot Manager

Tutorial on how to use this repo: https://docs.kindroid.ai/official-discord-bot-integration

A Node.js service that manages multiple Discord bots, each tied to a unique Kindroid AI persona. The system uses just-in-time message fetching to provide conversation context without storing large message logs.

## Features

- **Multi-bot** support: Run multiple Discord bots from a single service
- **Kindroid AI integration**: Each bot is tied to a unique AI persona (via `SHARED_AI_CODE_n`)
- **JIT message fetching**: Dynamically grabs the last ~30 messages for context
- **Caching**: Minimizes redundant Discord API calls
- **Graceful shutdown**: Bots disconnect on SIGINT/SIGTERM
- **Configurable NSFW filtering** via environment variables

## Prerequisites

- Node.js 16.x or higher
- Discord Bot Token(s) from the [Discord Developer Portal](https://discord.com/developers/applications)
- Kindroid AI API access (API key and share code)

## Setup

1. **Clone the repository**:

   ```bash
   git clone https://github.com/KindroidAI/Kindroid-discord.git
   cd Kindroid-discord
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy and configure .env:

   ```bash
   cp .env.example .env
   ```

4. Fill in your KINDROID_API_KEY, KINDROID_INFER_URL, and bot tokens (BOT_TOKEN_n).
   Provide SHARED_AI_CODE_n for each bot's AI persona.

5. Run in development mode:

   ```bash
   npm run dev
   ```

   For production:

   ```bash
   npm run build
   npm start
   ```

# Docker version (production)

1. **Clone the repository**

   ```bash
   git clone https://github.com/KindroidAI/Kindroid-discord.git
   cd Kindroid-discord
   ```

2. **Build the image**

   ```bash
   docker build -t kindroid-bot .
   ```

3. **Run the image with environment variables**

   ```bash
   docker run -d -e KINDROID_API_KEY=your_kindroid_api_key_here -e SHARED_AI_CODE_1=your_shared_code_1_here -e BOT_TOKEN_1=your_discord_bot_token_1_here -e ENABLE_FILTER_1=false kindroid-bot:latest
   ```
   If you have a .env file

   ```bash
   docker run -d --env-file path_to_env_file kindroid-bot:latest
   ```

   Or create a compose file

   ```bash
   touch compose.yml
   ```

   ```yaml
   services:
      discord:
         image: kindroid-bot
         container_name: container_name
         restart: always
         environment:
            KINDROID_API_KEY: your_kindroid_api_key_here
            SHARED_AI_CODE_1: your_shared_code_1_here
            BOT_TOKEN_1: your_discord_bot_token_1_here
            ENABLE_FILTER_1: false
   ```

   ```bash
   docker compose up
   ```

## Configuration

Use environment variables to configure your bots. The .env.example file shows usage:

- KINDROID_INFER_URL: The Kindroid AI API endpoint, and should not change
- KINDROID_API_KEY: Your Kindroid AI API key
- SHARED_AI_CODE_n: The share code to identify which AI persona to use for the n-th bot
- BOT_TOKEN_n: Discord bot token for the n-th bot
- ENABLE_FILTER_n: (Optional) true or false to enable NSFW filtering for the n-th bot

You can create as many bots as you want by incrementing the number (\_1, \_2, \_3, etc.).

## Error Handling

- Failed bot initialization is logged; other bots still initialize
- Conversation fetch failures are caught and logged
- API call errors log diagnostic info and return a friendly user message
- SIGINT or SIGTERM triggers a graceful shutdown of all bots

## Contributing

1. Fork this repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add some amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License

This project is licensed under the MIT License.
