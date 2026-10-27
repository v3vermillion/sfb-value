// db-worker.js — the database lives here, off the main thread.
//
// Loads an sfb-pack (tools/build-db.mjs describes the layout), keeps its files as typed-array views, and answers:
// search(query) within a frame, lookup(gtin), equivalent(gtin), plu(code), item(id). A format-3 pack is a list of
// shards (one per department); a shard already loaded is kept when a new version still uses the same files, and the
// core shards can be loaded first and the rest added later (load with `only`). Items are stored in rank order within a
// shard (best first), so a bitset scan from rank 0 already yields best-first candidates. An item's id across the pack is
// shard * 2^24 + rank. Format-2 packs load as one shard.
import { tokenize, joinedTokens, headNoun, typedSize } from "./tokenize.js";

const td = new TextDecoder();
const F = { RETIRED: 1, NO_SIZE: 2, PROMO: 4, CARRIED: 8, STORE_BRAND: 16, PRIMARY: 32, SIZE_CONFLICT: 64, UNAVAILABLE: 128 };
const UNIT_NAME = [null, "oz", "fl oz", "lb", "ct", "g", "kg", "ml", "l", "gal", "qt", "pt"];
// category names come from the pack manifest (data/categories.json); this table only covers a pack built before that
const CAT_NAME = { 1: "Produce", 2: "Dairy & Eggs", 3: "Meat & Seafood", 4: "Deli & Prepared Foods", 5: "Frozen Foods", 6: "Canned & Jarred Foods", 7: "Pasta, Rice & Dry Goods", 8: "Bread & Bakery", 9: "Snacks & Candy", 10: "Beverages", 11: "Condiments, Sauces & Spreads", 12: "International Foods", 13: "Baby", 14: "Health & Medicine", 15: "Personal Care", 16: "Household Supplies", 17: "Kitchen & Dining", 18: "Home", 19: "Pet Food & Supplies", 20: "School, Office & Crafts", 21: "Toys, Books & Games", 22: "Seasonal & Party", 23: "Other", 24: "Auto", 25: "Electronics", 26: "Jewelry & Accessories", 27: "Sports & Outdoors", 28: "Baking, Spices & Oils", 29: "Breakfast & Cereal", 30: "Beauty", 31: "Hardware & Tools", 32: "Lawn, Garden & Floral" };
const F2 = { PLACEHOLDER: 1, PRICE_WITHHELD: 2, DISCONTINUED: 4, STORE_PRICE: 32, UNIT_SUSPECT: 64, PACK_LISTING: 128 };
const VALUE_CONF = ["rough", "low", "medium", "high"];
const NO_RANK = 0xFFFFFFFF;
const SHARD_SPAN = 16777216;          // 2^24 ranks per shard in an item id
const gidOf = (si, r) => si * SHARD_SPAN + r;
const splitGid = (g) => [Math.floor(g / SHARD_SPAN), g % SHARD_SPAN];

// Query-time vocabulary: abbreviations volunteers actually type (AND-expansions) and spellings that
// should match each other (OR-groups). Index tokens are never altered; this only widens the query.
const ABBREV = {
  gv: ["great", "value"], pb: ["peanut", "butter"], pbj: ["peanut", "butter"],
  tp: ["toilet", "paper"], hbs: ["head", "shoulders"],
  oj: ["orange", "juice"], aj: ["apple", "juice"], ev: ["extra", "virgin"], evoo: ["extra", "virgin", "olive", "oil"], gf: ["gluten", "free"],
  sf: ["sugar", "free"], ls: ["low", "sodium"], nsa: ["no", "salt", "added"], ww: ["whole", "wheat"], wg: ["whole", "grain"],
  kd: ["kraft", "macaroni"], veg: ["vegetable"], veggies: ["vegetable"], choc: ["chocolate"], vit: ["vitamin"], deod: ["deodorant"],
  shamp: ["shampoo"], cond: ["conditioner"], det: ["detergent"], bbq: ["barbecue"], mayo: ["mayonnaise"], ketchup: ["ketchup"],
  pnut: ["peanut"], spag: ["spaghetti"], marg: ["margarine"], tom: ["tomato"], toms: ["tomato"],
};
const SYNONYM_GROUPS = [
  ["oz", "ounce", "ounces"], ["fl", "fluid"], ["lb", "lbs", "pound", "pounds"], ["ct", "count", "cnt", "pk", "pack", "packs"],
  ["gal", "gallon", "gallons"], ["qt", "quart", "quarts"], ["pt", "pint", "pints"], ["l", "liter", "liters", "litre", "litres", "ltr"], ["ml", "milliliter", "milliliters"],
  ["g", "gram", "grams"], ["kg", "kilogram", "kilograms"], ["and", "n"], ["mac", "macaroni"], ["ketchup", "catsup"], ["soda", "pop"], ["coke", "cocacola"],
  ["diaper", "diapers"], ["wipe", "wipes"], ["tissue", "tissues", "kleenex"], ["bandaid", "bandaids", "bandage", "bandages"],
  ["tuna", "tunafish"], ["ramen", "noodles"], ["cereal", "cereals"], ["bar", "bars"], ["cookie", "cookies"], ["chip", "chips"],
  ["cracker", "crackers"], ["bean", "beans"], ["tomato", "tomatoes"], ["potato", "potatoes"], ["pea", "peas"], ["egg", "eggs"],
  ["sock", "socks"], ["battery", "batteries"], ["candle", "candles"], ["toothbrush", "toothbrushes"], ["pad", "pads"], ["pen", "pens"],
  ["pencil", "pencils"], ["crayon", "crayons"], ["marker", "markers"], ["notebook", "notebooks"], ["towel", "towels"], ["roll", "rolls"],
  ["pretzel", "pretzels"], ["waffle", "waffles"], ["pancake", "pancakes"], ["nugget", "nuggets"], ["bagel", "bagels"], ["muffin", "muffins"],
  ["roll", "rolls"], ["mix", "mixes"], ["sauce", "sauces"], ["spice", "spices"], ["vitamin", "vitamins"], ["supplement", "supplements"],
];
const SYN = new Map();
for (const g of SYNONYM_GROUPS) for (const w of g) SYN.set(w, g);

let db = null;        // { manifest, version, shards: [S], N, eq*, plu, catNames }
const loaded = new Map();   // cols file path -> S, so a new version reuses a shard whose files did not change
const BIT_CACHE_MAX = 64;   // per shard

// ---------------------------------------------------------------- loading
async function readPack(url, cache) {
  // Prefer the app-managed Cache Storage copy; fall back to the network and store it.
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    if (cache) await cache.put(url, res.clone());
  }
  let buf = await res.arrayBuffer();
  const u = new Uint8Array(buf);
  if (u.length > 2 && u[0] === 0x1f && u[1] === 0x8b) {   // gzip magic -> we must inflate ourselves
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(u); w.close();
    buf = await new Response(ds.readable).arrayBuffer();
  }
  return buf;
}

