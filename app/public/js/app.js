// app.js — UI controller. One screen, two ways in (type / scan), one result sheet.
// Everything heavy (index, search, lookups) lives in db-worker.js; this file only renders.

import { DbClient } from "./db-client.js";
import { classifyCode, formatGtin } from "./barcode.js";
import { resolveCode, fromItem, kindLabel, titleOf, splitTitle, sizeText, piecesOf, countText, fmtNum, notesFor, livePlausible, packListingOf, liveUnitCents, whoseBrand, mergeLearned, pruneOwnMatches, liveCheckable } from "./resolve.js";
import { tokenize } from "./tokenize.js";
import { stalenessLevel, stalenessText, ageText, daysSince } from "./staleness.js";

// ------------------------------------------------------------------ setup
const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(["top", "main", "dock", "status", "statusText", "tallyBtn", "tallyCount", "tallyTotal", "settingsBtn", "progress", "progressBar", "stale", "home", "results", "list", "resultsMeta", "recent", "recentList", "q", "clearBtn", "scanBtn", "searchForm", "sheet", "tallySheet", "settings", "scanner", "video", "overlay", "scanClose", "torchBtn", "reticle", "scanHint", "scanTypeForm", "scanTypeInput", "scanTypeBtn", "toasts", "heroEyebrow", "readyCard", "statusLive", "tallyCard", "tallyCardTotal", "tallyCardSub", "homeEmpty", "pageTitle", "installHint", "tour", "tourSpot", "tourCard"].map((k) => [k, $(k)]));

const scanShortcut = new URLSearchParams(location.search).get("scan") === "1";   // launched from the Home Screen "Scan" shortcut
const LIVE_URL = (document.querySelector('meta[name="sfb-live-check"]')?.content || "").trim().replace(/\/$/, "");
const BUILD = document.querySelector('meta[name="sfb-build"]')?.content || "dev";

// One build per page. A Home Screen app reopened just as a new version takes over can get the previous version's page
// with this version's stylesheet or script: it then renders unstyled, half-old parts. build-site.mjs stamps the build
// into the page, the stylesheet and this script; when they disagree the page reloads once, which brings one version.
const SHELL_BUILD = "__SHELL_BUILD__";
{
  const cssBuild = getComputedStyle(document.documentElement).getPropertyValue("--shell-build").trim().replace(/["']/g, "");
  const seen = [BUILD, SHELL_BUILD, cssBuild].join(" ");
  if (!SHELL_BUILD.startsWith("__") && (BUILD !== SHELL_BUILD || cssBuild !== SHELL_BUILD)) {
    let reload = false;
    try { if (sessionStorage.getItem("sfb.buildReload") !== seen) { sessionStorage.setItem("sfb.buildReload", seen); reload = true; } } catch { /* no storage: never loop */ }
    if (reload) { location.reload(); await new Promise(() => {}); }   // stop here; the reload replaces the page
  }
}
const PREFS_KEY = "sfb.prefs", TALLY_KEY = "sfb.tally", RECENT_KEY = "sfb.recent";

const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const prefs = Object.assign({ theme: "auto", haptics: true, live: true }, readJson(PREFS_KEY, {}));
let tally = readJson(TALLY_KEY, []);
let recent = readJson(RECENT_KEY, []);
// barcodes nothing knew, matched on this phone by a search by name and added to the tally: gtin14 -> {key, title, at}
const LEARNED_KEY = "sfb.learned.v1", LEARNED_MAX = 500, LEARN_WINDOW_MS = 10 * 60 * 1000;
let learned = readJson(LEARNED_KEY, {});
if (!learned || typeof learned !== "object" || Array.isArray(learned)) learned = {};
const learnedFor = (gtin) => learned[gtin] || null;
const resolveOpts = (o = {}) => ({ ...o, prefixes: db.manifest?.prefixes || null, learned: learnedFor });
function rememberMatch(gtin, item) {
  if (!gtin || !item?.upc) return;
  learned[gtin] = { key: Number(item.upc), title: titleOf(item), at: Date.now() };
  learned = pruneOwnMatches(learned, LEARNED_MAX);
  writeJson(LEARNED_KEY, learned);
  shareMatch(gtin, item);
}
// Shared between phones through the pipeline Worker (/v1/learned, pipeline/src/index.js): a match one volunteer makes is
// posted, and every phone fetches the list when it starts, comes online or returns to the foreground (at most every
// LEARNED_SYNC_MS). Offline, or without a live-check URL, this phone's own matches work as before.
const LEARNED_SYNC_MS = 15 * 60 * 1000;
let learnedSyncedAt = 0;
function shareMatch(gtin, item, forget = false) {
  if (!LIVE_URL || !navigator.onLine || !gtin || !item?.upc) return;
  fetch(`${LIVE_URL}/v1/learned`, { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
    body: JSON.stringify({ gtin, upc: String(item.upc), title: titleOf(item), ...(forget ? { forget: true } : {}) }) }).catch(() => {});
}
async function syncLearned(force = false) {
  if (!LIVE_URL || !navigator.onLine || (!force && Date.now() - learnedSyncedAt < LEARNED_SYNC_MS)) return;
  learnedSyncedAt = Date.now();
  try {
    const r = await fetch(`${LIVE_URL}/v1/learned`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (!Array.isArray(d?.learned)) return;
    learned = mergeLearned(learned, d.learned);
    writeJson(LEARNED_KEY, learned);
  } catch { /* the Worker is unreachable: this phone's own matches still work */ }
}

const perf = { boot: { start: performance.now() }, keystrokes: [], scans: [], opens: [] };
const state = {
  query: "", seq: 0, last: null, codeHit: null, pending: null, sheetRes: null, qty: 1,
  learnFor: null,       // the barcode an unknown-item sheet sent to the name search: the item added next is remembered for it
  scan: null, scanOpen: false, scanGen: 0, scanPausedByVisibility: false, engine: "", source: null, pendingReload: false,
  openScannerAfterSheet: false, closeScannerAfterSheet: false, focusSearchAfterSheet: false,
  stale: "fresh", staleBusy: false, persisted: undefined, tourOpen: false,
  // price status inputs (renderStatus): the first download's progress, the other departments' progress, why the
  // database is not open, and whether the background download of the other departments has stopped
  dlPct: null, morePct: null, dbErr: null, workerError: false, morePaused: false, unsupported: false, lastLive: "",
};

const db = new DbClient();
window.__sfb = { db, perf, state, prefs, resolveCode: (c, f) => resolveCode(db, c, f, resolveOpts()), openCode, openRank, openScanner, closeScanner, runSearch, cameraReady: () => !!scannerMod?.cameraReady(), version: BUILD };

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents) => (cents == null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));
/** The sheet's big price (hidden from screen readers, which read the sheet's #sheetPrice phrase). Under a dollar the
 * cents are the value, so they keep the full size. */
const bigMoney = (cents) => {
  if (cents == null) return `<span class="price-big is-none" aria-hidden="true">No price available</span>`;
  const d = Math.floor(cents / 100), c = String(cents % 100).padStart(2, "0");
  if (d === 0) return `<span class="price-big" aria-hidden="true">$0.${c}</span>`;
  return `<span class="price-big" aria-hidden="true">$${d.toLocaleString("en-US")}<span class="cents">.${c}</span></span>`;
};
const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
/** "Oct 13" (short), "October 13, 2026" (long) or "Oct 13, 2026" (mid) for a YYYY-MM-DD date, read at local noon. */
const fmtDate = (iso, long = false) => { if (!iso) return ""; const d = new Date(`${iso}T12:00:00`); return d.toLocaleDateString(undefined, long === "mid" ? { month: "short", day: "numeric", year: "numeric" } : long ? { month: "long", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }); };
const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
const icon = (name, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// No page zoom, ever: rapid taps on plain text (the empty state's heading) made iOS double-tap-zoom the whole app
// (2026-10-20, owner's screenshot) although the body has touch-action: manipulation. The viewport meta pins the scale
// in a home-screen app; these guards cover the browser tab, where iOS ignores the meta: a second tap within 350 ms on
// anything that is not a control is swallowed, and the pinch gesture is refused.
{
  let lastTap = 0, moved = false;
  document.addEventListener("touchstart", () => { moved = false; }, { passive: true });
  document.addEventListener("touchmove", () => { moved = true; }, { passive: true });
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (moved) { lastTap = 0; return; }   // the end of a drag or a flick is not a tap
    if (now - lastTap < 350 && !e.target.closest("button, input, select, textarea, a, [role=button], [role=switch], [contenteditable]")) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
const haptic = (ms = 12) => { if (prefs.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ignore */ } } };
const priceDate = () => db.manifest?.priceDate || db.manifest?.published?.slice(0, 10) || "";
const storeLabel = () => db.manifest?.store?.label || "Strongsville Walmart";
const anyModalOpen = () => el.sheet.open || el.tallySheet.open || el.settings.open || state.tourOpen;

function highlight(text, toks) {
  const t = String(text ?? "");
  const words = toks.filter((w) => w.length >= 2 || /\d/.test(w));
  if (!words.length) return esc(t);
  const re = new RegExp(`(^|[^a-z0-9])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  let out = "", last = 0;
  for (const m of t.matchAll(re)) {
    const start = m.index + m[1].length;
    out += esc(t.slice(last, start)) + `<mark>${esc(m[2])}</mark>`;
    last = start + m[2].length;
  }
  return out + esc(t.slice(last));
}

/** Each sheet carries its own toast region, created when it opens and kept across re-renders: a modal dialog makes
 * everything outside it inert and draws above it, so a toast outside would be hidden from sight, touch and screen
 * readers, and a live region that is replaced with every re-render is never announced. */
function dialogToasts(dlg) {
  let h = dlg.querySelector(":scope > .toasts-dlg");
  if (!h) { h = document.createElement("div"); h.className = "toasts-dlg"; h.setAttribute("aria-live", "polite"); dlg.prepend(h); }
  return h;
}
/** Replace a sheet's content, keeping its toast region (and the toasts in it) where it is: a region taken out and put
 * back restarts the entry animation of every toast in it, so the toast a re-render follows (Check for new prices, V3)
 * blinked off and on again. */
function setDialogHtml(dlg, html) {
  const h = dlg.querySelector(":scope > .toasts-dlg");
  for (const n of [...dlg.childNodes]) if (n !== h) n.remove();
  const tpl = document.createElement("template"); tpl.innerHTML = html;
  dlg.append(tpl.content);
}
/** Where a toast goes: inside the open sheet, or over the page. `page` is for an action that is about to close the sheet
 * (Add to tally, Clear): its toast must outlive it. */
function toastHost(page = false) {
  const dlg = page ? null : [el.sheet, el.tallySheet, el.settings].find((d) => d.open && !d._closeTimer);
  return dlg ? dialogToasts(dlg) : el.toasts;
}
function toast(text, { action, onAction, ms = 4200, iconName = "check", page = false } = {}) {
  const t = document.createElement("div");
  t.className = "toast";   // the container is the live region; the toast itself is not one more
  t.innerHTML = `${icon(iconName)}<span>${esc(text)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  t.querySelector("button")?.addEventListener("click", () => { onAction?.(); dismiss(); });
  const dismiss = () => { if (!t.isConnected) return; t.classList.add("is-out"); setTimeout(() => t.remove(), 220); };
  const host = toastHost(page);
  host.appendChild(t);
  while (host.children.length > 3) host.firstChild.remove();
  if (ms) setTimeout(dismiss, ms);
  return dismiss;
}

// ------------------------------------------------------------------ theme / viewport
function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  const dark = prefs.theme === "dark" || (prefs.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = dark ? "#0a0d0b" : "#f7f5f0"; });
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
// keyboard or touch: focus rings show only for a keyboard (app.css)
// Navigation keys mean a keyboard is in use: Tab and Escape anywhere; the arrows, Enter, Space and "/" outside a text
// field. Typing into a field (the phone's own keyboard, its Go key, Backspace) never turns the focus rings on.
document.addEventListener("keydown", (e) => {
  const k = typeof e.key === "string" ? e.key : "";
  if (!k) return;
  if (k === "Tab" || k === "Escape" || (!typing() && (k.startsWith("Arrow") || k === "Enter" || k === " " || k === "/"))) document.documentElement.dataset.kbd = "";
}, true);
document.addEventListener("pointerdown", () => { delete document.documentElement.dataset.kbd; }, true);

const vv = window.visualViewport;
const rootStyle = document.documentElement.style;
const standalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = !isIOS && /Android/i.test(navigator.userAgent);
// What to update when the browser is too old (the feature gate at the end of this file): iPhone browsers are all the
// system's WebKit, so it is iOS itself; on Android it is the browser app, which updates from the Play Store on its own.
const UPDATE_WHAT = isIOS ? "Update to iOS 16.4 or later" : isAndroid ? "Update Chrome (or the phone's browser) from the Play Store" : "Update this browser";
/** True while a text field has the focus: the only time a phone keyboard can be on screen. */
const typing = () => { const a = document.activeElement; return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"); };
/** The system's top safe-area inset in px (status bar / sensor housing), read from a probe styled with env(). */
const safeProbe = document.createElement("div");
safeProbe.setAttribute("aria-hidden", "true");
safeProbe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)";
document.body.append(safeProbe);
const safeTop = () => safeProbe.offsetHeight;

// A keyboard-sized loss of visible height (iOS never resizes the window for the keyboard; the visual viewport shrinks
// by the keyboard, 260-400 px with its accessory bar); Safari's collapsing toolbars and a rubber-band scroll are far
// smaller, and a page not installed reports them in innerHeight too.
const KEYBOARD_MIN_PX = 100;
const KEYBOARD_SETTLE_MS = 150;   // no change of the visible height for this long: the keyboard's animation is over
// A pan is never fought. iOS can keep one going on its own: during a caret drag WebKit's selection autoscroll
// re-applies it every 50 ms whenever the finger's point is outside the visible area (a thumb that slides onto the
// keyboard), so an undo made then is put back within a frame or two, and undoing again is a tug of war the screen
// shows as flicker (owner's recording, 2026-10-23: the cursor held in the search box). So, while the keyboard is up:
// a pan is followed, not undone, while a finger is on the screen; and an undo that iOS puts back is not repeated: the
// pan is followed until a finger lifts, the pan goes back to 0 by itself, or the keyboard goes. A pan left behind once
// the keyboard has gone is always undone (nothing can re-apply it then: the layout and visible heights are equal).
const UNDO_PUT_BACK_MS = 1500;   // a pan that grows again this soon after an undo was put back by iOS, not left over
let kbLast = { inset: 0, top: 0, height: 0, heightAt: 0, pinAt: 0, rawPan: 0, undoAt: -Infinity, lowSinceUndo: 0, yielding: false };
let touchesDown = 0;   // fingers on the screen, from the last touch event (a stale count is corrected by the next touch)
const touching = () => touchesDown > 0;
function yieldToPan(why) { if (!kbLast.yielding) traceVv(`pan back after an undo (${why}): followed, not undone`); kbLast.yielding = true; }
for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  window.addEventListener(type, (e) => {
    const was = touchesDown;
    touchesDown = e.touches?.length || 0;
    if (!touchesDown) { if (was) kbLast.yielding = false; pollKeyboard(); }   // the gesture is over: one undo may follow
  }, { capture: true, passive: true });
}
const vvTrace = [];   // the last viewport readings, for Diagnostics (Settings › About)
const traceVv = (text) => { vvTrace.push(`${(performance.now() / 1000).toFixed(1)}s ${text}`); if (vvTrace.length > 24) vvTrace.shift(); };
function keyboardInset() {
  // Read from the visual viewport's geometry, not from the focus: the keyboard can be up with nothing focused (the
  // accessory bar's arrows, a tap that blurred the field a moment before the keyboard goes), and a field can be
  // focused with no keyboard (a hardware keyboard, the desktop). A pinch-zoomed page is never a keyboard.
  const zoomed = !!vv && vv.scale > 1.01;
  const vvh = vv ? Math.round(vv.height) : window.innerHeight;
  const now = performance.now();
  const rawPan = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
  // The height of the layout viewport, which the fixed layout is measured against. That is innerHeight, except that
  // iOS clips innerHeight to the document once the page is panned into the keyboard's room (WKWebView intersects the
  // unobscured rect with the content before the page reads it), so at the bottom of a pan it equals the visible height
  // and the keyboard would read as gone (owner's recording, 2026-10-23: mid-drag the list slid down under the keyboard
  // and the dock got its home-indicator padding back). The clipped reading plus the pan is the layout height again; the
  // root's clientHeight caps it, since Safari's layout viewport is shorter than innerHeight once its toolbars collapse.
  const layoutH = Math.max(window.innerHeight, Math.min(document.documentElement.clientHeight, window.innerHeight + rawPan));
  // settled: neither the height nor the pan has moved for a while. In a Home Screen app iOS gives the visual viewport
  // its final height at once and then animates the pan; undoing on the height alone cut into that animation
  // (owner's recording, 2026-10-23: the page slid up, then snapped down half a second later)
  if (vvh !== kbLast.height || rawPan !== kbLast.rawPan) { kbLast.height = vvh; kbLast.rawPan = rawPan; kbLast.heightAt = now; }
  const settled = now - kbLast.heightAt >= KEYBOARD_SETTLE_MS;
  const shrink = layoutH - vvh;
  const keyboard = !!vv && !zoomed && (shrink >= KEYBOARD_MIN_PX || (typing() && shrink > 0));
  let pan = rawPan;
  // iOS opens the keyboard by panning the page up (offsetTop) to reveal the field, and a drag with the keyboard up can
  // pan it further. While the keyboard animates, everything fixed follows the pan (--vv-top) so nothing on screen
  // moves; once it has settled the pan is undone (window.scrollTo moves the visual viewport in WebKit) with the layout
  // already written for pan 0 in the same frame, so the page never has a reason to slide again: the dock is above the
  // keyboard by --kb, which is all iOS wanted. A residual pan after the keyboard has gone (iOS 26.0 left 24 px) is
  // undone the same way. The undo never fights iOS (UNDO_PUT_BACK_MS above): a finger down, or an undo put back, and
  // the pan is followed instead.
  if (!keyboard || rawPan === 0) kbLast.yielding = false;   // the keyboard has gone, or iOS put the page back itself
  const sinceUndo = now - kbLast.undoAt;
  if (keyboard && sinceUndo < UNDO_PUT_BACK_MS) {
    if (rawPan > kbLast.lowSinceUndo) yieldToPan("the pan grew again after the undo");
    kbLast.lowSinceUndo = Math.min(kbLast.lowSinceUndo, rawPan);
  }
  let undo = false;
  if (pan > 0 && settled && now - kbLast.pinAt > 120 && (!keyboard || (!touching() && !kbLast.yielding))) {
    if (keyboard && sinceUndo < UNDO_PUT_BACK_MS) yieldToPan("a second undo this soon");
    else { undo = true; pan = 0; kbLast.pinAt = now; kbLast.undoAt = now; kbLast.lowSinceUndo = rawPan; }
  }
  const inset = keyboard ? Math.max(0, Math.round(layoutH - vvh - pan)) : 0;
  const top = keyboard ? pan : 0;
  if (inset !== kbLast.inset || top !== kbLast.top) {
    traceVv(`kb ${inset} pan ${top} (vv ${vvh}/${window.innerHeight}${layoutH !== window.innerHeight ? `, layout ${layoutH}` : ""}${typing() ? ", typing" : ""}${touching() ? ", touching" : ""}${kbLast.yielding ? ", following" : ""}${undo ? ", pan undone" : ""})`);
    kbLast.inset = inset; kbLast.top = top;
  }
  withResultsRowHeld(() => {
    rootStyle.setProperty("--kb", `${inset}px`);
    rootStyle.setProperty("--vv-top", `${top}px`);
    // The keyboard covers the home indicator: the dock drops its safe-area padding while it sits on the keyboard. Keyed
    // on the keyboard being there, never on the inset: when iOS reveals the field by panning the whole keyboard height
    // the inset is 0 while the keyboard is up, and the padding came back as a blank band under the search box (the
    // gap in the owner's screenshot, 2026-10-23). The bar heights are re-measured in the same frame, so nothing that
    // reads --dock-h lags the dock by a frame.
    const safeWas = rootStyle.getPropertyValue("--dock-safe-b");
    if (keyboard) rootStyle.setProperty("--dock-safe-b", "0px"); else rootStyle.removeProperty("--dock-safe-b");
    if (safeWas !== rootStyle.getPropertyValue("--dock-safe-b")) syncBars();
    // html[data-kb]: app.css turns the browser's pan gesture off on everything that does not scroll while the keyboard
    // is up, so a drag on the header, the dock or the empty home cannot pan the visual viewport in the first place
    if (keyboard) document.documentElement.dataset.kb = "1"; else delete document.documentElement.dataset.kb;
    if (undo) window.scrollTo(0, 0);
  });
}
/** Runs a layout change that can move the results box (the keyboard, the banner, the pan) while keeping the row the
 *  volunteer is looking at where it is: the list is anchored to its bottom (the best match by the thumb), so a change
 *  of its height moved every row the reader had scrolled to, by the whole keyboard (rows "above the screen"). At the
 *  best match (scrollTop 0) nothing is held: the best match rides with the dock, as it should. */
function withResultsRowHeld(apply) {
  const box = el.results;
  if (box.hidden || !box.scrollTop) { apply(); return; }
  const b0 = box.getBoundingClientRect();
  // the top-most visible row: it stays in view whether the box loses or gains room at its bottom (the keyboard)
  let row = null, rowTop = Infinity;
  for (const r of el.list.querySelectorAll(".row")) { const b = r.getBoundingClientRect(); if (b.bottom > b0.top && b.top < b0.bottom && b.top < rowTop) { row = r; rowTop = b.top; } }
  const before = row ? row.getBoundingClientRect().top - b0.top : 0;
  apply();
  if (!row) return;
  const after = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
  if (Math.abs(after - before) >= 1) box.scrollTop += after - before;
}
// iOS animates the keyboard over about a third of a second and does not promise a resize event for every step, or a
// last one: after anything that can move the keyboard, the viewport is read every frame for a while, so a missed
// event cannot leave the dock under the keyboard or above it (keyboard-check S3).
let kbPollUntil = 0, kbPolling = false;
function pollKeyboard(ms = 800) {
  kbPollUntil = Math.max(kbPollUntil, performance.now() + ms);
  if (kbPolling) return;
  kbPolling = true;
  const tick = () => { keyboardInset(); if (performance.now() < kbPollUntil) requestAnimationFrame(tick); else kbPolling = false; };
  requestAnimationFrame(tick);
}
const onViewport = () => { keyboardInset(); pollKeyboard(); };
vv?.addEventListener("resize", onViewport);
vv?.addEventListener("scroll", onViewport);
window.addEventListener("resize", onViewport);
window.addEventListener("pageshow", onViewport);
document.addEventListener("focusin", onViewport);
document.addEventListener("focusout", () => { setTimeout(keyboardInset, 0); pollKeyboard(); setTimeout(() => { if (!typing()) maybeApplyPending(); }, 2000); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) onViewport(); });
// while a field has the focus the keyboard can come and go without an event reaching here (iOS): a slow safety net
setInterval(() => { if (typing() || kbLast.inset) keyboardInset(); }, 500);

/** The header and the dock are measured, never assumed: everything placed under the header reads --top-h (its height,
 * status-bar inset included) and everything placed above the dock reads --dock-h (its height, home-indicator padding
 * included). Both follow text size, the tally pill and the keyboard. */
function syncBars() {
  rootStyle.setProperty("--top-h", `${Math.round(el.top.getBoundingClientRect().height * 100) / 100}px`);
  rootStyle.setProperty("--dock-h", `${Math.round(el.dock.getBoundingClientRect().height * 100) / 100}px`);
}
if ("ResizeObserver" in window) { const ro = new ResizeObserver(syncBars); ro.observe(el.top); ro.observe(el.dock); }
syncBars();

// Safari can come back from a rotation with the page left zoomed in; the only remedy is to pin the scale for one frame
const viewportMeta = document.querySelector('meta[name="viewport"]');
function resetZoomAfterRotation() {
  setTimeout(() => {
    keyboardInset();
    if (!vv || !viewportMeta || vv.scale <= 1.01) return;
    const content = viewportMeta.content;
    viewportMeta.content = `${content}, maximum-scale=1`;
    requestAnimationFrame(() => { viewportMeta.content = content; keyboardInset(); });
  }, 350);
}
window.addEventListener("orientationchange", resetZoomAfterRotation);
screen.orientation?.addEventListener?.("change", resetZoomAfterRotation);

// ------------------------------------------------------------------ modal stack (dialogs + scanner share history)
// Every open pushes a history entry so the phone's Back closes the top-most layer. A close that owns the top
// entry goes through history.back() and finishes in popstate; anything that must follow a close (open the
// scanner, close the scanner, focus the search box) runs from the dialog's "closed" event, never in the same
// task as the pending back().
const modals = {
  open(dlg, html) {
    if (dlg._closeTimer) { clearTimeout(dlg._closeTimer); dlg._closeTimer = 0; dlg.classList.remove("is-closing"); if (dlg.open) dlg.close(); }
    setDialogHtml(dlg, html);
    dialogToasts(dlg);   // the live region exists before its first toast, so screen readers announce it
    if (state.scanOpen) state.scan?.pause();
    if (!dlg.open) dlg.showModal();
    history.pushState({ modal: dlg.id, n: (history.state?.n || 0) + 1 }, "");
    dlg.querySelector(".sheet-inner").scrollTop = 0;
    dlg.querySelector(".x-btn")?.addEventListener("click", () => modals.close(dlg));
  },
  close(dlg, { fromPop = false, instant = false } = {}) {
    if (!dlg.open) return;
    instant ||= !!dlg._dragged;   // dragged off screen: the drag was the closing animation
    if (dlg._closeTimer) { if (!instant) return; clearTimeout(dlg._closeTimer); dlg._closeTimer = 0; }
    if (!fromPop && history.state?.modal === dlg.id) { history.back(); return; }   // popstate finishes the close
    const finish = () => {
      dlg._closeTimer = 0; dlg.classList.remove("is-closing");
      dlg._dragged = false; clearTimeout(dlg._springTimer); dlg.style.translate = ""; dlg.style.transition = ""; dlg.style.willChange = "";
      // toasts still showing in the sheet move over the page instead of closing with it
      for (const t of [...(dlg.querySelector(":scope > .toasts-dlg")?.children || [])]) el.toasts.appendChild(t);
      if (dlg.open) dlg.close(); dlg.dispatchEvent(new CustomEvent("closed"));
    };
    if (!instant && matchMedia("(prefers-reduced-motion: no-preference)").matches) { dlg.classList.add("is-closing"); dlg._closeTimer = setTimeout(finish, 220); } else finish();
  },
};
for (const dlg of [el.sheet, el.tallySheet, el.settings]) {
  sheetDrag(dlg);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); modals.close(dlg); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) modals.close(dlg); });
}
window.addEventListener("popstate", () => {
  const top = history.state?.modal;
  const openDlg = [el.sheet, el.tallySheet, el.settings].find((d) => d.open && !d._closeTimer);
  if (openDlg && top !== openDlg.id) { modals.close(openDlg, { fromPop: true }); return; }
  if (state.tourOpen && top !== "tour") { closeTour({ fromPop: true }); return; }
  if (state.scanOpen && top !== "scanner") { closeScanner({ fromPop: true }); return; }
  // Forward onto an entry whose layer is already closed (Back, then Forward) would leave a Back that does nothing:
  // step back past it: the entry belongs to a layer that is already closed
  const layerOpen = { tour: state.tourOpen, scanner: state.scanOpen, sheet: el.sheet.open, tallySheet: el.tallySheet.open, settings: el.settings.open };
  if (top && !layerOpen[top]) history.back();
});
// a reload keeps the previous entry's state: never start with a stale "a modal is open" marker
if (history.state?.modal) history.replaceState(null, "", location.href);

