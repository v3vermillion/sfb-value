// Typed search when only Walmart's brands are searched (data/brands.json search_scope "walmart", owner 2026-10-27): "green
// beans 14.5 oz" shows Walmart's own green beans, nearest size first; another brand typed is set aside and named; a brand
// alone shows what it mostly makes in Walmart's brands; a name brand stays findable by its barcode, valued at its
// Great Value equivalent.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPack } from "../tools/search-harness.mjs";
import { typedSize } from "../public/js/tokenize.js";
import { fromItem, withTypedSize, typedCents, valueAt } from "../public/js/resolve.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let id = 5000;
const row = (name, brand, price, extra = {}) => ({ id: id++, upc: String(80000000000 + id).padStart(14, "0"), name, brand, price, size: null, unit: null, pack: 1,
  cat: "6", dept: "Food", flags: [], primary: true, stock: "Available", ...extra });
// another brand needs 20 listings before its name is set aside by a typed search
const many = (brand, product, cat, n, extra = {}) => Array.from({ length: n }, (_, i) => row(`${brand} ${product} ${i + 1}, 15 oz`, brand, 1.5 + i / 100, { size: 15, unit: "oz", cat, ...extra }));
const ROWS = [
  row("Great Value Cut Green Beans, 14.5 oz Can", "Great Value", 0.5, { size: 14.5, unit: "oz", store_brand: true }),
  row("Great Value Cut Green Beans, 28 oz Can", "Great Value", 1.42, { size: 28, unit: "oz", store_brand: true }),
  row("Great Value Cut Green Beans, 8 oz", "Great Value", 0.68, { size: 8, unit: "oz", store_brand: true }),
  row("Del Monte Cut Green Beans, 14.5 oz Can", "Del Monte", 1.33, { size: 14.5, unit: "oz" }),
  ...many("Del Monte", "Sweet Corn", "6", 24),
  row("Great Value Sweet Cream Salted Butter, 16 oz", "Great Value", 2.98, { size: 16, unit: "oz", cat: "2", store_brand: true }),
  row("Great Value Creamy Peanut Butter, 16 oz", "Great Value", 2.24, { size: 16, unit: "oz", cat: "11", store_brand: true }),
  row("Land O Lakes Salted Butter, 16 oz", "Land O Lakes", 4.98, { size: 16, unit: "oz", cat: "2" }),
  row("Doritos Nacho Cheese Tortilla Chips, 9.25 oz", "Doritos", 4.98, { size: 9.25, unit: "oz", cat: "9" }),
  ...Array.from({ length: 22 }, (_, i) => row(`Doritos Cool Ranch Tortilla Chips ${i + 1}, 9.25 oz`, "Doritos", 4.98, { size: 9.25, unit: "oz", cat: "9" })),
  row("Great Value Restaurant Style Tortilla Chips, 13 oz", "Great Value", 2.32, { size: 13, unit: "oz", cat: "9", store_brand: true }),
  row("Mainstays 16 oz Milk Bottle, 2-Pack", "Mainstays", 4.3, { size: 16, unit: "oz", cat: "17", dept: "Home", store_brand: true }),
  row("Great Value Whole Vitamin D Milk, 1 Gallon", "Great Value", 3.12, { size: 128, unit: "fl oz", cat: "2", store_brand: true }),
  row("Organic Bananas, each", "Unbranded", 0.25, { cat: "1", dept: "Food" }),
  row("Dole Bananas, 3 lb Bag", "Dole", 1.98, { size: 3, unit: "lb", cat: "1" }),
  // Walmart's feed files another brand's listing under its own name
  row("Del Monte Fresh Cut Blue Lake Green Beans, 14.5 oz", "Great Value", 1.2, { size: 14.5, unit: "oz", store_brand: true }),
];

