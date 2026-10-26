// keyboard-check.mjs — the keyboard and visual-viewport rules of the real app, checked in a browser against a model
// of iOS. Chromium has no on-screen keyboard and never pans the visual viewport, so the page gets a scripted
// visualViewport (installed before the app runs) that behaves as iOS does: the keyboard shrinks the visual viewport
// over several frames, iOS may pan the layout viewport to reveal the focused field (offsetTop), the user can pan it
// further by dragging, a final resize event can go missing, window.scrollTo(0, 0) brings the pan back to 0 (in
// WebKit window.scrollY is the visual viewport's position), innerHeight is clipped to the document once the page is
// panned into the keyboard's room, and a caret drag runs WebKit's selection autoscroll, which reveals the finger's
// point through the document every 50 ms, grown by the root's scroll-padding. Every scenario asserts the same
// invariants in visual coordinates (layout coordinates minus the pan): the header's top edge is the visible top, the
// dock's bottom edge is the keyboard's top, the panel between them (home or results) fills exactly that room, and
// nothing is drawn outside. Exit code 1 when any check fails.
//   node tools/keyboard-check.mjs [--url http://127.0.0.1:8787/] [--browser chromium|webkit] [--only S1,S4]
import { chromium, webkit } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true] : [])).filter((x) => x.length));
const BROWSER = String(args.browser || "chromium").toLowerCase();
const BASE = new URL(args.url || "http://127.0.0.1:8787/");
const ONLY = args.only ? new Set(String(args.only).split(",").map((s) => s.trim())) : null;
const exe = process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {};
const browser = BROWSER === "webkit" ? await webkit.launch() : await chromium.launch({ args: ["--no-sandbox"], ...exe });
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let failed = 0;
const check = (id, name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
const settle = (page, ms = 250) => page.waitForTimeout(ms);

/** The iOS model, installed before any script of the page runs. */
const IOS_VV = () => {
  const st = { h: 0, top: 0, scale: 1, raf: null };
  const fake = new EventTarget();
  // the layout viewport's height: what innerHeight reads with no pan
  const realInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")?.get;
  const H = () => (realInnerHeight ? realInnerHeight.call(window) : window.innerHeight);
  // iOS clips innerHeight to the document once the page is panned into the keyboard's room: WKWebView intersects the
  // unobscured rect with the content before reporting it (WKWebViewIOS.mm, the visible-rect update), and
  // LocalDOMWindow::innerHeight is that rect's height. At the bottom of a 336 px pan an 852 px page reads 516, the
  // visible height, which looks like a keyboard that has gone (owner's recording, 2026-10-23).
  if (realInnerHeight) Object.defineProperty(window, "innerHeight", { get: () => H() - st.top, configurable: true });
  Object.defineProperties(fake, {
    width: { get: () => window.innerWidth }, height: { get: () => (st.h || H()) },
    offsetTop: { get: () => st.top }, offsetLeft: { get: () => 0 },
    pageTop: { get: () => st.top }, pageLeft: { get: () => 0 }, scale: { get: () => st.scale },
    onresize: { value: null, writable: true }, onscroll: { value: null, writable: true },
  });
  Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
  const fire = (t) => fake.dispatchEvent(new Event(t));
  const log = [];
  window.__ios = {
    log,
    get state() { return { h: fake.height, top: st.top, innerHeight: H() }; },
    /** The keyboard of height k opens over `frames` animation frames; iOS pans by `pan` at once (0 = no reveal pan);
     *  with silentLast the final resize event is never delivered (the value changes, nothing says so). */
    open(k, { frames = 5, pan = 0, silentLast = false } = {}) {
      return new Promise((resolve) => {
        const from = fake.height, to = H() - k; let i = 0;
        if (pan) { st.top = Math.min(pan, k); fire("scroll"); }
        const step = () => {
          i++;
          st.h = Math.round(from + (to - from) * (i / frames));
          log.push(["resize", st.h, st.top]);
          if (i < frames || !silentLast) fire("resize");
          if (i < frames) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    /** The keyboard goes; the pan goes with it. */
    close({ frames = 4 } = {}) {
      return new Promise((resolve) => {
        const from = fake.height, to = H(); let i = 0;
        const step = () => { i++; st.h = Math.round(from + (to - from) * (i / frames)); if (i === frames) { st.h = 0; st.top = 0; fire("scroll"); } fire("resize"); if (i < frames) requestAnimationFrame(step); else resolve(); };
        requestAnimationFrame(step);
      });
    },
    /** The user drags: the visual viewport pans within the layout viewport, as far as the keyboard's height. */
    pan(dy) { const max = Math.max(0, H() - fake.height); st.top = Math.max(0, Math.min(Math.max(max, dy), st.top + dy)); log.push(["pan", st.top]); fire("scroll"); },
    /** WebKit's selection autoscroll, one tick of its 50 ms timer during a caret drag: a 1 px point at the finger is
     *  revealed through the document (RenderLayer::autoscroll → LocalFrameView::scrollRectToVisibleInTopLevelView),
     *  grown by the root element's scroll-padding, scrolled to the nearest edge only when not already in view
     *  (ScrollableArea::getRectToExposeForScrollIntoView with alignToEdgeIfNeeded), the scroll clamped to the room the
     *  keyboard leaves. `y` is the finger in visual coordinates. Returns the pan afterwards. Not modelled: WebKit's edge band
     *  (a push of up to 40 px per tick once the finger is within 100 px of the unobscured rect's bottom), which at pan 0
     *  lies at the screen's bottom, below the search box; it only reaches a finger on the box once the page is deep-panned. */
    autoscrollTick(y) {
      const cs = getComputedStyle(document.documentElement);
      const padTop = parseFloat(cs.scrollPaddingTop) || 0, padBottom = parseFloat(cs.scrollPaddingBottom) || 0;
      const docY = y + st.top, top = docY - padTop, bottom = docY + 1 + padBottom, h = bottom - top;
      const vTop = st.top, vBottom = st.top + fake.height, visible = Math.max(0, Math.min(vBottom, bottom) - Math.max(vTop, top));
      let target = st.top;
      if (visible !== h && visible !== fake.height) {   // not fully in view, and not covering the whole view
        const alignBottom = (bottom > vBottom && h < fake.height) || (bottom < vBottom && h > fake.height);
        target = alignBottom ? bottom - fake.height : top;
      }
      target = Math.max(0, Math.min(Math.max(0, H() - fake.height), Math.round(target)));
      if (target !== st.top) { st.top = target; log.push(["autoscroll", st.top]); fire("scroll"); }
      return st.top;
    },
  };
  // iOS's reveal: a field that takes the focus where the keyboard will cover it makes iOS pan the page up to show it,
  // judged from the field's position at the moment of focus. In a Home Screen app the visual viewport gets its final
  // height at once and the pan is then animated (owner's screen recording, 2026-10-23).
  let focusRect = null;
  document.addEventListener("focusin", (e) => { if (e.target?.tagName === "INPUT") { const r = e.target.getBoundingClientRect(); focusRect = { top: r.top, bottom: r.bottom }; } }, true);
  /** A finger taps the field (touchstart, touchend; the browser focuses it unless the app cancelled the touchend),
   *  then the keyboard of height k opens with the reveal iOS would make. Resolves with every frame's geometry. */
  window.__ios.tapAndOpen = (sel, k, frames = 10) => new Promise((resolve) => {
    const field = document.querySelector(sel);
    const touch = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [{ identifier: 1, target: field, clientX: 100, clientY: 100 }] }); return field.dispatchEvent(e); };
    focusRect = null;
    touch("touchstart");
    if (touch("touchend")) field.focus();          // not cancelled: the browser's own focus
    const visibleBottom = H() - k;
    const reveal = focusRect && focusRect.bottom > visibleBottom ? Math.min(k, Math.round(focusRect.bottom - visibleBottom + 12)) : 0;
    const trace = [{ reveal, focusTop: focusRect && Math.round(focusRect.top) }];
    st.h = H() - k; fire("resize");
    let i = 0;
    const step = () => {
      i++;
      if (reveal) { st.top = Math.round(reveal * Math.min(1, i / frames)); fire("scroll"); }
      requestAnimationFrame(() => {
        const top = document.getElementById("top").getBoundingClientRect(), dock = document.getElementById("dock").getBoundingClientRect();
        trace.push({ i, pan: st.top, headerTop: Math.round(top.top - st.top), dockBottom: Math.round(dock.bottom - st.top), keyboardTop: fake.height });
        if (i < frames + 6) step(); else resolve(trace);
      });
    };
    requestAnimationFrame(step);
  });
  // WebKit: window.scrollTo moves the visual viewport when the layout viewport has nowhere to go
  const scrollTo = window.scrollTo.bind(window);
  window.scrollTo = (x, y) => { let top = y; if (x && typeof x === "object") top = x.top; if (top === 0 && st.top !== 0) { st.top = 0; log.push(["scrollTo0"]); fire("scroll"); } return scrollTo(typeof x === "object" ? x : x, typeof x === "object" ? undefined : y); };
  Object.defineProperty(window, "scrollY", { get: () => st.top, configurable: true });
  Object.defineProperty(window, "pageYOffset", { get: () => st.top, configurable: true });
};

async function open(width = 393, height = 852) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  await ctx.addInitScript(IOS_VV);
  await ctx.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const u = new URL(BASE.href); u.searchParams.set("nosw", "1"); u.searchParams.set("tour", "0");
  await page.goto(u.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("html[data-ready='1']", { timeout: 120000 });
  await settle(page, 300);
  return { ctx, page, errors };
}

/** Everything in visual coordinates: layout rect minus the pan. */
const geometry = (page) => page.evaluate(() => {
  const { top: pan, h: vvh } = window.__ios.state;
  const r = (sel) => { const e = document.querySelector(sel); if (!e || e.hidden || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { t: b.top - pan, b: b.bottom - pan, l: b.left, r: b.right }; };
  const cs = getComputedStyle(document.documentElement);
  const rows = [...document.querySelectorAll("#list .row")].map((e) => { const b = e.getBoundingClientRect(); return { t: b.top - pan, b: b.bottom - pan }; });
  return { pan, vvh, ih: innerHeight, kb: cs.getPropertyValue("--kb").trim(), vvTop: cs.getPropertyValue("--vv-top").trim(), dataKb: document.documentElement.dataset.kb === "1",
    top: r("#top"), dock: r("#dock"), results: r("#results"), home: r("#home"), main: r("#main"), empty: r("#home .empty, #home .prompt, #home h2, #home .empty-title"), input: r("#q"),
    rows, bestRow: rows.length ? rows.reduce((a, b) => (b.b > a.b ? b : a)) : null, scrollTop: document.getElementById("results").scrollTop, active: document.activeElement?.id || document.activeElement?.tagName };
});
const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;
/** The invariants that hold whenever the keyboard is up (kb > 0) in every scenario. */
function invariants(id, label, g) {
  const panel = g.results || g.main;
  check(id, `${label}: the header's top edge is the visible top`, g.top && near(g.top.t, 0), `header top ${g.top?.t} (pan ${g.pan})`);
  check(id, `${label}: the dock's bottom edge is the keyboard's top`, g.dock && near(g.dock.b, g.vvh), `dock bottom ${g.dock?.b} keyboard top ${g.vvh} (--kb ${g.kb}, --vv-top ${g.vvTop})`);
  check(id, `${label}: the search box is on screen above the keyboard`, g.input && g.input.b <= g.vvh + 0.5 && g.input.t >= (g.top?.b ?? 0) - 0.5, `input ${g.input?.t}-${g.input?.b}`);
  check(id, `${label}: the panel between header and dock fills exactly that room`, panel && near(panel.t, g.top.b, 1.5) && near(panel.b, g.dock.t, 1.5), `panel ${panel?.t}-${panel?.b} header bottom ${g.top?.b} dock top ${g.dock?.t}`);
  if (g.results && g.scrollTop === 0) check(id, `${label}: the best match is drawn inside the results box, by the dock`, g.bestRow && g.bestRow.b <= g.results.b + 0.5 && g.bestRow.t >= g.results.t - 0.5, `best row ${g.bestRow?.t}-${g.bestRow?.b} box ${g.results?.t}-${g.results?.b}`);
}

const scenarios = [];
const scenario = (id, name, fn) => scenarios.push({ id, name, fn });

scenario("S1", "the keyboard opens without a pan: the dock rises onto it", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 400);
  invariants("S1", "open", await geometry(page));
});
scenario("S2", "iOS reveals the field by panning the page the whole keyboard height", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336, { pan: 336 })); await settle(page, 600);
  const g = await geometry(page);
  invariants("S2", "panned open", g);
  check("S2", "the app brings the pan back to zero, so nothing underneath can slide", g.pan === 0, `pan ${g.pan}`);
});
scenario("S3", "the final resize event never arrives", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336, { silentLast: true })); await settle(page, 900);
  invariants("S3", "silent final frame", await geometry(page));
});
scenario("S4", "typing shows results; the user drags and the page is panned; nothing visible moves", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.type("#q", "pea"); await page.waitForSelector("#results:not([hidden]) .row", { timeout: 20000 }); await settle(page, 500);
  invariants("S4", "results up", await geometry(page));
  await page.evaluate(() => window.__ios.pan(120)); await settle(page, 400);
  const g = await geometry(page);
  invariants("S4", "after a 120px pan", g);
  check("S4", "the pan is undone at once", g.pan === 0, `pan ${g.pan}`);
  await page.evaluate(() => window.__ios.pan(336)); await settle(page, 400);
  invariants("S4", "after a pan to the limit", await geometry(page));
});
scenario("S5", "rapid typing and backspacing to nothing: home returns in place, the dock stays on the keyboard", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.type("#q", "peanut butter", { delay: 20 });
  for (let i = 0; i < 13; i++) await page.keyboard.press("Backspace");
  await settle(page, 800);
  const g = await geometry(page);
  check("S5", "home is back with no results box", !g.results && !!g.main, JSON.stringify({ results: !!g.results, main: !!g.main }));
  invariants("S5", "home after backspacing", g);
  await page.evaluate(() => window.__ios.pan(200)); await settle(page, 400);
  invariants("S5", "home after a drag", await geometry(page));
});
scenario("S6", "the keyboard closes: everything returns to the screen's edges", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => window.__ios.close()); await settle(page, 500);
  const g = await geometry(page);
  check("S6", "the dock is back on the bottom edge and the header on the top", near(g.dock.b, g.ih) && near(g.top.t, 0) && g.kb === "0px" && g.vvTop === "0px", JSON.stringify({ dock: g.dock, top: g.top, kb: g.kb, vvTop: g.vvTop }));
});
scenario("S7", "the keyboard stays up while no field has the focus (the accessory bar, a stray tap): the dock still sits on it", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.evaluate(() => document.activeElement.blur()); await settle(page, 300);
  invariants("S7", "keyboard up, nothing focused", await geometry(page));
});