/**
 * Drag a sheet down by its header to close it, as native sheets do. The header is the handle, the title and the row
 * with the close button (the handle alone was a 21px strip). Wired once per dialog, on the dialog itself: a re-render of
 * its content mid-drag (Settings refreshes its price card) cannot drop the gesture or strand the sheet half-way.
 * - a drag starts after 6px downwards, so a tap on the header is still a tap and the close button still a button
 * - from the touch on the header until the sheet settles it is lifted onto its own compositing layer (will-change):
 *   moved without one, every frame repainted the whole screen, the blurred page behind included, and the drag stuttered
 *   on the iPhone; held for good, the layer would keep a full-screen bitmap in memory while the sheet just sits open
 * - a release past a quarter of the sheet (at most 120px) or a downward flick closes it, sliding on from where the
 *   finger let go; anything else springs back. The click that follows a drag is swallowed (with the pointer captured
 *   it lands on the dialog itself, which reads as a tap outside the sheet and would close it).
 */
function sheetDrag(dlg) {
  let d = null;
  const still = () => !matchMedia("(prefers-reduced-motion: no-preference)").matches;
  const move = (y, transition = "none") => { dlg.style.transition = transition; dlg.style.translate = y > 0 ? `0 ${y}px` : ""; };
  const lift = (on) => { dlg.style.willChange = on ? "transform" : ""; };
  // the layer goes once the sheet is at rest: after the spring-back, or at once when nothing moved
  const rest = (ms) => { clearTimeout(dlg._springTimer); dlg._springTimer = setTimeout(() => { if (!d) { dlg.style.transition = ""; lift(false); } }, ms); };
  dlg.addEventListener("pointerdown", (e) => {
    dlg._swallowClick = false;
    if (d || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || dlg._closeTimer || dlg._dragged) return;
    if (!e.target.closest?.(".sheet-top") || e.target.closest("button, a, input, select, textarea, [role=switch]")) return;
    d = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, v: 0, on: false };
    clearTimeout(dlg._springTimer); lift(true);   // ready before the first move, so the first frames do not repaint
  });
  dlg.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.on) {
      const dy = e.clientY - d.y0;
      if (dy < -6) { d = null; rest(340); return; }   // upwards: not a dismiss
      if (dy < 6) return;
      d.on = true; d.y0 = e.clientY; d.t = e.timeStamp;   // the sheet moves from here: no jump by the threshold
      try { dlg.setPointerCapture(d.id); } catch { /* the gesture still works without it */ }
    }
    const dy = Math.max(0, e.clientY - d.y0), dt = Math.max(1, e.timeStamp - d.t);
    d.v = 0.7 * ((dy - d.dy) / dt) + 0.3 * d.v;   // px per ms, smoothed
    d.dy = dy; d.t = e.timeStamp;
    move(dy);
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const { on, dy, v } = d; d = null;
    if (!on) { rest(340); return; }   // a tap (it may have landed during a spring-back: let that finish lifted)
    dlg._swallowClick = true; setTimeout(() => { dlg._swallowClick = false; }, 400);   // iOS can send it late
    const h = dlg.getBoundingClientRect().height;
    const close = e.type === "pointerup" && (dy > Math.min(120, h * 0.25) || (v > 0.45 && dy > 20));
    if (!close) {
      move(0, still() ? "none" : "translate .32s cubic-bezier(.25, 1, .5, 1)");
      rest(340);
      return;
    }
    dlg._dragged = true;   // modals.close then finishes at once: this slide is the closing animation
    if (still()) { modals.close(dlg); return; }
    const ms = Math.round(Math.min(260, Math.max(140, (h - dy) / Math.max(v, 1.6))));
    move(h + 40, `translate ${ms}ms cubic-bezier(.3, .6, .4, 1)`);
    setTimeout(() => modals.close(dlg), ms);
  };
  dlg.addEventListener("pointerup", end);
  dlg.addEventListener("pointercancel", end);
  dlg.addEventListener("click", (e) => { if (dlg._swallowClick) { dlg._swallowClick = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

// ------------------------------------------------------------------ price status: one story for the pill, the card, the dot and the announcement
// Every surface that talks about the prices reads priceStatus(), so they can never disagree. The header pill always
// carries the date of the price list (or the one word that matters while there is none); the home card appears only
// when there is something to know or do (downloading, more departments on the way, offline with nothing saved, a
// problem). Old prices are the banner's job (renderStale) and the dot's colour.
function setProgress(frac) {
  if (frac == null) { el.progress.hidden = true; el.progressBar.style.width = "0"; return; }
  el.progress.hidden = false; el.progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}
const pct = (d) => Math.min(100, Math.max(0, Math.round((d.doneBytes / (d.totalBytes || 1)) * 100)));

/** { state, long, short, live, card: null | { tone, icon, title, sub } } for the current inputs. */
function priceStatus() {
  const online = navigator.onLine;
  if (state.unsupported) {
    return { state: "error", long: "Update required", short: "Update", live: "Software update required to keep prices on this phone.",
      card: { tone: "problem", icon: "info", title: "Software update required", sub: `${UPDATE_WHAT} to keep prices on this phone.` } };
  }
  if (!db.version) {
    const err = state.dbErr;
    // nothing has happened for a while (a stalled download, a pack that will not open, a browser that lost the thread):
    // say so and offer a retry instead of a spinner that never ends (owner's first Home Screen launch, 2026-10-21)
    if (state.bootStuck && db.state !== "error") {
      return { state: "error", long: "Taking longer than expected", short: "Retry", live: "The price list is taking longer than expected. Tap to retry.",
        card: { tone: "problem", icon: "refresh", title: "Taking longer than expected", sub: db.state === "downloading" ? `The download stopped making progress${state.dlBytes ? ` at ${mb(state.dlBytes.done)} of ${mb(state.dlBytes.total)}` : ""}. Tap to retry.` : "The price list did not open. Tap to retry." } };
    }
    if (db.state === "downloading") return { state: "downloading", long: "Downloading", short: "Loading", live: "Downloading prices.", card: { tone: "busy", icon: "refresh", title: "Downloading prices", sub: state.dlPct == null ? "Starting the download." : `${state.dlPct}% complete${state.dlBytes?.total ? ` · ${mb(state.dlBytes.done)} of ${mb(state.dlBytes.total)}` : ""}` } };
    if (db.state === "offline-empty") return { state: "offline", long: "Offline", short: "Offline", live: "Offline. No prices on this phone yet.", card: { tone: "problem", icon: "wifi-off", title: "No prices on this phone yet", sub: "Connect to the internet to download them." } };
    if (db.state === "error" && err) {
      if (err.storage) return { state: "error", long: "Storage full", short: "Storage", live: "Phone storage is full.", card: { tone: "problem", icon: "info", title: "Phone storage is full", sub: `Free about ${db.storageFull?.needMB || err.needMB || "?"} MB, then reopen the app.` } };
      if (err.server) return { state: "error", long: "Server unavailable", short: "Error", live: "The price server is unavailable. Retrying automatically.", card: { tone: "problem", icon: "info", title: "Price server unavailable", sub: "Retrying automatically." } };
      if (err.network) return { state: "offline", long: "No connection", short: "Offline", live: "Download paused until the connection returns.", card: { tone: "problem", icon: "wifi-off", title: "Download paused", sub: "It resumes when the connection returns." } };
      return { state: "error", long: "Unavailable", short: "Error", live: "The price list could not be opened.", card: { tone: "problem", icon: "info", title: "The price list could not be opened", sub: "Open Settings for details." } };
    }
    return { state: "loading", long: "Loading", short: "Loading", live: "Loading the price list.", card: { tone: "busy", icon: "refresh", title: "Loading the price list", sub: "Preparing prices on this phone." } };
  }
  if (state.workerError) {
    return { state: "error", long: "Unavailable", short: "Error", live: "The price search stopped. Close and reopen the app.", card: { tone: "problem", icon: "info", title: "The price search stopped", sub: "Close and reopen the app." } };
  }
  const date = fmtDate(priceDate()), dateLong = fmtDate(priceDate(), true);
  const out = online
    ? { state: "ready", long: `Prices ${date}`, short: date, live: `Price list updated ${dateLong}.`, card: null }
    : { state: "ready", long: `Offline · ${date}`, short: "Offline", live: "Offline. Saved prices remain available.", card: null };
  if (db.storageFull) { out.card = { tone: "problem", icon: "info", title: "Phone storage is full", sub: `Free about ${db.storageFull.needMB} MB to finish downloading prices.` }; out.live = `Phone storage is full. Free about ${db.storageFull.needMB} MB to finish downloading prices.`; }
  else if (db.more) {
    const ready = "Groceries and essentials are ready.";
    out.card = !online ? { tone: "info", icon: "wifi-off", title: "More departments download when online", sub: ready }
      : state.morePaused ? { tone: "info", icon: "info", title: "More departments not downloaded yet", sub: "The download resumes automatically." }
      : { tone: "busy", icon: "refresh", title: "Adding more departments", sub: state.morePct == null ? ready : `${state.morePct}% complete · ${ready.toLowerCase()}` };
  }
  return out;
}

let statusCardHtml = "";
function renderStatus() {
  const s = priceStatus();
  el.status.dataset.state = s.state;
  el.status.setAttribute("aria-label", `Price list: ${s.long}. Opens Settings.`);
  el.statusText.innerHTML = `<span class="st-long">${esc(s.long)}</span><span class="st-short">${esc(s.short)}</span>`;
  // a screen reader hears a change of meaning once, never a download percentage
  if (s.live !== state.lastLive) { state.lastLive = s.live; el.statusLive.textContent = s.live; }
  const c = el.readyCard;
  if (!s.card) { if (!c.hidden) { c.hidden = true; c.innerHTML = ""; statusCardHtml = ""; } return; }
  const html = `<span class="sc-ico">${icon(s.card.icon)}</span><span class="sc-text"><b>${esc(s.card.title)}</b><span class="sub">${esc(s.card.sub)}</span></span>${icon("back", "ico chev")}`;
  c.dataset.tone = s.card.tone;
  if (html !== statusCardHtml) { c.innerHTML = html; statusCardHtml = html; }
  c.hidden = false;
}

db.addEventListener("state", (e) => {
  const d = e.detail;
  if (d.state === "error") {
    setProgress(null);
    state.dbError = d.message; state.dbErrorPlain = false;
    if (db.version) state.workerError = true;   // the search worker failed after the prices were open
    else {
      state.dbErr = { network: !!d.network, server: !!d.server, storage: !!d.storage, needMB: d.needMB || 0 };
      // a dropped connection or a busy server: try again on our own (also on the "online" event)
      if ((d.network || d.server) && !state.unsupported) {
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(() => { if (!db.version && navigator.onLine) db.start().catch(() => {}); }, 30_000);
      }
    }
    if (state.query.trim()) runSearch(state.query);
  } else if (d.state === "ready" || d.state === "downloading" || d.state === "loading") {
    state.dbErr = null; state.dbError = null;
    if (d.state === "ready") { setProgress(null); state.dlPct = null; }
  } else if (d.state === "offline-empty") {
    setProgress(null);
    if (state.query.trim()) runSearch(state.query);
  }
  renderStale();
  renderStatus();
});
// a full phone during a background download (other departments, a weekly update): the card says so until a later
// download succeeds; the prices already on the phone keep working
for (const ev of ["storage-full", "storage-ok"]) db.addEventListener(ev, () => { if (ev === "storage-full") setProgress(null); renderStatus(); });
db.addEventListener("progress", (e) => {
  const d = e.detail;
  if (d.phase === "download") {
    // the first download and the other departments show their progress; a background update stays silent
    if (!d.background) { state.dlPct = pct(d); state.dlBytes = { done: d.doneBytes, total: d.totalBytes }; setProgress(d.totalBytes ? d.doneBytes / d.totalBytes : 0); renderStatus(); }
    else if (d.tier === "more" && db.version) { state.morePct = pct(d); state.morePaused = false; setProgress(d.totalBytes ? d.doneBytes / d.totalBytes : 0); renderStatus(); }
  } else if (!db.version && d.total) setProgress(0.9 + 0.1 * (d.done / d.total));
});
db.addEventListener("ready", () => {
  performance.mark("sfb:db-ready");
  perf.boot.dbReadyMs = Math.round(performance.now());
  perf.boot.loadMs = db.stats?.loadMs; perf.boot.wallMs = db.stats?.wallMs; perf.boot.downloadMs = db.stats?.downloadMs ?? null;
  requestAnimationFrame(() => { performance.mark("sfb:interactive"); perf.boot.interactiveMs = Math.round(performance.now()); document.documentElement.dataset.ready = "1"; });
  state.workerError = false;
  pruneRecent();
  dropSampleLines();
  refreshRecent();
  if (state.query.trim()) runSearch(state.query);
  if (scanShortcut && !state.scanOpen && !state.tourOpen) { history.replaceState(null, "", location.pathname); openScanner(); }
});
db.addEventListener("more", () => {
  // the other departments joined the search: refresh the status and whatever is on screen
  setProgress(null);
  state.morePct = null; state.morePaused = false;
  renderStatus();
  refreshRecent();
  if (state.query.trim()) runSearch(state.query);
  if (el.settings.open && !el.settings.querySelector(".confirm-row")) refreshSettings();
});
db.addEventListener("more-paused", () => {
  setProgress(null);
  state.morePct = null; state.morePaused = true;
  renderStatus();
  // try again in a minute while online (a full phone never fixes itself; the card says so instead)
  clearTimeout(state.moreRetry);
  state.moreRetry = setTimeout(() => { if (navigator.onLine && !db.storageFull && db.more) db.checkForUpdate().catch(() => {}); }, 60_000);
});
db.addEventListener("update-available", () => { setProgress(null); maybeApplyPending(true); });
/** Apply a downloaded snapshot when nothing is in progress; otherwise offer it once and retry at the next idle moment. */
function maybeApplyPending(offer = false) {
  if (!db.pendingUpdate) return;
  const idle = !anyModalOpen() && !state.scanOpen && !state.query.trim();
  const apply = () => db.applyUpdate().then(() => { renderStatus(); renderStale(); toast(`Price list updated to ${fmtDate(db.manifest?.priceDate, true)}`); }).catch(() => toast("The new price list could not be opened. The previous price list remains in use.", { iconName: "info" }));
  if (idle) apply();
  else if (offer) toast("A newer price list is ready", { action: "Update", onAction: apply, ms: 8000, iconName: "refresh" });
}
window.addEventListener("online", () => {
  renderStatus();
  renderStale();
  if (state.unsupported) return;   // nothing can be unpacked on this browser: keep saying so
  state.morePaused = false;
  (db.version ? db.checkForUpdate() : db.start()).catch(() => {});
  syncLearned();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncLearned(); });
// Two open copies of the app (a browser tab beside the installed app on Android) share this storage but each keeps its own
// copy in memory: a line added in one would be overwritten by the other's next add. A change made in the other copy is read
// back here at once (the "storage" event fires only in the other copies, never in the one that wrote). Audit P2-002.
window.addEventListener("storage", (e) => {
  if (e.key === TALLY_KEY || e.key === null) { tally = readJson(TALLY_KEY, []); renderTallyPill(); refreshTally(); }
  if (e.key === RECENT_KEY || e.key === null) { recent = readJson(RECENT_KEY, []); renderRecent(); }
  if (e.key === LEARNED_KEY || e.key === null) { const l = readJson(LEARNED_KEY, {}); learned = l && typeof l === "object" && !Array.isArray(l) ? l : {}; }
});
window.addEventListener("offline", () => {
  renderStatus(); renderStale();
  // with no prices on the phone yet (a first download cut short) search cannot work offline: say what happens instead
  toast(db.version ? "Offline. Scanning and search continue to work." : "Offline. Prices download when the connection returns.", { iconName: "wifi-off" });
});
// an installed app (Android's "Add to Home screen") is what makes Chrome grant persistent storage: ask again right then
window.addEventListener("appinstalled", () => { db.requestPersistence({ force: true }).catch(() => {}); hideInstallHint(); });

// ------------------------------------------------------------------ "Add to Home Screen" (first runs, in the browser)
// Safari deletes a website's saved data after about a week without a visit; an app on the Home Screen keeps its prices.
// Android's Chrome (and Samsung Internet) offers its own install prompt, kept here and shown as a button; an Android
// browser that offers none (Firefox; Chrome before it has decided the page is installable) gets the menu steps instead.
// Any other browser (a laptop) is told nothing.
const INSTALL_KEY = "sfb.installHint";
let installPrompt = null;
function hideInstallHint() { const h = $("installHint"); if (h) { h.hidden = true; h.innerHTML = ""; } }
function showInstallHint() {
  const h = $("installHint");
  if (!h || standalone() || readJson(INSTALL_KEY, null)?.dismissed) return;
  if (!isIOS && !isAndroid && !installPrompt) return;
  const how = isIOS
    ? `Tap ${icon("share")} <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen and keeps the prices saved (they download once more inside the app).`
    : installPrompt ? "It opens full screen and keeps the prices saved on this phone."
    : "Open the browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>. It opens full screen and keeps the prices saved.";
  h.innerHTML = `<span class="sc-ico">${icon(isIOS ? "share" : "plus")}</span><div><b>${isIOS ? "Add to Home Screen" : "Install the app"}</b><span class="sub">${how}</span></div>${installPrompt ? `<button class="btn btn--sm" type="button" data-act="install">Install</button>` : ""}<button class="x-btn" type="button" data-act="dismiss" aria-label="Don't show again">${icon("x")}</button>`;
  h.hidden = false;
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; showInstallHint(); });
$("installHint")?.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "install" && installPrompt) { const p = installPrompt; installPrompt = null; p.prompt(); const r = await p.userChoice.catch(() => null); if (r?.outcome === "accepted") hideInstallHint(); else showInstallHint(); }
  if (act === "dismiss") { writeJson(INSTALL_KEY, { dismissed: Date.now() }); hideInstallHint(); }
});

