# CLAUDE.md

Guidance for Claude Code (desktop, web or mobile) working in this repo.

## What this is

Kitchen — Kostas's meal planner. You keep recipes in it, tick the ones you want
this week, and it gives you back a single deduplicated shopping list grouped by
aisle, plus a step-by-step cook mode with the recipe's YouTube video.

The shopping list is the point. Recipes are the substrate that makes it
possible, not the feature.

Static site, no build step, no package.json, no dependencies. One page:

- `index.html` — the whole app (sign-in required). Vanilla JS/CSS/HTML talking
  to Supabase REST/Auth over `fetch`.

Verify changes by opening the file in a browser (e.g. `python -m http.server` in
the repo root, then `http://localhost:8000/`). Localhost talks to the real
database — there is no separate test backend.

## Deployment

GitHub Pages from `main`, repo root → `https://costgal.github.io/kitchen/`.
Pushing to `main` deploys (takes ~1 min). All asset URLs must stay **relative**
(`manifest.json`, not `/manifest.json`) because the site lives under `/kitchen/`.

### Beta and sandbox are separate

Kitchen has no beta repo yet. When it gets one, the rule that already applies to
Ledger and Overtime applies here too: **never copy a change into the beta unless
Kostas explicitly says to push to the beta.** The two repos would carry nearly
the same files, which makes "and sync the beta" look like the obvious last step
of any piece of work. It isn't. The sandbox is where things get tried; a beta
has other people on it, and a change landing there lands on their data. Finish
the work here, say plainly that the beta has *not* been updated, and wait to be
asked. The same goes the other way: the two are allowed to drift, and drift is
not a bug to fix on sight.

## Backend

Supabase project `dgnxbcoxdpdloplkcmzs` — the same personal project as Ledger's
sandbox and Overtime, so **the login is the same account as both**. The free
plan is at its 2-project limit, which is why all three share it. Every table
here is prefixed `mp_` so they never collide with Ledger's (`entry_types`,
`logs`, `reflections`, `allowed_emails`) or Overtime's (`ot_*`). Don't touch
either of those.

Schema lives in `supabase/schema.sql` (reference copy; it was applied as the
migration `kitchen_app_schema`). Schema changes: apply via the Supabase MCP
(`apply_migration`) and update `supabase/schema.sql` in the same commit.

- `mp_items` — the ingredient catalogue. `name`, `aisle`, `unit` (a default,
  offered when you pick the item). Unique on `lower(btrim(name))` per user, so
  "Olive Oil" can never become a second row alongside "olive oil" and split a
  shopping line in two.
- `mp_recipes` — `title`, `servings` (the base the ingredients are written for),
  `minutes`, `video` (a **YouTube id**, never a URL), `steps text[]`, `note`.
- `mp_recipe_items` — one ingredient line: `recipe_id`, `item_id`, `name`,
  `qty`, `unit`, `pos`. `name` is denormalised next to `item_id` on purpose —
  deleting a catalogue entry must never blank an ingredient in a saved recipe.
- `mp_basket` — what you've decided to cook. Primary key `(user_id, recipe_id)`,
  so adding the same recipe twice is idempotent. `servings` is what you want
  this week, which may differ from the recipe's base.
- `mp_extras` — things no recipe asked for (bin bags, coffee).

RLS on every `mp_*` table: `user_id = auth.uid()`. The publishable key in the
HTML is meant to be public. Nothing here is reachable by `anon`.

## The shared session

Ledger, Overtime and Kitchen are all served from `costgal.github.io`, so they
share one `localStorage`. The session key is derived from the **Supabase
project**, not the app name — `costgal_session_<ref>`, with `<ref>` parsed out
of `SB_URL` (`SB_REF`). Signing into any one of the three signs you into all
three, which is the point: it used to be three separate sign-ins for one
account.

Deriving it from `SB_URL` is what keeps a beta safe without a flag anyone has
to remember. A deploy pointed at a different project lands on a different key,
so a tester's session can never be read as a sandbox session. Copy the repo for
a beta and the isolation comes along for free.

Three pieces make it hold together, and none of them is optional:

- **`rotatedSession`.** Supabase rotates the refresh token on every use, and
  three apps now share one token. If a sibling refreshes while our request is
  in flight, ours comes back `invalid_grant` even though a good session was
  just minted. Before treating a failed refresh as signed-out,
  `refreshSession` waits briefly for the rotated session to appear in
  `localStorage` and uses that. Without it, having two apps open means one of
  them gets dumped at the sign-in screen. It waits on the `storage` **event**
  with a poll as backstop, not a poll alone — `setTimeout` is throttled to
  seconds in a background tab.
- **`e.offline`.** A failed refresh flags whether the cause was the network
  rather than the server. `api()` only discards the session when it wasn't —
  a dropped connection is not a sign-out.
- **The `storage` listener** (bottom of the file, next to `boot`). Signing in
  or out in one app is picked up by the others straight away rather than
  surfacing later as a confusing 401. Token rotation writes the same key, so it
  only reboots on a real change, and calls `resetData()` first so the next
  account can't see a frame of the previous one's recipes.

`OLD_SESS_KEY` (`kitchen_session`) is adopted once on load and then deleted, so
the switch didn't sign anyone out. That block can go once every deploy has been
opened at least once.

`SIBLINGS` is non-empty only when the app is served from its own `/<name>/`
path — true on `costgal.github.io`, and true locally if you serve the folder
holding all three. A beta deploy sits at a host root where `../ledger/` doesn't
exist, so it gets no app switcher and no shared-account copy on the sign-in
screen.

## Privacy invariants — do not break

This repo is **public** (required for free GitHub Pages). So:

