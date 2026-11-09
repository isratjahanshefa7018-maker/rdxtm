# AXIION DMS Panel v5.27.0 — new deployment

1. Supabase (new, empty project): run `schema_full_new_deployment.sql` once in the SQL editor (complete schema incl. offer + price-history).
2. Vercel: deploy this folder (build: `npm run build`, builds `public/index.html` from `src/index.html`). Set the Supabase env vars as in SETUP.md. 12 API files, no more.
3. Existing live database: do NOT run the schema; use `migrations/` (006 is optional).
4. Tests (optional): `node tests/session0.test.js` … `session3.test.js`.
