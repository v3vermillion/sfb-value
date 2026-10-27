// db-client.js — main-thread side of the database: install, cache, update, and query the worker.
//
// Storage model
//   A format-3 pack is a manifest plus shard files named by their content (db/files/<sha>.bin.gz). The files live in one
//   Cache Storage bucket (`sfb-db-files`) shared by every version, so an update downloads only the files whose content
//   changed; each version's manifest and its small per-version files (equivalents, produce codes) live in
//   `sfb-db-<version>`. A format-2 pack keeps all its files in its version bucket. localStorage["sfb.db"] records the
//   installed version and localStorage["sfb.db.pending"] a fully downloaded newer one; without localStorage the buckets
//   are the source of truth.
//
// First install: the core shards (consumable departments) download first and the app opens on them; the other
//   departments follow in the background and join the search when they arrive ("more" in the state). A boot that finds
//   only the core on the phone (the first download was interrupted) opens it and resumes the rest when online.
// Updates download every file of the new version in the background while the current one keeps answering; the swap
//   happens when the app is idle and is rolled back if the new pack fails to open.
// Downloads retry each file with back-off, stop at the first file that keeps failing, and say why in words a volunteer
//   can act on; nothing half-downloaded is ever opened.
//
// Events (EventTarget): "state" {state, ...}, "progress" {phase, ...}, "ready" {stats}, "more" {loaded, pending},
// "update-available" {version}

const KEY = "sfb.db";
const PENDING_KEY = "sfb.db.pending";
const PERSIST_KEY = "sfb.persist";       // when persistent storage was last requested
const LOG_KEY = "sfb.boot.log";          // the last diagnostics lines of the previous page (Settings > About)
const LOAD_TIMEOUT_MS = 90_000;          // a pack open that takes longer than this is an error, never an endless "Loading"
const PERSIST_RETRY_MS = 86_400_000;     // ask again at most once a day until it is granted
const DB_ROOT = "./db/";
const CACHE_PREFIX = "sfb-db-";
const FILES_CACHE = "sfb-db-files";      // shard files of every format-3 version (not a version bucket)
const RETRIES = 3;                       // per file, before the download stops
const PARALLEL = 3;

/** Every file of a version: { url (relative to the page), bytes, shard, tier, bucket }, core first. */
export function fileList(manifest, version) {
  if (manifest.shards) {
    const out = [];
    for (const sh of manifest.shards) for (const f of [sh.files.cols, sh.files.upc, sh.files.tokens, ...sh.files.strings]) {
      out.push({ url: DB_ROOT + f.path, bytes: f.gzBytes || f.bytes || 0, shard: sh.id, tier: sh.tier || "core", bucket: FILES_CACHE });
    }
    for (const f of [manifest.files.equiv, manifest.files.plu, manifest.files.brands].filter(Boolean)) out.push({ url: DB_ROOT + f.path, bytes: f.gzBytes || f.bytes || 0, shard: null, tier: "core", bucket: CACHE_PREFIX + version });
    return out.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "core" ? -1 : 1));
  }
  const f = manifest.files;
  return [f.cols, ...f.strings, f.upc, f.tokens, f.equiv, f.plu].map((x) => ({ url: `${DB_ROOT}${version}/${x.path}`, bytes: x.gzBytes || x.bytes || 0, shard: "all", tier: "core", bucket: CACHE_PREFIX + version }));
}
const shardIds = (manifest) => (manifest.shards ? manifest.shards.map((s) => s.id) : ["all"]);
const coreIds = (manifest) => (manifest.shards || [{ id: "all", tier: "core" }]).filter((s) => (s.tier || "core") === "core").map((s) => s.id);

// ---- how much of the pack this phone can hold open
// The search worker keeps every open shard in memory (typed arrays over the inflated files plus the word dictionary):
// measured 99.6 MB for the 760k-item fixture, about 131 bytes per item. A pack of several million durable items
// would be killed by the phone's memory limit before it ever answered, so the consumable (core) departments always
// open and the durable (more) departments are added in manifest order only while the estimate stays under a budget
// for this device. Shards past the budget are not downloaded either; Settings names them.
export const BYTES_PER_ITEM = 140;
const MB = 1048576;
/** Worker memory the whole pack may take: ~100 MB per GB of device memory (Chrome reports it, capped at 8), clamped to
 * 250–640 MB; a browser that does not say (Safari) is treated as a 4 GB phone. */
