#!/usr/bin/env node
// build-db.mjs — turn a published snapshot (a data-store checkout) into the app's binary database pack.
//
//   node --max-old-space-size=6144 app/tools/build-db.mjs --store <data-store dir> --out <dist/db dir>
//
// Reads  <store>/build/published/{items.jsonl.gz,manifest.json,stats.json} and <store>/identify/equivalents.jsonl.gz
// Writes <out>/files/<sha>.bin.gz          every shard file, named by its content (immutable, shared across versions)
//        <out>/<version>/manifest.json     the shard list and file names
//        <out>/<version>/{equiv.bin.gz, plu.json}
//        <out>/current.json  -> { version, base }
//
// Format "sfb-pack" 3: the items are split into SHARDS, one per department (a large one in parts), consumable departments
// first (tier "core"; durable goods are tier "more"). A phone downloads the core shards first and searches them while the
// rest arrive, and an update downloads only the files whose content changed: a weekly food refresh no longer re-sends
// every department, and no file comes near Cloudflare's 25 MiB limit. Each shard is self-contained, in the layout of
// format 2 (all integers little-endian, arrays 8-byte aligned, every .bin gzipped as a whole):
//   cols.bin     "SFBC" u32 N | price u32[N] cents | size f32[N] | pack u16[N] | unit u8[N] | basis u8[N] | flags u8[N] | cat u8[N] | id f64[N] | upc f64[N]
//                | flags2 u8[N] | valueBasis u32[N] (local rank, 0xFFFFFFFF = none) | rawPrice u32[N] cents (0 = not withheld)
//                | listingPack u16[N] (the N of a "(N pack)" bundle listing, 0 otherwise; trailing, a pack without it derives N)
//                price is what the app shows: Walmart's price, or for a withheld price (flags2 PRICE_WITHHELD) its
//                equivalent value, with Walmart's own price in rawPrice; flags2 bits: 1 placeholder (barcode lookup only,
//                never in the token index), 2 price withheld, 4 discontinued, bits 3-4 value confidence (0 rough .. 3 high),
//                32 the price is the store's own shelf price (manifest.store names the store), not Walmart.com's,
//                64 the price is far from comparable items by size (unit_price_suspect: often a case listed as one)
//                128 one unit of a "(N pack)" bundle listing (pack_listing): rawPrice then holds the bundle's own price
//   strings-K    "SFBS" u32 count u32 firstRank | offsets u32[count+1] | utf8 bytes of "brand\x1Fname" per item
//   upc.bin      "SFBU" u32 M | keys f64[M] sorted (GTIN-14 as a number; primary row first within a key) | ranks u32[M]
//   tokens.bin   "SFBT" u32 T u32 postingBytes | dictOff u32[T+1] | dict utf8 (tokens in byte order) | postOff u32[T+1] | postings (varint deltas of ascending ranks) | tokCat u8[T] (dominant category, 0 = none)
//                | headBytes u32 | headOff u32[T+1] | head postings: the items whose head noun (tokenize.js headNoun) is the token
// Shared by all shards, per version:
//   equiv.bin    "SFBE" u32 E | keys f64[E] sorted | est u32[E] cents | basis u32[E] (shard << 24 | local rank, 0xFFFFFFFF = none) | baseQty f32[E] | pack u16[E] | unit u8[E] | conf u8[E] | offsets u32[E+1] | utf8 "brand\x1Fname\x1Fquantity"
//   plu.json     codes with their price and the matched item as {shard, rank}
// Items are stored in RANK order within a shard (best candidate first), so the search worker's bitset scan from rank 0
// yields best-first results without sorting. Format 2 packs (one shard, files under the version folder) still load.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { uniqueTokens, tokenize, headNoun } from "../public/js/tokenize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const UNIT = { oz: 1, "fl oz": 2, lb: 3, ct: 4, g: 5, kg: 6, ml: 7, l: 8, gal: 9, qt: 10, pt: 11 };
const TO_OZ = { oz: 1, lb: 16, g: 0.035274, kg: 35.274 };
const TO_FLOZ = { "fl oz": 1, ml: 0.033814, l: 33.814, gal: 128, qt: 32, pt: 16 };
const F = { RETIRED: 1, NO_SIZE: 2, PROMO: 4, CARRIED: 8, STORE_BRAND: 16, PRIMARY: 32, SIZE_CONFLICT: 64, UNAVAILABLE: 128 };
const CORE_DEPTS = new Set(["Food", "Health and Medicine", "Pharmacy", "Personal Care", "Beauty", "Baby", "Pets", "Household Essentials"]);
const CONF = { low: 0, medium: 1, high: 2 };
const F2 = { PLACEHOLDER: 1, PRICE_WITHHELD: 2, DISCONTINUED: 4, STORE_PRICE: 32, UNIT_SUSPECT: 64, PACK_LISTING: 128 };
const VALUE_CONF = { rough: 0, low: 1, medium: 2, high: 3 };
const NO_RANK = 0xFFFFFFFF;

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const STORE = path.resolve(arg("store", path.join(APP, "build", "fixture-store")));
const OUT = path.resolve(arg("out", path.join(APP, "dist", "db")));
const MAX_ITEMS = Number(arg("max-items", "0")) || Infinity;

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// A data-store .jsonl.gz over 45 MB is stored as shards <name>.s000, <name>.s001, ... (crawler/store.py): read either form.
function jsonlFiles(file) {
  if (fs.existsSync(file)) return [file];
  const dir = path.dirname(file), base = path.basename(file);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(base + ".s") && /\.s\d{3}$/.test(n)).sort().map((n) => path.join(dir, n));
}