1. **No personal data in the repo.** No recipes, no shopping lists, no exports.
   The seed ingredient list in `SEED` is generic pantry staples, not anybody's
   data — keep it that way.
2. **No API keys beyond the publishable Supabase one.** In particular: the app
   never calls the YouTube Data API. It stores an id you pasted and embeds it.
   If a feature ever needs a real key (parsing a recipe with an LLM, searching
   YouTube), the key goes in a Supabase Edge Function secret and the app calls
   the function — the key never enters this repo.
3. **Nothing is shared.** Unlike Overtime, this app has no public view and no
   `security definer` RPC. Keep it that way unless asked.

## How the shopping list is computed (`shopList`)

1. Each basket recipe is scaled by `basket.servings / recipe.servings`.
2. Ingredient lines are merged by `lower(name)` across every recipe.
3. Quantities are summed **per unit family**. Only mass (`g`/`kg`) and volume
   (`ml`/`l`) convert — see `FAM`. Everything else (tbsp, cloves, tins,
   bunches) is summed per exact unit and rendered side by side: "Garlic —
   2 cloves + 1 tbsp". **Do not invent conversions between those.** There isn't
   one, and a wrong number on a shopping list is worse than two right ones.
4. Ingredients with no quantity ("salt", "olive oil") still appear, without a
   number.
5. Lines are grouped into `AISLES`, whose order is the walk through the shop,
   not the alphabet.

Ticked-off state lives in `localStorage` (`kitchen_checked`), not the database —
it's per-shop and disposable, and a table would cost a round trip per tap.

## Architecture (index.html)

Mirrors Ledger's and Overtime's conventions:

- `el(tag, props, ...kids)` is the only DOM helper; views are built with it
  directly.
- Global state `S`. All data loads once at boot (`loadAll`) — it's small
  forever — and every calculation runs in memory. Mutate `S`, call `render()`.
- `api()` wraps `/rest/v1`, retries once on 401 after refreshing the token.
  Session in `localStorage` under the **shared** key — see below.
- Views: `renderRecipes` (cards, with a +/✓ that adds to the plan without
  opening the recipe), `renderRecipe` (detail, ingredients scaled by a servings
  stepper), `renderForm` (add/edit), `renderPlan`, `renderShop`,
  `renderSettings` (ingredient catalogue + aisles, `appSwitcher()`, sign out),
  `renderCook`.
- `appSwitcher()` is the door to the sibling apps — plain `<a href="../ledger/">`
  links styled as secondary buttons by the one `.btnrow a` rule. A shared door,
  not a merge: each app keeps its own identity.
- **`itemPicker` is the thing to preserve.** It is the whole "easy input"
  promise: type, see ranked suggestions, tap, repeat. It updates its suggestion
  list with surgical DOM writes rather than `render()`, because a re-render
  closes the keyboard mid-word. Ranking is prefix-match first, then how many of
  your recipes already use the item, then alphabetical. Anything you type that
  isn't in the catalogue is offered as "Add …" and becomes a permanent
  `mp_items` row — that's how the list learns.
- Item usage counts are **derived** from `S.ings` (`useCounts`), not stored. The
  recipes are already in memory; a counter column would be a second source of
  truth for no gain.
- `S.draft` holds the recipe form's in-progress state. It lives on `S` rather
  than in `renderForm`'s closure so a background refetch can't wipe what you
  were typing. The `visibilitychange` refetch is skipped entirely while
  `S.draft` or `S.cook` is set.
- Cook mode takes a Screen Wake Lock so the phone doesn't sleep on step 3 with
  wet hands. Locks are dropped when the page hides, so `visibilitychange`
  re-acquires it.

## YouTube

No API key, no quota, no network call to Google until you ask for one:

- `ytId()` accepts any YouTube URL shape (`youtu.be/`, `?v=`, `/embed/`,
  `/shorts/`, `/live/`) or a bare 11-char id, and stores **only the id**.
- `videoTile()` renders a flat thumbnail from `i.ytimg.com` in our own styling
  (dimmed, our border radius, our play button) and only swaps in the
  `youtube-nocookie.com` iframe once tapped.

Keep it that way. Searching YouTube for a matching video would need the Data
API, and this repo is public.

## Design invariants

Same visual language as Ledger and Overtime: black background, Futura stack,
iOS-first, 44pt+ tap targets, safe-area insets on all edges. Reuse the `:root`
variables.

- `#D97757` is the accent, as in both other apps.
- `#E5484D` stays reserved for destructive actions and errors.
- `--ok:#8FAE72` is used for **exactly one thing**: a ticked shopping line.
  Don't spend it on anything else.
- Aisles are plain uppercase rules, not colours. Ten coloured headers would be
  noise, and the list is read while walking.

Flex rows that hold text must set `min-width:0` (and ellipsis the label) —
Futura is absent on most non-Apple devices and the wider fallback will otherwise
push the page sideways.

## Icons

Generated by `tools/make_icons.py` (Pillow). Edit the script and re-run it
rather than editing the PNGs. `icon-180.png` is what iOS uses for Add to Home
Screen.

## Not built yet

Deliberately left out of v1, in rough order of what's worth doing next:

- **Dates.** The plan is a basket, not a calendar — "what am I cooking this
  week", not "Tuesday dinner". Adding days means a `date` on `mp_basket` and a
  week grid; the shopping list maths doesn't change.
- **Pantry stock** ("I already have rice"), which would subtract from the list.
- **Paste-a-recipe parsing.** A heuristic parser over pasted text, previewing
  before it writes — the same shape as Overtime's CSV import
  (`parseCsv` → preview → dedupe). An LLM version goes in an Edge Function, per
  the privacy invariants above.