// an installed app that is brought back to the foreground (not relaunched) checks for a new price list too, at most
// every few hours, so a phone that is never fully closed still receives the monthly update
const RECHECK_MS = 4 * 3600_000;
let lastRecheck = performance.now();
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !navigator.onLine || state.unsupported || !db.version || performance.now() - lastRecheck < RECHECK_MS) return;
  lastRecheck = performance.now();
  db.checkForUpdate().catch(() => {});
});

// ------------------------------------------------------------------ prices-as-of banner (amber from 40 days, red from 60)
// Sits under the header, above the content; the dock never moves. Re-evaluated on every database state change,
// when the app comes back to the foreground, when the network comes and goes, and once an hour for a phone left open.
function renderStale() {
  const date = priceDate();
  const level = db.version ? stalenessLevel(date) : "fresh";
  state.stale = level;
  el.status.dataset.stale = level;
  if (level === "fresh") {
    if (!el.stale.hidden) { el.stale.hidden = true; el.stale.innerHTML = ""; }
    syncBannerInset();
    return;
  }
  // built once, then only its words change: replacing the button would drop the focus from it mid-check
  if (!el.stale.querySelector(".stale-text")) {
    el.stale.innerHTML = `${icon("clock")}<div class="stale-text" role="status"><b></b><span></span></div><button class="btn btn--sm" type="button" data-act="update"></button>`;
  }
  const days = daysSince(date);
  // only what changed is written (the text is a live region: a rewrite would be announced again)
  const set = (node, prop, v) => { if (node[prop] !== v) node[prop] = v; };
  set(el.stale.querySelector(".stale-text b"), "textContent", stalenessText(level, days));
  set(el.stale.querySelector(".stale-text span"), "innerHTML", `Prices from <span class="nw">${esc(fmtDate(date, "mid"))}</span>${level === "red" ? ` · <span class="nw">${esc(ageText(days))}</span>` : ""}${navigator.onLine ? "" : ". Connect to the internet to update."}`);
  const btn = el.stale.querySelector("[data-act=update]");
  // aria-disabled, not disabled: a disabled button drops the keyboard focus (checkNow ignores a second tap itself)
  if (btn.getAttribute("aria-disabled") !== String(!!state.staleBusy)) btn.setAttribute("aria-disabled", String(!!state.staleBusy));
  set(btn, "textContent", state.staleBusy ? "Checking…" : "Update now");
  el.stale.dataset.level = level;
  el.stale.hidden = false;
  syncBannerInset();
}
/** The banner is fixed under the header, so the content below is pushed down by its measured height (0 when hidden). */
function syncBannerInset() { rootStyle.setProperty("--banner-h", el.stale.hidden ? "0px" : `${el.stale.offsetHeight}px`); }
if ("ResizeObserver" in window) new ResizeObserver(syncBannerInset).observe(el.stale);
el.stale.addEventListener("click", (e) => { if (e.target.closest("[data-act=update]")) checkNow(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) renderStale(); });
setInterval(renderStale, 3600_000);

/** Settings' "Check for new prices" and the banner's "Update now" share one path: check, download, apply, say what happened. */
async function checkNow(btn = null) {
  if (state.unsupported) { toast(`${UPDATE_WHAT} to download prices.`, { iconName: "info" }); return; }
  if (!navigator.onLine) { toast("Offline. Connect to the internet to check for new prices.", { iconName: "wifi-off" }); return; }
  if (state.staleBusy) { toast("A check is already in progress"); return; }
  const wasStale = state.stale !== "fresh";
  state.staleBusy = true; btn?.setAttribute("aria-disabled", "true"); renderStale();
  const d = toast("Checking for a new price list…", { ms: 0, iconName: "refresh" });
  try {
    const r = await db.checkForUpdate({ apply: true });
    d();
    toast(r.upToDate ? (wasStale ? "No newer price list is available yet" : "The price list is up to date") : r.applied || r.installed ? `Price list updated to ${fmtDate(priceDate(), true)}` : r.busy ? "A check is already in progress" : "No newer price list is available yet");
    renderStatus();
    if (el.settings.open) { const had = document.activeElement === btn; refreshSettings(); if (had) el.settings.querySelector("[data-act=update]")?.focus({ preventScroll: true }); }
  } catch (err) { d(); console.warn("check for update", err); toast("Could not check for a new price list. Try again later.", { iconName: "info" }); }
  finally { state.staleBusy = false; btn?.removeAttribute("aria-disabled"); renderStale(); }
}

// ------------------------------------------------------------------ search
const PLACEHOLDER = el.q.placeholder;
// iOS slides the whole page up to reveal a field it thinks the keyboard will cover, judged from where the field is
// at the moment it takes the focus; a field in a bottom bar always qualifies, so every tap on the search box slid
// the page up, and the app then had to bring it back down (owner's screen recording, 2026-10-23: the header off the
// top, the keyboard over the search box, then a snap back, in half a second). So a tap on a text field that is not
// focused yet takes the focus itself: the tap's own default is cancelled, the field is moved far above the screen for
// that instant, focused without scrolling, and put back on the next frame. iOS sees nothing to reveal and only raises
// the keyboard, which the dock rides up on (--kb, read every frame). The pattern of React Aria's usePreventScroll.
// A field that already has the focus is left alone, so taps that move the caret or select text work as before.
function focusWithoutReveal(e) {
  const field = e.currentTarget;
  if (document.activeElement === field || field.disabled || e.touches?.length) return;
  e.preventDefault();
  field.style.transform = "translateY(-2000px)";
  field.focus({ preventScroll: true });
  requestAnimationFrame(() => { field.style.transform = ""; });
  pollKeyboard(1200);
}
for (const field of [el.q, el.scanTypeInput]) field.addEventListener("touchend", focusWithoutReveal, { passive: false });

// One search per animation frame: a burst of keystrokes (or backspaces) searches and renders once, for the text as it
// stands when the frame comes, instead of once per key with every intermediate list drawn and thrown away.
let searchFrame = 0;
el.q.addEventListener("input", () => {
  const q = el.q.value;
  if (el.q.placeholder !== PLACEHOLDER) el.q.placeholder = PLACEHOLDER;
  el.clearBtn.hidden = !q;
  state.query = q;
  if (!q.trim()) { cancelAnimationFrame(searchFrame); searchFrame = 0; showHome(); return; }
  cancelMore();
  if (searchFrame) return;
  searchFrame = requestAnimationFrame(() => { searchFrame = 0; if (state.query.trim() && state.query === el.q.value) runSearch(state.query); });
});
// A finger on the results, or a list still coasting, is never moved by a render: the answer waits for the quiet
// (keyboard-check S9; results audit, 2026-10-23). The best match re-anchors only for a new query.
let resultsTouching = false, resultsScrollTimer = 0, deferredRender = null;
const resultsBusy = () => resultsTouching || resultsScrollTimer !== 0;
function renderWhenQuiet() { if (!resultsBusy() && deferredRender) { const d = deferredRender; deferredRender = null; if (d.seq === state.seq) renderResults(d.res, d.code, d.q); } }
el.results.addEventListener("touchstart", () => { resultsTouching = true; }, { passive: true });
for (const ev of ["touchend", "touchcancel"]) el.results.addEventListener(ev, () => { resultsTouching = false; setTimeout(renderWhenQuiet, 0); }, { passive: true });
el.results.addEventListener("scroll", () => { clearTimeout(resultsScrollTimer); resultsScrollTimer = setTimeout(() => { resultsScrollTimer = 0; renderWhenQuiet(); }, 120); }, { passive: true });
el.clearBtn.addEventListener("click", () => { el.q.value = ""; el.clearBtn.hidden = true; state.query = ""; showHome(); el.q.focus(); });
el.searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = el.q.value.trim();
  if (!q) return;
  // a keyboard-wedge scanner types digits + Enter faster than the worker answers: resolve the text itself
  if (classifyCode(q).kind !== "text") { openCode(q, { source: "typed" }); return; }
  if (state.pending) await state.pending;              // make sure the rows belong to this query
  if (state.query.trim() !== q) return;
  const first = state.last?.items?.[0];
  if (first) openRank(first.rank, { closest: !!state.last.relaxed });
});
/** Home or results: one switch, so the header's tally pill (results only; home has the tally card) always follows. */
function setView(view) {
  el.home.hidden = view !== "home"; el.results.hidden = view !== "results"; el.resultsMeta.hidden = view !== "results";
  renderTallyPill();
}
function showHome() {
  state.seq++;
  state.learnFor = null;          // a search by name for an unknown barcode ends with the home screen, either way
  setView("home");
  el.list.innerHTML = ""; el.resultsMeta.textContent = "";
  state.last = null; state.codeHit = null; state.pending = null; state.shownQuery = null;
  renderRecent();
  homeToTop();
  if (!typing()) maybeApplyPending();   // backspacing to nothing is not an idle moment: the swap waits for the keyboard to go
}
/** Home reads top-down (the food bank, a status card when there is one, the tally, Recent) and always comes back at the top. */
/** The home panel scrolls on its own (it is fixed against the visible area); the page itself never scrolls, and nothing
 *  here asks it to: a window.scrollTo while the keyboard is up made iOS re-pan the page to keep the field in view. */
