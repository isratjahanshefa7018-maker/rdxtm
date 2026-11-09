# AXIION DMS — Setup (v5.17.0)

## 1. Supabase — database  ⚠️ read this first
There are TWO SQL files. Use exactly one of them:

| Situation | File to run | Effect |
|---|---|---|
| **Brand-new Supabase project** (empty) | `schema_fresh.sql` | Creates everything: tables, indexes, functions, triggers, policies, seed data, photo bucket. |
| **Already running / has real data** | `migrations/001_v5_1_fixes.sql` (if coming from before 5.1), then `migrations/002_v5_11.sql` (from 5.1–5.10). **From 5.16.x → 5.17.0: run `migrations/003_v5_17.sql` once (adds the sale-return type), then redeploy.** | Add only the new changes. Safe to run more than once. Never deletes data. |

`schema_fresh.sql` begins with a safety stop: if the database already contains
sales/transactions it refuses to run (the old `schema.sql` dropped tables and wiped data).
Even so — **never run `schema_fresh.sql` on production**, and take a backup first
(Supabase → Database → Backups, or `pg_dump`) before running any migration.

The app keeps working if the migration has not been run yet (every new database function
has an identical JavaScript fallback), but it will be slower and the stock guard / audit log /
idempotency features stay off until the SQL is run.

## 2. Supabase — Storage (product/staff photos)
**Update:** `schema_fresh.sql` now creates the public `thumbs` bucket automatically. The manual steps below are only needed if that statement fails on your project.

The app uploads product and staff profile photos to Supabase Storage, not
the database. Create the bucket manually — `schema_fresh.sql` can't do this part:

1. Supabase dashboard → **Storage** → **New bucket**
2. Name it exactly `thumbs` (the code has this name hardcoded)
3. Toggle **Public bucket** ON — photos are served as plain public URLs,
   no signed-URL logic exists in this codebase
4. Nothing else to configure — no folders or policies needed beyond
   "Public"

## 3. Vercel — environment variables
The build succeeding does not mean the app can reach the database — the API
needs two environment variables set in Vercel (Project → Settings →
Environment Variables), not a "password":

| Name                   | Where to find it in Supabase                          |
|------------------------|---------------------------------------------------------|
| `SUPABASE_URL`         | Project Settings → API → Project URL                    |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → Project API keys → `service_role` |

Optional but recommended: `CRON_SECRET` (any long random text). Vercel then sends it
automatically as `Authorization: Bearer …` to the nightly report cron. It is no longer
accepted in the URL.

Add them, then redeploy (env var changes don't apply to a build already in
progress).

## 4. GitHub / Vercel deploy
Push this folder to your repo and let Vercel auto-deploy, or drag-and-drop
the folder directly on Vercel. No other config changes are needed.

## 5. Serverless function limit (Vercel Hobby plan)
Hobby caps a deployment at 12 Serverless Functions. This project has
exactly 12 route files under `api/` (helper files under `api/_lib/` don't
count — Vercel excludes underscore-prefixed folders). If you add a new
`api/*.js` route later, merge it into an existing file (dispatch on
`?action=`) instead of adding a 13th file, or upgrade to a Pro/team plan.

## 6. First login
The schema seeds one login:

- Username: `owner`
- Password: `12345`

You'll be forced to set a new password on first login.

> **Older version notes below are historical.** Wherever they say `schema.sql`, use `schema_fresh.sql` (new install only) or `migrations/` (existing data) as described in section 1.

## 7. What's new in 4.7.0
`schema.sql` already includes everything (new `return_company` transaction type, order
columns, and the 35 default products). Nothing else to run.

- SO order / manager or owner "give" -> straight to the DSR's load list. The DSR presses
  "সম্পন্ন" after loading and stock is deducted at that moment. No approval steps.
- Orders tab and Approvals page show every order read-only (who, what, ordered vs loaded, times).
- Transactions -> "কোম্পানিতে ফেরত": removes stock only (blocked if it exceeds current stock).
- Still 12 API files.

## 8. What's new in 4.8.0
It adds 3 tables (`due_collections`, `damage_collections`, `dsr_settlements`) and allows manager
settlements in the approval queue. **Fresh installs:** `schema.sql` already contains everything.
Still 12 API files (new logic lives inside `sr-payments.js`, `shops.js`, `due-calendar.js`, `_lib/db.js`).

