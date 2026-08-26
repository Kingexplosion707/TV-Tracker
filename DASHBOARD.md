# AniTracker Developer Portal

A password-protected dashboard served straight from the bot's existing web
server — no separate hosting needed, and it works fine on Render's free tier.

## What it does

- **Overview** — server count, tracked-user count, total recommend votes, uptime, running/paused status
- **Servers** — every server the bot is in, which channel it posts to, how many people are tracked there
- **Tracked Users** — flat list of every tracked AniList profile across all servers
- **Recent Activity** — the latest posted updates across all servers, newest first
- **Leaderboards**
  - *Most Recommended* — ⭐ votes, summed across servers (per-user global dedup is a planned follow-up)
  - *Most Watched* — a running count of how many activity updates each title has produced, bot-wide
  - *Watch Later* — everyone's watch-later lists, grouped by Discord user (temporary view, as requested)
  - *Linked AniList Accounts* — empty placeholder for now; will populate once a real `/signin` OAuth flow ships
- **Send Message** — pick a server + channel, post as the bot
- **Bot Controls** — Pause/Resume polling, and a Redeploy button (Render deploy hook)

## One-time setup

1. **Install the new dependency**
   ```
   npm install
   ```
   (this pulls in `express`, now listed in `package.json`)

2. **Add three env vars** — locally in `.env`, and in Render's Environment tab:
   - `DASHBOARD_PASSWORD` — the password you'll log in with. Pick something long/random; this single password protects sending messages, pausing the bot, and redeploying.
   - `DASHBOARD_SESSION_SECRET` — a random string so logins survive a restart. Generate one with:
     ```
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - `RENDER_DEPLOY_HOOK_URL` *(optional, only needed for the Redeploy button)* — Render dashboard → your service → **Settings** → **Deploy Hook** → copy the URL.

3. **Deploy as usual.** Once it's live, the dashboard is at:
   ```
   https://<your-render-url>.onrender.com/dashboard
   ```

## Linking from Webflow (free plan)

Webflow's free plan can't run backend logic, so the dashboard has to keep
living on Render — Webflow can only link *to* it, not embed it as a live app.
Easiest options on the free plan:
- Add a plain link/button on your Webflow site pointing at `.../dashboard`.
- Once you're off the free plan, you could embed it in an iframe instead —
  the dashboard doesn't need any changes for that, just ask and I'll add the
  right headers (`X-Frame-Options`/CSP) to allow it.

## Notes on what's real vs. placeholder right now

- **Most Watched** starts counting from the moment this update ships — there's
  no historical backfill, since the bot never tracked this before.
- **Watch Later** is grouped by raw Discord user ID for now. If you want
  display names instead, I can fetch them from each guild's member list —
  just didn't want to add extra Discord API calls without you confirming
  you want that.
- **Linked AniList Accounts** is an empty scaffold — there's no `/signin`
  command yet, so this tab will stay empty until that's built.
- **Most Recommended** sums votes per-server for now. True global dedup
  (one vote per person per anime, no matter how many servers they vote from)
  is the architecture change you already flagged for the next embed update —
  I left a hook (`data.recommendations` shape) so that's a clean follow-up.