function homeToTop() { requestAnimationFrame(() => { if (!el.home.hidden) el.main.scrollTop = 0; }); }
/** The best match sits at the bottom of the bottom-anchored results. scrollHeight lands there whether the engine counts
 *  a column-reverse scroller's offset from the bottom (0, negative upward) or from the top. */
function resultsToBest() { el.results.scrollTop = el.results.scrollHeight; }

async function runSearch(q) {
  const t0 = performance.now();
  const seq = ++state.seq;
  state.last = null; state.codeHit = null;
  if (!db.version) {
    setView("results");
    const msg = db.state === "offline-empty" ? "No prices on this phone yet. Connect to the internet to download them."
      : db.state === "error" && state.dbErr?.server ? "The price server is unavailable. The download retries automatically."
      : db.state === "error" && state.dbErr?.network ? "The download is paused. It resumes when the connection returns."
      : db.state === "error" ? "Prices could not be opened. Open Settings and tap Check for new prices." : "Opening prices…";
    el.list.innerHTML = `<li class="empty">${msg}</li>`;
    el.resultsMeta.textContent = "";
    state.shownQuery = null; resultsToBest();
    return;
  }
  const cls = classifyCode(q);
  const p = Promise.all([db.search(q, 40), cls.kind === "text" ? null : resolveCode(db, q, undefined, resolveOpts()).catch(() => null)]);
  state.pending = p;
  const [res, code] = await p;
  if (seq !== state.seq) return;       // a newer keystroke won
  const t1 = performance.now();
  state.last = res; state.codeHit = code; state.pending = null;
  renderResults(res, code, q);
  const t2 = performance.now();
  requestAnimationFrame(() => perf.keystrokes.push({ q, workerMs: res.ms, roundtripMs: Math.round((t1 - t0) * 10) / 10, renderMs: Math.round((t2 - t1) * 10) / 10, totalMs: Math.round((performance.now() - t0) * 10) / 10, n: res.items.length }));
}

function rowHtml(it, toks) {
  const { pre, brand, rest } = splitTitle(it);
  const title = brand ? `${highlight(pre, toks)}<b>${highlight(brand, toks)}</b>${highlight(rest, toks)}` : highlight(rest, toks);
  const n = piecesOf(it);
  const tags = [sizeText(it), countText(it), it.storeBrand ? "Store brand" : "", it.retired ? "Older barcode" : ""].filter(Boolean);
  const sub = it.basis === "lb" ? "<small>per lb</small>" : n > 1 ? `<small>${money(Math.round(it.priceCents / n))} each</small>` : "";
  const value = it.priceWithheld ? `<small>Equivalent value</small>` : sub;
  return `<li><button class="row${it.retired ? " is-retired" : ""}" type="button" data-rank="${it.rank}"><span class="name">${title}</span><span class="price">${money(it.priceCents)}${value}</span><span class="meta">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span></button></li>`;
}
function codeRowHtml(res) {
  const sub = res.unit === "lb" ? "<small>per lb</small>" : "";
  return `<li><button class="row row--code" type="button" data-code="${esc(res.code)}"><span class="name"><span class="kind" data-kind="${res.kind}">${esc(kindLabel(res))}</span><span class="code-title">${esc(res.title)}</span></span><span class="price">${money(res.priceCents)}${sub}</span><span class="meta"><span class="tag mono">${esc(res.gtin ? formatGtin(res.gtin) : res.code)}</span></span></button></li>`;
}

const FIRST_ROWS = 12;   // painted synchronously (more than a phone screen); the rest arrive on the next idle slice
let moreTimer = 0;
function cancelMore() { if (!moreTimer) return; ("cancelIdleCallback" in window ? cancelIdleCallback : clearTimeout)(moreTimer); moreTimer = 0; }
function renderResults(res, code, q) {
  const entering = el.results.hidden;
  if (!entering && resultsBusy()) { deferredRender = { res, code, q, seq: state.seq }; return; }
  deferredRender = null;
  setView("results");
  const toks = tokenize(q);
  // a number that is a priced code is shown as the first row; an unknown code is not shouted over real matches
  const showCode = code && (code.priceCents != null || !res.items.length);
  let html = showCode ? codeRowHtml(code) : "";
  const first = res.items.slice(0, FIRST_ROWS), rest = res.items.slice(FIRST_ROWS);
  for (const it of first) html += rowHtml(it, toks);
  if (!html) html = `<li class="empty"><p>No results for <b>${esc(q)}</b>. Try fewer words or the brand name, or scan the barcode.</p><button class="btn btn--ghost" type="button" data-act="scan">${icon("scan")}<span>Scan the barcode</span></button></li>`;
  el.list.innerHTML = html;
  cancelMore();
  if (rest.length) {
    const seq = state.seq;
    const append = () => { moreTimer = 0; if (seq !== state.seq) return; el.list.insertAdjacentHTML("beforeend", rest.map((it) => rowHtml(it, toks)).join("")); };
    // the remaining rows arrive when the main thread is idle, so a fast typist never pays for them between keystrokes
    moreTimer = "requestIdleCallback" in window ? requestIdleCallback(append, { timeout: 400 }) : setTimeout(append, 50);   // Safari has no idle callback
  }
  let meta = "";
  if (res.notReady) meta = "Opening prices…";
  else if (res.items.length) {
    meta = `<b>${fmtInt(res.total)}</b> ${res.total === 1 ? "match" : "matches"}`;
    if (res.fuzzy) meta += " · spelling corrected";
    if (res.relaxed) meta = `<span class="warn">Closest matches</span>${res.dropped?.length ? ` · “${esc(res.dropped.join(" "))}” not found` : " · no item has every word"}`;
    if (res.otherBrand) meta = `<span class="warn">${esc(res.otherBrand.brand)} is ${esc(whoseBrand(res.otherBrand))}, not sold at Walmart</span> · Walmart's own brand first${res.dropped?.length ? ` · “${esc(res.dropped.join(" "))}” not found` : ""}`;
  }
  el.resultsMeta.innerHTML = meta;
  // the list says "No results" on screen; the announcement says it too
  announceResults(res.items.length || showCode ? el.resultsMeta.textContent : `No results for “${q}”`);
  // a new or refined query starts at its best match; the same query re-run (the database finished opening, more
  // departments arrived) keeps the volunteer where they had scrolled to
  if (entering || state.shownQuery !== q) resultsToBest();
  state.shownQuery = q;
  if (entering) { el.list.classList.add("is-entering"); clearTimeout(state.enterTimer); state.enterTimer = setTimeout(() => el.list.classList.remove("is-entering"), 600); }
}

/** The result count is announced once typing pauses, not on every keystroke. */
let resultsLiveTimer = 0, resultsLiveText = "";
function announceResults(text) {
  clearTimeout(resultsLiveTimer);
  resultsLiveTimer = setTimeout(() => { if (text !== resultsLiveText) { resultsLiveText = text; $("resultsLive").textContent = text; } }, 700);
}
el.list.addEventListener("click", (e) => {
  if (e.target.closest("[data-act=scan]")) { openScanner(); return; }
  const b = e.target.closest("button[data-rank], button[data-code]"); if (!b) return;
  if (b.dataset.code != null) { state.learnFor = null; if (state.codeHit) openResolution(state.codeHit, { source: "typed" }); return; }
  openRank(Number(b.dataset.rank), { closest: !!state.last?.relaxed });
});

async function openRank(rank, { closest = false, source = "search" } = {}) {
  const item = await db.item(rank);
  if (!item) return;
  openResolution(fromItem(item, { closest, query: state.query, dropped: state.last?.dropped || [], otherBrand: state.last?.otherBrand || null }), { source });
}
async function openCode(raw, { source = "typed", format, scanned = false, preferId = null } = {}) {
  state.learnFor = null;
  const res = await resolveWithPending(raw, format, resolveOpts({ scanned, preferId }), () => toast("Other departments are still loading…", { iconName: "refresh", ms: 2500 }));
  if (!res) { toast("Not a valid barcode number", { iconName: "info" }); return null; }
  openResolution(res, { source });
  return res;
}

// ------------------------------------------------------------------ result sheet
function unitCents(res) { return res.unitCents ?? res.priceCents; }
function lineTotal(res) { return Math.round(unitCents(res) * state.qty); }

/** "each", "per lb", "on the label", "whole pack", "1 of 6" or "pack of 6": what the big price is for. */
function basisText(res) {
  const it = res.item;
  if (res.priceCents == null) return "";
  if (res.unit === "lb") return "per lb";
  if (res.kind === "store-label") return "on the label";
  if (res.listing) return res.unitCents === res.listing.cents ? `pack of ${res.listing.n}` : "each";
  const n = piecesOf(it);
  return n > 1 ? (res.unitCents != null && res.unitCents !== res.priceCents ? `1 of ${n}` : "whole pack") : "each";
}
/** The big price, read by a screen reader as one phrase ("$4.84 each"); the visual parts are hidden from it. */
function priceBlockHtml(res) {
  const cents = res.priceCents == null ? null : unitCents(res), basis = basisText(res);
  return `<span class="sr-only" id="sheetPrice">${cents == null ? "No price available" : `${money(cents)}${basis ? ` ${basis}` : ""}`}</span>${bigMoney(cents)}${basis ? `<span class="price-basis" aria-hidden="true">${basis}</span>` : ""}`;
}
const matchWord = (c) => (c === "high" ? "Close match" : c === "medium" ? "Fair match" : c === "rough" ? "Rough estimate" : "Rough match");

function sheetHtml(res) {
  const it = res.item;
  const label = kindLabel(res);
  const chips = [];
  if (it && (res.kind === "exact" || res.kind === "closest")) {
    const s = sizeText(it); if (s) chips.push(s);
    const c = countText(it); if (c) chips.push(c);
    if (it.storeBrand) chips.push("Store brand");
    if (it.retired) chips.push("Older barcode");
  }
  if (res.kind === "plu") { chips.push(`PLU ${res.code}`); chips.push(res.unit === "lb" ? "Sold by weight" : "Sold each"); }
  if (res.kind === "equivalent") { const e = res.equiv; if (e.quantity) chips.push(e.quantity); chips.push(matchWord(e.confidence)); }
  if (res.kind === "store-label" && res.label.needsConfirm) chips.push("Check against the label");
  const notes = notesFor(res, { priceDateLong: fmtDate(priceDate(), true) });
  const title = res.kind === "exact" || res.kind === "closest" ? boldTitle(it) : res.kind === "live" ? boldTitle({ brand: res.brand, name: res.name }) : esc(res.title);
  const updated = `Updated ${fmtDate(priceDate(), "mid")}`;   // the price list's date, as the pill shows it (owner, 2026-10-17); a carried-over row says so in its note
  const checked = res.kind === "live" ? `${liveSource(res.live)} price, checked ${res.live?.checkedAt ? `at ${fmtTime(res.live.checkedAt)}` : "today"}`
    : res.kind === "store-label" ? "Printed by the store's scale"
    : res.kind === "plu" && res.entry.source === "typical" ? "Typical Walmart price"
    : res.kind === "not-ready" ? "The price list is still loading"
    : res.priceCents == null ? "No price on file for this barcode"
    : res.livePrice != null ? `${liveSource(res.live)} price, checked ${res.live?.checkedAt ? `at ${fmtTime(res.live.checkedAt)}` : "today"}`
    : it?.storePrice ? [`${storeLabel()} shelf price`, updated]
    : ["Walmart.com price", updated];
  // the source, then the date of the price list kept on one line (it wraps as a whole after the dot)
  const checkedHtml = Array.isArray(checked) ? `${esc(checked[0])} · <span class="nw">${esc(checked[1])}</span>` : esc(checked);

  // a loose single from a multipack is an exact item too: let the volunteer price one of the pack; an item Walmart
  // lists only as a "(N pack)" bundle is priced as one unit, with the bundle's own price as the alternate
  const packSeg = res.listing && res.priceCents != null
    ? `<div class="seg pack-seg" role="group" aria-label="Price one item or the whole pack"><button type="button" data-pack="unit" data-cents="${res.priceCents}" aria-pressed="${res.unitCents == null || res.unitCents === res.priceCents}">One · ${money(res.priceCents)}</button><button type="button" data-pack="listing" data-cents="${res.listing.cents}" aria-pressed="${res.unitCents === res.listing.cents}">Pack of ${res.listing.n} · ${money(res.listing.cents)}</button></div>`
    : it && piecesOf(it) > 1 && res.unit !== "lb" && res.priceCents != null
    ? `<div class="seg pack-seg" role="group" aria-label="Price the whole pack or one item"><button type="button" data-pack="whole" data-cents="${res.priceCents}" aria-pressed="${res.unitCents == null || res.unitCents === res.priceCents}">Whole pack · ${money(res.priceCents)}</button><button type="button" data-pack="one" data-cents="${Math.round(res.priceCents / piecesOf(it))}" aria-pressed="${res.unitCents != null && res.unitCents !== res.priceCents}">1 of ${piecesOf(it)} · ${money(Math.round(res.priceCents / piecesOf(it)))}</button></div>`
    : "";
  const liveRow = (LIVE_URL && prefs.live && liveCheckable(res.gtin) && res.kind !== "store-label" && res.kind !== "plu" && res.kind !== "not-ready") ? `<div class="live-row" data-state="idle" hidden></div>` : "";

  const stepper = res.priceCents == null ? "" : res.unit === "lb"
    ? `<div class="stepper" role="group" aria-label="Weight"><button class="st-btn" type="button" data-step="-0.25" aria-label="Decrease weight">${icon("minus")}</button><span class="st-val counting" aria-live="polite" aria-atomic="true"><span id="qtyVal">${fmtNum(state.qty)}</span> <small>lb</small></span><button class="st-btn" type="button" data-step="0.25" aria-label="Increase weight">${icon("plus")}</button></div>`
    : `<div class="stepper" role="group" aria-label="Quantity"><button class="st-btn" type="button" data-step="-1" aria-label="Decrease quantity">${icon("minus")}</button><span class="st-val counting" aria-live="polite" aria-atomic="true"><span id="qtyVal">${state.qty}</span> <small>${state.qty === 1 ? "item" : "items"}</small></span><button class="st-btn" type="button" data-step="1" aria-label="Increase quantity">${icon("plus")}</button></div>`;

  // the primary action is described by the match label, the price line and the notes, so a screen reader that lands on
  // it first still hears "Closest match" and any warning
  const desc = `aria-describedby="sheetKind sheetPriceNote${notes.length ? " sheetNotes" : ""}"`;
  const primary = res.kind === "not-ready"
    ? `<button class="btn btn--accent btn--block" type="button" data-act="close" ${desc}>Close</button>`
    : res.priceCents == null
      ? `<button class="btn btn--accent btn--block" type="button" data-act="find" ${desc}>${icon("search")}<span>Search by name</span></button>`
      : res.kind === "store-label" && res.label.needsConfirm
        ? `<button class="btn btn--accent btn--block" type="button" data-act="add" autofocus ${desc}>${icon("check")}<span>Confirm <span id="addTotal" class="counting">${money(lineTotal(res))}</span> and add to tally</span></button>`
        : `<button class="btn btn--accent btn--block" type="button" data-act="add" autofocus ${desc}>${icon("receipt")}<span>Add <span id="addTotal" class="counting">${money(lineTotal(res))}</span> to tally</span></button>`;
  // the second row says where the sheet leads: the next scan, back to the results, or (from home) the scanner alone
  const secondary = state.source === "scan"
    ? `<button class="btn btn--ghost" type="button" data-act="scan">${icon("scan")}<span>Scan next</span></button><button class="btn btn--ghost" type="button" data-act="close">Done scanning</button>`
    : state.source === "search"
      ? `<button class="btn btn--ghost" type="button" data-act="scan">${icon("scan")}<span>Scan</span></button><button class="btn btn--ghost" type="button" data-act="close">Back to results</button>`
      : `<button class="btn btn--ghost btn--block" type="button" data-act="scan">${icon("scan")}<span>Scan a barcode</span></button>`;

  // a remembered match can be corrected: the name search again, and the next item added replaces it
  const again = res.learned ? `<button class="btn btn--ghost btn--block" type="button" data-act="find">${icon("search")}<span>Not this item? Search by name</span></button>` : "";
  const also = res.others?.length ? `<section class="also"><h2 class="h2">Other items with this barcode</h2><ol class="list list--compact">${res.others.map((o) => rowHtml(o, [])).join("")}</ol></section>` : "";
  const basisCard = res.kind === "equivalent" && res.equiv.basis ? basisCardHtml("Priced from this Walmart item", res.equiv.basis)
    : res.kind === "plu" && res.item ? basisCardHtml("Priced from this Walmart item", res.item) : "";

  const facts = [];
  if (res.gtin && res.kind !== "not-ready") facts.push(["Barcode", `<span class="mono">${esc(formatGtin(res.gtin))}</span>`]);
  if (it) {
    facts.push(["Walmart item number", esc(String(it.id))]);
    if (it.catName) facts.push(["Department", esc(it.catName)]);
  }

  return `<div class="sheet-inner">
    <div class="sheet-top"><div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><span class="kind" id="sheetKind" data-kind="${esc(res.kind)}">${esc(label)}</span><button class="x-btn" type="button" aria-label="Close">${icon("x")}</button></div></div>
    <div class="sheet-body"><div class="sheet-main">
    <div class="price-block">${priceBlockHtml(res)}</div>
    <p class="price-note" id="sheetPriceNote">${checkedHtml}</p>
    <h2 class="item-title" id="sheetTitle">${title}</h2>
    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="t">${esc(c)}</span>`).join("")}</div>` : ""}
    ${notes.length ? `<div id="sheetNotes">${notes.map((n) => `<p class="note${n.tone ? ` note--${n.tone}` : ""}">${n.tone === "warn" ? icon("alert", "ico note-ico") : n.tone === "equiv" ? icon("info", "ico note-ico") : ""}<span>${esc(n.text)}</span></p>`).join("")}</div>` : ""}
    ${liveRow}
    </div><div class="sheet-side">
    ${packSeg}
    ${stepper}
    <div class="actions">${primary}${secondary}${again}</div>
    </div></div>
    ${basisCard}${also}<div class="sizes-slot">${sizesHtml(res)}</div>
    ${facts.length ? `<ul class="facts">${facts.map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("")}</ul>` : ""}
  </div>`;
}