- **Van-stock cap.** A DSR can never sell more than is on his van. The quantity boxes clamp to the
  remaining van stock and the server (`shops.js` visit-sale) rejects any over-sale.
- **হিসাব/পেমেন্ট (owner/manager) — end-of-day settlement.** Pick DSR + date: cash, unsold return, damage,
  commission and discount are calculated automatically. One press applies it; pressing again cannot
  double-count (unique token + only "not yet settled" amounts are ever shown). Cash short of the expected
  amount simply stays in the DSR's due; collect it later with "শুধু নগদ জমা". Manager settlements go to
  the Owner's approval queue.
- **Unsold van stock** is returned to the warehouse automatically as a normal "ফেরত" transaction.
- **DSR menu: 📥 বাকি আদায়** — every shop with due (details, phone, road), collect any amount.
  Collected cash is added to that day's settlement automatically.
- **DSR menu: ⚠️ ড্যামেজ কালেকশন** — take damaged goods back from a shop and either pay the shop money
  or swap for a product from the van. Money paid out is deducted from the DSR's expected cash; both
  options count as damage in the settlement and open a pending claim in the Damage Report.
- **Owner/Manager tab 📥 আদায়** — see what each DSR collected (dues + damage) with shop details.
- **Road on shop registration** — the DSR's own registration form now has the Road field too, and the
  server refuses a shop without a road.

## 9. What's new in 4.8.1 — menu layout only (no SQL, no API change)
- New main-menu item **🧮 দিনশেষ হিসাব** (Owner + Manager, right under the Home tab). It holds
  **হিসাব/পেমেন্ট** (end-of-day settlement) and **বাকি পেমেন্ট** (due & damage collected by DSRs) as icon tiles.
- The **DSR/SO** page now has only icon tiles: 👥 তালিকা, ➕ যোগ করুন, 🛣️ রোড (add/delete/assign road stay here).

## 8. What's new in 4.9.0 — DU fix, 1000-row fix, speed
**Run the full `schema.sql` in the Supabase SQL editor.** The new v4.9 function and indexes are at the very bottom of it (they use `CREATE OR REPLACE` / `IF NOT EXISTS`). The app still works without them, just slower.

- One shared due calculation (`getDueTotals`) for Owner / Manager / SO / DSR — same DU everywhere. Uses a Postgres SUM (`dsr_due_totals`) instead of downloading all history.
- `fetchAll` now orders by `id` as a tiebreaker and loads pages in parallel (fixes rows skipped/repeated at page boundaries → the "sometimes wrong" DU).
- Shop list, duplicate-name check, due calendar, payment lists, reports: no more silent 1000-row cut-off.
- "Today" on SO/DSR dashboards now follows Asia/Dhaka time (was UTC).
- Owner bonus card loads only the give-history it needs; shop list paints 200 rows at a time; identical simultaneous GETs are merged; app shell revalidates instead of full re-download.
- Still 12 API files.

## 9. What's new in 4.9.1 — no database change needed
- **Owner/Manager → দিনশেষ হিসাব → 📥 বাকি পেমেন্ট:** every due collection now shows the **time** (Bangladesh time), shop, amount and a **📞 কল** button, grouped by DSR with a shop count and total ("N টি দোকান থেকে M বার আদায়").
- **Owner/Manager dashboard → 🏅 সেরা ৫০ দোকান:** top 50 shops by buying and payment behaviour (period + sort selectable), each with a one-tap call button. Loads only when the card is opened. Backed by `api/shops.js?action=top-shops`.
- Still 12 API files; `schema.sql` unchanged from 4.9.0.

## 6. Box-based sales targets
Sales targets are BOX-based (1 box = 1 full case of any SKU) alongside the money target. The `targets` table in `schema.sql` already includes the `target_boxes` column — running `schema.sql` once (section 1) is all that is needed. No separate migration file.

## 10. What's new in 5.0.0 — Shop Ledger (📒 লেনদেন খাতা)
Every shop now has a full transaction page. Open any shop (Owner / Manager / SO: **দোকান ও লোকেশন → shop**; DSR: **shop → detail**) and press **📒 লেনদেন খাতা**.

