// The search worker on a small real pack (built by tools/build-db.mjs from a handful of rows): relaxation order and
// ranking rules that real queries depend on.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPack } from "../tools/search-harness.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let id = 1000;
const row = (name, brand, price, extra = {}) => ({ id: id++, upc: String(70000000000 + id).padStart(14, "0"), name, brand, price, size: null, unit: null, pack: 1,
  cat: "7", dept: "Food", flags: [], primary: true, stock: "Available", ...extra });
const ROWS = [
  row("Great Value Pinto Beans, 32 oz", "Great Value", 2.12, { size: 32, unit: "oz", cat: "7", store_brand: true }),
  row("Great Value Dry Roasted Peanuts, 16 oz", "Great Value", 2.98, { size: 16, unit: "oz", cat: "9", store_brand: true }),
  row("Great Value Active Dry Yeast, 0.75 oz, 3 Count", "Great Value", 1.12, { size: 0.75, unit: "oz", pack: 3, cat: "28", store_brand: true }),
  row("Great Value Dry Black Beans, 2 lb", "Great Value", 2.24, { size: 2, unit: "lb", cat: "7", store_brand: true }),
  row("Huggies Little Movers Baby Diapers, Size 4, 60 Count", "Huggies", 24.97, { size: 60, unit: "ct", cat: "13", dept: "Baby" }),
  row("Huggies Diaper Bag Backpack, Gray", "Huggies", 39.97, { cat: "13", dept: "Baby" }),
  row("Huggies Diaper Pail Refills", "Huggies", 9.97, { cat: "13", dept: "Baby" }),
  row("Jersey Tomato Co. Marinara Sauce, 25 Oz", "Jersey Tomato", 4.98, { size: 25, unit: "oz", cat: "11" }),
  row("Hunt's Tomato Sauce, 15 oz Can", "Hunt's", 0.98, { size: 15, unit: "oz", cat: "11" }),
  row("(6 pack) Hunt's Tomato Sauce, 15 oz Can", "Hunt's", 5.88, { size: 15, unit: "oz", pack: 6, cat: "11" }),
  row("Jell-O Strawberry Gelatin Dessert Mix, 3 oz Box", "Jell-O", 1.12, { size: 3, unit: "oz", cat: "28" }),
  row("Shahia Cherry Jello Cups", "Shahia", 0.66, { cat: "9" }),
  row("Campbell's Condensed Chicken Noodle Soup, 10.75 oz Can", "Campbell's", 1.48, { size: 10.75, unit: "oz", cat: "11" }),
  row("Great Value Chicken Noodle Condensed Soup, 10.5 oz Can", "Great Value", 0.98, { size: 10.5, unit: "oz", cat: "11", store_brand: true }),
  row("Progresso Chicken Noodle Soup, 19 oz Can", "Progresso", 2.48, { size: 19, unit: "oz", cat: "11" }),
  // one unit of a "(200 pack)" bundle listing at a cent: the count must come from the pack, not from the rounded prices
  row("Dixie Bath Cups, 3 oz", "Dixie", 0.01, { size: 3, unit: "oz", cat: "9", listing_price: 2.5, listing_pack: 200, flags: ["pack_listing"] }),
  // the food bank's shelves, 2026-10-21: an Aldi spice brand that shares a word with a Walmart dip brand, a count typed
  // after the name, and Walmart's own brand in a durable department
  row("Stonemill Kitchens Pesto, 7 oz", "Stonemill Kitchens", 5.19, { size: 7, unit: "oz", cat: "4" }),
  row("Stonemill Kitchens Spinach Artichoke Dip, 10 oz", "Stonemill Kitchens", 4.48, { size: 10, unit: "oz", cat: "4" }),
  row("Great Value Rosemary Leaves, 0.8 oz", "Great Value", 1.98, { size: 0.8, unit: "oz", cat: "28", store_brand: true }),
  row("SkinnyPop Skinny Pop Original Popcorn, 4.4 oz", "SkinnyPop", 2.99, { size: 4.4, unit: "oz", cat: "9" }),
  row("Caroline's Treasures Skinny Guinea Pig Kitchen Mat, 28 x 19 in", "Caroline's Treasures", 21.81, { cat: "18", dept: "Home" }),
  row("Mainstays 4pk Dinner_pumpkin", "Mainstays", 12.58, { cat: "17", dept: "Home", store_brand: true }),   // the listing as Walmart names it
  row("Great Value 100% Pure Pumpkin, 15 oz", "Great Value", 1.96, { size: 15, unit: "oz", cat: "6", store_brand: true }),
  // photos 6-10: a soup named "Chili Mac", a brand typed as two words, a product line named without its maker, a brand
  // that makes canned fruit only, and an appliance that shares the product line's words
  row("Campbell's Chunky Chili Mac Soup, 18.8 oz Can", "Chunky", 1.98, { size: 18.8, unit: "oz", cat: "11" }),
  row("Hamburger Helper Chili Macaroni, 5.2 oz Box", "Hamburger Helper", 1.38, { size: 5.2, unit: "oz", cat: "7" }),
  row("Redpack Whole Peeled Plum Tomatoes in Puree, 28 oz Can", "Redpack", 1.98, { size: 28, unit: "oz", cat: "6" }),
  row("(6 pack) Red Gold Whole Peeled Tomatoes, 28 Oz", "Red Gold", 11.76, { size: 28, unit: "oz", pack: 6, cat: "6" }),
  row("Oven Fry Extra Crispy Seasoned Coating Mix for Chicken, 4.2 oz Box", "Kraft Oven Fry", 4.23, { size: 4.2, unit: "oz", cat: "7" }),
  row("Hamilton Beach Sure-Crisp Air Fry Oven", "Hamilton Beach", 44.96, { cat: "17", dept: "Home" }),
  row("Mission Pride Pear Slices 15oz", "Mission Pride", 0.98, { size: 15, unit: "oz", cat: "6" }),
  row("Mission Pride Peach Slices 15oz", "Mission Pride", 0.98, { size: 15, unit: "oz", cat: "6" }),
  row("Great Value Light Syrup Extra Cherry Fruit Mix, 15 oz", "Great Value", 1.08, { size: 15, unit: "oz", cat: "6", store_brand: true }),
  row("Zilla Reptile Munchies Vegetable and Fruit Mix 4 Ounces", "Zilla", 14.95, { size: 4, unit: "oz", cat: "19", dept: "Pets" }),
  // one product in its sizes: a single bar, boxes whose count follows the box's weight, a count size, a bundle of boxes
  row("Rice Krispies Treats Original Chewy Marshmallow Snack Bars, 26.4 oz, 12 Count", "Rice Krispies Treats", 17.57, { size: 26.4, unit: "oz", cat: "9" }),
  row("Rice Krispies Treats Original Chewy Marshmallow Snack Bar, Kids Snacks, 2.2 oz", "Rice Krispies Treats", 1.48, { size: 2.2, unit: "oz", cat: "9" }),
  row("Rice Krispies Treats Original Chewy Marshmallow Snack Bars, Kids Snacks, 26 oz, 20 Count", "Rice Krispies Treats", 14.63, { size: 26, unit: "oz", cat: "9" }),
  row("Rice Krispies Treats Original Chewy Marshmallow Snack Bars, 40 Ct", "Rice Krispies Treats", 13.79, { size: 40, unit: "ct", cat: "9" }),
  row("(2 pack) Rice Krispies Treats Original Chewy Marshmallow Snack Bars, 26.4 oz, 12 Count", "Rice Krispies Treats", 34.0, { size: 26.4, unit: "oz", pack: 2, cat: "9" }),
  row("Rice Krispies Treats Original Breakfast Cereal, 11.6 oz", "Rice Krispies Treats", 6.86, { size: 11.6, unit: "oz", cat: "7" }),
  // photos 11-15: another chain's cereal whose Walmart own-brand twin is named "... Cereal"
  row("Weight Watchers Ww Honey Nut Toasted Oats 12.3 Oz.", "Weight Watchers", 7.78, { size: 12.3, unit: "oz", cat: "7" }),
  row("Great Value Honey Nut Toasted Oats Cereal, 12.25 oz", "Great Value", 3.14, { size: 12.25, unit: "oz", cat: "7", store_brand: true }),
  // photos 16-20: pet food and baby food share the flavour words of people food
  row("Pedigree Adult Complete Nutrition Roasted Chicken, Rice & Vegetable Flavor Dry Dog Food, 14 lb", "Pedigree", 14.98, { cat: "19", dept: "Pets" }),
  row("Great Value Ready-to-Heat 90-Second Roasted Chicken Flavored Rice Pouch, 8.8 oz", "Great Value", 1.37, { size: 8.8, unit: "oz", cat: "7", store_brand: true }),
  row("Parents Choice Sweet Potato & Sweet Corn, 4oz Glass Jar", "Parent's Choice", 0.98, { size: 4, unit: "oz", cat: "13", dept: "Baby", store_brand: true }),
  row("Great Value Golden Sweet Whole Kernel Corn, 15.25 oz", "Great Value", 0.72, { size: 15.25, unit: "oz", cat: "6", store_brand: true }),
  // photos 21-22: Costco calls it bath tissue, Walmart's own brand toilet paper
  row("Charmin Ultra Soft Bath Tissue 2-Ply 213 Sheets 30 Rolls", "Charmin", 32.98, { size: 30, unit: "ct", cat: "16", dept: "Household" }),
  row("Great Value Soft & Strong Premium Toilet Paper, 30 Mega Rolls", "Great Value", 18.93, { size: 30, unit: "ct", cat: "16", dept: "Household", store_brand: true }),
  // every item valued at Walmart's value brand (owner, 2026-10-26): name brands, their value-brand twins, a value-brand
  // variant that is another product, Walmart's premium own brand, a twin dearer than the item, a dog food beside a cat food
  row("Barilla Classic Non-GMO Rigatoni Pasta, 16 oz", "Barilla", 1.88, { size: 16, unit: "oz", cat: "7" }),
  row("Great Value Rigatoni, 16 oz", "Great Value", 1.36, { size: 16, unit: "oz", cat: "7", store_brand: true }),
  row("Sam's Choice Italia Rigatoni Pasta, 17.6 oz", "Sam's Choice", 3.7, { size: 17.6, unit: "oz", cat: "7", store_brand: true }),
  row("Ronzoni Rigatoni, 16 oz", "Ronzoni", 1.2, { size: 16, unit: "oz", cat: "7" }),
  row("Quaker Whole Grain Quick 1-Minute Oats, 18 oz Canister", "Quaker", 4.12, { size: 18, unit: "oz", cat: "29" }),
  row("Great Value Whole Grain Quick Oats, 42 oz", "Great Value", 4.18, { size: 42, unit: "oz", cat: "29", store_brand: true }),
  row("Great Value Gluten Free Quick Oats, 18 oz", "Great Value", 3.17, { size: 18, unit: "oz", cat: "29", store_brand: true }),
  row("Purina Dog Chow Complete Adult Dry Dog Food, 16 lb", "Purina", 14.98, { size: 16, unit: "lb", cat: "19", dept: "Pets" }),
  row("Special Kitty Complete Nutrition Dry Food, 16 lb", "Special Kitty", 7.48, { size: 16, unit: "lb", cat: "19", dept: "Pets", store_brand: true }),
];

