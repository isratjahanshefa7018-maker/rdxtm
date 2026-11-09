# OFFER_PROGRESS.md

## Session 3 of 4 — PROFIT PANEL, DASHBOARD, REPORTS, ROLE SAFETY (v5.27.0) — DONE — ALL 4 SESSIONS COMPLETE

### Done
- `computeProfit` (api/_lib/db.js) now returns normalSales, offerDeduction, actualSales, cashProfit, offerProfit, offerReceived, offerPending, adjustment(s), companyPayments, settledBy; `netProfit` = cash + offer + সমন্বয় (payment date only). Offer figures come from `offerLedger.profitOffer(from,to)` (sums `getOfferAllocation().days` by SALE date, adjustments by PAYMENT date).
- `offerLedger.profitAllowed(query)`: owner/manager only (actorId verified in user_passwords; role=dsr/so/driver always refused). Used by dashboard.js (main + sales-range), report.js, expenses.js deposit-history. The app adds `actorId` automatically to those GETs (apiFetch).
- UI: profit hero card (total + ক্যাশ লাভ | অফার line, tap for details `profDetail()`), month card, “পাওনা অফার (কোম্পানির কাছে)” card (`offerDue` in the dashboard payload), report profit detail + offer receivable, company payments in the deposit history (received money, not sales/profit).
- Fixed the DSR transaction boxes (দেওয়া box + “N টি দোকানে বিক্রয়”): missing global `dg()`.
- Tests: `node tests/session3.test.js` (22 pass); session0 (13), session1 (19), session2 (26) pass. API count 12. No migration needed.

### Unfinished / to check on a device
- Not browser-tested on a real phone (only a jsdom check of the box pop-ups and the new panel HTML). Please open: profit card + details, পাওনা অফার card, report page, deposit history, DSR boxes (owner and DSR login), A4/thermal memos, WhatsApp share.
- Report per-product / per-SR / per-day tables keep the old “মোট লাভ*” (gross − cost, which equals cash + offer); only the new detail block and the day rows’ `cashProfit/totalProfit` fields carry the split. Per-day table UI does not yet show the split columns.
- Company payments carry no cash/bank method, so the cash/bank view lists them as one “received” line, not split by bank vs cash.
- “Offer balance −3,000” in the brief: the balance drops by exactly the payment (tested with enough earlier offers). A 3,000 payment against only 330 owed becomes a +2,670 সমন্বয় by the Session 2 rule.
- dashboard sales-panel/DSR branches were not changed (they never carried profit); other sale-type reads still show gross as noted in Session 1.
- `public/index.html` rebuilt with esbuild.

## Session 2 of 4 — COMPANY OFFER LEDGER (v5.26.0) — DONE

### Done
- Section "কোম্পানি অফার হিসাব" (tab id `coffer`, page `pg-coffer`, menu: রিপোর্ট ও হিসাব) for OWNER + MANAGER; not in MENU_PERMS for so/dsr/driver; API rejects them too.
- Per-product ledger from stored snapshots (cases, bottles, cases since last payment, earned, returned, received, adjusted, balance), totals, day table.
- Company payments (add/edit/delete, own password via `askDsrPin`), optional products + period, "সমন্বয় সহ বন্ধ করুন" checkbox and a post-save prompt when the payment is short.
- FIFO display-only settlement, positive / negative adjustment, "কোম্পানিকে বিক্রয় পাঠান" (copy/WhatsApp text, A4 + thermal memo through MEMO.show).
- Tests: `node tests/session2.test.js` (26 pass), session0 (13), session1 (19) still pass.

