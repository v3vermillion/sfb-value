import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCode, fromItem, valueAt, kindLabel, splitTitle, titleOf, notesFor, livePlausible, packListingOf, liveUnitCents, storeOfCode, whoseBrand, mergeLearned, pruneOwnMatches, liveCheckable } from "../public/js/resolve.js";

const corn = { rank: 0, id: 1, brand: "Great Value", name: "Great Value Golden Sweet Whole Kernel Corn, Canned Corn, 15.25 oz Can", priceCents: 87, size: 15.25, unit: "oz", pack: 1, basis: "each", cat: 6, catName: "Canned & Jarred", upc: "00078742054261", retired: false, primary: true, storeBrand: true };
const retired = { ...corn, rank: 1, id: 2, retired: true, primary: false };
const mkDb = ({ ready = true } = {}) => ({
  calls: [],
  async lookupUpc(key) {
    this.calls.push(key);
    if (!ready) return { notReady: true };
    if (key === 78742054261) return { items: [corn, retired], equivalent: null };
    if (key === 4252614) return { items: [{ ...corn, id: 9, upc: "00000004252614" }], equivalent: null };   // keyed the crawler's way (zero-padded 8 digits)
    if (key === 4099100000000) return { items: [], equivalent: { brand: "Clancy's", name: "Potato Chips", quantity: "10 oz", estCents: 198, confidence: "high", basis: corn } };
    if (key === 4099100000017) return { items: [], equivalent: { brand: "Clancy's", name: "Pretzels", quantity: "16 oz", estCents: 150, confidence: "low", basis: null } };
    if (key === 213571107096) return { items: [{ ...corn, id: 11, brand: "Hickory Farms", name: "Spiral-Sliced Ham", priceCents: 4900, upc: "00213571107096" }], equivalent: null };   // a Walmart listing whose own barcode starts with 2
    if (key === 212345000007) return { items: [{ ...corn, id: 7, name: "Great Value Ground Beef Tray", upc: "00212345000007" }], equivalent: null };
    return { items: [], equivalent: null };
  },
  async lookupPlu(code) { if (!ready) return { notReady: true }; return code === 4011 ? { plu: 4011, name: "Bananas", unit: "lb", price: 0.58, source: "snapshot", item: corn } : null; },
});

test("resolution order: exact item first, retired listings kept behind the primary", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "078742054261");
  assert.equal(r.kind, "exact"); assert.equal(r.priceCents, 87); assert.equal(r.item.id, 1); assert.equal(r.others.length, 1);
  assert.equal(kindLabel(r), "Exact item");
  const r2 = await resolveCode(db, "0078742054261");           // EAN-13 form of the same UPC
  assert.equal(r2.gtin, "00078742054261");
  const r3 = await resolveCode(db, "07874205426");             // typed without the check digit
  assert.equal(r3.kind, "exact");
  const pref = await resolveCode(db, "078742054261", undefined, { preferId: 2 });   // a recent row remembers which listing it was
  assert.equal(pref.item.id, 2); assert.equal(pref.others[0].id, 1);
});

test("a UPC-E that the crawler keyed as 8 zero-padded digits is still found", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "04252614", "upc_e", { scanned: true });
  assert.equal(r.kind, "exact"); assert.equal(r.item.id, 9); assert.equal(r.gtin, "00000004252614");
  assert.deepEqual(db.calls, [42100005264, 4252614]);
});

test("store-printed price labels decode when the barcode is not a Walmart listing; a zero price never shows as $0.00", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "201234928751");
  assert.equal(r.kind, "store-label"); assert.equal(r.priceCents, 2875); assert.equal(r.label.verified, true);
  assert.deepEqual(db.calls, [201234928751]);                  // the barcode is looked up first (audit W8-02)
  const zero = await resolveCode(db, "212345000007");          // price field 0000: a manufacturer variable-measure code
  assert.equal(zero.kind, "exact"); assert.equal(zero.item.id, 7);
  const zeroUnknown = await resolveCode(db, "212346000006");
  assert.equal(zeroUnknown.kind, "unknown"); assert.equal(zeroUnknown.priceCents, null); assert.equal(zeroUnknown.noPrice, true);
  assert.match(notesFor(zeroUnknown)[0].text, /has no encoded price/);
  const typo = await resolveCode(db, "201234928759");          // bad check digit
  assert.equal(typo.kind, "store-label"); assert.equal(typo.label.verified, false);
  assert.match(notesFor(typo).map((n) => n.text).join(" "), /check digit does not match/);
});

