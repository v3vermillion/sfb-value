#!/usr/bin/env node
// gold.mjs — the search gold set (data/gold-search.json) against a built pack, with the app's own search worker.
//
//   node --max-old-space-size=6144 app/tools/gold.mjs --db dist/db [--json gold.json] [--min 0.95] [--block 0.90]
//
// A query passes when an item containing every expected word (brand + name, lower-case; size within 3% and category when given)
// is among the top 3 results. A query whose expected item is in no row of the pack (its department not crawled yet)
// is "not covered" and left out of the rate. Prints a markdown report (append it to $GITHUB_STEP_SUMMARY); exit 0,
// or 3 when the rate is below --block (the deploy keeps the previous build), with the outcome in $GITHUB_OUTPUT
// (rate, passed, total, below_min, below_block) when that file is set.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPack } from "./search-harness.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const dbDir = arg("db", path.join(APP, "dist", "db"));
// a pack built with the "walmart" search scope (data/brands.json) answers with Walmart's brands only: its gold set expects them
const scopeOf = () => { try { const c = JSON.parse(fs.readFileSync(path.join(dbDir, "current.json"), "utf8")); return JSON.parse(fs.readFileSync(path.join(dbDir, c.base, "manifest.json"), "utf8")).searchScope; } catch { return null; } };
const goldFile = arg("gold", path.join(APP, "..", "data", scopeOf() === "walmart" ? "gold-search-walmart.json" : "gold-search.json"));
const WALMART = new Set((() => { try { return JSON.parse(fs.readFileSync(path.join(APP, "..", "data", "brands.json"), "utf8")).walmart_brands || []; } catch { return []; } })().map((b) => b.toLowerCase().replace(/['’]/g, "")));
const min = Number(arg("min", "0.95")), block = Number(arg("block", "0.90"));

const TO = { oz: ["oz", 1], lb: ["oz", 16], "fl oz": ["fl oz", 1], g: ["oz", 0.035274], kg: ["oz", 35.274], ml: ["fl oz", 0.033814], l: ["fl oz", 33.814], gal: ["fl oz", 128], qt: ["fl oz", 32], pt: ["fl oz", 16] };
export function sizeOk(want, it) {
  if (!want) return true;
  const a = TO[it.unit], b = TO[want[1]];
  if (!it.size || !a || !b || a[0] !== b[0]) return false;
  return Math.abs(it.size * a[1] - want[0] * b[1]) / (want[0] * b[1]) <= 0.03;
}
export const satisfies = (g, it) => { const t = `${it.brand} ${it.name}`.toLowerCase(); return g.all.every((w) => w.split("|").some((x) => t.includes(x))) && sizeOk(g.size, it) && (g.cat == null || it.cat === g.cat)
  && (!g.walmart || WALMART.has(String(it.brand || "").toLowerCase().replace(/['’]/g, "")) || FRESH.has(String(it.brand || "").toLowerCase().trim())); };
// unbranded fresh food is searched beside Walmart's brands (app/tools/build-db.mjs GENERIC_BRANDS)
const FRESH = new Set(["", "unbranded", "fresh produce", "produce", "fresh", "generic", "walmart", "no brand"]);

const gold = JSON.parse(fs.readFileSync(goldFile, "utf8")).queries.filter((g) => !g.skip);
const db = await openPack(dbDir);
// coverage: one pass over the pack's names
const covered = new Array(gold.length).fill(false);
for (const r of db.ids()) {
  const it = db.itemRaw(r);          // names only: no value-brand equivalent worked out for every item of the pack
  if (it.placeholder) continue;
  for (let i = 0; i < gold.length; i++) if (!covered[i] && satisfies(gold[i], it)) covered[i] = true;
}
let passed = 0, total = 0;
const misses = [], uncovered = [];
const t0 = performance.now();
gold.forEach((g, i) => {
  if (!covered[i]) { uncovered.push(g.q); return; }
  total++;
  const r = db.search(g.q, 10);
  const rank = r.items.findIndex((it) => satisfies(g, it));
  if (rank >= 0 && rank < 3) passed++;
  else misses.push({ q: g.q, want: g.all.join(" + ") + (g.size ? ` (${g.size.join(" ")})` : ""), rank, top: r.items.slice(0, 3).map((it) => `${it.brand ? it.brand + " · " : ""}${it.name}`) });
});
const rate = total ? passed / total : 0;
const ms = Math.round(performance.now() - t0);
const L = [`### Search gold set`, ``, `**${passed}/${total}** queries have the right item in the top 3 (${(100 * rate).toFixed(1)}%; alert below ${100 * min}%, deploy blocked below ${100 * block}%). ${gold.length - total} not covered by this pack. ${ms} ms for all searches.`];
if (misses.length) {
  L.push("", "| query | expected | found at | top 3 |", "|---|---|---|---|");
  for (const m of misses) L.push(`| ${m.q} | ${m.want} | ${m.rank < 0 ? "not in top 10" : m.rank + 1} | ${m.top.join("<br>").replace(/\|/g, "/")} |`);
}
if (uncovered.length) L.push("", `Not covered (no such item in the pack): ${uncovered.join(", ")}`);
console.log(L.join("\n"));
const json = arg("json", null);
if (json) fs.writeFileSync(json, JSON.stringify({ passed, total, rate, uncovered, misses }, null, 1));
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `rate=${rate.toFixed(4)}\npassed=${passed}\ntotal=${total}\nbelow_min=${rate < min}\nbelow_block=${rate < block}\n`);
}
process.exit(rate < block ? 3 : 0);