// the same product in its other sizes and counts (a single bar, the 8, 16 and 40 count boxes), from the worker after the
// sheet opens, so a box can be priced against its single and the other way round
function sizesHtml(res) {
  const rows = res.sizes || [];
  return rows.length ? `<section class="also"><h2 class="h2">Other sizes</h2><ol class="list list--compact">${rows.map((o) => rowHtml(o, [])).join("")}</ol></section>` : "";
}
async function loadSizes(res) {
  const it = res.item;
  if (res.sizes || !it || (res.kind !== "exact" && res.kind !== "closest" && res.kind !== "live")) return;
  const rows = await db.sizes(it.rank).catch(() => null);
  if (!rows?.length || state.sheetRes !== res || !el.sheet.open) return;
  res.sizes = rows;
  const slot = el.sheet.querySelector(".sizes-slot");
  if (!slot) return;
  slot.innerHTML = sizesHtml(res);
  slot.querySelectorAll("[data-rank]").forEach((b) => b.addEventListener("click", () => openInSheet(Number(b.dataset.rank))));
}
async function openInSheet(rank) {
  const item = await db.item(rank);
  if (item) { const r = fromItem(item); state.qty = 1; rerenderSheet(r); liveCheck(r).catch(() => {}); }
}

function boldTitle(item) {
  const { pre, brand, rest } = splitTitle(item);
  return brand ? `${esc(pre)}<b>${esc(brand)}</b>${esc(rest)}` : esc(rest);
}
function basisCardHtml(heading, item) {
  return `<section class="also"><h2 class="h2">${esc(heading)}</h2><button class="basis-card" type="button" data-rank="${item.rank}"><span><span class="name">${boldTitle(item)}</span><span class="sub">${esc([sizeText(item), item.pack > 1 ? `Pack of ${item.pack}` : ""].filter(Boolean).join(" · ") || item.catName || "")}</span></span><span class="price">${money(item.priceCents)}${item.basis === "lb" ? "<small>per lb</small>" : ""}</span></button></section>`;
}

function openResolution(res, { source = "search" } = {}) {
  const t0 = performance.now();
  state.sheetRes = res; state.source = source; state.qty = 1;
  if (!el.sheet.open) state.sheetOpener = document.activeElement;   // focus returns here when the sheet closes
  modals.open(el.sheet, sheetHtml(res));
  wireSheet(el.sheet, res);
  pushRecent(res);
  requestAnimationFrame(() => perf.opens.push({ kind: res.kind, source, ms: Math.round((performance.now() - t0) * 10) / 10 }));
  if (res.priceCents != null) haptic(8);
  liveCheck(res).catch(() => {});
  loadSizes(res).catch(() => {});
}
function rerenderSheet(res) {
  state.sheetRes = res;
  setDialogHtml(el.sheet, sheetHtml(res));
  el.sheet.querySelector(".x-btn")?.addEventListener("click", () => modals.close(el.sheet));
  wireSheet(el.sheet, res);
  el.sheet.querySelector(".sheet-inner").scrollTop = 0;
  loadSizes(res).catch(() => {});
}
function refreshPrice(dlg, res) {
  const pb = dlg.querySelector(".price-block");
  if (pb) pb.innerHTML = priceBlockHtml(res);
  // the button's visible words carry the new total, so its accessible name follows on its own
  const tot = dlg.querySelector("#addTotal"); if (tot) tot.textContent = money(lineTotal(res));
}

function wireSheet(dlg, res) {
  dlg.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const step = Number(b.dataset.step);
    const min = res.unit === "lb" ? 0.25 : 1, max = res.unit === "lb" ? 200 : 99;
    state.qty = Math.min(max, Math.max(min, Math.round((state.qty + step) * 100) / 100));
    const v = dlg.querySelector("#qtyVal"); if (v) v.textContent = res.unit === "lb" ? fmtNum(state.qty) : String(state.qty);
    const small = v?.nextElementSibling; if (small && res.unit !== "lb") small.textContent = state.qty === 1 ? "item" : "items";
    refreshPrice(dlg, res);
    haptic(5);
  }));
  dlg.querySelectorAll("[data-pack]").forEach((b) => b.addEventListener("click", () => {
    // from the price the sheet holds now (a live price the volunteer adopted included), never the price it was drawn with
    res.packOne = b.dataset.pack === "one";
    res.packListing = b.dataset.pack === "listing";
    res.unitCents = res.packOne ? Math.round(res.priceCents / piecesOf(res.item)) : res.packListing && res.listing ? res.listing.cents : res.priceCents;
    dlg.querySelectorAll("[data-pack]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    refreshPrice(dlg, res);
    haptic(5);
  }));
  dlg.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    const act = b.dataset.act;
    if (act === "add") { addToTally(res); if (state.source !== "scan") { el.q.value = ""; el.clearBtn.hidden = true; state.query = ""; showHome(); } modals.close(dlg); }
    else if (act === "scan") { if (!state.scanOpen) state.openScannerAfterSheet = true; modals.close(dlg); }
    else if (act === "find") {
      if (state.scanOpen) state.closeScannerAfterSheet = true;
      state.focusSearchAfterSheet = true;
      // an unknown or remembered barcode: the item added from this search is remembered for it; a barcode under a listed
      // store's prefix starts the search with that brand, so Walmart's own brand ranks first for whatever is typed next
      el.q.value = res.kind === "unknown" && res.store ? `${res.store.brand} ` : ""; state.query = el.q.value; el.clearBtn.hidden = !el.q.value;
      showHome(); el.q.placeholder = "Name and size"; modals.close(dlg);
      // after showHome (which forgets it): the item added from this search, within a few minutes, is remembered for the barcode
      state.learnFor = (res.kind === "unknown" || res.learned) && res.gtin && !res.badDigits && !res.noPrice ? { gtin: res.gtin, at: Date.now() } : null;
    }
    else if (act === "close") { if (state.scanOpen && state.source === "scan") state.closeScannerAfterSheet = true; modals.close(dlg); }
  }));
  dlg.querySelectorAll("[data-rank]").forEach((b) => b.addEventListener("click", () => openInSheet(Number(b.dataset.rank))));
}
el.sheet.addEventListener("closed", () => {
  if (state.closeScannerAfterSheet) { state.closeScannerAfterSheet = false; closeScanner(); }
  else if (state.openScannerAfterSheet) { state.openScannerAfterSheet = false; openScanner(); return; }
  else if (state.scanOpen) { if (el.scanTypeForm.hidden) resumeScan(); return; }
  if (state.focusSearchAfterSheet && state.scanOpen) { state.focusSearchAfterSheet = false; state.focusSearchAfterScanner = true; }   // the page is inert until the scanner closes
  else if (state.focusSearchAfterSheet) { state.focusSearchAfterSheet = false; el.q.focus({ preventScroll: true }); }
  else if (!state.scanOpen) restoreFocus(state.sheetOpener);
  state.sheetOpener = null;
  maybeApplyPending();
});
/** Focus goes back to what opened a layer when it is still on screen; otherwise to the page heading (never the search
 * box, which would raise the keyboard uninvited). */
function restoreFocus(node) {
  // a Recent row is re-rendered when its item moves to the top: the newest row is where it went
  if (node && !node.isConnected && node.matches?.("[data-recent]")) node = el.recentList.querySelector("[data-recent='0']");
  const ok = node && node !== document.body && node !== el.q && node.isConnected && node.getClientRects().length && !node.closest("[inert], [hidden]");
  (ok ? node : el.pageTitle).focus({ preventScroll: true });
}
// the tally or settings opened over the scanner (a toast's View, the header): the camera rests until it closes
for (const dlg of [el.tallySheet, el.settings]) {
  dlg.addEventListener("closed", () => { if (state.scanOpen && !el.sheet.open && el.scanTypeForm.hidden) resumeScan(); maybeApplyPending(); });
}

// ------------------------------------------------------------------ live Walmart check (public, rate-limited Worker route; no token in the client)
const liveSource = (j) => (j?.priceSource === "store" ? storeLabel() : "Walmart.com");
async function liveCheck(res) {
  const row = el.sheet.querySelector(".live-row");
  if (!row || !LIVE_URL || !prefs.live || !res.gtin) return;
  if (!navigator.onLine) { row.hidden = false; row.dataset.state = "off"; row.innerHTML = `${icon("wifi-off")}<span>Offline. Showing the saved price.</span>`; return; }
  row.hidden = false; row.dataset.state = "checking";
  row.innerHTML = `${icon("refresh")}<span>Checking the current Walmart price…</span>`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
  const unavailable = () => { row.dataset.state = "error"; row.innerHTML = `${icon("info")}<span>Live price check unavailable. Showing the saved price.</span>`; };
  try {
    const r = await fetch(`${LIVE_URL}/v1/price/${res.gtin}`, { signal: ctrl.signal, headers: { accept: "application/json" }, cache: "no-store" });
    clearTimeout(timer);
    if (state.sheetRes !== res || !el.sheet.open) return;
    if (r.status === 429) { row.dataset.state = "error"; row.innerHTML = `${icon("info")}<span>Live price check unavailable. Showing the saved price.</span>`; return; }
    const j = await r.json().catch(() => null);
    if (r.status >= 500 || !j) { unavailable(); return; }
    if (!r.ok || !j.ok) {
      if (j?.reason === "not found" || j?.reason === "not sold by walmart") { row.dataset.state = "none"; row.innerHTML = `${icon("info")}<span>Walmart.com has no current price for this barcode.</span>`; }
      else unavailable();
      return;
    }
    // several listings can share a barcode: compare with the one on screen when the route lists them, else with a plain
    // listing before a "(N pack)" bundle; a bundle's price is read as its count times one unit (resolve.liveUnitCents)
    const listings = j.listings || [];
    const listing = listings.find((l) => res.item && String(l.itemId) === String(res.item.id)) || listings.find((l) => !packListingOf(l.name)) || j;
    const live = liveUnitCents(listing);
    if (!Number.isFinite(live)) throw new Error("bad price");
    const when = j.checkedAt ? `at ${fmtTime(j.checkedAt)}` : "today";
    const src = liveSource(j);
    // the same sanity the pipeline applies to saved prices: a feed error never reaches a tally
    const verdict = livePlausible(live, res.kind === "unknown" ? null : res.priceCents, db.manifest?.priceCeiling || undefined);
    if (verdict !== "ok") {
      row.dataset.state = "none";
      row.innerHTML = `${icon("info")}<span>${esc(src)} currently lists <b>${money(live)}</b>, which ${verdict === "far" ? "differs widely from the saved price" : "is outside the range this price list covers"}. ${res.kind === "unknown" ? "Search by name instead." : "The saved price is kept."}</span>`;
      return;
    }
    if (res.kind === "unknown") {
      // the saved database didn't know it, Walmart does: show the live listing as the result
      const liveName = (packListingOf(listing.name || j.name)?.name) || listing.name || j.name || "Walmart item";
      const lr = { ...res, kind: "live", priceCents: live, name: liveName, brand: j.brand || "", title: [j.brand, liveName].filter(Boolean).join(" "), live: j, key: `v:${res.gtin}` };
      state.qty = 1;
      rerenderSheet(lr);
      const r2 = el.sheet.querySelector(".live-row"); if (r2) { r2.hidden = false; r2.dataset.state = "ok"; r2.innerHTML = `${icon("bolt")}<span>Found at ${esc(src)}, checked ${when}${j.stock ? ` · ${esc(j.stock)}` : ""}</span>`; }
      pushRecent(lr); haptic(8);
      return;
    }
    const diff = live - res.priceCents;
    row.dataset.state = "ok";
    if (diff === 0) row.innerHTML = `${icon("bolt")}<span>${esc(src)} ${when}: <b>${money(live)}</b> · Same as the saved price</span>`;
    else {
      row.innerHTML = `${icon("bolt")}<span>${esc(src)} ${when}: <b>${money(live)}</b></span><span class="delta ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}</span><button class="btn btn--ghost btn--sm" type="button">Use this price</button>`;
      row.querySelector("button").addEventListener("click", () => {
        res.priceCents = live; res.livePrice = live; res.live = j;
        if (res.packOne && piecesOf(res.item) > 1) res.unitCents = Math.round(live / piecesOf(res.item));
        else if (res.packListing && res.listing) { res.listing = { ...res.listing, cents: live * res.listing.n }; res.unitCents = res.listing.cents; }
        else res.unitCents = live;
        refreshPrice(el.sheet, res);
        const pn = el.sheet.querySelector(".price-note"); if (pn) pn.textContent = `${src} price, checked ${when}`;
        row.innerHTML = `${icon("check")}<span>Using the ${esc(src)} price, <b>${money(live)}</b></span>`;
      });
    }
  } catch {
    clearTimeout(timer);
    if (state.sheetRes !== res) return;
    unavailable();
  }
}

// ------------------------------------------------------------------ tally
const tallyCount = () => tally.reduce((a, t) => a + (t.unit === "lb" ? 1 : t.qty), 0);
const tallyTotal = () => tally.reduce((a, t) => a + t.cents, 0);
const itemsText = (n) => `${n} ${n === 1 ? "item" : "items"}`;
function renderTallyPill() {
  const count = tallyCount(), total = tallyTotal();
  // the header pill is for the results screen; home shows the tally card itself
  el.tallyBtn.hidden = tally.length === 0 || !el.home.hidden;
  el.tallyCount.textContent = itemsText(count);
  el.tallyTotal.textContent = money(total);
  el.tallyCardTotal.textContent = money(total);
  el.tallyCardSub.textContent = tally.length ? itemsText(count) : "No items added";
  el.tallyCard.dataset.empty = String(tally.length === 0);
}
function saveTally() { writeJson(TALLY_KEY, tally); renderTallyPill(); }
function addToTally(res) {
  const cents = lineTotal(res);
  const base = res.kind === "exact" || res.kind === "closest" ? titleOf(res.item) : res.title;
  const title = res.packOne && piecesOf(res.item) > 1 ? `${base} (1 of ${piecesOf(res.item)})` : res.packListing && res.listing ? `${base} (pack of ${res.listing.n})` : base;
  const line = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, unitCents: unitCents(res), qty: state.qty, unit: res.unit, kind: res.kind, cents, at: Date.now(), key: res.key, ...(db.manifest?.fixture ? { sample: true } : {}) };
  tally.push(line);
  saveTally();
  const lf = state.learnFor; state.learnFor = null;
  if (lf && Date.now() - lf.at < LEARN_WINDOW_MS && res.item?.upc && (res.kind === "exact" || res.kind === "closest" || res.kind === "equivalent") && res.gtin !== lf.gtin) {
    const before = learned[lf.gtin] || null;
    rememberMatch(lf.gtin, res.item);
    toast(`Remembered barcode ${formatGtin(lf.gtin)} as this item`, { action: "Undo", onAction: () => { if (before) learned[lf.gtin] = before; else delete learned[lf.gtin]; writeJson(LEARNED_KEY, learned); shareMatch(lf.gtin, res.item, true); }, ms: 7000, page: true });
  }
  haptic(15);
  // an accidental add is undone in one tap
  toast(`Added ${money(cents)} · Tally total ${money(tallyTotal())}`, { action: "Undo", onAction: () => { tally = tally.filter((t) => t.id !== line.id); saveTally(); }, ms: 4000, page: true });
}
function tallyHtml({ confirmClear = false } = {}) {
  const total = tallyTotal();
  const rows = tally.slice().reverse().map((t) => `<li><span class="tn">${esc(t.title)}<small>${t.unit === "lb" ? `${fmtNum(t.qty)} lb × ${money(t.unitCents)}` : `${t.qty} × ${money(t.unitCents)}`} · <span class="nw">${esc(kindLabel({ kind: t.kind }))}</span></small></span><span class="tp">${money(t.cents)}</span><button class="x-btn" type="button" data-remove="${t.id}" aria-label="Remove ${esc(t.title)}">${icon("trash")}</button></li>`).join("");
  const actions = confirmClear
    ? `<div class="confirm-row" role="group" aria-labelledby="clearQ"><p id="clearQ">Clear all ${itemsText(tallyCount())} from the tally? This cannot be undone.</p><div class="actions"><button class="btn btn--ghost" type="button" data-act="keep">Cancel</button><button class="btn btn--danger-solid" type="button" data-act="clear-yes">${icon("trash")}<span>Clear tally</span></button></div></div>`
    : `<div class="actions"><button class="btn btn--accent" type="button" data-act="share" ${tally.length ? "" : "disabled"}>${icon("share")}<span>Share</span></button><button class="btn btn--danger" type="button" data-act="clear" ${tally.length ? "" : "disabled"}>${icon("trash")}<span>Clear</span></button></div>`;
  return `<div class="sheet-inner"><div class="sheet-top"><div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 class="sheet-title" id="tallyTitle">Donation tally</h2><button class="x-btn" type="button" aria-label="Close">${icon("x")}</button></div></div>
    ${tally.length ? `<ul class="tally-list">${rows}</ul>` : `<p class="empty">No items added. Open an item and tap <b>Add to tally</b>.</p>`}
    <div class="tally-total-row"><span>${itemsText(tallyCount())}</span><b class="counting">${money(total)}</b></div>
    ${actions}
    <p class="fine">Saved on this phone until cleared. Totals use the price list updated ${esc(fmtDate(priceDate(), true) || "most recently")}.</p>
    <p class="verse">1 John 4:19</p>
  </div>`;
}
function openTally() { modals.open(el.tallySheet, tallyHtml()); }
/** Re-render the open tally in place (same scroll position), e.g. after a line is removed or put back. */
function refreshTally(opts) {
  if (!el.tallySheet.open) return;
  const y = el.tallySheet.querySelector(".sheet-inner")?.scrollTop || 0;
  setDialogHtml(el.tallySheet, tallyHtml(opts)); el.tallySheet.querySelector(".sheet-inner").scrollTop = y;
  el.tallySheet.querySelector(".x-btn")?.addEventListener("click", () => modals.close(el.tallySheet));
}
el.tallySheet.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    const i = tally.findIndex((t) => t.id === rm.dataset.remove); if (i < 0) return;
    const [line] = tally.splice(i, 1);
    saveTally(); refreshTally(); haptic(5);
    // removing is one tap, so it is undone in one tap too
    toast(`Removed ${line.title}`, { action: "Undo", onAction: () => { tally.splice(Math.min(i, tally.length), 0, line); saveTally(); refreshTally(); }, ms: 5000, iconName: "trash" });
    return;
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "clear") { refreshTally({ confirmClear: true }); el.tallySheet.querySelector("[data-act=keep]")?.focus({ preventScroll: true }); }
  else if (act === "keep") { refreshTally(); el.tallySheet.querySelector("[data-act=clear]")?.focus({ preventScroll: true }); }
  else if (act === "clear-yes") { tally = []; saveTally(); modals.close(el.tallySheet); toast("Tally cleared", { page: true }); }
  else if (act === "share") shareTally();
});
async function shareTally() {
  const total = tallyTotal();
  const lines = tally.map((t) => `${t.unit === "lb" ? `${fmtNum(t.qty)} lb` : `${t.qty}×`} ${t.title} — ${money(t.cents)}`);
  const text = `Strongsville Emergency Food Bank · Donation value · ${new Date().toLocaleDateString()}\n${lines.join("\n")}\nTotal: ${money(total)} (${itemsText(tallyCount())})\nPrice list updated ${fmtDate(priceDate(), true)}\n1 John 4:19`;
  try {
    if (navigator.share) await navigator.share({ title: "Donation value", text });
    else { await navigator.clipboard.writeText(text); toast("Tally copied to the clipboard"); }
  } catch (err) { if (err?.name !== "AbortError") { try { await navigator.clipboard.writeText(text); toast("Tally copied to the clipboard"); } catch { toast("Sharing is not available on this device", { iconName: "info" }); } } }
}
el.tallyBtn.addEventListener("click", openTally);
el.tallyCard.addEventListener("click", openTally);
renderTallyPill();

