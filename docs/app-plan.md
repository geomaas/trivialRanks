# Trivia Leaderboard — App Plan

Nov 9, 2026 · @Geoff

## Concept & goals

One leaderboard for the daily trivia games: players log their results from MapTap, Wordle, Catfishing and others, and the site turns them into a single cross-game "trivia rating" plus per-game standings.

**Who it's for:** friend groups who already paste results into a group chat, then the wider public once it works.

**MVP scope (v1):**

- Accounts and private groups ("leagues") with an invite link
- Paste-to-submit for 3 games: MapTap, Wordle, Catfishing
- Daily, weekly and all-time boards per game, plus a combined rating
- Streaks and simple player profile pages

**Not in v1:** world rankings pulled from the games themselves, a mobile app, prizes.

## The data problem: capture, don't scrape

Scraping won't get you far, because these games keep your score on your own device, not on a public page. Wordle-style games save progress in the browser's local storage or the app, and the results page lives on your screen only. A server-side scraper visiting maptap.gg sees a blank game, not your 940.

What every one of these games *does* give you is a **share text**, built for group chats. That text is the integration point.

| Approach | How it works | Effort | Verdict |
| --- | --- | --- | --- |
| Paste share text | Player taps Share in the game, pastes into our site; a parser reads it | Low | **v1 core** |
| Share-sheet / PWA share target | Our site installs as a PWA; players share straight to it from the game | Low–medium | v1.5, removes the copy-paste step |
| Browser extension | Reads the game's results from the page or local storage after you finish, submits automatically | Medium–high | v2, more trustworthy data |
| Group-chat bot | A Discord/Telegram bot reads results people already post | Medium | v2, zero behaviour change for groups |
| Scraping public leaderboards | Fetch world/global boards if a game publishes them | Varies | Only with permission; fragile and may break terms of service |

World rankings from the games themselves are mostly out of reach without the developers' cooperation. Several of these are small indie projects, so emailing them for an export or a partnership is realistic.

## Capture with the fewest taps

The best low-effort setup is a game launcher on our site plus a one-tap **Paste result** button, with a text-message number and share-sheet shortcuts as backups. An iframe won't work.

**Why not an iframe:** many sites forbid being embedded at all (the X-Frame-Options or frame-ancestors security headers). Even when one loads, the browser's same-origin rule blocks our page from reading anything inside it: not the score, not its storage, not what it copies. So an iframe could only show the game, never capture it.

| Method | What the player does | Taps after finishing | Works on | Build effort |
| --- | --- | --- | --- | --- |
| Launcher + Paste button | Opens the game from our site, taps Share in the game, switches back, taps **Paste result** | 3 | Everything | Low (v1) |
| Text it to us | Taps Share → Messages → our saved contact → Send; we match their phone number | 3–4 | Every phone | Low (v1): SMS service such as Twilio, small per-message cost |
| Android share target | Taps Share → picks our installed web app; submitted automatically | 2 | Android Chrome only | Low (v1.5) |
| iOS Shortcut | Taps Share → "Send to Trivia Board" shortcut; it posts the text to our site | 2 | iPhone (one-time Shortcut install) | Low (v1.5) |
| Browser extension | Nothing: it spots the finished result on the game page and submits it | 0 | Desktop Chrome/Firefox/Edge; Safari via an App Store wrapper | Medium (v2) |
| Native app with share extension | Taps Share → our app icon | 2 | iPhone and Android | High: App Store apps |
| Group-chat bot | Nothing new: keeps posting in the group as now | 0 | Discord, Telegram (not iMessage or WhatsApp groups) | Medium (v2) |

**The v1 flow in detail:**

1. The player's home screen on our site lists today's games, each marked done or not yet.
2. Tapping a game opens it in a new tab and records the start time (useful for cheat checks).
3. They play and tap the game's own Share button, which copies the result.
4. When they switch back, our page shows one big **Paste result** button. It reads the clipboard (the browser asks permission once; on iPhone a small Paste bubble appears) and works out which game the text came from.
5. A confirm card shows the parsed score; one tap saves it, or it saves automatically after 3 seconds.

