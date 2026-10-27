// resolve.js — turns a scanned/typed code or a chosen search hit into a priced resolution, following
// docs/WORKFLOW.md: exact item (incl. retired UPCs) → store-printed price label → produce PLU →
// equivalent value (basis item shown) → closest match (flagged). A resolution always carries a price unless
// the code is simply unknown, in which case the UI offers the name search and the live Walmart check.

import { classifyCode, formatGtin, toGtin14 } from "./barcode.js";

export const KIND_LABEL = {
  exact: "Exact item",
  closest: "Closest match",
  "store-label": "Store price label",
  plu: "Produce code",
  equivalent: "Equivalent value",
  live: "Live Walmart price",
  unknown: "Not in price list",
  "not-ready": "Price list loading",
};

export function kindLabel(res) {
  return KIND_LABEL[res.kind] || res.kind;
}

/** Walmart names usually already start with the brand ("Great Value Peanut Butter…"); never print it twice. */
export function splitTitle(item) {
  const brand = (item.brand || "").trim(), name = (item.name || "").trim();
  if (!brand) return { pre: "", brand: "", rest: name };
  const i = name.toLowerCase().indexOf(brand.toLowerCase());
  if (i >= 0) return { pre: name.slice(0, i), brand: name.slice(i, i + brand.length), rest: name.slice(i + brand.length) };   // "(2 pack) Great Value …"
  return { pre: "", brand, rest: ` ${name}` };
}
export function titleOf(item) {
  const { pre, brand, rest } = splitTitle(item);
  return (pre + brand + rest).trim();
}

export function sizeText(item) {
  if (item.size && item.unit) return `${fmtNum(item.size)} ${item.unit}`;
  return "";
}
/** How many pieces one listing holds, for pricing one of them: its pack, else the count its name states ("26.4 oz,
 * 12 Count": a box of 12 bars), else 1. Sold by the pound: 1. */
export function piecesOf(item) {
  if (!item || item.basis === "lb") return 1;
  return item.pack > 1 ? item.pack : item.pieces > 1 ? item.pieces : 1;
}
/** "Pack of 6", or "Count of 12" for a count read from the name, unless the size already says it ("40 ct"). */
export function countText(item) {
  if (!item) return "";
  if (item.pack > 1) return `Pack of ${item.pack}`;
  const n = piecesOf(item);
  return n > 1 && !(item.unit === "ct" && Math.round(item.size) === n) ? `Count of ${n}` : "";
}

function moneyText(cents) {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "";
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, "");
}

/** "Costco's own brand", "a store brand of another grocer", "Aldi's own brand" (the brand is the store's name). */
export function whoseBrand({ brand, store }) {
  if (!store) return "a store brand";
  if (/^(a|an|another|other)\s/i.test(store)) return `a store brand of ${store}`;
  return `${store}'s own brand`;
}

/** The store whose company prefix a barcode starts with (data/brands.json via the manifest: {prefix: {store, brand}}),
 * or null. The prefix is compared with the 13-digit form of the code. */
export function storeOfCode(gtin14, prefixes) {
  if (!gtin14 || !prefixes) return null;
  const ean = String(gtin14).padStart(14, "0").slice(1);
  let best = null;
  for (const [p, v] of Object.entries(prefixes)) if (ean.startsWith(p) && (!best || p.length > best.p.length)) best = { p, v };
  return best ? { store: best.v.store, brand: best.v.brand, prefix: best.p } : null;
}

/** Resolution from a search hit the volunteer tapped (or the listing a barcode found). otherBrand: the other chain's
 * store brand the query named (the item is Walmart's equivalent); learned: a match remembered on this phone.
 * An item with a value-brand equivalent (item.gv, from the worker) is valued at it: Great Value's price for the same
 * product, scaled to the item's size (owner, 2026-10-26); the item's own Walmart price stays on the resolution as
 * gv.ownCents, and useOwn() switches to it when the volunteer says the equivalent is not the same product. */
