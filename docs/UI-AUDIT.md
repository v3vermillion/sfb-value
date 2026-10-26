# UI audit and fixes, 2026-10-17

The volunteer app (app/public), audited from the owner's iPhone screenshots of 2026-10-16. The findings were fixed by root
cause and checked in a real browser. Every finding has an id, and `app/tools/ui-check.mjs` names each check after the
id it guards. tests.yml runs it on every pull request on a 3,000-item fixture.

## How it was audited

- **Code reading.** Four independent first-pass reviews covered the walkthrough, the home screen, the dock and viewport
  handling, and a live run of the app. They produced F1–F48.
- **Failing checks first.** Each finding got a Playwright check before any fix; 46 ids failed at the start.
- **Screenshots.** Every screen and state was captured at 320×568, 360×780, 375×667, 390×844, 430×932, 768×1024 and
  844×390, in light and dark. iPhone safe areas were emulated (`Emulation.setSafeAreaInsetsOverride`; 47/34 portrait,
  47/47/21 landscape) at 2–3× density. The screenshots were then cropped and measured.
- **Price states.** Downloading, more departments, offline, server 5xx, an unsupported browser and stale prices were
  driven by routing, the page clock and synthetic events.
- **Independent reviews of the fixes.** Three fresh reviewers looked at the fixes: an adversarial code review, a design
  review against shipped scanning and POS apps, and an accessibility (WCAG 2.2 AA, VoiceOver) and wording review. A
  fourth verified the fixes from those reviews. Their findings are the R, A, D and P ids below.
- **Stylesheet refactor.** The stylesheet was consolidated first with zero computed-style change. Every element's
  computed style was compared across 72 app states.

## Owner decisions applied

| Decision | What a leading app does | What the app does now |
|---|---|---|
| Label for the price date | Scan and price apps label a catalogue date as an update date. They never present it as the moment an item was checked. | "Updated Oct 13" in the pill; "Walmart.com price · Updated Oct 13, 2026" under a price; "Price list is N days old" / "Price list may be out of date" on the banner |
| Narrow screens | The header never truncates. Secondary chrome gives way first. | On home the tally is a card, so there is no header pill. On results the wordmark gives way to the tally total. Under 380px the pill keeps the date alone. |
| Samples and casual wording | The empty state is a single clear prompt, with no canned shortcuts. | The "Common items" chips and the casual headline are removed. A "Scan a barcode to begin" prompt sits under the tally card. "Price list" is the one term for the data throughout. |
| Dynamic Type (F40) | — | Deferred to its own pull request (owner) |

## Findings and status

The status is **Fixed** (the check passes in Chromium) or **Fixed; confirm on iPhone** (the logic passes in emulation,
but the iOS behaviour itself can only be seen on a device). The check column gives the ui-check id; "unit" means
`app/tests`.