// ------------------------------------------------------------------ recent (reopened by barcode, never by a snapshot's row number)
function pushRecent(res) {
  if (res.priceCents == null) return;
  const entry = {
    key: res.key, kind: res.kind, title: res.kind === "exact" || res.kind === "closest" ? titleOf(res.item) : res.title, priceCents: res.priceCents, unit: res.unit,
    code: res.code || null, id: res.item?.id ?? null, rank: res.item?.rank ?? null, version: db.version, brand: res.brand || null, name: res.name || null, at: Date.now(),
    ...(db.manifest?.fixture ? { sample: true } : {}),
  };
  recent = [entry, ...recent.filter((r) => r.key !== res.key)].slice(0, 8);
  writeJson(RECENT_KEY, recent);
  renderRecent();
}
/** Sample (fixture) prices never mix with real ones: when the real snapshot arrives, tally lines and recents priced from
 * the sample go, and the volunteer is told once. */
function dropSampleLines() {
  if (!db.manifest || db.manifest.fixture) return;
  const t = tally.filter((x) => !x.sample), r = recent.filter((x) => !x.sample);
  if (t.length === tally.length && r.length === recent.length) return;
  tally = t; recent = r; writeJson(TALLY_KEY, tally); writeJson(RECENT_KEY, recent);
  renderTallyPill(); renderRecent();
  toast("The price list was replaced. Items priced from the earlier list were removed from the tally and Recent.", { iconName: "info", ms: 7000 });
}
/** Rows that can only be reopened by row number belong to one snapshot: drop them when the snapshot changes. */
function pruneRecent() {
  const before = recent.length;
  recent = recent.filter((r) => r.code || r.version === db.version);
  if (recent.length !== before) { writeJson(RECENT_KEY, recent); renderRecent(); }
}
/** A Recent row shows today's price: entries saved under an older price list are looked up again by barcode when a new
 * list opens (or more departments join), so a row never shows last month's price and opens another. */
let refreshingRecent = null, refreshAgain = false;
function refreshRecent() {
  if (refreshingRecent) { refreshAgain = true; return refreshingRecent; }   // a new department arrived mid-run: run once more after
  if (!db.version) return null;
  refreshingRecent = (async () => {
    let changed = false;
    for (const r of recent) {
      if (!r.code || r.version === db.version) continue;
      const res = await resolveCode(db, r.code, undefined, resolveOpts({ preferId: r.id })).catch(() => null);
      if (!res || res.priceCents == null || res.kind === "unknown" || res.kind === "not-ready") continue;
      // the key follows the kind (a live entry the list now knows becomes an exact one), so reopening it never adds a twin
      Object.assign(r, { key: res.key, kind: res.kind, priceCents: res.priceCents, unit: res.unit, title: res.kind === "exact" || res.kind === "closest" ? titleOf(res.item) : res.title, id: res.item?.id ?? r.id, rank: res.item?.rank ?? r.rank, version: db.version });
      changed = true;
    }
    if (changed) {
      const seen = new Set();
      recent = recent.filter((r) => (seen.has(r.key) ? false : seen.add(r.key)));
      writeJson(RECENT_KEY, recent); renderRecent();
    }
  })().finally(() => { refreshingRecent = null; if (refreshAgain) { refreshAgain = false; refreshRecent(); } });
  return refreshingRecent;
}
let recentDrawn = "";
function renderRecent() {
  el.recent.hidden = recent.length === 0;
  el.homeEmpty.hidden = recent.length > 0;
  const sig = JSON.stringify(recent.slice(0, 4));
  if (sig === recentDrawn) return;   // the same four rows: nothing to redraw (a return to home while typing)
  recentDrawn = sig;
  // each row slides left to uncover Remove (a swipe, or the keyboard: the button sits before the row and reveals it on focus)
  el.recentList.innerHTML = recent.slice(0, 4).map((r, i) => `<li class="swipe"><button class="swipe-remove" type="button" data-recent-remove="${i}" aria-label="Remove ${esc(r.title)} from Recent">${icon("trash")}<span>Remove</span></button><div class="swipe-face"><button class="row" type="button" data-recent="${i}"><span class="name">${esc(r.title)}</span><span class="price">${money(r.priceCents)}${r.unit === "lb" ? "<small>per lb</small>" : ""}</span><span class="meta"><span class="tag">${esc(kindLabel({ kind: r.kind }))}</span></span></button></div></li>`).join("");
}
// ---- swipe left on a Recent row to uncover Remove (volunteers' ask, 2026-10-19); a tap on an open row closes it again
const SWIPE_W = 96, SWIPE_OPEN = 40, SWIPE_START = 8;
let swipe = null;              // the gesture in progress: { li, row, x0, y0, dx, moved, startOpen }
let swipeClickBlock = false;   // the click that follows a swipe is not a tap on the row
const swipeOpenRows = () => [...el.recentList.querySelectorAll(".swipe[data-open]")];
function swipeSet(li, dx, animate = true) { const face = li.querySelector(".swipe-face"); face.style.transition = animate ? "" : "none"; face.style.transform = dx ? `translateX(${dx}px)` : ""; }
function swipeClose(li) { if (!li) return; delete li.dataset.open; swipeSet(li, 0); }
// Clear takes every Recent row off the home screen at once; low stakes, so an Undo toast rather than a confirmation
document.getElementById("recentClear").addEventListener("click", () => {
  if (!recent.length) return;
  const kept = recent; recent = []; writeJson(RECENT_KEY, recent); renderRecent(); haptic(5);
  toast(`Cleared Recent (${itemsText(kept.length)})`, { action: "Undo", onAction: () => { recent = kept; writeJson(RECENT_KEY, recent); renderRecent(); }, ms: 5000, iconName: "trash", page: true });
});
el.recentList.addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".row"); const li = row?.closest(".swipe");
  if (!li || e.button !== 0) return;
  swipe = { li, row, x0: e.clientX, y0: e.clientY, dx: 0, moved: false, startOpen: li.dataset.open === "1" };
});
el.recentList.addEventListener("pointermove", (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
  if (!swipe.moved) {
    if (Math.abs(dx) < SWIPE_START || Math.abs(dx) < Math.abs(dy)) return;      // a scroll, or not yet a swipe
    swipe.moved = true; swipe.li.dataset.swiping = "1"; try { swipe.row.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    for (const other of swipeOpenRows()) if (other !== swipe.li) swipeClose(other);
  }
  e.preventDefault();
  const base = swipe.startOpen ? -SWIPE_W : 0;
  swipe.dx = Math.max(-SWIPE_W, Math.min(0, base + dx));
  swipeSet(swipe.li, swipe.dx, false);
});
function swipeEnd(e) {
  if (!swipe) return;
  const { li, row, dx, moved } = swipe; swipe = null;
  delete li.dataset.swiping;
  if (!moved) return;
  swipeClickBlock = true; setTimeout(() => { swipeClickBlock = false; }, 350);
  try { row.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (dx <= -SWIPE_OPEN) { li.dataset.open = "1"; swipeSet(li, -SWIPE_W); haptic(5); }
  else swipeClose(li);
}
el.recentList.addEventListener("pointerup", swipeEnd);
el.recentList.addEventListener("pointercancel", swipeEnd);
el.recentList.addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-recent-remove]");
  if (rm) {
    const i = Number(rm.dataset.recentRemove); const r = recent[i]; if (!r) return;
    recent.splice(i, 1); writeJson(RECENT_KEY, recent); renderRecent(); haptic(5);
    toast(`Removed ${r.title} from Recent`, { action: "Undo", onAction: () => { recent.splice(Math.min(i, recent.length), 0, r); writeJson(RECENT_KEY, recent); renderRecent(); }, ms: 5000, iconName: "trash", page: true });
    return;
  }
  const b = e.target.closest("[data-recent]"); if (!b) return;
  if (swipeClickBlock) return;                                               // the end of a swipe, not a tap
  const open = swipeOpenRows();
  if (open.length) { for (const li of open) swipeClose(li); return; }        // a tap anywhere first closes an open row
  const r = recent[Number(b.dataset.recent)]; if (!r) return;
  if (r.kind === "live" && r.code) {
    // the saved database never knew this one: show what Walmart said, then refresh it live when online
    openResolution({ kind: "live", code: r.code, gtin: r.code, title: r.title, name: r.name || r.title, brand: r.brand || "", priceCents: r.priceCents, unit: r.unit, key: r.key, live: null }, { source: "recent" });
    return;
  }
  if (r.code) { openCode(r.code, { source: "recent", preferId: r.id }); return; }
  if (r.rank != null && r.version === db.version) openRank(r.rank, { source: "recent" });
  else toast("This item is not in the current price list. Scan or search for it again.", { iconName: "info" });
});
renderRecent();
homeToTop();