async function* jsonlGz(file) {
  const files = jsonlFiles(file);
  if (!files.length) throw new Error(`missing ${file}`);
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) if (line) yield JSON.parse(line);
  }
}

function gtinNumber(upc) {
  if (!upc) return 0;
  const d = String(upc).replace(/\D/g, "");
  if (!d || d.length > 14) return 0;
  return Number(d.padStart(14, "0"));
}

// ---------------------------------------------------------------- 1. read items
const pubDir = path.join(STORE, "build", "published");
const srcManifest = JSON.parse(fs.readFileSync(path.join(pubDir, "manifest.json"), "utf8"));
const srcStats = fs.existsSync(path.join(pubDir, "stats.json")) ? JSON.parse(fs.readFileSync(path.join(pubDir, "stats.json"), "utf8")) : {};
// The pack version names the snapshot plus a hash of everything else that shapes the pack bytes (the equivalents
// table, this builder, the tokenizer, the format), so an identify refresh or a builder change ships as a new version
// instead of new bytes under an "immutable" URL that phones already hold.
const snapshot = String(srcManifest.version);
const FORMAT_VERSION = 3;
const packHash = crypto.createHash("sha256").update(`sfb-pack/${FORMAT_VERSION}\n`);
const CATEGORIES_FILE = path.join(APP, "..", "data", "categories.json");
const STORE_FILE = path.join(APP, "..", "data", "store.json");
const BRANDS_FILE = path.join(APP, "..", "data", "brands.json");
for (const f of [fileURLToPath(import.meta.url), path.join(APP, "public", "js", "tokenize.js"), path.join(STORE, "identify", "equivalents.jsonl.gz"), CATEGORIES_FILE, STORE_FILE, BRANDS_FILE]) {
  const parts = jsonlFiles(f);
  packHash.update(parts.length ? Buffer.concat(parts.map((p) => fs.readFileSync(p))) : Buffer.from("none")).update("\n");
}
const version = `${snapshot}-${packHash.digest("hex").slice(0, 8)}`;
log(`reading snapshot ${snapshot} from ${pubDir} (pack ${version})`);