| Id | Finding | Fix | Check | Status |
|---|---|---|---|---|
| F1 | iPhone launch: layout viewport 47px short; dock floats | iOS 26 bug (WebKit 301108): the viewport is short only while the page is shorter than the screen, and nothing is drawn below its edge. In the Home Screen app the page is made as tall as the screen, `min(100lvh, 100% + top inset)`, so iOS gives it the full viewport. (The first fix, which extended the bottom bars by the gap, was cut off on the device: 2026-10-19.) | F1, R8 | Fixed; confirm on iPhone |
| F2 | Walkthrough dim and centred card short by 47px | Follows from F1: the dim fills the viewport, which is now the whole screen | F2 | Fixed; confirm on iPhone |
| F3 | Spotlight past the screen edges | Clamped inside the screen; step 1 spotlights the controls, not the bar | F3 | Fixed |
| F4 | Focus ring on Next after an automatic open | The step takes the focus; rings only for keyboard use | F4 | Fixed |
| F5 | Dots and Next shift; Skip misaligned | Dots in the step line; Skip on the text edge | F5 | Fixed |
| F6 | Demo button unlike the real one | The real receipt "Add to tally" button and sheet parts | F6 | Fixed |
| F7 | "there when there" | Rewritten | F7 | Fixed |
| F8 | Tapping the spotlit Scan just advanced | Spotlit Scan and search box are live | F8, R4 | Fixed |
| F9 | aria-labels hid card text; dock height 1px short | Visible words are the names; dock measured | F9, F9b | Fixed |
| F10 | Spotlight did not follow its subject | Follows frame by frame while open | F10 | Fixed |
| F11 | Toasts above layers but inert | Toasts stay usable; inside an open sheet they show in the sheet | F11, A1 | Fixed |
| F12 | Scan shortcut opened the scanner over the walkthrough | The shortcut skips the walkthrough for that launch; one layer function | F12 | Fixed |
| F13 | Page scrolled by the gap | Body is a column; main fills exactly the layout viewport | F13 | Fixed |
| F14 | Date shown twice; awkward break; Close = Start | Card only when needed; date kept whole; last step has Back and Done | F14 | Fixed |
| F15 | Walkthrough card off-screen in landscape | Flip or centre; wide landscape card | F15 (11 sizes) | Fixed |
| F16 | Replay over results pointed at hidden things | Returns home first | F16 | Fixed |
| F17 | Step 4 contradicted the card | Points at the pill; wording fits every state | F17 | Fixed |
| F18 | Escape lost after tapping the card | Handled on the document while open | F18 | Fixed |
| F19 | Skip link and banner reachable during the walkthrough | Everything but the layer, toasts and announcements is inert | F19 | Fixed |
| F20 | VoiceOver heard only "Next" | Card focused, labelled by title, described by step and text | F20 | Fixed |
| F21 | Focus on body after first launch | Page heading | F21 | Fixed |
| F22 | Pinch zoom misplaced the card | Layout-viewport coordinates throughout | traced | Fixed |
| F23 | Dead history entry after Back then Forward | Closed-layer entries are stepped back over | F23 | Fixed |
| F24 | Header 61px, everything assumed 56 | `--top-h` measured | F24 | Fixed |
| F25 | Stale dot cancelled by a later rule | Rule order fixed in the consolidated stylesheet | F25 | Fixed |
| F26 | "Prices ready" under the red banner | Card hidden when ready; old prices are the banner's job | F26 | Fixed |
| F27 | Pill truncated or leaked percentages | Date or one word, never a percentage, never cut | F27, R1 | Fixed |
| F28 | "More departments loading" when nothing loads | Offline and stopped states, retried after a minute | F28 | Fixed |
| F29 | Progress bar stuck after a background update | Background updates are silent | F29 | Fixed |
| F30 | 5xx shown as a lost connection | Server flag from db-client; "Price server unavailable" | F30 | Fixed |
| F31 | Pill and card disagreed | One `priceStatus()` for every surface | F31, R5 | Fixed |
| F32 | "Update required" undone by reconnecting | Unsupported is sticky; nothing downloads | F32, R6 | Fixed |
| F33 | Recent upside down | Newest first | F33 | Fixed |
| F34 | Recent prices stale after an update | Re-priced by barcode when a list opens or departments join | F34, R2 | Fixed |
| F49 | No way to take a row off Recent | Swipe left uncovers Remove (keyboard: the button precedes the row and reveals it on focus) | F49 | Done |
| F50 | Removing a Recent row is irreversible | Remove shows an Undo toast for five seconds | F50 | Done |
| F51 | No way to clear Recent at once | A Clear text button at the section's edge, with Undo | F51 | Done |
| F52 | Rapid taps zoomed the whole app (iOS double-tap zoom on plain text) | The viewport pins the scale; a second quick tap on non-controls and the pinch gesture are swallowed | F52 | Fixed |
| F53 | A small bottle barcode would not read | UPC-E accepted in every form the detectors report it; 1080p camera, full-resolution decode, try-harder row scanning; after 4 s without a read the camera zooms in by itself where it can, and the hint says what helps | F53 | Fixed |
| F54 | A long press on the camera view highlighted the reticle and parts of the frame | No text selection or system callout anywhere in the scanner; the typed number still selects | F54 | Fixed |
| F55 | On an Android phone the app spoke of iPhones: Safari in the camera-permission text, no install hint unless Chrome offered its prompt (Firefox never does), "iOS" in the update texts | Platform words come from one place (`isIOS`, `isAndroid`, `UPDATE_WHAT`): Android gets its own camera-permission path (installed app or browser site settings), the menu steps to install when no prompt comes, and About names both platforms | F55 | Fixed |
| F56 | The too-old-browser gate tested only `DecompressionStream`: a Chrome from 2022 would download nothing and draw the layout without its colours (oklch) or heights (dvh), with a message about "this browser" | The gate also tests `OffscreenCanvas`, `oklch`, `dvh` and `:has()`, one floor (March 2023: iOS 16.4, Chrome 111), and says what to update per platform (iOS itself; Chrome from the Play Store) | F56 | Fixed |
| F57 | The first Home Screen launch sat on "Loading" for over three minutes (owner's iPhone); a tap on Check for new prices fixed it at once. Whatever stalled, nothing on screen said so or offered a way out | A boot watchdog: 30 s without a state change or a download step turns the card into "Taking longer than expected · tap to retry" (and retries `start()` where that can help); 120 s reloads the page once. The download card shows MB done of MB total. Settings › About › Diagnostics lists every boot step of this and the previous launch, with Copy | F57 | Fixed |
| F63 | A Home Screen launch on an iPhone showed a blank white screen until the page drew (owner, 2026-10-22): iOS ignores the manifest's colours and icons for this | Launch images: the app icon on the page's own background, light and dark, for every iPhone (portrait) and iPad (both orientations) screen size (`tools/icon/make_splash.py`); not precached | F63 | Done |
| F64 | The launch was a logo on a flat colour that cut to the home screen (owner's draft, 2026-10-22: a glass icon over a green bloom and a progress bar; no ribbons; then rings, mud and too little glow against the draft) | A boot screen (index.html `#boot`): the app icon over a three-part glow on a vignetted deep-green field, tuned to the draft by sampling, with grain against 8-bit banding; a sweeping progress bar and the wordmark in Manrope; light and dark in the app's tokens; the iOS launch images are the same layer rendered at every screen size under mobile emulation (`tools/icon/render-splash.mjs`; a desktop scrollbar gutter once left a strip down the iPad images), so the launch resolves into the page without a jump; app.js fades it when the prices open, or at once for a download, offline or a problem; `?splash=1` holds it for a preview; still under reduced motion | F64 | Done |
| F65 | The privacy page opened light on a phone whose app is set to dark (it followed the system scheme only), and in a Home Screen app had no way back but the edge swipe (owner, 2026-10-22) | The page loads app.css and reads the app's Appearance setting before its first paint; a Back link at the top (the app's chevron and accent, 44 px) returns to the screen it was opened from, else to the app | F65 | Done |
| F66 | The note under a carried-over price said Walmart "did not list a price" (it misstates the cause), sat in the same grey as the size chip and the stepper, and the "Updated" date beside the price read as current (reviewer, 2026-10-22) | The note says the item's department was not part of that update, in the sheet's amber `equiv` tone with an icon and full-ink text; every toned note now leads with an icon (warn: exclamation, equiv: "i") so its tint is never the only signal; the date line keeps the price list's date, as the pill does (owner); the exact day a carried row was last priced needs a per-row stamp (docs/DECISIONS.md 2026-10-22) | F66 | Done |
| F67 | After Don't Allow, the camera message sent an iPhone to Settings › Apps › SFB Value › Camera, which does not exist for a web app; and with the barcode keyboard up the scanner's message sat under the status bar and the field under the keys (owner's screenshots, 2026-10-23) | The message names what works on each platform (Home Screen: close and reopen, then Allow; Safari tab: aA › Website Settings › Camera › Allow; Android unchanged); the scanner follows the visible area like the dock | F67 | Done |
| F68 | Every cold start of the Home Screen app asked for the camera again, and so did a scan after a minute away (owner, 2026-10-23: iOS keeps no camera decision for a web app, WebKit bugs 215884 and 327237, and asks again about a minute after capture stops) | The camera is kept ready for four hours after the last scan on iPhone, automatically (owner: the length of a shift, no setting): closing the scanner or leaving the app parks the camera track instead of ending it (still running, since WebKit never re-prompts while capture is ongoing; smallest and slowest picture, read by nothing, light off, zoom reset), and the next scan inside the window takes it back without asking; Android never holds the camera (its grant persists); Diagnostics log "camera opened" or "camera taken back"; the privacy page says so | F68 | Done |
| F69 | With Light or Dark chosen, nothing in Settings answered: the live-check switch would not move, Check for new prices did nothing, until System was chosen again (owner's iPhone, 2026-10-23) | `<html data-theme>` carries the chosen theme, and the tap handler looked for the nearest `[data-theme]` from the tap, which with Light or Dark chosen was the page itself, so every tap re-applied the theme and returned; it now looks for the theme button only | F69 | Fixed |
| F70 | The toast after Check for new prices blinked: appeared, vanished, appeared again (owner's iPhone, 2026-10-23) | The re-render that follows the check took the sheet's toast region out of the sheet and put it back, which restarts the entry animation of every toast in it; the region now stays where it is while the content around it is replaced | F70 | Fixed |
| F71 | The boot screen stayed up for minutes, in the Home Screen app and in Safari, right after a deploy; closing and reopening the app started it at once (owner, 2026-10-23) | The page was the new build's and the script the previous build's: the old service worker answered from every cache it could see, the next build's precache included, so the new index.html (with the boot layer) ran with the old app.js (which knew no boot layer and never took it down). The worker now reads only its own build's cache (sw.test), so a build is served whole or not at all; and the layer leaves on its own after 12 s whatever happens to the script (a CSS animation, no script needed), so the home screen's own card can say what is going on | F71, unit | Fixed |
| F72 | The boot bar filled to 40% and swept, which said nothing about the start (owner, 2026-10-23: a bar that fills with the real progress, so a stalled start can be seen) | The bar is the real progress: 40% is the launch image (the shell is up), 48% the script running, the rest the price list's shards opening in the worker, full before the fade; only forwards | F72 | Fixed |
| F73 | With the keyboard up (iPhone 16, 2026-10-23): the search bar floated above the keyboard with a blank band under it; at other times it was lost under the keyboard; the home content panned up under the header and the empty-state title was cut by the dock; results rows sat above the visible screen; rapid typing, backspacing and dragging moved the whole screen | Six causes, each fixed and modelled in `tools/keyboard-check.mjs` (a scripted iOS visual viewport: keyboard animation, reveal pan, user pan, a missed final event, a residual pan): (1) the dock's home-indicator padding was keyed on the inset being non-zero, which it is not when iOS reveals the field by panning the whole keyboard height, so the padding came back as the band; now keyed on the keyboard being there, bar heights re-measured in the same frame; (2) the inset came from events alone and was zeroed on blur while the keyboard was still leaving; now read from the viewport's geometry, polled every frame for 800 ms after any event and every 500 ms while typing; (3) the home was laid out in the document with the keyboard inset as padding, so iOS scrolled it under the header; now a fixed panel between header and dock, like the results, which also left the home panel; (4) every fixed element chased the pan one event late and the dock eased its position over 120 ms; now the pan is followed only while the keyboard animates and undone once it settles (window.scrollTo moves the visual viewport in WebKit), with the layout written for pan 0 in the same frame, the browser's pan gesture is off on everything that does not scroll while the keyboard is up (`html[data-kb]`), and the dock has no transition; (5) `showHome()` scrolled the window on every backspace to nothing, which made iOS re-pan; now it scrolls its own panel only, and the pending price list waits for the keyboard to go; (6) the bottom-anchored results list moved every row by the keyboard's height whenever its box changed height while scrolled; now the top-most visible row is held in place (at the best match nothing is held), one search runs per frame instead of one per key, and a render never moves a list under a finger or one still coasting; (7) found by the new WebKit assertion on the first CI run: the "N matches" line was a sticky element at the bottom of the reversed scroller, which WebKit does not keep in place, so it floated away when the list was scrolled up; now a fixed strip of its own above the dock | S1 to S10 (keyboard-check), F45, R8, scroll-check | Fixed; confirm on iPhone |
| F74 | A tap on the search box slid the whole page up (header off the top, the keyboard over the search box for two frames), then snapped it back down, in half a second (owner's screen recording, 2026-10-23, read frame by frame: slide 0.19-0.47 s, snap 0.50 s) | iOS reveals a field it thinks the keyboard will cover, judged from where the field is at the moment of focus, and a field in a bottom bar always qualifies; the app's pan undo then fired as soon as the height stopped changing, mid-slide. A tap on a text field that is not yet focused now takes the focus itself: the tap's default is cancelled and the field is moved far above the screen for that instant, focused without scrolling and put back on the next frame (React Aria's usePreventScroll pattern), so iOS has nothing to reveal and only the keyboard and the dock move; the undo stays as a fallback and waits until both the height and the pan have stopped | S11 (keyboard-check models the reveal and fails on the recorded build: a 336 px slide) | Fixed; confirm on iPhone |
| F75 | With the keyboard up and a query longer than the box, holding the cursor in the search box and dragging it made the screen flicker every quarter second: the search box flew to the top with blank space under it, then the list slid down under the keyboard with the search bar lost, then everything snapped back (owner's screen recording, 2026-10-23, 86 frames at 60 per second) | A held cursor in overflowing text runs WebKit's selection autoscroll: every 50 ms it reveals the finger's point through the document, grown by the root's `scroll-padding`, which carried the keyboard's height; the reveal jumped the page about 280 px in one tick, WebKit's edge autoscroll then took it to the whole keyboard height (the page's own scroll indicator in the frames gives the pan), at the full pan iOS reports `innerHeight` clipped to the document so the app took the keyboard for gone, the pan went back to 0, and the next tick jumped again. Now: no scroll-padding on the root (the page never scrolls; both panels are fixed scrollers that end at the dock); the keyboard is measured against the layout viewport's height (innerHeight, or innerHeight plus the pan when clipped, capped by the root's clientHeight); and the pan undo never fights iOS: no undo while a finger is down, an undo iOS puts back is not repeated (the pan is followed until a finger lifts, the pan returns to 0 or the keyboard goes), a pan left after the keyboard has gone is always undone. The thumb sliding onto the keyboard still makes WebKit pan the page; it is followed | S12 (the reveal computed from the root's computed style: a 336 px pan on the first tick on the recorded build), S13, S14 (the finger on the keyboard for 4 s, touches delivered or cancelled: at most one undo, header and dock in place in every frame); the model clips innerHeight in every scenario | Fixed; confirm on iPhone |
| F35 | Logo reloaded the app | Returns home | F35 | Fixed |
| F36 | Announcement repeated, stuck, missed offline | One sentence per change of meaning | F36 | Fixed |
| F37 | Headline grew with Recent | Headline removed | — | Fixed |
| F38 | Verse reference wrapped by accident | Deliberate second line; name on one line at 320 | F38 | Fixed |
| F39 | Label on a generic div | Removed with the chips | F39 | Fixed |
| F40 | iOS Larger Text not followed | — | — | Deferred (owner) |
| F41 | Date labelled "checked" | "Updated", everywhere including sheet notes | F41 | Fixed |
| F42 | Toasts off-centre at ≥720px | Centring fixed | F42 | Fixed |
| F43 | Scanner overflowed landscape | Reticle sized to the room between the controls | F43 | Fixed |
| F44 | Scanner controls under the notch | Side safe areas | F44 | Fixed |
| F45 | Home-indicator padding over the keyboard | `--dock-safe-b` 0 while the keyboard is up | F45 | Fixed; confirm on iPhone |
| F46 | Landscape plus keyboard left room for no result | Follows from F24 and F45 | F45 | Fixed |
| F47 | Scanner let focus reach the page | Same layer function | F47 | Fixed |
| F48 | Dock announced as the page footer | Plain container; the form keeps role=search | F48 | Fixed |

### Findings from the reviews of the fixes

| Id | Finding | Status |
|---|---|---|
| R1 | Wordmark under the pill at 441–520px | Fixed (R1) |
| R2 | Duplicate Recent row after a refresh changed the kind | Fixed (R2) |
| R3 | A scan could stack a result on the tally | Fixed: the camera rests under other sheets (traced) |
| R4 | Spotlit search box did not raise the iOS keyboard | Fixed: focus inside the tap (R4); confirm on iPhone |
| R5 | Worker failure before opening went unreported | Fixed (R5) |
| R6, R7 | Unsupported browser downloaded from Settings; doubled wording | Fixed (R6, R7) |
| R8 | Launch gap dropped while a hardware keyboard typed | Fixed: no gap is compensated any more; the dock stays on the edge (R8) |
| R9, A5 | No focus ring in Enter-only keyboard flows | Fixed (R9) |
| A1 | Toasts hidden while a sheet is open | Fixed (A1) |
| A2 | Confirm button named "Add" | Fixed (A2) |
| A3 | Update now lost focus | Fixed (A3) |
| A4 | Focused rows hidden under the dock | Fixed: the results are a fixed scroller that ends at the dock (the root's scroll-padding that first did this is gone, F75) |
| A6–A8 | No-results, scanner hints not announced; hint unreadable on bright frames | Fixed (A6) |
| A9, A10 | Warnings not read from the Add button; price read in pieces | Fixed: describedby; one phrase per price |
| A11, A12 | Pressed segment under 3:1; Settings overflow at 320 | Fixed (D1) |
| A13–A18 | Tally pill name, nested live regions, banner noise, per-keystroke count, landmarks, focus return | Fixed |
| D1–D4 | Settings overflow, sheet header scrolling away, landscape actions, clipped meta line | Fixed (D1–D4) |
| D6, D7 | Remove without undo, native confirm(), lines vs items | Fixed (D6, D7) |
| D8–D16 | Pill words on results, search glow after a sheet, field sizes, wraps, legend, gutters, store-label repetition, second button, cents under $1 | Fixed (D16 and screenshots) |
| P2, P4, P6–P14 | Sheet titles, toasts, highlights, repeated facts, tally pill, stepper corners, walkthrough on black, no-results action, camera copy, Prices card, iPad sheet width | Fixed |
| P3 | Row prices not on the title's baseline | Fixed: the price shares the title's first line |
| P1 | 21 text sizes | Partly: one label style; the full type scale moves into the Dynamic Type change (F40), which rewrites every size |
| V1, V2 | The Added and Tally cleared toasts closed with their sheet | Fixed (V1, V2) |
| V3 | The Settings check result toast was wiped by the card refresh; focus lost | Fixed (V3) |
| V4 | In-sheet toasts covered the close button and the first row; a second removal lost the first Undo | Fixed: toasts at the sheet's foot, one region per sheet kept across re-renders (V4) |
| V5 | In-sheet live region recreated with every re-render (not announced) | Fixed: created when the sheet opens and kept |
| V6 | Landscape sticky actions covered the item's title and warnings | Fixed: two-column landscape sheet (V6) |
| V7 | The phone keyboard's Go key turned focus rings on | Fixed: only navigation keys outside fields, Tab and Escape anywhere (R9) |
| V8 | "No results" twice on screen | Fixed (V8) |
| V9, V10 | Banner text rewritten on every re-render; focus return after Recent and typed codes | Fixed |
| P5 | Badge colours close (produce/exact, equivalent/closest) | Kept: every badge carries its words, so colour is never the only cue; glyphs considered for the Dynamic Type pass |

### Found on the owner's iPhone after release (2026-10-19)

| Id | Finding | Fix | Check |
|---|---|---|---|
| F1 (again) | The dock was cut off at the short edge and a light band showed under it. A double tap fixed the layout until the next one | See F1. The double tap re-laid the page out: the zoom change forced iOS to recompute the viewport | F1 |
| U1 | The first launch after the update showed the previous page styled by the new stylesheet (run-together text, the old chips unstyled) | The page, stylesheet and script carry their build. When they disagree, the page reloads once, which brings one version, and never loops. This first takes effect from the build after this one | U1 |
| T1 | The walkthrough text was balanced into short lines, which left a quarter of the card empty | Body text fills its measure; it only keeps a last word from standing alone | screenshots |
| T2 | The empty-state icon peeked half-covered past the walkthrough card | Hidden while the walkthrough runs | screenshots |
| S2 | Scrolling moved the search bar: a bounce of the page dragged the fixed header and bar with it | `overscroll-behavior: none` on `html` (it was on `body`, which does not reach the page itself) | scroll-check (Chromium and WebKit) |
| S3 | Settings › Replay the walkthrough did nothing on the iPhone (it worked in desktop Chromium and WebKit) | The Settings layer is swapped for the walkthrough in one step, reusing its history entry. Nothing waits on a Back navigation | scroll-check (Chromium and WebKit) |
| S4 | Swiping Settings down was hard to start and glitched on the way. The swipe only worked from a 21px handle strip; a swipe from the title scrolled the sheet's content instead. On release the sheet jumped back up before its closing animation, and a Settings re-render mid-swipe dropped the gesture. A short swipe also reset the scroll position | The whole header (handle, title and close-button row) drags the sheet. A quarter of its height (at most 120px) or a flick closes it, sliding on from where the finger let go. A shorter swipe springs back. The gesture lives on the dialog, so a re-render cannot break it, and taps and the close button behave as before | S4, scroll-check (Chromium and WebKit) |
| S5 | Settings stuttered while it was swiped down. Measured in Chromium (390×844 at 3×, CPU 4× slower), every finger movement repainted the whole screen (390×844): about 80 full-screen paints and about 100ms of painting per swipe. Once its opening animation ends, the sheet has no compositing layer of its own, so moving it redraws everything under it, the blurred page included. Style work was not a cause (2 elements, about 1ms per move) | From the touch on the header until the sheet comes to rest, it is lifted onto its own layer (`will-change: transform`). Measured the same way: 8–12 small paints, 12–20ms. The layer is given back at rest, so no full-screen bitmap is held while the sheet sits open | S4 |
| S1 | The flashlight button stayed on screen with no camera behind it, so tapping it did nothing. Leaving the app releases the camera; on return iOS can refuse the restart, and the button kept showing | The button shows only while a camera with a light is running. It hides when the camera stops, restarts or is refused | S1 |

## Check on a real iPhone before merging

These behaviours depend on iOS itself and cannot be produced in Chromium:

1. Open the app from the Home Screen. The search bar sits on the bottom edge with no band below it, including in the
   first seconds after launch, and nothing changes on a double tap (F1).
2. Run the walkthrough. Every step is fully visible, the whole screen dims, and on step 1 tapping the search box opens
   the keyboard (F2, R4).
3. Tap the search box. The bar sits directly on the keyboard with no empty band (F45).
4. Add an item, open the tally and remove a line. The "Removed … Undo" toast shows inside the tally (A1).
5. Type a query longer than the search box and, with the keyboard up, hold the cursor (long press the text) and drag
   it left and right for a few seconds, then let the thumb slide down onto the keyboard. Only the cursor moves: the
   header, the list and the search bar stay where they are (F75, S12 to S14).

## Screens

`docs/screens/` holds the README's four screens, dark, taken from the live site with the real price list (`node tools/readme-shots.mjs`, run in `app/`). The full set at every size, light and dark, with the accessibility audit, comes from `node tools/shots.mjs` into `app/build/shots`.