The player never has to say which game a result is from, because the parser recognises it, so the same Paste button and text number work for every game. Installing the site to the home screen (a PWA) makes this feel like an app without an App Store listing.

## Supported games & parsers

Each game gets a small parser plugin: a regex that recognises its share text and pulls out the puzzle ID, date and score. New games are added by writing one file.

| Game | Share text looks like | Parse out | Raw score range |
| --- | --- | --- | --- |
| [MapTap](https://maptap.gg/faq) | `www.maptap.gg June 18` then five per-round scores with emoji, then `Final score: 828` | date, 5 round scores, final | 0–1000 (5 × 0–100, plus bonuses) |
| Wordle | `Wordle 1,234 4/6` + emoji grid | puzzle #, guesses (X = fail), hard-mode `*` | 1–6 or fail |
| [Catfishing](https://catfishing.net/help) | `#624 - 5/10` + rows of 🐈 (right) and 🐟 (wrong) | puzzle #, score (half points allowed) | 0–10 |
| Later candidates | See the game catalogue below | per game | per game |

**Parser rules:**

- Store the raw pasted text alongside the parsed result, so parsers can be fixed and re-run later.
- Map puzzle number or date to a canonical "game day" so everyone's results line up.
- Reject results for days that haven't happened yet, and allow late entries for only a short window (say 48 h).
- Recompute totals from the per-round numbers where the format allows it (MapTap rounds, Catfishing emoji) and flag mismatches.

## Game catalogue by knowledge area

These are all free to play daily in a browser. Several also have paid extras (archives, apps, packs) that we ignore. Pick one or two per area so the overall rating rewards broad knowledge, not just one specialty. Check each game's exact share text before writing its parser; the score shapes below come from each game's own description.

| Area | Game | How it plays | Score shape | Priority |
| --- | --- | --- | --- | --- |
| Open-ended trivia | [Krillion](https://www.thewordfinder.com/misc-solvers/krillion-answers/2026-10-29/) (krillion.io) | 7 prompts like "Name a pasta dish", 25 seconds each; rarer valid answers score more | 0–700 points (10/30/60/85/100 per prompt) | **v1.5** |
| Music | [Bandle](https://apps.apple.com/az/app/id6471419531?l=en-gb) | Guess the song as instruments are added one at a time, 6 tries | Instruments needed, 1–6 or fail | **v1.5** |
| Film | [Framed](https://screencrush.com/wordle-for-movies/) (framed.wtf) | Guess the movie from stills; each wrong guess shows another frame, 6 tries | Frames needed, 1–6 or fail | **v1.5** |
| Film | [Actorle](https://www.pcgamesn.com/wordle/games-like) | Guess the actor from a list of their movies, 8 tries | Guesses, 1–8 or fail | Later |
| History | [TimeGuessr](https://gigazine.net/gsc_news/en/20230821-timeguessr) | 5 historical photos; guess the year and pin the place | Up to 10,000 per photo (5,000 year + 5,000 place) | **v1.5** |
| Geography | [Worldle](https://worldle.teuteuf.fr/) | Guess the country from its outline, 6 tries | Guesses, 1–6 or fail | Later (overlaps MapTap) |
| Geography | [Globle](https://faqs.nerdlegame.com/game_categories/geography-and-science-games.html) | Guess the country; each guess shows hotter or colder on a globe | Guess count, no cap | Later |
| Art | [Artle](https://www.smithsonianmag.com/smart-news/new-daily-game-like-wordle-for-art-180980083/) (National Gallery of Art) | Guess the artist from their works, 4 tries | Guesses, 1–4 or fail | **v1.5** |
| Science | [Elemendle](https://github.com/suio03/elemendle) | Guess the chemical element from its periodic-table properties | Guesses | Later |
| Sports | [Immaculate Grid](https://www.sports-reference.com/blog/2023/07/sports-reference-acquires-immaculate-grid) (Sports Reference) | Fill a 3×3 grid with players matching row and column clues, 9 guesses; baseball, football, basketball, hockey, soccer | Squares right (0–9) plus a rarity score | **v1.5** |
| General | [Daily Trivia Quest](https://www.producthunt.com/products/daily-trivia-quest/makers) | 5 questions from categories you choose | Correct, 0–5 | Later (players choose categories, so results aren't comparable) |

**Share check (as of Nov 9, 2026):**

| Share support | Games |
| --- | --- |
| Confirmed: copies a text snippet | Wordle, MapTap, Catfishing, [Artle](https://www.smithsonianmag.com/smart-news/new-daily-game-like-wordle-for-art-180980083/), [Worldle](https://studyabroad.ucmerced.edu/content/worldle-geography-themed-wordle-daily-game), [Framed](https://www.gfinityesports.com/framed/clue-hints/), [Daily Trivia Quest](https://www.producthunt.com/products/daily-trivia-quest/makers) |
| Shares a link, not a full score | [Immaculate Grid](https://immaculategrid.com/share/RH5dCQT): the link opens a public share page with the grid number; we'd read the score from that page |
| Shares, but only basic info | TimeGuessr: someone built a [Firefox add-on](https://addons.mozilla.org/sv-SE/firefox/addon/timeguessr-detailed-score) to copy a detailed score, which suggests the built-in share is minimal |
| Not confirmed yet | Krillion, Bandle, Actorle, Globle, Elemendle: play once and tap Share to check |

**Music note:** the original Heardle was [bought by Spotify](https://newsroom.spotify.com/tag/daily-music-game) and is now [listed as discontinued](https://alternativeto.net/software/heardle/about), so Bandle is the music pick. Krillion's maker also runs a [family of daily games](https://webiano.digital/noillirks-name-is-its-sibling-game-spelled-backwards-and-so-is-its-rule/) that includes a music-recognition game and Noillirk, where the most common answer wins. Worth a look once we confirm it has a daily, shareable score.

**Scoring fit:** most of these are "fewer guesses is better" games like Wordle, so one generic guess-count parser covers Bandle, Framed, Actorle, Worldle and Artle. Krillion, TimeGuessr and Immaculate Grid need their own parsers.

## Categories, sub-boards & daily spider chart

Our own six categories with plain names, each with its own color. Each category is also a **sub-board**: set aside for now to keep the interface simple; games are still grouped by category on the Games tab. Eight counting games, grouped into three levels below, feed the spider chart; the rest are bonus games that don't count toward points for now.

| Category | Color | Official game | Other games on the sub-board |
| --- | --- | --- | --- |
| Words | Teal | Wordle | Quordle, Octordle, Waffle |
| Places | Blue | MapTap | Worldle, Globle, Travle |
| Screen & Sound | Magenta | Framed | Actorle, Artle (Bandle counts at Gold) |
| History | Amber | TimeGuessr |  |
| Sports | Orange | Immaculate Grid |  |
| General Knowledge | Purple | Catfishing and Krillion, both every day (two spokes) | None yet |

**Spider chart:** one spoke per category, 0–100 each, toggling between **% of max** and **vs players**. Each label links to that day's official game. Unplayed categories sit at 0 with a hollow dot; a dashed outline shows the group average.

**Daily points:** the level's games added up: Bronze out of 300, Silver out of 500, Gold out of 800. Standings show a row of seven category dots, filled for each category played.

## Levels

Three nested levels, so nobody has to play every game every day. The standings follow whichever level is selected: everyone who played that level's games, ranked by points on just those games, with players who haven't finished all of them shown faded and unranked below.

| Level | Games | Adds | Points |
| --- | --- | --- | --- |
| Bronze | 3 | Wordle, MapTap, Framed | out of 300 |
| Silver | 5 | Catfishing, TimeGuessr | out of 500 |
| Gold | 8 | Krillion, Immaculate Grid, Bandle | out of 800 |

- **Ranked:** you're ranked once you finish the 3 Bronze games that day; anyone partway through shows under "Still playing."
- **Spider chart:** shows one level at a time: a triangle for Bronze's 3 games, a pentagon for Silver's 5, an octagon for Gold's 8. It opens on your highest level finished; tapping a level card switches to that level. Game names and points are colored by the tier they belong to, and the shape is dashed until that level is finished.
- **Level cards:** three cards above the chart show your points for each level finished, or how many of its games you've played.
- **Weekly board:** uses the same level as Today and averages points over the days each player finished it, so skipping a day doesn't hurt.

## Profile & stats pages

Two buttons in the header, next to the date, open full pages with a Back button.

- **Profile:** display name (editable), playing-since date, the groups you belong to, and appearance (follow the phone's setting, light or dark; phone setting is the default).
- **History & stats:** counts of Gold, Silver and Bronze days; current and best streak (days finishing at least Bronze); a 30-day bar chart of daily points, colored by the level finished; a per-game table with games played, best result and average % of max; and a day-by-day history list.

**Interface cleanup (after review):** one color system (tier colors; categories are plain text labels); the Games tab is grouped Bronze / Silver adds / Gold adds / Bonus, replacing the separate level-progress bars; the paste box collapses to a button once you've logged something that day; a Back to you link appears when viewing someone else's chart.

## Scoring & ranking model

Rank people by how they do *compared with everyone else on the same puzzle*, not by raw score. Otherwise a 3/6 Wordle and a 940 MapTap can't be compared, and hard days unfairly punish everyone.

1. **Normalise each result per game-day.** Turn each raw score into a percentile among all of that day's submissions (or a z-score once there are enough players). Example: 900 on a hard MapTap day might be the 95th percentile.
2. **Fill thin days with a prior.** Early on there won't be many players per day, so blend in a fixed baseline curve for each game until there are about 30 submissions.
3. **Combine into a rating.** Each player gets an Elo/Glicko-style rating per game, updated daily as if they'd "played" everyone else who did that puzzle. The overall trivia rating is a weighted average across games.
4. **Reward consistency, not volume.** Skipping a day shouldn't hurt much and playing 10 games shouldn't beat playing 3 well. Rating uncertainty (Glicko's deviation) handles this: inactive players' ratings become less certain and drop off the main board.

**Boards to show:** today per game, this week, all-time rating, overall trivia rating, longest streak. Groups see the same boards filtered to members.

**Decided: show both.** Updated after review: one official number. Each game scores your percentile among everyone who played it that day (100 = best), falling back to % of the best possible score when fewer than 3 people played it. Raw scores (940, 3/6) still show next to each game, and Stats shows your average % of max, but there's no toggle that changes rankings.

## Login

Start with **Sign in with Google** plus an **emailed sign-in link** for anyone without Google, both through Supabase Auth. No passwords to forget, and every result is tied to a real account from day one.

- **First sign-in:** pick a display handle; that's all the profile there is in v1.
- **Stay signed in:** long-lived sessions so phone users rarely see the login screen again.
- **Email delivery:** Supabase's built-in email sender is throttled on the free plan, so sign-in emails can arrive late or not at all. Hook up a proper email service (custom SMTP, such as Resend) before inviting friends.
- **Free-plan pause:** free Supabase projects pause after a week with no activity. A daily game board won't sit idle, but it matters during development breaks.
- **Later:** Discord sign-in if a Discord group bot happens; phone-number sign-in would pair with the text-it-in option but costs money per text.

## Boards & groups

Every result counts on the **public global board** and on every group the player belongs to; a result is logged once and shows up everywhere it applies.

| Board | Who sees it | Who's on it | How you join |
| --- | --- | --- | --- |
| Global | Anyone, signed in or not | Every player (with an opt-out to hide your name) | Automatic |
| Public group | Anyone can view and find it in a group directory | Members only | Join button, or owner approval if set |
| Private group | Members only | Members only | Invite link or code from the owner |

- **Creating a group:** any signed-in player; they become its owner and can rename it, make admins, remove members and reset the invite link.
- **Limits for v1:** a player can join up to 10 groups; groups can't change scoring rules yet, so every board uses the same 700-point daily total.
- **Group view:** the same Today, Games and This week tabs, filtered to members, with the dashed spider-chart average becoming the group average.
- **Privacy:** private groups' member lists and scores are hidden by database row-level security, not just the interface.

## Architecture & JS stack

One full-stack TypeScript app plus a managed Postgres database is enough for v1; there are no scrapers to run or babysit.

&#91;embedded content: system architecture · capture, app, database, nightly job\]

Share text goes through the parser plugins into Postgres; a nightly job recomputes percentiles and ratings, and the leaderboard pages read the results.

| Layer | Pick | Why |
| --- | --- | --- |
| Framework | Next.js (React + TypeScript), decided | Pages and API routes in one codebase |
| Database | Postgres on Supabase | Relational data, generous free tier, row-level security for private groups |
| ORM | Drizzle or Prisma | Typed queries and migrations |
| Auth | Supabase Auth: Sign in with Google, plus an emailed sign-in link as backup | Same service as the database, so each account links straight to its results; free up to 50,000 monthly active users |
| Hosting | Vercel: free Hobby plan while it's a personal, non-commercial project; Pro ($20 a month) if it ever makes money | Deploy on git push, free to start |
| Scheduled jobs | Vercel Cron (once a day on the free plan, which fits a nightly job) | Nightly rating recompute |
| Parsers | Plain TypeScript regex modules | Unit-tested against real pasted share texts |
| Charts | Recharts or Chart.js | Rating history on profiles |
| Extension (v2) | Manifest V3 browser extension in TypeScript | Reads results from the game page after you finish |
| Bot (v2) | discord.js | Picks up results posted in group channels |

## Data model

Seven tables in Postgres cover v1.

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, handle, avatar, created\_at | One row per Supabase Auth account; handle picked at first sign-in |
| `games` | id, slug, name, score\_direction, parser\_version | `score_direction`: higher-better (MapTap) or lower-better (Wordle guesses) |
| `game_days` | id, game\_id, puzzle\_no, date | One row per puzzle; unique (game\_id, puzzle\_no) |
| `results` | id, user\_id, game\_day\_id, raw\_text, raw\_score, details (JSON), percentile, submitted\_at, source | Unique (user\_id, game\_day\_id): one result per puzzle; `source` = paste, share-target, extension |
| `ratings` | user\_id, game\_id (null = overall), rating, deviation, updated\_at | Recomputed nightly |
| `groups` + `group_members` | group id, name, slug, visibility (public or private), invite code, owner; member user\_id, role (owner, admin, member) | Private leagues |

## Anti-cheat & trust

Pasted text is easy to fake, so treat v1 as an honour system with guardrails, and grade trust by how a result arrived.

- **One result per puzzle per player**, locked once submitted; no edits.
- **Submission window:** a result must arrive within about 48 h of the puzzle date.
- **Consistency checks:** totals must match the per-round numbers or emoji; impossible values are rejected.
- **Statistical flags:** a player suddenly far above their own history, or at the 99th percentile every day, gets flagged for review and hidden from public boards until cleared.
- **Trust tiers:** results from the browser extension (read from the game page itself) rank as "verified"; pasted ones as "self-reported". Public boards can filter to verified only.
- **Groups as a check:** in private leagues, friends police each other, which is how it already works in group chats.