test("a Walmart listing whose barcode starts with 2 opens that listing, not a price read from its digits (audit W8-02)", async () => {
  const db = mkDb();
  const ham = await resolveCode(db, "213571107096", "upc_a", { scanned: true });   // read as a label: a 5-digit price of $107.09
  assert.equal(ham.kind, "exact"); assert.equal(ham.item.id, 11); assert.equal(ham.priceCents, 4900); assert.equal(ham.gtin, "00213571107096");
  const ean = await resolveCode(db, "0213571107096");           // the EAN-13 form of the same code
  assert.equal(ean.kind, "exact"); assert.equal(ean.item.id, 11);
  const cold = mkDb({ ready: false });                          // while the list loads, a label still reads its price
  const r = await resolveCode(cold, "201234928751");
  assert.equal(r.kind, "store-label"); assert.equal(r.priceCents, 2875);
  const zero = await resolveCode(cold, "212345000007");
  assert.equal(zero.kind, "not-ready");
  const typed11 = await resolveCode(db, "20123492875");         // 11 typed digits: never completed, never looked up
  assert.equal(typed11.kind, "store-label"); assert.equal(typed11.priceCents, 2875); assert.equal(db.calls.includes(201234928751), false);
});

test("no live check is offered for a code the Worker always refuses (a 2-prefix Walmart listing)", () => {
  assert.equal(liveCheckable("00213571107096"), false);         // the gift ham above: the Worker answers 400
  assert.equal(liveCheckable("00078742054261"), true);
  assert.equal(liveCheckable("05000112637922"), true);          // EAN-13
  assert.equal(liveCheckable("00000004252614"), true);          // an 8-digit key
  assert.equal(liveCheckable("02000000000000"), true);          // 13 digits starting 2 after the zero: an EAN-13, accepted there
  assert.equal(liveCheckable(null), false); assert.equal(liveCheckable(""), false);
});

test("an 11-digit typed label whose price digits fail is not said to fail a check digit (audit W8-03)", async () => {
  const db = mkDb();
  const r11 = await resolveCode(db, "20123420699");
  assert.equal(r11.kind, "unknown"); assert.equal(r11.badDigits, true); assert.equal(r11.priceCents, null);
  const t11 = notesFor(r11).map((n) => n.text).join(" ");
  assert.doesNotMatch(t11, /check digit|check-digit/); assert.match(t11, /price digits fail their check/); assert.match(t11, /all 12 digits/);
  const r12 = await resolveCode(db, "201234206991");             // 12 digits, verifier and check digit both wrong
  assert.equal(r12.badDigits, true);
  assert.match(notesFor(r12).map((n) => n.text).join(" "), /failed its check-digit test/);
});

test("PLU codes price produce by the pound, organic 9-prefix included", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "4011");
  assert.equal(r.kind, "plu"); assert.equal(r.unit, "lb"); assert.equal(r.priceCents, 58);
  const o = await resolveCode(db, "94011");
  assert.equal(o.title, "Organic Bananas");
  assert.equal((await resolveCode(db, "4999")).kind, "unknown");
  assert.equal((await resolveCode(db, "83000")).kind, "unknown");   // 8xxxx is its own code, not 3000
});

