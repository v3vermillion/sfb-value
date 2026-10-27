// search-harness.mjs — run the app's own search worker (public/js/db-worker.js) in Node against a built pack.
//
//   import { openPack } from "./tools/search-harness.mjs";
//   const db = await openPack("dist/db");          // reads current.json, then <version>/manifest.json
//   db.search("gv peanut butter").items[0]
//
// The worker reads files with fetch(); here fetch reads them from disk. No Cache Storage (caches is undefined).
import fs from "node:fs";
import path from "node:path";

let worker = null;

export async function openPack(dbDir) {
  const dir = path.resolve(dbDir);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("pack:")) {
      const p = path.join(dir, u.slice(5));
      if (!fs.existsSync(p)) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(p));
    }
    return realFetch(url, opts);
  };
  if (!worker) {
    globalThis.self = globalThis.self || globalThis;
    globalThis.postMessage = globalThis.postMessage || (() => {});
    worker = await import("../public/js/db-worker.js");
  }
  const current = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, current.base, "manifest.json"), "utf8"));
  const stats = await worker.load({ root: "pack:", base: `pack:${current.base}`, manifest, cacheName: null });
  // every item of the pack in order (gold.mjs coverage): ids are shard * 2^24 + rank
  const ids = function* () { for (const sh of manifest.shards || [{ items: manifest.items }]) { const si = (manifest.shards || [sh]).indexOf(sh); for (let r = 0; r < sh.items; r++) yield si * 16777216 + r; } };
  return { manifest, stats, ids, search: (q, limit) => worker.search(q, limit), lookupUpc: (k) => worker.lookupUpc(k), lookupEquivalent: (k) => worker.lookupEquivalent(k), item: (r) => worker.item(r), itemRaw: (r) => worker.itemRaw(r), sizes: (r, n) => worker.sizesOf(r, n), valueDebug: (r) => worker.valueDebug(r) };
}
