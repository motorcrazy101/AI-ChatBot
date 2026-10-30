# Kindroid Discord Multi-Bot Manager

Based on Kindroid's official bot: https://docs.kindroid.ai/official-discord-bot-integration

Runs one or more Discord bots, each tied to a Kindroid AI persona. Hosted on Railway, deployed from this GitHub repo.

## Features

- **Talks when called**: say her name, @mention her, reply to her, or DM her
- **Multi-bot**: add `BOT_TOKEN_2` / `SHARED_AI_CODE_2` (and so on) to run more Kindroids; they can talk to each other, with a loop limit
- **Custom status** under her name
- **Random chime-ins**: she sometimes joins conversations in channels you pick
- **Emoji reactions**: she sometimes reacts to messages
- **Welcomes new members** in her own voice
- **Scheduled posts**: e.g. a good-morning message every day at 8am
- **Admin slash command** (`/aurora`, named after the bot) to control all of the above
- **Chat logs** saved to Postgres, plus a password-protected web page to browse them

## Settings (Railway → bot service → Variables)

See `.env.example` for the full list. The main ones:

| Variable | What it is |
|---|---|
| `KINDROID_API_KEY` | Your Kindroid API key |
| `KINDROID_INFER_URL` | `https://api.kindroid.ai/v1/discord-bot` |
| `SHARED_AI_CODE_1` | The Kindroid's share code |
| `BOT_TOKEN_1` | Discord bot token |
| `BOT_STATUS_1` | Optional status, e.g. `Playing in the Asylum` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`: saves chats and command settings |
| `LOG_VIEWER_PASSWORD` | Turns on the chat log web page |
| `TIMEZONE` | For scheduled posts, default `America/Los_Angeles` |

Never put real keys or tokens in GitHub.

## Slash commands

Only members with **Manage Server** can see these. Change who can use them in Discord under
Server Settings → Integrations → the bot.

| Command | What it does |
|---|---|
| `/aurora settings` | Show everything that's set |
| `/aurora stats` | Who talks to her the most (last 30 days) |
| `/aurora quiet` / `unquiet` | Silence her in this channel / undo |
| `/aurora block` / `unblock` / `blocklist` | Make her ignore someone |
| `/aurora status` | Change her status (empty text clears it) |
| `/aurora chimein on` / `off` / `chance` | Random chime-ins in this channel |
| `/aurora reactions chance` / `emojis` | How often she reacts, and with which emojis |
| `/aurora welcome on` / `off` / `test` | Welcome new members in a channel |
| `/aurora schedule add` / `list` / `remove` / `test` | Scheduled posts |

## Discord Developer Portal

Under **Bot → Privileged Gateway Intents**:

- **Message Content Intent**: required
- **Server Members Intent**: needed only for welcoming new members (the bot still runs without it)

## Chat log web page

1. Set `LOG_VIEWER_PASSWORD` in Railway.
2. Bot service → **Settings → Networking → Generate Domain**.
3. Open that address and sign in with any username and your password.

## Running locally (optional)

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

## License

MIT. See `LICENSE`.
