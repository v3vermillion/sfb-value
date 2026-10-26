# SFB Value — the volunteer app

Scan or type a donated item, see its exact Walmart price. Works with no network after the first open,
on the phone already in the volunteer's hand. Lives in `app/`; deployed to Cloudflare Workers static assets
by `.github/workflows/deploy-app.yml`; the price data is the pipeline's published snapshot (`data-store` branch).
A full-size synthetic fixture stands in for it in tests and local builds; the interface never mentions it, and tally lines and Recent items priced from it are dropped when a real price list opens.

```
app/
  public/            the app as served (no bundler; plain ES modules)
    index.html       one screen: header, home, results, dock (search + Scan), sheets, scanner, toasts;  privacy.html  the privacy page (linked from About; the Play listing's privacy policy)
    app.css          design tokens + components (light/dark, reduced motion, high contrast)
    sw.js            app-shell service worker (precache list + build hash stamped at build time)
    js/app.js        UI controller
    js/db-client.js  install / cache / update the database pack; proxy to the worker
    js/db-worker.js  pack reader + search + lookups (runs off the main thread)
    js/tokenize.js   shared tokenizer (same file is imported by the pack builder)
    js/barcode.js    GTIN / UPC-E / store-label / PLU mathematics
    js/resolve.js    resolution engine (exact → label → PLU → equivalent → closest)
    js/scanner.js    camera (1080p, full-resolution decode, try-harder) + native BarcodeDetector (self-tested) or zxing-cpp wasm in a worker; zooms in by itself after 4 s without a read where the camera can; UPC-E in every form a detector reports it
    js/staleness.js  how old the prices are (fresh / amber from 40 days / red from 60) in a volunteer's words
    vendor/          zxing-wasm 3.1.5 reader (ESM, MIT; the wasm is zxing-cpp, Apache-2.0: both licence texts alongside)   fonts/  Geist + Geist Mono, Manrope for the boot screen wordmark (all OFL)
  tools/
    make_fixture.py  760k-row synthetic snapshot in the crawler's row format (through crawler/normalize.py); its
                     version is a hash of the inputs, so unchanged inputs never make phones re-download
    build-db.mjs     snapshot (items.jsonl.gz + equivalents) → sfb-pack v3 under dist/db/<version>/ (one shard per department)
    build-site.mjs   public/ → dist/, stamps sw.js + config meta, writes _headers
    serve.mjs        local static server that mirrors production headers
    measure.mjs      the performance numbers below (Playwright, 4× CPU throttle, fake camera); --browser webkit for iPhone's engine
    shots.mjs        phone-size screenshots (light/dark) + accessibility audit; --browser webkit too
    readme-shots.mjs the README's four dark screens from the live site and its real price list (into docs/screens)
    scroll-check.mjs the scrolling rules (best match by the search box, wheel, keyboard pan, sheets); --browser webkit too
    ui-check.mjs     layout, price-status, walkthrough, accessibility and design rules, one id per defect (docs/UI-AUDIT.md)
    icon/make_splash.py   the iOS launch images: the page's boot screen rendered at every screen size by icon/render-splash.mjs (Chromium), Floyd-Steinberg dithered to 256 colours
    make-barcode-clip.mjs  a UPC-A .y4m clip for Chromium's fake camera (measure.mjs --video)
    perf-table.mjs   markdown tables of measure/shots results: one browser, or Chromium vs WebKit (app-browsers.yml)
  tests/             node --test: barcode maths, tokenizer, resolution engine, staleness thresholds, storage persistence policy,
                     perf comparison flags
  wrangler.toml      assets-only Worker config
```

Commands: `npm run fixture` · `npm run build` (db + site) · `npm run serve` · `npm test` · `npm run measure` · `npm run shots`.

## Screens

One screen, two ways in. The **dock** at the bottom holds the search field and the Scan button, where a thumb
rests. Results are a bottom-anchored list: the best match sits right above the search box and the list grows
upward, so the eye never travels. Tapping a result (or a scan, a produce code, a store label) opens a
**bottom sheet** whose only loud element is the price, followed by the exact item (brand bold, variant, size,
pack, per-item price for packs), the date the price was checked, a note explaining anything unusual, a
quantity or weight stepper, and **Add to tally**. The sheet's coloured label names the resolution kind:

| label | when | what is shown |
|---|---|---|
| Exact item | barcode or chosen search hit found in the snapshot (incl. retired UPCs, "older barcode") | item, price, "1 of N" for a pack or a box counted in its name, other listings for the same barcode, the product's other sizes and counts |
| Store price label | barcode starting with 2 (scale labels: meat, deli, bakery) | price decoded from the barcode, GS1 verifier checked |
| Produce code | 4-digit PLU (and 9xxxx organic) | produce name, price per lb or each, weight stepper |
| Equivalent value | barcode Walmart doesn't sell, present in the equivalents table | estimated price, confidence, the Walmart basis item (tappable) |
| Closest match | the search had to drop a word to find anything; or it named another chain's store brand (Walmart's own brand shown as the equivalent); or a remembered match (a barcode this phone, or another volunteer's, matched by name before, "Not this item? Search by name" to correct it) | nearest item, the ignored word or the brand named |
| Live Walmart price | unknown barcode, phone online, Walmart has it | live price and name from the Worker route |
| Not in database | unknown barcode, nothing online | "Search by name" (search focused; a barcode under a listed store's prefix is named by its store and the brand is typed in) — never a silent blank; the item added from that search is remembered for the barcode on this phone (`sfb.learned.v1`, 500 most recent) and shared with the other phones through the Worker's `/v1/learned` (fetched at start, when online again and when the app returns to the foreground, at most every 15 minutes; a shared match never overrides one made on this phone) |

Recent rows: swipe left to uncover Remove (an Undo toast follows); the Remove button precedes the row in the document and reveals it on keyboard focus. Clear, at the section's edge, empties Recent with Undo.

Also: the home screen reads top-down and fills exactly the screen between the header and the dock: the food bank's
name with 1 John 4:19, a **status card** only when there is something to know or do (downloading with progress, more
departments on the way, no prices yet, storage full, server unavailable, a browser too old; tapping it opens Settings),
the **donation tally** card (total and item count; opens the tally), the Home Screen card in the browser, then Recent
(newest first, re-priced when a new price list opens) or a "Scan a barcode to begin" prompt. The header pill carries the
date of the price list ("Prices Oct 13": the app updates on every deploy, the prices only when the pipeline publishes a list);
on the results screen the header also shows the tally total. One function,
`priceStatus()`, feeds the pill, the card, the dot and the screen-reader announcement, so they always agree. On the first
launch a four-step **walkthrough** runs over the real screen (find the item, add it to the tally, review and share, saved
on this phone): the card sits beside its subject, flips or centres when there is no room, and the spotlit Scan button and
search box work. It is shown once per phone and can be replayed from Settings (`?tour=1` forces it, `?tour=0` skips it,
as the measuring tools do; a launch from the Scan shortcut skips it for that launch). The tally (items, total,
share/copy, remove with Undo, clear with an in-app confirmation), settings (appearance, vibration where the phone can
vibrate, live price check; a Prices card with the date, the source and the size on the phone, Check for new prices; a
three-step How to use; an About fold with the result-label legend, the small print and the build; Reset app data with an
in-app confirmation), scanner with torch, manual barcode entry for denied cameras and keyboard-wedge scanners. Nothing in
the interface refers to sample data. The layout is measured (`--top-h`, `--dock-h`; app.js viewport section; the
iOS 26 short Home Screen viewport is avoided by a standalone page height in app.css), and `tools/ui-check.mjs` checks the layout, status, walkthrough,
accessibility and design rules (docs/UI-AUDIT.md).

## Visual direction

Warm paper in light mode, warm near-black in dark mode, following the phone. Geist for text, Geist Mono for
barcodes. One accent (deep green) for the primary action; the five resolution kinds have their own hues, used
only as labels with a dot and text, never as the only signal. Text is 13 px minimum, prices 20 px in lists and
52–64 px in the sheet, targets 44 px minimum. Motion is a 320 ms rise on the rows nearest the thumb and a spring
on the sheet; `prefers-reduced-motion` turns it off and `prefers-contrast: more` lifts the secondary greys.

## Data: loading and indexing

**Pack format (sfb-pack v3)** — built once per snapshot by `tools/build-db.mjs`. The pack is cut into *shards*, one
per department (Pharmacy rides with Health and Medicine, Premium Beauty with Beauty; a department past 600k items
is split into interleaved parts). Each shard is a small v2-style pack with its own rank order, and every file is
**content-addressed**: `/db/files/<sha20>.bin.gz`, immutable, shared by every version that has the same bytes. A weekly
snapshot that only changed Food prices therefore downloads one file (Food's columns), not the whole pack. The published
list of 2026-10-13 (2.57M items, 2.45M barcodes, 118k equivalents) is 152 MB over the wire, 69 MB of it in the *core* tier
(`totalGzBytes`, `coreGzBytes` in the live manifest).

| file | contents |
|---|---|
| `<version>/manifest.json` | snapshot facts + `shards[]`: id, name, tier (`core` = consumable departments, `more` = durables), departments, item and token counts, and the path, size and gzip size of each shard file |
| shard `cols` | per-item columns in the shard's rank order: price (u32 cents: what the app shows), size (f32), pack (u16), unit, basis, flags, category (u8), Walmart id (f64), GTIN-14 (f64), flags2 (u8: placeholder, price withheld, discontinued, value confidence, store price, unit suspect, pack listing), value basis and Walmart's own price of a withheld item (or, for one unit of a "(N pack)" bundle listing, the bundle's own price). Placeholders are in the UPC index but never in the token index |
| shard `strings` | `brand\x1Fname` blobs with offset tables, split so no file exceeds Cloudflare's 25 MiB limit |
| shard `upc` | sorted GTIN-14 keys → rank, primary listing first for each barcode |
| shard `tokens` | sorted dictionary + varint-delta posting lists + each token's home category, then *head postings*: the items whose head noun (what the listing is: "Bananas", not "Banana Pudding") is exactly that word |
| `<version>/equiv.bin.gz` | equivalents: GTIN → estimated price, confidence, basis item (`shard << 24 \| rank`), name/quantity |
| (cols.bin, trailing) | `listingPack u16[N]`: the N of a "(N pack)" bundle listing, since 2026-10-19; an older pack derives it from the two prices |
| `<version>/plu.json` | PLU → produce name, unit, price and the matching produce item (`{shard, rank}`) |

An item's id in the app is `shard × 2^24 + rank`. Items inside a shard are in *rank order* (primary listing, store
brand, in stock, short name first), so a search that scans the AND of two bitsets from rank 0 upward meets the best
candidates first and can stop early. Each posting list decodes into a `Uint32Array` bitset per shard; single-letter
prefixes are warmed after load and the rest live in a small LRU.

**On the device** — `db-client.js` downloads the *core* shards first and opens the app on them (ready in under a
second on the fixture), then fetches the *more* shards in the background and adds them to the open database
("more" event). Shard files go into one Cache Storage bucket, `sfb-db-files`, shared across versions; each version's
manifest and per-version files go into `sfb-db-<version>`. Downloads run three at a time with three retries and
back-off; a network failure stops the queue and the app says "No connection — prices will download when it's back"
and retries every 30 s. Opening a shard means: read its files from Cache Storage, inflate with `DecompressionStream`,
wrap typed arrays over the buffers (no parsing, no copy), decode the dictionary. On every launch the app fetches
`db/current.json` (network-first, 1 KB); a newer snapshot downloads only the files it does not already have while the
current one keeps answering, and is swapped in when nothing is open (or on tap, or at the next launch). Updates are
applied one at a time; the swap is committed only after the new pack opens; a pack that fails to open is deleted and
the previous one restored; files no version uses any more are pruned afterwards.
The service worker precaches only the app shell (HTML, CSS, JS, fonts, wasm, icons: ~1.2 MB).

**Search** (`db-worker.js`) — tokenize the query (shared tokenizer), expand abbreviations (gv, pb, oz, pk…),
plural stems and synonyms, prefix-match every word against the dictionary, OR the postings of each word's
expansions, AND the words in every shard, then collect about 400 candidates in all, shared between the shards in
proportion to their matches (at least 40 each), head-noun matches first for up to half of each shard's share. Score
them (exact word > prefix, the whole brand named, size/pack number match, words adjacent in the name, the word's
home department, the item's head noun named, the plain item, coverage of the item's content words, store brand;
retired, out-of-stock and multipacks pushed down) and return 40. A run of query words that is another chain's store
brand (the manifest's `brands`, from data/brands.json) is set aside, named in the result (`otherBrand`), and Walmart's
own-brand items rank first among the matches for the rest. A word that matches nothing gets one-edit
alternatives; if the AND is empty a word is dropped and the result is flagged: a number first ("skinny pop 28"), then a
word that is mostly a brand in the listings carrying it ("stonemill rosemary" keeps rosemary), then the most common word
whose removal leaves results. Walmart's own brand ranks first for another chain's brand only for the item the query names
in a consumable department. The main thread renders 12 rows synchronously and the rest on the next idle slice;
off-screen rows skip layout via `content-visibility`.

**Barcodes** (`barcode.js`) — GS1 check digits, UPC-E → UPC-A expansion, 11-digit typed codes completed, EAN-13
with a leading zero folded into UPC-A, GTIN-14 keys as exact doubles (≤ 2^53), GS1 US store labels
`2 IIIII V PPPP C` with the 4-digit price verifier (and the 5-digit no-verifier fallback), PLU 3000–4999 with
8/9 prefixes (8xxxx codes are their own items). The scanner accepts retail symbologies only, requires two agreeing
reads on either engine before it fires, and ignores the code it just priced for 2.5 s so an item left in frame after
"Add to tally" is not counted twice.

## Performance budget and measured numbers

Method: `tools/measure.mjs` drives the built app in Chromium (Pixel 7 viewport) with **4× CPU throttling** as a
mid-range-phone proxy, the full 760k-item pack, a local server, and Chromium's fake camera fed a real UPC-A
clip for the scan path. Every number below comes from that script (`build/measure.json`); nothing is estimated.

| requirement | budget | measured (p50 / p95) |
|---|---|---|
| cold start to interactive, DB already on the phone | < 2 s | see `docs/perf/measure.json` → `coldStart.interactive` |
| first install (download 32 MB + index) | one-time | `firstInstall` |
| search per keystroke, worker | < 16 ms | `keystroke.worker` |
| keystroke → results painted (worker round trip + DOM) | ≈ one frame | `keystroke.total` |
| typed barcode → sheet painted | < 300 ms | `lookup.toSheet` |
| scan: decoder hit → price → sheet painted | < 300 ms | `scan.decodeToPrice` |
| scan: camera ready → sheet (incl. two agreeing reads) | < 300 ms | `scan.cameraReadyToSheet` |

The latest run is summarised in `docs/perf/README.md` next to the raw JSON.

**WebKit (iPhone).** Every iPhone browser is WebKit, so the same script runs there too: `node tools/measure.mjs --browser webkit`
(iPhone 14 profile) and `node tools/shots.mjs --browser webkit` (files prefixed `webkit-`, default `build/shots-webkit`).
Two things exist only in Chromium: CPU throttling, so WebKit numbers are host speed, and the fake camera, so the camera
scan rows are recorded as "not measurable on WebKit in CI" (`notMeasurable` in the JSON). `scanTyped` (open the scanner, type
the digits, sheet painted) is measured in both browsers instead, and also records whether the camera started or was refused.
Memory (`memory`: page and search-worker JS heap, the open pack's buffers) and long tasks are Chromium-only as well.
Actions → **app-browsers** → Run workflow builds the 760k fixture, runs both browsers (Chromium unthrottled by default, so the
two are compared at the same speed) and writes a Chromium-vs-WebKit table to the run summary. The table flags any metric where
WebKit is more than 25% slower, or that failed. Screenshots and JSON are uploaded as artifacts.
"Sheet painted" is the same mark in both engines: the sheet is open and the main thread has rendered the first frame that
shows it (rAF, then a task queued from it). The sheet two frames later ("presented", the old double-rAF mark) is listed as a
diagnosis only, since WebKit's second frame waits for its compositor (software on a GPU-less runner) and Chromium's does not;
`lookup.withoutBackdropFilter` repeats it with every backdrop-filter off to show how much of that is blur. The audit counts
real page errors only (uncaught exceptions, unhandled rejections, console errors); known harmless browser messages, such as
WebKit ignoring the viewport's `interactive-widget` key (kept for Chrome on Android's keyboard), are listed as notes
(`BROWSER_NOTES` in `tools/audit-lib.mjs`).

## Offline and updates

- First open online: shell precached (~1.2 MB), the core tier downloaded (69 MB for the real list, 32 MB on the test
  fixture) with a progress bar, the rest in the background; "Add to Home Screen" keeps iOS from evicting storage.
- Every later open: shell from the service worker, pack from Cache Storage, no network needed. The core departments
  (consumables, 45% of the real list) open first and the app is ready on them; the other departments on the phone open
  right behind, three shards at a time, and join the search ("Adding more departments" meanwhile; a barcode they hold
  waits for them once instead of reading as unknown). Measured in throttled Chromium on the real list: ready in about
  2 s instead of 3.2-6.2 s for everything (`docs/DECISIONS.md` 2026-10-21). `navigator.storage.persist()` is requested after every successful load (and again when the
  app is installed to the Home Screen, which is what makes Chrome on Android grant it); when `navigator.storage.persisted()`
  says best-effort, Settings says the phone may clear the prices and how to keep them.
- Memory budget: the search worker keeps every open shard in memory (about 131 bytes per item measured on the 760k
  fixture), so `db-client.js` opens every core shard and then the durable ("more") shards in manifest order only while
  the estimate stays under a budget for the phone (`memoryBudget()`: ~100 MB per GB of `navigator.deviceMemory`,
  clamped to 250–640 MB; 400 MB when the browser does not say, as Safari does not). Shards past the budget are not
  downloaded; Settings names those departments and their barcodes still get a live Walmart price when online.
- Sample → real: tally lines and recents made on the synthetic fixture carry `sample: true`; the first load of a real
  snapshot drops them and says so once, so sample prices never mix into a real tally.
- Online: `current.json` is checked; a new snapshot is fetched in the background and applied when idle.
- A first open that stalls (a download that stops, a pack that will not open) is never an endless spinner: after 30 s
  without progress the status card says "Taking longer than expected · tap to retry", after 120 s the page reloads
  itself once, and a pack open past 90 s is an error with a message. Settings › About › Diagnostics lists the boot steps
  of this launch and the previous one (Copy to send them). On iOS a Home Screen app has its own storage, so its first
  launch downloads the core once more; the hint says so.
- Price list date: the header pill ("Prices Oct 13") and every sheet carry the snapshot's date. From 40 days a banner
  under the header says "Price list is N days old" (amber), from 60 days "Price list may be out of date" (red; the list is rebuilt monthly), with an **Update now**
  button that checks, downloads and applies the newest snapshot (`js/staleness.js`; thresholds pinned by
  `tests/staleness.test.mjs`). It is re-evaluated on every database state change, when the app returns to the
  foreground, when the network comes back and hourly; the dock never moves. No Web Push.
- Deploy hygiene (`deploy-app.yml`): every build writes `build.json` with a build key (app code, repo build inputs,
  published snapshot, equivalents). A pipeline run only redeploys when that key differs from the live
  `APP_URL/build.json` (checked before any setup, so a no-op run costs seconds); after a deploy `build.json` and
  `db/current.json` are polled until they serve the new build, and a `pipeline-alert` issue
  (`[deploy-failed]` / `[deploy-mismatch]`) is opened or resolved accordingly. Deploys queue, never cancel each other.
- Pack versions are `<snapshot>-<hash of equivalents + builder + tokenizer + format>`, so new pack bytes always
  arrive under a new version (pack URLs are cached as immutable).
- Live check: when online, a scanned/typed barcode is also sent to the pipeline Worker's public
  `/v1/price/<gtin>` route (rate limited, cached, no token); a differing live price is shown with the delta and
  can be used for the tally with one tap. Unknown barcodes that Walmart does sell become a "Live Walmart price".

## Phones and browsers

The app is one code path on both platforms; what differs is named in one place (`isIOS`, `isAndroid`, `UPDATE_WHAT` in
app.js) and checked by `tools/ui-check.mjs` F55/F56 with an Android user agent.

| | iPhone | Android |
|---|---|---|
| Browser floor | iOS 16.4 (March 2023; iPhone 8, X and newer). Every iPhone browser is the system's WebKit, so the floor is iOS itself | Chrome 111 (March 2023; updates from the Play Store on Android 8 and newer), Samsung Internet 23, Firefox 121. The floor is the browser app, not Android |
| Below the floor | "Software update required: update to iOS 16.4 or later"; nothing is downloaded | "Update Chrome (or the phone's browser) from the Play Store"; nothing is downloaded. The gate tests `DecompressionStream`, `OffscreenCanvas`, `oklch`, `dvh` and `:has()` |
| Install | Share › Add to Home Screen (the hint on the home screen says so); keeps storage from the 7-day eviction | Chrome and Samsung Internet raise their install prompt (the hint shows an **Install** button); a browser without one (Firefox) is told the menu steps. Installed, Chrome grants persistent storage |
| Barcode engine | iOS 17+ `BarcodeDetector` when its self-test passes (iOS 18 shipped one that detects nothing), else zxing-cpp wasm | `BarcodeDetector` (ML Kit, through Google Play services) when present and self-tested, else zxing-cpp wasm (phones without Play services, Firefox) |
| Camera extras | Torch and zoom where iOS exposes them (iOS 17+) | Torch and zoom from the track's capabilities, which Chrome fills in a moment after the camera starts (read twice) |
| Camera refused | In a Safari tab, the per-site setting behind the aA button (Website Settings › Camera › Allow) lasts; a Home Screen web app has no Settings entry and keeps no camera decision (WebKit bug 327237), so it simply asks again on the next launch | The site's permissions in the browser, or Settings › Apps › SFB Value › Permissions when installed |
| Camera between scans | iOS asks again about a minute after capture stops, so the camera track is parked for four hours after the last scan when the scanner closes or the app leaves the foreground (`scanner.js parkCamera`: still running, so WebKit's own rule that an ongoing capture is never re-prompted applies by construction; 320×240 at 2 fps, read by nothing, light off, zoom reset; the phone's indicator stays on) and the next scan takes it back without a prompt; automatic, no setting (owner, 2026-10-23) | The grant persists for an installed app ("While using the app"), so the camera ends when the scanner closes |
| Vibration on scan | Not available (Safari has no `vibrate`), so the setting is not shown | `navigator.vibrate`, with the setting |
| Keyboard | iOS never resizes the layout viewport for the keyboard: the visual viewport shrinks and is panned to reveal the field. The keyboard is read from that geometry every frame while it moves (`keyboardInset`, `pollKeyboard`), the header, dock and both panels (home and results, each a fixed scroller) are positioned against the visible area, the pan is undone once the keyboard settles, and a drag cannot pan the page while it is up (`html[data-kb]`); a caret drag in the search box pans nothing because the root carries no scroll-padding for WebKit's selection autoscroll to grow its reveal by, and the undo never fights a pan iOS keeps re-applying (none while a finger is down, none repeated once iOS has put one back); `tools/keyboard-check.mjs` models all of it (fourteen scenarios, Chromium and WebKit in CI) | Chrome resizes the layout viewport (`interactive-widget=resizes-content`), so nothing moves |
| Back | The sheet's own close and swipe | The system Back closes the top layer (every sheet and the scanner push a history entry) |
| Orientation | Rotates with the phone | Rotates with the phone (manifest `orientation: any`, like iOS) |
| Status bar | `black-translucent`, content under it with safe-area insets | Coloured by `theme-color` per colour scheme |
| Launch screen | The page's boot screen (`#boot`: the app icon over its glow on a deep-green field, a progress bar and the wordmark in Manrope), light or dark, as an `apple-touch-startup-image` per screen size: `tools/icon/make_splash.py` renders the layer in Chromium (`render-splash.mjs`, `?splash=1` holds it still), writes `public/splash/` and the links in index.html; not precached. The page paints the same layer first and fades it when the prices open, so the launch is one picture. iOS ignores the manifest for this and appears to read the images when the app is added to the Home Screen, so an app added before 2026-10-22 may show them only after it is removed and added again — iOS copies the launch image (and the icon) once, when the app is added to the Home Screen, and never refreshes it: an app added before the images shipped (2026-10-22) shows white until the page paints, and is fixed by removing it and adding it again | Chrome draws its splash from the manifest (`background_color` and the 512 px icon), then the page's boot screen takes over the same way |

**Google Play.** The same PWA can be listed on Google Play as a Trusted Web Activity (an Android app that opens the site
full screen): docs/RUNBOOK.md "Google Play" has the steps. The site's half is in place: the manifest, the privacy page
(`privacy.html`), and `build-site.mjs` writes `/.well-known/assetlinks.json` from the repository variable
`ANDROID_ASSET_LINKS` once the Play signing key exists.

## Accessibility

Every control has a name; targets are ≥ 44 px; text ≥ 13 px with ≥ 4.5:1 contrast (audited by `tools/shots.mjs`);
dialogs are real `<dialog>` elements with focus trapping and Escape/back-button close; results and status use
`aria-live`; the scanner makes the page behind it inert and closes on Escape; the dock precedes the list in the DOM so
Tab order follows the thumb (search → Scan → best result). The whole app works one-handed from the bottom of the
screen and with an external keyboard (`/` focuses search, Enter opens the best result, digits + Enter from a
keyboard-wedge scanner resolve the code directly).