export function memoryBudget(deviceMemoryGB = (typeof navigator !== "undefined" ? navigator.deviceMemory : undefined)) {
  const gb = Number(deviceMemoryGB);
  if (!Number.isFinite(gb) || gb <= 0) return 400 * MB;
  return Math.min(640 * MB, Math.max(250 * MB, Math.round(gb * 100 * MB)));
}
/** The shard ids to open on this phone: every core shard, then the "more" shards in manifest order while the estimated
 * worker memory stays under the budget. Returns { open: [ids], skipped: [{ id, name, items }] }. */
export function pickShards(manifest, budgetBytes = memoryBudget()) {
  const shards = manifest.shards || [{ id: "all", tier: "core", items: manifest.items || 0 }];
  const open = [], skipped = [];
  let used = 0;
  for (const sh of shards) if ((sh.tier || "core") === "core") { open.push(sh.id); used += (sh.items || 0) * BYTES_PER_ITEM; }
  for (const sh of shards) {
    if ((sh.tier || "core") === "core") continue;
    const cost = (sh.items || 0) * BYTES_PER_ITEM;
    if (used + cost <= budgetBytes) { open.push(sh.id); used += cost; } else skipped.push({ id: sh.id, name: sh.name || sh.id, items: sh.items || 0 });
  }
  return { open, skipped };
}

/** A download that failed: `network` when it is worth retrying (the phone lost its connection, or the server answered
 * 5xx), `server` when the server answered 5xx (the phone's connection is fine), `storage` when the phone refused to save
 * it (full), else the server's answer. */
class DownloadError extends Error {
  constructor(message, { network = false, server = false, storage = false, needMB = 0 } = {}) { super(message); this.network = network; this.server = server; this.storage = storage; this.needMB = needMB; }
}
/** Save a response in Cache Storage; a full phone is a storage error, a body cut off mid-way a network one. */
async function save(cache, url, res) {
  try { await cache.put(url, res); }
  catch (e) {
    if (e?.name === "QuotaExceededError") throw new DownloadError("this phone's storage is full", { storage: true });
    throw new DownloadError(`${url}: ${e?.message || e}`, { network: true });
  }
}