scenario("S8", "results scrolled up, then the keyboard opens: the row under the thumb stays, nothing is pushed above the screen", async (page) => {
  await page.focus("#q"); await page.type("#q", "pea"); await page.waitForSelector("#results:not([hidden]) .row", { timeout: 20000 }); await settle(page, 400);
  await page.evaluate(() => document.activeElement.blur()); await settle(page, 200);
  const scrolled = await page.evaluate(() => { const r = document.getElementById("results"); r.scrollTop = -400; return r.scrollTop; });
  check("S8", "the list can be scrolled up away from the best match", scrolled < -100, `scrollTop ${scrolled}`);
  const anchor = () => page.evaluate(() => { const box = document.getElementById("results").getBoundingClientRect(); const row = [...document.querySelectorAll("#list .row")].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > box.top && b.top < box.bottom; }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]; return row ? { id: row.dataset.rank ?? row.textContent.slice(0, 30), top: Math.round(row.getBoundingClientRect().top - box.top) } : null; });
  const before = await anchor();
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 600);
  const after = await anchor();
  invariants("S8", "keyboard up over scrolled results", await geometry(page));
  check("S8", "the row the reader was on is still where it was, relative to the box", before && after && before.id === after.id && Math.abs(before.top - after.top) <= 2, JSON.stringify({ before, after }));
});
scenario("S9", "a drag on the results puts the keyboard away: the rows do not run from the finger", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.type("#q", "pea"); await page.waitForSelector("#results:not([hidden]) .row", { timeout: 20000 }); await settle(page, 400);
  await page.evaluate(() => { document.getElementById("results").scrollTop = -700; });   // further up than the keyboard is tall, so the list has room to hold the row
  const anchor = () => page.evaluate(() => { const box = document.getElementById("results").getBoundingClientRect(); const row = [...document.querySelectorAll("#list .row")].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > box.top && b.top < box.bottom; }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]; return row ? { id: row.textContent.slice(0, 30), top: Math.round(row.getBoundingClientRect().top - box.top) } : null; });
  const before = await anchor();
  // the drag: a touch that moves 40px (the app blurs the field after 12px); iOS then takes the keyboard down
  // plain events carrying what the app reads (touches[0].clientY): WebKit on Linux has no Touch constructor
  await page.evaluate(() => { const r = document.getElementById("results"); const t = (type, y) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [{ identifier: 1, target: r, clientX: 180, clientY: y }] }); r.dispatchEvent(e); }; t("touchstart", 300); t("touchmove", 280); t("touchmove", 260); t("touchend", 260); });
  await settle(page, 100);
  const blurred = await page.evaluate(() => document.activeElement !== document.getElementById("q"));
  check("S9", "the drag took the focus off the field", blurred);
  await page.evaluate(() => window.__ios.close()); await settle(page, 600);
  const after = await anchor();
  const g = await geometry(page);
  check("S9", "the keyboard is gone and the dock is back on the bottom edge", near(g.dock.b, g.ih) && g.kb === "0px", JSON.stringify({ dock: g.dock, kb: g.kb }));
  check("S9", "the row the reader was on is still where it was, relative to the box", before && after && before.id === after.id && Math.abs(before.top - after.top) <= 2, JSON.stringify({ before, after }));
});
scenario("S10", "the keyboard closes but iOS leaves the page panned (iOS 26.0 left 24 px): the pan is undone", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336, { pan: 336 })); await settle(page, 500);
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => window.__ios.close({ frames: 3 })); await page.evaluate(() => window.__ios.pan(24)); await settle(page, 600);
  const g = await geometry(page);
  check("S10", "no pan is left behind, and the dock and header sit on the screen's edges", g.pan === 0 && near(g.dock.b, g.ih) && near(g.top.t, 0), JSON.stringify({ pan: g.pan, dock: g.dock, top: g.top }));
});