let db;
before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfb-search-"));
  const pub = path.join(tmp, "store", "build", "published");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, "items.jsonl.gz"), zlib.gzipSync(ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  fs.writeFileSync(path.join(pub, "manifest.json"), JSON.stringify({ version: "test-1", published: "2026-10-09T00:00:00Z" }));
  // two equivalents (barcodes Walmart does not sell): one valued at the store-brand tier
  const idn = path.join(tmp, "store", "identify"); fs.mkdirSync(idn, { recursive: true });
  const eqs = [{ upc: "00196633831439", name: "Energy Drink", brand: "Kirkland", quantity: "12 oz", base_qty: 12, base_unit: "fl oz", pack: 1, est_price: 1.3, basis_id: ROWS[0].id, basis_name: ROWS[0].name, basis_price: ROWS[0].price, basis_count: 6, store_brand_factor: 0.5, confidence: "high", score: 1.1 },
               { upc: "00012345678905", name: "Sparkling Water", brand: "LaCroix", quantity: "12 fl oz", base_qty: 12, base_unit: "fl oz", pack: 1, est_price: 0.8, basis_id: ROWS[0].id, basis_name: ROWS[0].name, basis_price: ROWS[0].price, basis_count: 4, store_brand_factor: null, confidence: "medium", score: 0.8 }];
  fs.writeFileSync(path.join(idn, "equivalents.jsonl.gz"), zlib.gzipSync(eqs.map((e) => JSON.stringify(e)).join("\n") + "\n"));
  // every brand searched (the search scope of the main app; this fork's data/brands.json searches Walmart's brands only,
  // tested in walmart-search.test.mjs)
  execFileSync(process.execPath, [path.join(APP, "tools", "build-db.mjs"), "--store", path.join(tmp, "store"), "--out", path.join(tmp, "db"), "--search", "all"], { stdio: "ignore" });
  db = await openPack(path.join(tmp, "db"));
});

