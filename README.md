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
- **Picture search**: "aurora find me a picture of ..." posts an image with a comment from her (anime pictures are free via nekos.best; anything else uses Brave image search with SafeSearch on)
- **Anime lookup**: "aurora tell me about Frieren" gives her take plus real MyAnimeList info
- **Weather**: "aurora what's the weather in LA" gives a real 3-day forecast
- **Catch-up**: "aurora what did I miss?" summarizes the chat since you last talked
- **Mini-games**: trivia (first right answer wins), would-you-rather, truth or dare, magic 8-ball
- **Affection levels**: she gets friendlier the more you talk (Stranger → Soulmate)
- **Sleep schedule**: 😴 at night, groggy if you wake her, ☕ in the morning
- **Reminders**: "aurora remind me in 2 hours to…" pings you in character
- **Long-term memory**: she remembers your birthday, things you ask her to remember, and past conversations with you (DMs never come up in servers)
- **Birthdays**: "aurora my birthday is May 5" and she wishes you happy birthday on the day
- **Moods**: a daily mood (happy, hyper, cozy, dramatic, sleepy, grumpy) that colors her replies; chats, gifts and streaks cheer her up
- **Holidays**: special status and greetings on Halloween, Christmas, New Year's and more, plus server anniversaries
- **Notices what you're doing**: "ooh, Genshin again?" (needs Presence Intent)
- **Daily streaks**: say good morning / good night every day for a streak with milestones
- **Gifts**: "aurora here's a cookie 🍪" — she has favorites and dislikes
- **Anonymous confessions**: DM her "I want to confess" and it's posted anonymously after owner approval
- **Polls**: "aurora poll: pizza or tacos?" with reaction voting and a winner announcement
- **Episode alerts**: "aurora tell me when Frieren airs" pings you when new episodes come out (AniList)
- **Recommendations**: "aurora recommend me something like Frieren" (MyAnimeList)
- **Server watchlist**: add shows, see the list, and let her pick tonight's watch
- **Asylum story games** (all set in the Anime Asylum, with the bot owner as the Warden):
  text adventures with voting, dice, characters, Energy and inventory (6 story packs, group in threads or solo in DMs),
  Asylum Mysteries, the Warden's Secret File (20 Questions), the Asylum Logbook (story chain) and roleplay scenes
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
| `BRAVE_API_KEY` | Turns on web picture search (anime pictures work without it) |
| `IMAGE_SEARCH_DAILY_LIMIT` | Max Brave searches per day, default 50 |

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
| `/aurora memory add` / `nicknames` / `list` / `remove` | Facts she treats as true about people (bot owner only) |
| `/aurora dm` | Have her DM someone in her own words (bot owner only) |
| `/aurora replies on` / `off` | Whether replying to her messages makes her answer (per server) |
| `/aurora confessions on` / `off` / `approval` | Anonymous confessions channel and approval |
| `/aurora mood show` / `set` / `reset` | Her mood today |
| `/aurora length` | How long her replies are (short / medium / long / no limit) |
| `/aurora sleep on` / `off` / `set` | Her sleep schedule |
| `/aurora birthdays on` / `off` / `list` | Where birthday wishes go (DMs if none) |

## Things anyone can say to her

| Say | What happens |
|---|---|
| `aurora tell me about <anime>` | Anime info and her opinion (`have you watched…`, `should I read…` work too) |
| `aurora what's the weather in <place>` | Real forecast |
| `aurora what did I miss?` | Chat catch-up |
| `aurora trivia` / `aurora anime trivia` | Trivia question; reply with A–D |
| `aurora would you rather` · `aurora truth or dare` · `aurora 8ball <question>` | Party games |
| `aurora remind me in 2 hours to …` · `aurora my reminders` · `aurora cancel reminder 3` | Reminders |
| `aurora my birthday is May 5` · `aurora when is my birthday` · `aurora forget my birthday` | Birthdays |
| `aurora what's my level` | Your friendship level with her |
| `aurora remember that I love cats` · `aurora what do you remember about me?` · `aurora forget note 2` | Things she remembers about you long-term |
| `aurora find me a picture of …` | Picture search |
| `aurora good morning` / `aurora goodnight` | Builds your daily streak |
| `aurora here's a cookie 🍪` · `*hands aurora a plushie*` | Give her a gift |
| `aurora poll: pizza or tacos?` (add `for 2 hours`) | Reaction poll |
| `aurora tell me when Frieren airs` · `aurora my anime alerts` · `aurora stop alerts for Frieren` | Episode alerts |
| `aurora recommend me something like Frieren` · `aurora recommend a romance anime` | Recommendations |
| `aurora add Frieren to the watchlist` · `aurora show the watchlist` · `aurora what should we watch tonight?` | Server watchlist |
| `aurora start an adventure` (or `…: haunted east wing`, `start a solo adventure`) · `aurora adventure packs` | Asylum text adventure — vote with 🇦🇧🇨 or type A/B/C |
| `aurora pause / continue / end the adventure` · `aurora adventure status` | Control the adventure |
| `aurora create my character: Rin the Escape Artist` · `aurora my character` · `aurora character classes` | Your Asylum resident (+3 on matching rolls) |
| `aurora start a mystery` · `aurora ask Mimi where she was` · `aurora search the laundry room` · `aurora case file` · `aurora start the vote` | Asylum Mystery |
| `aurora open the secret file` · then `is it a girl?` · `is it Levi?` · `aurora give up` | The Warden's Secret File (20 Questions) |
| `aurora open the logbook` · then everyone adds lines · `aurora close the logbook` | Asylum Logbook (story chain) |
| `aurora let's roleplay in the cafeteria` · `aurora end the scene` | Roleplay scene (she answers everyone in the thread) |
| DM her `I want to confess`, then send the confession (or `confess: …` in one message) | Anonymous confession |

## Discord Developer Portal

Under **Bot → Privileged Gateway Intents**:

- **Message Content Intent**: required
- **Server Members Intent**: needed only for welcoming new members (the bot still runs without it)
- **Presence Intent**: needed only for noticing what people are playing / listening to (the bot still runs without it)

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