const items = [];
for await (const r of jsonlGz(path.join(pubDir, srcManifest.file || "items.jsonl.gz"))) {
  if (items.length >= MAX_ITEMS) break;
  const flags = r.flags || [];
  let bits = 0;
  if (flags.includes("retired_upc")) bits |= F.RETIRED;
  if (flags.includes("no_size") || r.size == null) bits |= F.NO_SIZE;
  if (flags.includes("promo_price") || flags.includes("kept_normal_price")) bits |= F.PROMO;
  if (flags.includes("carried_over")) bits |= F.CARRIED;
  if (flags.includes("size_conflict")) bits |= F.SIZE_CONFLICT;
  if (r.store_brand) bits |= F.STORE_BRAND;
  if (r.primary) bits |= F.PRIMARY;
  const stock = flags.includes("store_price") && r.store_stock ? r.store_stock : r.stock;   // the store's shelf when known
  if (stock && stock !== "Available") bits |= F.UNAVAILABLE;
  let bits2 = 0;
  if (flags.includes("placeholder")) bits2 |= F2.PLACEHOLDER;
  if (flags.includes("discontinued")) bits2 |= F2.DISCONTINUED;
  if (flags.includes("store_price")) bits2 |= F2.STORE_PRICE;
  if (flags.includes("unit_price_suspect")) bits2 |= F2.UNIT_SUSPECT;
  const packListing = flags.includes("pack_listing") && Number(r.listing_price) > 0 && Number(r.listing_pack) > 1;
  if (packListing) bits2 |= F2.PACK_LISTING;
  const withheld = Boolean(r.price_withheld && r.equiv && r.equiv.price > 0);
  if (withheld) bits2 |= F2.PRICE_WITHHELD | ((VALUE_CONF[r.equiv.confidence] ?? 0) << 3);
  const name = String(r.name || "").trim();
  const brand = String(r.brand || "").trim();
  const upc = gtinNumber(r.upc);
  let score = 0;
  if (r.primary) score += 3;
  if (upc) score += 1;
  if (r.store_brand) score += 2;
  if (!(bits & F.UNAVAILABLE)) score += 1.5;
  if (CORE_DEPTS.has(r.dept)) score += 1;
  if (r.online) score += 0.3;
  if (r.reviews > 0) score += Math.min(1.5, Math.log10(1 + r.reviews) * 0.5);   // well-known items before obscure listings
  if (bits & F.CARRIED) score -= 1;
  if (bits & F.RETIRED) score -= 3;
  if (bits & F.NO_SIZE) score -= 0.5;
  if (bits & F.PROMO) score -= 0.2;
  if (bits2 & F2.PLACEHOLDER) score -= 2;
  if (withheld) score -= 1;
  if (bits2 & F2.UNIT_SUSPECT) score -= 1;      // priced far from items of its size: likely a case or multipack listing
  score -= Math.min(1, name.length / 120);
  if (/^\s*\(\d+\s*pack\)/i.test(name)) score -= 0.8;   // "(6 pack) ..." multipacks after the single item a volunteer holds
  items.push({
    id: Number(r.id), upc, name, brand, price: Math.round(Number(withheld ? r.equiv.price : r.price) * 100), size: r.size == null ? 0 : Number(r.size),
    flags2: bits2, rawPrice: withheld ? Math.round(Number(r.price) * 100) : packListing ? Math.round(Number(r.listing_price) * 100) : 0,
    listingPack: packListing ? Math.min(0xFFFF, Math.round(Number(r.listing_pack))) : 0, valueBasisId: withheld && r.equiv.basis_id != null ? Number(r.equiv.basis_id) : null,
    unit: UNIT[r.unit] || 0, unitName: r.unit || null, pack: Math.min(65535, Number(r.pack) || 1), basis: r.basis === "lb" ? 1 : 0,
    cat: Number(r.cat) || 0, flags: bits, score, dept: r.dept || "Other",
  });
}
log(`${items.length.toLocaleString()} items parsed`);

