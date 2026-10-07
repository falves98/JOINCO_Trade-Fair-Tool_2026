// Browser runtime for the standalone server. It provides the same `claude.use(name)`
// interface the app uses on claude.ai, backed by this server's REST API, so
// app/index.html runs unchanged in both places.
(function () {
  "use strict";
  const err = (code, message) => ({ code, message: message || code });
  async function api(method, url, body, raw) {
    const init = { method, credentials: "same-origin", headers: {} };
    if (raw) { init.body = raw; init.headers["content-type"] = raw.type || "application/octet-stream"; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    let r;
    try { r = await fetch(url, init); } catch { throw err("unavailable", "No connection"); }
    if (r.status === 401) { location.href = "/login"; throw err("revoked", "Signed out"); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(err(r.status === 404 ? "invalid_argument" : r.status === 413 ? "too_large" : "unavailable", data.error), { status: r.status });
    return data;
  }

  // ------------------------------------------------------------- db
  const cache = {}; const subs = new Set(); let lastV = -1;
  const snapDoc = d => ({ id: d.id, exists: true, data: () => JSON.parse(JSON.stringify(d.data)), metadata: { fromCache: false, hasPendingWrites: false } });
  function view(sub) {
    let docs = (cache[sub.col] || []).slice();
    if (sub.ord) { const [f, dir] = sub.ord; const k = dir === "desc" ? -1 : 1;
      docs.sort((a, b) => { const x = a.data[f], y = b.data[f]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : 1) * k; }); }
    docs = docs.slice(0, sub.lim || 5000).map(snapDoc);
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  const inflight = {};
  function refresh(col) {
    if (inflight[col]) return inflight[col];
    return inflight[col] = api("GET", "/api/db/" + col).then(r => { cache[col] = r.docs; for (const s of subs) if (s.col === col) s.next(view(s)); })
      .catch(() => {}).finally(() => { delete inflight[col]; });
  }
  async function poll() {
    if (!subs.size || document.hidden) return;
    try { const { v } = await api("GET", "/api/version"); if (v !== lastV) { lastV = v; new Set([...subs].map(s => s.col)).forEach(refresh); } } catch {}
  }
  setInterval(poll, 4000); document.addEventListener("visibilitychange", poll);
  function query(col, ord, lim) {
    return {
      where() { throw new TypeError("where() is not supported"); },
      orderBy: (f, d = "asc") => query(col, [f, d], lim),
      limit: n => query(col, ord, n),
      async get() { await refresh(col); return view({ col, ord, lim }); },
      onSnapshot(next, onErr) { const s = { col, ord, lim, next, onErr }; subs.add(s); if (cache[col]) setTimeout(() => next(view(s)), 0); refresh(col); return () => subs.delete(s); },
    };
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
  function docRef(col, id) {
    const u = "/api/db/" + col + "/" + encodeURIComponent(id);
    const after = () => refresh(col);
    return { id, path: col + "/" + id,
      async get() { const r = await api("GET", u); return r.exists ? snapDoc({ id, data: r.data }) : { id, exists: false, data: () => undefined, metadata: {} }; },
      async set(d) { await api("PUT", u, d); after(); },
      async update(d) { await api("PATCH", u, d); after(); },
      async delete() { await api("DELETE", u); after(); },
      onSnapshot(next) { const s = { col, next: q => { const d = q.docs.find(x => x.id === id); next(d || { id, exists: false, data: () => undefined, metadata: {} }); } }; subs.add(s); refresh(col); return () => subs.delete(s); },
    };
  }
  const dbNs = {
    doc(p) { const [col, id] = p.split("/"); return docRef(col, id); },
    collection(col) { return Object.assign(query(col), { path: col, doc: id => docRef(col, id || rid()), async add(d) { const r = docRef(col, rid()); await r.set(d); return r; } }); },
  };

  // ------------------------------------------------------------- assets
  const assets = {
    async upload(blob, opts = {}) { const type = opts.type || blob.type; const b = type === blob.type ? blob : new Blob([blob], { type }); return api("POST", "/api/assets", undefined, b); },
    async delete(ref) { const id = String(ref).split("/").pop(); return api("DELETE", "/api/assets/" + id); },
    async list() { return { assets: [], usage: {} }; },
  };

  // ------------------------------------------------------------- AI
  const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function ask(prompt, opts = {}) {
    if (opts.signal?.aborted) throw err("cancelled");
    const ims = opts.images ? [...(opts.images.length !== undefined ? opts.images : [opts.images])] : [];
    const images = await Promise.all(ims.map(async b => ({ type: b.type || "image/jpeg", data: await toB64(b) })));
    if (opts.signal?.aborted) throw err("cancelled");
    let r;
    try { r = await fetch("/api/analyse", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, images }), signal: opts.signal }); }
    catch (e) { throw err(e?.name === "AbortError" ? "cancelled" : "upstream_error"); }
    if (r.status === 401) { location.href = "/login"; throw err("session_expired"); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const m = data.error || ""; throw err(r.status === 429 ? "rate_limited" : m === "refused" ? "refused" : m === "invalid_json" ? "invalid_json" : r.status === 413 ? "image_rejected" : "upstream_error", m); }
    return data.json;
  }
  const sample = Object.assign(async (prompt, opts) => { const j = await ask(prompt, opts); const text = JSON.stringify(j); opts?.onText?.({ text, delta: text }); return { text, truncated: false, modelTierApplied: "default" }; }, {
    async json(prompt, opts = {}) { const j = await ask(prompt, opts); const text = JSON.stringify(j); try { opts.onText?.({ text, delta: text }); } catch {} return j; },
    async limits() { return { maxPromptBytes: 262144, images: { maxCount: 20, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } }; },
  });

  // ------------------------------------------------------------- people
  let meP = null; const me = () => meP || (meP = api("GET", "/api/me"));
  const user = {
    async me() { const m = await me(); return { id: m.id, name: m.name, email: m.email }; },
    async id() { return (await me()).id; },
    async can() { return true; }, async canEdit() { return true; },
    async isOwner() { return !!(await me()).admin; },
    async profiles(ids) { ids = [].concat(ids).filter(Boolean); if (!ids.length) return {}; return api("GET", "/api/profiles?ids=" + encodeURIComponent(ids.join(","))); },
  };
  const team = {
    me, list: () => api("GET", "/api/users"), add: u => api("POST", "/api/users", u),
    setPassword: (id, password) => api("POST", "/api/users/" + id + "/password", { password }),
    remove: id => api("DELETE", "/api/users/" + id),
    async signOut() { await api("POST", "/api/logout").catch(() => {}); location.href = "/login"; },
  };

  // ------------------------------------------------------------- downloads
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : "application/octet-stream" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return { status: "saved" };
    },
  };

  const caps = { db: dbNs, assets, sample, user, downloads, team };
  window.claude = { use: async name => caps[name] || null, standalone: true };
})();
