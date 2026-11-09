# Changelog

## 5.27.0 — Session 3 (final): profit panel, dashboard, reports, role safety
**Database: no migration required** (optional `migrations/006_v5_25_offer.sql` from Session 1 still recommended). API: `dashboard.js`, `report.js`, `expenses.js`, `_lib/db.js`, `_lib/offerLedger.js` edited — still 12 API files, no new function. UI: `src/index.html`.

- **Profit panel (owner + manager).** Main figure = TOTAL profit (“আজকের লাভ ৳1,500”). Below it: “ক্যাশ লাভ ৳1,170 | অফার ৳330 (বাকি)” (negative cash profit in red). Tap → details: সাধারণ বিক্রয়, কোম্পানি অফার ছাড়, আসল বিক্রয়, ক্রয় মূল্য, কমিশন, ক্যাশ লাভ, অফার প্রাপ্ত/বাকি (from `getOfferAllocation`), সমন্বয় lines, which payment settled the offer (ranges) and the company payments of the period. When the offer is fully received the total stays the same and only the label becomes “প্রাপ্ত”. Range totals = sum of daily totals; the month card uses the same figures.
- **Profit rules.** Profit belongs to the SALE date. Cash profit = (price after offer deduction − snapshot buy price) × qty − commission; offer profit = stored `offerDeductionTotal` minus return reversals; total = cash + offer. Only stored snapshots are used, so a later price change never moves an old day. A company payment never changes any day or month profit; only the Session 2 সমন্বয় (difference only) is added, on the payment date.
- **Dashboard / reports.** New card “পাওনা অফার (কোম্পানির কাছে)” (owner/manager only) with earned / received / সমন্বয় / last payment. Report page shows the full profit detail plus the owner/manager-only offer receivable, company payments and সমন্বয়. The online-deposit (cash/bank) history lists company payments as RECEIVED money, apart from deposits — never sales or profit.
- **Role safety, enforced in the API.** `dashboard.js` (main, sales-range), `report.js` and `expenses.js deposit-history` return profit, cost, ledger, payments and offer balance only to a verified owner/manager (`actorId`, sent automatically by the app); DSR/SO/driver or an unknown caller get none of it. DSR/SO still see only the reduced price, expected cash and due.
- **Fixed: DSR transaction panel (owner dashboard + DSR dashboard).** The “দেওয়া” box (and every box that lists slips) and the last box “N টি দোকানে বিক্রয়” opened nothing because they called a digit helper `dg()` that only existed inside the memo engine. A global `dg()` was added; all boxes and the details list now open.
- Tests: `node tests/session3.test.js` (22 checks) — 1,500 = 1,170 + 330; REAL case 5,861.54 / 6,050.00 / −188.46 / 488.46 / 300.00; payment 3,000 leaves profit unchanged and lowers the offer balance by 3,000; price change leaves old days identical; month = sum of dailies before/after a payment; over/under-payment adjustment only on the payment date; DSR/SO/unknown get no profit data. Sessions 0–2 tests still pass (13 / 19 / 26).

### Summary of all sessions (5.24 → 5.27)
- **5.24 Session 0** — price-change safety: every sale/return line stores its own sell price, buy price, case size and offer; returns use the original sale snapshot; price history; owner “freeze legacy lines” tool.
- **5.25 Session 1** — automatic company-offer deduction as a lower shop price (bill, slips, memos, due, DSR expected cash), start-date setting, return reversal, DSR/SO see only the reduced bill.
- **5.26 Session 2** — company offer ledger (FIFO display settlement), company payments (add/edit/delete with own password), সমন্বয় on over/under payment, “কোম্পানিকে বিক্রয় পাঠান”.
- **5.27 Session 3** — profit panel (cash + offer), dashboard/report/cash-bank lines, API role enforcement, DSR transaction box fix.

## 5.26.0 — Session 2: company offer ledger
**Database: no migration required** (payments are kept in the settings store `app_settings.profit_rules._store._offerPayments`). API: `products.js` edited (new `action` values `co-*`), `_lib/offerLedger.js` added (helper — still 12 API files). UI: `src/index.html`.