// ---------------------------------------------------------------- 2. shards: one per department (big ones in parts)
const SHARD_MAX = Number(arg("shard-max", "600000"));
const catCfg = fs.existsSync(CATEGORIES_FILE) ? JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf8")) : { departments: [] };
const consumable = new Set(catCfg.departments.filter((d) => d.consumable).map((d) => d.name));
const deptOrder = new Map(catCfg.departments.map((d, i) => [d.name, i]));
const SHARD_OF = { Pharmacy: "Health and Medicine", "Premium Beauty": "Beauty" };    // tiny departments ride along
const slug = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const groups = new Map();
for (const it of items) {
  const name = SHARD_OF[it.dept] || it.dept;
  let g = groups.get(name);
  if (!g) { g = { name, tier: consumable.has(name) || consumable.has(it.dept) ? "core" : "more", items: [] }; groups.set(name, g); }
  g.items.push(it);
}
const shards = [];
for (const g of [...groups.values()].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "core" ? -1 : 1) || ((deptOrder.get(a.name) ?? 99) - (deptOrder.get(b.name) ?? 99)))) {
  g.items.sort((a, b) => (b.score - a.score) || (a.id - b.id));
  const parts = Math.ceil(g.items.length / SHARD_MAX);
  for (let p = 0; p < parts; p++) {
    shards.push({ id: slug(g.name) + (parts > 1 ? `-${p + 1}` : ""), name: g.name, tier: g.tier,
      depts: [...new Set(g.items.map((it) => it.dept))], items: g.items.filter((_, i) => i % parts === p) });   // interleaved: each part keeps a best-first mix
  }
}
if (shards.length > 255) throw new Error(`${shards.length} shards: the equivalents table addresses at most 255`);
const where = new Map();                 // Walmart id -> [shard index, local rank]
shards.forEach((sh, si) => sh.items.forEach((it, r) => where.set(it.id, [si, r])));
const N = items.length;
log(`${shards.length} shards: ${shards.map((s) => `${s.id} ${s.items.length.toLocaleString()}`).join(", ")}`);

// ---------------------------------------------------------------- helpers for binary writing
const MAGIC = (s) => Buffer.from(s, "ascii");
const pad8 = (n) => (n + 7) & ~7;
function concatAligned(parts) {
  // each part: Buffer; align the START of every part to 8 bytes
  let total = 0;
  for (const p of parts) total = pad8(total) + p.length;
  const out = Buffer.alloc(pad8(total));
  let o = 0;
  for (const p of parts) { o = pad8(o); p.copy(out, o); o += p.length; }
  return out;
}
const u32 = (arr) => Buffer.from(new Uint32Array(arr).buffer);
const header = (magic, ...nums) => Buffer.concat([MAGIC(magic), u32(nums)]);

fs.mkdirSync(path.join(OUT, version), { recursive: true });
fs.mkdirSync(path.join(OUT, "files"), { recursive: true });
const MAX_ASSET_BYTES = Number(process.env.SFB_MAX_ASSET_BYTES) || 24 * 1048576;   // Cloudflare static assets reject a file over 25 MiB
// a shard file is named by its content: an unchanged shard keeps its name from version to version, so a phone that has it
// never downloads it again
function writeFile(name, buf) {
  const gz = zlib.gzipSync(buf, { level: 6 });
  if (gz.length > MAX_ASSET_BYTES) throw new Error(`${name}.gz is ${(gz.length / 1048576).toFixed(1)} MiB, over the 24 MiB file limit: lower --shard-max`);
  const sha = crypto.createHash("sha256").update(gz).digest("hex").slice(0, 20);
  const rel = `files/${sha}.bin.gz`;
  if (!fs.existsSync(path.join(OUT, rel))) fs.writeFileSync(path.join(OUT, rel), gz);
  return { path: rel, bytes: buf.length, gzBytes: gz.length };
}
function writeVersionFile(name, buf) {
  const gz = zlib.gzipSync(buf, { level: 6 });
  fs.writeFileSync(path.join(OUT, version, name + ".gz"), gz);
  return { path: `${version}/${name}.gz`, bytes: buf.length, gzBytes: gz.length };
}
function varints(lists, keyOrder) {
  // varint-delta encode the ascending rank lists in keyOrder; returns { bytes, off }
  let total = 0;
  for (const k of keyOrder) total += (lists.get(k) || []).length;
  let buf = Buffer.alloc(Math.max(1024, total * 2)), p = 0;
  const off = new Uint32Array(keyOrder.length + 1);
  keyOrder.forEach((k, j) => {
    const a = lists.get(k) || [];
    if (p + a.length * 5 > buf.length) { const nb = Buffer.alloc(buf.length * 2 + a.length * 5); buf.copy(nb, 0, 0, p); buf = nb; }
    let prev = -1;
    for (const r of a) { let v = r - prev - 1; prev = r; while (v >= 0x80) { buf[p++] = (v & 0x7f) | 0x80; v >>>= 7; } buf[p++] = v; }
    off[j + 1] = p;
  });
  return { bytes: buf.subarray(0, p), off, total };
}