export class DbClient extends EventTarget {
  constructor() {
    super();
    this.worker = new Worker("./js/db-worker.js", { type: "module" });
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    // the search worker failed (a crash, out of memory): every pending answer fails at once, and the state says so
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "the price search stopped"));
      this.pending.clear();
      this.#setState("error", { message: e.message || "the price search stopped", worker: true });
    };
    this.pending = new Map();
    this.seq = 0;
    // what happened since the page opened, for Settings > About > Diagnostics (the owner reads the phone, not a console):
    // state changes, the steps of start(), errors; the last entries are also kept in localStorage across a reload
    this.log = [];
    this.state = "idle";
    this.version = null;
    this.manifest = null;
    this.stats = null;
    this.pendingUpdate = null;
    this.more = null;             // { loaded: [shard ids], pending: [shard ids] } while other departments are still arriving
    this.skipped = [];            // durable shards this phone does not open (memory budget): [{ id, name, items }]
    this.persisted = undefined;   // true | false | null (the browser cannot say) | undefined (not asked yet)
    this.ready = new Promise((r) => (this.#resolveReady = r));
  }
  #resolveReady = null;
  #downloads = new Map();     // version + tier -> in-flight download promise
  #updating = null;           // in-flight start/checkForUpdate
  #moreTask = null;           // in-flight background completion of the current version

  #readKey(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }
  #writeKey(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  #setState(state, extra = {}) { this.state = state; this.note(`state ${state}${extra.message ? `: ${extra.message}` : ""}`); this.#emit("state", { state, ...extra }); }
  /** One line in the diagnostics log (seconds since the page opened), kept in memory and, the last 40, in localStorage. */
  note(text) {
    const line = `${(performance.now() / 1000).toFixed(1)}s ${text}`;
    this.log.push(line);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(this.log.slice(-40))); } catch { /* private mode */ }
  }

  #onMessage(m) {
    if (m.type === "progress") { this.#emit("progress", { done: m.done, total: m.total, file: m.file, phase: "load" }); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error));
    else p.resolve(m.type === "ready" ? m.stats : m.result);
  }
  call(msg, transfer, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      let timer = 0;
      if (timeoutMs > 0) timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`the price database took more than ${Math.round(timeoutMs / 1000)} s to open`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  // ---- what is on the phone
  async #manifestOf(version) {
    try {
      const cache = await caches.open(CACHE_PREFIX + version);
      const m = await cache.match(`${DB_ROOT}${version}/manifest.json`);
      return m ? await m.json() : null;
    } catch { return null; }
  }
  /** Shard ids whose every file is in Cache Storage, and whether the per-version files are there too. */
  async #present(version, manifest) {
    const have = new Set(), missing = new Set();
    let base = true;
    for (const f of fileList(manifest, version)) {
      let ok = false;
      try { ok = !!(await (await caches.open(f.bucket)).match(f.url)); } catch { ok = false; }
      if (f.shard == null) { if (!ok) base = false; } else if (ok) have.add(f.shard); else missing.add(f.shard);
    }
    for (const s of missing) have.delete(s);
    return { base, shards: [...have] };
  }
  /** The shards this phone opens for a manifest (core always; "more" within the memory budget). */
  #wanted(manifest) { return new Set(pickShards(manifest).open); }
  /** The core shards of a version are all on the phone: it can open offline. */
  async #usable(version) {
    const manifest = await this.#manifestOf(version);
    if (!manifest) return null;
    const p = await this.#present(version, manifest);
    const core = coreIds(manifest);
    const want = this.#wanted(manifest);
    return p.base && core.every((id) => p.shards.includes(id)) ? { manifest, shards: p.shards, complete: [...want].every((id) => p.shards.includes(id)) } : null;
  }
  /** Versions with a usable bucket on this device (newest first), for when localStorage is gone. */
  async #cachedVersions() {
    const out = [];
    try {
      for (const n of await caches.keys()) {
        if (!n.startsWith(CACHE_PREFIX) || n === FILES_CACHE) continue;
        const v = n.slice(CACHE_PREFIX.length);
        if (await this.#usable(v)) out.push(v);
      }
    } catch { /* no Cache Storage */ }
    return out.sort().reverse();
  }

  /** Boot: open what is installed (instantly, offline), then look for a newer snapshot when online. */
  async start() {
    if (this.#updating) return this.#updating;
    const run = (async () => {
      let installed = this.#readKey(KEY)?.version || null;
      const pending = this.#readKey(PENDING_KEY)?.version || null;
      if (!installed) { const cached = await this.#cachedVersions(); if (cached.length) installed = cached[0]; }
      this.note(`start: installed ${installed || "none"}, pending ${pending || "none"}, ${navigator.onLine ? "online" : "offline"}`);
      // a fully downloaded newer snapshot waits for an idle moment: boot is one
      if (pending && pending !== installed && (await this.#usable(pending))?.complete) {
        try { await this.#load(pending); this.#writeKey(KEY, { version: pending, installedAt: Date.now() }); this.#writeKey(PENDING_KEY, null); installed = pending; }
        catch (err) { console.warn("pending pack failed to open, keeping the installed one", err); this.#writeKey(PENDING_KEY, null); await caches.delete(CACHE_PREFIX + pending).catch(() => {}); }
      }
      // A pack that fails to open (a worker or memory failure, a read error, an open past LOAD_TIMEOUT_MS) is kept until a
      // new copy can be fetched: an offline phone retries it at the next launch, tap or "online" event instead of losing its
      // prices (audit W9-02, 2026-10-21; it used to be deleted first, and an offline phone then had none)
      let broken = null;
      if (installed && !this.version) {
        try { await this.#load(installed); this.#writeKey(KEY, { version: installed, installedAt: Date.now() }); }
        catch (err) {
          console.warn("installed pack failed to load", err);
          this.note(`installed ${installed} failed to open: ${String(err?.message || err).slice(0, 160)}`);
          broken = installed;
        }
      }
      if (!this.version) {
        if (!navigator.onLine) {
          if (broken) this.#setState("error", { message: "The prices on this phone could not be opened. They are tried again when the app reopens or the connection returns." });
          else this.#setState("offline-empty");
          return;
        }
        try {
          const cur = await this.#fetchCurrent();
          if (broken) {
            // the server answers: replace the pack that would not open (its shard files stay in the shared bucket)
            await caches.delete(CACHE_PREFIX + broken).catch(() => {});
            this.#writeKey(KEY, null);
            this.note(`reinstalling ${cur.version} in place of ${broken}`);
          }
          this.note(`current ${cur.version}: downloading the core`);
          await this.#download(cur.version, { background: false, tier: "core" });
          this.note("core downloaded");
          await this.#load(cur.version);
          this.#writeKey(KEY, { version: cur.version, installedAt: Date.now() });
        } catch (err) {
          this.#setState("error", { message: this.#explain(err), network: !!err.network, server: !!err.server, storage: !!err.storage, needMB: err.needMB || 0 });
        }
      }
    })();
    // the launch check runs once start() has released #updating; called inside run it would only see itself as busy
    this.#updating = run.finally(() => {
      this.#updating = null;
      if (this.version) { this.#completeMore().catch(() => {}); this.checkForUpdate().catch(() => {}); }
    });
    return this.#updating;
  }

  #explain(err) {
    if (err?.storage) return `This phone is out of storage space for the prices (about ${err.needMB || "?"} MB more is needed). Free some space (old photos, videos or apps), then open the app again.`;
    if (err?.server) return "The price server is not responding. The download retries automatically.";
    if (err?.network || !navigator.onLine) return "The download was interrupted. It resumes automatically when the phone is back online.";
    return String(err?.message || err);
  }

  async #fetchCurrent() {
    let res;
    try { res = await fetch(DB_ROOT + "current.json", { cache: "no-store" }); }
    catch (e) { throw new DownloadError(`could not reach the price server (${e.message})`, { network: true }); }
    if (!res.ok) throw new DownloadError(`could not read db/current.json (${res.status})`, { network: res.status >= 500, server: res.status >= 500 });
    const cur = await res.json();
    if (!cur?.version || !/^[\w.-]+$/.test(cur.version)) throw new DownloadError("db/current.json is not a snapshot pointer");
    return cur;
  }

  async #fetchManifest(version) {
    const url = `${DB_ROOT}${version}/manifest.json`;
    const cache = await caches.open(CACHE_PREFIX + version);
    let res = await cache.match(url);
    if (!res) {
      try { res = await fetch(url, { cache: "no-store" }); }
      catch (e) { throw new DownloadError(`could not reach the price server (${e.message})`, { network: true }); }
      if (!res.ok || /text\/html/i.test(res.headers.get("content-type") || "")) throw new DownloadError(`manifest missing (${res.status})`, { network: res.status >= 500, server: res.status >= 500 });
      await save(cache, url, res.clone());
    }
    return res.json();
  }

  /** Download the files of a version (tier "core", "more" or "all") that are not on the phone yet. Deduplicated. */
  #download(version, { background, tier = "all" }) {
    const k = `${version}:${tier}`;
    let p = this.#downloads.get(k);
    if (!p) {
      p = this.#downloadNow(version, background, tier).finally(() => this.#downloads.delete(k));
      this.#downloads.set(k, p);
    }
    return p;
  }
  async #downloadNow(version, background, tier) {
    if (!background) this.#setState("downloading", { version });
    const t0 = performance.now();
    const manifest = await this.#fetchManifest(version);
    const want = this.#wanted(manifest);
    const files = fileList(manifest, version).filter((f) => (tier === "all" || f.tier === tier) && (f.shard == null || want.has(f.shard)));
    const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    let doneBytes = 0, failed = null;
    const queue = files.slice();
    const progress = (f) => { if (!failed) this.#emit("progress", { phase: "download", background, tier, version, doneBytes, totalBytes, file: f.url }); };
    const fetchOne = async (f) => {
      const cache = await caches.open(f.bucket);
      if (await cache.match(f.url)) return;
      for (let attempt = 1; ; attempt++) {
        try {
          let res;
          try { res = await fetch(f.url, { cache: "no-store" }); }
          catch (e) { throw new DownloadError(`${f.url}: ${e.message}`, { network: true }); }
          if (!res.ok) throw new DownloadError(`download failed: ${f.url} (${res.status})`, { network: res.status >= 500, server: res.status >= 500 });
          if (/text\/html/i.test(res.headers.get("content-type") || "")) throw new DownloadError(`download failed: ${f.url} (not a pack file)`);
          // the response goes straight into Cache Storage: reading it into an ArrayBuffer first copied every pack file
          // through the page's JS heap twice on a phone
          await save(cache, f.url, res);
          return;
        } catch (e) {
          if (failed || attempt >= RETRIES || !e.network || !navigator.onLine) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));    // 2 s, 4 s
        }
      }
    };
    const runOne = async () => {
      while (queue.length && !failed) {
        const f = queue.shift();
        try { await fetchOne(f); } catch (e) { failed = failed || e; break; }
        doneBytes += f.bytes;
        progress(f);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, runOne));
    if (failed?.storage) {
      // say how much room is missing (what this download still needed), in every tier: a full phone never fixes itself
      failed.needMB = Math.max(1, Math.ceil((totalBytes - doneBytes) / 1048576));
      this.storageFull = { needMB: failed.needMB, tier };
      this.#emit("storage-full", this.storageFull);
    }
    if (failed) throw failed;                  // the other downloads stopped too; late progress is never reported
    if (this.storageFull) { this.storageFull = null; this.#emit("storage-ok", {}); }
    if (!background) this.#lastDownloadMs = Math.round(performance.now() - t0);
    return manifest;
  }
  #lastDownloadMs = null;     // the foreground (first-install) download, reported once in the next load's stats

  async #load(version, { quiet = false } = {}) {
    if (!quiet) this.#setState("loading", { version });
    const manifest = await this.#fetchManifest(version);
    const t0 = performance.now();
    const p = await this.#present(version, manifest);
    if (!p.base || !p.shards.length) throw new Error("the price database on this phone is incomplete");
    const picked = pickShards(manifest);
    const present = p.shards.filter((id) => picked.open.includes(id));
    if (!present.length) throw new Error("the price database on this phone is incomplete");
    // The core departments (groceries and the other consumables) open first and the app is ready on them; the other
    // departments on the phone open right after, in the background (#completeMore), and join the search when they do.
    // Measured on the published list (2.57M items, 14 shards): opening everything before "ready" took 3.2-6.2 s in a
    // throttled Chromium and 15-20 s on the owner's iPhone; the core is 45% of that work.
    const core = new Set(coreIds(manifest));
    const only = present.filter((id) => core.has(id));
    if (!only.length) throw new Error("the price database on this phone is incomplete");
    this.note(`open ${version}: ${only.join(", ")}${present.length > only.length ? ` (then ${present.length - only.length} more)` : ""}`);
    const stats = await this.call({ type: "load", root: new URL(DB_ROOT, location.href).href, base: new URL(`${DB_ROOT}${version}/`, location.href).href,
      manifest, cacheName: CACHE_PREFIX + version, filesCache: FILES_CACHE, only }, null, LOAD_TIMEOUT_MS);
    this.note(`opened ${version} in ${stats.loadMs} ms (${stats.items} items)`);
    this.manifest = manifest;
    this.stats = { ...stats, wallMs: Math.round(performance.now() - t0), downloadMs: this.#lastDownloadMs };
    this.#lastDownloadMs = null;
    this.version = version;
    this.skipped = picked.skipped;
    this.more = this.#pendingOf(stats, picked);
    if (!quiet) {
      this.#setState("ready", { version, manifest, stats: this.stats, more: this.more });
      this.#emit("ready", { stats: this.stats, manifest });
      this.#resolveReady?.(true);
    }
    this.#cleanup().catch(() => {});
    this.requestPersistence().catch(() => {});
  }

  /** What is still to come for this phone: the worker's pending list minus the shards the budget leaves out. */
  #pendingOf(stats, picked) {
    const pending = (stats.pending || []).filter((id) => picked.open.includes(id));
    return pending.length ? { loaded: stats.shards, pending } : null;
  }

  /** The other departments of the open version: open what is already on the phone, download what is missing (when
   *  online), and add them to the search. */
  #completeMore() {
    if (this.#moreTask || !this.more || !this.version) return this.#moreTask || Promise.resolve();
    const version = this.version;
    this.#moreTask = (async () => {
      if (navigator.onLine) await this.#download(version, { background: true, tier: "more" });
      if (this.version !== version) return;
      const p = await this.#present(version, this.manifest);
      const picked = pickShards(this.manifest);
      const opened = new Set(this.stats?.shards || []);
      const only = p.shards.filter((id) => picked.open.includes(id));
      if (!only.some((id) => !opened.has(id))) return;      // nothing new on the phone (offline, the rest not downloaded yet)
      const stats = await this.call({ type: "load", root: new URL(DB_ROOT, location.href).href, base: new URL(`${DB_ROOT}${version}/`, location.href).href,
        manifest: this.manifest, cacheName: CACHE_PREFIX + version, filesCache: FILES_CACHE, only });
      this.stats = { ...this.stats, ...stats };
      this.skipped = picked.skipped;
      this.more = this.#pendingOf(stats, picked);
      this.#emit("more", { loaded: stats.shards, pending: this.more?.pending || [], items: stats.items });
    })().catch((err) => { console.warn("other departments not downloaded yet", err); this.#emit("more-paused", { message: String(err?.message || err) }); }).finally(() => { this.#moreTask = null; });
    return this.#moreTask;
  }

  /** Bytes of the open version that are on this phone (the shards it opens plus the per-version files), from the manifest. */
  installedBytes() {
    if (!this.manifest || !this.version) return 0;
    const have = new Set(this.stats?.shards || []);
    return fileList(this.manifest, this.version).reduce((a, f) => a + (f.shard == null || have.has(f.shard) ? f.bytes : 0), 0);
  }

  /**
   * Look for a newer snapshot and download it in the background while the current one keeps answering.
   * Returns {upToDate} | {downloaded, version} | {pending, version} | {applied, version} | {offline} | {notReady}.
   */
  checkForUpdate(opts = {}) {
    if (this.#updating) return this.#updating.then(() => ({ busy: true }));
    const run = this.#checkForUpdate(opts);
    this.#updating = run.finally(() => { this.#updating = null; });
    return this.#updating;
  }
  async #checkForUpdate({ apply = false } = {}) {
    if (!navigator.onLine) return { offline: true };
    if (!this.version) {
      // nothing installed yet: a first install is start()'s job, never two parallel downloads
      if (this.state === "offline-empty" || this.state === "error" || this.state === "idle") { this.#updating = null; await this.start(); return { installed: !!this.version }; }
      return { notReady: true };
    }
    this.#completeMore().catch(() => {});
    const cur = await this.#fetchCurrent();
    if (cur.version === this.version) { this.#writeKey(PENDING_KEY, null); return { upToDate: true }; }
    if (this.pendingUpdate?.version !== cur.version) {
      const manifest = await this.#download(cur.version, { background: true, tier: "all" });
      this.pendingUpdate = { version: cur.version, manifest };
      this.#writeKey(PENDING_KEY, { version: cur.version, at: Date.now() });
      this.#emit("update-available", { version: cur.version, manifest });
    }
    if (apply) { await this.applyUpdate(); return { applied: this.version === cur.version, version: cur.version }; }
    return { pending: true, version: cur.version };
  }

  /** Swap to the downloaded snapshot. Shards whose files did not change stay open; the old pack is restored on failure. */
  applyUpdate() {
    // one swap at a time: a second caller (the idle handler and an "Update now" tap) waits for the same one
    if (this.#applying) return this.#applying;
    if (!this.pendingUpdate) return Promise.resolve(false);
    this.#applying = this.#applyNow().finally(() => { this.#applying = null; });
    return this.#applying;
  }
  #applying = null;
  async #applyNow() {
    const u = this.pendingUpdate;
    const prev = this.version;
    this.pendingUpdate = null;
    try {
      await this.#load(u.version);
      this.#writeKey(KEY, { version: u.version, installedAt: Date.now() });
      this.#writeKey(PENDING_KEY, null);
      return true;
    } catch (err) {
      console.warn("new pack failed to open, restoring the previous one", err);
      this.#writeKey(PENDING_KEY, null);
      await caches.delete(CACHE_PREFIX + u.version).catch(() => {});
      if (prev) await this.#load(prev);
      throw err;
    }
  }

  /** Remove versions and shard files nothing uses any more (keeps the open, pending and downloading versions). */
  async #cleanup() {
    const keep = new Set([this.version, this.pendingUpdate?.version, this.#readKey(PENDING_KEY)?.version,
      ...[...this.#downloads.keys()].map((k) => k.split(":")[0])].filter(Boolean));
    const used = new Set();
    for (const v of keep) { const m = v === this.version ? this.manifest : await this.#manifestOf(v); if (m) for (const f of fileList(m, v)) used.add(new URL(f.url, location.href).href); }
    for (const n of await caches.keys()) {
      if (n === FILES_CACHE) {
        const c = await caches.open(n);
        for (const req of await c.keys()) if (!used.has(req.url)) await c.delete(req);
      } else if (n.startsWith(CACHE_PREFIX) && !keep.has(n.slice(CACHE_PREFIX.length))) await caches.delete(n);
    }
  }

  async storageEstimate() { try { return await navigator.storage.estimate(); } catch { return null; } }

  /** true when the browser has promised not to evict the pack, false when storage is best-effort, null when it cannot say. */
  async persistenceStatus() {
    try {
      if (!navigator.storage?.persisted) return null;
      this.persisted = !!(await navigator.storage.persisted());
      return this.persisted;
    } catch { return null; }
  }

  /**
   * Ask the browser to keep the pack through storage pressure. Chrome decides silently (installed app, bookmark or
   * enough engagement), Safari grants it to Home Screen apps, Firefox asks the user: cheap to repeat, so it is asked
   * after every successful load, but at most once a day unless `force` (the app was just installed, which changes
   * the answer). Resolves to the same values as persistenceStatus(); never throws.
   */
  async requestPersistence({ force = false } = {}) {
    const s = navigator.storage;
    if (!s?.persist) { this.persisted = null; return null; }
    try {
      if (s.persisted && (await s.persisted())) { this.persisted = true; return true; }
      const askedAt = Number(this.#readKey(PERSIST_KEY)?.askedAt) || 0;
      if (!force && Date.now() - askedAt < PERSIST_RETRY_MS) { this.persisted = false; return false; }
      this.#writeKey(PERSIST_KEY, { askedAt: Date.now() });
      this.persisted = !!(await s.persist());
      return this.persisted;
    } catch { return null; }
  }

  // ---- queries
  search(q, limit = 40) { return this.call({ type: "search", q, limit }); }
  lookupUpc(key) { return this.call({ type: "upc", key }); }
  lookupPlu(code) { return this.call({ type: "plu", code }); }
  item(rank) { return this.call({ type: "item", rank }); }
  /** The same product's other sizes and counts (see db-worker sizesOf). */
  sizes(rank, limit = 8) { return this.call({ type: "sizes", rank, limit }); }

  /** Remove every downloaded pack and the markers (settings → reset). The app shell is left alone. */
  async reset() {
    await this.call({ type: "unload" }).catch(() => {});
    for (const n of await caches.keys()) if (n.startsWith(CACHE_PREFIX)) await caches.delete(n);
    this.#writeKey(KEY, null); this.#writeKey(PENDING_KEY, null);
    this.version = null; this.manifest = null; this.stats = null; this.pendingUpdate = null; this.more = null; this.skipped = [];
  }
}
