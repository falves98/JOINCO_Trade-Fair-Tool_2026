# JOINCO Sourcing Intelligence

A private, mobile-first web app for JOINCO buyers at sourcing fairs.

**Live app:** https://claude.ai/artifact/1Jvc4U48x6BoTorrFdQBFj (private; see *Access* below)

## Workflow

New visit → take or upload several photos → Claude analyses all of them in one call → buyer reviews an editable draft → buyer confirms → the records are saved to the shared database.

- Photos are compressed on the phone (max 1800 px, JPEG) and uploaded as soon as they are taken, so analysis can start right away.
- The AI result is stored only on the visit (`visits.ai` and `visits.review`). Suppliers, Contacts and Product Opportunities are written **only** when the buyer taps *Confirm & save*.
- Every extracted field has a source tag the buyer can change: **Observed**, **Supplier claim**, **AI inference** or **Buyer note**, plus a short evidence note naming the photo it came from.
- *Before you leave the booth* lists missing commercial information (price, MOQ, Incoterm, lead time, OEM, certificate proof…) as a checklist with answer fields.
- When a supplier matches an existing record (by normalised name or website domain), the review screen offers to link the visit to it instead of creating a duplicate.
- The Export tab downloads CSV files for all five tables, either one at a time or together as a zip. Each extracted field has `_source` and `_evidence` columns.

## Platform

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
node tests/e2e.js app/index.html /tmp/out
```