const pad8 = (n) => (n + 7) & ~7;
class Reader {
  constructor(buf) { this.buf = buf; this.dv = new DataView(buf); this.o = 0; }
  magic(expect) { const m = td.decode(new Uint8Array(this.buf, this.o, 4)); if (m !== expect) throw new Error(`bad magic ${m} (want ${expect})`); this.o += 4; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  align() { this.o = pad8(this.o); return this; }
  arr(Ctor, n) { this.align(); const a = new Ctor(this.buf, this.o, n); this.o += n * Ctor.BYTES_PER_ELEMENT; return a; }
  bytes(n) { this.align(); const a = new Uint8Array(this.buf, this.o, n); this.o += n; return a; }
  left() { return this.buf.byteLength - pad8(this.o); }
}

/** The shards a manifest describes, with their file URLs: format 3 lists shards (paths relative to the db folder),
 * format 2 is one shard (paths relative to the version folder). */
export function shardsOf(manifest, root, base) {
  if (manifest.shards) return manifest.shards.map((sh) => ({ ...sh, url: (f) => root + f.path }));
  const f = manifest.files;
  return [{ id: "all", tier: "core", items: manifest.items, files: { cols: f.cols, strings: f.strings, upc: f.upc, tokens: f.tokens }, url: (x) => base + x.path }];
}

async function openShard(sh, cache) {
  const key = sh.url(sh.files.cols);
  if (loaded.has(key)) return loaded.get(key);
  const [cols, upc, tokens, ...strings] = await Promise.all([sh.files.cols, sh.files.upc, sh.files.tokens, ...sh.files.strings].map((f) => readPack(sh.url(f), cache)));
  const S = { shardId: sh.id, tier: sh.tier, key, bitCache: new Map(), headCache: new Map() };   // S.id is the Walmart id column
  { const r = new Reader(cols); r.magic("SFBC"); const N = r.u32(); S.N = N;
    S.price = r.arr(Uint32Array, N); S.size = r.arr(Float32Array, N); S.pack = r.arr(Uint16Array, N); S.unit = r.arr(Uint8Array, N);
    S.basis = r.arr(Uint8Array, N); S.flags = r.arr(Uint8Array, N); S.cat = r.arr(Uint8Array, N); S.id = r.arr(Float64Array, N); S.upcOf = r.arr(Float64Array, N);
    // format 2 appended flags2, the value basis and Walmart's own price of a withheld item; a format-1 pack has none
    if (pad8(r.o) + N * 9 <= cols.byteLength) { S.flags2 = r.arr(Uint8Array, N); S.valueBasis = r.arr(Uint32Array, N); S.rawPrice = r.arr(Uint32Array, N); }
    else { S.flags2 = new Uint8Array(N); S.valueBasis = new Uint32Array(N).fill(NO_RANK); S.rawPrice = new Uint32Array(N); }
    // 2026-10-19 appended the count of a "(N pack)" bundle listing; a pack without it derives N from the two prices
    S.listingPack = pad8(r.o) + N * 2 <= cols.byteLength ? r.arr(Uint16Array, N) : null; }
  S.strings = strings.map((buf) => { const r = new Reader(buf); r.magic("SFBS"); const count = r.u32(), first = r.u32(); const offs = r.arr(Uint32Array, count + 1); const bytes = r.bytes(offs[count]); return { first, count, offs, bytes }; });
  { const r = new Reader(upc); r.magic("SFBU"); const M = r.u32(); S.upcKeys = r.arr(Float64Array, M); S.upcRanks = r.arr(Uint32Array, M); }
  { const r = new Reader(tokens); r.magic("SFBT"); const T = r.u32(), pbytes = r.u32(); const dictOff = r.arr(Uint32Array, T + 1); const dictBytes = r.bytes(dictOff[T]);
    const dict = new Array(T); for (let k = 0; k < T; k++) dict[k] = td.decode(dictBytes.subarray(dictOff[k], dictOff[k + 1]));
    S.dict = dict; S.postOff = r.arr(Uint32Array, T + 1); S.postings = r.bytes(pbytes);
    S.tokCat = r.left() >= T ? r.bytes(T) : new Uint8Array(T);
    if (r.left() >= 4 + 4 * (T + 1)) { r.align(); const hb = r.u32(); S.headOff = r.arr(Uint32Array, T + 1); S.headPostings = r.bytes(hb); }   // format 3
    else { S.headOff = null; S.headPostings = null; } }
  S.words = (S.N + 31) >>> 5;
  loaded.set(key, S);
  return S;
}

function readVersionFile(url, cache, json) {
  return (async () => {
    let res = cache && await cache.match(url);
    if (!res) { res = await fetch(url, { cache: "no-store" }); if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`); if (cache) cache.put(url, res.clone()).catch(() => {}); }
    return json ? JSON.parse(await res.text()) : readPack(url, cache);
  })();
}

/**
 * Open a pack: every shard, or only the ids in `only` (the core first, the rest in a second call with the same
 * manifest). root is the db folder URL, base the version folder URL; cacheName the version's Cache Storage bucket and
 * filesCache the bucket of shard files shared by every version.
 */
async function cachesFor(cacheName, filesCache) {
  // shard files (db/files/) live in the bucket every version shares; manifests and per-version files in the version's
  if (typeof caches === "undefined" || !cacheName) return null;
  const v = await caches.open(cacheName), f = filesCache ? await caches.open(filesCache) : v;
  const pick = (url) => (String(url).includes("/db/files/") ? f : v);
  return { match: (url) => pick(url).match(url), put: (url, res) => pick(url).put(url, res) };
}

const OPEN_PARALLEL = 3;

async function load({ base, root, manifest, cacheName, filesCache, only }) {
  const cache = await cachesFor(cacheName, filesCache);
  root = root || new URL("../", base).href;
  const t0 = performance.now();
  const all = shardsOf(manifest, root, base);
  const want = only ? all.filter((sh) => only.includes(sh.id)) : all;
  const same = db && db.version === manifest.version;
  const opened = new Map(same ? db.shardsById : []);
  const queue = want.filter((sh) => !opened.has(sh.id));
  let done = 0;
  const total = queue.length + (same ? 0 : 2);
  const tick = (file) => postMessage({ type: "progress", done: ++done, total, file });
  // a few shards at a time: the cache reads and the inflate of one overlap the other's, while the memory peak stays at a
  // few shards' compressed bytes (opening every shard at once would hold them all)
  await Promise.all(Array.from({ length: Math.min(OPEN_PARALLEL, queue.length) }, async () => {
    while (queue.length) { const sh = queue.shift(); opened.set(sh.id, await openShard(sh, cache)); tick(sh.id); }
  }));
  const d = same ? db : { manifest, version: manifest.version, shardsById: opened };
  d.shardsById = opened;
  d.shards = all.map((sh) => opened.get(sh.id) || null);      // index = shard number in item ids; null = not loaded yet
  if (!same) {
    const eqFile = manifest.files.equiv;
    const pluFile = manifest.files.plu;
    const eqUrl = manifest.shards ? root + eqFile.path : base + eqFile.path, pluUrl = manifest.shards ? root + pluFile.path : base + pluFile.path;
    // the other brands' names a typed search sets aside (search scope "walmart"): first word -> [{ toks, cat }], longest first
    const brUrl = manifest.files.brands ? (manifest.shards ? root : base) + manifest.files.brands.path : null;
    const [eqBuf, plu, br] = await Promise.all([readVersionFile(eqUrl, cache, false), readVersionFile(pluUrl, cache, true), brUrl ? readVersionFile(brUrl, cache, true).catch(() => null) : null]);
    d.brandPhrases = new Map(); d.brandWords = new Set();
    for (const [ph, v] of Object.entries(br?.phrases || {})) {
      const toks = ph.split(" ");
      const [cat, product] = Array.isArray(v) ? v : [v, ""];
      if (!d.brandPhrases.has(toks[0])) d.brandPhrases.set(toks[0], []);
      d.brandPhrases.get(toks[0]).push({ toks, cat, product, name: ph });
      for (const t of toks) d.brandWords.add(t);
    }
    for (const list of d.brandPhrases.values()) list.sort((a, b) => b.toks.length - a.toks.length);
    tick("equiv"); tick("plu");
    { const r = new Reader(eqBuf); r.magic("SFBE"); const E = r.u32(); d.eqKeys = r.arr(Float64Array, E); d.eqEst = r.arr(Uint32Array, E); d.eqBasis = r.arr(Uint32Array, E);
      d.eqBase = r.arr(Float32Array, E); d.eqPack = r.arr(Uint16Array, E); d.eqUnit = r.arr(Uint8Array, E); d.eqConf = r.arr(Uint8Array, E); d.eqOffs = r.arr(Uint32Array, E + 1); d.eqBytes = r.bytes(d.eqOffs[E]); }
    d.plu = new Map(plu.codes.map((c) => [c.plu, c]));
    d.catNames = manifest.categories || null;
    d.v2 = !manifest.shards;
  }
  // the other chains' store brands (data/brands.json via the manifest), as token runs, longest first
  const titleCase = (s) => String(s).replace(/(^|[\s(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  d.brands = Object.entries(manifest.brands || {}).map(([name, store]) => ({ toks: tokenize(name), name: titleCase(name), store })).filter((b) => b.toks.length).sort((a, b) => b.toks.length - a.toks.length);
  // shards no new version uses are released
  const keep = new Set(d.shards.filter(Boolean).map((S) => S.key));
  for (const k of [...loaded.keys()]) if (!keep.has(k)) loaded.delete(k);
  d.N = d.shards.reduce((a, S) => a + (S ? S.N : 0), 0);
  d.loadMs = Math.round(performance.now() - t0);
  db = d;
  tokCache.clear();
  setTimeout(warm, 0);
  return { items: d.N, upcs: d.shards.reduce((a, S) => a + (S ? S.upcKeys.length : 0), 0), tokens: d.shards.reduce((a, S) => a + (S ? S.dict.length : 0), 0),
    equivalents: d.eqKeys.length, loadMs: d.loadMs, shards: d.shards.filter(Boolean).map((S) => S.shardId), pending: all.filter((sh) => !opened.has(sh.id)).map((sh) => sh.id) };
}

function warm() {
  // the single-character prefixes are the expensive unions: build them in the background, core shards first
  if (!db) return;
  const jobs = [];
  for (const S of db.shards) if (S && !S.warmed) { S.warmed = true; for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") jobs.push([S, c]); }
  for (const S of db.shards) if (S && S.tier !== "more") jobs.push([S, null]);       // the value-brand index of the core shards
  const step = () => { if (!db || !jobs.length) return; const [S, c] = jobs.shift(); if (c === null) gvIndex(S); else prefixBits(S, c); setTimeout(step, 0); };
  step();
}

// ---------------------------------------------------------------- item access
function itemText(S, rank) {
  const s = S.strings.find((sh) => rank >= sh.first && rank < sh.first + sh.count);
  const i = rank - s.first;
  return td.decode(s.bytes.subarray(s.offs[i], s.offs[i + 1]));
}
function itemOf(S, rank, withBasis = true) {
  const si = db.shards.indexOf(S);
  const txt = itemText(S, rank);
  const sep = txt.indexOf("\x1F");
  const flags = S.flags[rank], flags2 = S.flags2[rank];
  const upc = S.upcOf[rank];
  const withheld = !!(flags2 & F2.PRICE_WITHHELD);
  // one unit of a "(N pack)" bundle listing: the bundle's own price rides in rawPrice and its count in listingPack (an older
  // pack derives N from the two prices, which drifts for a unit under about 20 cents)
  const packListing = !withheld && !!(flags2 & F2.PACK_LISTING) && S.rawPrice[rank] > 0 && S.price[rank] > 0;
  const listingCents = packListing ? S.rawPrice[rank] : null;
  const listingPack = packListing ? (S.listingPack && S.listingPack[rank] > 1 ? S.listingPack[rank] : Math.max(2, Math.round(listingCents / S.price[rank]))) : null;
  const basisRank = S.valueBasis[rank];
  return {
    rank: gidOf(si, rank), id: S.id[rank], brand: txt.slice(0, sep), name: txt.slice(sep + 1), priceCents: S.price[rank],
    size: S.size[rank] || null, unit: UNIT_NAME[S.unit[rank]], pack: S.pack[rank], basis: S.basis[rank] ? "lb" : "each",
    cat: S.cat[rank], catName: (db.catNames && db.catNames[S.cat[rank]]) || CAT_NAME[S.cat[rank]] || "Other", upc: upc ? String(upc).padStart(14, "0") : null,
    placeholder: !!(flags2 & F2.PLACEHOLDER), discontinued: !!(flags2 & F2.DISCONTINUED), storePrice: !!(flags2 & F2.STORE_PRICE), unitSuspect: !!(flags2 & F2.UNIT_SUSPECT),
    priceWithheld: withheld, rawPriceCents: withheld ? S.rawPrice[rank] : null, valueConfidence: withheld ? VALUE_CONF[(flags2 >> 3) & 3] : null,
    packListing, listingCents, listingPack, pieces: piecesOf(S, rank, txt.slice(sep + 1)),
    valueBasis: withheld && withBasis && basisRank !== NO_RANK && basisRank !== rank ? itemOf(S, basisRank, false) : null,
    retired: !!(flags & F.RETIRED), noSize: !!(flags & F.NO_SIZE), promo: !!(flags & F.PROMO), carried: !!(flags & F.CARRIED),
    storeBrand: !!(flags & F.STORE_BRAND), primary: !!(flags & F.PRIMARY), sizeConflict: !!(flags & F.SIZE_CONFLICT), unavailable: !!(flags & F.UNAVAILABLE),
  };
}
// how many pieces one listing holds, for "1 of N": its pack, else a count the name states beside a total weight ("26.4 oz,
// 12 Count", "8 ea", "Size 4, 60 Count"), else a count size ("40 Ct"). A "(6 pack)" bundle prefix is not one; 1 when none
const PIECES_RX = /(?<![\d.])(\d{1,3})\s*-?\s*(?:count|ct|cnt|ea|each|pk|bars|pieces|pcs|packets|pouches|cups|cans|bottles|rolls|sticks|pods|squares|cookies|cakes|pies|packs?)\b(?!\s*\))/i;
function piecesOf(S, rank, name) {
  if (S.pack[rank] > 1) return S.pack[rank];
  if (S.basis[rank]) return 1;
  const m = PIECES_RX.exec(name);
  const n = m ? Number(m[1]) : UNIT_NAME[S.unit[rank]] === "ct" ? Math.round(S.size[rank] || 0) : 0;
  return n > 1 && n <= 500 ? n : 1;
}

/** An item by its id across the pack (shard * 2^24 + rank); null when its shard is not loaded. */
function item(g, withBasis = true) {
  const [si, r] = splitGid(Number(g));
  const S = db.shards[si];
  return S && r < S.N ? itemOf(S, r, withBasis) : null;
}

// ---------------------------------------------------------------- UPC / equivalents / PLU
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; }

function lookupUpc(key) {
  const out = [];
  for (const S of db.shards) {
    if (!S) continue;
    const i = lowerBound(S.upcKeys, key);
    for (let j = i; j < S.upcKeys.length && S.upcKeys[j] === key; j++) out.push(itemOf(S, S.upcRanks[j]));
  }
  // the primary listing first (each shard sorts its own primary first; a barcode listed in two departments has one primary)
  return out.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
}

function lookupEquivalent(key) {
  const i = lowerBound(db.eqKeys, key);
  if (i >= db.eqKeys.length || db.eqKeys[i] !== key) return null;
  const txt = td.decode(db.eqBytes.subarray(db.eqOffs[i], db.eqOffs[i + 1]));
  const [brand, name, quantity] = txt.split("\x1F");
  const b = db.eqBasis[i];
  // format 3: shard << 24 | rank; format 2: a plain rank in its only shard
  const basis = b === NO_RANK ? null : db.v2 ? item(b) : item(gidOf(b >>> 24, b & 0xFFFFFF));
  return {
    brand, name, quantity, estCents: db.eqEst[i], baseQty: db.eqBase[i], pack: db.eqPack[i], unit: UNIT_NAME[db.eqUnit[i]],
    confidence: ["low", "medium", "high"][db.eqConf[i] & 3] || "low", basis,
    storeTier: !!(db.eqConf[i] & 4),     // another chain's store brand, valued at Walmart's store-brand tier (about half a national brand)
  };
}

function lookupPlu(code) {
  const c = db.plu.get(Number(code));
  if (!c) return null;
  const g = c.rank == null ? null : c.shard != null ? gidOf(c.shard, c.rank) : c.rank;
  return { ...c, item: g != null ? item(g) : null };
}

// ---------------------------------------------------------------- value-brand equivalent
// Every donated item is valued at Walmart's own value brand's version of it (owner, 2026-10-26): a box of Barilla rigatoni
// is worth what Great Value Rigatoni costs, scaled to the box's size. The value brands come from data/brands.json via the
// manifest (Great Value, Equate, Parent's Choice, ...; Walmart's premium lines such as Sam's Choice are not the same tier).
// The equivalent is the value-brand item of the same category whose name the donated item's name explains best (its own
// words found in the donated item's, the same kind of thing), at the nearest size; its price per ounce, fluid ounce or
// count is scaled to the donated item's size. None when the item is a value brand itself, a durable good, sold by the
// pound, has no stated size, when nothing matches closely enough, or when the equivalent would cost more than the item's
// own Walmart price (a wrong match more often than a real one): the item's own Walmart price is then its value.
const VALUE_BRANDS_DEFAULT = ["great value", "equate", "parent's choice", "ol' roy", "special kitty", "mainstays", "marketside",
  "freshness guaranteed", "clear american", "spring valley"];
const brandKey = (b) => String(b || "").toLowerCase().replace(/['’`]/g, "").trim();
const MEASURE_OF = { oz: ["oz", 1], lb: ["oz", 16], g: ["oz", 0.035274], kg: ["oz", 35.274], "fl oz": ["oz", 1], ml: ["oz", 0.033814],
  l: ["oz", 33.814], gal: ["oz", 128], qt: ["oz", 32], pt: ["oz", 16], ct: ["ct", 1] };   // ounces and fluid ounces compare loosely, as identify.py does
// words that say nothing about what the item is: marketing, certification, packaging
const GV_NOISE = new Set(["great", "value", "brand", "new", "classic", "original", "non", "gmo", "kosher", "certified", "shelf", "stable",
  "premium", "quality", "resealable", "canister", "family", "size", "per", "made", "real", "all", "natural", "naturally", "delicious",
  "percent", "100", "usa", "free", "flavored", "flavor", "pantry", "staple", "staples", "ready", "eat", "serve", "contains", "net", "wt",
  "approx", "approximately", "multipack", "multi", "variety", "assorted", "bulk", "value", "pk", "fl", "jumbo", "mega", "pack", "packs",
  "count", "ct", "box", "bag", "can", "cans", "jar", "bottle", "bottles", "tub", "pouch", "carton", "container",
  "easy", "open", "fully", "cooked", "frozen"]);
// "free" alone is noise, but "gluten free", "sugar free", "low sodium", "reduced fat" and their kin are the variant: kept
// as one word ("glutenfree", "lowsodium"), and so is a diaper or clothing size ("size 4" -> "size4")
const FREE_OF = new Set(["gluten", "sugar", "fat", "dairy", "caffeine", "salt", "sodium", "lactose", "fragrance", "dye", "alcohol", "nut", "egg", "soy", "carb", "calorie", "fluoride", "paraben", "sulfate"]);
const LESS = new Set(["low", "reduced", "less", "no", "lower"]);
// words that must agree: when the value item says it (decaf, sugar free, organic, for cats, size 4), the donated item says
// it too, or the value item is a different product (regular oats are not the gluten-free ones, dog food is not cat food)
const MUST_AGREE = /^(organic|decaf|decaffeinated|diet|zero|unsweetened|lite|kid|kids|toddler|infant|baby|puppy|kitten|dog|cat|men|women|herbal|green|size\d.*|stage\d|.+free|(low|reduced|less|no|lower)[a-z]+)$/;
const sing = (t) => (t.length > 3 && t.endsWith("ies") ? t.slice(0, -3) + "y" : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
function gvWords(it, generic = null) {
  const brandToks = new Set(tokenize(it.brand));
  const toks = tokenize(it.name);
  const out = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], next = toks[i + 1];
    if (t === "free" && i > 0 && FREE_OF.has(toks[i - 1])) { out.add(toks[i - 1] + "free"); out.delete(sing(toks[i - 1])); continue; }
    if (LESS.has(t) && FREE_OF.has(next)) { out.add(t + next); i++; continue; }
    if (t === "size" && /^(\d+|n|nb|newborn|preemie)$/.test(next || "")) { out.add("size" + next); i++; continue; }
    if (t === "stage" && /^\d$/.test(next || "")) { out.add("stage" + next); i++; continue; }        // baby food stages
    if (/^diapers?$/.test(t) && /^\d$/.test(next || "")) { out.add("diaper"); out.add("size" + next); i++; continue; }   // "Diapers 4 22-37 lbs"
    if (/^\d/.test(t) || t.length < 2 || UNIT_WORDS.has(t) || GV_NOISE.has(t) || brandToks.has(t)) continue;
    out.add(sing(t));
  }
  // a brand that is the product's name ("Cheerios", "Kool-Aid", "Q-tips"): the generic words it stands for
  // (data/brands.json generic_names, via the manifest)
  if (generic?.length) {
    const all = [...brandToks, ...toks];
    const hasRun = (run) => { for (let i = 0; i + run.length <= all.length; i++) if (run.every((x, k) => all[i + k] === x)) return true; return false; };
    // the longest name first; a shorter one inside it is the same product ("honey nut cheerios", not also "cheerios")
    const hit = [];
    for (const g of generic) {
      if (!hasRun(g.toks) || hit.some((h) => h.toks.join(" ").includes(g.toks.join(" ")))) continue;
      hit.push(g);
      for (const w of g.words) out.add(w);
      out.genericHead ||= g.words[g.words.length - 1];
    }
  }
  return out;
}
function genericNames() {
  if (!db.genericNames) {
    const src = db.manifest?.genericNames || {};
    db.genericNames = Object.entries(src).map(([k, v]) => ({ name: k, toks: tokenize(k), raw: tokenize(v), words: [...new Set(tokenize(v).map(sing))] }))
      .filter((g) => g.toks.length && g.words.length).sort((a, b) => b.toks.length - a.toks.length);
  }
  return db.genericNames;
}
function valueBrandSet() {
  if (!db.valueBrands) db.valueBrands = new Set((db.manifest?.valueBrands || VALUE_BRANDS_DEFAULT).map(brandKey));
  return db.valueBrands;
}
// what a listing is, for this comparison: the head noun after a leading brand ("Quaker, Quick 1 Minute Oats" is oats) and
// before an "in water", "in juice" ("Chunk Light Tuna in Water" is tuna)
function gvHead(it) {
  let name = String(it.name).split(/\s+in\s+/i)[0];
  const b = String(it.brand || "").trim();
  if (b && name.toLowerCase().startsWith(b.toLowerCase())) name = name.slice(b.length).replace(/^[\s,:;-]+/, "") || name;
  return sing(headNoun(name) || "");
}
/** A donated item's possible head nouns: the head of each part of its name between commas or dashes, marketing words
 * aside ("Barilla Classic Non-GMO, Kosher Certified Rigatoni Pasta, 16 oz" is pasta, not "gmo"). The first is its own. */
function gvHeads(it, words) {
  const first = gvHead(it);
  const out = first ? [first] : [];
  for (const part of String(it.name).split(/,| - | – | \| /).slice(1)) {
    const h = sing(headNoun(part.split(/\s+in\s+/i)[0]) || "");
    if (h && !GV_NOISE.has(h) && words.has(h) && !out.includes(h)) out.push(h);
  }
  return out;
}
// a listing that is two products, or one with a gift ("Bundle and Save!", "+ Free Pampers Sensitive Wipes", "FREE Holiday
// Stocking Toy with your purchase of"): never compared
const BUNDLED_RX = /\bbundle\b|\+\s*free\b|\bfree\b[^,]*\bwith\b|\bwith (?:your )?purchase\b|\bbuy\b[^,]*\bsave\b/i;
// what a donated item's name may say it is when it shares only one word with the value item: a class of products, so
// "Barilla Collezione Rigatoni Pasta" is Great Value Rigatoni, while "Milk Chocolate Caramel Squares" are not Caramels
const CLASS_WORDS = new Set(["pasta", "cereal", "soup", "snack", "food", "drink", "beverage", "candy", "treat", "dessert",
  "meal", "dinner", "side", "seasoning", "spice", "mix", "vegetable", "fruit", "cleaner", "medicine", "supplement", "vitamin"]);
// what a value brand's name leaves unsaid: Special Kitty is cat food, Ol' Roy dog food
const BRAND_SAYS = { "special kitty": "cat", "ol roy": "dog" };
// sold by what it holds, not by its content: a 9 oz cup or a 2 gallon bag is not 9 ounces of anything (Kitchen & Dining,
// and these items wherever they are filed)
const CAPACITY_HEADS = new Set(["cup", "tumbler", "mug", "glass", "plate", "bowl", "container", "lid", "bottle", "jar", "pitcher", "tray", "pan", "set"]);
const CAPACITY_CATS = new Set([17]);
const isValueBrand = (it) => !!it && it.storeBrand && valueBrandSet().has(brandKey(it.brand));
// a listing's quantity per piece in ounces (weight and volume alike) or count, and its pieces: [measure, qty, pieces]
function gvQty(it) {
  const m = MEASURE_OF[it.unit];
  if (!m || !(it.size > 0)) return null;
  return [m[0], it.size * m[1], it.pack > 1 ? it.pack : 1];
}
/** The value-brand items of a core shard, built on first use: by category, and by category and word. */
function gvIndex(S) {
  const vb = valueBrandSet();
  if (S.gv && S.gv.brands === vb) return S.gv;      // a shard kept across versions is re-indexed when the brand list is new
  const byCat = new Map(), byWord = new Map();
  if (S.tier !== "more") {
    for (let r = 0; r < S.N; r++) {
      if (!(S.flags[r] & F.STORE_BRAND) || (S.flags[r] & F.RETIRED) || (S.flags2[r] & (F2.PLACEHOLDER | F2.PRICE_WITHHELD | F2.UNIT_SUSPECT)) || S.basis[r] || !S.price[r]) continue;
      const txt = itemText(S, r), sep = txt.indexOf("\x1F");
      if (!vb.has(brandKey(txt.slice(0, sep)))) continue;
      const it = { brand: txt.slice(0, sep), name: txt.slice(sep + 1), size: S.size[r], unit: UNIT_NAME[S.unit[r]], pack: S.pack[r] };
      const q = gvQty(it);
      // a count in the name beside a weight ("15 oz Can, 4 Count", "26.4 oz, 12 Count") may be per piece or for the whole
      // box: such a listing never sets a value-brand price
      if (!q || (q[0] !== "ct" && q[2] === 1 && piecesOf(S, r, it.name) > 1) || BUNDLED_RX.test(it.name)) continue;
      const words = gvWords(it);
      if (!words.size) continue;
      const says = BRAND_SAYS[brandKey(it.brand)];
      if (says) words.add(says);
      const e = { r, cat: S.cat[r], q, words, head: gvHead(it), price: S.price[r] };
      if (CAPACITY_CATS.has(e.cat) || CAPACITY_HEADS.has(e.head)) continue;
      if (!byCat.has(e.cat)) byCat.set(e.cat, []);
      byCat.get(e.cat).push(e);
      for (const w of words) { const k = e.cat + "|" + w; if (!byWord.has(k)) byWord.set(k, []); byWord.get(k).push(e); }
    }
  }
  S.gv = { byCat, byWord, brands: vb };
  return S.gv;
}
/** How many value-brand items of each category carry each word (all loaded core shards): a rare word ("magnesium",
 * "worcestershire") says more about what an item is than a common one ("powder", "sauce"). */
function gvStats() {
  const key = db.shards.filter((S) => S && S.tier !== "more").map((S) => S.key).join("|");
  if (db.gvStats?.key === key) return db.gvStats;
  const df = new Map(), n = new Map();
  for (const S of db.shards) {
    if (!S || S.tier === "more") continue;
    for (const [cat, list] of gvIndex(S).byCat) {
      n.set(cat, (n.get(cat) || 0) + list.length);
      for (const e of list) for (const w of e.words) df.set(cat + "|" + w, (df.get(cat + "|" + w) || 0) + 1);
    }
  }
  db.gvStats = { key, idf: (cat, w) => Math.log(1 + (n.get(cat) || 1) / (df.get(cat + "|" + w) || 1)) };
  return db.gvStats;
}
const FRESH_BRANDS = new Set(["", "unbranded", "fresh produce", "produce", "fresh", "generic", "walmart", "no brand"]);
const GV_RANK_BONUS = 1.2;    // search: a value-brand item that is what the query names (measured on the gold set: no query lost)
const GV_MIN_COVER = 0.6;     // at least this share of the value item's own words are in the donated item's name
const GV_MARGIN = 0.25;       // candidates this close to the best score compete on size
const GV_MAX_SCALE = 4;       // a value item at most 4x larger or smaller per piece than the donated one
/** The value-brand equivalent of an item (from itemOf), or null; marks it.gvNone when one was looked for and not found.
 * debug: an array that collects every candidate with the reason it was kept or set aside (tools only). */
function valueEquivalent(it, debug = null) {
  if (!it || it.priceCents == null || !it.priceCents || it.basis === "lb" || it.placeholder || isValueBrand(it)) return null;
  const [si] = splitGid(it.rank);
  if (!db.shards[si] || db.shards[si].tier === "more") return null;
  const q = gvQty(it);
  const words = gvWords(it, genericNames());
  // what the item is: the generic name's last word for a brand-name product ("Dog Chow" is dog *food*), else its head noun
  const heads = words.genericHead ? [words.genericHead] : gvHeads(it, words);
  const head = heads[0] || "";
  if (!q || !words.size || BUNDLED_RX.test(it.name) || CAPACITY_CATS.has(it.cat) || heads.some((h) => CAPACITY_HEADS.has(h))) { it.gvNone = true; return null; }
  const { idf } = gvStats();
  // how much one listing holds: "15 oz, 6 Count" is six 15 oz cans, "26.4 oz, 12 Count" a 26.4 oz box of 12 bars; the
  // name does not say which, so both readings are tried and the one priced like a value brand against this item wins
  const n = it.pieces > 1 && !(it.pack > 1) && q[0] !== "ct" ? it.pieces : 0;
  const readings = n ? [[q[1], n], [q[1] / n, n], [q[1], 1]] : [[q[1], q[2]]];
  const cands = [];
  const seen = new Set();
  for (const S of db.shards) {
    if (!S || S.tier === "more") continue;
    const { byWord } = gvIndex(S);
    for (const w of words) {
      for (const e of byWord.get(it.cat + "|" + w) || []) {
        if (seen.has(e) || e.q[0] !== q[0]) continue;
        seen.add(e);
        let both = 0, clash = null, wBoth = 0, wAll = 0;
        for (const x of e.words) {
          const w = idf(e.cat, x);
          wAll += w;
          if (words.has(x)) { both++; wBoth += w; } else if (MUST_AGREE.test(x)) clash = x;
        }
        // the share of the value item's own words found in the donated item's name, each word weighted by how rare it is
        const cover = wAll ? wBoth / wAll : 0;
        const sameHead = heads.includes(e.head);
        // the same kind of thing: the same head noun, or each item's head noun in the other's name, or the value item's head
        // noun in the donated item's name when the donated item's own is only a class ("Barilla Collezione Rigatoni Pasta"
        // is Great Value Rigatoni; "KIND Almond Butter Dark Chocolate Bars" are not Great Value Dark Chocolate with
        // Almonds, nor a "Baby Eau De Parfum Spray" an Equate Baby Sunscreen Spray); most of the value item's words (two fifths for the same noun: "Colgate Total
        // Whitening Toothpaste" is an Equate toothpaste); and one word in common only when it is all one of them says
        // ("Rummo Rigatoni", "StarKist Tuna"; not "Hell Fire Hot Sauce" for Great Value Worcestershire Sauce)
        const kind = sameHead || (words.has(e.head) && heads.some((h) => e.words.has(h) || CLASS_WORDS.has(h)));
        const why = clash ? `says ${clash}` : !kind ? "another kind of item"
          : !(cover >= GV_MIN_COVER || (sameHead && cover >= 0.4)) ? `cover ${cover.toFixed(2)}`
          : both < 2 && e.words.size > 1 && words.size > 1 ? "one word in common" : "";
        if (debug) debug.push({ name: itemText(S, e.r).replace("\x1F", " · "), why: why || "ok", cover: +cover.toFixed(2) });
        if (why) continue;
        cands.push({ e, S, score: cover + 0.5 * (both / words.size) + (sameHead ? 0.1 : 0) });
      }
    }
  }
  let pick = null;
  for (const [per, pieces] of readings) {
    const scored = cands.map((c) => ({ ...c, scale: per / c.e.q[1] })).filter((c) => c.scale <= GV_MAX_SCALE && c.scale >= 1 / GV_MAX_SCALE);
    if (!scored.length) continue;
    const best = Math.max(...scored.map((c) => c.score));
    const near = scored.filter((c) => c.score >= best - GV_MARGIN)
      .sort((a, b) => Math.abs(Math.log(a.scale)) - Math.abs(Math.log(b.scale)) || b.score - a.score || a.e.r - b.e.r);
    // one listing never sets the value alone (a 144-count box of diapers listed at $6.00): the median price per ounce or
    // per count of the closest wordings between half and twice the size (the nearest size alone when none is), and a
    // listing of the same size is its value when its own price agrees with that median within a third
    const unit = (c) => c.e.price / c.e.q[2] / c.e.q[1];
    // (the best-worded of them: an organic soup is priced from the organic ones)
    const close = near.filter((c) => c.scale >= 0.5 && c.scale <= 2);
    const top = Math.max(...close.map((c) => c.score));
    const pool = close.length ? close.filter((c) => c.score >= top - 0.1) : near.slice(0, 1);
    const ups = pool.map(unit).sort((a, b) => a - b);
    const med = ups.length % 2 ? ups[ups.length >> 1] : (ups[ups.length / 2 - 1] + ups[ups.length / 2]) / 2;
    const same = pool.find((c) => Math.abs(c.scale - 1) <= 0.02 && Math.abs(unit(c) / med - 1) <= 0.34);
    const basis = same || pool.slice().sort((a, b) => Math.abs(unit(a) - med) - Math.abs(unit(b) - med) || a.e.r - b.e.r)[0];
    const cents = Math.round(same ? (same.e.price / same.e.q[2]) * pieces : med * per * pieces);
    // never above the item's own Walmart price, nor under a fifth of it (a wrong reading or match, or a mispriced
    // listing, more often than a real price); of the readings, the one nearest the measured value-brand price level
    // (0.57 of a national brand per unit, 2026-10-26)
    if (!(cents > 0) || cents > it.priceCents || cents < 0.2 * it.priceCents) continue;
    const fit = Math.abs(Math.log(cents / it.priceCents / 0.57));
    if (!pick || fit < pick.fit) pick = { c: basis, cents, sameSize: !!same, fit, n: pool.length };
  }
  if (!pick) { it.gvNone = true; return null; }
  const basis = itemOf(pick.c.S, pick.c.e.r, false);
  // scaled: the value is not the basis listing's own price but the per-unit price of the value brand's similar sizes
  // times this item's size (the sheet says so)
  return { cents: pick.cents, ownCents: it.priceCents, brand: basis.brand, basis, scaled: !pick.sameSize, compared: pick.n, confidence: pick.c.score >= 1.1 ? "high" : "medium" };
}
/** An item as the app sees it: with its value-brand equivalent when it has one. Successive keystrokes show mostly the
 * same items, so each item's answer is kept (per pack version) and a keystroke only works out the new ones. */
const gvCache = new Map();
function withValue(it) {
  if (!it || it.gv !== undefined) return it;
  const key = `${db.version}:${it.rank}`;
  let hit = gvCache.get(key);
  if (!hit) {
    const gv = valueEquivalent(it);
    hit = { gv, none: !!it.gvNone };
    if (gvCache.size > 5000) gvCache.clear();
    gvCache.set(key, hit);
  }
  if (hit.gv) it.gv = hit.gv;
  if (hit.none) it.gvNone = true;
  return it;
}

// ---------------------------------------------------------------- search, per shard
function lowerBoundStr(S, x) { const a = S.dict; let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
function dictRange(S, prefix) { return [lowerBoundStr(S, prefix), lowerBoundStr(S, prefix + "\uffff")]; }

function orList(bits, bytes, i, end) {
  // decode a varint-delta posting list into the bitset
  let prev = -1;
  while (i < end) {
    let v = 0, shift = 0, b;
    do { b = bytes[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const r = prev + v + 1; prev = r;
    bits[r >>> 5] |= 1 << (r & 31);
  }
}
function cached(cache, key, make) {
  let bits = cache.get(key);
  if (bits) { cache.delete(key); cache.set(key, bits); return bits; }    // refresh LRU position
  bits = make();
  if (cache.size >= BIT_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, bits);
  return bits;
}
function prefixBits(S, prefix) {
  return cached(S.bitCache, prefix, () => { const bits = new Uint32Array(S.words); const [lo, hi] = dictRange(S, prefix); for (let k = lo; k < hi; k++) orList(bits, S.postings, S.postOff[k], S.postOff[k + 1]); return bits; });
}
// items whose head noun (what the listing is) is exactly the word
function headBits(S, word) {
  if (!S.headOff) return null;
  const k = lowerBoundStr(S, word);
  if (k >= S.dict.length || S.dict[k] !== word || S.headOff[k] === S.headOff[k + 1]) return null;
  return cached(S.headCache, word, () => { const bits = new Uint32Array(S.words); orList(bits, S.headPostings, S.headOff[k], S.headOff[k + 1]); return bits; });
}
const hasAnyToken = (prefix) => db.shards.some((S) => { if (!S) return false; const [lo, hi] = dictRange(S, prefix); return hi > lo; });
const hasExactToken = (w) => db.shards.some((S) => { if (!S) return false; const i = lowerBoundStr(S, w); return i < S.dict.length && S.dict[i] === w; });
function popcount(bits) { let c = 0; for (let i = 0; i < bits.length; i++) { let v = bits[i]; v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); c += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; } return c; }

/** Expand the typed tokens into groups; each group is a list of alternative prefixes (OR), groups are ANDed. */
function expand(tokens) {
  const groups = [];   // { alts: [prefixes ORed], src: the word the volunteer typed }
  for (const t of tokens) {
    if (ABBREV[t]) { for (const w of ABBREV[t]) groups.push({ alts: [w], src: t }); continue; }
    const alts = new Set([t]);
    if (SYN.has(t)) for (const w of SYN.get(t)) alts.add(w);
    if (t.length >= 4 && t.endsWith("ies")) alts.add(t.slice(0, -3) + "y");
    else if (t.length >= 6 && /(ches|shes|sses|xes|zes|oes)$/.test(t) && hasExactToken(t.slice(0, -2))) alts.add(t.slice(0, -2));   // boxes, tomatoes, dishes — only when the stem is a real word
    else if (t.length >= 4 && t.endsWith("s")) alts.add(t.slice(0, -1));
    groups.push({ alts: [...alts], src: t });
  }
  return groups;
}

function groupBits(S, alts) {
  let acc = null;
  for (const a of alts) {
    const [lo, hi] = dictRange(S, a);
    if (hi <= lo) continue;
    const b = prefixBits(S, a);
    if (!acc) acc = b.slice(); else for (let i = 0; i < acc.length; i++) acc[i] |= b[i];
  }
  return acc;   // null when no alternative matches any token of this shard
}
function groupHeadBits(S, alts) {
  let acc = null;
  for (const a of alts) { const b = headBits(S, a); if (!b) continue; if (!acc) acc = b.slice(); else for (let i = 0; i < acc.length; i++) acc[i] |= b[i]; }
  return acc;
}

// One-edit variants of a token that exist in the dictionary as prefixes (typo tolerance).
function fuzzyAlternatives(t) {
  if (t.length < 4) return [];
  const out = new Set();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const tryAdd = (s) => { if (s && s !== t && hasAnyToken(s)) out.add(s); };
  for (let i = 0; i < t.length; i++) {
    tryAdd(t.slice(0, i) + t.slice(i + 1));                                   // deletion
    if (i < t.length - 1) tryAdd(t.slice(0, i) + t[i + 1] + t[i] + t.slice(i + 2));   // transposition
    for (const c of letters) { tryAdd(t.slice(0, i) + c + t.slice(i + 1)); tryAdd(t.slice(0, i) + c + t.slice(i)); }   // substitution, insertion
  }
  tryAdd(t + "s");
  return [...out].slice(0, 12);
}

function collect(bitsets, limit, mask = null, skip = null) {
  // AND all bitsets (and the mask) and collect ranks in ascending (= best-first) order
  const words = bitsets[0].length;
  const out = [];
  for (let w = 0; w < words && out.length < limit; w++) {
    let v = bitsets[0][w];
    for (let g = 1; g < bitsets.length && v; g++) v &= bitsets[g][w];
    if (mask) v &= mask[w];
    if (skip) v &= ~skip[w];
    while (v && out.length < limit) {
      const bit = v & -v;
      out.push((w << 5) + (31 - Math.clz32(bit)));
      v ^= bit;
    }
  }
  return out;
}

const UNIT_WORDS = new Set(["oz", "ounce", "ounces", "fl", "fluid", "lb", "lbs", "pound", "pounds", "ct", "cnt", "count", "pack", "pk", "pc", "pcs", "piece", "pieces", "g", "gram", "grams", "kg", "mg", "mcg", "ml", "l", "liter", "liters", "litre", "litres", "gal", "gallon", "gallons", "qt", "quart", "quarts", "pt", "pint", "pints", "each", "ea", "x", "of", "the", "and", "with", "in", "a", "can", "bag", "box", "bottle", "jar", "cup", "tub", "pouch", "package", "carton", "case", "sq", "ft", "inch", "inches", "mm", "cm"]);
const PLAIN_QUALIFIERS = new Set(["percent", "organic", "fresh", "whole", "large", "small", "medium", "jumbo", "original", "classic", "regular", "plain", "pure", "natural", "each", "loose", "family", "size", "value"]);
function numberTokens(tokens) { return tokens.filter((t) => /^\d/.test(t)).map(Number); }

function homeCategories(S, groups) {
  // for every group: the dominant category of the first matching dictionary token, 0 if unclear
  return groups.map((g) => {
    for (const a of g) { const [lo, hi] = dictRange(S, a); if (hi > lo) return S.tokCat[lo]; }
    return 0;
  });
}

// Tokenized names of recently scored items: successive keystrokes narrow the same candidates, so this makes
// scoring mostly allocation-free on a slow phone.
const tokCache = new Map();
function itemTokens(key, it) {
  let t = tokCache.get(key);
  if (!t) {
    const s = it.brand + " " + it.name;
    t = { toks: [...tokenize(s), ...joinedTokens(s)], brandToks: tokenize(it.brand), brandJoined: joinedTokens(it.brand), head: headNoun(it.name) };
    if (tokCache.size > 20000) tokCache.clear();
    tokCache.set(key, t);
  }
  return t;
}

/** A run of query tokens that is another chain's store brand ("kirkland signature", "members mark"): the brand, its store and
 * the token span, or null. The longest listed brand wins; a brand word that is the whole query is not matched, so "aldi"
 * alone still searches the list for it. */
function otherStoreBrand(tokens) {
  if (!db?.brands?.length || tokens.length < 2) return null;
  for (const b of db.brands) {
    if (b.toks.length >= tokens.length) continue;
    for (let i = 0; i + b.toks.length <= tokens.length; i++) {
      if (b.toks.every((t, k) => tokens[i + k] === t)) return { brand: b.name, store: b.store, start: i, end: i + b.toks.length };
    }
  }
  return null;
}

function scoreCandidates(S, ranks, qTokens, groups, typed = null, ownBrandFirst = false, joined = [], brandHome = 0, qSize = null) {
  const walmartScope = db.manifest?.searchScope === "walmart";
  const nums = numberTokens(qTokens);
  const homes = homeCategories(S, groups);
  const scored = ranks.map((r) => {
    const it = itemOf(S, r);
    const { toks, brandToks, brandJoined, head } = itemTokens(it.rank, it);
    const tokSet = new Set(toks);
    let s = 0;
    let matched = 0, exact = 0;
    for (const g of groups) {
      if (g.some((a) => tokSet.has(a))) {
        s += 2; matched++; exact++;                                                        // exact token vs prefix-only
        let tf = 0; for (const t of toks) if (g.includes(t)) tf++;                 // "Corn, Canned Corn" over "Corn Meal"
        if (tf > 1) s += 0.8;
      } else { s += 0.6; if (toks.some((t) => g.some((a) => t.startsWith(a)))) matched++; }
    }
    // coverage: how much of the item's content (brand, numbers and unit words aside) the query explains.
    // "Peanut Butter 16 oz" (2/2) beats "Peanut Butter Cookies 12 ct" (2/3) for the query "peanut butter".
    const content = toks.filter((t) => !/^\d/.test(t) && !UNIT_WORDS.has(t) && !brandToks.includes(t));
    s += 1.5 * Math.min(1, matched / Math.max(1, content.length));
    // the brand counts only when the query names all of it: "tomato sauce" is not a search for the Jersey Tomato brand,
    // "soy sauce" not for Soy Vay
    // brand words must be typed whole ("hot" is not the brand Hotel Doggy), except the word still being typed
    const lastG = groups.length - 1;
    const covers = (g, gi, b) => g.some((a) => a === b || (gi === lastG && b.startsWith(a)) || (b.length > 3 && a === b + "s"));
    const namesBrand = (g) => brandToks.some((b) => covers(g, 0, b)) || brandJoined.some((j) => covers(g, 0, j));
    // after another chain's brand is set aside the rest names a product, never a brand ("sweet harvest peach slices" is
    // canned peaches, not the skin-care brand Peach Slices)
    if (ownBrandFirst) { /* no brand credit */ }
    else if (brandToks.length && groups.length && namesBrand(groups[0])
        && (brandToks.every((b) => groups.some((g, gi) => covers(g, gi, b))) || brandJoined.some((j) => groups.some((g, gi) => covers(g, gi, j))))) s += 1.5;
    // a product line named without its maker: "oven fry" is the brand Kraft Oven Fry, the words after the company name
    else if (brandToks.length >= 3 && groups.length >= 2 && covers(groups[0], 0, brandToks[1])
        && brandToks.slice(1).every((b) => groups.some((g, gi) => covers(g, gi, b)))) s += 1.5;
    // the plain item: every word of the listing (brand, sizes and qualifiers aside) is in the query ("Organic Bananas"
    // for "bananas", "Heinz Ketchup, 20 oz" for "ketchup"), not a product made with it ("Banana Pouch")
    // (the word as typed or a listed synonym, not its singular: "Chocolate Chip" cookies are not "chocolate chips")
    if (typed && content.length && content.every((t) => PLAIN_QUALIFIERS.has(t) || typed.some((w, gi) => w.has(t) || (gi === lastG && [...w].some((x) => t.startsWith(x)))))) s += 1.2;
    for (const j of joined) if (tokSet.has(j)) s += 1.5;   // the brand typed as two words: "red pack" is Redpack, not a Red Gold 6 pack
    for (const n of nums) { if ((it.size && Math.abs(it.size - n) < 0.01) || it.pack === n) s += 1.2; }
    // a size typed with its unit ("green beans 14.5 oz", "butter 1 lb"): the nearer the listing's size, the higher, in any
    // unit of the same measure (16 oz is 1 lb); nothing at twice or half the size
    if (qSize && it.size > 0) {
      const m = MEASURE_OF[it.unit];
      if (m && m[0] === qSize.dim) s += 1.8 * Math.max(0, 1 - Math.abs(Math.log((it.size * m[1]) / qSize.qty)) / Math.LN2);
    }
    s -= 0.03 * Math.max(0, toks.length - groups.length);
    // phrase proximity: query words that sit next to each other in the name are the item the volunteer means
    let first = -1, last = -1;
    for (const g of groups) { const pos = toks.findIndex((t) => g.some((a) => t.startsWith(a))); if (pos >= 0) { if (first < 0 || pos < first) first = pos; if (pos > last) last = pos; } }
    if (first >= 0 && groups.length > 1) s += 1.2 * groups.length / Math.max(groups.length, last - first + 1);
    for (const h of homes) if (h && h === it.cat) s += 0.8;
    if (brandHome && it.cat === brandHome) s += 2;
    const headHit = !!head && groups.some((g) => g.some((a) => head === a || (a.length >= 4 && head.startsWith(a))));
    if (headHit) s += 1.6;
    else if (head && toks.length) s -= 0.6;          // the query's words only describe it: a diaper *bag*, a tomato *basket*
    // a plain word typed ("butter", "milk", "cheese", "beans") is that product, not the one a word before it makes of it
    // ("peanut butter", "almond milk", "cream cheese", "jelly beans"), unless that word is typed too
    for (const g of groups) {
      const mods = COMPOUNDS.get(g[0]);
      if (!mods) continue;
      const at = toks.indexOf(g[0]);
      if (at > 0 && mods.has(toks[at - 1]) && !qTokens.includes(toks[at - 1])) s -= 1.5;
    }
    // Walmart's own brand is the same price tier as another chain's store brand: first when the query named one, but only
    // for the item the query names, among the consumable departments other chains' store brands compete in ("giant eagle
    // pumpkin" is canned pumpkin, not Mainstays pumpkin plates; owner's food-bank photos, 2026-10-21)
    // (or carries every word: "giant eagle honey nut toasted oats" is Great Value Honey Nut Toasted Oats Cereal)
    // and every item is valued at Walmart's value brand (owner, 2026-10-26): a query that names no brand ("rigatoni 16
    // oz") shows the value brand's item first when it is the item named, so the volunteer sees the price that counts
    if (it.storeBrand) s += ownBrandFirst && (headHit || exact === groups.length) && S.tier !== "more" ? 3
      : (headHit || exact === groups.length) && S.tier !== "more" && isValueBrand(it) ? GV_RANK_BONUS : 0.3;
    // unbranded fresh food is valued as it is, like the value brand: the bag of potatoes beside the boxed ones
    else if (walmartScope && (headHit || exact === groups.length) && S.tier !== "more" && FRESH_BRANDS.has(brandKey(it.brand))) s += GV_RANK_BONUS;
    const aud = AUDIENCE_CATS.get(it.cat);
    if (aud && !qTokens.some((t) => aud.test(t)) && !namesBrand(groups[0]) && brandHome !== it.cat) s -= 2.5;   // (a baby brand typed: "huggies wipes")
    if (it.retired) s -= 1.5;
    // a food word means the food ("milk", "pumpkin"), not a bottle or plates: general merchandise after what is eaten or used up
    if (walmartScope && (S.tier === "more" || it.cat === 17 || it.cat === 18)) s -= 0.8;
    if (it.unavailable) s -= 0.4;
    s -= (r / S.N) * 0.8;             // rank within the shard as the final tiebreaker
    if (globalThis.SFB_SCORE_DEBUG) it._score = Math.round(s * 100) / 100;
    return { it, s };
  });
  return scored;
}

// exact number of items matching every live group (AND of the bitsets), for the "N matches" line
function andCount(bs) {
  let n = 0;
  const w = bs[0].length;
  for (let i = 0; i < w; i++) {
    let v = bs[0][i];
    for (let k = 1; k < bs.length; k++) v &= bs[k][i];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
}

// the share of the items carrying a word (up to 80 sampled) whose brand is or contains it: near 1 for "redpack" or
// "stonemill", low for "rosemary"
function brandShareOf(alts) {
  let seen = 0, branded = 0;
  for (const S of db.shards) {
    if (!S || seen >= 80) continue;
    const bits = groupBits(S, alts);
    if (!bits) continue;
    for (const r of collect([bits], 80 - seen)) {
      const it = itemOf(S, r, false);
      const { brandToks, brandJoined } = itemTokens(it.rank, it);
      seen++;
      if (alts.some((a) => brandToks.includes(a) || brandJoined.includes(a))) branded++;
    }
  }
  return seen ? branded / seen : 0;
}

// the category of most (at least 60%) of the items whose brand carries every one of these words, else 0
function brandCategory(altsList) {
  const tally = new Map();
  let seen = 0;
  for (const S of db.shards) {
    if (!S || seen >= 120) continue;
    const bs = altsList.map((alts) => groupBits(S, alts));
    if (bs.some((b) => !b)) continue;
    for (const r of collect(bs, 400)) {
      if (seen >= 120) break;
      const it = itemOf(S, r, false);
      const { brandToks, brandJoined } = itemTokens(it.rank, it);
      if (!altsList.every((alts) => alts.some((a) => brandToks.includes(a) || brandJoined.includes(a)))) continue;
      seen++;
      tally.set(it.cat, (tally.get(it.cat) || 0) + 1);
    }
  }
  let best = 0, n = 0;
  for (const [c, k] of tally) if (k > n) { best = c; n = k; }
  return seen >= 2 && n / seen >= 0.6 ? best : 0;
}

const COMPOUNDS = new Map(Object.entries({
  butter: ["peanut", "almond", "apple", "cashew", "sunflower", "cookie", "shea", "cocoa", "body", "nut", "seed", "pumpkin", "hazelnut", "soy"],
  milk: ["almond", "coconut", "oat", "soy", "rice", "cashew", "condensed", "evaporated", "powdered", "goat", "body", "cleansing"],
  cheese: ["cream", "cottage", "and", "n"],
  cream: ["ice", "sour", "shaving", "hand", "face", "body", "eye", "rash", "cortisone", "hydrocortisone", "foot"],
  beans: ["coffee", "jelly", "espresso", "vanilla"], bean: ["coffee", "jelly", "espresso", "vanilla"],
  sugar: ["cotton"], oil: ["motor", "baby", "essential", "massage", "hair", "body"],
}).map(([k, v]) => [k, new Set(v)]));
// baby food and pet food carry the same flavour words as people food ("roasted chicken rice", "sweet corn"): they rank
// first only when the query says it is for a baby or a pet, or names the item's brand (owner's food-bank photos 16-20)
const AUDIENCE_CATS = new Map([[13, /^(baby|babies|infant|toddler|newborn|puree|purees|formula|stage|kids?)$/], [19, /^(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|bird|fish|hamster|kibble|treats?|chews?|litter)$/]]);
const PHRASE_SYN = new Map([["bath tissue", ["toilet", "paper"]], ["bathroom tissue", ["toilet", "paper"]], ["toilet tissue", ["toilet", "paper"]],
  ["toilet paper", ["bath", "tissue"]], ["paper towel", ["kitchen", "towel"]], ["paper towels", ["kitchen", "towels"]]]);
function search(q, limit = 40) {
  const t0 = performance.now();
  let tokens = tokenize(q).filter(Boolean);
  if (!tokens.length) return { query: q, items: [], relaxed: false, fuzzy: false, ms: 0, total: 0 };
  // "kirkland chicken noodle soup": Walmart does not sell Costco's brand, so the brand words are set aside (named in the
  // result, never reported as "not found") and Walmart's own brand ranks first among the matches for the rest
  const other = otherStoreBrand(tokens);
  let otherBrand = null;
  if (other) { otherBrand = { brand: other.brand, store: other.store }; tokens = [...tokens.slice(0, other.start), ...tokens.slice(other.end)]; }
  // a brand that is the product's name ("cheerios", "kool aid", "q tips") and has no item of its own in this pack (only
  // Walmart's brands are searched): the words Walmart's value brand uses for the product (data/brands.json generic_names)
  let generic = null;
  const walmartOnly = db.manifest?.searchScope === "walmart";
  for (const g of genericNames()) {
    for (let i = 0; i + g.toks.length <= tokens.length; i++) {
      if (!g.toks.every((x, k) => tokens[i + k] === x) || (!walmartOnly && hasExactToken(g.toks[0]))) continue;
      const rest = [...tokens.slice(0, i), ...tokens.slice(i + g.toks.length)];
      tokens = [...tokens.slice(0, i), ...g.raw.filter((w) => !rest.includes(w)), ...tokens.slice(i + g.toks.length)];
      generic = { name: g.name, words: g.raw.join(" ") };
      break;
    }
    if (generic) break;
  }
  // only Walmart's brands are searched: the words of another brand's name ("del monte", "barilla") are set aside before the
  // search and point it at that brand's aisle; a query of brand words only finds nothing, and says why
  const brandSetAside = [];
  let asideCat = 0, asideProduct = "", brandOnly = false;
  if (walmartOnly && db.brandPhrases?.size) {
    const keep = [];
    for (let i = 0; i < tokens.length;) {
      const run = (db.brandPhrases.get(tokens[i]) || []).find((b) => b.toks.every((x, k) => tokens[i + k] === x));
      if (run) { brandSetAside.push(run.name); asideCat ||= run.cat; asideProduct ||= run.product; i += run.toks.length; } else keep.push(tokens[i++]);
    }
    // a brand alone ("doritos", "tide"): what that brand mostly makes, in Walmart's brands; nothing when that is not known
    if (!keep.length && !asideProduct) return { query: q, items: [], relaxed: false, dropped: [], setAside: brandSetAside, fuzzy: false, otherBrand, generic, size: null, walmartOnly, brandOnly: true, ms: performance.now() - t0, total: 0 };
    // (or with only a size, or with words no Walmart item has: "chef boyardee beefaroni" is what Chef Boyardee makes)
    const said = keep.filter((t) => !/^\d/.test(t) && !typedSize([1, t]) && hasAnyToken(t));
    if (!said.length && asideProduct) { keep.unshift(...tokenize(asideProduct).filter((t) => !keep.includes(t))); brandOnly = true; }
    tokens = keep;
  }
  // a size typed with its unit ranks the listings by how near their size is (scoreCandidates); among Walmart's brands it
  // never filters, so "butter 1 lb" also finds the 16 oz box and "green beans 20 oz" the 14.5 and 28 oz cans (every brand
  // searched: its words must match, as before, and are the first to go when nothing has them all)
  const qSize = typedSize(tokens);
  if (qSize && walmartOnly) {
    const at = qSize.text === "dozen" ? tokens.indexOf("dozen") : tokens.findIndex((t, i) => /^\d/.test(t) && typedSize(tokens.slice(i, i + 3))?.text === qSize.text);
    const n = qSize.text.split(" ").length;
    const rest = [...tokens.slice(0, at), ...tokens.slice(at + n)];
    if (at >= 0 && rest.length) tokens = rest;
  }
  const shards = db.shards.filter(Boolean);
  let groups = expand(tokens);
  const dropped = [];
  // two-word names of the same thing: "bath tissue" (Kirkland, Charmin) is what Walmart's own brand calls "toilet paper"
  for (let i = 0; i + 1 < groups.length; i++) {
    const pair = PHRASE_SYN.get(groups[i].src + " " + groups[i + 1].src);
    if (pair) for (let k = 0; k < 2; k++) if (!groups[i + k].alts.includes(pair[k])) groups[i + k].alts = [...groups[i + k].alts, pair[k]];
  }
  const joined = [];
  // two typed words that are one brand word in the listings ("red pack" is Redpack, "veg all" Veg-All): the joined word
  // is an alternative of both, so an item carrying it matches the pair. Only a joined word that is mostly a brand, so
  // "all purpose" does not start matching an "allpurpose" somewhere in a name (owner's food-bank photos, 2026-10-21)
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i].src, b = groups[i + 1].src, ab = a + b;
    if (a === b || /^\d/.test(a) || /^\d/.test(b) || ab.length < 5 || !hasExactToken(ab) || brandShareOf([ab]) < 0.6) continue;
    for (const g of [groups[i], groups[i + 1]]) if (!g.alts.includes(ab)) g.alts = [...g.alts, ab];
    joined.push(ab);
  }
  const matches = (g) => g.alts.some((a) => hasAnyToken(a));
  let fuzzy = false, relaxed = false;
  // typo tolerance: a group that matches nothing in any shard gets one-edit alternatives
  if (groups.some((g) => !matches(g))) {
    // (another brand's name is not a typo of a Walmart word: "tide" is not "tile")
    const brandWord = (g) => walmartOnly && db.brandWords?.has(g.src);
    groups = groups.map((g) => (matches(g) || /^\d/.test(g.src) || brandWord(g) ? g : { ...g, alts: [...g.alts, ...fuzzyAlternatives(g.alts[0])] }));
    fuzzy = groups.some((g) => g.alts.length > 1 && matches(g) && !hasAnyToken(g.src) && !SYN.has(g.src) && !ABBREV[g.src]);   // a typo was actually corrected
  }
  // a word that still matches nothing is dropped and named, so the result is flagged, never silently widened
  let live = [];
  for (const g of groups) { if (matches(g)) live.push(g); else if (!dropped.includes(g.src)) { dropped.push(g.src); relaxed = true; } }
  if (!live.length) return { query: q, items: [], relaxed: false, dropped, setAside: brandSetAside, fuzzy, otherBrand, generic, size: qSize, walmartOnly, ms: performance.now() - t0, total: 0 };
  // per shard: the bitset of every live group (null: the word is not in this shard, so nothing here matches all)
  const perShard = shards.map((S) => ({ S, bits: live.map((g) => groupBits(S, g.alts)) }));
  const anyAll = (keep) => perShard.some(({ bits }) => { const bs = bits.filter((_, i) => keep(i)); return bs.every(Boolean) && collect(bs, 1).length > 0; });
  // never blank: relax one word at a time. The word dropped is the least informative one (the most common) among those
  // whose removal leaves something to show: "great value dry pinto beans" drops "dry" and keeps "pinto"; dropping the
  // rarest word, as before, threw away exactly the word that says what the item is.
  // Which word goes first (owner's food-bank photos, 2026-10-21): a number ("skinny pop 28": the 28 bags, not "pop"), then
  // a brand word, one that is mostly a brand in the listings that carry it ("stonemill rosemary", "martins apple chips",
  // "schwebels stuffing": Walmart does not carry that product of that brand, and the product is what is valued, so the
  // brand goes, not "rosemary"), then the most common word.
  const isNumber = (i) => /^\d/.test(live[i].src);
  const brandShare = (i) => brandShareOf(live[i].alts);
  const brandDropped = [];   // the alternatives of brand words set aside: what kind of item that brand makes still counts
  const drop = (pick, asBrand = false) => {
    if (asBrand) brandDropped.push(live[pick].alts);
    if (!dropped.includes(live[pick].src)) dropped.push(live[pick].src);
    live = live.filter((_, j) => j !== pick);
    for (const p of perShard) p.bits = p.bits.filter((_, j) => j !== pick);
    relaxed = true;
  };
  while (live.length > 1 && !anyAll(() => true)) {
    const counts = live.map((_, i) => perShard.reduce((a, { bits }) => a + (bits[i] ? popcount(bits[i]) : 0), 0));
    const frees = live.map((_, i) => anyAll((j) => j !== i));
    const best = (ok) => { let pick = -1; for (let i = 0; i < live.length; i++) if (frees[i] && ok(i) && (pick < 0 || counts[i] > counts[pick])) pick = i; return pick; };
    let pick = best(isNumber), asBrand = false;
    // a long description ("swanson sipping bone broth beef") keeps its brand: one word too many there is a flavour or
    // variant the brand does not make, and the brand's nearest product is the better match
    if (pick < 0 && live.length <= 4) { pick = best((i) => !isNumber(i) && brandShare(i) >= 0.35); asBrand = pick >= 0; }
    // the last word typed is usually what the item is ("gia russa spaghetti sauce" is a sauce, "martins apple chips" are
    // chips): it goes last
    if (pick < 0 && live.length <= 4) pick = best((i) => i !== live.length - 1);
    if (pick < 0) pick = best(() => true);
    // no single word frees a result: drop a brand word first (an unknown brand such as "mission pride fruit mix" or
    // "mothers maid apple sauce" shares a word with brands Walmart has), else the most common word, and go on
    if (pick < 0) {
      let b = -1;
      for (let i = 0; i < live.length; i++) if (!isNumber(i) && brandShare(i) >= 0.35 && (b < 0 || counts[i] > counts[b])) b = i;
      pick = b >= 0 ? b : counts.indexOf(Math.max(...counts));
      asBrand = b >= 0;
    }
    drop(pick, asBrand);
  }
  // the kind of item the set-aside brand makes ("mission pride fruit mix": Mission Pride is canned fruit, so the canned
  // fruit mix, not a reptile food or a trail mix): the one category holding most of the items branded with every word
  let brandHome = brandDropped.length ? brandCategory(brandDropped) : 0;
  // only Walmart's brands are searched: another brand's name typed with the product ("tide pods", "del monte green beans")
  // was set aside above, and points at the aisle that brand sells in (<version>/brands.json)
  if (walmartOnly && !brandHome) brandHome = asideCat;
  // candidates per shard, best rank first: items that ARE what a query word names (head noun) before items that only
  // carry the word, so "bananas" reaches the fresh bananas before a thousand banana-flavoured things
  const CAND = Math.max(limit * 10, 400);
  let scored = [], total = 0;
  const alts = live.map((g) => g.alts);
  const sameWord = (a, b) => a === b || a === b + "s" || b === a + "s" || a === b + "es" || b === a + "es";
  const typed = live.map((g) => new Set([g.src, ...(SYN.get(g.src) || []).filter((w) => !sameWord(w, g.src)), ...(ABBREV[g.src] ? g.alts : [])]));
  // one candidate budget shared by the shards, in proportion to their matches (each keeps a floor), so a one-letter
  // query that matches in every shard scores about CAND items in all, not CAND per shard
  const counts = perShard.map(({ bits }) => (bits.every(Boolean) ? andCount(bits) : 0));
  const sum = counts.reduce((a, b) => a + b, 0);
  const POOL = CAND, FLOOR = limit;
  perShard.forEach((p, i) => { p.n = counts[i]; p.cand = Math.min(CAND, Math.max(FLOOR, Math.ceil(POOL * counts[i] / Math.max(1, sum)))); });
  for (const { S, bits, n, cand } of perShard) {
    if (!n) continue;
    total += n;
    let heads = null;
    for (const g of live) { const h = groupHeadBits(S, g.alts); if (h) { if (!heads) heads = h; else for (let i = 0; i < heads.length; i++) heads[i] |= h[i]; } }
    // at most half the pool from head matches, the rest in plain rank order, so a word that is also a common head
    // elsewhere ("dogs" in "Coat For Dogs") cannot crowd out the item ("Hot Dogs") the rank order would have found
    let ranks = heads ? collect(bits, cand >> 1, heads) : [];
    if (ranks.length < cand) {
      const seen = new Set(ranks);
      for (const r of collect(bits, cand)) { if (ranks.length >= cand) break; if (!seen.has(r)) ranks.push(r); }
    }
    scored = scored.concat(scoreCandidates(S, ranks, tokens, alts, typed, !!otherBrand, joined, brandHome, qSize));
  }
  scored.sort((a, b) => b.s - a.s || a.it.rank - b.it.rank);
  const items = scored.slice(0, limit).map((x) => x.it);
  // only Walmart's brands are searched: when the best match does not even carry the word that says what the item is (the
  // last word typed, "ramen" answered with egg noodles through a synonym), Walmart's brands have no such item, and the
  // results are only the closest ones
  let missing = null;
  if (walmartOnly && items.length && !relaxed) {
    const key = [...live].reverse().find((g) => !/^\d/.test(g.src))?.src;
    const forms = key ? [key, key + "s", key + "es", key.replace(/e?s$/, ""), key.replace(/ies$/, "y")] : [];
    const { toks } = itemTokens(items[0].rank, items[0]);
    if (key && key.length > 2 && !toks.some((t) => forms.includes(t) || (t.length > 4 && t.startsWith(key)))) { missing = key; relaxed = true; }
  }
  return { query: q, items, relaxed, dropped, missing, setAside: brandSetAside, brandProduct: brandOnly ? asideProduct : null, fuzzy, otherBrand, generic, size: qSize, walmartOnly, total, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

// ---------------------------------------------------------------- other sizes
// The same product in its other sizes and counts (a single bar, the 8, 16 and 40 count boxes): the brand's items in the
// same department whose names, brand words and quantities aside, mostly agree with this one. Owner, 2026-10-21: "for a
// box in bulk such as Rice Krispies ... the different sizes and variations they can come in - individual, box - count of".
const FILLER = new Set(["kids", "snack", "snacks", "new", "value", "size", "family", "pack", "packs", "variety", "bulk", "per", "for"]);
function nameWords(it, brandToks) {
  const out = new Set();
  for (const t of tokenize(it.name)) if (!/^\d/.test(t) && t.length > 1 && !UNIT_WORDS.has(t) && !FILLER.has(t) && !brandToks.includes(t)) out.add(t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t);
  return out;
}
const BUNDLE_RX = /^\(\d+ pack\)/i;
function sizesOf(g, limit = 8) {
  const me = item(g, false);
  if (!me || !me.brand) return [];
  const [si] = splitGid(Number(g));
  const S = db.shards[si];
  const brandToks = tokenize(me.brand).filter((t) => !UNIT_WORDS.has(t));
  if (!brandToks.length) return [];
  let bits = null;
  for (const t of brandToks) { const b = groupBits(S, [t]); if (!b) return []; if (!bits) bits = b.slice(); else for (let i = 0; i < bits.length; i++) bits[i] &= b[i]; }
  const mine = nameWords(me, brandToks);
  // a big brand (Great Value) narrows to the listings carrying this one's rarest word as well
  if (andCount([bits]) > 600 && mine.size) {
    let rare = null, rareN = Infinity;
    for (const w of mine) { const b = groupBits(S, [w]); if (!b) continue; const n = andCount([bits, b]); if (n > 0 && n < rareN) { rare = b; rareN = n; } }
    if (rare) bits = bits.map((v, i) => v & rare[i]);
  }
  const brandKey = me.brand.toLowerCase();
  const qty = (it) => (it.size || 0) * (it.unit === "lb" ? 16 : it.unit === "gal" ? 128 : it.unit === "qt" ? 32 : it.unit === "pt" ? 16 : 1);
  const sig = (it) => `${Math.round(qty(it) * 100)}|${it.unit}|${it.pieces}`;
  const seen = new Set([sig(me)]);
  const out = [];
  for (const r of collect([bits], 600)) {
    const it = itemOf(S, r, false);
    if (it.rank === me.rank || it.cat !== me.cat || it.brand.toLowerCase() !== brandKey || it.retired || it.placeholder || it.priceCents == null) continue;
    if (it.packListing || BUNDLE_RX.test(it.name)) continue;      // a "(6 pack)" bundle of the same size is not another size
    const w = nameWords(it, brandToks);
    let both = 0; for (const x of w) if (mine.has(x)) both++;
    const sim = w.size + mine.size ? (2 * both) / (w.size + mine.size) : 1;
    if (sim < 0.6) continue;
    const k = sig(it);
    if (seen.has(k)) continue;           // one listing per size and count: the best ranked
    seen.add(k);
    out.push({ it, sim });
  }
  // the closest wording (same flavour) and the best sellers kept, then shown smallest to largest
  out.sort((a, b) => b.sim - a.sim || a.it.rank - b.it.rank);
  // shown by count (the single first, then the 8, 16, 40 count boxes), then by size
  return out.slice(0, limit).map((x) => x.it).sort((a, b) => a.pieces - b.pieces || (qty(a) || 0) - (qty(b) || 0));
}

// ---------------------------------------------------------------- what the app asks for: items with their value-brand equivalent
function searchValued(q, limit) { const r = search(q, limit); r.items = r.items.map(withValue); return r; }
const itemValued = (g) => withValue(item(g));
const lookupUpcValued = (key) => lookupUpc(key).map(withValue);
function lookupEquivalentValued(key) { const e = lookupEquivalent(key); if (e?.basis) withValue(e.basis); return e; }
const sizesValued = (g, limit) => sizesOf(g, limit).map(withValue);
/** Tools only: an item's value-brand equivalent with every candidate considered and why it was kept or set aside. */
function valueDebug(g) { const it = item(g); const candidates = []; const gv = it ? valueEquivalent(it, candidates) : null; return { it, gv, candidates }; }

// ---------------------------------------------------------------- messages
self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "load": { const stats = await load(m); postMessage({ type: "ready", id: m.id, stats }); break; }
      case "search": { postMessage({ type: "result", id: m.id, result: db ? searchValued(m.q, m.limit) : { query: m.q, items: [], notReady: true } }); break; }
      case "upc": { postMessage({ type: "result", id: m.id, result: db ? { items: lookupUpcValued(m.key), equivalent: lookupEquivalentValued(m.key) } : { notReady: true } }); break; }
      case "plu": { postMessage({ type: "result", id: m.id, result: db ? lookupPlu(m.code) : { notReady: true } }); break; }
      case "item": { postMessage({ type: "result", id: m.id, result: db ? itemValued(m.rank) : null }); break; }
      case "sizes": { postMessage({ type: "result", id: m.id, result: db ? sizesValued(m.rank, m.limit) : [] }); break; }
      case "unload": { db = null; loaded.clear(); tokCache.clear(); postMessage({ type: "result", id: m.id, result: true }); break; }
      default: postMessage({ type: "error", id: m.id, error: "unknown message " + m.type });
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, error: String(err && err.stack || err) });
  }
};

// for tools/search-harness.mjs (Node: tests and the gold search set); a module worker ignores exports
export { load, searchValued as search, lookupUpcValued as lookupUpc, lookupEquivalentValued as lookupEquivalent, lookupPlu, itemValued as item, item as itemRaw, sizesValued as sizesOf, valueDebug };