- **Top card:** current due, total given, total paid, number of memos.
- **চলমান মেমো (live memo):** starts with the first sale after the due was zero. It lists, in time order, every bill (date + time, slip, who delivered, total, cash paid, due added) and every later due collection (date + time, collector, which bill it paid) with the running due after each line.
- **Tap a bill** → every product with cases/pieces, price, line total, commission/discount, the bill's payable, and that bill's own due breakdown (total → cash at delivery → collected later → still due).
- **Due reaches zero → the memo closes automatically** (however many days it took) and moves to **📚 আগের মেমো**. The next sale opens a fresh memo. Tap any old memo to see its whole timeline.
- Damaged goods taken back (money/exchange) and point-sale returns appear as information lines and never change the due.
- The ledger's final due always equals the "মোট বাকি" shown everywhere else.

**Database:** run the full `schema.sql` in the Supabase SQL editor. The only changes in 5.0 are one new column (`due_calendar.tx_id`) and a few indexes (bottom of the file). Note: `schema.sql` drops and recreates tables, so it wipes existing data.
Older dues without `tx_id` are matched to their sale automatically (same shop + date + amount), so existing history appears in the ledger immediately.

Still 12 API files — the ledger lives inside `api/shops.js` (`action=ledger`, `action=ledger-sale`).


---
## 11. What's new in 5.1.0 — calculations, free-tier speed, safe deploy
Full list: `CHANGELOG.md`. Highlights:

**Calculations**
- **Net profit** (`নীট লাভ`) is now ONE definition on every screen:
  `revenue − cost of goods − commission − discount − damage loss − shop bonus − expenses`.
  Each deduction can be switched on/off in ⚙️ Settings → "হিসাব ও স্টক নিয়ম".
  The report shows the whole breakdown. The per-product / per-date tables still show *gross*
  profit (marked `*`).
- Prices and costs are read from the products table **on the server**; numbers sent by the
  phone are ignored. Money is rounded per bill line to 2 decimals and whole cases use the case price.
- Bonus rules are stored on each sale row, so changing a product's bonus later no longer rewrites old bonus.
- **Van stock carries over across days** (a DSR's unsold stock from yesterday still counts today).
  ⚠️ If, before this update, DSRs never returned/settled old stock, those old loads will now show
  up as stock still on the van. Do one settlement/return round after deploying to clear them.
- Every money-writing request carries a `requestId`; a double tap / retry / second tab is answered
  with the first result instead of recording twice.
- Sales that touch several tables (shop sale + due + visit) are saved in one database transaction.
- **Stock guard**: giving/selling more than is in stock is refused (toggle in Settings). The check is
  also inside the database trigger, so two people at once cannot both succeed.
- Edits/deletes of dues and similar changes are written to `audit_log`.
- Due "mark cleared" now records a real payment for the remaining balance (shows in the collections log).
- Dates use the Dhaka calendar day (no more wrong date between 00:00–06:00).

**Free-tier performance**
- Totals are computed inside Postgres (functions `sales_summary`, `sr_sales_totals`, `shop_due_totals`, …)
  instead of downloading thousands of rows into the serverless function.
- Lists have explicit columns, optional paging, DB-side search and `openOnly` filters.
- GPS ping every ~3 min (was 60 s) and only when moved ~50 m (heartbeat every 10 min);
  chat polling 20 s with `?since=` and paused while the tab is hidden.
- Nightly cron processes SOs 3 at a time and logs to `cron_runs` (`/api/report?action=cron-status`).

**Deploy**
- `vercel.json` now uses `rewrites` (the old `routes` + `headers` combination is invalid on Vercel).
- Still exactly 12 files in `api/`.
- Keep the Supabase keep-alive/cron ping you use (free projects pause after 7 idle days) — nothing here replaces it.

**Not changed on purpose:** the PIN/login system (SEC-1…4 of the audit plan) is untouched as requested.
Known note: damage loss is the `total_cost` stored on each damage claim (purchase-cost based).


## 12. What's new in 5.12.0 (no SQL needed)
- **বিক্রয় প্যানেল** turns **green** for a logged-in SO once that day's calculation (returns taken, day-end settlement) is closed; **red** otherwise and for every other role. See `CHANGELOG.md`.
- **SO home** shows my sale and every other SO's sale of today with a closed/open chip.
- **ডিউ ক্যালেন্ডার**: the due left after a partial payment is red.
- Still exactly 12 files in `api/`.