export function fromItem(item, { closest = false, query = "", dropped = [], otherBrand = null, learned = null } = {}) {
  if (item.gv) return valueAt(fromItem({ ...item, gv: undefined, priceWithheld: false }, { closest, query, dropped, otherBrand, learned }), item, false);
  if (item.priceWithheld) {
    // Walmart's own price for this listing is implausible (data/gates.json price_sanity): the snapshot values it at an
    // equivalent instead, so the volunteer still gets a sensible value and sees where it came from
    return {
      kind: "equivalent", code: item.upc, gtin: item.upc, item, others: [],
      equiv: { withheld: true, rawCents: item.rawPriceCents, confidence: item.valueConfidence, basis: item.valueBasis },
      priceCents: item.priceCents, unit: item.basis === "lb" ? "lb" : "each", title: titleOf(item),
      key: item.upc ? `g:${item.upc}` : `r:${item.rank}`, query, dropped,
      ...(otherBrand ? { otherBrand } : {}), ...(learned ? { learned } : {}),
    };
  }
  return {
    kind: closest || otherBrand || learned ? "closest" : "exact",
    code: item.upc, gtin: item.upc, item, others: [],
    priceCents: item.priceCents,
    unit: item.basis === "lb" ? "lb" : "each",
    title: titleOf(item),
    key: item.upc ? `g:${item.upc}` : `r:${item.rank}`,
    query, dropped,
    ...(otherBrand ? { otherBrand } : {}), ...(learned ? { learned } : {}),
    // Walmart listed the item only as a "(N pack)" bundle: the price is one unit of it; the bundle's own price is the
    // alternate the sheet offers (a volunteer may hold the whole bundle)
    ...(item.packListing && item.listingCents > 0 && item.listingPack > 1 ? { listing: { cents: item.listingCents, n: item.listingPack } } : {}),
  };
}

// ---- a size typed with the search ("green beans 20 oz"): an item tapped in another size is priced for the size typed, by
// the ounce or count (owner, 2026-10-27: the volunteer types the size on the box, and Walmart's brand may not sell it)
const MEASURE = { oz: ["oz", 1], lb: ["oz", 16], g: ["oz", 0.035274], kg: ["oz", 35.274], "fl oz": ["oz", 1], ml: ["oz", 0.033814],
  l: ["oz", 33.814], gal: ["oz", 128], qt: ["oz", 32], pt: ["oz", 16], ct: ["ct", 1] };
/** The resolution with the size typed ({ dim, qty, text } from tokenize.typedSize), when the item is sized in the same
 * measure, more than 3% off it and within a quarter to four times it; the size typed is then the one priced (useTyped). */
export function withTypedSize(res, size) {
  const it = res?.item;
  if (!size || !it || res.unit === "lb" || res.priceCents == null || !(it.size > 0)) return res;
  const m = MEASURE[it.unit];
  if (!m || m[0] !== size.dim) return res;
  const ratio = size.qty / (it.size * m[1]);
  if (Math.abs(ratio - 1) <= 0.03 || ratio > 4 || ratio < 0.25) return res;
  const out = { ...res, typed: { text: size.text, qty: size.qty, per: it.size * m[1] }, useTyped: true };
  out.unitCents = typedCents(out);
  return out;
}
/** The price of one item of the size typed: the listing's price per ounce or count (one piece of a pack), times that size. */
export function typedCents(res) {
  return Math.round((res.priceCents / piecesOf(res.item) / res.typed.per) * res.typed.qty);
}

/** A resolution of an item with a value-brand equivalent, valued at the equivalent (own = false) or at the item's own
 * Walmart price (own = true). The bundle alternate of a "(N pack)" listing follows: N times the unit's value. */