- **New section "কোম্পানি অফার হিসাব"** (Owner + Manager only). Menu item hidden for DSR/SO/driver, and every `co-*` API action rejects any caller whose role is not owner/manager (writes also need the caller's own password).
- **Ledger per product** from the stored snapshots only (`offerDeductionTotal` of sale rows minus return reversals): total cases/bottles, cases since the last company payment, earned, received, balance (red = company owes us, green = settled).
- **Company payments**: date, amount, note, optional products and period; add / edit / delete with the user's own password. A payment is cash/bank received, not profit.
- **FIFO settlement (display only)**: payments settle the oldest earned offers first (by sale date, then product); a payment not tied to a product is spread over all products, so per-product balances are derived from the total. Nothing old is rewritten. `getOfferAllocation(sales, returns, payments)` in `api/_lib/offerLedger.js` returns per-day earned / received / pending (for Session 3).
- **সমন্বয় (adjustment)**: payment above the pending offer → positive adjustment on the payment date; payment below it with "সমন্বয় সহ বন্ধ করুন" → negative adjustment on the payment date. Only this difference ever reaches profit (Session 3).
- **কোম্পানিকে বিক্রয় পাঠান**: since-last-payment or a date range; product + cases + bottles; copy/WhatsApp text, A4 memo, thermal memo (existing MEMO engine, no SKU).
- Tests: `node tests/session2.test.js` (26 checks).

## 5.25.0 — Session 1: automatic company-offer deduction
**Database: no migration required** (optional `migrations/006_v5_25_offer.sql`). API: `shops.js`, `transactions.js`, `sr-payments.js`, `products.js`, `_lib/db.js` edited, `_lib/offer.js` added (helper — still 12 API files). UI: `src/index.html`.

- **Offer = lower shop price.** For a product with an offer (X cases → F free bottles + M free money) the shop still gets real bottles; the bill is reduced: value/bottle = P/(U+F/X), shop case price = that × U − M/X, deduction per case = P − shop price. Only whole qualifying cases count (loose bottles get none); total is rounded once from the exact rate (10 cases of 635/24/2 free = 488.46, shop pays 5,861.54). Stock drops by real bottles only.
- **Where it applies:** DSR/SO shop sale (`visit-sale`), point sale (`point-sale` and `transactions` type point_sale/dsr_sale), only when the date is on/after the new Settings value **অফার হিসাব শুরুর তারিখ** ("আজ থেকে চালু করুন", owner + own password, set once). Earlier sales and legacy lines get no offer.
- **Snapshot on every line:** case price, deduction per case, deduction total (columns `offer_*` if migration 006 is run, otherwise in the settings store). Sell/buy price, units per case and the offer fields were already stored in Session 0. Slips, bills, ledger and reprints read only these.
- **Shown as a separate line "কোম্পানি অফার ছাড়"** on the sale screen, the on-screen slip, the A4/thermal cash memo (DSR sale), the point-sale slip and the shop ledger bill. Bill payable, the shop due row and DSR expected cash use the reduced amount. DSR settlement carries the deduction with the company-borne discount so the DSR's own due still balances.
- **Returns** (shop sale return, point return) reverse the deduction proportionally (whole cases) from the original sale's snapshot (fallback: latest sale of that shop + product); stored on the return line; the due is lowered by the net value.
- **DSR/SO** no longer see the offer rule (🎁 badges hidden for them); they see only the reduced bill.
- Tests: `node tests/session1.test.js` (19 checks, in-memory fake database).

## 5.24.0 — Session 0: price-change safety
**Database: no migration required** (works on the current schema; `product_price_history` is optional). API: `products.js`, `transactions.js`, `shops.js`, `sr-payments.js`, `report.js`, `due-calendar.js`, `_lib/db.js`, `_lib/money.js` edited, `_lib/snapshot.js` added (helper, not a function — still 12 API files). UI: `src/index.html`.

- **Returns use the original sale's snapshot.** A shop sale-return, a point-sale return, a DSR return and a shop damage-collect are now valued at the sell price AND buy price (and case size / offer rule) of the original sale; if none is found they fall back to the latest sale snapshot for that shop+product, and only then to the current product. Before this, cost of returns and shop returns used today's product price, so old profit moved when a price changed.
- **Legacy lines never get today's offer.** Lines without a snapshot no longer pick up the product's current bonus rule in the bonus summary.
- **Product report** shows the prices of the transactions, not today's product prices.
- **Price history.** Every change to sell price, buy price, bottles per case or the offer fields appends a dated entry (who, old, new). Stored in `product_price_history` if that table exists, otherwise inside the settings store (`app_settings.profit_rules._store`). `GET /api/products?action=price-history[&productId=]`.
- **Legacy freeze (owner only).** New dialog at the owner's login (Bengali: "এখনই ফ্রিজ করুন" / "পরে মনে করান"), JSON backup download, dashboard warning until done, and a Settings button "পুরনো হিসাব ফ্রিজ করুন". Nothing is written without confirmation + the owner's password. Idempotent: only rows with no snapshot are written, each write is guarded, so two tabs/users are safe.
- Tests: `node tests/session0.test.js` (in-memory fake database, 13 checks).

## 5.23.1
**Database: no change.** API: no change. UI only (`src/index.html`).

- **Fixed: shop name inside the DSR transaction boxes did nothing when tapped.** The shop's খাতা (ledger) page opened *behind* the box pop-up (page layer 900 vs pop-up layer 9000), so it looked as if nothing happened. This affected every box that lists shops: মোট বাকি (top red box), আজকের বাকি, পূর্বের বাকি আদায়, জমা দিতে হবে, কমিশন, ছাড়, ড্যামেজ, পয়েন্ট সেল, and the "N টি দোকানে বিক্রয়" details box (owner/manager/SO "DSR লেনদেন" page and DSR home).
- The ledger page now opens above the pop-up. Closing it (✕ or phone back button) returns you to the same pop-up where you left off.

## v5.18.1 — Speed release
- Browser: icon + number-fit scanners now touch only changed parts of the page; 2–10 min GET cache for stable lists (cleared on every save/logout); chat refresh 60 s; location check every 10 min (sends only if moved >100 m, heartbeat 20 min); search boxes debounced (150 ms local / 400 ms server).
- Startup: load-all, notice, deposit and advance list now go out together and are cached.
- Slip tab loads the last 60 days, with "load older" and "show more" (50 at a time).
- DSR day view no longer downloads every settlement ever received: the all-time total comes from a database function (migrations/004_perf.sql), with a safe fallback.
- /api/products?action=migrate-thumbs moves old base64 photos into Storage.
- Build step (build.js) minifies public/index.html from src/index.html. EDIT src/index.html, not public/.

## Update — slips & merged boxes
- DSR panel: merged boxes (ফেরত / বিক্রয় ফেরত, ড্যামেজ·কমিশন·ছাড়) now show ONE summed total; tap to see each part.
- কোম্পানি লেনদেন: "কেনা" has a company slip-number field; new 🧾 স্লিপ tab lists all purchase/return slips newest-first with search (slip no, date, product, note) and detail pop-up.

# Changelog

## 5.23.0
**Database: no change.** API: `dashboard.js` edited.

- **Memos:** SKU removed from every memo; each product is now 2 lines (name + amount, then qty × rate); the small headings are gone, so "গ্রহণকারী (DSR/SO): নাম" is ONE line. Result: much shorter memo, fits WhatsApp.
- **Slip lists (details):** each slip row shows "📦 N টি পণ্য" at the top-left, on the same row as the time.
- **Product pickers (give / return / point sale):** price now reads "প্রতি কেস ৳…"; tapping a product only flips its tick (no full-screen re-render → no glitch / scroll jump).
- **Stock / low-stock list:** price line removed under the name; quantity shows cases + pieces (SO too).
- **Road duty:** Friday is a holiday. DSR duty = the road the SO visited on the previous WORKING day (Saturday → Thursday's road); no duty on Friday for SO or DSR.

## 5.22.0
**Database: no change.** API: `shops.js` edited (ledger now also sends each product's own commission / discount).

- **Tally book (খাতা) redesigned.** Every entry is now ONE line — তারিখ · বিবরণ (first product + quantity, "+N" badge for more items) · মোট · জমা · বাকি — so long product lists never make the page tall. Vertical ruling between all columns, perfectly aligned.
- **Tap a line to open its details:** product · quantity · commission per case · discount per case (+ "মোট বাদ" row), then the bill summary (পণ্যের মূল্য, কমিশন, ছাড়, মোট বিল, জমা, বাকি), slip no., DSR and time. Same for ফেরত (🔁) and ড্যামেজ (⚠️) lines. Tap again to close.
- Whole amounts drop ".00"; zero shows "—". A lump-sum discount that cannot be split per case shows as a total tagged "মোট"; piece-only lines show "/পিস".

## 5.21.0
**Database: ONE small, optional SQL** — `migrations/005_v5_21.sql` (adds who-collected / credited-to columns to `due_collections`; the app still works without it).

- **বাকি আদায় for every role** (owner, manager, SO, DSR): shops are sorted by your live GPS — nearest first, with the distance in metres, grouped 100 m / 300 m / 1 km / further / no location. Owner/manager/SO see every shop that owes; a DSR sees his own shops (tick "other DSRs' shops" for more).
- **Auto-credit:** whoever collects, the credit goes to the shop's registered DSR automatically. Cash stays with the person who took it (DSR/SO → his own day-end cash; owner/manager → nobody's).
- **SO has his own van:** stock given to an SO is sold from the SO's own van (no borrowed DSR van, picker removed). SO uses the same delivery screens, shop auto-detect (nearby shop prompt) and has "আমার লেনদেন"; he appears in the payment / van-return / collection lists like a DSR.
- **Menu:** extra logout button at the very end (the top one stays).
- **Owner home:** the "DSR/SO বাকির তালিকা" block was removed.
- **Transaction details:** each product's total = selling price × only the quantity sold to shops (point sale included, shop-returns deducted). Column "ক্রয় দর" → "বিক্রয় দর".
- **Tally book (খাতা):** tapping a shop opens a hand-written-ledger style book — one page per due cycle: date · what was taken · total · paid · due, commission/discount under the row, deposits as rows; page closes when due hits zero and the next sale starts a new page (◀ ▶ to flip).
- **DSR/SO payment:** cash is locked to exactly what is in hand (no editing; enforced on the server too).
- **Slips:** removed QR, barcode, hash, signature boxes, terms, amount-in-words, thank-you footer, distributor/TIN lines, duplicated memo no/date/total lines. Online-deposit slip: name · mobile · address, then ONE sheet (date · day · method · amount) and the total once.

## 5.18.0
**Database: no change.** API files: still **12** (`sr-payments.js` edited).

- **DSR panel red box:** shows dues only up to the previous day — a day's unpaid credit counts only after the owner/manager registers that DSR's payment for the day.
- **Previous-due bug fixed:** the 24-hour rule is replaced by a calendar-date rule. Paid on the day the due was made = cash; any later day = "পূর্বের বাকি আদায়".
- **DSR/date boxes:** icons removed; the date box now has the same green top border as the DSR box.
- **DSR transaction boxes:** all boxes same size, one line, no helper text; ফেরত / বিক্রয় ফেরত and ড্যামেজ, কমিশন, ছাড় are merged; every box opens a pop-up (merged boxes list their parts first). "আমার পারফরম্যান্স" tile removed; date moved beside the "আমার লেনদেন" title and the আজ/তারিখ/রেঞ্জ chips are smaller.
- **Menu:** "দিনশেষ হিসাব" → "দেওয়া, নেওয়া ও পেমেন্ট" (3 tabs; নেওয়া = pick DSR → van stock loads → take). "লেনদেন" → "কোম্পানি লেনদেন" (damage, buy, return to company). New "পয়েন্ট সেল" item for owner/manager (shop → DSR auto-filled; DSR only → shop required).
- **Payment tab:** fully automatic (no ticking); DSR + date → cash → password. Point sale shown in its own box.
- **SO menu:** product, expenses and sales-calculation removed. **Manager menu:** ফেরত পণ্য removed.
- **Approvals removed:** every entry saves immediately; approval queue endpoints deleted. The owner page is now "অগ্রিম আবেদন" (salary-advance requests only).
- **Due collection list:** shop name + location + due; tapping the due opens the shop's due book.
- **SO sale message / table, tile text centring** adjusted.

## 5.17.1
**Database: no change.** UI only (`public/index.html`).

- **DSR লেনদেন top boxes:** the DSR-name box and the date box are now exactly the same size, shape and style (one line each, ▾ on the right). আজ / রেঞ্জ chips moved to the title row.
- **DSR/SO list:** the pop-up now lists every DSR **and** every SO (SOs tagged "· SO") plus "সব DSR একসাথে" — e.g. 6 people + all = 7 options.
- **Eyebrow style:** the two picker boxes are white cards with a thin line and a thick coloured top line (green = DSR, blue = date), small caption above the value.
- **DSR name pop-up:** tapping the DSR box opens a centred grey pop-up list of names (white text, radio on the right, tap outside to close) instead of the old drop-down.
- **Transaction boxes:** দেওয়া, ফেরত, ড্যামেজ, কমিশন, ছাড় … and the red top box use the earlier version's look: white card, full coloured outline, rounded corners, larger figure.

## 5.17.0
**Database: ONE small SQL to run** — `migrations/003_v5_17.sql` (Supabase → SQL editor, safe to run twice). Fresh installs: `schema_fresh.sql` already has it. API files: still **12**.

- **New DSR menu item "বিক্রয় ফেরত"** (Sale Return): pick a shop that owes → type what it hands back → own password → the goods go back into the DSR's **van stock** and the shop's **due goes down** (oldest due first). Guards: a shop can only return what it bought from that DSR (minus earlier returns), and the value can't exceed its due. A detail list (date range) shows every return, with the shop, items and ৳. New 🔁 box in the DSR transaction panel + a column in the product table; the shop's memo book (খাতা) shows the return too. Needs the SQL above (without it the app says so and saves nothing).
- **SO ↔ DSR mismatch fixed:** the SO/owner totals counted point-sale, the DSR panel did not. The sale figure is now ONE rule everywhere: (দেওয়া + পয়েন্ট সেল) − (ফেরত + পয়েন্ট ফেরত). DSR panel, SO home grid and the owner figures now agree.
- **Point sale now shows on the DSR panel (bug fixed):** the panel's API never read point-sale rows, so nothing appeared. Point sale (by DSR name or by shop → that shop's assigned DSR) now appears in the DSR's transactions, in the bottom "দোকানে বিক্রয়" bar (count + ৳) and in the product table.
- **Point sale: commission + discount** fields added (optional, validated ≤ sale total). They are listed in the DSR's কমিশন / ছাড় boxes tagged "🛒 পয়েন্ট সেল".
- **Cash box:** the 🛒 পয়েন্ট সেল amount is now its own box directly **below** "জমা দিতে হবে", so cash in hand and point-sale amount are clearly separate.
- **Due list (first red box):** tapping a shop opens its **memo book / due book** (what it took, paid, due) instead of calling it. Same for every shop name in the panel.
- **Layout:** pages use the full screen width (no empty side bands); the sales/stock pop-up is wider with smaller text and tighter rows so more products show at once.

## 5.16.0
**Database: no change.** API files: still **12**.

- **Fonts:** Bengali/Latin digits now use Inter → Noto Sans → Noto Sans Bengali (cleaner ১ / 1).
- **Menu:** flat list for every role (same order, no sub-sections).
- **Due Calendar:** "নতুন বাকি" can search an existing shop (name / no / phone) and adds to it; custom-client name suggestions. Colours: today = red, earlier = orange, coming = blue, paid = green.
- **DSR লেনদেন:** DSR + date boxes equal, tinted; আজ/রেঞ্জ inside date box; dropdown shows ~7 rows with SO names; new **আজকের বিক্রয় (দেওয়া − ফেরত)** box; coloured top border on all boxes.
- **Due list:** every write clears cached figures; opening the list re-reads live data; detail pop-up syncs the row.
- **Passwords:** every due payment (shop detail, today's dues, calendar) needs the actor's OWN password (server-checked).
- **SO:** new "বাকি আদায় (DSR-এর নামে)" menu item next to the existing DSR-style sale.
- **Van return:** Owner/Manager ফেরত পণ্য → 🚐 ভ্যান ফেরত (pick DSR → van stock auto-loads → own password → slip). DSR sees what is in his van.
- **Shops:** Owner + Manager can edit name, owner, phone, address, road (own password); GPS stays locked; delete = Owner only.
- **Targets:** DSR % now uses the same box basis as the SO % (was money vs boxes); new slim company total-target strip on Owner/Manager home.
- Low-stock bar (DSR/SO) same height as owner's; Owner low-stock closed by default.

## 5.15.0
**Database: no change** (schema_fresh.sql / schema.sql unchanged). API files: still **12**.

### Home pages redesigned
- **DSR home:** RADT → scrolling info panel → low-stock alert → target panel (my %, rank, my SO's %) → my team's DSR target names → the 10 transaction boxes → extras.
- **SO home:** RADT → info panel → low-stock alert → my target → every SO's fill % → SO due (with আজ / এই মাস / রেঞ্জ) → full DSR transaction panel (10 boxes) → 9×2 today/this-month grid → DSR & SO performance, top 50 shops, SKU ranking, DSR/SO due list → "আমার আরও তথ্য".
- **Owner / Manager home:** RADT first, then info panel, low stock, SO fill %, sale tile; new 9×2 grid (given · return · sale · damage · commission · discount · due · due taken · payment, today | this month); performance / top 50 / SKU ranking / due list kept.

### Menus (exact order)
- **DSR:** delivery · damage collection · due collection · van return product · due calendar · presents · products · sales target · shop registration · group chat · important numbers · my password · dark mode.
- **SO:** order & van loading · today's sale · damage · production fold (placeholder) · product catalog & stock · online deposit slip · expenses slip · sell · sales target · sales calculation · group chat · important numbers · my password · dark mode.

### API (inside existing files)
- `sr-payments?action=dsr-my-day` accepts `soId` with `dsrId=all` (that SO's DSRs only).
- `dashboard?action=sr-perf` now also returns each DSR's `soId`.

## 5.14.0
**Database: no change.** API files: still **12** (changes are inside `attendance.js`).

### Home — RADT line + SO fill box
- The slim target line now reads `🎯 আজকের টার্গেট ........ RADT = N কেস` (with the remaining cases and days after it).
- New box right under it on the **Owner and Manager** home: every SO's target fill-up % in the same three colours as the target page (🔴 below 60 · 🟡 60–99 · 🟢 100+). Tap → the full সেলস টার্গেট page.

### DSR — performance tab
- New **📈 আমার পারফরম্যান্স** tile on the DSR home (and in the ☰ menu): his sale this cycle, his share of the SO target with a ring, his rank among DSRs, and his SO's box target progress.

### Targets — set by hand, never split equally
- The owner sets the **total** (boxes + money), then types **each SO's own target** and **each SKU's cases**. The "equal split" button and the `target-split-even` API are removed.
- Hard limits (checked live on screen and again on the server): SO boxes ≤ total boxes · SO money ≤ total money · **sum of all SKU cases ≤ total boxes**. One 💾 save stores the total, the SOs and the SKUs together (Owner PIN).
- `product-target-set` also refuses a SKU figure that would push the SKU sum above the total (set the total first).
- The per-SKU cards below are now read-only; they are edited in the setup box above.

### Login
- After any login (new PIN, first-login PIN setup, or a normal login after logout) the app always opens on that role's **home dashboard** — never on the page or tab that was open before. Logout also resets it.

## 5.13.0
**Database: no change.** API files: still **12** (changes are inside `dashboard.js` and `sr-payments.js`).

### বিক্রয় প্যানেল — one tile + pop-up, pieces only
- Owner, Manager and SO home now show **one tile**: today's whole-shop sale in **pieces, free/bonus included**. Tap it → pop-up with a single picker (🏪 মোট দোকান · each SO · each DSR) and a date row (◀ date ▶). Everything in the pop-up (stock before, sale, current stock) is **pieces only**.
- SO stock tab and SO low-stock list also show **pieces only** (no cases).
- API: `sales-panel&scope=dsr&dsrId=` (one DSR's own sale); `sales-panel` now also returns the DSR list.

### DSR লেনদেন panel
- The DSR name and the date are now **one slim row**; আজ / রেঞ্জ chips sit in the title line.
- Top red box now shows the DSR's **total unpaid due** (tap → every shop that owes). The **পূর্বের বাকি আদায়** box now shows what the DSR actually **collected** of old dues in that period.
- All boxes are slightly taller, and every box's details use the same polished day-box as দেওয়া (DSR + date on top, rows, filled total at the bottom).
- New box **🛒 পয়েন্ট সেল** (shows 0 when none): every slip, shop, product and the total money. The cash box notes that this money is collected from the manager/owner and handed to accounts separately (the DSR settlement math itself is unchanged).

### Point sale — always booked on a DSR
- Owner/Manager choose **🚚 DSR-এর নামে** or **🏪 দোকানের নামে**. For a shop, the sale goes to the DSR assigned to that shop (if none is assigned, a DSR must be picked). The shop ledger keeps working (shop id is saved on the sale).
- The sale counts in that DSR's SO sale, the sales panel, day-status and targets.

### Advance payment in the top ticker
- Owner + Manager: pending advance requests scroll in **red**, approved ones (last 7 days) in **green**.

### Adaptive numbers everywhere
- Every tile figure (home tiles, nine boxes, hero cards, accordion totals, the new sale tile and any other big bold amount) now shrinks to fit its box instead of being cut off or spilling out; grid/flex tiles can no longer be stretched by a long number.

### Van load (DSR)
- The DSR no longer has an "অর্ডার ও গাড়ি লোড" menu entry. When he opens the **delivery (দোকান) panel**, a pending load pops up in a window: confirm "সম্পন্ন" or edit quantities; then the stock is added to his hand.

## 5.12.0
**Database: no change.** A new deploy runs `schema_fresh.sql` (full schema, unchanged since 5.11). Upgrading from 5.11.x: just redeploy, no SQL. API files: still **12** (new logic is one new action inside `sr-payments.js`).

### বিক্রয় প্যানেল — green / red day-close tone
- A day's sale is only reliable after the manager has taken the returns and closed that day's calculation (unsold stock can still come back and change the stock). The whole panel now shows that:
  - 🟢 **Green** — a **SO is logged in** and every DSR of the people on screen is fully settled for that day (nothing left on the van, no pending cash / commission / discount / damage). Banner: "হিসাব সম্পন্ন — বিক্রয় চূড়ান্ত".
  - 🔴 **Red** — the calculation is not finished (banner lists which DSR is still open and why: ভ্যানে মাল আছে / নগদ বাকি / কমিশন-ছাড় বাকি / ড্যামেজ বাকি), the status could not be checked, **or the viewer is any other role** (Owner / Manager / DSR). To let another role see green, edit the one-line `_SP_GREEN_ROLES` in `public/index.html`.
- A new loading, sale or collection after the settlement re-opens the day (panel turns red again) until the manager settles it again.
- Works for back dates too (the colour follows the date being viewed) and for each pick (one SO, or 🏪 whole shop).
- API: `GET /api/sr-payments?action=day-status[&date=YYYY-MM-DD][&soId=]`.

### SO dashboard — my sale and everyone's sale
- New card **🏆 আজকের বিক্রয় — আমার ও সব SO-এর** on the SO home: every SO's net sale of today (his DSRs' give − return + his own point sale), my row on top, a total line, and a green ✅ / red ⏳ chip per SO showing whether that SO's day is closed. The card takes the tone of MY day.

### ডিউ ক্যালেন্ডার — partial due in red
- A due that remains after a **partial payment** is now **red** everywhere (it was orange): calendar day cell and dot, legend, entry list (red row with a red left edge), day pop-up, person pop-up, entry detail, shop due history, DSR collection lists.
- The "আংশিক" tile is now **আংশিক বাকি** = money still due on partly-paid entries (before it showed the part already paid).
- Fixed a stray `)` that made the amount colour invalid on partly-paid rows.

## 5.11.0
**Database:** one small change — new columns on `dsr_settlements`. A **new deploy** just runs `schema_fresh.sql` (already includes it). **Upgrading from 5.10.x:** run `migrations/002_v5_11.sql` once (safe to re-run; until you do, everything keeps working but the manager-cash total stays empty). API files: still **12** (no new file; new actions live inside `sr-payments.js` and `dashboard.js`).

### Units everywhere (কেস / ডজন / কার্টুন / পলি)
- Wherever a quantity or a total showed "কেস", it now uses the unit the owner chose in the product panel — slips/memos, DSR day boxes, shop ledger, order lists, forms, sales panel, reports.
- Totals of mixed products are split per unit: `5 কেস · 3 ডজন · 2 পলি · 8 পিস` (server `cpSplit` now returns a `by` breakdown; old fields unchanged).

### Product order
- Every slip/memo, slip list and product-wise total follows the order the owner set in the product panel (sort order), not the order items were typed.

### অনলাইন জমা slip — official format
- Now an A4 spreadsheet-style statement (gridded table, oldest first, running total, bank / depot subtotals, words, signatures) instead of the 50 mm roll.
- New **📊 Excel (.xlsx)** download (real formulas; falls back to CSV if the library cannot load).

### Manager cash (Owner home)
- New card **ম্যানেজারের কাছে নগদ**: cash each manager took from all DSRs, added together = what the owner will receive from the managers. Approved + pending shown separately; filter আজ / এই মাস / সব সময়. API: `GET /api/sr-payments?action=manager-cash`. Settlements made before this version are not attributed to a manager.

### বিক্রয় প্যানেল — back dates
- Date picker + ◀ ▶ + আজ for every role (up to 1 year back). Stock columns are rebuilt for that day. API: `sales-panel&date=YYYY-MM-DD`.

## 5.10.0
No database change — `schema_fresh.sql` is unchanged and is still the full schema for a new deploy (upgrading from 5.9.x needs no SQL). API files: still **12** (no new file; `transactions.js` only gained an optional `?type=` filter).

### Home
- The single scrolling info tile (notice · road duty · online deposit) stays on every role's home; the big online-deposit box is gone (full details only via ☰ → অনলাইন জমা).
- **RADT (আজকের টার্গেট) is now one slim line** in the app's emerald theme instead of the tall purple box: `🎯 আজকের টার্গেট ........ N কেস · বাকি X কেস · Y দিন`.

### ফেরত পণ্য (new, ☰ menu — Owner · Manager · SO, also a quick-action tile)
- Pick a date or range (আজ / গতকাল / ৭ দিন / এই মাস or custom) → total returned value, slip count, product-wise totals, and every return slip grouped by date with DSR name, time, items and amount.
- **🧾 স্লিপ** button on each return opens the return slip (memo) again. SO sees only his own + his DSRs' returns.
- API: `GET /api/transactions?type=return&from=&to=[&soId=]`.

### Return needs no approval
- A Manager's **return** entry is saved straight away (no Owner-approval queue). Other manager entries (give, damage, payments, expense …) keep the approval flow.

### দেওয়া / ফেরত / ড্যামেজ detail boxes
- Each day is now one square box: **DSR name + date on top**, the slips (time, items) inside, and the **total as a filled, rounded block at the bottom** (green for দেওয়া).

### Owner approvals page
- **Pending approvals first** (newest on top, "সব অনুমোদন করুন" right there), then advance-salary requests, then the view-only orders list. Approved / rejected items sink to the very bottom — no more scrolling past them.

## 5.9.0
No database change — `schema_fresh.sql` is unchanged and is still the full schema for a new deploy (upgrading from 5.8.x needs no SQL). API files: still **12** (no API file touched).

### Minimal home screen
- **One scrolling info tile.** The important notice, today's online-deposit amount and the road duty no longer stack as three separate banners — they run one after another in a single slim ticker (SO: notice · road visit · deposit; DSR: notice · road duty; Manager: notice · deposit; Owner: deposit). If everything fits on one line it simply stays still.
- **অনলাইন জমা moved into the ☰ menu** (Owner + Manager, under "প্রতিদিনের কাজ"). It opens the full panel — today/month totals, month history, and for the Owner **➕ নতুন জমা যোগ করুন** (still asks for the Owner PIN). The big deposit box is gone from the Owner home; only the amount scrolls in the ticker.
- **কম স্টক সতর্কতা removed from the DSR page** (Owner, Manager and SO keep it).

### Smaller header + tiles
- Header logo/name bar and the date-time/section bar are both much shorter, so more fits on every role's page.
- Home tiles (দেওয়া / ফেরত / বিক্রি / লাভ / পেমেন্ট / বাকি …), quick-action tiles, accordions, cards, the red DSR box and the report tiles have less height and padding.

### Numbers never hide
- Every amount in a tile (`.mv`, hero cards, today strip, DSR boxes) is measured against its box and shrunk until it fits; if a figure is still too wide at the smallest size it wraps to a second line instead of being cut off. Re-checked after every render, rotation and font load.

## 5.8.0
No database change — `schema_fresh.sql` is unchanged and is still the full schema for a new deploy. API files: still **12** (one extra read-only query inside `sr-payments.js`, no new route).

### DSR লেনদেন boxes (DSR · SO · Owner · Manager)
- "আগের বাকি" box renamed to **পূর্বের বাকি আদায়**.
- New **red box on top**: the selected DSR's name + the total cash the system has received from him (all dates; the figure for the chosen period is shown under it). API `dsr-my-day` now returns `received: { total, period }`.
- All boxes are shorter (one line, small caret) so the red box + the 8 boxes fit one phone screen. The "লেনদেনের বিস্তারিত" box is shrunk the same way.

### Menu (☰) — all roles
- Opens as a **half-width side panel** (about half the screen; the page stays visible and tapping outside closes it) instead of a full-screen cover.
- Top: square **হোম** button with **লগ আউট** beside it; then the functions as one-per-row tiles.
- Functions are **grouped, most-used first**: প্রতিদিনের কাজ (open) → টিম/হিসাব/দোকান → রিপোর্ট ও খরচ → সিস্টেম (password, notice, reset, dark mode). One group open at a time.
- **DSR and SO home**: the box bar at the top of the home screen is gone. Those pages (DSR: শপ ডেলিভারি, বাকি আদায়, ড্যামেজ কালেকশন, বিক্রয় প্যানেল, বাকি/পেমেন্ট, পণ্য ক্যাটালগ, শপ নিবন্ধন · SO: বিক্রয়, আজকের মোট বিক্রয়, DSR লেনদেন, DSR বাকি, বিক্রয় হিসাব, স্টক, ক্যাটালগ) are now in the menu. The top bar shows which one is open; **হোম** returns to the DSR "লেনদেন" / SO "সারসংক্ষেপ".
- Fixed a doubled emoji in the menu header role label.

## 5.7.0
No database change — `schema_fresh.sql` is unchanged and is still the full schema for a new deploy. API files: still **12**.

### Screens
- Removed the top-left "◀ ফিরুন / ◀ তালিকায় ফিরুন" buttons (attendance person page, shop register/detail, shop ledger). The phone's back gesture already steps out of these pages. The step buttons inside the give/return/damage/point-sale wizards ("← পণ্য বদলান") are kept — they are wizard steps, not menu buttons.

### বিক্রয় প্যানেল (Owner · Manager · DSR · SO)
- One simple box: tap it and choose **whose sale** to see — any single SO (his DSRs + his own point sale, free/bonus pieces NOT counted) or **🏪 মোট দোকান** (whole shop, free/bonus pieces counted).
- Products are listed in the same order as the product/inventory page; a product with no sale shows 0. Columns: গতকালের স্টক · আজকের বিক্রয় · বর্তমান স্টক.
- Where: SO → "আজকের মোট বিক্রয়" tab · DSR → new "📦 বিক্রয় প্যানেল" tab · Owner/Manager → "বিক্রয় প্যানেল" box on the home page.
- API: `GET /api/dashboard?action=sales-panel&scope=so|total&soId=`.

### কম স্টক সতর্কতা
- Now shown to every SO and DSR (was Owner/Manager only). API: `GET /api/dashboard?action=low-stock`.

### Payments — password, no double taking, no over-paying
- Manual cash-in (জমা) and the day-end settlement now ask for the logged-in user's own password; the server checks it again (`actorId` + `pin`). A manager's request is checked when it is submitted.
- A payment can never be larger than the person's current due, and the same amount for the same person cannot be saved twice within 2 minutes. Day-end settlement can no longer exceed the DSR's due.
- One money action at a time on screen (a second tap while one is running is ignored).
- DSR collecting due from a shop already needed the DSR password and could not exceed the shop's due (v5.6) — unchanged.

### Owner — DSR লেনদেন
- New option **👥 সব DSR একসাথে**: every DSR's transactions combined, each entry tagged with the DSR's name. (`dsr-my-day?dsrId=all`)

### Roads
- One SO (with his paired DSR) can now be assigned to **many roads** — the old code un-assigned his previous road.
- The paired-DSR lookup no longer fails when an SO has more than one DSR.
- An SO cannot be given two different roads on the same weekday (clear message); different weekdays for different roads work.
- DSR road duty ("the day after the SO") is resolved through the DSR's SO, so it no longer depends on a possibly stale DSR id stored on the weekly rule.

### Net profit
- NET profit = gross profit − **commission only**. Discount, damage, bonus and expenses are no longer deducted (they are still shown as separate figures). The Settings screen explains this and the old per-item switches are gone; an old saved setting can no longer switch them back on.

## 5.6.0
No database change. API files: still **12** (extra fields / one extra check added inside existing files — no new route).

### DSR লেনদেন boxes (DSR · Owner · Manager · SO — one shared board)
- Every detail list now shows the **date once as a header**, with that day's total as a filled, labelled pill (**মোট কমিশন / মোট ছাড় / মোট ড্যামেজ / মোট দেওয়া / মোট ফেরত / মোট বাকি**). Individual shop amounts stay plain coloured numbers, so the total can no longer be confused with a single shop's amount.
- Rows under a date show only the **time** (and the shop name). Applies to: দেওয়া, ফেরত, ড্যামেজ (van + from shops), কমিশন, ছাড়, আজকের বাকি, আগের বাকি and the "জমা দিতে হবে" box (cash at sale / old due collected / money paid for damage).
- The auto-generated text "দোকান বিক্রয় বাকি" is no longer printed in these lists.
- **লেনদেনের বিস্তারিত** (bottom of the DSR home) is now one collapsible box in the same style: product totals (দেওয়া / ফেরত / দোকানে / ড্যামেজ in cases + pcs), then date → slips with time. Shop sales now show the **shop name** (tap to call).
- API `dsr-my-day`: due / cash lines now carry `createdAt`, `shopId`, `shopPhone`; new `txShops` map (shopId → name/phone).

### বাকি আদায় — DSR password
- Every collection, **full or partial**, asks for the DSR's own password before saving. The check is also done on the server (`sr-payments?action=due-collect` needs `pin`), so it cannot be skipped. A wrong password saves nothing.

### Damage panel fix
- Damage a DSR collects **from shops** (ড্যামেজ কালেকশন) is stored in `damage_collections`, not in `transactions`, so the SO home "ড্যামেজ" card never counted it. It now does (purchase-price basis, shown with a "দোকান থেকে ৳…" line).
- Owner / Manager home damage alert now also shows **আজকের ড্যামেজ** (before it only showed pending claims, so a claim that was already cleared — or one dated today — was invisible).

### ডিউ ক্যালেন্ডার
- No more "দোকান বিক্রয় বাকি" text beside the DSR / SO name. List and day pop-up show: name, **date + time of the entry**, and the **total amount**.
- Tap an entry → full detail: shop, keeper, phone, date + time, status, what was sold (items, commission, discount), and a **📞 call shopkeeper** button. A call button is also on each entry in the day view.
- API `GET /api/due-calendar` rows now include `shopPhone` and `keeperName`.

### সেরা ৫০ দোকান
- New **🛣️ রোড** filter: choose a road and only the shops of that road *within the top 50* are shown (rank numbers are kept; shops with no road are under "রোড দেওয়া নেই").

## 5.5.1
No database change. API: `dsr-my-day` commission / discount / shop-damage lines now also return `createdAt`, `shopId`, `shopPhone`.
- DSR লেনদেন → কমিশন / ছাড় / ড্যামেজ boxes: the date is shown once as a header (with that day's total); each row shows only the time.
- Shop name is tappable (📞) when the shop has a saved phone number: asks to confirm, then calls so the owner can verify the entry.

## 5.5.0
No database change. API files: still 12 (small additions inside `due-calendar.js` and `sr-payments.js`).

### Memo / receipt clarity (thermal)
- Long receipts are no longer drawn as ONE very tall image (phone browsers cap canvas size and silently shrink it → blurry text). The receipt is now cut between rows into parts of at most ~275 mm and each part is drawn at a fixed ~385 dpi. Preview, PDF (one page per part, 50 mm wide), JPG and WhatsApp use the sharp parts.
- **Direct Bluetooth print** button (🔵 ব্লুটুথ প্রিন্ট) in the memo panel: converts the sharp image to a 1-bit bitmap at the printer's dot width (58 mm = 384 dots, 80 mm = 576 dots — selectable) and sends ESC/POS raster over BLE. Needs Chrome/Edge on Android (HTTPS). Not available in iOS Safari. Classic-only (non-BLE) printers cannot be used from a web page — use the normal "প্রিন্ট" button or the RawBT app for those.

### Digit "1" / fonts
- `--font-ui`, `--font-num`, `--font-disp` still listed Hind Siliguri / Inter first, so digits (especially 1) used their odd shapes. Noto Sans is now first everywhere; Bengali letters still fall through to Hind Siliguri.

### Product settings
- অফার fields (ফ্রি পিস, প্রতি কত কেস, ফ্রি টাকা, লো স্টক অ্যালার্ট) now accept decimals (0.5 etc.) with a decimal keypad.

### Calendar
- Due calendar now follows the pay cycle like salary/targets: 26th of the previous month → 25th of the month (screen + `GET /api/due-calendar?month=YYYY-MM`). Expense report "এই মাসের খরচ" uses the same cycle.

### Owner home — profit panel
- The 2nd panel already was the profit panel (label flips নীট লাভ ↔ নীট ক্ষতি). It now shows a − sign for a loss and a line explaining the figure: মোট লাভ − (কমিশন/ছাড়/ড্যামেজ/বোনাস/খরচ).

### DSR লেনদেন → দেওয়া / ফেরত / ড্যামেজ বিস্তারিত
- Each slip: DSR name on top → items → straight line → total + the time the slip was saved (Bangladesh time). `dsr-my-day` now returns `dsrName` and `createdAt` per slip.

## 5.4.0
No database change — `schema_fresh.sql` is unchanged and is still the full schema for a new deploy. API files: still 12 (no new function; extra fields were added inside existing ones).

### Memos → 50 mm thermal paper
- Every memo / slip / receipt now renders as one narrow thermal receipt (50 mm wide, black on white, no page breaks): give, return, damage, buy, return-to-company, point sale / return, SO order memo, DSR cash memo, due-collection receipt, day-end settlement memo, online deposit slip, salary slip.
- **No "প্যাক সাইজ" column** any more (thermal and A4). Each item prints as: name, "৫ কেস ২ পিস × ৳দর/কেস", amount.
- Download PDF (page = 50 mm × receipt length), JPG, Print (`@page` 50 mm) and WhatsApp all work from the same receipt. To change the roll width edit `THM.mm` at the top of the memo engine (e.g. 58).
- Reports stay A4: the SO daily report and the business report.

### Quantities in cases everywhere
- Swap product picker (damage collection → বদলে কোন পণ্য): shows only the product name, no car stock.
- Shop delivery list: no unit price; shows the product and how much is on the van (cases + pcs).
- Damage / swap / sale / return warnings, stock lists (total stock), catalog and picker prices (now ৳ per case), SO sales split, DSR month, dashboard today strip, analytics report, damage report, bonus report, DSR history now show "X কেস Y পিস" instead of total pieces.
- Totals are exact: units are summed per product and split with that product's own case size (new fields `givenCP / returnCP / dmgCP / soldCP / totalCP / shopSalesCP` in dashboard, report, transactions, claims APIs).

### Layout
- The sliding shortcut strip at the top (home / products / transactions / attendance / shops) is removed for all roles; everything remains in ☰ and the quick-action panel.
- Owner/Manager home: the money numbers (মোট বাকি, পেমেন্ট আদায় …) scale to the screen so the full amount is always visible.
- Shop delivery / sale screen, shop registration and damage collection: the on-page "◀ ফিরুন" button is gone; the phone back button does the same job as on other pages.

### Return (ফেরত) flow
- After choosing DSR + date, step 2 has two tabs: **🚚 <DSR name>** (default — only the products still on that DSR's van that day, pre-selected, quantities pre-filled in cases/pcs) and **✏️ কাস্টম** (pick any products manually).

## 5.3.0
No database change. API files: still 12 (no new function added).

### DSR লেনদেন — ৮টি বক্স, প্রতিটি আলাদা লাইনে
- বক্সগুলো (উপর থেকে নিচে): **দেওয়া · ফেরত · ড্যামেজ · কমিশন · ছাড় · আজকের বাকি · আগের বাকি · ম্যানেজার/মালিককে জমা দিতে হবে**.
- যেকোনো বক্সে ট্যাপ করলে ঠিক তার নিচেই সম্পূর্ণ বিস্তারিত (কোন পণ্য / কোন দোকান / কত টাকা) খোলে; আবার ট্যাপ, ✕ বা ব্যাক বাটনে বন্ধ হয়।
- **আজকের বাকি** = এই সময়ে এই DSR-এর দেওয়া এখনো-অনাদায়ী বাকি; **আগের বাকি** = এর আগের তারিখের অনাদায়ী বাকি (DSR-এর নিজের + তার দোকানের)। হিসাবটা বাকি-রিপোর্টের আজকের/পূর্বের বাকির সাথে একই নিয়মে।
- একই বোর্ড DSR (নিজের হোম), **মালিক ও ম্যানেজার** (নতুন মেনু/দ্রুত-একশন "📝 DSR লেনদেন") এবং **SO** (হোমের "📝 DSR লেনদেন" ট্যাব) — সবাই DSR বেছে নিয়ে আজ / তারিখ / রেঞ্জ দেখতে পারেন।
- API: `GET /api/sr-payments?action=dsr-my-day` এখন `todayDue` ও `prevDue` (মোট + দোকান-ভিত্তিক লাইন) ফেরত দেয়; প্রতিটি লাইনে `cases`/`pcs` আছে।

### ব্যাক বাটন
- **DSR হোম**: শপ ডেলিভারির স্লিপ/বিক্রয় → দোকানের বিবরণ → তালিকা; ড্যামেজ কালেকশনে দোকান-তালিকা; বাকি/পেমেন্ট, বাকি আদায়, শপ নিবন্ধন, ক্যাটালগ → DSR হোম। এরপর আগের মতোই অ্যাপের ব্যাক-স্ট্যাক।
- **SO হোম**: যেকোনো ট্যাব → সারসংক্ষেপ।
- **মালিক/ম্যানেজার DSR লেনদেন**: খোলা বক্স বন্ধ।

### পরিমাণ — শুধু কেস ও খুচরা পিস
- মেমো, স্লিপ, অর্ডার মেমো, রুট রিপোর্ট, লেনদেন উইজার্ড (দেওয়া/ফেরত/ড্যামেজ/কেনা/পয়েন্ট সেল/অর্ডার), স্টক তালিকা ও অনুমোদন বিবরণে এখন "৫ কেস ২ পিস" দেখায়; আর মোট-পিস সংখ্যা ("১২২ পিস") দেখানো হয় না। একাধিক পণ্যের মোটে কেস ও খুচরা পিস আলাদা করে যোগ হয়।
- ড্যাশবোর্ডের সারসংক্ষেপ কার্ড/রিপোর্টের অ্যাগ্রিগেট সংখ্যা (সব পণ্য মিলিয়ে মোট পিস) আগের মতোই আছে।

## 5.2.0
No database change — `schema_fresh.sql` is unchanged and still the full schema for a new deploy. API files: still 12 (no new function added).

### Back button
- **উপস্থিতি ও লোকেশন** (Owner: one person's attendance → staff list) and **দোকান ও লোকেশন** (register form, shop detail, edit mode, full-screen shop ledger) now step back one level with the phone's back button, exactly like the on-page "◀ ফিরুন" button. After that, back continues through the normal tab history like every other page.

### DSR → আমার লেনদেন
- Five boxes: **দেওয়া · ফেরত · ড্যামেজ · কমিশন · ছাড়** (all in ৳). Tap a box to open its detailed history (which product, which shop); tap again, ✕, or the back button to close.
- Last box: **ম্যানেজার/মালিককে জমা দিতে হবে** = cash shops paid at the sale + old dues collected − cash paid to shops for damaged goods (same formula as the end-of-day settlement). Shows how much was already handed over via settlement and how much is still due.
- New read-only endpoint `GET /api/sr-payments?action=dsr-my-day&dsrId=&from=&to=` (added inside the existing sr-payments function).

## 5.1.0
Scope: audit items CALC-1…10, PERF-1…8, SEC-5 (schema/migrations), OPS-1, setup docs. SEC-1…4 (PIN/auth) intentionally NOT changed.

### Calculations
- CALC-1 one net-profit definition (`computeProfit`) used by dashboard, sales-range, owner view, analytics report.
- CALC-2 van stock carries over (RPC `van_stock_totals`, JS fallback).
- CALC-3 bonus rule snapshot columns on `transactions`; bonus via RPC `bonus_net_units`.
- CALC-4 due balance rounded to 2dp; <0.01 counts as cleared; "mark cleared" pays the balance.
- CALC-5 server-side pricing (`api/_lib/money.js`).
- CALC-6 per-line 2dp rounding, case price for whole cases; `dmg_claims` amounts numeric(14,4).
- CALC-7 `audit_log` table + writes on due edit/delete.
- CALC-8 idempotency (`idempotency_keys`, `requestId`), client auto-attaches ids.
- CALC-9 stock guard trigger + pre-check + toggle (`app_settings.block_negative_stock`).
- CALC-10 Dhaka dates on server and client.

### Performance
- `fetchAll` single request when < 1000 rows; aggregate RPCs; explicit columns; paging; owner dashboard rebuilt on aggregates.
- Less polling (GPS, chat); cron batching + `cron_runs`.
- pg_trgm + extra indexes.

### Deploy / DB
- `schema_fresh.sql` (guarded) and `migrations/001_v5_1_fixes.sql` (idempotent). Old `schema.sql` removed.
- `vercel.json` routes → rewrites. `CRON_SECRET` header only.
