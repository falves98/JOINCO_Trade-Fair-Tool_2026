// JOINCO Sourcing Intelligence — standalone server.
// Serves the mobile app (../app/index.html), a shared JSON document store (SQLite),
// photo storage (files on disk), password login, and the AI photo analysis.
// The Anthropic API key never leaves this process.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = +process.env.PORT || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const APP_HTML = path.resolve(process.env.APP_HTML || path.join(__dirname, "..", "app", "index.html"));
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const EFFORT = process.env.ANALYSIS_EFFORT || "low"; // speed matters at the booth
const COLLECTIONS = new Set(["suppliers", "visits", "contacts", "products", "images"]);
const SESSION_DAYS = 30;

fs.mkdirSync(path.join(DATA_DIR, "blobs"), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL, created_by TEXT);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
const meta = {
  get: k => db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v,
  set: (k, v) => db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
};
const SECRET = process.env.SESSION_SECRET || meta.get("secret") || (() => { const s = crypto.randomBytes(32).toString("hex"); meta.set("secret", s); return s; })();
let version = +(meta.get("version") || 0);
const bump = () => { version++; meta.set("version", version); };

// ---------------------------------------------------------------- users & sessions
function hashPw(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return salt + ":" + crypto.scryptSync(String(pw), salt, 64).toString("hex");
}
function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newId = () => crypto.randomBytes(12).toString("hex");
function createUser({ email, name, password, admin }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email");
  if (String(password || "").length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw new HttpError(409, "That email already has an account");
  const u = { id: "u" + newId(), email, name: String(name || email.split("@")[0]).trim().slice(0, 80), admin: admin ? 1 : 0 };
  db.prepare("INSERT INTO users(id,email,name,pw,admin,created) VALUES(?,?,?,?,?,?)").run(u.id, u.email, u.name, hashPw(password), u.admin, new Date().toISOString());
  return u;
}
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !db.prepare("SELECT 1 FROM users WHERE email=?").get(process.env.ADMIN_EMAIL.toLowerCase())) {
  createUser({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || "Admin", password: process.env.ADMIN_PASSWORD, admin: true });
  console.log("Created admin user", process.env.ADMIN_EMAIL);
}
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function sessionCookie(uid) {
  const exp = Date.now() + SESSION_DAYS * 864e5; const v = `${uid}.${exp}`;
  return `jsi=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.INSECURE_COOKIE ? "" : "; Secure"}`;
}
function currentUser(req) {
  const m = /(?:^|;\s*)jsi=([^;]+)/.exec(req.headers.cookie || ""); if (!m) return null;
  const [uid, exp, sig] = m[1].split("."); if (!uid || !exp || !sig) return null;
  const expect = sign(`${uid}.${exp}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) || +exp < Date.now()) return null;
  return db.prepare("SELECT id,email,name,admin FROM users WHERE id=?").get(uid) || null;
}
const loginAttempts = new Map();

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body), isStr = typeof body === "string";
  res.writeHead(status, { "content-type": isBuf || isStr ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "same-origin", ...headers });
  res.end(isBuf || isStr ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(new HttpError(413, "Too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
async function readJson(req, limit = 1e6) { const b = await readBody(req, limit); try { return JSON.parse(b.toString("utf8") || "{}"); } catch { throw new HttpError(400, "Invalid JSON"); } }
function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === "object" && !Array.isArray(v) && t[k] && typeof t[k] === "object" && !Array.isArray(t[k])) deepMerge(t[k], v); else t[k] = v;
  }
  return t;
}
const validId = id => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) && id !== "." && id !== "..";

// ---------------------------------------------------------------- AI analysis
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text); if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const i = text.indexOf("{"), j = text.lastIndexOf("}"); if (i >= 0 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch {} }
  return undefined;
}
async function analyse({ prompt, images }) {
  if (!anthropic) throw new HttpError(503, "AI analysis is not configured on the server (ANTHROPIC_API_KEY missing)");
  if (typeof prompt !== "string" || !prompt || prompt.length > 200000) throw new HttpError(400, "Bad prompt");
  if (!Array.isArray(images) || images.length > 20) throw new HttpError(400, "Send 1-20 images");
  const content = [];
  images.forEach((im, i) => {
    const mt = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(im?.type) ? im.type : "image/jpeg";
    if (typeof im?.data !== "string" || !im.data) throw new HttpError(400, "Bad image " + (i + 1));
    content.push({ type: "text", text: `Image ${i + 1}:` }, { type: "image", source: { type: "base64", media_type: mt, data: im.data } });
  });
  content.push({ type: "text", text: prompt });
  const msg = await anthropic.beta.messages.create({
    model: MODEL, max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: EFFORT },
    messages: [{ role: "user", content }],
  });
  if (msg.stop_reason === "refusal") throw new HttpError(422, "refused");
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (msg.stop_reason === "max_tokens") throw new HttpError(422, "invalid_json");
  const json = parseJsonLoose(text);
  if (json === undefined) throw new HttpError(422, "invalid_json");
  return { json, model: msg.model, usage: { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens } };
}

// ---------------------------------------------------------------- pages
const RUNTIME = fs.readFileSync(path.join(__dirname, "runtime.js"), "utf8");
const LOGIN = fs.readFileSync(path.join(__dirname, "login.html"), "utf8");
const SKELETON_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#C2440F"><link rel="manifest" href="/manifest.webmanifest">
<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;padding:0}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/runtime.js"></script></head><body>`;
function appPage() { return SKELETON_HEAD + fs.readFileSync(APP_HTML, "utf8") + "</body></html>"; }
const MANIFEST = JSON.stringify({ name: "JOINCO Sourcing Intelligence", short_name: "JOINCO Sourcing", start_url: "/", display: "standalone", background_color: "#EEF1F4", theme_color: "#C2440F",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] });
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#C2440F"/><path d="M14 24h8l4-6h12l4 6h8v24H14z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><circle cx="32" cy="35" r="7" fill="none" stroke="#fff" stroke-width="4"/></svg>`;

// ---------------------------------------------------------------- router
async function handle(req, res) {
  const url = new URL(req.url, "http://x"); const p = url.pathname; const m = req.method;
  if (p === "/healthz") return send(res, 200, { ok: true, ai: !!anthropic });
  if (p === "/runtime.js") return send(res, 200, RUNTIME, { "content-type": "text/javascript; charset=utf-8" });
  if (p === "/manifest.webmanifest") return send(res, 200, MANIFEST, { "content-type": "application/manifest+json" });
  if (p === "/favicon.ico") { res.writeHead(301, { location: "/icon.svg" }); return res.end(); }
  if (p === "/icon.svg") return send(res, 200, ICON, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
  if (p === "/login") return send(res, 200, LOGIN);
  if (p === "/api/login" && m === "POST") {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    const a = loginAttempts.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 20) throw new HttpError(429, "Too many attempts. Try again in 15 minutes");
    const { email, password } = await readJson(req);
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(email || "").trim().toLowerCase());
    if (!u || !checkPw(password, u.pw)) { a.n++; loginAttempts.set(ip, a); throw new HttpError(401, "Wrong email or password"); }
    return send(res, 200, { ok: true }, { "set-cookie": sessionCookie(u.id) });
  }
  if (p === "/api/logout") return send(res, 200, { ok: true }, { "set-cookie": "jsi=; Path=/; Max-Age=0" });

  const user = currentUser(req);
  if (!user) {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new HttpError(401, "Sign in first");
    res.writeHead(302, { location: "/login" }); return res.end();
  }
  if (p === "/" || p === "/index.html") return send(res, 200, appPage());
  if (p === "/api/me") return send(res, 200, { id: user.id, name: user.name, email: user.email, admin: !!user.admin });
  if (p === "/api/version") return send(res, 200, { v: version });

  // documents
  let mm = /^\/api\/db\/([a-z]+)(?:\/([^/]+))?$/.exec(p);
  if (mm) {
    const [, col, rawId] = mm; if (!COLLECTIONS.has(col)) throw new HttpError(404, "Unknown collection");
    if (!rawId && m === "GET") {
      const rows = db.prepare("SELECT id,data FROM docs WHERE col=?").all(col).map(r => ({ id: r.id, data: JSON.parse(r.data) }));
      const ob = url.searchParams.get("orderBy"), dir = url.searchParams.get("dir") === "desc" ? -1 : 1;
      if (ob) rows.sort((a, b) => { const x = a.data[ob], y = b.data[ob]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : 1) * dir; });
      else rows.sort((a, b) => a.id < b.id ? -1 : 1);
      const lim = Math.min(5000, +url.searchParams.get("limit") || 5000);
      return send(res, 200, { v: version, docs: rows.slice(0, lim) });
    }
    const id = decodeURIComponent(rawId || ""); if (!validId(id)) throw new HttpError(400, "Bad id");
    if (m === "GET") { const r = db.prepare("SELECT data FROM docs WHERE col=? AND id=?").get(col, id); return send(res, 200, { exists: !!r, data: r ? JSON.parse(r.data) : null }); }
    if (m === "PUT" || m === "PATCH") {
      const body = await readJson(req, 512 * 1024); if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be an object");
      let data = body;
      if (m === "PATCH") { const r = db.prepare("SELECT data FROM docs WHERE col=? AND id=?").get(col, id); if (!r) throw new HttpError(404, "Document does not exist"); data = deepMerge(JSON.parse(r.data), body); }
      db.prepare("INSERT INTO docs(col,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated").run(col, id, JSON.stringify(data), Date.now());
      bump(); return send(res, 200, { ok: true, v: version });
    }
    if (m === "DELETE") { db.prepare("DELETE FROM docs WHERE col=? AND id=?").run(col, id); bump(); return send(res, 200, { ok: true, v: version }); }
  }

  // photos
  if (p === "/api/assets" && m === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) throw new HttpError(415, "Images only");
    const buf = await readBody(req, 20 * 1024 * 1024); if (!buf.length) throw new HttpError(400, "Empty file");
    const id = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(DATA_DIR, "blobs", id), buf);
    db.prepare("INSERT INTO blobs(id,type,bytes,created,created_by) VALUES(?,?,?,?,?)").run(id, type, buf.length, new Date().toISOString(), user.id);
    return send(res, 200, { id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
  }
  mm = /^\/api\/assets\/([0-9a-f]{32})$/.exec(p);
  if (mm && m === "DELETE") { const r = db.prepare("DELETE FROM blobs WHERE id=?").run(mm[1]); try { fs.unlinkSync(path.join(DATA_DIR, "blobs", mm[1])); } catch {} return send(res, 200, { deleted: r.changes > 0 }); }
  mm = /^\/_blob\/([0-9a-f]{32})$/.exec(p);
  if (mm && m === "GET") {
    const r = db.prepare("SELECT type FROM blobs WHERE id=?").get(mm[1]); if (!r) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": r.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    return fs.createReadStream(path.join(DATA_DIR, "blobs", mm[1])).pipe(res);
  }

  // AI
  if (p === "/api/analyse" && m === "POST") {
    const body = await readJson(req, 40 * 1024 * 1024);
    try { return send(res, 200, await analyse(body)); }
    catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("analyse failed:", e?.status, e?.message);
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "rate_limited");
      if (e instanceof Anthropic.BadRequestError) throw new HttpError(400, "AI request rejected: " + (e.message || "").slice(0, 200));
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The server's Anthropic API key is invalid");
      throw new HttpError(502, "upstream_error");
    }
  }

  // people
  if (p === "/api/profiles") {
    const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200); const out = {};
    for (const id of ids) { const u = db.prepare("SELECT id,name FROM users WHERE id=?").get(id); out[id] = { id, name: u?.name || "" }; }
    return send(res, 200, out);
  }
  if (p.startsWith("/api/users")) {
    if (!user.admin) throw new HttpError(403, "Admins only");
    if (p === "/api/users" && m === "GET") return send(res, 200, db.prepare("SELECT id,email,name,admin,created FROM users ORDER BY created").all().map(u => ({ ...u, admin: !!u.admin })));
    if (p === "/api/users" && m === "POST") { const b = await readJson(req); return send(res, 200, createUser(b)); }
    mm = /^\/api\/users\/(u[0-9a-f]+)(\/password)?$/.exec(p);
    if (mm && m === "POST" && mm[2]) { const b = await readJson(req); if (String(b.password || "").length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      db.prepare("UPDATE users SET pw=? WHERE id=?").run(hashPw(b.password), mm[1]); return send(res, 200, { ok: true }); }
    if (mm && m === "DELETE" && !mm[2]) { if (mm[1] === user.id) throw new HttpError(400, "You can't remove yourself"); db.prepare("DELETE FROM users WHERE id=?").run(mm[1]); return send(res, 200, { ok: true }); }
  }
  throw new HttpError(404, "Not found");
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    const status = e instanceof HttpError ? e.status : 500; if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : "Server error" }); else res.end();
  });
}).listen(PORT, () => console.log(`JOINCO Sourcing Intelligence on :${PORT} (AI ${anthropic ? MODEL + "/" + EFFORT : "not configured"})`));