test("equivalent value is labeled and carries its basis item; a missing basis is flagged", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "4099100000000");
  assert.equal(r.kind, "equivalent"); assert.equal(r.priceCents, 198); assert.equal(r.equiv.basis.id, 1);
  assert.match(notesFor(r).map((n) => n.text).join(" "), /closest Walmart equivalent/);
  const tier = fromItem ? { ...r, equiv: { ...r.equiv, storeTier: true } } : r;
  assert.match(notesFor(tier).map((n) => n.text).join(" "), /store brand: valued at about half/);
  assert.doesNotMatch(notesFor(r).map((n) => n.text).join(" "), /about half/);
  const nb = await resolveCode(db, "4099100000017");
  assert.equal(nb.kind, "equivalent"); assert.equal(nb.equiv.basis, null);
  assert.match(notesFor(nb).map((n) => n.text).join(" "), /no longer listed/);
});

test("unknown barcodes are flagged, never silently priced; text is not a code; a loading pack says so", async () => {
  const db = mkDb();
  const r = await resolveCode(db, "012345678905");
  assert.equal(r.kind, "unknown"); assert.equal(r.priceCents, null); assert.equal(r.checkOk, true);
  assert.equal(await resolveCode(db, "peanut butter"), null);
  const cold = mkDb({ ready: false });
  assert.equal((await resolveCode(cold, "078742054261")).kind, "not-ready");
  assert.equal((await resolveCode(cold, "4011")).kind, "not-ready");
  assert.equal(kindLabel({ kind: "not-ready" }), "Price list loading");
  assert.equal(kindLabel({ kind: "exact", item: retired }), "Exact item");   // an older barcode is a chip on the sheet, not a longer label
});

test("titles never repeat the brand", () => {
  assert.deepEqual(splitTitle(corn), { pre: "", brand: "Great Value", rest: " Golden Sweet Whole Kernel Corn, Canned Corn, 15.25 oz Can" });
  assert.deepEqual(splitTitle({ brand: "Great Value", name: "(2 pack) Great Value Peanut Butter, 28 oz" }), { pre: "(2 pack) ", brand: "Great Value", rest: " Peanut Butter, 28 oz" });
  assert.equal(titleOf({ brand: "Great Value", name: "(2 pack) Great Value Peanut Butter, 28 oz" }), "(2 pack) Great Value Peanut Butter, 28 oz");
  assert.equal(titleOf({ brand: "Jif", name: "Creamy Peanut Butter, 16 oz" }), "Jif Creamy Peanut Butter, 16 oz");
  assert.equal(titleOf({ brand: "", name: "Bananas" }), "Bananas");
  const closest = fromItem(corn, { closest: true, query: "corn 40 oz", dropped: ["40"] });
  assert.equal(kindLabel(closest), "Closest match");
  assert.match(notesFor(closest)[0].text, /“40” was ignored/);
});

// ---- price sanity (2026-10-08): a withheld Walmart price is never shown; the item is valued at an equivalent
const withheld = { ...corn, rank: 5, id: 50, upc: "00012345678905", priceCents: 129, priceWithheld: true, rawPriceCents: 1617000,
  valueConfidence: "high", valueBasis: corn, primary: true };
test("a withheld price resolves to an equivalent value with its basis, from a search tap or a scan", async () => {
  const r = fromItem(withheld);
  assert.equal(r.kind, "equivalent"); assert.equal(r.priceCents, 129); assert.equal(kindLabel(r), "Equivalent value");
  assert.equal(r.equiv.basis.id, 1); assert.equal(r.equiv.rawCents, 1617000);
  const note = notesFor(r).map((n) => n.text).join(" ");
  assert.match(note, /\$16,170\.00/); assert.match(note, /closest comparable Walmart item/);
  const db = { async lookupUpc(key) { return key === 12345678905 ? { items: [withheld], equivalent: null } : { items: [], equivalent: null }; } };
  const s = await resolveCode(db, "012345678905");
  assert.equal(s.kind, "equivalent"); assert.equal(s.priceCents, 129); assert.equal(s.gtin, "00012345678905");
});

test("a rough equivalent says how it was valued", () => {
  const r = fromItem({ ...withheld, valueBasis: null, valueConfidence: "rough" });
  assert.match(notesFor(r).map((n) => n.text).join(" "), /typical price of items in its category/);
});

