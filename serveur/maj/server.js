// Serveur de la Table Daggerheart. Node.js 18 ou plus, aucune dépendance à installer.
// Lancement : node server.js   (configuration dans config.json)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const CFG = { port: 8090, tableCode: "", mjCode: "" };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"))); }
catch (e) { console.error("config.json introuvable ou invalide :", e.message); process.exit(1); }
if (process.env.PORT) CFG.port = +process.env.PORT;
if (!CFG.mjCode || CFG.mjCode.length < 4 || CFG.mjCode === "change-moi") { console.error("Ouvrez config.json et choisissez votre propre mjCode (4 caractères minimum)."); process.exit(1); }

/* ---------- Stockage (un fichier JSON, écriture atomique, sauvegarde quotidienne) ---------- */
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BK_DIR = path.join(DATA_DIR, "sauvegardes");
fs.mkdirSync(BK_DIR, { recursive: true });
let store = {};
try { store = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { store = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + ".tmp";
    const txt = JSON.stringify(store);
    try { fs.writeFileSync(tmp, txt); fs.renameSync(tmp, DB_FILE); }
    catch (e) { try { fs.writeFileSync(DB_FILE, txt); } catch (e2) { console.error("Écriture impossible :", e2.message); return; } }
    const day = new Date().toISOString().slice(0, 10);
    const bk = path.join(BK_DIR, "db-" + day + ".json");
    if (!fs.existsSync(bk)) {
      fs.copyFileSync(DB_FILE, bk);
      const old = fs.readdirSync(BK_DIR).filter(f => f.startsWith("db-")).sort();
      while (old.length > 30) fs.unlinkSync(path.join(BK_DIR, old.shift()));
    }
  }, 400);
}

/* ---------- Identité et droits ---------- */
const SEG = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
const validPath = p => typeof p === "string" && p.length <= 1000 && p.split("/").every(s => SEG.test(s));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function who(req, q) {
  const h = k => req.headers[k] || (q && q.get(k.replace("x-", ""))) || "";
  const table = h("x-table"), mj = h("x-mj"), pid = h("x-player");
  if (CFG.tableCode && !same(table, CFG.tableCode)) return null;
  if (!/^p_[a-z0-9]{8,32}$/.test(pid)) return null;
  return { pid, mj: !!mj && same(mj, CFG.mjCode) };
}
function canRead(p, w) {
  const s = p.split("/");
  if (s[0] === "table") return true;
  if (s[0] === "players") return s.length === 1 ? w.mj : (s[1] === w.pid || w.mj);
  if (s[0] === "data" && s[1] === "users") return s[2] === w.pid;
  if (s[0] === "chars") return w.mj;
  return false;
}
function canWrite(p, w) {
  const s = p.split("/");
  if (s[0] === "table") return w.mj;
  if (s[0] === "players") return s.length >= 2 && (s[1] === w.pid || w.mj);
  if (s[0] === "data" && s[1] === "users") return s[2] === w.pid;
  if (s[0] === "chars") return w.mj;
  return false;
}

/* ---------- Anti force brute sur les codes ---------- */
const fails = new Map();
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; }
function fail(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60e3) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); }

/* ---------- Adresse publique du tunnel (lue dans data/tunnel.log) ---------- */
let tunnelCache = { t: 0, u: "" };
function tunnelUrl() {
  if (Date.now() - tunnelCache.t < 10e3) return tunnelCache.u;
  let u = "";
  try { const m = fs.readFileSync(path.join(DATA_DIR, "tunnel.log"), "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g); if (m) u = m[m.length - 1]; } catch (e) {}
  tunnelCache = { t: Date.now(), u }; return u;
}

/* ---------- Temps réel (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast(p) { for (const c of clients) { try { c.write("data: " + p + "\n\n"); } catch (e) {} } }
setInterval(() => { for (const c of clients) { try { c.write(": ping\n\n"); } catch (e) {} } }, 25e3);

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json", ".apk": "application/vnd.android.package-archive" };
function send(res, code, obj) { const b = obj === undefined ? "" : JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(b); }
function body(req) {
  return new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > 3e6) { ko(new Error("trop gros")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); } catch (e) { ko(e); } });
    req.on("error", ko);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ip = req.socket.remoteAddress || "";
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    if (u.pathname.startsWith("/api/")) {
      if (u.pathname === "/api/ping") return send(res, 200, { ok: true, needTable: !!CFG.tableCode, publicUrl: tunnelUrl() });
      if (tooMany(ip)) return send(res, 429, { error: "Trop d’essais, réessayez dans 10 minutes." });
      const w = who(req, u.pathname === "/api/events" ? u.searchParams : null);
      if (u.pathname === "/api/login") {
        if (!w) { fail(ip); return send(res, 401, { error: "Code de table incorrect." }); }
        if (req.headers["x-mj"] && !w.mj) { fail(ip); return send(res, 401, { error: "Code MJ incorrect." }); }
        return send(res, 200, { ok: true, mj: w.mj });
      }
      if (!w) { fail(ip); return send(res, 401, { error: "Non autorisé." }); }
      if (u.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        clients.add(res); req.on("close", () => clients.delete(res));
        return;
      }
      const p = u.searchParams.get("p") || "";
      if (!validPath(p)) return send(res, 400, { error: "Chemin invalide." });
      if (u.pathname === "/api/doc") {
        if (req.method === "GET") { if (!canRead(p, w)) return send(res, 200, { exists: false }); return send(res, 200, store[p] === undefined ? { exists: false } : { exists: true, data: store[p] }); }
        if (!canWrite(p, w)) return send(res, 403, { error: "Accès refusé." });
        if (req.method === "PUT") { const d = await body(req); if (!d || typeof d !== "object" || Array.isArray(d)) return send(res, 400, { error: "Document invalide." }); store[p] = d; persist(); broadcast(p); return send(res, 200, { ok: true }); }
        if (req.method === "DELETE") { delete store[p]; persist(); broadcast(p); return send(res, 200, { ok: true }); }
        return send(res, 405, { error: "Méthode non permise." });
      }
      if (u.pathname === "/api/col" && req.method === "GET") {
        if (!canRead(p, w)) return send(res, 200, []);
        const pre = p + "/", out = [];
        for (const k of Object.keys(store)) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) { const id = k.slice(pre.length); if (canRead(k, w)) out.push({ id, data: store[k] }); }
        return send(res, 200, out);
      }
      return send(res, 404, { error: "Introuvable." });
    }
    // Fichiers statiques
    let f = decodeURIComponent(u.pathname); if (f === "/") f = "/index.html";
    const fp = path.normalize(path.join(ROOT, "public", f));
    if (!fp.startsWith(path.join(ROOT, "public")) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("Introuvable"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream", "Cache-Control": f === "/sw.js" || f === "/index.html" ? "no-cache" : "public, max-age=3600" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { send(res, 500, { error: "Erreur serveur." }); }
});
server.listen(CFG.port, () => console.log("Table Daggerheart en ligne sur le port " + CFG.port));