scenario("S11", "a tap on the search box opens the keyboard without iOS sliding the page (owner's recording, 2026-10-23)", async (page) => {
  const trace = await page.evaluate(() => window.__ios.tapAndOpen("#q", 336));
  const [head, ...frames] = trace;
  const focused = await page.evaluate(() => document.activeElement?.id);
  check("S11", "the tap focuses the search box", focused === "q", focused);
  check("S11", "iOS finds nothing to reveal: the field was out of its sight at the moment of focus", head.reveal === 0, JSON.stringify(head));
  const maxPan = Math.max(...frames.map((f) => f.pan));
  check("S11", "the page never pans, in any frame", maxPan === 0, `largest pan ${maxPan}`);
  const off = frames.filter((f) => f.headerTop !== 0);
  check("S11", "the header stays at the top in every frame", off.length === 0, JSON.stringify(off.slice(0, 3)));
  const late = frames.slice(2).filter((f) => Math.abs(f.dockBottom - f.keyboardTop) > 1);
  check("S11", "from the second frame on, the dock sits on the keyboard in every frame", late.length === 0, JSON.stringify(late.slice(0, 3)));
  await settle(page, 300);
  const back = await page.evaluate(() => getComputedStyle(document.getElementById("q")).transform);
  check("S11", "the field is back in place on the next frame", back === "none", back);
  invariants("S11", "after the tap", await geometry(page));
});