test("a barcode with a plausible listing and a withheld one shows the plausible listing", async () => {
  const db = { async lookupUpc() { return { items: [withheld, { ...corn, id: 51 }], equivalent: null }; } };
  const r = await resolveCode(db, "078742054261");
  assert.equal(r.kind, "exact"); assert.equal(r.item.id, 51); assert.equal(r.others[0].id, 50);
});

test("a discontinued listing says so", () => {
  assert.match(notesFor(fromItem({ ...corn, discontinued: true })).map((n) => n.text).join(" "), /discontinued/);
});

test("a live price must be believable before it can be used", () => {
  assert.equal(livePlausible(296, 300), "ok");
  assert.equal(livePlausible(250, 4925), "ok");            // 19.7x below: still within the 20x line
  assert.equal(livePlausible(98, 4925), "far");            // Pampers 162 ct at $0.98 against a saved $49.25
  assert.equal(livePlausible(500000, 2000), "far");
  assert.equal(livePlausible(5, null), "implausible");      // under $0.10
  assert.equal(livePlausible(2_000_000, null), "implausible");
  assert.equal(livePlausible(NaN, 100), "implausible");
  assert.equal(livePlausible(1999, null), "ok");            // an unknown barcode: only the absolute range applies
});

test("an equivalent's title names the brand once", async () => {
  const db = { async lookupUpc() { return { items: [], equivalent: { brand: "Rachael Ray Nutrish", name: "Rachael Ray Nutrish Surfin' Turf Cat Food", quantity: "3 lb", estCents: 798, confidence: "medium", basis: null } }; } };
  const r = await resolveCode(db, "071190006114");
  assert.equal(r.kind, "equivalent");
  assert.equal(r.title, "Rachael Ray Nutrish Surfin' Turf Cat Food, 3 lb");
});

test("a price far from items of its size says so", () => {
  const notes = notesFor({ kind: "exact", item: { ...corn, unitSuspect: true } }).map((n) => n.text).join(" ");
  assert.match(notes, /case or multipack/);
});

test("one unit of a \"(N pack)\" bundle listing carries the bundle's price as its alternate and says so", () => {
  const unit = { ...corn, id: 20, upc: null, primary: false, name: "Hefty Ultra Strong 13 Gallon Trash Bags, 40 Bags", brand: "Hefty", priceCents: 1333, packListing: true, listingCents: 7999, listingPack: 6 };
  const r = fromItem(unit);
  assert.equal(r.kind, "exact"); assert.equal(r.priceCents, 1333);
  assert.deepEqual(r.listing, { cents: 7999, n: 6 });
  const notes = notesFor(r).map((n) => n.text);
  assert.ok(notes.some((t) => /only as a pack of 6 \(\$79\.99\)\. The price shown is for one/.test(t)), notes.join(" | "));
  assert.ok(!notes.some((t) => /alternate item/.test(t)), "a row without a barcode is not an alternate listing of one");
  assert.equal(fromItem(corn).listing, undefined);
  // a non-primary listing that does carry a barcode still says it is an alternate
  assert.ok(notesFor(fromItem({ ...corn, primary: false })).some((n) => /alternate item/.test(n.text)));
});

test("live listings that are \"(N pack)\" bundles are read as N units", () => {
  assert.deepEqual(packListingOf("(6 pack) Hefty Trash Bags, 40 Bags"), { n: 6, name: "Hefty Trash Bags, 40 Bags" });
  assert.deepEqual(packListingOf("(2 pack) (6 Pack) Crest Toothpaste 6.4 oz."), { n: 6, name: "Crest Toothpaste 6.4 oz." });
  assert.equal(packListingOf("(1 pack) Beans"), null); assert.equal(packListingOf("Beans (6 pack)"), null); assert.equal(packListingOf(null), null);
  assert.equal(liveUnitCents({ price: 79.99, name: "(6 pack) Hefty Trash Bags, 40 Bags" }), 1333);
  assert.equal(liveUnitCents({ price: 10.52, name: "Hefty Trash Bags, 40 Bags" }), 1052);
  assert.ok(Number.isNaN(liveUnitCents({ price: "x" })));
});