### Files
`api/_lib/offerLedger.js` (new), `api/products.js`, `src/index.html`, `public/index.html` (copied unminified — esbuild not installed here; Vercel's build step re-minifies), `package.json`, `package-lock.json`, `CHANGELOG.md`, `OFFER_PROGRESS.md`, `tests/session2.test.js`.

### getOfferAllocation
Location: `api/_lib/offerLedger.js` (the project's helper folder is `api/_lib`, not `/lib`; helpers there are not serverless functions). Also exported: `salesSummary`, `ledger()`, `loadRows()`, `readPayments()`, role checks.
Signature: `getOfferAllocation(sales, returns, payments)`
- sales/returns: `[{date, productId, productName?, cases, units(bottles), offerDeductionTotal}]` (rows with 0 deduction are ignored)
- payments: `[{id, date, amount, productIds?:[], from?, to?, close?}]`
Return shape:
`{ days:[{date,sold,returned,earned,received,adjusted,pending}], products:{[pid]:{productId,name,cases,bottles,soldCases,soldBottles,returnedCases,returnedBottles,sold,returned,earned,received,adjusted,pending,balance,adjustmentNet,casesSincePayment,bottlesSincePayment,lastPaymentDate,daily:[…same day shape…]}}, total:{sold,returned,earned,received,adjusted,pending,balance,adjustmentNet}, adjustments:[{paymentId,date,amount(+over / −close),kind:'over'|'close',productId|null}], payments:[{id,date,amount,applied,over,writtenOff,adjustment,unsettledBefore}], lastPaymentDate }`
Notes for Session 3: days are by SALE date; `earned = sold − returned` where a return lowers the oldest pending bucket of that product (a return with nothing pending becomes a credit absorbed by later sales); `adjustments` are the only payment amounts that touch profit, dated on the payment date. Payments only settle offers with sale date <= payment date (a payment before any earned offer is all "over" = positive adjustment).

### Where payments are stored
`app_settings.profit_rules._store._offerPayments` (array, newest 5000): `{id, date, amount, note, productIds[], from, to, close, by, at, editedBy?}`. No migration. Adjustments are NOT stored — they are recomputed from payments + snapshots every time.

### API
`POST /api/products` with `action`: `co-ledger`, `co-send` (read: actorId must be owner/manager), `co-pay-add`, `co-pay-edit`, `co-pay-del` (write: actorId + own password pin, role owner/manager). Reads trust `actorId` (same trust model as the rest of the app); writes verify the password.
API count: 12 (unchanged). Migration: not needed.

### Remaining
- Session 3: profit panel using `getOfferAllocation().adjustments` (+/− only) and per-day earned; split the offer out of pending.discount in DSR settlement.
- Not browser-tested (no UI run here): layout of the new page, modals and the A4/thermal memo should be checked once on a phone.
- Send summary counts only rows that earned an offer (deduction > 0); sales below the qualifying case count are not listed.
- Editing/deleting a payment re-derives all adjustments (they are computed, not frozen) — Session 3 should read them live.

## Session 1 of 4 — AUTO OFFER DEDUCTION (v5.25.0) — DONE

### Done
- `calcOfferDeduction` helper + automatic deduction on DSR/SO shop sales (`visit-sale`), point sales (`point-sale`, `transactions` dsr_sale/point_sale), only when date >= start date (new setting).
- Setting "অফার হিসাব শুরুর তারিখ" with "আজ থেকে চালু করুন" (owner + own password; set once; earlier sales never get an offer).
- Separate line "কোম্পানি অফার ছাড়" on: DSR sale screen, on-screen slip, A4/thermal cash memo (`MEMO.sale`), point-sale slip (`MEMO.stock` offer), point-sale preview, shop ledger bill.
- Bill payable / shop due row / DSR expected cash use the reduced amount; DSR settlement adds the deduction to the company-borne discount (pending.discount, summary.offerToday) so the DSR due balances.
- Returns (shop `sale-return`, `point_damage_return`) reverse the deduction proportionally from the original sale snapshot (fallback: latest sale of that shop+product) and store it on the return line; due lowered by the net value.
- DSR/SO: 🎁 offer-rule badges hidden; they see only the reduced bill.
- Tests: `node tests/session1.test.js` (19 pass), `node tests/session0.test.js` (13 pass).

### Where things live
- `api/_lib/offer.js` (pure + storage): `calcOfferDeduction(snapshot, casesSold)` → {qualifyingCases, exactPerCase, perCase, total, valuePerBottle, shopPricePerCase}; `reverseOfferDeduction`; `applyOffers(lines,{date,start})`; `applyReturnOffers(lines, src)`; `sourceOffers(where,types,productIds,date)`; `persist(txId,lines)`; `hydrate(rawRows)`; `dedOf(row)`; `netDeduction(rows)`; `selCols()`; `getStartDate()`.
- Client mirror: `offerCalc(product, cases, dateIso)` (next to `num()` in src/index.html); `S.offerStart`; `_offLoad`, `_offSettingsHtml`, `_offStart` (Settings card, owner).
- API: `GET /api/products?action=offer-settings`, `POST /api/products {action:'offer-start'}`. Responses of visit-sale / point-sale / transactions add now carry `offerTotal` (+ `offerLines`). `/api/transactions` rows carry `offerCasePrice`, `offerDeductionPerCase`, `offerDeductionTotal`. Ledger events carry `offer`; `dsr-my-day` carries `offer:{total,lines}`.

### Snapshot fields (per sale/return line)
sellPrice, buyPrice, unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney (Session 0 columns) + NEW offerCasePrice, offerDeductionPerCase, offerDeductionTotal.
Storage: optional columns `transactions.offer_case_price / offer_deduction_per_case / offer_deduction_total` (`migrations/006_v5_25_offer.sql`). WITHOUT the migration the same values are kept in `app_settings.profit_rules._store._offerLines` keyed `txId|productId` (newest 20,000). Gross `total_revenue` and stock rows are unchanged (gross); the deduction is subtracted wherever a payable is built.

### API count: 12 (unchanged — helper in api/_lib)
### Migration: optional (006). Recommended before heavy use so the snapshot sits on the rows.

### Remaining / notes
- Not browser-tested (no UI run here); build passes (esbuild) and the logic is covered by the fake-DB tests.
- Preview of the reversal on the shop sale-return / point-return screens is not shown (server applies it and returns `value`).
- Not touched on purpose: dashboards/reports still sum GROSS revenue; profit panel, company receivable ledger and offer payments are Sessions 2–3. Settlement folds the deduction into pending.discount — Session 2/3 should split it into its own "company owes us" figure.
- Other sale-type reads still show gross: `dsr_sale` totals in dashboard.js, report.js, `shops.js` ~L458/492 (shop buy totals), DSR "my transaction" boxes except `offer` lines.
- `dsr_sale` DSR slip lists lines at gross unit price; the offer line carries the total deduction (no per-line deduction column on the A4 table).
- Start date can be set once (cannot be moved or switched off from the UI); to stop offers for a product set its offer to 0.

## Session 0 of 4 — PRICE CHANGE SAFETY (v5.24.0) — DONE (core), items below remain

### Done
- Audit of current-product reads for historical data (see "Fixed" / "Remaining").
- Snapshot on every sale / point-sale / return row; returns price from the original sale snapshot.
- Price history (table optional, settings-store fallback).
- Legacy freeze: owner dialog, backup, dashboard warning, manual Settings button, idempotent server routine.
- Tests: tests/session0.test.js (13 pass).

### Snapshot field names (no migration: mapped onto existing transaction columns)
| Snapshot field | Stored in |
|---|---|
| sellPrice | transactions.selling_price (per piece) |
| buyPrice | transactions.purchase_price (per piece) |
| unitsPerCase | transactions.rule_case_size |
| offerCasesReq | transactions.rule_bonus_cases_req |
| offerFreeUnits | transactions.rule_bonus_free_units |
| offerFreeMoney | transactions.rule_bonus_free_money |
| offerDeductionPerCase / offerDeductionTotal | derived on read from the three offer fields (`snapOfRow` in api/_lib/snapshot.js) |
| snapshotAt | transactions.created_at |
| legacy | rule_case_size NULL (not frozen) or rule_bonus_cases_req = 0 (frozen); `mapTx().snap.legacy` |
| frozenAt / freeze done flag | settings store: app_settings.profit_rules._store.freeze {done, at, by, count} |
| price history | product_price_history if present, else _store._priceHistory (capped 3000) |
`mapTx().snap` is returned by /api/transactions (rule columns are added to its SELECT only if the DB has them).
Commission and discount are already stored per line as amounts (commission_amt, discount_amt) and are never recalculated. Products have no commission/discount field of their own; `diffProduct` already tracks such fields if added later.

### Fixed (read current product fields for history)
1. money.js priceItems: return / dsr_sale_return / point_damage_return priced at current price and current buy price.
2. sr-payments.js settle: van-return value/cost used current buy price and current rule.
3. sr-payments.js damage-collect: shop damage valued at current price (now latest sale snapshot of that shop).
4. db.js computeBonusRangeSummary: lines without snapshot used today's offer (now no offer).
5. report.js product-wise: price columns came from the current product.

### Remaining (not done in this session)
- attendance.js `_targetStats` / case counts, claims.js, transactions.js due-history, dashboard.js (today's net-sale bonus at ~L457 and some case-size displays) still use the CURRENT case size / bonus of the product. Fix: select rule_case_size per row and use it.
- dashboard.js stock value (sellValue) is current stock x current price on purpose (inventory today).
- No server-side "edit sale" endpoint exists in api/*.js; quantity edits are handled by the screens that re-post, which now get the snapshot only for returns. If a quantity-edit endpoint is added, it must copy rule_*/selling_price/purchase_price from the original row.
- Frontend places that show a NEW-transaction price from S.products (pickers, order screens, 4471/4500/6320...) are correct (new transactions). Frontend reprint/WhatsApp/A4/thermal read the line's own sellingPrice and were not changed; not browser-tested here.
- Owner "freeze" was tested against an in-memory fake database only; run it once on a staging copy / after a Supabase backup.

### Files changed
api/_lib/snapshot.js (new), api/_lib/money.js, api/_lib/db.js, api/products.js, api/transactions.js, api/shops.js, api/sr-payments.js, api/report.js, api/due-calendar.js, src/index.html, public/index.html (rebuilt), package.json, package-lock.json, CHANGELOG.md, OFFER_PROGRESS.md, tests/session0.test.js

### API count: 12 (unchanged; helpers live in api/_lib)
### Migration: none required (optional product_price_history table)
### Next: Session 2 of 4
