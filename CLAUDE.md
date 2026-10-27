# CLAUDE.md — read this first

## What this is
Offline PWA for Strongsville Emergency Food Bank volunteers: scan or type the donated item, get the
exact item and its current price. Prices come from the Walmart I/O Affiliate API. Design: docs/WORKFLOW.md.

## Rules
- Since 2026-10-07 Claude Code owns the pre-rollout automation (docs/DECISIONS.md, that date): it ships tested, reviewed
  changes without waiting, and the owner's decisions arrive as `pipeline-alert` issues. Still proposed first, never done unilaterally:
  anything touching secrets or the Cloudflare account, crawl scope, and work outside that list.
- docs/DECISIONS.md is the source of truth; append a dated entry for every new decision.
- Never commit secrets. They live in GitHub Actions secrets, Cloudflare Worker secrets, and the owner's password manager.
- The owner works from a phone. Anything that must run goes through GitHub Actions or Cloudflare.

## How the pipeline runs itself (since 2026-10-07)
Nothing waits for a human. `.github/workflows/pipeline.yml` is scheduled every 30 minutes (17 and 47 past the hour; GitHub fires it irregularly, see RUNBOOK) and chains its own next run:
a cheap peek reads `state/run.json`, the published manifest, `sizing.json`, `audit/latest.json` and the candidate `gates.json`
through the GitHub API and stops when nothing is due. Otherwise `crawler/ci.py` picks ONE Walmart job per run, in priority order:
sizing pass (once per 30 days) > crawl resume > build + gates + publish > weekly live audit > identify refresh >
Strongsville store prices (tiers in data/store.json: consumable departments on 28/56-day cycles; only Walmart's own in-stock offer counts). Every department is re-crawled 30 days after its last crawl (`refresh.fixed_days` in data/schedule.json, docs/DECISIONS.md 2026-10-19; the measured per-department planner of crawler/cadence.py is bypassed while it is set). Cadence lives in
`data/schedule.json` (also `volunteer_hours`: the pipeline's pace while volunteers may be using the live check; not applied yet, docs/DECISIONS.md 2026-10-21); gate thresholds in `data/gates.json`; the sample review (up to 600 rows in batches of 300, drawn from the rows the last reviewed snapshot did not have, judged on evidence: docs/DECISIONS.md 2026-10-13 and 2026-10-14) uses the `ANTHROPIC_API_KEY` secret.
A snapshot publishes only when every gate passes; otherwise it holds and an issue is opened. A review that cannot run at all (key, credits, model) for `sample_review.unavailable_grace_days` (21) stops holding a candidate the deterministic gates pass; the issue stays open. GitHub's cron is unreliable, so the pipeline Worker's cron watchdog dispatches `continue` whenever the pipeline sits idle 40 minutes (needs its `GH_DISPATCH_TOKEN` secret).

## What the owner decides (everything else is automatic)
- An open issue labelled `pipeline-alert` is the to-do list: `[gates-hold]` (read the report in the issue; fix rules or thresholds,
  or run `plan=approve` to override), `[review-key-missing]` (add the `ANTHROPIC_API_KEY` secret or set
  `sample_review.required=false` in data/gates.json), `[review-key-invalid]` (replace the key: 401/403), `[review-credits]`
  (add Anthropic credits; auto-reload is off), `[review-model]` (set the `SFB_REVIEW_MODEL` variable; the review first tries the newest current model itself), `[schedule-gap]` (pipeline runs hours apart: add or renew the pipeline Worker's `GH_DISPATCH_TOKEN` secret so its cron watchdog can start runs), `[pipeline-failed]`, `[deploy-failed]`, `[deploy-mismatch]`,
  `[audit-regression]`, `[audit-failed]`, `[accuracy-budget]` (the per-department refresh plan cannot hold the target inside the Walmart quota: raise `refresh.crawl_share` or lower `refresh.target_close_rate` in data/schedule.json, or widen `live_match_tolerance`), `[data-store-size]` (branch past 1 GB: decide where raw pages move), `[snapshot-archive]`, `[stale-prices]`, `[throttled]`, `[search-gold]` (the 351-query search gold set fell below 95%: fix ranking or a wrong expectation), `[crawl-truncated]` (a department ended far short of Walmart's page count or its id was refused: give it a `split` or fix the node id), `[tests-failed]`. Issues close themselves when the condition clears.
- Changing scope or rules: edit `data/categories.json`, `data/sentinels.json`, `data/gates.json` (the next run re-evaluates
  a held candidate automatically when one of these changes) or `data/schedule.json` (cadence only: applies from the next run,
  never re-evaluates a candidate).
- When Claude Code is asked to look: read the open alert issues and `data-store:build/candidate/report.md`, diagnose, propose fixes
  (never edit published data by hand; change rules, rebuild, re-check). Manual plans still work from the Actions tab:
  continue | full | core | approve | identify | audit | size | status | rollback (rollback_to: previous or a kept
  `snapshot-*` release; the newest three publishes are kept as GitHub Releases). The anthropic-key-check workflow
  tests the ANTHROPIC_API_KEY secret (HTTP status and pass/fail only).

## Commands (also runnable locally with WM_CONSUMER_ID / WM_PRIVATE_KEY set and SFB_STORE pointing at a data-store checkout)
- `python -m crawler.ci --plan continue|core|full|approve|identify|audit|size|status|peek|finish|rollback|store`
- `python -m unittest discover tests` (402 tests; `tests/fixtures/run-live.json` is the live crawl state the pipeline must resume from)
- `cd app && node --test tests/*.test.mjs`

## Layout
- crawler/ — wm.py (signed client, pacing), crawl.py (resumable), normalize.py (rules), process.py (snapshot),
  qa.py (gates/publish), releases.py (kept snapshots, rollback), classify.py (store categories, exclusions, placeholders),
  valuation.py (price sanity, equivalent values), audit.py (weekly live audit), history.py (price history), review.py (sample review),
  sizing.py (department sizes), throttle.py (429 analysis, pace cap), identify.py (non-Walmart barcodes → equivalents; USDA FoodData Central Branded Foods for the chains in data/brands.json, Open Facts for the rest),
  storeprice.py (Strongsville store prices: refresh, apply, probe), cadence.py (per-department refresh intervals from measured drift), ci.py (orchestrator + decide())
- data/categories.json — scope (departments, consumable or not, `split` child nodes for Home and Home Improvement; edits apply to the crawl in progress), category ids and path hints; docs/CATEGORIES.md — how every item is labelled
- data/sentinels.json — items that must always be found and priced; data/store.json — the store whose shelf prices are shown
- data/brands.json — other chains' store brands and their barcode company prefixes (identify.py matches them to Walmart's own brands; the app ranks Walmart's own brand first for a typed one and names the store of a scanned one); `walmart_value_brands` and `generic_names`: every item is valued at its value-brand (Great Value) equivalent in the app (db-worker.js valueEquivalent, docs/DECISIONS.md 2026-10-27); data/categories.json `consumable_rules`/`durable_rules` `max_price` — the price ceilings ($150 / $100), nothing above them is in the list
- data/gold-search.json — search gold set (351 queries, checked on every real deploy by app/tools/gold.mjs)
- data/gates.json — acceptance thresholds (null = measure only); data/schedule.json — cadence; data/review-criteria.md — sample review rules
- .github/workflows/ — pipeline.yml (30-min continue, manual plans), deploy-app.yml, tests.yml, keepalive.yml,
  app-browsers.yml (manual: app perf + screenshots in Chromium and WebKit, comparison in the run summary); actions/alert (issue alerts)
- pipeline/ — Cloudflare Worker (public /v1/price/<gtin> live check, token-gated test routes)
- app/ — PWA (public/ shell + workers, tools/ fixture + pack builder + measure, tests/); deploy-app.yml deploys it
- docs/ — PLAN, DECISIONS, SCHEMA, RUNBOOK, WORKFLOW
