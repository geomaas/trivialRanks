# trivialRANKS

A daily trivia leaderboard. Players paste the share text from daily games (Wordle, MapTap, Framed, Catfishing, TimeGuessr, Krillion, Immaculate Grid, Bandle), and the page parses each result, scores it, and ranks players on the total points from the games they played. Each game is worth up to 100 points, based on your place among everyone who played it that day.

## Running it

The whole app is one file, [`index.html`](index.html). Open it in a browser to try it.

### Local build with a database

```
python3 local/server.py
```

Then open http://localhost:8000. Results are saved in `local/trivia.db` (SQLite), and the leaderboard updates every 2 seconds. Only Python 3 is needed; there's nothing to install.

- **Test with several players:** each browser is its own player. Add `?as=<name>` to the address to act as someone else, e.g. `http://localhost:8000/?as=ana` in a second tab.
- **Play from phones on your Wi-Fi:** run `python3 local/server.py --lan` and open the "phones" address it prints.
- **Start over:** stop the server and delete `local/trivia.db`.

The server slips a small stand-in for claude.ai's database and sign-in ([`local/claude-shim.js`](local/claude-shim.js)) into the page as it serves it, so `index.html` is unchanged and still runs on claude.ai. There are no real accounts: anyone who can reach the server can post as any player, so keep it on your own machine or home network.

### Hosted on Vercel with Supabase

Vercel runs [`build.mjs`](build.mjs), which writes `dist/index.html` with Supabase wired in: email-link sign-in, a Postgres `players` table, and live updates. [`web/supabase-shim.js`](web/supabase-shim.js) does the wiring, and `index.html` itself is unchanged.

One-time setup:

1. **Database:** in Supabase, open SQL Editor, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It creates the `players` table, the access rules (everyone reads, each player writes only their own row) and live updates. Then run [`supabase/groups.sql`](supabase/groups.sql) the same way for groups: invite-link groups whose names, members and codes only their members can see (up to 10 groups per player, 50 players per group). Both files are safe to run again.
2. **Sign-in links:** in Supabase → Authentication → URL Configuration, set **Site URL** to the site's address (e.g. `https://trivialranks.vercel.app`) and add it under Redirect URLs as `https://<your-site>/**`. If you want sign-in on preview deployments too, also add their exact address pattern from Vercel → Deployments. Never add a bare `https://*.vercel.app/**`, because that would let any Vercel site receive your sign-in links.
3. **Keys:** in Vercel → Settings → Environment Variables, check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` exist (the Supabase integration adds them). The build only accepts the public anon/publishable key and refuses a secret one.

Every push to `main` then deploys.

**Build it locally against Supabase** (needs Node):

```
cp .env.example .env.local     # then paste your Supabase URL and anon/publishable key
node build.mjs --serve         # builds dist/ and previews at http://localhost:3000
```

To sign in on the preview, add `http://localhost:3000/**` to Supabase → Authentication → URL Configuration → Redirect URLs. `.env.local` is git-ignored.

### On claude.ai

**The shared board needs claude.ai.** The page was built as a claude.ai artifact, and it uses that platform's built-in database and sign-in (`window.claude.use('db')` and `window.claude.use('user')`) to share players and results. Opened as a plain file or from other hosting (without the local server above), it shows "Not connected": results stay on that device, and there is no shared leaderboard.

## Plan

[`docs/app-plan.md`](docs/app-plan.md) covers the full design: capture flow, parsers, scoring, levels, groups, and the planned Next.js + Supabase stack that would let the shared board run outside claude.ai.