// ------------------------------------------------------------------ settings
// What a volunteer can change (appearance, buzz, live check), what they need to know about the prices (date, source,
// whether the phone keeps them), the two actions (check for new prices, reset), and an About fold for everything else.
const sourceText = () => (db.manifest?.storePriced ? `${storeLabel()} shelf prices, otherwise Walmart.com` : "Walmart.com prices");
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
function settingsHtml() {
  const m = db.manifest;
  const seg = [["auto", "System"], ["light", "Light"], ["dark", "Dark"]].map(([t, l]) => `<button type="button" data-theme="${t}" aria-pressed="${prefs.theme === t}">${l}</button>`).join("");
  const notes = [];
  if (db.pendingUpdate) notes.push(`<p class="data-note">A newer price list (${esc(fmtDate(db.pendingUpdate.manifest?.priceDate, true))}) has been downloaded and will be applied when the app is not in use.</p>`);
  if (db.skipped?.length) notes.push(`<p class="data-note">Not stored on this phone (memory limit): ${esc(db.skipped.map((s) => s.name).join(", "))}. A search by name does not find those items on this phone; a scanned barcode from them is checked live when online.</p>`);
  notes.push(`<p class="data-note" id="storageNote"${state.persisted === false ? "" : " hidden"}>The phone may clear saved prices to free space; they download again when online. Adding the app to the Home Screen keeps them.</p>`);
  // no price list open: the same words as the home card, plus the technical reason when there is one
  const st = priceStatus();
  const problem = state.dbErrorPlain ? state.dbError
    : [st.card?.sub === "Open Settings for details." ? "" : st.card?.sub, state.dbError && !state.dbErr?.storage ? `Details: ${state.dbError}` : ""].filter(Boolean).join(" ");
  const card = m && !state.workerError
    ? `<div class="data-head">${icon("check", "ico data-ico")}<div><h3 class="data-title">Prices from ${esc(fmtDate(priceDate(), "mid"))}</h3><p class="data-sub">${esc(sourceText())} · ${mb(db.installedBytes() || m.totalGzBytes)} saved on this phone</p></div></div>`
    : `<div class="data-head data-head--warn">${icon("info", "ico data-ico")}<div><h3 class="data-title">${esc(st.card?.title || "Loading the price list")}</h3><p class="data-sub">${esc(problem)}</p></div></div>`;
  const legend = [["exact", "Exact item", "Found in the Walmart price list by barcode or name"], ["store-label", "Store price label", "A store scale label (meat, deli, bakery) that carries its own price"],
    ["plu", "Produce code", "The four-digit sticker on produce, priced by the pound or each"], ["equivalent", "Equivalent value", "Not sold at Walmart, so priced at the closest Walmart item"],
    ["closest", "Closest match", "No item matched every word; check the type and size"], ["live", "Live Walmart price", "Not in the price list; current price from Walmart.com"]]
    .map(([k, l, t]) => `<li><span class="kind" data-kind="${k}">${l}</span><span>${t}</span></li>`).join("");
  // vibration exists only where the browser can vibrate (not Safari on iPhone): no switch that does nothing
  const canVibrate = typeof navigator.vibrate === "function";
  return `<div class="sheet-inner"><div class="sheet-top"><div class="grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 class="sheet-title" id="settingsTitle">Settings</h2><button class="x-btn" type="button" aria-label="Close">${icon("x")}</button></div></div>
    <div class="setting setting--seg"><div class="lab">Appearance</div><div class="seg" role="group" aria-label="Appearance">${seg}</div></div>
    ${canVibrate ? `<div class="setting"><div class="lab">Vibrate on scan<small>A short vibration when a barcode is read</small></div><button class="switch" type="button" role="switch" aria-checked="${prefs.haptics}" data-pref="haptics" aria-label="Vibrate on scan"></button></div>` : ""}
    ${LIVE_URL ? `<div class="setting"><div class="lab">Live price check<small>When online, compare a scanned item with Walmart's current price</small></div><button class="switch" type="button" role="switch" aria-checked="${prefs.live}" data-pref="live" aria-label="Live price check"></button></div>` : ""}
    <h2 class="h2">Prices</h2>
    <section class="data-card" aria-label="Price list">${card}${notes.join("")}
      <button class="btn btn--ghost btn--block" type="button" data-act="update">${icon("refresh")}<span>Check for new prices</span></button>
    </section>
    <h2 class="h2">How to use</h2>
    <ol class="howto">
      <li>Scan the barcode, or search by name and size.</li>
      <li>Check the item and price, then tap <b>Add to tally</b>.</li>
      <li>Share the tally once the donation is valued.</li>
    </ol>
    <button class="btn btn--ghost btn--block" type="button" data-act="tour">${icon("info")}<span>Replay the walkthrough</span></button>
    <details class="about">
      <summary><span>About</span>${icon("back", "ico chev")}</summary>
      <ul class="legend-list" aria-label="What the labels mean">${legend}</ul>
      <p class="fine">SFB Value is the donation valuation tool of the Strongsville Emergency Food Bank. Prices are the Strongsville Walmart Supercenter's shelf prices (8585 Pearl Rd) where Walmart reports one, otherwise Walmart.com prices; the note under each price says which. The price list is refreshed every month, and the store's shelf prices for food, household, personal care and health items about every four weeks; the app updates itself when online. Barcodes Walmart does not sell are identified with USDA FoodData Central Branded Foods data (U.S. Department of Agriculture, public domain) and Open Food Facts, Open Beauty Facts and Open Products Facts data (ODbL), and with the matches volunteers make by searching by name, shared between the food bank's phones. Barcode reading by zxing-cpp (Apache-2.0). Runs on iPhone (iOS 16.4 or later) and Android (Chrome 111 or later, Samsung Internet, Firefox); nothing leaves the phone except the live price check and the shared barcode matches (<a href="./privacy.html" target="_blank" rel="noopener">privacy</a>).</p>
      <p class="fine verse-full">“We love because he first loved us.” — 1 John 4:19</p>
      <p class="fine mono">Version ${esc(BUILD)}${m ? `<br>Price list ${esc(m.version)}` : ""}</p>
      <details class="diag"><summary>Diagnostics</summary><pre class="fine mono diag-log">${esc(diagnostics())}</pre><button class="btn btn--ghost btn--sm" type="button" data-act="copy-diag">Copy</button></details>
    </details>
    <div id="resetArea"><button class="btn btn--danger btn--block" type="button" data-act="reset">${icon("trash")}<span>Reset app data</span></button></div>
  </div>`;
}
/** What happened on this launch and the end of the previous one, for a report from the phone. */
function diagnostics() {
  const prev = readJson("sfb.boot.log", null);
  const now = db.log.slice(-25);
  const head = `${BUILD} · ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 90)} · ${standalone() ? "home screen" : "browser"} · ${navigator.onLine ? "online" : "offline"}`;
  return [head, ...now, ...(Array.isArray(prev) && prev.length && prev[prev.length - 1] !== now[now.length - 1] ? ["— previous launch —", ...prev.slice(-12)] : []), ...(vvTrace.length ? ["— keyboard —", ...vvTrace] : [])].join("\n");
}
function fillStorage() {
  db.persistenceStatus().then((p) => {
    state.persisted = p;
    const note = el.settings.querySelector("#storageNote"); if (note) note.hidden = p !== false;
  }).catch(() => {});
}
function openSettings() { modals.open(el.settings, settingsHtml()); fillStorage(); }
function refreshSettings() { const y = el.settings.querySelector(".sheet-inner")?.scrollTop || 0; setDialogHtml(el.settings, settingsHtml()); el.settings.querySelector(".sheet-inner").scrollTop = y; el.settings.querySelector(".x-btn")?.addEventListener("click", () => modals.close(el.settings)); fillStorage(); }
window.__sfb.refreshSettings = refreshSettings;   // the checks re-render Settings mid-drag
el.settings.addEventListener("click", async (e) => {
  if (e.target.closest("[data-act=copy-diag]")) { navigator.clipboard?.writeText(diagnostics()).then(() => toast("Diagnostics copied"), () => toast("Could not copy", { iconName: "info" })); return; }
  // the control itself, never an ancestor: <html data-theme> carries the chosen theme, so a bare [data-theme] matched
  // the page for every tap in Settings while Light or Dark was chosen, and nothing else in the sheet answered (F69)
  const th = e.target.closest("button[data-theme]");
  if (th) { prefs.theme = th.dataset.theme; writeJson(PREFS_KEY, prefs); applyTheme(); el.settings.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b === th))); return; }
  const sw = e.target.closest("[data-pref]");
  if (sw) { const k = sw.dataset.pref; prefs[k] = !prefs[k]; writeJson(PREFS_KEY, prefs); sw.setAttribute("aria-checked", String(prefs[k])); haptic(5); return; }
  const actBtn = e.target.closest("[data-act]"), act = actBtn?.dataset.act;
  if (act === "update") await checkNow(actBtn);
  else if (act === "tour") replayTour();
  else if (act === "reset") {
    // an in-app confirmation, not the browser's dialog
    const area = el.settings.querySelector("#resetArea");
    area.innerHTML = `<div class="confirm-row" role="group" aria-labelledby="resetQ"><p id="resetQ">Remove the saved prices, the tally, Recent and the barcode matches remembered on this phone? Prices download again when online.</p><div class="actions"><button class="btn btn--ghost" type="button" data-act="reset-no">Cancel</button><button class="btn btn--danger-solid" type="button" data-act="reset-yes">${icon("trash")}<span>Reset</span></button></div></div>`;
    area.querySelector("[data-act=reset-no]").focus({ preventScroll: true });
    area.scrollIntoView({ block: "nearest" });
  }
  else if (act === "reset-no") { refreshSettings(); el.settings.querySelector("[data-act=reset]")?.focus({ preventScroll: true }); }
  else if (act === "reset-yes") {
    await db.reset(); tally = []; recent = []; learned = {};
    for (const k of [TALLY_KEY, RECENT_KEY, PREFS_KEY, TOUR_KEY, LEARNED_KEY]) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
    location.reload();   // the app shell stays cached, so this works offline too
  }
});
el.settingsBtn.addEventListener("click", openSettings);
el.status.addEventListener("click", openSettings);
el.readyCard.addEventListener("click", () => { if (state.bootStuck && !db.version) retryBoot("tap"); else openSettings(); });

// ------------------------------------------------------------------ boot screen
// The launch image continues as #boot (index.html, app.css "boot screen") until the price list is open, so a launch is
// one picture that resolves into the app rather than a logo, then a header, then a list. It leaves at once when the
// home screen has something to say instead (a first download, offline, a problem) and never later than
// BOOT_SCREEN_MAX_MS; it stays at least BOOT_SCREEN_MIN_MS from navigation so a warm launch does not flash it.
// ?splash=1 keeps it up with its motion held (html[data-splash]): the launch-image renderer, and a preview on a phone.
const BOOT_SCREEN_MIN_MS = 650, BOOT_SCREEN_MAX_MS = 8000;
const bootScreen = $("boot");
const splashHeld = new URLSearchParams(location.search).get("splash") === "1";
if (splashHeld) document.documentElement.dataset.splash = "1";
// The bar is the real progress (owner, 2026-10-23: a bar that fills, so a stalled start can be seen for what it is):
// 40% is the launch image (the shell is up), 48% this script running, and the rest the price list's shards opening in
// the worker (the "load" progress events); it fills before the fade. Only forwards, never back.
const BOOT_FILL_SCRIPT = 0.48;
let bootFill = 0.4;
function setBootFill(f) {
  if (!bootScreen || splashHeld) return;
  f = Math.min(1, Math.max(bootFill, f));
  if (f === bootFill) return;
  bootFill = f; perf.boot.fill = Math.round(f * 100) / 100;
  (perf.boot.fills ||= []).push([Math.round(performance.now()), perf.boot.fill]);   // the bar's path, for the checks and a report
  bootScreen.style.setProperty("--boot-fill", `${(f * 100).toFixed(1)}%`);
}
setBootFill(BOOT_FILL_SCRIPT);
db.addEventListener("progress", (e) => { const d = e.detail; if (d.phase === "load" && d.total > 0) setBootFill(BOOT_FILL_SCRIPT + (0.97 - BOOT_FILL_SCRIPT) * Math.min(1, d.done / d.total)); });
let bootScreenClosing = false;
function closeBootScreen(why) {
  if (!bootScreen || bootScreenClosing || splashHeld) return;
  bootScreenClosing = true;   // the first reason wins; the fade itself waits out the minimum
  if (why === "ready") setBootFill(1);
  const fade = () => {
    // a timer can fire a fraction of a millisecond early by performance.now(): wait out the rest, so the minimum holds
    if (performance.now() < BOOT_SCREEN_MIN_MS) return setTimeout(fade, Math.ceil(BOOT_SCREEN_MIN_MS - performance.now()));
    bootScreen.classList.add("is-out");
    perf.boot.splashMs = Math.round(performance.now()); perf.boot.splashWhy = why;
    const gone = () => bootScreen.remove();
    bootScreen.addEventListener("transitionend", (e) => { if (e.target === bootScreen && e.propertyName === "opacity") gone(); });
    setTimeout(gone, 700);   // reduced motion (no transition), or an engine that never fires the event
  };
  setTimeout(fade, Math.max(0, BOOT_SCREEN_MIN_MS - performance.now()));
}
db.addEventListener("ready", () => closeBootScreen("ready"));
db.addEventListener("state", (e) => { if (e.detail.state !== "loading" && e.detail.state !== "ready") closeBootScreen(e.detail.state); });
setTimeout(() => closeBootScreen("timeout"), BOOT_SCREEN_MAX_MS);

// ------------------------------------------------------------------ boot watchdog
// The first open on the owner's iPhone (added to the Home Screen, which starts with its own empty storage on iOS) sat on
// "Loading" for over three minutes until Settings > Check for new prices was tapped, which worked at once. Whatever
// stalled, a spinner must never be the only thing on screen: after BOOT_STUCK_MS without a state change or a download
// step the card says so and offers a retry (and db.start() is tried again where that can help); after BOOT_RELOAD_MS
// the page reloads itself once (the shell is cached; downloaded files stay in Cache Storage), since a hung fetch or
// worker call cannot be cancelled from inside the page. Every step is in Settings > About > Diagnostics.
const BOOT_STUCK_MS = 30_000, BOOT_RELOAD_MS = 120_000, BOOT_RETRY_KEY = "sfb.bootRetry";
let bootActivity = performance.now();
const bootActive = () => { bootActivity = performance.now(); if (state.bootStuck) { state.bootStuck = false; renderStatus(); } };
db.addEventListener("state", bootActive);
db.addEventListener("progress", bootActive);
function retryBoot(how) {
  db.note(`retry (${how}) from state ${db.state}`);
  if (db.state === "idle" || db.state === "offline-empty" || db.state === "error") { bootActive(); db.start().catch(() => {}); return; }
  // downloading or loading and nothing moves: only a fresh page lets go of the hung request or worker call
  let n = 0; try { n = Number(sessionStorage.getItem(BOOT_RETRY_KEY) || 0); sessionStorage.setItem(BOOT_RETRY_KEY, String(n + 1)); } catch { /* none */ }
  if (how === "auto" && n >= 1) return;   // one automatic reload per session; after that the card waits for a tap
  location.reload();
}
setInterval(() => {
  if (db.version || state.unsupported || db.state === "error" || !navigator.onLine) return;
  const idle = performance.now() - bootActivity;
  if (idle >= BOOT_RELOAD_MS) { retryBoot("auto"); bootActivity = performance.now(); return; }
  if (idle >= BOOT_STUCK_MS && !state.bootStuck) {
    state.bootStuck = true; db.note(`no progress for ${Math.round(idle / 1000)} s in state ${db.state}`); renderStatus();
    if (db.state === "idle" || db.state === "offline-empty") db.start().catch(() => {});
  }
}, 5000);
// the logo is the way home: it clears the search instead of reloading the app (which would reopen the prices)
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  if (state.query || !el.results.hidden) { el.q.value = ""; el.clearBtn.hidden = true; state.query = ""; showHome(); }
  else el.main.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

// ------------------------------------------------------------------ layers: the walkthrough and the scanner
// One of them at a time covers the screen. While one is up, everything else in the page is inert (out of reach of a tap,
// Tab and VoiceOver) except the toasts, which stay usable above it, the screen-reader announcements and the dialogs
// (the browser handles a modal dialog itself). One function decides it from the state, so closing one layer can never
// release the screen while the other is still up.
function syncInert() {
  const layer = state.scanOpen ? el.scanner : state.tourOpen ? el.tour : null;
  for (const n of document.body.children) {
    if (n === el.toasts || n === el.statusLive || n.id === "resultsLive" || n.tagName === "DIALOG" || n.tagName === "SCRIPT") continue;
    n.inert = !!layer && n !== layer;
  }
}

// ------------------------------------------------------------------ walkthrough (first launch, and Settings › Replay the walkthrough)
// Four coach marks over the real screen: find the item, add it, review and share the tally, prices stay on the phone.
// Shown once per phone (TOUR_KEY); ?tour=1 forces it, ?tour=0 skips it (the measuring tools), and a launch from the
// Scan shortcut goes straight to the camera (the walkthrough waits for the next launch).
const TOUR_KEY = "sfb.tour";
const TOUR_STEPS = [
  { target: () => [el.searchForm, el.scanBtn], place: "above", live: true, title: "Find the item", text: "Tap <b>Scan</b> and point the camera at the barcode, or search by product name and size." },
  { demo: true, title: "Add it to the tally", text: "Confirm the item and its price, set the quantity, then tap <b>Add to tally</b>." },
  { target: () => [el.tallyCard], place: "below", title: "Review and share", text: "The tally totals every item added. Open it to review the lines, then tap <b>Share</b> to send the total." },
  { target: () => [el.status], place: "below", title: "Saved on this phone", text: "Prices work without a connection and update automatically when online. The date shows when the price list was last updated." },
];
const tour = { step: 0, returnTo: null, after: null, raf: 0, lastRect: "" };
const tourParam = new URLSearchParams(location.search).get("tour");
const tourWanted = () => tourParam === "1" || (tourParam !== "0" && !scanShortcut && !readJson(TOUR_KEY, null)?.done);
/** Settings › Replay the walkthrough: the Settings layer is swapped for the walkthrough in one step. Its history entry
 * becomes the walkthrough's, so nothing waits on a Back navigation and its popstate (the previous way, which worked in
 * every desktop engine but not on the owner's iPhone). */
function replayTour() {
  const entry = history.state?.modal === "settings" ? history.state : null;
  modals.close(el.settings, { fromPop: true, instant: true });
  if (entry) history.replaceState({ modal: "tour", n: entry.n }, "");
  openTour({ reuseEntry: !!entry });
}
function openTour({ reuseEntry = false } = {}) {
  if (state.tourOpen || state.scanOpen || anyModalOpen()) return;
  // the walkthrough points at the home screen: a search in progress gives way to it
  if (el.home.hidden) { el.q.value = ""; el.clearBtn.hidden = true; state.query = ""; showHome(); }
  state.tourOpen = true; tour.step = 0; tour.after = null;
  tour.returnTo = document.activeElement;
  window.scrollTo(0, 0);
  el.tour.hidden = false;
  syncInert();
  if (!reuseEntry) history.pushState({ modal: "tour", n: (history.state?.n || 0) + 1 }, "");
  renderTour();
  followTarget();
}
/** Take the walkthrough off the screen and give the page back (no history, no focus): the shared part of every close. */
function finishTour() {
  state.tourOpen = false;
  cancelAnimationFrame(tour.raf);
  writeJson(TOUR_KEY, { done: Date.now() });
  el.tour.hidden = true; el.tourCard.innerHTML = ""; el.tourSpot.hidden = true;
  syncInert();
}
/** Close; `after` runs once the close has finished (its history entry is gone), so it may open another layer. */
function closeTour({ fromPop = false, after = null } = {}) {
  if (!state.tourOpen) return;
  if (after) tour.after = after;
  if (!fromPop && history.state?.modal === "tour") { history.back(); return; }   // popstate finishes the close
  finishTour();
  const next = tour.after; tour.after = null;
  const back = tour.returnTo; tour.returnTo = null;
  if (next) { setTimeout(next, 0); return; }
  // focus goes back where it came from; after the first launch (nothing was focused) it lands on the page heading,
  // never on the search box, which would open the keyboard
  const target = back && back !== document.body && back.isConnected && !back.closest("[inert]") ? back : el.pageTitle;
  target.focus?.({ preventScroll: true });
}
function renderTour() {
  const s = TOUR_STEPS[tour.step], n = TOUR_STEPS.length, last = tour.step === n - 1;
  const dots = TOUR_STEPS.map((_, i) => `<i${i === tour.step ? ' class="is-on"' : ""}></i>`).join("");
  // step 2 shows the result sheet's own parts: the label, the price line and the real Add to tally button
  const demo = s.demo ? `<div class="tour-demo" aria-hidden="true"><div class="td-top"><span class="kind" data-kind="exact">Exact item</span><span class="td-bar td-bar--price"></span></div><span class="td-bar td-bar--title"></span><span class="td-bar td-bar--sub"></span><span class="td-btn">${icon("receipt")} Add to tally</span></div>` : "";
  el.tourCard.innerHTML = `<div class="tour-head"><p class="tour-step" id="tourStep">Step ${tour.step + 1} of ${n}</p><span class="tour-dots" aria-hidden="true">${dots}</span></div>
    <h2 class="tour-title" id="tourTitle">${s.title}</h2>
    <p class="tour-text" id="tourText">${s.text}</p>${demo}
    <div class="tour-nav">${last ? "<span></span>" : `<button class="btn btn--ghost tour-skip" type="button" data-tour="skip">Skip</button>`}
      <span class="tour-go">${tour.step ? `<button class="btn btn--ghost" type="button" data-tour="back" aria-label="Previous step">${icon("back")}</button>` : ""}<button class="btn btn--accent" type="button" data-tour="next">${last ? "Done" : "Next"}</button></span></div>`;
  tour.lastRect = "";
  placeTour();
  // the step itself takes the focus: a screen reader reads its title, step count and text; Tab reaches the buttons
  el.tourCard.focus({ preventScroll: true });
}
/** The rectangle around a step's subject (several elements: their union), or null when none of it is on screen. */
function tourTarget(s) {
  const els = (s.target?.() || []).filter((e) => e && !e.closest("[hidden]") && e.getClientRects().length);
  if (!els.length) return null;
  const rs = els.map((e) => e.getBoundingClientRect());
  const r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
  return r.right - r.left > 0 && r.bottom - r.top > 0 ? r : null;
}
/** The spotlight sits on the step's subject, kept inside the screen; the card sits on the free side of it (the other
 * side when it does not fit), and when neither side has room the card is centred on a dimmed screen instead of
 * covering what it points at. Coordinates are the layout viewport's (what fixed elements use). */
function placeTour() {
  if (!state.tourOpen) return;
  const s = TOUR_STEPS[tour.step], card = el.tourCard, spot = el.tourSpot;
  const r = tourTarget(s);
  const W = window.innerWidth, H = window.innerHeight, M = 12, pad = 6, space = 10;
  const insetT = safeTop(), insetB = parseFloat(getComputedStyle(el.dock).paddingBottom) - 10 || 0;
  card.style.top = card.style.bottom = card.style.maxHeight = "";
  const free = () => {
    el.tour.classList.add("is-free"); spot.hidden = true; card.classList.remove("is-placed");
    card.style.top = `${H / 2}px`;
    card.style.maxHeight = `${Math.max(160, H - insetT - insetB - 2 * M)}px`;
  };
  if (!r) { free(); return; }
  const box = { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad), r: Math.min(W - 4, r.right + pad), b: Math.min(H - 4, r.bottom + pad) };
  card.classList.add("is-placed");
  const ch = card.offsetHeight;
  const room = { above: box.t - space - (insetT + M), below: H - (box.b + space) - (insetB + M) };
  let side = s.place;
  if (ch > room[side]) { const other = side === "above" ? "below" : "above"; if (ch <= room[other]) side = other; else { free(); return; } }
  el.tour.classList.remove("is-free");
  spot.hidden = false;
  spot.style.cssText = `left:${box.l}px;top:${box.t}px;width:${box.r - box.l}px;height:${box.b - box.t}px`;
  if (side === "above") card.style.bottom = `${window.innerHeight - (box.t - space)}px`;
  else card.style.top = `${box.b + space}px`;
}
/** While the walkthrough is up, the spotlight follows its subject frame by frame (a banner appearing, a card changing
 * height, a rotation): one rectangle read per frame for a few seconds of use. */
function followTarget() {
  cancelAnimationFrame(tour.raf);
  const tick = () => {
    if (!state.tourOpen) return;
    const r = tourTarget(TOUR_STEPS[tour.step]);
    const key = `${r ? [r.left, r.top, r.right, r.bottom].map(Math.round).join(",") : "none"}|${window.innerWidth}x${window.innerHeight}`;
    if (key !== tour.lastRect) { tour.lastRect = key; placeTour(); }
    tour.raf = requestAnimationFrame(tick);
  };
  tour.raf = requestAnimationFrame(tick);
}
function tourGo(step) { tour.step = Math.max(0, Math.min(TOUR_STEPS.length - 1, step)); renderTour(); }
function tourNextStep() { if (tour.step >= TOUR_STEPS.length - 1) closeTour(); else tourGo(tour.step + 1); }
el.tourCard.addEventListener("click", (e) => {
  e.stopPropagation();   // a click on the card never counts as a tap outside it (a step re-render detaches the target)
  const act = e.target.closest("[data-tour]")?.dataset.tour; if (!act) return;
  if (act === "skip") closeTour();
  else if (act === "back") tourGo(tour.step - 1);
  else if (act === "next") tourNextStep();
});
// A tap outside the card moves on (owner, 2026-10-13). On the first step the spotlit controls are live: a tap on Scan
// opens the camera and a tap on the search box starts typing, ending the walkthrough the way the volunteer meant.
el.tour.addEventListener("click", (e) => {
  if (el.tourCard.contains(e.target)) return;
  const s = TOUR_STEPS[tour.step];
  if (s.live) {
    const hit = (node) => { const r = node.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
    // both act inside the tap itself (iOS raises the keyboard only for a focus made during the gesture): the walkthrough
    // is taken down at once, its history entry becomes the scanner's or is stepped back over
    if (hit(el.scanBtn)) {
      finishTour(); tour.returnTo = null;
      if (history.state?.modal === "tour") history.replaceState({ modal: "scanner", n: history.state.n }, "");
      openScanner({ reuseEntry: history.state?.modal === "scanner" });
      return;
    }
    if (hit(el.searchForm)) {
      finishTour(); tour.returnTo = null;
      el.q.focus();
      if (history.state?.modal === "tour") history.back();
      return;
    }
  }
  tourNextStep();
});
// Escape closes and Tab stays inside the card wherever the focus is (a tap on the card's text moves it to the page);
// the arrow keys page through the steps
document.addEventListener("keydown", (e) => {
  if (!state.tourOpen) return;
  if (e.key === "Escape") { e.preventDefault(); closeTour(); return; }
  if (e.key === "ArrowRight" && !e.target.closest?.("input")) { e.preventDefault(); tourNextStep(); return; }
  if (e.key === "ArrowLeft" && !e.target.closest?.("input") && tour.step > 0) { e.preventDefault(); tourGo(tour.step - 1); return; }
  if (e.key === "Tab") {
    const f = [...el.tourCard.querySelectorAll("button")];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    const next = i < 0 ? (e.shiftKey ? f[f.length - 1] : f[0]) : f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length];
    next.focus();
  }
});
window.__sfb.tour = { open: openTour, close: closeTour };

// ------------------------------------------------------------------ scanner
let scannerMod = null;
// Keep the camera ready (iPhone): iOS keeps no camera decision for a Home Screen web app and asks again about a minute
// after capture stops, so the camera is parked, not released, when the scanner closes or the app goes to the background
// (scanner.js parkCamera), for the length of a shift after the last scan (owner, 2026-10-23: four hours, no setting).
// Android and desktop browsers remember the grant, so they never hold the camera for this.
const KEEP_CAMERA_MS = 4 * 3600_000;
const keepCameraMs = () => (isIOS && navigator.mediaDevices?.getUserMedia ? KEEP_CAMERA_MS : 0);
async function openScanner({ reuseEntry = false } = {}) {
  if (state.scanOpen) return;
  if (state.tourOpen) { closeTour({ after: () => openScanner() }); return; }
  state.scanOpen = true;
  const gen = ++state.scanGen;
  el.scanner.hidden = false; el.scanner.classList.remove("is-hit");
  el.scanHint.textContent = "Center the barcode in the frame";
  el.scanTypeForm.hidden = true; el.scanTypeBtn.hidden = false; el.torchBtn.hidden = true; el.torchBtn.setAttribute("aria-pressed", "false");
  el.scanner.querySelector(".scan-denied")?.remove(); el.reticle.hidden = false;
  syncInert();
  if (!reuseEntry) history.pushState({ modal: "scanner", n: (history.state?.n || 0) + 1 }, "");
  el.scanClose.focus({ preventScroll: true });
  await startCamera(gen);
}
/** The flashlight button exists only while a camera that has one is running. */
function hideTorch() { el.torchBtn.hidden = true; el.torchBtn.setAttribute("aria-pressed", "false"); }
// A barcode that has not read after a few seconds is usually a small one (a water bottle's): the camera zooms in by
// itself where it can (nothing for the volunteer to find or tap; owner's call, 2026-10-20), and the hint says what helps.
// The zoom resets whenever scanning resumes, so the next item starts at the full view.
const SMALL_HELP_MS = 4000;
let smallHelpTimer = 0;
function armSmallHelp() {
  clearTimeout(smallHelpTimer);
  smallHelpTimer = setTimeout(async () => {
    const scan = state.scan;
    if (!state.scanOpen || !scan?.running || !el.scanTypeForm.hidden) return;
    if (scan.hasZoom && !scan.zoom && await scan.setZoom(true) && scan === state.scan && scan.running) el.scanHint.textContent = "Zoomed in for a small barcode. Hold it 4 to 6 inches away";
    else if (scan === state.scan && scan.running) el.scanHint.textContent = "Small barcode: hold it 4 to 6 inches away and keep it flat";
  }, SMALL_HELP_MS);
}
async function startCamera(gen) {
  hideTorch();   // a restart (back from the background) shows it again only when the new camera has a light
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) { scanDenied("The camera requires a secure (HTTPS) connection. Enter the barcode manually."); return; }
  try {
    scannerMod ||= await import("./scanner.js");
    const scan = await scannerMod.startScanner(el.video, el.overlay, (hit) => { if (gen === state.scanGen) onScanHit(hit); }, (info) => {
      if (gen !== state.scanGen) return;
      if (info.engine) state.engine = info.engine;
      if (info.reused != null) db.note(`camera ${info.reused ? "taken back (kept ready)" : "opened"}`);
      if (info.torch != null) el.torchBtn.hidden = !info.torch;
      if (info.fatal) { console.warn("scanner:", info.error); state.scan?.stop(); state.scan = null; scanDenied("The barcode reader could not start on this phone. Enter the barcode manually."); }
      else if (info.error) console.warn("scanner:", info.error);
    });
    if (gen !== state.scanGen || !state.scanOpen) { scan.stop(); return; }   // closed (or reopened) while the camera was starting
    state.scan?.stop();
    armSmallHelp();
    state.scan = scan;
    if (!el.scanTypeForm.hidden || el.sheet.open) scan.pause();
  } catch (err) {
    if (gen !== state.scanGen) return;
    console.warn("camera", err);
    // iPhone: a web app has no entry under Settings › Apps (owner, 2026-10-23: "SFB Value" is not there), and iOS keeps no
    // camera decision for a Home Screen web app at all (WebKit bug 327237), so the way back is simply to be asked again;
    // in a Safari tab the per-site setting behind the aA button is the one that lasts
    const denied = isIOS ? (standalone() ? "Camera access was declined. Close the app and open it again, then tap Allow when the camera is requested, or enter the barcode manually."
        : "Camera access was declined. Tap aA in the address bar, then Website Settings › Camera › Allow, or enter the barcode manually.")
      : isAndroid ? `Camera access is turned off. Allow it in ${standalone() ? "the phone's Settings › Apps › SFB Value › Permissions › Camera" : "the browser's site settings (the lock icon by the address, then Permissions › Camera)"}, or enter the barcode manually.`
      : "Camera access is turned off. Allow it in the browser's site settings, or enter the barcode manually.";
    scanDenied(err?.name === "NotAllowedError" ? denied
      : err?.name === "NotFoundError" ? "No camera was found on this device. Enter the barcode manually."
      : err?.name === "NotReadableError" ? "The camera is in use by another app. Close it and try again, or enter the barcode manually."
      : "The camera could not start. Enter the barcode manually.");
  }
}
function scanDenied(msg) {
  hideTorch();
  el.reticle.hidden = true; el.scanHint.textContent = "Enter the digits printed under the barcode";
  el.scanner.querySelector(".scan-denied")?.remove();
  const d = document.createElement("div"); d.className = "scan-denied"; d.innerHTML = `<p>${esc(msg)}</p>`;
  el.scanner.insertBefore(d, el.scanner.querySelector(".scan-bottom"));
  showScanType();
}
function showScanType() { el.scanTypeForm.hidden = false; el.scanTypeBtn.hidden = true; el.scanTypeInput.value = ""; state.scan?.pause(); el.scanTypeInput.focus(); }
function closeScanner({ fromPop = false } = {}) {
  if (!state.scanOpen) return;
  if (!fromPop && history.state?.modal === "scanner") { history.back(); return; }
  state.scanOpen = false; state.scanGen++;
  state.scan?.stop({ keepMs: keepCameraMs() }); state.scan = null;
  el.scanner.hidden = true;
  el.scanner.querySelector(".scan-denied")?.remove();
  el.torchBtn.setAttribute("aria-pressed", "false");
  syncInert();
  if (state.focusSearchAfterScanner) { state.focusSearchAfterScanner = false; el.q.focus({ preventScroll: true }); }
  else if (!el.sheet.open) el.scanBtn.focus({ preventScroll: true });
}
function resumeScan() {
  if (!state.scanOpen || !state.scan) return;
  el.scanner.classList.remove("is-hit"); el.scanHint.textContent = "Center the barcode in the frame";
  if (state.scan.zoom) state.scan.setZoom(false).catch(() => {});
  state.scan.resume(); armSmallHelp();
}
/** Resolves when the other departments have joined the search (the "more" event), or after `ms`. */
const moreArrives = (ms) => new Promise((resolve) => { const done = () => { clearTimeout(t); db.removeEventListener("more", done); resolve(); }; const t = setTimeout(done, ms); db.addEventListener("more", done); });
/** A barcode the open departments do not know, while other departments are still opening (the first seconds after a
 *  launch): wait once for them, then look again, so a Home item scanned early is not called unknown. */
async function resolveWithPending(raw, format, opts, onWait) {
  let res = await resolveCode(db, raw, format, opts);
  if (res?.kind === "unknown" && db.more?.pending?.length) {
    onWait?.();
    await moreArrives(2500);
    res = await resolveCode(db, raw, format, opts);
  }
  return res;
}
async function onScanHit(hit) {
  if (anyModalOpen()) { state.scan?.pause(); return; }   // the tally or settings is open over the camera: never stack a result on it
  const t0 = performance.now();
  haptic(20);
  el.scanner.classList.add("is-hit");
  el.scanHint.textContent = `Scanned ${formatGtin(hit.gtin?.gtin14 || hit.raw)}`;
  let res = null;
  state.learnFor = null;
  try { res = await resolveWithPending(hit.raw, hit.format, resolveOpts({ scanned: true }), () => { el.scanHint.textContent = "Other departments are still loading…"; }); } catch (err) { console.warn("resolve", err); }
  if (!state.scanOpen) return;
  if (!res) { el.scanHint.textContent = "This is not a product barcode"; setTimeout(resumeScan, 900); return; }
  if (res.kind === "not-ready") { el.scanHint.textContent = "The price list is still loading"; setTimeout(resumeScan, 1200); return; }
  state.source = "scan";
  openResolution(res, { source: "scan" });
  requestAnimationFrame(() => perf.scans.push({ code: hit.raw, kind: res.kind, decodeMs: hit.ms, engine: hit.engine, toPriceMs: Math.round((performance.now() - t0) * 10) / 10 }));
}
el.scanBtn.addEventListener("click", openScanner);
el.scanClose.addEventListener("click", () => closeScanner());
el.scanner.addEventListener("contextmenu", (e) => e.preventDefault());   // a long press on the camera view is not a menu
el.torchBtn.addEventListener("click", async () => {
  const scan = state.scan;
  if (!scan) { hideTorch(); return; }
  const on = await scan.setTorch(!scan.torch);
  if (scan === state.scan) el.torchBtn.setAttribute("aria-pressed", String(!!on));
});
el.scanTypeBtn.addEventListener("click", showScanType);
el.scanTypeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = el.scanTypeInput.value.trim(); if (!v) return;
  if (!db.version) { toast("The price list is still loading. Try again shortly.", { iconName: "info" }); return; }
  const res = await openCode(v, { source: "scan" });
  if (res) { state.source = "scan"; el.scanTypeInput.value = ""; }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // stop reading at once (parking the camera where the app keeps it ready); the history bookkeeping can wait for the
    // app to come back
    if (state.scan) { state.scan.stop({ keepMs: keepCameraMs() }); state.scan = null; state.scanPausedByVisibility = state.scanOpen; hideTorch(); }
  } else if (state.scanPausedByVisibility) {
    state.scanPausedByVisibility = false;
    if (state.scanOpen) startCamera(++state.scanGen);
  }
});

// ------------------------------------------------------------------ scrolling the results from anywhere
// While a search is up the results are the only thing that scrolls. A wheel or trackpad over the header, the banner,
// the dock or the margins of a wide screen scrolls them too, instead of nothing.
const resultsScrollable = () => !el.results.hidden && !anyModalOpen() && !state.scanOpen;
document.addEventListener("wheel", (e) => {
  if (e.ctrlKey || !resultsScrollable() || el.results.contains(e.target) || e.target.closest?.(".toasts")) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.results.clientHeight : e.deltaY;
  if (!dy) return;
  e.preventDefault();
  el.results.scrollTop += dy;
}, { passive: false });
// Page Up / Page Down from the search box page through the results (the caret keeps the arrows and Home/End)
el.q.addEventListener("keydown", (e) => {
  if ((e.key !== "PageUp" && e.key !== "PageDown") || !resultsScrollable()) return;
  e.preventDefault();
  el.results.scrollTop += (e.key === "PageUp" ? -1 : 1) * Math.round(el.results.clientHeight * 0.85);
});
// dragging the list on a phone puts the keyboard away, as native lists do: the whole list is then in reach
let touchY = null;
el.results.addEventListener("touchstart", (e) => { touchY = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
el.results.addEventListener("touchmove", (e) => {
  if (touchY == null || document.activeElement !== el.q) return;
  if (Math.abs(e.touches[0].clientY - touchY) > 12) { touchY = null; el.q.blur(); }
}, { passive: true });

// ------------------------------------------------------------------ keyboard (desktop testing, external scanners that type digits + Enter)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.scanOpen && !anyModalOpen()) { e.preventDefault(); closeScanner(); return; }
  if (e.key === "/" && document.activeElement !== el.q && !anyModalOpen() && !state.scanOpen) { e.preventDefault(); el.q.focus(); }
});

// ------------------------------------------------------------------ service worker + boot
if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      const offerUpdate = () => toast("An app update is ready", { action: "Reload", ms: 0, iconName: "refresh", onAction: () => { state.pendingReload = true; (reg.waiting || reg.installing)?.postMessage({ type: "SKIP_WAITING" }); } });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();   // an update that was already waiting from a previous visit
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", () => { if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(); });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (state.pendingReload) location.reload(); });
    } catch (err) { console.warn("sw", err); }
  });
}

keyboardInset();
showInstallHint();
// The browser floor is one date on both platforms, March 2023: Safari 16.4 (every iPhone browser is the system's WebKit;
// iPhone 8 and X and newer reach it) and Chrome 111 on Android (Chrome updates from the Play Store on Android 8 and newer;
// Samsung Internet 23, Firefox 121). Below it the price database cannot be unpacked (DecompressionStream) or the layout
// cannot be drawn (oklch colours, dvh units), so nothing is downloaded, now or when the connection comes back (the online
// handler checks this flag), and the status card says what to update.
const tooOld = typeof DecompressionStream === "undefined" || typeof OffscreenCanvas === "undefined"
  || !(window.CSS?.supports?.("color", "oklch(50% 0 0)") && CSS.supports("height", "100dvh") && CSS.supports("selector(:has(a))"));
if (tooOld) {
  state.unsupported = true;
  state.dbErrorPlain = true;
  state.dbError = isIOS ? "This iPhone's software is too old to keep prices offline. Update to iOS 16.4 or later (Settings › General › Software Update), then open the app again."
    : isAndroid ? "This browser is too old to keep prices offline. Update Chrome (or the phone's browser) from the Play Store, then open the app again."
    : "This browser is too old to keep prices offline. Update it, then open the app again.";
  db.state = "error";
  closeBootScreen("unsupported");
} else db.start();
renderStatus();
syncLearned();
if (tourWanted()) requestAnimationFrame(openTour);
perf.boot.scriptMs = Math.round(performance.now());