export function valueAt(res, item, own) {
  const g = item.gv;
  const cents = own ? g.ownCents : g.cents;
  const out = { ...res, item, gv: g, useOwn: own, priceCents: cents, unitCents: null, packOne: false, packListing: false };
  if (res.listing) out.listing = { ...res.listing, cents: own ? item.listingCents : g.cents * res.listing.n };
  if (out.typed && out.useTyped) out.unitCents = typedCents(out);
  return out;
}

// Walmart's bundle listings start with "(N pack)" / "(N pk)" / "(N-Pack)" and are priced for all N units (the crawler's
// normalize.pack_listing rule, measured 2026-10-19). The live check applies the same reading to the listings Walmart
// returns, so a live bundle price is never compared with, or used as, the price of one unit.
const PACK_LISTING_RX = /^\s*(?:\(\s*\d+\s*-?\s*(?:pack|pk)\s*\)\s*)+/i;
export function packListingOf(name) {
  const m = PACK_LISTING_RX.exec(String(name ?? ""));
  if (!m) return null;
  const counts = [...m[0].matchAll(/\(\s*(\d+)\s*-?\s*(?:pack|pk)\s*\)/gi)].map((x) => Number(x[1]));
  const n = Math.max(0, ...counts);
  return n > 1 ? { n, name: String(name).slice(m[0].length).trim() } : null;
}
/** A live listing's price for one unit: its price, or a bundle listing's price divided by its count. */
export function liveUnitCents(listing) {
  const cents = Math.round(Number(listing?.price) * 100);
  if (!Number.isFinite(cents)) return NaN;
  const w = packListingOf(listing?.name);
  return w ? Math.round(cents / w.n) : cents;
}

/** Pick the listing for a barcode: the one whose Walmart id the caller wants, else the primary (first). */
function pickListing(items, preferId) {
  if (preferId != null) { const i = items.findIndex((it) => String(it.id) === String(preferId)); if (i > 0) return [items[i], ...items.filter((_, k) => k !== i)]; }
  // a listing with Walmart's own (plausible) price beats one whose price was withheld
  if (items.length > 1 && items[0].priceWithheld) { const i = items.findIndex((it) => !it.priceWithheld); if (i > 0) return [items[i], ...items.filter((_, k) => k !== i)]; }
  return items;
}

/**
 * Resolve any code (scanned or typed digits). Returns null when the text isn't a code at all.
 * @param {{lookupPlu:Function, lookupUpc:Function}} db
 * @param {object} [opts] scanned: the code came from the camera (no typed-input heuristics); preferId: Walmart id to prefer among listings;
 *   prefixes: the manifest's barcode company prefixes ({prefix: {store, brand}}); learned: gtin14 -> {key, title, at} | null,
 *   the matches remembered on this phone (a barcode nothing knew, matched by a search by name and added to the tally)
 */
