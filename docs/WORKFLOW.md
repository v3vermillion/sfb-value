# Data workflow

Goal: the volunteer scans or types the item in their hand and gets the exact item and its current price, offline,
never a blank. Everything below serves that.

## Architecture
- **Crawler, gates and publishing: GitHub Actions** (`.github/workflows/pipeline.yml`, code in `crawler/`). Runs for
  hours at no cost on a public repository; working data lives on the `data-store` branch, compacted to one commit after
  every publish so the repository never grows.
- **Live price check and schedule watchdog: Cloudflare Worker** (`pipeline/`). Signs Walmart requests for the app's
  online lookups; its cron starts a pipeline run whenever GitHub's scheduler has gone quiet.
- **The app: offline PWA** (`app/`, see `app/README.md`). A database pack per department, search and a barcode scanner on
  the phone; deployed to Cloudflare by `.github/workflows/deploy-app.yml` after every publish.

## Pipeline
Every run does one job, chosen by `crawler/ci.py decide()` from a few small state files read through the GitHub API, in
this order of priority:

1. **Size** every department once a month (one call each), so a crawl that ends early is noticed.
2. **Crawl** the departments whose refresh interval has passed (`state/cadence.json`), every page, first-party listings
   only (`soldByWmt=true`: marketplace prices run five to ten times higher). The cursor is saved after every page; a run
   that reaches its time budget starts the next one itself; a run throttled by Walmart backs off and resumes.
3. **Normalise and build** (`crawler/normalize.py`, `crawler/process.py`): size and pack from the product name (Walmart's
   size field is unreliable), variant words, per-unit price for consumables, the store category (`crawler/classify.py`,
   docs/CATEGORIES.md), barcodes as GTIN-14. Retired barcodes are kept and flagged, since donors give old stock. A
   clearance or flash price keeps the last normal price. Listings that are not products, and departments a food bank
   never receives, are left out.
4. **Gate** the candidate (`crawler/qa.py`, thresholds in `data/gates.json`): every department finished, every sentinel
   item priced, a live check of sampled prices against Walmart, size parsing, per-unit outliers, item and category counts
   against the previous snapshot, price drift, and a sample review of the rows the last reviewed snapshot did not have,
   judged on evidence. A held snapshot opens a `[gates-hold]` issue with the report; the previous snapshot stays live.
   The 351-query search gold set is checked after a publish, on the app's built pack (deploy-app): below 95% it opens
   `[search-gold]`, below 90% the deploy stops and the live site keeps the previous build.
5. **Publish** to `data-store:build/published/` with a manifest; the price history records what changed
   (docs/HISTORY.md); the newest three publishes are kept as GitHub Releases for rollback. The app deploys itself next.
6. **Audit** the published prices against Walmart every week, per department, and record each department's drift.
   Every department is re-crawled 30 days after its last crawl (`refresh.fixed_days`, 2026-10-19); the measured
   per-department intervals (`crawler/cadence.py`) apply only when that is set to 0.
7. **Identify** barcodes Walmart does not sell (`crawler/identify.py`, monthly) from USDA FoodData Central's Branded Foods
   (the other chains' brands in `data/brands.json`: label data from the barcode registry) and Open Food, Beauty and Products
   Facts (everything else), matched to the closest Walmart item for an equivalent value with a confidence level; what both
   miss, volunteers teach the app by a search by name, shared between phones through the Worker (`/v1/learned`).
8. **Store prices** (`crawler/storeprice.py`): the Strongsville Supercenter's own shelf price and stock for consumable
   rows, on the tiers in `data/store.json`.

## Schedule
- A scheduled run every 30 minutes, plus the Worker's cron watchdog, plus a run that chains its successor while work
  remains. A run with nothing due ends in under a minute.
- Every department is re-crawled 30 days after its last crawl (`refresh.fixed_days`, 2026-10-19), so each refresh is a full
  crawl of a few days; the measured per-department planner is bypassed while that is set.
- Store prices: food, household, personal care and health every 28 days; baby, pets, beauty and pharmacy every 56.
- The pipeline is meant to slow to 3 calls a minute on weekday mornings (`volunteer_hours`), when volunteers may be
  using the live check that shares the same Walmart key; not applied yet (docs/DECISIONS.md 2026-10-21).

## How the app resolves an item (decision 2026-10-06)
1. **Barcode → exact Walmart item**, retired barcodes and single units from multipacks included.
2. **Store-printed labels** (meat, deli, bakery; barcodes starting with 2) carry their price and are decoded directly;
   produce stickers (PLU codes) give the item and its price per pound or each.
3. **A barcode Walmart does not sell** (Aldi, Giant Eagle, Marc's, Meijer, Target, Dollar General, Kirkland, regional
   brands) is identified offline and valued at the closest Walmart equivalent, labelled "equivalent value" with the
   basis item shown. A barcode this phone matched before (an unknown one, found by name and added to the tally) opens
   that Walmart item as a remembered match; one under a listed store's company prefix (`data/brands.json`) is named by
   its store ("Kirkland Signature item (Costco)") and the name search starts with that brand.
4. **Typed search** shows brand, variant, size, pack and price; the volunteer taps the exact one. In this repository
   (`data/brands.json` `search_scope: "walmart"`, decision 2026-10-27) only Walmart's own brands and unbranded fresh food
   are searched: "green beans 14.5 oz" lists Walmart's green beans, nearest size first; another brand typed is set aside
   and named, and a name brand is found by its barcode only. Another chain's
   store brand in the query (Kirkland, Clancy's, Market District, Happy Belly...) is set aside and Walmart's own brand
   ranks first: the same price tier, and the sheet says so.
5. **Live check**: when the phone is online, an unknown barcode is priced through the Worker; a live price above the
   list's ceiling (one figure for every item, the higher department ceiling: $150; the pack manifest's `priceCeiling`) is not believed.
6. **Last resort**: the same product type at the same size, per unit, flagged. Never blank, never unpriced.
7. **Valued at Walmart's value brand** (decision 2026-10-27): whatever the item resolved to, a name brand is valued at
   its Great Value (Equate, Parent's Choice, ...) equivalent: the same kind of item, at the nearest size, priced by the
   ounce or count for the item's size (app/public/js/db-worker.js `valueEquivalent`; the value brands and the generic
   words of brand-name products in `data/brands.json`). The sheet names the value item and the brand's own price, and
   one tap values the item at its own price instead. With no close equivalent, the item's own Walmart price is used.

Used goods show the new retail price; whether to adjust for condition is food-bank policy.
