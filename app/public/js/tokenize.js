// Shared tokenizer: the DB builder (Node) and the app (browser worker) import this same module,
// so an index built offline always agrees with what is typed into the search box.

const DIACRITICS = /[̀-ͯ]/g;

// Normalize text to a lowercase ASCII-ish form. "Bush's" -> "bushs", "Pen+Gear" -> "pen gear",
// "16oz" stays a single chunk until splitLetterDigit() splits it into "16" and "oz".
export function normalizeText(s) {
  return String(s)
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/['’`]/g, "")          // bush's -> bushs, kellogg's -> kelloggs
    .replace(/(\d)\s*%/g, "$1 percent ")   // "2% milk" -> "2 percent milk": keeps the fat grade a real word
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.]+/g, " ");   // every other separator (incl. + / , - x ×) becomes a space
}

// Split a chunk such as "16oz", "5w-30"(already split on -), "2pk", "15.25oz" into letter and digit runs.
// Numbers keep one decimal point ("15.25"); a trailing "." is dropped ("15." -> "15").
function* splitLetterDigit(chunk) {
  const re = /(\d+(?:\.\d+)?)|([a-z]+)/g;
  let m;
  while ((m = re.exec(chunk)) !== null) yield m[0];
}

/** Tokens of a product name or query, in order, duplicates kept. */
export function tokenize(s) {
  const out = [];
  for (const chunk of normalizeText(s).split(" ")) {
    if (!chunk) continue;
    for (const t of splitLetterDigit(chunk)) out.push(t);
  }
  return out;
}

// Hyphenated brand words are also indexed joined, the way people type them: "Jell-O" -> jello, "Cheez-It" ->
// cheezit, "Pop-Tarts" -> poptarts, "Kool-Aid" -> koolaid, "Rice-A-Roni" -> ricearoni, "Q-tips" -> qtips.
export function joinedTokens(s) {
  const t = String(s).normalize("NFKD").replace(DIACRITICS, "").toLowerCase().replace(/['’`]/g, "");
  return (t.match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) || []).map((w) => w.replace(/-/g, "")).filter((w) => /^[a-z]/.test(w) && w.length >= 4);
}

/** Sorted unique tokens (what the index stores per item). */
export function uniqueTokens(s) {
  return Array.from(new Set([...tokenize(s), ...joinedTokens(s)])).sort();
}

// The item a listing is: the last word of the name before its first comma or dash, once trailing quantities are
// stripped ("Huggies Little Movers Baby Diapers, Size 4" -> diapers; "Huggies Day Pack Diaper Bag" -> bag;
// "Coca-Cola Soda Pop 12 fl oz 12 Pack Cans" -> pop). A container word is a quantity only after a number.
const MEASURE = new Set(["oz", "ounce", "ounces", "fl", "fluid", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg", "mg", "mcg", "ml",
  "l", "liter", "liters", "litre", "litres", "gal", "gallon", "gallons", "qt", "quart", "quarts", "pt", "pint", "pints", "ct", "cnt", "count",
  "pk", "each", "ea", "x", "of", "size", "sq", "ft", "inch", "inches", "in", "mm", "cm", "percent"]);
const CONTAINER = new Set(["can", "cans", "bag", "bags", "box", "boxes", "bottle", "bottles", "jar", "jars", "cup", "cups", "pouch", "pouches",
  "tub", "tubs", "carton", "cartons", "case", "pack", "packs", "pc", "pcs", "piece", "pieces", "rolls", "sheets", "bars", "packets"]);
const HEAD_SKIP = new Set(["value", "family", "original", "classic", "new", "assorted", "variety", "fresh", "fruit", "vegetable", "vegetables"]);
export function headNoun(name) {
  // "Melton Coat For Dogs" is a coat, "Shampoo with Argan Oil" a shampoo, "Chunk Light Tuna in Water" tuna: what follows
  // for/with/by/in describes it
  const first = String(name).split(/,| - | \| /)[0];
  const lead = first.split(/\s+(?:for|with|by|in|w\/)\s+/i)[0];
  const toks = tokenize(lead.trim() ? lead : first);
  while (toks.length) {
    const t = toks[toks.length - 1];
    // a container is a quantity right after one ("12 Pack Cans", "2 Liter Bottle"), not after a product word ("16 oz Milk
    // Bottle" is a bottle)
    const prev = toks[toks.length - 2];
    const afterNumber = !!prev && (/^\d/.test(prev) || MEASURE.has(prev) || CONTAINER.has(prev));
    if (/^\d/.test(t) || MEASURE.has(t) || HEAD_SKIP.has(t) || (CONTAINER.has(t) && afterNumber)) toks.pop();
    else break;
  }
  return toks.length ? toks[toks.length - 1] : null;
}

// A size typed with its unit ("16 oz", "1 lb", "2 liter", "12 count", "8 rolls"), in ounces (weight and volume alike,
// as the shelf labels mix them) or pieces: { dim: "oz" | "ct", qty, text }, or null. The first one in the query.
const SIZE_UNIT = {
  oz: ["oz", 1], ounce: ["oz", 1], ounces: ["oz", 1], lb: ["oz", 16], lbs: ["oz", 16], pound: ["oz", 16], pounds: ["oz", 16],
  g: ["oz", 0.035274], gram: ["oz", 0.035274], grams: ["oz", 0.035274], kg: ["oz", 35.274], ml: ["oz", 0.033814],
  l: ["oz", 33.814], liter: ["oz", 33.814], liters: ["oz", 33.814], litre: ["oz", 33.814], litres: ["oz", 33.814], ltr: ["oz", 33.814],
  gal: ["oz", 128], gallon: ["oz", 128], gallons: ["oz", 128], qt: ["oz", 32], quart: ["oz", 32], quarts: ["oz", 32], pt: ["oz", 16],
  pint: ["oz", 16], pints: ["oz", 16], ct: ["ct", 1], count: ["ct", 1], cnt: ["ct", 1], pk: ["ct", 1], pack: ["ct", 1], packs: ["ct", 1],
  roll: ["ct", 1], rolls: ["ct", 1], pod: ["ct", 1], pods: ["ct", 1], pc: ["ct", 1], pcs: ["ct", 1], piece: ["ct", 1], pieces: ["ct", 1],
  bars: ["ct", 1], diapers: ["ct", 1], wipes: ["ct", 1], bags: ["ct", 1], tablets: ["ct", 1], caplets: ["ct", 1], capsules: ["ct", 1],
};
export function typedSize(textOrTokens) {
  const t = Array.isArray(textOrTokens) ? textOrTokens : tokenize(textOrTokens);
  // "eggs dozen", "2 dozen eggs": a count of 12 each
  const dz = t.indexOf("dozen");
  if (dz >= 0) { const n = dz > 0 && /^\d+$/.test(t[dz - 1]) ? Number(t[dz - 1]) : 1; return { dim: "ct", qty: 12 * n, text: n > 1 && dz > 0 && /^\d+$/.test(t[dz - 1]) ? `${n} dozen` : "dozen" }; }
  for (let i = 0; i + 1 < t.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(t[i])) continue;
    const n = Number(t[i]);
    const j = t[i + 1] === "fl" && t[i + 2] ? i + 2 : i + 1;
    const u = SIZE_UNIT[t[j]];
    if (u && n > 0) return { dim: u[0], qty: n * u[1], text: `${t[i]} ${t[i + 1] === "fl" ? "fl oz" : t[j]}` };
  }
  return null;
}