export async function resolveCode(db, raw, format, { scanned = false, preferId = null, prefixes = null, learned = null } = {}) {
  const cls = classifyCode(raw, format, { scanned });
  if (cls.kind === "text") return null;

  if (cls.kind === "plu") {
    const e = await db.lookupPlu(cls.plu);
    if (e?.notReady) return { kind: "not-ready", code: cls.digits, title: "The price list is still loading", priceCents: null, unit: "each", key: `n:${cls.digits}` };
    if (e) {
      return {
        kind: "plu", code: cls.digits, plu: cls, entry: e, item: e.item || null,
        priceCents: Math.round(e.price * 100), unit: e.unit === "lb" ? "lb" : "each",
        title: (cls.organic ? "Organic " : "") + e.name, key: `p:${cls.digits}`,
      };
    }
    return { kind: "unknown", code: cls.digits, codeType: "PLU", title: `Produce code ${cls.digits}`, priceCents: null, unit: "each", key: `u:${cls.digits}` };
  }

  if (cls.kind === "store-label") {
    // A Walmart listing whose own barcode starts with 2 (about 1,700 in the list: gift hams, steaks, some toys) is that
    // listing, not a scale label: the barcode is looked up first, as the resolve order says (barcode, then store label;
    // decision 2026-10-06). Read as a label it showed a price made of its digits ($49 ham as $107.09; audit W8-02,
    // 2026-10-21). A real scale label is not in the list, and while the list loads the label is read as before.
    const g = toGtin14(cls.digits, undefined, { scanned: true });     // null for 11 typed digits: never completed
    const r = g ? await db.lookupUpc(g.key) : null;
    if (r?.items?.length) { const [item, ...others] = pickListing(r.items, preferId); return { ...fromItem(item), others, gtin: g.gtin14, code: cls.digits, scanned: g }; }
    if (cls.priceCents == null) {
      // a digit does not check out: no price is better than a wrong one
      return { kind: "unknown", code: cls.digits, codeType: "store-label", badDigits: true, noPrice: true, title: `Label ${formatGtin(cls.digits)}`, priceCents: null, unit: "each", key: `u:${cls.digits}` };
    }
    if (cls.priceCents > 0) {
      return {
        kind: "store-label", code: cls.digits, label: cls, priceCents: cls.priceCents, unit: "each",
        title: "Store-priced item (meat, deli, bakery or weighed produce)", key: `l:${cls.digits}`,
      };
    }
    // a 2-prefix code with no price encoded is a manufacturer's variable-measure code (not in the list: looked up above),
    // never shown as $0.00
    if (r?.notReady) return { kind: "not-ready", code: cls.digits, title: "The price list is still loading", priceCents: null, unit: "each", key: `n:${cls.digits}` };
    return { kind: "unknown", code: cls.digits, gtin: g?.gtin14 || null, codeType: "store-label", noPrice: true, title: `Label ${formatGtin(cls.digits)}`, priceCents: null, unit: "each", key: `u:${cls.digits}` };
  }

  // GTIN (try the alternate 8-digit interpretation too, so UPC-E and EAN-8 keyed rows are both found)
  let r = await db.lookupUpc(cls.key);
  if (r?.notReady) return { kind: "not-ready", code: cls.digits, gtin: cls.gtin14, title: "The price list is still loading", priceCents: null, unit: "each", key: `n:${cls.gtin14}` };
  let gtin = cls.gtin14;
  if (!r?.items?.length && !r?.equivalent && cls.altKey) {
    const r2 = await db.lookupUpc(cls.altKey);
    if (r2?.items?.length || r2?.equivalent) { r = r2; gtin = String(cls.altKey).padStart(14, "0"); }
  }
  if (r?.items?.length) {
    const [item, ...others] = pickListing(r.items, preferId);
    return { ...fromItem(item), others, gtin, code: cls.digits, scanned: cls };
  }
  if (r?.equivalent) {
    const e = r.equivalent;
    const title = titleOf({ brand: e.brand, name: e.name }) + (e.quantity ? `, ${e.quantity}` : "");   // the brand once
    // the Walmart item it was valued from has a value-brand equivalent: the estimate moves to that price level, as every
    // item's value does (another chain's store brand is already at it: storeTier)
    const b = e.basis;
    let priceCents = e.estCents, gv = null;
    if (!e.storeTier && b?.gv && b.priceCents > 0 && e.estCents > 0) {
      const cents = Math.round((e.estCents * b.gv.cents) / b.priceCents);
      if (cents > 0 && cents < e.estCents) { priceCents = cents; gv = { ...b.gv, cents, ownCents: e.estCents, viaBasis: true }; }
    }
    return { kind: "equivalent", code: cls.digits, gtin, equiv: e, priceCents, ...(gv ? { gv } : {}), unit: "each", title, key: `e:${gtin}`, scanned: cls };
  }
  // a barcode this phone matched before (a search by name, added to the tally): the same Walmart item, by its own barcode
  const mem = typeof learned === "function" ? learned(cls.gtin14) : learned?.[cls.gtin14];
  if (mem?.key) {
    const r3 = await db.lookupUpc(mem.key);
    if (r3?.items?.length) {
      const [item, ...others] = pickListing(r3.items, null);
      return { ...fromItem(item, { learned: mem }), others, gtin: cls.gtin14, code: cls.digits, scanned: cls, key: `g:${cls.gtin14}` };
    }
  }
  const store = storeOfCode(cls.gtin14, prefixes);
  return {
    kind: "unknown", code: cls.digits, gtin: cls.gtin14, codeType: cls.type, checkOk: cls.checkOk, ...(store ? { store } : {}),
    title: store ? (store.brand === store.store ? `${store.brand} item` : `${store.brand} item (${store.store})`) : `Barcode ${formatGtin(cls.gtin14)}`, priceCents: null, unit: "each", key: `u:${cls.gtin14}`, scanned: cls,
  };
}

