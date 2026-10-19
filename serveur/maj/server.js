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

/* ---------- Réglages modifiables depuis la page admin (stockés dans data, prioritaires sur config.json) ---------- */
const S = () => store["_cfg"] || (store["_cfg"] = {});
const tableCode = () => (typeof S().tableCode === "string" ? S().tableCode : CFG.tableCode) || "";
const mjCode = () => S().mjCode || CFG.mjCode;
const signupOpen = () => S().open !== false;

/* ---------- Journal (300 derniers évènements) ---------- */
function log(ev, who, ip) {
  const l = store["_log"] || (store["_log"] = []);
  l.push({ t: Date.now(), ev, who: who || "", ip: String(ip || "").replace(/^::ffff:/, "") });
  while (l.length > 300) l.shift();
  persist();
}

/* ---------- Identité et droits ---------- */
const SEG = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
const validPath = p => typeof p === "string" && p.length <= 1000 && p.split("/").every(s => SEG.test(s));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const NAME = /^[a-z0-9][a-z0-9-]{1,19}$/;
const slug = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
const dec = s => { try { return decodeURIComponent(String(s || "")); } catch (e) { return ""; } };
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randCode = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % ALPHA.length]).join("");
const fmtRec = c => c.match(/.{1,4}/g).join("-");
const normRec = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const okPin = p => typeof p === "string" && p.length >= 4 && p.length <= 64;
const rec = sl => store["_auth/" + sl];

function setPin(r, pin, tmp) { r.s = crypto.randomBytes(16).toString("hex"); r.h = hashPin(pin, r.s); if (tmp) r.tmp = true; else delete r.tmp; okCache.clear(); }
function newRecovery(r) { const c = randCode(12); r.rs = crypto.randomBytes(16).toString("hex"); r.rh = hashPin(c, r.rs); return fmtRec(c); }

const okCache = new Map();
function checkPin(sl, pin) {
  const r = rec(sl); if (!r || !pin) return false;
  const k = sl + "\0" + crypto.createHash("sha256").update(String(pin)).digest("hex");
  if (okCache.get(k) === r.h) return true;
  const ok = same(hashPin(pin, r.s), r.h); if (ok) okCache.set(k, r.h); return ok;
}
function seen(sl) { const r = rec(sl); if (!r) return; const now = Date.now(); if (!r.last || now - r.last > 5 * 60e3) { r.last = now; persist(); } else r.last = now; }
function who(req, q) {
  const h = k => req.headers[k] || (q && q.get(k.replace("x-", ""))) || "";
  const table = h("x-table"), mj = h("x-mj"), sl = slug(dec(h("x-player"))), pin = h("x-pin");
  if (tableCode() && !same(table, tableCode())) return null;
  if (!NAME.test(sl) || !checkPin(sl, pin)) return null;
  const r = rec(sl); if (r.locked) return null;
  seen(sl);
  return { sl, pid: "p_" + sl, mj: !!mj && same(mj, mjCode()), tmp: !!r.tmp };
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
function fail(ip, why, name) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60e3) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); if (why) log(why, name, ip); }