let db;
before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfb-walmart-"));
  const pub = path.join(tmp, "store", "build", "published");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, "items.jsonl.gz"), zlib.gzipSync(ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  fs.writeFileSync(path.join(pub, "manifest.json"), JSON.stringify({ version: "test-w", published: "2026-10-27T00:00:00Z" }));
  execFileSync(process.execPath, [path.join(APP, "tools", "build-db.mjs"), "--store", path.join(tmp, "store"), "--out", path.join(tmp, "db"), "--search", "walmart"], { stdio: "ignore" });
  db = await openPack(path.join(tmp, "db"));
});
const top = (q) => db.search(q, 10);

test("only Walmart's brands (and unbranded fresh food) answer a typed search", () => {
  assert.equal(db.manifest.searchScope, "walmart");
  for (const q of ["green beans", "butter", "tortilla chips", "bananas"]) {
    for (const it of top(q).items) assert.ok(it.storeBrand || /^unbranded$/i.test(it.brand), `${q}: ${it.brand} ${it.name}`);
  }
  assert.equal(top("bananas").items[0].name, "Organic Bananas, each");
});

test("a size typed ranks the nearest size first, in any unit, and never hides the others", () => {
  const r = top("green beans 28 oz");
  assert.equal(r.size.text, "28 oz");
  assert.match(r.items[0].name, /28 oz/);
  assert.ok(r.items.some((x) => /14\.5 oz/.test(x.name)), "the other sizes are still there");
  assert.match(top("green beans 1 lb").items[0].name, /14\.5 oz/, "16 oz is nearest the 14.5 oz can");
  assert.deepEqual(typedSize("eggs dozen"), { dim: "ct", qty: 12, text: "dozen" });
  assert.equal(typedSize("2 liter cola").qty.toFixed(1), "67.6");
});

test("another brand typed is set aside and named; Walmart's own version comes first", () => {
  const r = top("del monte green beans");
  assert.deepEqual(r.setAside, ["del monte"]);
  assert.match(r.items[0].name, /^Great Value Cut Green Beans/);
  assert.ok(!r.items.some((x) => /Del Monte/.test(x.name)), "a listing Walmart filed under its own brand is still Del Monte's");
});

test("a brand alone shows what it mostly makes, in Walmart's brands", () => {
  const r = top("doritos");
  assert.equal(r.brandProduct, "tortilla chips");
  assert.match(r.items[0].name, /^Great Value .*Tortilla Chips/);
});

test("a plain word is the plain product, and a food word the food", () => {
  assert.match(top("butter").items[0].name, /Salted Butter/, "butter, not peanut butter");
  assert.match(top("milk").items[0].name, /Whole Vitamin D Milk/, "milk, not a milk bottle");
});

test("a name brand is still found by its barcode and valued at its Great Value equivalent", () => {
  const delMonte = ROWS.find((r) => r.name === "Del Monte Cut Green Beans, 14.5 oz Can");
  const items = db.lookupUpc(Number(delMonte.upc));
  assert.equal(items[0].name, delMonte.name);
  assert.equal(items[0].gv?.basis.name, "Great Value Cut Green Beans, 14.5 oz Can");
  assert.equal(items[0].gv.cents, 50);
});

test("an item tapped in another size than the one typed is priced for the size typed", () => {
  const can = top("green beans").items.find((x) => x.name === "Great Value Cut Green Beans, 14.5 oz Can");
  const res = withTypedSize(fromItem(can), typedSize("green beans 20 oz"));
  assert.equal(res.useTyped, true);
  assert.equal(res.unitCents, Math.round((50 / 14.5) * 20));
  assert.equal(withTypedSize(fromItem(can), typedSize("green beans 14.5 oz")).typed, undefined, "the same size: nothing to scale");
  assert.equal(withTypedSize(fromItem(can), typedSize("green beans 2 count")).typed, undefined, "another measure: nothing to scale");
  // valued at the brand's own price instead: the size typed follows
  const barilla = { ...can, brand: "Del Monte", name: "Del Monte Cut Green Beans, 14.5 oz Can", priceCents: 133, storeBrand: false,
    gv: { cents: 50, ownCents: 133, brand: "Great Value", basis: can, scaled: false } };
  const r = withTypedSize(fromItem(barilla), typedSize("20 oz"));
  assert.equal(typedCents(valueAt(r, barilla, true)), Math.round((133 / 14.5) * 20));
});