/** Whether the Worker's live check can price this barcode: it prices Walmart barcodes only, and a 12-digit code starting
 *  with 2 (a store's own number range, used by a few Walmart listings such as gift hams) is always refused there
 *  (pipeline/src/index.js parseGtin), so no check is offered for it. */
export function liveCheckable(gtin) {
  const d = String(gtin || "").replace(/^0+(?=\d{12}$)/, "");
  return /^\d{8,14}$/.test(d) && !(d.length === 12 && d[0] === "2");
}

/** This phone's remembered matches merged with the shared list (the Worker's /v1/learned): a match made on this phone
 *  stays as it is; a shared one fills every other barcode, marked `shared`, and leaves again when the list drops it.
 *  gtin14 -> {key, title, at, shared?}. */
export function mergeLearned(local, shared) {
  const out = {};
  for (const [g, m] of Object.entries(local || {})) if (m && m.key && !m.shared) out[g] = m;
  for (const e of Array.isArray(shared) ? shared : []) {
    const gtin = String(e?.gtin || ""), upc = String(e?.upc || "");
    if (!/^\d{14}$/.test(gtin) || !/^\d{8,14}$/.test(upc) || out[gtin]) continue;
    out[gtin] = { key: Number(upc), title: String(e.title || "").slice(0, 120), at: Number(e.at) || 0, shared: true };
  }
  return out;
}

/** At most `max` of this phone's own matches, the newest kept; shared matches (the Worker's list, up to 5,000) are left as
 *  they are and never count against the phone's own (they come back with every sync). Audit 2026-10-21: counting them
 *  deleted a phone's own older matches once the shared list passed about 500 rows. */
export function pruneOwnMatches(learned, max) {
  const own = Object.keys(learned || {}).filter((g) => learned[g] && !learned[g].shared);
  if (own.length <= max) return learned;
  const out = { ...learned };
  for (const g of own.sort((a, b) => (learned[a].at || 0) - (learned[b].at || 0)).slice(0, own.length - max)) delete out[g];
  return out;
}