const top = (q) => db.search(q, 10);

test("a word that matches nothing together is dropped by how little it says, not how rare it is", () => {
  const r = top("great value dry pinto beans");
  assert.equal(r.relaxed, true);
  assert.deepEqual(r.dropped, ["dry"]);
  assert.equal(r.items[0].name, "Great Value Pinto Beans, 32 oz");
});

test("the item a query names (its head noun) comes before things that merely carry the word", () => {
  const r = top("huggies diapers");
  assert.equal(r.items[0].name, "Huggies Little Movers Baby Diapers, Size 4, 60 Count");
});

test("every query still returns something", () => {
  for (const q of ["pinto", "dry beans", "zzzz", "huggies size 4", "yeast packets"]) {
    const r = top(q);
    if (q !== "zzzz") assert.ok(r.items.length > 0, q);
  }
});

test("a query word that is only part of a brand does not earn the brand bonus", () => {
  const r = top("tomato sauce");
  assert.match(r.items[0].name, /^Hunt's Tomato Sauce/);
});

test("the single item ranks before its (6 pack) listing", () => {
  const names = top("hunts tomato sauce").items.map((it) => it.name);
  assert.ok(names.indexOf("Hunt's Tomato Sauce, 15 oz Can") < names.indexOf("(6 pack) Hunt's Tomato Sauce, 15 oz Can"));
});

test("hyphenated brands are found typed joined: jello finds Jell-O first", () => {
  const r = top("jello");
  assert.equal(r.items[0].brand, "Jell-O");
});

// ---- other chains' store brands (data/brands.json, 2026-10-19): the brand words are set aside and Walmart's own brand ranks first
test("a query naming another store's brand ranks Walmart's own brand first and says so", () => {
  const r = top("kirkland chicken noodle soup");
  assert.deepEqual(r.otherBrand, { brand: "Kirkland", store: "Costco" });
  assert.equal(r.relaxed, false); assert.deepEqual(r.dropped, []);
  assert.equal(r.items[0].name, "Great Value Chicken Noodle Condensed Soup, 10.5 oz Can");
  assert.ok(r.items.some((it) => /Campbell/.test(it.name)), "the national brands still follow");
  const two = top("clancys chicken noodle soup");              // typed without its apostrophe
  assert.equal(two.otherBrand.store, "Aldi"); assert.equal(two.items[0].name, "Great Value Chicken Noodle Condensed Soup, 10.5 oz Can");
  const three = top("simply nature chicken noodle soup");       // a two-word brand
  assert.equal(three.otherBrand.brand, "Simply Nature");
  assert.equal(top("members mark chicken noodle soup").otherBrand, null, "Member's Mark is Walmart-owned: searched as typed");
  const plain = top("chicken noodle soup");                   // without a brand the usual ranking holds (store brand +0.3 only)
  assert.equal(plain.otherBrand, null);
  assert.equal(top("kirkland").otherBrand, null, "a brand alone is still searched for as typed");
});

test("an equivalent valued at the store-brand tier says so through the pack", () => {
  const k = db.lookupEquivalent(196633831439), l = db.lookupEquivalent(12345678905);
  assert.equal(k.storeTier, true); assert.equal(k.confidence, "high"); assert.equal(k.estCents, 130);
  assert.equal(l.storeTier, false); assert.equal(l.confidence, "medium");
});

test("the pack manifest carries the brands, the barcode prefixes and the price ceiling", () => {
  const m = db.manifest;
  assert.equal(m.brands["kirkland signature"], "Costco"); assert.equal(m.brands["heinen's"], "Heinen's"); assert.equal(m.brands["happy belly"], "Amazon");
  assert.deepEqual(m.prefixes["0096619"], { store: "Costco", brand: "Kirkland Signature" });
  assert.equal(m.prefixes["0030034"].store, "Giant Eagle");
  assert.equal(m.priceCeiling, 15000);
});

test("a bundle listing's count is read from the pack, never derived from rounded prices", () => {
  const it = db.search("dixie bath cups", 5).items[0];
  assert.equal(it.packListing, true); assert.equal(it.listingCents, 250); assert.equal(it.listingPack, 200);   // 250 / 1 would say 250
  const hunts = db.search("hunts tomato sauce", 10).items.find((x) => x.name.startsWith("(6 pack)"));
  assert.equal(hunts.packListing, false, "a row without the flag is not a bundle unit");
});

test("when no item has every word, a count goes first, then a brand word, and the product stays (food-bank photos, 2026-10-21)", () => {
  const pop = top("skinny pop 28");
  assert.deepEqual(pop.dropped, ["28"], "the 28 bags, not the word pop");
  assert.match(pop.items[0].name, /^SkinnyPop/);
  const spice = top("stonemill rosemary");
  assert.deepEqual(spice.dropped, ["stonemill"], "Aldi's Stonemill rosemary is valued as rosemary, not as a Stonemill Kitchens dip");
  assert.match(spice.items[0].name, /Rosemary/);
});

test("Walmart's own brand ranks first for another chain's brand only among the things the food bank receives", () => {
  const r = top("giant eagle pumpkin");
  assert.equal(r.otherBrand?.store, "Giant Eagle");
  assert.equal(r.items[0].name, "Great Value 100% Pure Pumpkin, 15 oz", "canned pumpkin, not Mainstays pumpkin plates");
});

test("words the shelves typed differently from the listing: Chili Mac, Red Pack, Oven Fry (food-bank photos 6-10, 2026-10-21)", () => {
  const mac = top("chunky chili mac");
  assert.deepEqual(mac.dropped, [], "mac is a word of the listing, not only short for macaroni");
  assert.match(mac.items[0].name, /Chunky Chili Mac/);
  assert.match(top("red pack whole peeled tomatoes").items[0].name, /^Redpack/, "the brand typed as two words, not a Red Gold 6 pack");
  assert.match(top("oven fry").items[0].name, /Coating Mix/, "Kraft Oven Fry, not an air fry oven");
});

test("a brand Walmart has, set aside, still says what kind of item it is", () => {
  const r = top("mission pride fruit mix");
  assert.ok(r.dropped.includes("pride") && r.dropped.includes("mission"));
  assert.match(r.items[0].name, /Fruit Mix, 15 oz/, "Mission Pride makes canned fruit: the canned fruit mix, not a reptile food");
});

test("a box priced as one of its pieces, and the product's other sizes (owner, 2026-10-21: individual, box, count of)", () => {
  const box = top("rice krispies treats 26.4 oz 12 count").items.find((x) => x.name.startsWith("Rice Krispies Treats Original Chewy Marshmallow Snack Bars, 26.4"));
  assert.equal(box.pack, 1, "the box is one listing");
  assert.equal(box.pieces, 12, "its 12 bars, for pricing one of them");
  const find = (q, re) => top(q).items.find((x) => re.test(x.name));
  assert.equal(find("rice krispies treats 40 ct", /40 Ct/).pieces, 40, "a count size is its pieces");
  assert.equal(find("rice krispies treats 2.2 oz", /2\.2 oz/).pieces, 1, "a single bar");
  assert.equal(find("rice krispies treats 26.4 oz 12 count", /^\(2 pack\)/).pieces, 2, "a bundle is priced one box at a time");
  const sizes = db.sizes(box.rank).map((x) => x.name);
  assert.ok(sizes.some((n) => /2\.2 oz/.test(n)), "the single bar");
  assert.ok(sizes.some((n) => /20 Count/.test(n)) && sizes.some((n) => /40 Ct/.test(n)), "the other boxes");
  assert.ok(!sizes.some((n) => /^\(2 pack\)/.test(n)), "not a bundle of the same box");
  assert.ok(!sizes.some((n) => /Cereal/.test(n)), "not the cereal of the same brand");
  assert.ok(!sizes.some((n) => n === box.name), "not the item itself");
});

test("another chain's brand: Walmart's own brand first when it carries every other word, not only when it is named by them", () => {
  const r = top("giant eagle honey nut toasted oats");
  assert.equal(r.otherBrand?.store, "Giant Eagle");
  assert.match(r.items[0].name, /^Great Value Honey Nut Toasted Oats Cereal/, "the store-brand twin, not Weight Watchers");
});

test("pet food and baby food come first only when the query is for a pet or a baby (food-bank photos 16-20)", () => {
  assert.match(top("earthly grains roasted chicken rice").items[0].name, /Rice Pouch/, "Aldi's rice side is valued as the rice pouch, not dog food");
  assert.match(top("dog food roasted chicken").items[0].name, /Dog Food/);
  assert.match(top("sweet corn").items[0].name, /Whole Kernel Corn/, "canned corn, not a baby-food jar");
  assert.match(top("baby sweet corn").items[0].name, /Glass Jar/);
});

test("bath tissue is toilet paper: Kirkland's 30 rolls are valued as Walmart's own 30 rolls (food-bank photos 21-22)", () => {
  const r = top("kirkland bath tissue 30 rolls");
  assert.equal(r.otherBrand?.store, "Costco");
  assert.match(r.items[0].name, /^Great Value .*Toilet Paper, 30/);
  assert.ok(top("toilet paper").items.some((x) => /Bath Tissue/.test(x.name)), "and the other way round");
});

const find = (q, re) => top(q).items.find((x) => re.test(x.name));

test("every item is valued at its value-brand equivalent, scaled to its size (owner, 2026-10-26)", () => {
  const barilla = find("barilla rigatoni", /^Barilla/);
  assert.equal(barilla.gv.brand, "Great Value");
  assert.equal(barilla.gv.basis.name, "Great Value Rigatoni, 16 oz");
  assert.equal(barilla.gv.cents, 136, "the same size: the value brand's own price");
  assert.equal(barilla.gv.scaled, false);
  assert.equal(barilla.gv.ownCents, 188);
  const quaker = find("quaker quick oats", /^Quaker/);
  assert.match(quaker.gv.basis.name, /Whole Grain Quick Oats, 42 oz/, "regular oats, not the gluten-free ones");
  assert.equal(quaker.gv.cents, Math.round((418 / 42) * 18), "priced by the ounce for 18 oz");
  assert.equal(quaker.gv.scaled, true);
  assert.equal(find("sams choice rigatoni", /^Sam's Choice/).gv.cents, Math.round((136 / 16) * 17.6), "Walmart's premium line is valued at the value brand too");
  const gv = find("great value rigatoni", /^Great Value Rigatoni/);
  assert.equal(gv.gv, undefined); assert.ok(!gv.gvNone, "a value-brand item is its own value");
});

test("an equivalent is never another product, nor dearer than the item itself", () => {
  const dog = find("purina dog chow", /^Purina/);
  assert.equal(dog.gv, undefined, "dog food is not valued as cat food");
  assert.equal(dog.gvNone, true);
  const ronzoni = find("ronzoni rigatoni", /^Ronzoni/);
  assert.equal(ronzoni.gv, undefined, "a twin at $1.36 does not value a $1.20 box");
  assert.equal(ronzoni.gvNone, true);
});

test("a query that names no brand shows the value brand's item first; a brand typed is still found", () => {
  assert.equal(top("rigatoni 16 oz").items[0].name, "Great Value Rigatoni, 16 oz");
  assert.equal(top("barilla rigatoni").items[0].brand, "Barilla");
});