/* ---------- Adresse publique du tunnel (lue dans data/tunnel.log) ---------- */
let tunnelCache = { t: 0, u: "" };
function tunnelUrl() {
  if (Date.now() - tunnelCache.t < 10e3) return tunnelCache.u;
  let u = "";
  try { const m = fs.readFileSync(path.join(DATA_DIR, "tunnel.log"), "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g); if (m) u = m[m.length - 1]; } catch (e) {}
  tunnelCache = { t: Date.now(), u }; return u;
}

/* ---------- Temps réel (Server-Sent Events) ---------- */
const clients = new Map(); // res -> slug
function broadcast(p) { for (const c of clients.keys()) { try { c.write("data: " + p + "\n\n"); } catch (e) {} } }
function kick(sl) { for (const [c, s] of clients) if (s === sl) { try { c.end(); } catch (e) {} clients.delete(c); } }
setInterval(() => { for (const c of clients.keys()) { try { c.write(": ping\n\n"); } catch (e) {} } }, 25e3);

/* ---------- Administration (MJ) ---------- */
const keysOf = pid => Object.keys(store).filter(k => k === "players/" + pid || k.startsWith("players/" + pid + "/") || k === "data/users/" + pid || k.startsWith("data/users/" + pid + "/"));
function charsOf(pid) {
  const pre = "players/" + pid + "/chars/";
  return Object.keys(store).filter(x => x.startsWith(pre) && !x.slice(pre.length).includes("/")).map(x => { const c = store[x] || {}; return { id: x.slice(pre.length), name: c.name || "Sans nom", classe: c.classe || "", level: c.level || 1, updatedAt: c.updatedAt || 0 }; });
}
function accounts() {
  const online = new Set(clients.values());
  return Object.keys(store).filter(k => k.startsWith("_auth/")).map(k => {
    const sl = k.slice(6), r = store[k], chars = charsOf("p_" + sl);
    return { slug: sl, name: r.n, created: r.t || 0, last: r.last || 0, tmp: !!r.tmp, locked: !!r.locked, recovery: !!r.rh, online: online.has(sl), chars };
  }).sort((a, b) => (b.last || b.created) - (a.last || a.created));
}
async function admin(req, res, u, w, ip) {
  if (!w.mj) return send(res, 403, { error: "Réservé au MJ." });
  const op = u.pathname.slice(11), q = u.searchParams, sl = slug(q.get("name"));
  const need = () => { const r = rec(sl); if (!r) { send(res, 404, { error: "Joueur inconnu." }); return null; } return r; };
  if (op === "overview" && req.method === "GET") {
    const pids = new Set(Object.keys(store).filter(k => k.startsWith("players/")).map(k => k.split("/")[1]));
    const orphans = [...pids].filter(pid => !(pid.startsWith("p_") && rec(pid.slice(2)))).map(pid => ({ pid, chars: charsOf(pid) }));
    const bks = fs.readdirSync(BK_DIR).filter(f => f.startsWith("db-")).sort().reverse();
    return send(res, 200, { accounts: accounts(), orphans, settings: { tableCode: tableCode(), open: signupOpen(), mjFromFile: !S().mjCode }, log: (store["_log"] || []).slice(-120).reverse(), backups: bks, online: clients.size, me: w.sl });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Méthode non permise." });
  const b = (await body(req).catch(() => null)) || {};
  switch (op) {
    case "reset": { const r = need(); if (!r) return; const tmp = randCode(6); setPin(r, tmp, true); kick(sl); persist(); log("Code provisoire créé par le MJ", r.n, ip); return send(res, 200, { ok: true, temp: tmp }); }
    case "lock": { const r = need(); if (!r) return; if (sl === w.sl) return send(res, 400, { error: "Vous ne pouvez pas bloquer votre propre compte." }); r.locked = !r.locked; okCache.clear(); if (r.locked) kick(sl); persist(); log(r.locked ? "Compte bloqué" : "Compte débloqué", r.n, ip); return send(res, 200, { ok: true, locked: r.locked }); }
    case "rename": { const r = need(); if (!r) return; const n = String(b.display || "").trim().slice(0, 30); if (slug(n) !== sl) return send(res, 400, { error: "Le nouveau nom doit garder les mêmes lettres (seuls majuscules, accents et espaces changent)." }); r.n = n; persist(); return send(res, 200, { ok: true }); }
    case "delete": {
      const r = need(); if (!r) return; if (sl === w.sl) return send(res, 400, { error: "Vous ne pouvez pas supprimer votre propre compte." });
      if (slug(b.confirm) !== sl) return send(res, 400, { error: "Tapez le nom du joueur pour confirmer." });
      const ks = keysOf("p_" + sl); ks.forEach(k => { delete store[k]; broadcast(k); }); delete store["_auth/" + sl]; okCache.clear(); kick(sl); persist();
      log("Compte supprimé (" + ks.length + " documents)", r.n, ip); return send(res, 200, { ok: true });
    }
    case "purge": { const pid = String(q.get("pid") || ""); if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid) || rec(pid.replace(/^p_/, ""))) return send(res, 400, { error: "Dossier invalide." }); const ks = keysOf(pid); ks.forEach(k => { delete store[k]; broadcast(k); }); persist(); log("Fiches orphelines supprimées (" + ks.length + ")", pid, ip); return send(res, 200, { ok: true }); }
    case "movechar": {
      const from = String(q.get("from") || ""), id = String(q.get("id") || ""), to = slug(q.get("to"));
      if (!SEG.test(from) || !SEG.test(id)) return send(res, 400, { error: "Requête invalide." });
      if (!rec(to)) return send(res, 404, { error: "Joueur destinataire inconnu." });
      const src = "players/" + from + "/chars/" + id, dst = "players/p_" + to + "/chars/" + id;
      if (!store[src]) return send(res, 404, { error: "Fiche introuvable." });
      if (src === dst) return send(res, 200, { ok: true });
      const c = store[src]; if (c && typeof c === "object") c.owner = "p_" + to;
      store[dst] = c; delete store[src]; store["players/p_" + to] = Object.assign({}, store["players/p_" + to], { updatedAt: Date.now() });
      persist(); broadcast(src); broadcast(dst); broadcast("players/p_" + to); log("Fiche « " + ((c && c.name) || id) + " » transférée à " + rec(to).n, from, ip); return send(res, 200, { ok: true });
    }
    case "delchar": { const from = String(q.get("from") || ""), id = String(q.get("id") || ""); if (!SEG.test(from) || !SEG.test(id)) return send(res, 400, { error: "Requête invalide." }); const k = "players/" + from + "/chars/" + id; const c = store[k]; if (!c) return send(res, 404, { error: "Fiche introuvable." }); delete store[k]; persist(); broadcast(k); log("Fiche « " + (c.name || id) + " » supprimée", from, ip); return send(res, 200, { ok: true }); }
    case "settings": {
      const s = S();
      if (typeof b.open === "boolean") { s.open = b.open; log(b.open ? "Inscriptions ouvertes" : "Inscriptions fermées", rec(w.sl).n, ip); }
      if (typeof b.tableCode === "string") { const t = b.tableCode.trim(); if (t && (t.length < 4 || t.length > 64)) return send(res, 400, { error: "Code de table : 4 à 64 caractères." }); s.tableCode = t; log("Code de table modifié", rec(w.sl).n, ip); }
      if (typeof b.mjCode === "string") { if (b.mjCode.length < 8 || b.mjCode.length > 64) return send(res, 400, { error: "Code MJ : 8 caractères minimum." }); if (b.mjCode !== b.mjCode2) return send(res, 400, { error: "Les deux codes MJ ne correspondent pas." }); s.mjCode = b.mjCode; log("Code MJ modifié", rec(w.sl).n, ip); }
      persist(); return send(res, 200, { ok: true });
    }
    case "clearlog": store["_log"] = []; log("Journal vidé", rec(w.sl).n, ip); return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Introuvable." });
}

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
  res.setHeader("X-Frame-Options", "DENY");
  try {
    if (u.pathname.startsWith("/api/")) {
      if (u.pathname === "/api/ping") return send(res, 200, { ok: true, needTable: !!tableCode(), open: signupOpen(), publicUrl: tunnelUrl(), v: 2 });
      if (tooMany(ip)) return send(res, 429, { error: "Trop d’essais, réessayez dans 10 minutes." });
      const H = k => req.headers[k] || "";

      /* Connexion et création de compte */
      if (u.pathname === "/api/login") {
        const mjc = H("x-mj"), pin = String(H("x-pin")), raw = dec(H("x-player")).trim(), mode = H("x-mode") || "login";
        if (tableCode() && !same(H("x-table"), tableCode())) { fail(ip, "Code de table incorrect", raw); return send(res, 401, { error: "Code de table incorrect." }); }
        const sl = slug(raw);
        if (!NAME.test(sl)) return send(res, 400, { error: "Nom de joueur : 2 à 20 lettres ou chiffres." });
        if (!okPin(pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        let r = rec(sl), recovery = "";
        if (mode === "create") {
          if (r) return send(res, 409, { error: "Ce nom est déjà pris. Choisissez-en un autre ou connectez-vous." });
          if (!signupOpen() && !(mjc && same(mjc, mjCode()))) return send(res, 403, { error: "Les inscriptions sont fermées. Demandez au MJ de les ouvrir." });
          if (mjc && !same(mjc, mjCode())) { fail(ip, "Code MJ incorrect", raw); return send(res, 401, { error: "Code MJ incorrect." }); }
          r = store["_auth/" + sl] = { n: raw.slice(0, 30), t: Date.now() }; setPin(r, pin); recovery = newRecovery(r); r.last = Date.now(); persist(); log("Compte créé", r.n, ip);
        } else {
          if (!r) { fail(ip); return send(res, 404, { error: "Aucun compte à ce nom. Vérifiez l’orthographe ou créez un compte." }); }
          if (!checkPin(sl, pin)) { fail(ip, "Mauvais mot de passe", r.n); return send(res, 401, { error: "Mot de passe incorrect." }); }
          if (r.locked) { log("Connexion refusée (compte bloqué)", r.n, ip); return send(res, 403, { error: "Ce compte est bloqué. Contactez le MJ." }); }
          if (mjc && !same(mjc, mjCode())) { fail(ip, "Code MJ incorrect", r.n); return send(res, 401, { error: "Code MJ incorrect." }); }
          if (!r.last || Date.now() - r.last > 30 * 60e3) log(mjc ? "Connexion MJ" : "Connexion", r.n, ip);
          r.last = Date.now(); persist();
        }
        return send(res, 200, { ok: true, mj: !!mjc, pid: "p_" + sl, name: r.n, created: mode === "create", recovery, mustChange: !!r.tmp, hasRecovery: !!r.rh });
      }

      /* Mot de passe oublié : code de récupération */
      if (u.pathname === "/api/recover" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {};
        if (tableCode() && !same(H("x-table"), tableCode())) { fail(ip, "Code de table incorrect", b.name); return send(res, 401, { error: "Code de table incorrect." }); }
        const sl = slug(b.name), r = rec(sl), c = normRec(b.code);
        if (!r || !r.rh || c.length !== 12 || !same(hashPin(c, r.rs), r.rh)) { fail(ip, "Récupération échouée", b.name); return send(res, 401, { error: "Nom ou code de récupération incorrect." }); }
        if (r.locked) return send(res, 403, { error: "Ce compte est bloqué. Contactez le MJ." });
        if (!okPin(b.pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        setPin(r, b.pin); const recovery = newRecovery(r); kick(sl); persist(); log("Mot de passe récupéré", r.n, ip);
        return send(res, 200, { ok: true, name: r.n, recovery });
      }

      const w = who(req, u.pathname === "/api/events" ? u.searchParams : null);
      if (!w) { fail(ip); return send(res, 401, { error: "Non autorisé." }); }

      /* Mon compte */
      if (u.pathname === "/api/account/pin" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {};
        if (!okPin(b.pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        const r = rec(w.sl); setPin(r, b.pin); const recovery = r.rh ? "" : newRecovery(r);
        persist(); log(w.tmp ? "Mot de passe choisi après code provisoire" : "Mot de passe modifié", r.n, ip);
        return send(res, 200, { ok: true, recovery });
      }
      if (u.pathname === "/api/account/recovery" && req.method === "POST") { const r = rec(w.sl); const recovery = newRecovery(r); persist(); log("Nouveau code de récupération", r.n, ip); return send(res, 200, { ok: true, recovery }); }
      if (w.tmp) return send(res, 403, { error: "Choisissez d’abord votre nouveau mot de passe." });

      if (u.pathname.startsWith("/api/admin/")) return admin(req, res, u, w, ip);
      if (u.pathname === "/api/resetpin" && req.method === "POST") { return admin(req, res, new URL("/api/admin/reset?" + u.searchParams, "http://x"), w, ip); }
      if (u.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        clients.set(res, w.sl); req.on("close", () => clients.delete(res));
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