scenario("S12", "the cursor is held and dragged in the search box: WebKit's autoscroll reveals the finger's point through the document, and nothing fights it (owner's recording, 2026-10-23)", async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.type("#q", "pea"); await page.waitForSelector("#results:not([hidden]) .row", { timeout: 20000 }); await settle(page, 500);
  // the finger goes down on the field's text and stays; WebKit's autoscroll timer fires every 50 ms for a second, and
  // every frame is sampled in visual coordinates
  const { y, dockTop, frames } = await page.evaluate(() => new Promise((resolve) => {
    const field = document.getElementById("q"); const pan0 = window.__ios.state.top;
    const r = field.getBoundingClientRect(); const y = Math.round((r.top + r.bottom) / 2 - pan0);
    const dockTop = Math.round(document.getElementById("dock").getBoundingClientRect().top - pan0);
    const e = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", { value: [{ identifier: 1, target: field, clientX: 120, clientY: y }] });
    field.dispatchEvent(e);
    let ticks = 0; const tick = () => { window.__ios.autoscrollTick(y); if (++ticks < 20) setTimeout(tick, 50); }; setTimeout(tick, 50);
    const frames = [];
    const sample = () => {
      const { top: pan, h } = window.__ios.state;
      const top = document.getElementById("top").getBoundingClientRect(), dock = document.getElementById("dock").getBoundingClientRect();
      frames.push({ pan, headerTop: Math.round(top.top - pan), dockBottom: Math.round(dock.bottom - pan), keyboardTop: h, innerHeight });
      if (frames.length < 72) requestAnimationFrame(sample); else resolve({ y, dockTop, frames });
    };
    requestAnimationFrame(sample);
  }));
  check("S12", "the finger is on the search box, above the keyboard", y > dockTop && y < frames[0].keyboardTop, `finger ${y}, dock top ${dockTop}, keyboard top ${frames[0].keyboardTop}`);
  const maxPan = Math.max(...frames.map((f) => f.pan));
  check("S12", "the reveal finds the finger's point already in view: the page never pans, in any frame", maxPan === 0, `largest pan ${maxPan} (the root's scroll-padding grows the point past the keyboard)`);
  const headerOff = frames.filter((f) => f.headerTop !== 0);
  check("S12", "the header stays at the visible top in every frame", headerOff.length === 0, JSON.stringify(headerOff.slice(0, 3)));
  const dockOff = frames.filter((f) => Math.abs(f.dockBottom - f.keyboardTop) > 1);
  check("S12", "the dock sits on the keyboard in every frame", dockOff.length === 0, JSON.stringify(dockOff.slice(0, 3)));
  // whatever else iOS scrolls while the finger is down (here: a pan to the bottom, where innerHeight reads as the
  // visible height) is followed, never undone, so nothing on screen moves against the finger
  await page.evaluate(() => window.__ios.pan(336)); await settle(page, 450);
  const held = await geometry(page);
  check("S12", "a pan made while the finger is down is left alone (no tug of war)", held.pan === 336, `pan ${held.pan}`);
  check("S12", "the model clips innerHeight to the visible height at the bottom of the pan, as iOS does", held.ih === held.vvh, JSON.stringify({ innerHeight: held.ih, vvh: held.vvh }));
  check("S12", "with innerHeight clipped, the keyboard is still known", held.dataKb, JSON.stringify({ dataKb: held.dataKb, kb: held.kb, vvTop: held.vvTop }));
  invariants("S12", "panned, finger down", held);
  // the finger lifts: the pan is undone once, with the layout written for pan 0 in the same frame
  await page.evaluate(() => { const field = document.getElementById("q"); const e = new Event("touchend", { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: [] }); field.dispatchEvent(e); });
  await settle(page, 450);
  const after = await geometry(page);
  check("S12", "once the finger lifts the pan is undone", after.pan === 0, `pan ${after.pan}`);
  invariants("S12", "after the drag", after);
  const panned = await page.evaluate(() => window.__ios.log.filter((l) => l[0] === "autoscroll").length);
  check("S12", "WebKit's autoscroll never had to scroll", panned === 0, `${panned} autoscroll ticks scrolled`);
});

