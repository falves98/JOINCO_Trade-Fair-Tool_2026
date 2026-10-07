# JOINCO Sourcing Intelligence

A private, mobile-first web app for JOINCO buyers at sourcing fairs.

There are two ways to run the same app (`app/index.html`):

1. **Standalone server (recommended).** `server/` is a Node app with its own logins, database and photo storage. It calls Claude with an Anthropic API key kept on the server, so photo analysis works in any phone browser. Deploy instructions are below.
2. **claude.ai Artifact (pilot only).** https://claude.ai/artifact/1Jvc4U48x6BoTorrFdQBFj. Capture, review, database and export work there, but claude.ai does not offer image analysis to this page on this account, so it can't run the AI step.

## Workflow

New visit → take or upload several photos → Claude analyses all of them in one call → buyer reviews an editable draft → buyer confirms → the records are saved to the shared database.

- Photos are compressed on the phone (max 1800 px, JPEG) and uploaded as soon as they are taken, so analysis can start right away.
- The AI result is stored only on the visit (`visits.ai` and `visits.review`). Suppliers, Contacts and Product Opportunities are written **only** when the buyer taps *Confirm & save*.
- Every extracted field has a source tag the buyer can change: **Observed**, **Supplier claim**, **AI inference** or **Buyer note**, plus a short evidence note naming the photo it came from.
- *Before you leave the booth* lists missing commercial information (price, MOQ, Incoterm, lead time, OEM, certificate proof…) as a checklist with answer fields.
- When a supplier matches an existing record (by normalised name or website domain), the review screen offers to link the visit to it instead of creating a duplicate.
- The Export tab downloads CSV files for all five tables, either one at a time or together as a zip. Each extracted field has `_source` and `_evidence` columns.

## Deploy the standalone server

Requirements: an Anthropic API key, and a host with a persistent disk (the database and photos live in `DATA_DIR`).

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Server-side only; never sent to browsers |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First admin account, created on first start |
| `SESSION_SECRET` | Signs login cookies (generated and stored if unset) |
| `DATA_DIR` | SQLite database + photos (default `server/data`, `/data` in Docker) |
| `ANTHROPIC_MODEL` | Default `claude-opus-5-5` |
| `ANALYSIS_EFFORT` | Default `low` for speed at the booth; `medium` or `high` for more careful reading |

- **Render:** New → Blueprint → this repo (`render.yaml`). Enter the API key and admin login when asked.
- **Fly.io:** see the commands at the top of `fly.toml`.
- **Any Docker host:** `docker build -t joinco . && docker run -p 8080:8080 -v joinco-data:/data -e ANTHROPIC_API_KEY=... -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... joinco` behind HTTPS.
- **Locally:** `cd server && npm ci && ANTHROPIC_API_KEY=... ADMIN_EMAIL=you@joinco.com ADMIN_PASSWORD=... INSECURE_COOKIE=1 npm start`.

After it's running, the admin signs in and adds buyers under **Export → Team**. Each buyer gets their own email and password. On the phone, open the URL in Safari and choose **Add to Home Screen**.

Server pieces: `server/server.js` (HTTP API, SQLite via `node:sqlite`, photo files, scrypt passwords, signed cookies, Anthropic SDK call with `fallbacks: "default"`), `server/runtime.js` (browser-side `claude.use()` shim over the API), `server/login.html`.

## Platform (Artifact version)

The app is one HTML file (`app/index.html`) hosted as a claude.ai Artifact. It doesn't use Google, Airtable, Firebase or Make.

| Need | Provided by |
|---|---|
| HTTPS hosting, private by default | claude.ai Artifact |
| Authentication | claude.ai sign-in; only people the owner shares with can open it |
| Database (shared, realtime) | Artifact `db` capability |
| Image storage | Artifact `assets` capability (makes the app organisation-internal) |
| Multimodal AI | Artifact `sample` capability with images (Claude), runs on the viewer's Claude account; no API key exists in the page |
| CSV download | Artifact `downloads` capability |

## Data model

| Collection | Key fields |
|---|---|
| `suppliers` | name, nameKey, country, address, website, domain, businessType, prov{field:{src,ev}}, createdBy, createdAt |
| `visits` | status (capturing → analysing → review → confirmed), fair, booth, supplierId, supplierName, buyerNotes, beforeYouLeave[], ai{raw}, review (editable draft), createdBy, confirmedBy |
| `contacts` | supplierId, visitId, name, role, email, phone, whatsapp, prov |
| `products` | supplierId, visitId, category, description, specs, materials, packaging, certifications, moq, price, currency, incoterm, oem, score (0–100), aiScore, scoreSrc, scoreRationale, status (lead/shortlist/rejected), prov |
| `images` | visitId, assetId (served at `/_blob/<assetId>`), kind (AI classification), summary, takenAt, seq |

## Access

To add JOINCO buyers, open the app and use **Share**. Give buyers **Editor** access, because uploading photos needs it. People with view-only access can browse the data but can't capture visits. Each buyer approves Claude and image analysis once, the first time they tap *Analyse*.

## Tests

`tests/e2e.js` runs the full workflow in headless Chromium at phone size against a mocked runtime: photos → analysis → review edits → confirmation → supplier match on a second visit → CSV export.

```
node tests/e2e.js app/index.html /tmp/out          # Artifact runtime, mocked
node tests/e2e_noimg.js app/index.html /tmp/out    # Artifact view without image support
node tests/e2e_server.js /tmp/out                  # standalone server, mock Anthropic endpoint
```
