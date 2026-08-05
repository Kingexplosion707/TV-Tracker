<<<<<<< HEAD
# AniList Activity Discord Bot

Posts a Discord server's tracked AniList users' activity feed (episode/chapter progress, status updates) into a channel of your choice, automatically.

## Commands

- `/track <username>` — start following an AniList user. First run also sets the notification channel to wherever you ran the command (unless already set).
- `/untrack <username>` — stop following them.
- `/list` — show who's being tracked and which channel updates go to.
- `/setchannel <channel>` — change the notification channel (requires Manage Server permission).

The bot checks AniList every 3 minutes by default (`POLL_MINUTES` in `.env`) and posts anything new since the last check.

**Whoever runs `/track <username>` gets pinged** whenever that AniList user's activity posts — so you know at a glance who to blame/congratulate.

Embeds for episode/chapter updates use the anime/manga's cover art as a large image, with the embed's side color pulled from that cover art's dominant color. Note: Discord embeds don't support a side-by-side "image left, text right" layout — that's a hard limitation of Discord's embed API, not something any bot can work around — so the image renders large, full-width, below the text instead.

---

## Part 1 — Create the Discord bot (Developer Portal)

1. Go to https://discord.com/developers/applications and click **New Application**. Name it whatever you want (e.g. "AniList Tracker").
2. In the left sidebar, click **Bot**.
   - Click **Reset Token** (or **Copy** if visible) to get your bot token. Save it somewhere safe — you'll put it in `.env` as `DISCORD_TOKEN`. Treat it like a password; never commit it or share it.
   - No special "Privileged Gateway Intents" are needed for this bot (it doesn't read messages), so you can leave those off.
3. In the left sidebar, click **General Information**. Copy the **Application ID** — that's your `CLIENT_ID` for `.env`.
4. In the left sidebar, click **OAuth2 → URL Generator**.
   - Under **Scopes**, check `bot` and `applications.commands`.
   - Under **Bot Permissions**, check `Send Messages` and `Embed Links` (that's all this bot needs).
   - Copy the generated URL at the bottom, paste it into your browser, pick your server, and authorize it. The bot will appear offline in your member list until you actually run the code.

## Part 2 — Configure the project

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Fill in `.env`:
   - `DISCORD_TOKEN` — from Part 1, step 2
   - `CLIENT_ID` — from Part 1, step 3
   - `GUILD_ID` — optional. While testing, grab your server's ID (enable Developer Mode in Discord settings → Advanced, then right-click your server icon → Copy Server ID) and paste it here so slash commands register instantly. Leave it blank once you're ready to go global (takes up to ~1 hour to propagate everywhere).
   - `POLL_MINUTES` — how often to check AniList, default 3.

## Part 3 — Run it locally (to test)

```bash
npm install               # re-run this after pulling updates, e.g. new dependencies like jimp
npm run deploy-commands   # registers the slash commands with Discord
npm start                 # starts the bot
```

Once you see `Logged in as ...` in the console, go to your Discord server and try `/track` with an AniList username.

## Part 4 — Deploy to Railway (so it runs 24/7)

1. Push this project to a GitHub repo (make sure `.env` is NOT included — `.gitignore` already excludes it).
2. Go to https://railway.app, sign in, and click **New Project → Deploy from GitHub repo**, then pick your repo.
3. Once it's created, go to your service's **Variables** tab and add:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (optional)
   - `POLL_MINUTES` (optional)
4. Go to the **Settings** tab and set the **Start Command** to `npm start`.
5. Deploy. Check the **Deployments → Logs** tab for `Logged in as ...`.
6. **Important:** you still need to register slash commands once. Easiest way — run `npm run deploy-commands` from your own machine with the same `.env` values (it just talks to Discord's API, doesn't need to be hosted). You only need to redo this if you add/change commands later.

### Note on persistence
This bot stores tracked users in `data/storage.json` on disk. Railway's filesystem persists while the service is running but can reset on redeploys depending on your plan. If you notice tracked users disappearing after redeploys, add a Railway **Volume** mounted at `/app/data` (in Settings → Volumes) so `storage.json` survives, or let me know and I can switch this to a small database instead.

---

## How it works under the hood

- `anilist.js` — talks to AniList's public GraphQL API (`https://graphql.anilist.co`), no API key needed.
- `storage.js` — reads/writes `data/storage.json`, which tracks per-server: notification channel + list of `{ username, id, lastActivityId }`.
- `index.js` — handles slash commands and runs a `setInterval` loop every `POLL_MINUTES` that fetches each tracked user's 10 most recent activities, filters for ones newer than `lastActivityId`, posts them as embeds oldest-first, and updates `lastActivityId`.
=======
# AniTracker
A discord bot for Anilist.co to track users activity and send it to a server channel.
>>>>>>> 1af0517fd6c1f0da59b5ab19d172f0052581052e