// ---------------------------------------------------------------- 3. one shard's files
function writeShard(sh, si) {
  const its = sh.items, n = its.length;
  const files = {};
  { // columns
    const price = new Uint32Array(n), size = new Float32Array(n), pack = new Uint16Array(n), unit = new Uint8Array(n),
      basis = new Uint8Array(n), flags = new Uint8Array(n), cat = new Uint8Array(n), id = new Float64Array(n), upc = new Float64Array(n);
    const flags2 = new Uint8Array(n), valueBasis = new Uint32Array(n).fill(NO_RANK), rawPrice = new Uint32Array(n), listingPack = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const it = its[i];
      price[i] = it.price; size[i] = it.size; pack[i] = it.pack; unit[i] = it.unit; basis[i] = it.basis; flags[i] = it.flags; cat[i] = it.cat; id[i] = it.id; upc[i] = it.upc;
      flags2[i] = it.flags2; rawPrice[i] = Math.min(0xFFFFFFFF, it.rawPrice); listingPack[i] = it.listingPack || 0;
      const w = it.valueBasisId != null ? where.get(it.valueBasisId) : null;
      if (w && w[0] === si) valueBasis[i] = w[1];               // a basis in another shard is shown without its card
    }
    files.cols = writeFile("cols.bin", concatAligned([header("SFBC", n), ...[price, size, pack, unit, basis, flags, cat, id, upc, flags2, valueBasis, rawPrice, listingPack].map((a) => Buffer.from(a.buffer))]));
  }
  { // names, in parts of at most ~40 MB raw
    const SHARD_BYTES = 40 * 1048576;
    let start = 0;
    files.strings = [];
    while (start < n) {
      const bufs = [], offs = [0];
      let bytes = 0, end = start;
      while (end < n && bytes < SHARD_BYTES) { const b = Buffer.from(its[end].brand + "\x1F" + its[end].name, "utf8"); bufs.push(b); bytes += b.length; offs.push(bytes); end++; }
      files.strings.push({ ...writeFile("strings.bin", concatAligned([header("SFBS", end - start, start), u32(offs), Buffer.concat(bufs)])), firstRank: start, count: end - start });
      start = end;
    }
  }
  let upcs = 0;
  { // barcodes
    const rows = [];
    for (let i = 0; i < n; i++) if (its[i].upc) rows.push(i);
    rows.sort((a, b) => (its[a].upc - its[b].upc) || (((its[b].flags & F.PRIMARY) ? 1 : 0) - ((its[a].flags & F.PRIMARY) ? 1 : 0)) || (a - b));
    const keys = new Float64Array(rows.length), ranks = new Uint32Array(rows.length);
    for (let j = 0; j < rows.length; j++) { keys[j] = its[rows[j]].upc; ranks[j] = rows[j]; }
    files.upc = writeFile("upc.bin", concatAligned([header("SFBU", rows.length), Buffer.from(keys.buffer), Buffer.from(ranks.buffer)]));
    upcs = rows.length;
  }
  let T = 0, postings = 0;
  { // words, and the items each word is the head noun of
    const post = new Map(), head = new Map();
    for (let i = 0; i < n; i++) {
      if (its[i].flags2 & F2.PLACEHOLDER) continue;            // barcode lookup only: a placeholder name never answers a typed search
      for (const t of uniqueTokens(its[i].brand + " " + its[i].name)) { let a = post.get(t); if (!a) { a = []; post.set(t, a); } a.push(i); }
      const h = headNoun(its[i].name);
      if (h && post.has(h)) { let a = head.get(h); if (!a) { a = []; head.set(h, a); } a.push(i); }
    }
    const tokens = Array.from(post.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));   // UTF-16 order == byte order for ASCII
    T = tokens.length;
    const dictOff = new Uint32Array(T + 1), dictParts = [];
    let d = 0;
    for (let k = 0; k < T; k++) { const b = Buffer.from(tokens[k], "utf8"); dictParts.push(b); d += b.length; dictOff[k + 1] = d; }
    const p = varints(post, tokens), h = varints(head, tokens);
    postings = p.total;
    const tokCat = new Uint8Array(T);       // dominant category per word: search favours items in the category a word usually means
    for (let k = 0; k < T; k++) {
      const a = post.get(tokens[k]), counts = new Map(), step = Math.max(1, Math.floor(a.length / 2000));
      for (let j = 0; j < a.length; j += step) { const c = its[a[j]].cat; counts.set(c, (counts.get(c) || 0) + 1); }
      let best = 0, bestN = 0, total = 0;
      for (const [c, m] of counts) { total += m; if (m > bestN) { bestN = m; best = c; } }
      tokCat[k] = bestN >= total * 0.45 ? best : 0;
    }
    files.tokens = writeFile("tokens.bin", concatAligned([header("SFBT", T, p.bytes.length), Buffer.from(dictOff.buffer), Buffer.concat(dictParts),
      Buffer.from(p.off.buffer), p.bytes, Buffer.from(tokCat.buffer), u32([h.bytes.length]), Buffer.from(h.off.buffer), h.bytes]));
  }
  const gz = [files.cols, ...files.strings, files.upc, files.tokens].reduce((a, f) => a + f.gzBytes, 0);
  log(`shard ${sh.id} (${sh.tier}): ${n.toLocaleString()} items, ${T.toLocaleString()} words, ${(gz / 1048576).toFixed(1)} MB`);
  return { id: sh.id, name: sh.name, tier: sh.tier, depts: sh.depts, items: n, upcs, tokens: T, postings, gzBytes: gz, files };
}
const shardMeta = shards.map(writeShard);