// ---- other chains' store brands and remembered matches (2026-10-19)
const PREFIXES = { "0096619": { store: "Costco", brand: "Kirkland Signature" }, "0030034": { store: "Giant Eagle", brand: "Giant Eagle" }, "4099100": { store: "Aldi", brand: "Aldi" } };
test("a barcode under a listed store's company prefix is named by its store even when nothing else is known", async () => {
  assert.deepEqual(storeOfCode("00096619261574", PREFIXES), { store: "Costco", brand: "Kirkland Signature", prefix: "0096619" });
  assert.equal(storeOfCode("00078742054261", PREFIXES), null);
  assert.equal(storeOfCode("04099100000000", PREFIXES).store, "Aldi");          // an EAN-13 (Aldi Sued) code
  const db = mkDb();
  const r = await resolveCode(db, "096619261574", undefined, { prefixes: PREFIXES });   // the owner's Aller-Tec can, not on file
  assert.equal(r.kind, "unknown"); assert.equal(r.store.store, "Costco"); assert.equal(r.title, "Kirkland Signature item (Costco)");
  assert.match(notesFor(r).map((n) => n.text).join(" "), /Costco's Kirkland Signature brand.*remembers the match/);
  const aldi = await resolveCode(db, "4099100012345", undefined, { prefixes: PREFIXES, learned: () => null });   // an Aldi code nothing knows
  assert.equal(aldi.title, "Aldi item", "the brand is the store's name: said once");
  assert.match(notesFor(aldi)[0].text, /belongs to Aldi's own brand/);
  assert.equal(whoseBrand({ brand: "Kirkland", store: "Costco" }), "Costco's own brand");
  assert.equal(whoseBrand({ brand: "Aldi", store: "Aldi" }), "Aldi's own brand");
  assert.equal(whoseBrand({ brand: "Food Club", store: "another grocer" }), "a store brand of another grocer");
  const plain = await resolveCode(db, "012345678905", undefined, { prefixes: PREFIXES });
  assert.equal(plain.store, undefined); assert.match(notesFor(plain)[0].text, /remembers the match/);
});

test("a barcode this phone matched before resolves to that Walmart item, labelled as a remembered match", async () => {
  const db = mkDb();
  const learned = { "00096619261574": { key: 78742054261, title: "Great Value Golden Sweet Whole Kernel Corn", at: Date.UTC(2026, 9, 19) } };
  const r = await resolveCode(db, "096619261574", undefined, { prefixes: PREFIXES, learned: (g) => learned[g] || null });
  assert.equal(r.kind, "closest"); assert.equal(r.item.id, 1); assert.equal(r.gtin, "00096619261574"); assert.equal(r.key, "g:00096619261574");
  assert.equal(r.priceCents, 87); assert.equal(kindLabel(r), "Closest match");
  const note = notesFor(r).map((n) => n.text).join(" ");
  assert.match(note, /matched to this Walmart item on this phone/); assert.doesNotMatch(note, /No item matched every word/);
  const asMap = await resolveCode(db, "096619261574", undefined, { learned });
  assert.equal(asMap.kind, "closest");
  // the remembered item's own price is withheld now: still a remembered match, valued at its equivalent
  const wdb = { async lookupUpc(key) { return key === 78742054261 ? { items: [withheld], equivalent: null } : { items: [], equivalent: null }; }, async lookupPlu() { return null; } };
  const w = await resolveCode(wdb, "096619261574", undefined, { learned });
  assert.equal(w.kind, "equivalent"); assert.ok(w.learned); assert.ok(notesFor(w).some((n) => /matched to this Walmart item on this phone/.test(n.text)));
  // the remembered item has left the list: back to the unknown sheet, never a blank
  const gone = await resolveCode(db, "096619261574", undefined, { prefixes: PREFIXES, learned: () => ({ key: 999, title: "x", at: 1 }) });
  assert.equal(gone.kind, "unknown"); assert.equal(gone.store.store, "Costco");
});

test("a search that named another store's brand opens the Walmart item as its equivalent", () => {
  const r = fromItem(corn, { query: "kirkland corn", otherBrand: { brand: "Kirkland", store: "Costco" } });
  assert.equal(r.kind, "closest");
  const notes = notesFor(r).map((n) => n.text);
  assert.match(notes[0], /Kirkland is Costco's own brand, which Walmart does not sell/);
  assert.ok(!notes.some((t) => /No item matched every word/.test(t)), "no dropped words: no 'not matched' warning");
  const both = fromItem(corn, { query: "kirkland corn 40 oz", dropped: ["40"], otherBrand: { brand: "Kirkland", store: "Costco" } });
  assert.ok(notesFor(both).some((n) => /“40” was ignored/.test(n.text)));
});

test("a live price above the list's ceiling is implausible; online stock is not a note", () => {
  assert.equal(livePlausible(46058, null, 15000), "implausible");          // $460.58 against a $150 ceiling
  assert.equal(livePlausible(14999, null, 15000), "ok");
  assert.equal(livePlausible(46058, null), "ok");                           // no ceiling stated: the $10,000 line
  assert.ok(!notesFor(fromItem({ ...corn, unavailable: true })).some((n) => /stock/i.test(n.text)));
  assert.ok(notesFor(fromItem({ ...corn, unavailable: true, storePrice: true })).some((n) => /store's shelf/.test(n.text)));
});

test("shared matches fill in behind this phone's own, are labelled as a volunteer's, and leave when the list drops them", async () => {
  const own = { "00096619261574": { key: 78742054261, title: "Great Value Golden Sweet Whole Kernel Corn", at: 5 },
    "00096619000010": { key: 1, title: "old shared", at: 1, shared: true } };
  const shared = [
    { gtin: "00096619261574", upc: "00012345678905", title: "another item", n: 3, at: 9 },      // this phone's own match wins
    { gtin: "00096619000027", upc: "0078742054261", title: "Great Value Golden Sweet Whole Kernel Corn", n: 1, at: 7 },
    { gtin: "0096619000027", upc: "0078742054261", title: "bad gtin", n: 1, at: 7 },
    { gtin: "00096619000034", upc: "x", title: "bad upc", n: 1, at: 7 },
  ];
  const merged = mergeLearned(own, shared);
  assert.deepEqual(Object.keys(merged).sort(), ["00096619000027", "00096619261574"]);
  assert.equal(merged["00096619261574"].key, 78742054261); assert.equal(merged["00096619261574"].shared, undefined);
  assert.deepEqual(merged["00096619000027"], { key: 78742054261, title: "Great Value Golden Sweet Whole Kernel Corn", at: 7, shared: true });
  assert.deepEqual(mergeLearned(merged, []), { "00096619261574": own["00096619261574"] });
  assert.deepEqual(mergeLearned(null, "nonsense"), {});
  const db = mkDb();
  const r = await resolveCode(db, "096619000027", undefined, { learned: (g) => merged[g] || null });
  assert.equal(r.kind, "closest"); assert.equal(r.item.id, 1);
  const note = notesFor(r).map((n) => n.text).join(" ");
  assert.match(note, /matched to this Walmart item by a volunteer on/); assert.doesNotMatch(note, /on this phone/);
});

test("the phone keeps its own newest matches; shared ones never push them out (audit 2026-10-21)", () => {
  const learned = {};
  for (let i = 0; i < 600; i++) learned[String(90000000000000 + i)] = { key: 78742054261, title: "Shared", at: 1_000_000 + i, shared: true };
  for (let i = 0; i < 5; i++) learned[String(10000000000000 + i)] = { key: 78742054261, title: "Own", at: i };
  assert.equal(pruneOwnMatches(learned, 500), learned, "5 own matches, 600 shared: nothing is removed");
  const many = {};
  for (let i = 0; i < 503; i++) many[String(10000000000000 + i)] = { key: 1, title: "Own", at: i };
  many["90000000000001"] = { key: 2, title: "Shared", at: 0, shared: true };
  const kept = pruneOwnMatches(many, 500);
  assert.equal(Object.values(kept).filter((m) => !m.shared).length, 500, "own matches are capped at 500");
  assert.ok(!kept["10000000000000"] && !kept["10000000000002"] && kept["10000000000003"], "the oldest own matches go first");
  assert.ok(kept["90000000000001"], "a shared match is left alone");
});

// ---- every item valued at Walmart's value brand (owner, 2026-10-26): the worker attaches item.gv
const gvRigatoni = { ...corn, rank: 70, id: 70, brand: "Great Value", name: "Great Value Rigatoni, 16 oz", priceCents: 136, size: 16, cat: 7, upc: "00078742000001" };
const barilla = { ...corn, rank: 71, id: 71, brand: "Barilla", name: "Barilla Classic Rigatoni Pasta, 16 oz", priceCents: 188, size: 16, cat: 7, storeBrand: false, upc: "00076808000001",
  gv: { cents: 136, ownCents: 188, brand: "Great Value", basis: gvRigatoni, scaled: false, confidence: "high" } };
test("an item with a value-brand equivalent is valued at it, and its own price is one choice away", () => {
  const r = fromItem(barilla);
  assert.equal(r.kind, "exact"); assert.equal(r.priceCents, 136); assert.equal(r.gv.brand, "Great Value");
  assert.match(notesFor(r)[0].text, /Valued at its Great Value equivalent, Great Value Rigatoni, 16 oz\. This brand's own Walmart price is \$1\.88/);
  const own = valueAt(r, r.item, true);
  assert.equal(own.priceCents, 188); assert.equal(own.useOwn, true);
  assert.match(notesFor(own)[0].text, /own Walmart price, as chosen.*would be \$1\.36/);
  assert.equal(valueAt(own, own.item, false).priceCents, 136, "and back");
  const scaled = fromItem({ ...barilla, gv: { ...barilla.gv, cents: 102, scaled: true } });
  assert.match(notesFor(scaled)[0].text, /priced by the ounce for this item's size/);
});

test("a bundle listing's alternate follows the value: N times the unit's equivalent", () => {
  const unit = { ...barilla, packListing: true, listingCents: 1128, listingPack: 6 };
  const r = fromItem(unit);
  assert.deepEqual(r.listing, { cents: 136 * 6, n: 6 });
  assert.deepEqual(valueAt(r, unit, true).listing, { cents: 1128, n: 6 });
});

test("an item with no value-brand equivalent keeps its own price and says why", () => {
  const r = fromItem({ ...barilla, gv: undefined, gvNone: true });
  assert.equal(r.priceCents, 188);
  assert.match(notesFor(r)[0].text, /no close equivalent under its own value brands/);
});

test("a barcode Walmart does not sell moves to the value-brand level of the item it was valued from", async () => {
  const basis = { ...barilla, priceCents: 200, gv: { ...barilla.gv, cents: 120, ownCents: 200 } };
  const db = { async lookupUpc(key) { return key === 4099100000000 ? { items: [], equivalent: { brand: "Mueller's", name: "Rigatoni", quantity: "16 oz", estCents: 180, confidence: "high", basis } } : { items: [], equivalent: null }; } };
  const r = await resolveCode(db, "4099100000000");
  assert.equal(r.kind, "equivalent"); assert.equal(r.priceCents, Math.round((180 * 120) / 200)); assert.equal(r.gv.viaBasis, true);
  const tier = { async lookupUpc() { return { items: [], equivalent: { brand: "Clancy's", name: "Rigatoni", quantity: "16 oz", estCents: 90, confidence: "high", basis, storeTier: true } }; } };
  assert.equal((await resolveCode(tier, "4099100000000")).priceCents, 90, "another chain's store brand is already at that level");
});
