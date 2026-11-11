# trivialRANKS

A daily trivia leaderboard. Players paste the share text from daily games (Wordle, MapTap, Framed, Catfishing, TimeGuessr, Krillion, Immaculate Grid, Bandle), and the page parses each result, scores it, and ranks players across Bronze, Silver and Gold levels.

## Running it

The whole app is one file, [`index.html`](index.html). Open it in a browser to try it.

**The shared board needs claude.ai.** The page was built as a claude.ai artifact, and it uses that platform's built-in database and sign-in (`window.claude.use('db')` and `window.claude.use('user')`) to share players and results. Opened anywhere else, it shows "Not connected": results stay on that device, and there is no shared leaderboard.

## Plan

[`docs/app-plan.md`](docs/app-plan.md) covers the full design: capture flow, parsers, scoring, levels, groups, and the planned Next.js + Supabase stack that would let the shared board run outside claude.ai.