// The thumb slides down onto the keyboard while it holds the cursor. The finger's point is then below the visible area,
// so WebKit's autoscroll pans the page with no scroll-padding involved, about 40 px more every 50 ms up to the
// keyboard's height. Nothing can stop that pan; the app must follow it and never fight it, whether the page still gets
// the finger's touch events (S13) or UIKit's loupe cancels them when it starts (S14: the page then never sees the lift).
for (const [id, cancel] of [["S13", false], ["S14", true]]) scenario(id, `the cursor is held with the finger slid onto the keyboard${cancel ? ", the page's touches cancelled as the loupe starts" : ""}: WebKit's autoscroll pans the page; it is followed, never fought`, async (page) => {
  await page.focus("#q"); await settle(page, 100);
  await page.evaluate(() => window.__ios.open(336)); await settle(page, 300);
  await page.type("#q", "pea"); await page.waitForSelector("#results:not([hidden]) .row", { timeout: 20000 }); await settle(page, 500);
  const out = await page.evaluate((cancel) => new Promise((resolve) => {
    const field = document.getElementById("q");
    const y = window.__ios.state.h + 40;   // 40 px down onto the keyboard, in visual coordinates
    const touch = (type, touches) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: touches }); field.dispatchEvent(e); };
    touch("touchstart", [{ identifier: 1, target: field, clientX: 120, clientY: y }]);
    if (cancel) setTimeout(() => touch("touchcancel", []), 120);
    const t0 = performance.now();
    const tick = () => { window.__ios.autoscrollTick(y); if (performance.now() - t0 < 4000) setTimeout(tick, 50); };
    setTimeout(tick, 50);
    const frames = [];
    const sample = () => {
      const { top: pan, h } = window.__ios.state;
      const top = document.getElementById("top").getBoundingClientRect(), dock = document.getElementById("dock").getBoundingClientRect();
      frames.push({ t: Math.round(performance.now() - t0), pan, headerTop: Math.round(top.top - pan), dockBottom: Math.round(dock.bottom - pan), keyboardTop: h });
      if (performance.now() - t0 < 4200) requestAnimationFrame(sample); else resolve({ frames, log: window.__ios.log.slice() });
    };
    requestAnimationFrame(sample);
  }), cancel);
  const autos = out.log.filter((l) => l[0] === "autoscroll").length, undos = out.log.filter((l) => l[0] === "scrollTo0").length;
  check(id, "WebKit's autoscroll pans the page for a point below the visible area (the model)", autos > 0 && Math.max(...out.frames.map((f) => f.pan)) === 336, `${autos} autoscroll steps, largest pan ${Math.max(...out.frames.map((f) => f.pan))}`);
  if (cancel) check(id, "with no touch events the pan is undone at most once: an undo iOS puts back is not repeated", undos <= 1, `${undos} undos in 4 s`);
  else check(id, "the pan is never undone while the finger is down", undos === 0, `${undos} undos in 4 s`);
  const off = out.frames.filter((f) => f.headerTop !== 0 || Math.abs(f.dockBottom - f.keyboardTop) > 1);
  check(id, "the header and the dock stay put in every frame of the hold", off.length === 0, `${off.length}/${out.frames.length} frames off: ${JSON.stringify(off.slice(0, 3))}`);
  invariants(id, "end of the hold, pan followed", await geometry(page));
  // the lift: S13's touchend reaches the page; S14's does not, and the next tap on the page is what ends the gesture
  await page.evaluate((cancel) => {
    const el = cancel ? document.getElementById("results") : document.getElementById("q");
    const touch = (type, touches) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "touches", { value: touches }); el.dispatchEvent(e); };
    if (cancel) touch("touchstart", [{ identifier: 2, target: el, clientX: 200, clientY: 200 }]);
    touch("touchend", []);
  }, cancel);
  await settle(page, 450);
  const after = await geometry(page);
  const undosAfter = await page.evaluate(() => window.__ios.log.filter((l) => l[0] === "scrollTo0").length);
  check(id, `once ${cancel ? "a later tap ends the gesture" : "the finger lifts"} the pan is undone, once`, after.pan === 0 && undosAfter === undos + 1, `pan ${after.pan}, undos ${undos} -> ${undosAfter}`);
  invariants(id, "after the hold", after);
});

for (const s of scenarios) {
  if (ONLY && !ONLY.has(s.id)) continue;
  let env = null;
  try { env = await open(); await s.fn(env.page); if (env.errors.length) check(s.id, `${s.name}: no page errors`, false, env.errors.slice(0, 2).join(" | ")); }
  catch (err) { check(s.id, `${s.name} (scenario)`, false, String(err?.message || err).split("\n")[0]); }
  finally { await env?.ctx?.close().catch(() => {}); }
}
await browser.close();
console.log(failed ? `keyboard-check: ${failed} failed (${BROWSER})` : `keyboard-check: all passed (${BROWSER})`);
process.exit(failed ? 1 : 0);