// ---------------------------------------------------------------- 4. equivalents (other-store barcodes)
const gid = (w) => (w ? (w[0] << 24) | w[1] : NO_RANK) >>> 0;
const versionFiles = {};
{
  const eqFile = path.join(STORE, "identify", "equivalents.jsonl.gz");
  const rows = [];
  if (jsonlFiles(eqFile).length) {
    for await (const e of jsonlGz(eqFile)) {
      const key = gtinNumber(e.upc);
      if (!key || !(e.est_price > 0)) continue;
      rows.push({ key, est: Math.round(e.est_price * 100), basis: gid(where.get(Number(e.basis_id))),
        baseQty: Number(e.base_qty) || 0, pack: Math.min(65535, Number(e.pack) || 1), unit: UNIT[e.base_unit] || 0, conf: (CONF[e.confidence] ?? 0) | (Number(e.store_brand_factor) > 0 ? 4 : 0),
        str: Buffer.from(`${e.brand || ""}\x1F${e.name || ""}\x1F${e.quantity || ""}`, "utf8") });
    }
  }
  rows.sort((a, b) => a.key - b.key);
  const E = rows.length;
  const keys = new Float64Array(E), est = new Uint32Array(E), basisG = new Uint32Array(E), baseQty = new Float32Array(E), pack = new Uint16Array(E), unit = new Uint8Array(E), conf = new Uint8Array(E), offs = new Uint32Array(E + 1);
  let o = 0;
  for (let j = 0; j < E; j++) { const r = rows[j]; keys[j] = r.key; est[j] = r.est; basisG[j] = r.basis; baseQty[j] = r.baseQty; pack[j] = r.pack; unit[j] = r.unit; conf[j] = r.conf; o += r.str.length; offs[j + 1] = o; }
  versionFiles.equiv = writeVersionFile("equiv.bin", concatAligned([header("SFBE", E), ...[keys, est, basisG, baseQty, pack, unit, conf, offs].map((a) => Buffer.from(a.buffer)), Buffer.concat(rows.map((r) => r.str))]));
  versionFiles._equivalents = E;
}

