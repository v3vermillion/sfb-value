#!/usr/bin/env node
// make-walmart-gold.mjs — data/gold-search-walmart.json from data/gold-search.json, for packs built with the "walmart" search
// scope (data/brands.json search_scope): the same 351 everyday queries, each expecting a Walmart-brand item of the product.
//
//   node app/tools/make-walmart-gold.mjs --db <a walmart-scope dist/db> [--full <an all-scope dist/db of the same snapshot>]
//
// Per query: the words that name another brand (the brand of the item the query finds in the --full pack, the pack's
// brands.json, or the generic name of a brand-name product) are taken out of what the item must contain, a brand-name product is expected as the generic words Walmart's value brand
// uses (data/brands.json generic_names) or as what the brand mostly makes (the pack's brands.json); the item must be one
// of Walmart's brands (walmart: true); a size is kept only when the query was for Walmart's own brand already.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize } from "../public/js/tokenize.js";
import { openPack } from "./search-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const dbDir = path.resolve(arg("db", path.join(ROOT, "app", "dist", "db")));
const current = JSON.parse(fs.readFileSync(path.join(dbDir, "current.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(dbDir, current.base, "manifest.json"), "utf8"));
if (!manifest.files.brands) throw new Error("this pack was not built with the walmart search scope (no brands.json)");
const phrases = JSON.parse(fs.readFileSync(path.join(dbDir, manifest.files.brands.path), "utf8")).phrases;
const brandsCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "brands.json"), "utf8"));
const walmart = new Set((brandsCfg.walmart_brands || []).map((b) => b.toLowerCase()));
const generic = brandsCfg.generic_names || {};
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "gold-search.json"), "utf8"));

const norm = (s) => tokenize(s).join(" ");
// the brand of the item each query finds when every brand is searched (data/gold-search.json's expectation, in the top 10)
const fullDir = arg("full", null);
const expectedBrand = new Map();
// the words Walmart's own names use, with how many use them: an expected word fewer than three of them have ("sipping") cannot
// be expected, and a word of the original item's brand ("bens", "libbys") is the brand unless twenty of them use it ("water")
const vocab = new Map();
{
  const own = await openPack(dbDir);
  const FRESH = new Set(["", "unbranded", "fresh produce", "produce", "fresh", "generic", "walmart", "no brand"]);
  for (const r of own.ids()) {
    const it = own.itemRaw(r);
    const b = String(it.brand || "").toLowerCase();
    if (it.placeholder || !(walmart.has(b) || FRESH.has(b.trim()))) continue;
    for (const t of new Set(tokenize(`${it.brand} ${it.name}`))) { const k = t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t; vocab.set(k, (vocab.get(k) || 0) + 1); }
  }
}
const uses = (w) => Math.min(...tokenize(w).map((t) => vocab.get(t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t) || 0));
const known = (w) => uses(w) >= 3;
// spellings Walmart's own names use for a word volunteers type
const ALIAS = { bbq: "bbq|barbecue", "all purpose": "all purpose|all-purpose", "all purpose flour": "all purpose flour|all-purpose", "mac and cheese": "macaroni", "mac n cheese": "macaroni" };
if (fullDir) {
  const full = await openPack(fullDir);
  const has = (g, it) => { const t = `${it.brand} ${it.name}`.toLowerCase(); return g.all.every((w) => t.includes(w)); };
  for (const g of gold.queries) { const it = full.search(g.q, 10).items.find((x) => has(g, x)); if (it?.brand) expectedBrand.set(g.q, norm(it.brand)); }
}
// "fruit snacks" also finds "Fruit Snack", "eggs" "Egg": the expected words are stems
const stem = (w) => w.split(" ").map((x) => (x.length > 3 && x.endsWith("s") && !x.endsWith("ss") ? x.slice(0, -1) : x)).join(" ");
const isBrand = (w) => phrases[norm(w)] !== undefined || Object.keys(brandsCfg.stores || {}).some((st) => (brandsCfg.stores[st].brands || []).some((b) => norm(b) === norm(w)));
const out = [];
let changed = 0;
for (const g of gold.queries) {
  const eb = expectedBrand.get(g.q);
  const inBrand = (w) => tokenize(w).every((t) => eb.split(" ").some((b) => b.startsWith(t))) || eb.replace(/ /g, "") === norm(w).replace(/ /g, "");
  const ofBrand = (w) => isBrand(w) || generic[norm(w)] || (eb && !walmart.has(eb) && inBrand(w) && uses(w) < 20);
  const otherBrand = g.all.some((w) => !walmart.has(w.toLowerCase()) && ofBrand(w));
  let all = g.all.filter((w) => !walmart.has(w.toLowerCase()) && !ofBrand(w) && known(w));
  if (!all.length) {
    // only a brand was expected ("gerber baby food", "cheerios"): the rest of the query ("baby food"), else the brand-name
    // product's generic words, else what the brand mostly makes
    const brandWords = new Set(g.all.flatMap((w) => tokenize(w)));
    const rest = tokenize(g.q).filter((t) => !brandWords.has(t) && !/^\d/.test(t) && !["gv", "great", "value"].includes(t) && !generic[t] && !isBrand(t) && known(t));
    const gn = g.all.map((w) => generic[norm(w)]).find(Boolean);
    const pr = g.all.map((w) => phrases[norm(w)]?.[1]).find(Boolean);
    if (rest.length) all = rest;
    else if (gn || pr) all = [tokenize(gn || pr).slice(-1)[0]];
    else { out.push({ q: g.q, skip: "a brand Walmart's brands have no counterpart of" }); continue; }
  }
  const q = { q: g.q, all: all.map((w) => ALIAS[w] || stem(w)), walmart: true };
  if (g.size && !otherBrand) q.size = g.size;
  if (g.cat != null) q.cat = g.cat;
  if (JSON.stringify(all) !== JSON.stringify(g.all) || !g.size !== !q.size) changed++;
  out.push(q);
}
const note = "Search gold set for packs built with the walmart search scope (data/brands.json search_scope): data/gold-search.json's queries, each expecting one of Walmart's brands (walmart_brands; or unbranded fresh food) whose brand + name contains every word of `all` (size within 3% and `cat` when given) in the top 3. Generated by app/tools/make-walmart-gold.mjs (--db a walmart-scope pack, --full an all-scope pack of the same snapshot, for the brand of each query's original item) from data/gold-search.json and data/brands.json generic_names; edit those or the generator, not this file. `skip`: a query no Walmart brand answers (left out of the rate).";
fs.writeFileSync(path.join(ROOT, "data", "gold-search-walmart.json"), JSON.stringify({ note, queries: out }, null, 1) + "\n");
console.log(`${out.length} queries, ${changed} changed from data/gold-search.json, ${out.filter((x) => x.skip).length} skipped`);