/** Human notes that explain the price's provenance; shown under the title. */
export function notesFor(res, ctx = {}) {
  const notes = [];
  const it = res.item;
  if (res.asideBrand) notes.push({ tone: "equiv", text: `${res.asideBrand} is not a Walmart brand. This is Walmart's own version of the item.` });
  if (res.typed && res.useTyped) notes.push({ tone: "equiv", text: `Priced for ${res.typed.text}, the size typed, from this item's price per ${res.typed.qty && it?.unit === "ct" ? "count" : "ounce"}. Walmart lists it as ${sizeText(it)}.` });
  if (res.gv) {
    const g = res.gv, b = g.basis;
    const per = b?.unit === "ct" ? "count" : "ounce";
    if (res.useOwn) notes.push({ tone: "", text: `Valued at this item's own Walmart price, as chosen. Its ${g.brand} equivalent, ${titleOf(b)}, would be ${moneyText(g.cents)}.` });
    else if (g.viaBasis) notes.push({ tone: "equiv", text: `Valued at the ${g.brand} price level of the Walmart item it was compared with (${moneyText(g.ownCents)} at that item's own price).` });
    else notes.push({ tone: "equiv", text: `Valued at its ${g.brand} equivalent, ${titleOf(b)}${g.scaled ? `, priced by the ${per} for this item's size` : ""}. This brand's own Walmart price is ${moneyText(g.ownCents)}.` });
  } else if (it?.gvNone && (res.kind === "exact" || res.kind === "closest")) {
    notes.push({ tone: "", text: "Walmart sells no close equivalent under its own value brands (Great Value, Equate and the like), so this item's own Walmart price is used." });
  }
  if (res.otherBrand) {
    notes.push({ tone: "equiv", text: `${res.otherBrand.brand} is ${whoseBrand(res.otherBrand)}, which Walmart does not sell. This Walmart item is its equivalent, and Walmart's own brand is the same price tier.` });
  }
  if (res.learned) {
    const who = res.learned.shared ? "by a volunteer" : "on this phone";
    notes.push({ tone: "equiv", text: `This barcode is not in the price list. It was matched to this Walmart item ${who}${res.learned.at ? ` on ${new Date(res.learned.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""} by a search by name. If this is not the right item, search by name again.` });
  }
  if (res.kind === "closest" && !res.learned && (res.dropped?.length || !res.otherBrand)) {
    notes.push({ tone: "warn", text: `No item matched every word of “${res.query}”${res.dropped?.length ? `; “${res.dropped.join(" ")}” was ignored` : ""}. Check the type and size against the donated item.` });
  }
  if (res.kind === "equivalent" && res.equiv.withheld) {
    const e = res.equiv;
    const how = e.basis ? "the closest comparable Walmart item" : e.confidence === "rough" ? "the typical price of items in its category" : "the typical per-unit price of comparable items";
    notes.push({ tone: "equiv", text: `Walmart's listed price${e.rawCents != null ? ` (${moneyText(e.rawCents)})` : ""} is outside the normal range for this kind of item, so it is valued at ${how} instead.` });
  } else if (res.kind === "equivalent") {
    const e = res.equiv;
    notes.push({ tone: "equiv", text: `Not sold at Walmart. Valued at the price of the closest Walmart equivalent by type and size (${e.confidence === "high" ? "close match" : e.confidence === "medium" ? "fair match" : e.confidence === "rough" ? "rough estimate" : "rough match"}).` });
    if (e.storeTier) notes.push({ tone: "equiv", text: "A store brand: valued at about half the comparable national brand's price, the way Walmart's own brands are priced." });
    if (!e.basis) notes.push({ tone: "warn", text: "The Walmart item this estimate was based on is no longer listed, so the value is approximate." });
  }
  if (res.kind === "store-label") {
    // the price line already says the scale printed it; a note appears only when the label needs a second look
    if (res.label.needsConfirm) notes.push({ tone: "warn", text: "This label's price has no check digit of its own. Compare it with the price printed on the label before adding." });
    else if (res.label.checkOk === false) notes.push({ tone: "warn", text: "The barcode's check digit does not match, but the price digits are valid. Compare it with the price printed on the label." });
  }
  if (res.kind === "plu") {
    if (res.entry.source === "typical") notes.push({ tone: "warn", text: "This produce code is not in the current price list. The price shown is the typical Walmart price." });
    if (res.plu.organic) notes.push({ tone: "", text: "Organic (9-prefix). Priced as the conventional item." });
  }
  if (res.kind === "not-ready") {
    notes.push({ tone: "warn", text: "The price list is still loading on this phone. Try again when it is ready." });
  }
  if (res.kind === "unknown") {
    if (res.codeType === "PLU") notes.push({ tone: "warn", text: "This produce code is not in the price list. Search by the produce name instead." });
    else if (res.badDigits && String(res.code).length === 11) notes.push({ tone: "warn", text: "This label's price digits fail their check, so no price can be read from it. Re-enter all 12 digits under the barcode, or search by name." });   // 11 typed digits have no check digit to fail (audit W8-03)
    else if (res.badDigits) notes.push({ tone: "warn", text: "This label failed its check-digit test, so no price can be read from it. Re-enter the number under the barcode, or search by name." });
    else if (res.noPrice) notes.push({ tone: "warn", text: "This label has no encoded price and is not in the price list. Use the price printed on the label, or search by name." });
    else if (res.store) {
      notes.push({ tone: "equiv", text: `This barcode belongs to ${res.store.brand === res.store.store ? `${res.store.store}'s own brand` : `${res.store.store}'s ${res.store.brand} brand`}, which Walmart does not sell, and it is not on file. Search by name to value it at Walmart's own-brand equivalent; this phone remembers the match for the next scan.` });
      if (res.checkOk === false) notes.push({ tone: "warn", text: "The check digit does not match, so a digit may have been mistyped." });
    } else {
      notes.push({ tone: "warn", text: "This barcode is not in the price list and has no equivalent on file. Search by the name and size on the label; this phone remembers the match for the next scan." });
      if (res.checkOk === false) notes.push({ tone: "warn", text: "The check digit does not match, so a digit may have been mistyped." });
    }
  }
  if (res.scanned?.checkOk === null && (res.kind === "exact" || res.kind === "equivalent" || res.kind === "unknown")) {
    notes.push({ tone: "warn", text: "Entered without its check digit, so the barcode cannot be verified. Confirm that the name matches the package." });
  }
  if (it) {
    if (it.retired) notes.push({ tone: "", text: "This is an older barcode for this item. The price shown is the current price." });
    if (it.carried) notes.push({ tone: "equiv", text: `This item's department was not part of the ${ctx.priceDateLong || "latest"} update, so its price is from the previous price list.` });   // a department is re-crawled every 30 days; between runs its rows carry over whole (crawler/process.py)
    if (it.promo) notes.push({ tone: "", text: "This was a Rollback or sale price at the last update." });
    // Walmart's online stock says nothing about a grocery (88% of the list is "not available" online: store-only goods),
    // so only the store's own shelf is worth a note (2026-10-19)
    if (it.unavailable && it.storePrice) notes.push({ tone: "", text: "Not on the store's shelf at the last update. The price is the store's last one." });
    if (it.unitSuspect) notes.push({ tone: "warn", text: "This price is far from similar items of the same size, so the listing may be a case or multipack. Compare the size and count with the item in your hand." });
    if (it.sizeConflict) notes.push({ tone: "", text: "Walmart's listing shows two sizes. The one in the title is used." });
    if (it.discontinued) notes.push({ tone: "", text: "Walmart marks this item as discontinued. The price is the last one listed." });
    if (it.upc && !it.primary && (res.kind === "exact" || res.kind === "closest")) notes.push({ tone: "", text: "Walmart lists this barcode under more than one item. This is an alternate item." });
    if (res.listing) notes.push({ tone: "", text: `Walmart lists this item only as a pack of ${res.listing.n} (${moneyText(res.listing.cents)}). The price shown is for one.` });
  }
  return notes;
}

// A live price goes through the same believability check as a saved one (crawler/valuation.py): between $0.10 and
// the price list's ceiling (the manifest's priceCeiling: nothing above it is in the list, data/categories.json max_price;
// $10,000 when the pack states none), and within 20x of the saved price when there is one. "ok" | "implausible" | "far".
export function livePlausible(liveCents, savedCents, ceilingCents = 1_000_000) {
  if (!Number.isFinite(liveCents) || liveCents < 10 || liveCents > (ceilingCents || 1_000_000)) return "implausible";
  if (savedCents > 0 && (liveCents * 20 < savedCents || liveCents > savedCents * 20)) return "far";
  return "ok";
}