// ---------------------------------------------------------------- 8. PLU produce table, priced from the snapshot when possible
// A code is priced from a produce row only when the row names everything that distinguishes the code ("yellow bell
// pepper", not any bell pepper; "blood orange", not a bag of navels), loose produce is preferred over bags and packs,
// and a price outside 0.4-2.5x the code's typical price falls back to the typical one: a wrong match never prices a code.
const PLU_GENERIC = new Set(["fresh", "small", "medium", "large", "extra", "jumbo", "greenhouse", "conventional", "loose", "each", "lb", "per", "whole", "the", "and", "of"]);
const singular = (t) => (t.endsWith("ies") ? t.slice(0, -3) + "y" : t.endsWith("oes") ? t.slice(0, -2) : t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
function pluMatchWords(c) {
  const own = tokenize(c.name).filter((t) => !/^\d/.test(t) && !PLU_GENERIC.has(t)).map(singular);
  return [...new Set([...(c.match || []).map(singular), ...own])];
}
{
  const src = JSON.parse(fs.readFileSync(path.join(APP, "data", "plu.json"), "utf8"));
  const produce = [];          // [shard, local rank, item]
  shards.forEach((sh, si) => sh.items.forEach((it, r) => { if (it.cat === 1 && !(it.flags2 & (F2.PLACEHOLDER | F2.PRICE_WITHHELD))) produce.push([si, r, it]); }));
  const toks = new Map(produce.map(([, , it]) => [it, tokenize(it.name).map(singular)]));
  const out = [];
  let priced = 0, outOfBand = 0;
  for (const c of src.codes) {
    const words = pluMatchWords(c);
    let best = null;
    for (const [si, r, it] of produce) {
      const tk = toks.get(it);
      if (!words.every((m) => tk.some((t) => t.startsWith(m)))) continue;
      let price = null;
      if (c.unit === "lb") {
        if (it.basis === 1) price = it.price / 100;
        else if (it.size && it.unitName in TO_OZ) price = it.price / 100 / ((it.size * TO_OZ[it.unitName]) / 16 * it.pack);
      } else if (c.unit === "each") {
        if (!it.size || it.unitName === "ct") price = it.price / 100 / (it.unitName === "ct" ? it.size * it.pack : it.pack);
      }
      if (price == null || !(price > 0)) continue;
      // loose first: sold the way the code is (by the pound / each), not a bag, a pack or a tray
      let fit = 0;
      if ((c.unit === "lb" && it.basis === 1) || (c.unit === "each" && !it.size)) fit += 2;
      if (/\b(bag|bags|pack|packs|tray|clamshell|container|pouch|box)\b|\(\d+\s*pack\)/i.test(it.name)) fit -= 2;
      fit -= 0.1 * Math.max(0, tk.length - words.length);       // extra words: a variety or a product made from it
      if (!best || fit > best.fit || (fit === best.fit && (si < best.shard || (si === best.shard && r < best.rank)))) best = { shard: si, rank: r, price, fit };
    }
    if (best && c.fallback > 0 && (best.price < 0.4 * c.fallback || best.price > 2.5 * c.fallback)) { best = null; outOfBand++; }
    if (best) priced++;
    out.push({ plu: c.plu, name: c.name, unit: c.unit, price: best ? Math.round(best.price * 100) / 100 : c.fallback, source: best ? "snapshot" : "typical", shard: best ? best.shard : null, rank: best ? best.rank : null });
  }
  const json = JSON.stringify({ built: new Date().toISOString(), codes: out });
  fs.writeFileSync(path.join(OUT, version, "plu.json"), json);
  versionFiles.plu = { path: `${version}/plu.json`, bytes: json.length, gzBytes: json.length };
  log(`PLU table: ${priced}/${out.length} codes priced from the snapshot, ${outOfBand} matches outside 0.4-2.5x typical, rest typical`);
}

// ---------------------------------------------------------------- 9. manifest + pointer
// The version names the snapshot plus every file it is made of (and the builder), so new bytes always arrive under a new
// version; file paths are relative to the db folder.
const allFiles = [...shardMeta.flatMap((m) => [m.files.cols, ...m.files.strings, m.files.upc, m.files.tokens]), versionFiles.equiv, versionFiles.plu];
const manifest = {
  format: "sfb-pack", formatVersion: FORMAT_VERSION, version, snapshot, published: srcManifest.published, built: new Date().toISOString(),
  priceDate: (srcStats.built || srcManifest.published || "").slice(0, 10),
  items: N, upcs: shardMeta.reduce((a, m) => a + m.upcs, 0), equivalents: versionFiles._equivalents,
  tokens: shardMeta.reduce((a, m) => a + m.tokens, 0), postings: shardMeta.reduce((a, m) => a + m.postings, 0),
  fixture: Boolean(srcManifest.fixture), gatesPassed: srcManifest.gates_passed ?? null, approvedManually: srcManifest.approved_manually ?? null,
  categories: catCfg.categories || null,
  // the other chains' store brands (data/brands.json): a typed brand ranks Walmart's own brand first, a scanned barcode under
  // a listed company prefix is named by its store; and the price above which nothing is in this list (the live check
  // treats a Walmart price above it as implausible)
  ...(() => {
    const title = (s) => String(s).replace(/(^|[\s(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    try {
      const b = JSON.parse(fs.readFileSync(BRANDS_FILE, "utf8"));
      const brands = {}, prefixes = {};
      for (const [store, d] of Object.entries(b.stores || {})) {
        for (const name of d.brands || []) brands[String(name).toLowerCase()] = store;
        for (const p of d.prefixes || []) prefixes[String(p)] = { store, brand: title((d.brands || [store])[0]) };
      }
      // Walmart's value brands and the generic words of brand-name products: every item is valued at its value-brand
      // equivalent (db-worker valueEquivalent; owner, 2026-10-26)
      return { brands, prefixes, valueBrands: b.walmart_value_brands || null, genericNames: b.generic_names || null };
    } catch { return { brands: {}, prefixes: {}, valueBrands: null, genericNames: null }; }
  })(),
  priceCeiling: Math.round(100 * Math.max(Number(catCfg.consumable_rules?.max_price) || 0, Number(catCfg.durable_rules?.max_price) || 0)) || null,
  store: (() => { try { const s = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); return { id: s.store_id, name: s.name, address: s.address, label: s.label || "Strongsville Walmart" }; } catch { return null; } })(),
  storePriced: items.filter((it) => it.flags2 & F2.STORE_PRICE).length,
  shards: shardMeta,
  files: { equiv: versionFiles.equiv, plu: versionFiles.plu },
  totalGzBytes: allFiles.reduce((a, f) => a + f.gzBytes, 0),
  coreGzBytes: shardMeta.filter((m) => m.tier === "core").reduce((a, m) => a + m.gzBytes, 0) + versionFiles.equiv.gzBytes + versionFiles.plu.gzBytes,
};
fs.writeFileSync(path.join(OUT, version, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, "current.json"), JSON.stringify({ version, snapshot, base: `${version}/`, items: N, priceDate: manifest.priceDate, fixture: manifest.fixture, formatVersion: FORMAT_VERSION }, null, 2));
log(`done: ${N.toLocaleString()} items in ${shards.length} shards, ${(manifest.totalGzBytes / 1048576).toFixed(1)} MB over the wire ` +
    `(core ${(manifest.coreGzBytes / 1048576).toFixed(1)} MB first) -> ${path.join(OUT, version)}`);
