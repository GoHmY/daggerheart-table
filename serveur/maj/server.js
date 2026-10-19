// Serveur de la Table Daggerheart. Node.js 18 ou plus, aucune dépendance à installer.
// Lancement : node server.js   (configuration dans config.json)
// Plusieurs tables : chaque table a son code, son code MJ, ses comptes et ses fiches.
// Page de contrôle du site : /admin (mot de passe admin distinct).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tls = require("tls");
const os = require("os");

const ROOT = __dirname;
const CFG = { port: 8090, tableCode: "", mjCode: "" };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8").replace(/^﻿/, ""))); }
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

/* ---------- Outils ---------- */
const SEG = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
const validPath = p => typeof p === "string" && p.length <= 1000 && p.split("/").every(s => SEG.test(s)) && !p.startsWith("_");
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
const okCode = c => typeof c === "string" && c.trim().length >= 4 && c.trim().length <= 64;
const keysWith = pre => Object.keys(store).filter(k => k.startsWith(pre));

/* ---------- Envoi de mails (SMTP Gmail, sans dépendance) ---------- */
const MAIL = { user: String(CFG.mailUser || "").trim(), pass: String(CFG.mailPass || "").replace(/\s+/g, ""), host: CFG.mailHost || "smtp.gmail.com", port: +CFG.mailPort || 465, name: CFG.mailName || "Table Daggerheart" };
const mailOn = () => !!(MAIL.user && MAIL.pass);
const EMAIL = /^[^\s@<>()",;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const b64 = t => Buffer.from(t, "utf8").toString("base64");
function sendMail(to, subject, text) {
  return new Promise((ok, ko) => {
    if (!mailOn()) return ko(new Error("mail non configuré"));
    if (!EMAIL.test(to)) return ko(new Error("adresse invalide"));
    const msg = [
      "From: =?UTF-8?B?" + b64(MAIL.name) + "?= <" + MAIL.user + ">", "To: <" + to + ">",
      "Subject: =?UTF-8?B?" + b64(subject) + "?=", "Date: " + new Date().toUTCString().replace("GMT", "+0000"),
      "Message-ID: <" + crypto.randomBytes(12).toString("hex") + "@" + MAIL.user.split("@")[1] + ">",
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
      b64(text).match(/.{1,76}/g).join("\r\n")].join("\r\n");
    const steps = [["", 220], ["EHLO " + (os.hostname() || "localhost"), 250], ["AUTH PLAIN " + Buffer.from("\0" + MAIL.user + "\0" + MAIL.pass).toString("base64"), 235],
      ["MAIL FROM:<" + MAIL.user + ">", 250], ["RCPT TO:<" + to + ">", 250], ["DATA", 354], [msg + "\r\n.", 250], ["QUIT", 221]];
    let i = 0, buf = "", done = false;
    const end = e => { if (done) return; done = true; try { sock.end(); } catch (x) {} e ? ko(e) : ok(); };
    const sock = tls.connect({ host: MAIL.host, port: MAIL.port, servername: MAIL.host, rejectUnauthorized: process.env.MAIL_INSECURE !== "1" });
    sock.setTimeout(20e3, () => end(new Error("délai SMTP dépassé")));
    sock.on("error", end);
    sock.on("data", d => {
      buf += d.toString("utf8");
      let m; while ((m = buf.match(/^(\d{3})([ -])(.*)\r?\n/m)) && buf.indexOf(m[0]) === 0) {
        buf = buf.slice(m[0].length); if (m[2] === "-") continue;
        const code = +m[1];
        if (code !== steps[i][1]) return end(new Error("SMTP " + code + " " + m[3].slice(0, 120)));
        i++; if (i >= steps.length) return end();
        sock.write(steps[i][0] + "\r\n");
      }
    });
  });
}

/* ---------- Tables ---------- */
// _tables/<tid> = { name, code, mjs, mjh, open, locked, created }
// Données d'une table : T/<tid>/_auth/<slug>, T/<tid>/_log, T/<tid>/players/..., T/<tid>/table/..., T/<tid>/data/users/...
const tableIds = () => keysWith("_tables/").map(k => k.slice(8));
const tab = tid => store["_tables/" + tid];
const NS = tid => "T/" + tid + "/";
function newTid(name) { let base = slug(name).replace(/-+$/, "") || "table", id = base, n = 2; while (tab(id)) id = base + "-" + n++; return id; }
function setMj(t, code) { t.mjs = crypto.randomBytes(16).toString("hex"); t.mjh = hashPin(code, t.mjs); }
const mjCache = new Map();
function checkMj(tid, code) {
  const t = tab(tid); if (!t || !code) return false;
  const k = tid + "\0" + crypto.createHash("sha256").update(String(code)).digest("hex");
  if (mjCache.get(k) === t.mjh) return true;
  const ok = same(hashPin(code, t.mjs), t.mjh); if (ok) mjCache.set(k, t.mjh); return ok;
}
function findTable(code) {
  if (!code) return null; let hit = null;
  for (const tid of tableIds()) if (same(String(code).trim(), tab(tid).code)) hit = tid;
  return hit;
}
const codeTaken = (code, except) => tableIds().some(tid => tid !== except && tab(tid).code.toLowerCase() === String(code).trim().toLowerCase());

/* Migration : ancienne base à une seule table -> table « principale » */
(function migrate() {
  if (tableIds().length) return;
  const legacy = Object.keys(store).filter(k => !k.startsWith("_site") && !k.startsWith("T/") && !k.startsWith("_tables/"));
  if (legacy.length) { try { fs.writeFileSync(path.join(BK_DIR, "avant-multitables-" + Date.now() + ".json"), JSON.stringify(store)); } catch (e) { console.error("Sauvegarde avant migration impossible :", e.message); process.exit(1); } }
  const old = store["_cfg"] || {};
  const code = (typeof old.tableCode === "string" && old.tableCode) || CFG.tableCode || randCode(8).toLowerCase();
  const t = { name: CFG.tableName || "Les copains", code, open: old.open !== false, created: Date.now() };
  setMj(t, old.mjCode || CFG.mjCode);
  const tid = "principale"; store["_tables/" + tid] = t;
  for (const k of legacy) { if (k === "_cfg") { delete store[k]; continue; } store[NS(tid) + k] = store[k]; delete store[k]; }
  persist(); console.log("Base convertie en multi-tables (" + legacy.length + " documents dans la table « " + t.name + " »).");
})();

/* ---------- Journal (par table, et journal du site) ---------- */
function pushLog(key, e) { const l = store[key] || (store[key] = []); l.push(e); while (l.length > 300) l.shift(); persist(); }
function log(tid, ev, who, ip) { pushLog(NS(tid) + "_log", { t: Date.now(), ev, who: who || "", ip: ip || "" }); }
function slog(ev, who, ip) { pushLog("_site/log", { t: Date.now(), ev, who: who || "", ip: ip || "" }); }

/* ---------- Comptes joueurs (propres à chaque table) ---------- */
const rec = (tid, sl) => store[NS(tid) + "_auth/" + sl];
function setPin(r, pin, tmp) { r.s = crypto.randomBytes(16).toString("hex"); r.h = hashPin(pin, r.s); if (tmp) r.tmp = true; else delete r.tmp; okCache.clear(); }
function newRecovery(r) { const c = randCode(12); r.rs = crypto.randomBytes(16).toString("hex"); r.rh = hashPin(c, r.rs); return fmtRec(c); }
const okCache = new Map();
function checkPin(tid, sl, pin) {
  const r = rec(tid, sl); if (!r || !pin) return false;
  const k = tid + "\0" + sl + "\0" + crypto.createHash("sha256").update(String(pin)).digest("hex");
  if (okCache.get(k) === r.h) return true;
  const ok = same(hashPin(pin, r.s), r.h); if (ok) okCache.set(k, r.h); return ok;
}
function seen(tid, sl) { const r = rec(tid, sl); if (!r) return; const now = Date.now(); if (!r.last || now - r.last > 5 * 60e3) { r.last = now; persist(); } else r.last = now; }
function who(req, q) {
  const h = k => req.headers[k] || (q && q.get(k.replace("x-", ""))) || "";
  const tid = findTable(h("x-table")); if (!tid || tab(tid).locked) return null;
  const sl = slug(dec(h("x-player"))), pin = h("x-pin"), mj = h("x-mj");
  if (!NAME.test(sl) || !checkPin(tid, sl, pin)) return null;
  const r = rec(tid, sl); if (r.locked) return null;
  seen(tid, sl);
  return { tid, sl, pid: "p_" + sl, mj: !!mj && checkMj(tid, mj), tmp: !!r.tmp };
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
const mailCodes = new Map(); // tid\0slug -> { h, s, exp, tries, sent: [] }

/* ---------- Anti force brute ---------- */
const fails = new Map();
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60e3; }
function fail(ip, tid, why, name) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60e3) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); if (why) tid ? log(tid, why, name, ip) : slog(why, name, ip); }
function clientIp(req) {
  const r = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const cf = req.headers["cf-connecting-ip"];
  return (r === "127.0.0.1" || r === "::1") && cf ? String(cf).slice(0, 45) : r;
}

/* ---------- Adresse publique du tunnel (lue dans data/tunnel.log) ---------- */
let tunnelCache = { t: 0, u: "" };
function tunnelUrl() {
  if (Date.now() - tunnelCache.t < 10e3) return tunnelCache.u;
  let u = "";
  try { const m = fs.readFileSync(path.join(DATA_DIR, "tunnel.log"), "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g); if (m) u = m[m.length - 1]; } catch (e) {}
  tunnelCache = { t: Date.now(), u }; return u;
}

/* ---------- Temps réel (Server-Sent Events, par table) ---------- */
const clients = new Map(); // res -> { tid, sl }
function broadcast(tid, p) { for (const [c, x] of clients) if (x.tid === tid) { try { c.write("data: " + p + "\n\n"); } catch (e) {} } }
function kick(tid, sl) { for (const [c, x] of clients) if (x.tid === tid && (!sl || x.sl === sl)) { try { c.end(); } catch (e) {} clients.delete(c); } }
setInterval(() => { for (const c of clients.keys()) { try { c.write(": ping\n\n"); } catch (e) {} } }, 25e3);
const onlineSet = tid => new Set([...clients.values()].filter(x => x.tid === tid).map(x => x.sl));

/* ---------- Opérations communes (MJ d'une table et admin du site) ---------- */
function charsOf(tid, pid) {
  const pre = NS(tid) + "players/" + pid + "/chars/";
  return keysWith(pre).filter(x => !x.slice(pre.length).includes("/")).map(x => { const c = store[x] || {}; return { id: x.slice(pre.length), name: c.name || "Sans nom", classe: c.classe || "", level: c.level || 1, updatedAt: c.updatedAt || 0 }; });
}
function accounts(tid) {
  const online = onlineSet(tid), pre = NS(tid) + "_auth/";
  return keysWith(pre).map(k => {
    const sl = k.slice(pre.length), r = store[k];
    return { slug: sl, name: r.n, email: r.e || "", created: r.t || 0, last: r.last || 0, tmp: !!r.tmp, locked: !!r.locked, recovery: !!r.rh, online: online.has(sl), chars: charsOf(tid, "p_" + sl) };
  }).sort((a, b) => (b.last || b.created) - (a.last || a.created));
}
function orphans(tid) {
  const pre = NS(tid) + "players/";
  const pids = new Set(keysWith(pre).map(k => k.slice(pre.length).split("/")[0]));
  return [...pids].filter(pid => !(pid.startsWith("p_") && rec(tid, pid.slice(2)))).map(pid => ({ pid, chars: charsOf(tid, pid) }));
}
const userKeys = (tid, pid) => keysWith(NS(tid)).filter(k => { const s = k.slice(NS(tid).length); return s === "players/" + pid || s.startsWith("players/" + pid + "/") || s === "data/users/" + pid || s.startsWith("data/users/" + pid + "/"); });
// Renvoie [code HTTP, objet]
function accountOp(tid, op, q, b, actor, ip, self) {
  const sl = slug(q.get("name")), r = rec(tid, sl);
  const need = () => r ? null : [404, { error: "Joueur inconnu." }];
  switch (op) {
    case "reset": { if (!r) return need(); const tmp = randCode(6); setPin(r, tmp, true); kick(tid, sl); persist(); log(tid, "Code provisoire créé par " + actor, r.n, ip); return [200, { ok: true, temp: tmp }]; }
    case "lock": { if (!r) return need(); if (sl === self) return [400, { error: "Vous ne pouvez pas bloquer votre propre compte." }]; r.locked = !r.locked; okCache.clear(); if (r.locked) kick(tid, sl); persist(); log(tid, (r.locked ? "Compte bloqué par " : "Compte débloqué par ") + actor, r.n, ip); return [200, { ok: true, locked: r.locked }]; }
    case "email": { if (!r) return need(); const em = String(b.email || "").trim().toLowerCase(); if (em && !EMAIL.test(em)) return [400, { error: "Adresse mail invalide." }]; if (em) r.e = em; else delete r.e; persist(); log(tid, "Adresse mail modifiée par " + actor, r.n, ip); return [200, { ok: true }]; }
    case "delete": {
      if (!r) return need(); if (sl === self) return [400, { error: "Vous ne pouvez pas supprimer votre propre compte." }];
      if (slug(b.confirm) !== sl) return [400, { error: "Tapez le nom du joueur pour confirmer." }];
      const ks = userKeys(tid, "p_" + sl); ks.forEach(k => { delete store[k]; broadcast(tid, k.slice(NS(tid).length)); }); delete store[NS(tid) + "_auth/" + sl]; okCache.clear(); kick(tid, sl); persist();
      log(tid, "Compte supprimé par " + actor + " (" + ks.length + " documents)", r.n, ip); return [200, { ok: true }];
    }
    case "purge": { const pid = String(q.get("pid") || ""); if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid) || (pid.startsWith("p_") && rec(tid, pid.slice(2)))) return [400, { error: "Dossier invalide." }]; const ks = userKeys(tid, pid); ks.forEach(k => { delete store[k]; broadcast(tid, k.slice(NS(tid).length)); }); persist(); log(tid, "Fiches orphelines supprimées par " + actor + " (" + ks.length + ")", pid, ip); return [200, { ok: true }]; }
    case "movechar": {
      const from = String(q.get("from") || ""), id = String(q.get("id") || ""), to = slug(q.get("to")), dtid = q.get("totable") || tid;
      if (!SEG.test(from) || !SEG.test(id) || !tab(dtid)) return [400, { error: "Requête invalide." }];
      if (!rec(dtid, to)) return [404, { error: "Joueur destinataire inconnu." }];
      const src = NS(tid) + "players/" + from + "/chars/" + id, dst = NS(dtid) + "players/p_" + to + "/chars/" + id;
      if (!store[src]) return [404, { error: "Fiche introuvable." }];
      if (src === dst) return [200, { ok: true }];
      if (store[dst]) return [409, { error: "Une fiche porte déjà cet identifiant chez ce joueur." }];
      const c = store[src]; if (c && typeof c === "object") c.owner = "p_" + to;
      store[dst] = c; delete store[src]; store[NS(dtid) + "players/p_" + to] = Object.assign({}, store[NS(dtid) + "players/p_" + to], { updatedAt: Date.now() });
      persist(); broadcast(tid, src.slice(NS(tid).length)); broadcast(dtid, dst.slice(NS(dtid).length)); broadcast(dtid, "players/p_" + to);
      const where = dtid === tid ? "" : " (table " + tab(dtid).name + ")";
      log(tid, "Fiche « " + ((c && c.name) || id) + " » transférée à " + rec(dtid, to).n + where + " par " + actor, from, ip);
      if (dtid !== tid) log(dtid, "Fiche « " + ((c && c.name) || id) + " » reçue de la table " + tab(tid).name + " par " + actor, rec(dtid, to).n, ip);
      return [200, { ok: true }];
    }
    case "delchar": { const from = String(q.get("from") || ""), id = String(q.get("id") || ""); if (!SEG.test(from) || !SEG.test(id)) return [400, { error: "Requête invalide." }]; const k = NS(tid) + "players/" + from + "/chars/" + id; const c = store[k]; if (!c) return [404, { error: "Fiche introuvable." }]; delete store[k]; persist(); broadcast(tid, "players/" + from + "/chars/" + id); log(tid, "Fiche « " + (c.name || id) + " » supprimée par " + actor, from, ip); return [200, { ok: true }]; }
    case "clearlog": store[NS(tid) + "_log"] = []; log(tid, "Journal vidé par " + actor, "", ip); return [200, { ok: true }];
  }
  return null;
}
function tableSettings(tid, b, actor, ip) {
  const t = tab(tid);
  if (typeof b.name === "string") { const n = b.name.trim().slice(0, 40); if (n.length < 2) return [400, { error: "Nom de table : 2 caractères minimum." }]; t.name = n; }
  if (typeof b.open === "boolean") { t.open = b.open; log(tid, (b.open ? "Inscriptions ouvertes par " : "Inscriptions fermées par ") + actor, "", ip); }
  if (typeof b.locked === "boolean") { t.locked = b.locked; if (b.locked) kick(tid); log(tid, (b.locked ? "Table suspendue par " : "Table réactivée par ") + actor, "", ip); }
  if (typeof b.code === "string") { const c = b.code.trim(); if (!okCode(c)) return [400, { error: "Code de table : 4 à 64 caractères." }]; if (codeTaken(c, tid)) return [409, { error: "Ce code est déjà utilisé par une autre table." }]; t.code = c; log(tid, "Code de table modifié par " + actor, "", ip); }
  if (typeof b.mjCode === "string") { if (b.mjCode.length < 8 || b.mjCode.length > 64) return [400, { error: "Code MJ : 8 caractères minimum." }]; if (b.mjCode !== b.mjCode2) return [400, { error: "Les deux codes MJ ne correspondent pas." }]; setMj(t, b.mjCode); mjCache.clear(); log(tid, "Code MJ modifié par " + actor, "", ip); }
  persist(); return [200, { ok: true }];
}

/* ---------- Admin d'une table (MJ) ---------- */
async function tableAdmin(req, res, u, w, ip) {
  if (!w.mj) return send(res, 403, { error: "Réservé au MJ." });
  const op = u.pathname.slice(11), tid = w.tid, t = tab(tid), me = rec(tid, w.sl).n;
  if (op === "overview" && req.method === "GET") {
    const bks = fs.readdirSync(BK_DIR).filter(f => f.startsWith("db-")).sort().reverse();
    return send(res, 200, { accounts: accounts(tid), orphans: orphans(tid), settings: { tableCode: t.code, open: t.open !== false, name: t.name }, mail: mailOn() ? MAIL.user : "", log: (store[NS(tid) + "_log"] || []).slice(-120).reverse(), backups: bks, online: onlineSet(tid).size, me: w.sl });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Méthode non permise." });
  const b = (await body(req).catch(() => null)) || {};
  if (op === "settings") { const x = { name: b.name, open: b.open, code: b.tableCode, mjCode: b.mjCode, mjCode2: b.mjCode2 }; const r = tableSettings(tid, x, "le MJ " + me, ip); return send(res, r[0], r[1]); }
  if (op === "movechar" && u.searchParams.get("totable")) return send(res, 403, { error: "Seul l’admin du site peut déplacer une fiche vers une autre table." });
  const r = accountOp(tid, op, u.searchParams, b, "le MJ " + me, ip, w.sl);
  return r ? send(res, r[0], r[1]) : send(res, 404, { error: "Introuvable." });
}

/* ---------- Admin du site ---------- */
const sessions = new Map(); // jeton -> { exp, ip }
const adminSet = () => !!(store["_site/admin"] && store["_site/admin"].h);
function adminOk(req) { const tk = String(req.headers["x-admin"] || ""); const s = tk && sessions.get(tk); if (!s || Date.now() > s.exp) { if (s) sessions.delete(tk); return false; } s.exp = Date.now() + 12 * 3600e3; return true; }
function siteOverview() {
  const tables = tableIds().map(tid => {
    const t = tab(tid), acc = accounts(tid), orph = orphans(tid);
    const last = Math.max(0, ...acc.map(a => a.last || 0));
    return { tid, name: t.name, code: t.code, open: t.open !== false, locked: !!t.locked, created: t.created || 0, last, online: acc.filter(a => a.online).length, accounts: acc, orphans: orph, nchars: acc.reduce((n, a) => n + a.chars.length, 0) + orph.reduce((n, o) => n + o.chars.length, 0) };
  }).sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
  const logs = [];
  for (const tid of tableIds()) for (const l of store[NS(tid) + "_log"] || []) logs.push(Object.assign({ table: tab(tid).name }, l));
  for (const l of store["_site/log"] || []) logs.push(Object.assign({ table: "Site" }, l));
  logs.sort((a, b) => b.t - a.t);
  let size = 0; try { size = fs.statSync(DB_FILE).size; } catch (e) {}
  const bks = fs.readdirSync(BK_DIR).filter(f => f.startsWith("db-")).sort().reverse();
  return { tables, log: logs.slice(0, 250), backups: bks, dbSize: size, mail: mailOn() ? MAIL.user : "", online: clients.size, uptime: Math.round(process.uptime()), node: process.version, sessions: sessions.size };
}
async function siteAdmin(req, res, u, ip) {
  const op = u.pathname.slice(10);
  if (op === "status") return send(res, 200, { setup: adminSet() });
  if (req.method !== "POST" && op !== "overview" && op !== "export") return send(res, 405, { error: "Méthode non permise." });
  if (tooMany(ip)) return send(res, 429, { error: "Trop d’essais, réessayez dans 10 minutes." });
  if (op === "setup") {
    const b = (await body(req).catch(() => null)) || {};
    if (adminSet()) return send(res, 409, { error: "Le mot de passe admin est déjà défini." });
    if (!same(String(b.setup || ""), CFG.mjCode)) { fail(ip, null, "Mise en place admin refusée (mauvais code)", "", ip); return send(res, 401, { error: "Code de mise en place incorrect. C’est le mjCode écrit dans config.json." }); }
    if (typeof b.pass !== "string" || b.pass.length < 10 || b.pass.length > 128) return send(res, 400, { error: "Mot de passe admin : 10 caractères minimum." });
    if (b.pass !== b.pass2) return send(res, 400, { error: "Les deux mots de passe ne correspondent pas." });
    const s = crypto.randomBytes(16).toString("hex"); store["_site/admin"] = { s, h: hashPin(b.pass, s), t: Date.now() }; persist(); slog("Mot de passe admin créé", "admin", ip);
    const tk = crypto.randomBytes(32).toString("hex"); sessions.set(tk, { exp: Date.now() + 12 * 3600e3, ip }); return send(res, 200, { ok: true, token: tk });
  }
  if (op === "login") {
    const b = (await body(req).catch(() => null)) || {}, a = store["_site/admin"];
    if (!a || !a.h) return send(res, 409, { error: "Mot de passe admin pas encore créé." });
    if (typeof b.pass !== "string" || !same(hashPin(b.pass, a.s), a.h)) { fail(ip, null, "Connexion admin refusée", "admin", ip); return send(res, 401, { error: "Mot de passe incorrect." }); }
    const tk = crypto.randomBytes(32).toString("hex"); sessions.set(tk, { exp: Date.now() + 12 * 3600e3, ip }); slog("Connexion admin", "admin", ip); return send(res, 200, { ok: true, token: tk });
  }
  if (!adminOk(req)) { fail(ip); return send(res, 401, { error: "Session admin expirée. Reconnectez-vous." }); }
  if (op === "logout") { sessions.delete(String(req.headers["x-admin"])); return send(res, 200, { ok: true }); }
  if (op === "overview") return send(res, 200, siteOverview());
  if (op === "export") {
    const tid = u.searchParams.get("table"); if (!tab(tid)) return send(res, 404, { error: "Table inconnue." });
    const pre = NS(tid) + "players/", chars = keysWith(pre).filter(k => /\/chars\/[^/]+$/.test(k)).map(k => Object.assign({ id: k.split("/").pop(), owner: k.slice(pre.length).split("/")[0] }, store[k]));
    slog("Export des fiches de " + tab(tid).name, "admin", ip);
    return send(res, 200, { table: tab(tid).name, exportedAt: new Date().toISOString(), chars });
  }
  const b = (await body(req).catch(() => null)) || {}, q = u.searchParams, tid = q.get("table");
  switch (op) {
    case "password": {
      const a = store["_site/admin"];
      if (typeof b.old !== "string" || !same(hashPin(b.old, a.s), a.h)) return send(res, 401, { error: "Mot de passe actuel incorrect." });
      if (typeof b.pass !== "string" || b.pass.length < 10) return send(res, 400, { error: "Nouveau mot de passe : 10 caractères minimum." });
      if (b.pass !== b.pass2) return send(res, 400, { error: "Les deux mots de passe ne correspondent pas." });
      a.s = crypto.randomBytes(16).toString("hex"); a.h = hashPin(b.pass, a.s); const keep = String(req.headers["x-admin"]); for (const k of sessions.keys()) if (k !== keep) sessions.delete(k);
      persist(); slog("Mot de passe admin modifié", "admin", ip); return send(res, 200, { ok: true });
    }
    case "logoutall": { sessions.clear(); slog("Toutes les sessions admin fermées", "admin", ip); return send(res, 200, { ok: true }); }
    case "clearlog": { store["_site/log"] = []; slog("Journal du site vidé", "admin", ip); return send(res, 200, { ok: true }); }
    case "createtable": {
      const name = String(b.name || "").trim().slice(0, 40), code = String(b.code || "").trim();
      if (name.length < 2) return send(res, 400, { error: "Nom de table : 2 caractères minimum." });
      if (!okCode(code)) return send(res, 400, { error: "Code de table : 4 à 64 caractères." });
      if (codeTaken(code)) return send(res, 409, { error: "Ce code est déjà utilisé par une autre table." });
      if (typeof b.mjCode !== "string" || b.mjCode.length < 8) return send(res, 400, { error: "Code MJ : 8 caractères minimum." });
      if (b.mjCode !== b.mjCode2) return send(res, 400, { error: "Les deux codes MJ ne correspondent pas." });
      const id = newTid(name), t = { name, code, open: true, created: Date.now() }; setMj(t, b.mjCode); store["_tables/" + id] = t; persist();
      slog("Table « " + name + " » créée", "admin", ip); log(id, "Table créée par l’admin", "", ip); return send(res, 200, { ok: true, tid: id });
    }
    case "deletetable": {
      const t = tab(tid); if (!t) return send(res, 404, { error: "Table inconnue." });
      if (String(b.confirm || "").trim().toLowerCase() !== t.name.toLowerCase()) return send(res, 400, { error: "Tapez le nom exact de la table pour confirmer." });
      if (tableIds().length < 2) return send(res, 400, { error: "Impossible de supprimer la dernière table." });
      try { const snap = {}; keysWith(NS(tid)).forEach(k => snap[k] = store[k]); snap["_tables/" + tid] = t; fs.writeFileSync(path.join(BK_DIR, "table-supprimee-" + tid + "-" + Date.now() + ".json"), JSON.stringify(snap)); } catch (e) { return send(res, 500, { error: "Sauvegarde avant suppression impossible." }); }
      kick(tid); const n = keysWith(NS(tid)).length; keysWith(NS(tid)).forEach(k => delete store[k]); delete store["_tables/" + tid]; okCache.clear(); mjCache.clear(); persist();
      slog("Table « " + t.name + " » supprimée (" + n + " documents, copie dans sauvegardes)", "admin", ip); return send(res, 200, { ok: true });
    }
    case "tablesettings": { if (!tab(tid)) return send(res, 404, { error: "Table inconnue." }); const r = tableSettings(tid, b, "l’admin", ip); if (r[0] === 200) slog("Réglages de la table « " + tab(tid).name + " » modifiés", "admin", ip); return send(res, r[0], r[1]); }
  }
  if (!tab(tid)) return send(res, 404, { error: "Table inconnue." });
  const r = accountOp(tid, op, q, b, "l’admin", ip, null);
  return r ? send(res, r[0], r[1]) : send(res, 404, { error: "Introuvable." });
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
  const ip = clientIp(req);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  try {
    if (u.pathname.startsWith("/api/site/")) return siteAdmin(req, res, u, ip);
    if (u.pathname.startsWith("/api/")) {
      const H = k => req.headers[k] || "";
      if (u.pathname === "/api/ping") { const tid = findTable(H("x-table")); return send(res, 200, { ok: true, needTable: true, open: tid ? tab(tid).open !== false : true, table: tid ? tab(tid).name : "", publicUrl: tunnelUrl(), mail: mailOn(), v: 4 }); }
      if (tooMany(ip)) return send(res, 429, { error: "Trop d’essais, réessayez dans 10 minutes." });

      /* Connexion et création de compte */
      if (u.pathname === "/api/login") {
        const mjc = H("x-mj"), pin = String(H("x-pin")), raw = dec(H("x-player")).trim(), mode = H("x-mode") || "login";
        const tid = findTable(H("x-table"));
        if (!tid) { fail(ip, null, "Code de table incorrect", raw, ip); return send(res, 401, { error: "Code de table incorrect." }); }
        const t = tab(tid); if (t.locked) return send(res, 403, { error: "Cette table est suspendue. Contactez l’administrateur." });
        const sl = slug(raw);
        if (!NAME.test(sl)) return send(res, 400, { error: "Nom de joueur : 2 à 20 lettres ou chiffres." });
        if (!okPin(pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        let r = rec(tid, sl), recovery = "";
        if (mode === "create") {
          if (r) return send(res, 409, { error: "Ce nom est déjà pris. Choisissez-en un autre ou connectez-vous." });
          if (t.open === false && !(mjc && checkMj(tid, mjc))) return send(res, 403, { error: "Les inscriptions sont fermées. Demandez au MJ de les ouvrir." });
          if (mjc && !checkMj(tid, mjc)) { fail(ip, tid, "Code MJ incorrect", raw, ip); return send(res, 401, { error: "Code MJ incorrect." }); }
          const em = dec(H("x-email")).trim().toLowerCase();
          if (em && !EMAIL.test(em)) return send(res, 400, { error: "Adresse mail invalide." });
          r = store[NS(tid) + "_auth/" + sl] = { n: raw.slice(0, 30), t: Date.now() }; if (em) r.e = em; setPin(r, pin); recovery = newRecovery(r); r.last = Date.now(); persist(); log(tid, "Compte créé", r.n, ip);
          if (r.e && mailOn()) sendMail(r.e, "Bienvenue à la table", "Bonjour " + r.n + ",\n\nVotre compte est créé sur la table « " + t.name + " ». Cette adresse servira uniquement à vous envoyer un code si vous oubliez votre mot de passe.\n\nVotre code de récupération de secours : " + recovery + "\n\nLa Table Daggerheart").catch(e => log(tid, "Échec d’envoi du mail : " + e.message, r.n, ip));
        } else {
          if (!r) { fail(ip); return send(res, 404, { error: "Aucun compte à ce nom sur cette table. Vérifiez l’orthographe ou créez un compte." }); }
          if (!checkPin(tid, sl, pin)) { fail(ip, tid, "Mauvais mot de passe", r.n, ip); return send(res, 401, { error: "Mot de passe incorrect." }); }
          if (r.locked) { log(tid, "Connexion refusée (compte bloqué)", r.n, ip); return send(res, 403, { error: "Ce compte est bloqué. Contactez le MJ." }); }
          if (mjc && !checkMj(tid, mjc)) { fail(ip, tid, "Code MJ incorrect", r.n, ip); return send(res, 401, { error: "Code MJ incorrect." }); }
          if (!r.last || Date.now() - r.last > 30 * 60e3) log(tid, mjc ? "Connexion MJ" : "Connexion", r.n, ip);
          r.last = Date.now(); persist();
        }
        return send(res, 200, { ok: true, mj: !!mjc, pid: "p_" + sl, name: r.n, table: t.name, created: mode === "create", recovery, mustChange: !!r.tmp, hasRecovery: !!r.rh, email: r.e || "" });
      }

      /* Mot de passe oublié : code de récupération */
      if (u.pathname === "/api/recover" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {}, tid = findTable(H("x-table"));
        if (!tid) { fail(ip, null, "Code de table incorrect", b.name, ip); return send(res, 401, { error: "Code de table incorrect." }); }
        const sl = slug(b.name), r = rec(tid, sl), c = normRec(b.code);
        if (!r || !r.rh || c.length !== 12 || !same(hashPin(c, r.rs), r.rh)) { fail(ip, tid, "Récupération échouée", b.name, ip); return send(res, 401, { error: "Nom ou code de récupération incorrect." }); }
        if (r.locked) return send(res, 403, { error: "Ce compte est bloqué. Contactez le MJ." });
        if (!okPin(b.pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        setPin(r, b.pin); const recovery = newRecovery(r); kick(tid, sl); persist(); log(tid, "Mot de passe récupéré", r.n, ip);
        return send(res, 200, { ok: true, name: r.n, recovery });
      }

      /* Mot de passe oublié : code à 6 chiffres envoyé par mail */
      if (u.pathname === "/api/forgot" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {}, tid = findTable(H("x-table"));
        if (!tid) { fail(ip, null, "Code de table incorrect", b.name, ip); return send(res, 401, { error: "Code de table incorrect." }); }
        if (!mailOn()) return send(res, 503, { error: "L’envoi de mails n’est pas configuré sur ce serveur." });
        const sl = slug(b.name), r = rec(tid, sl), generic = { ok: true, message: "Si ce compte a une adresse mail, un code vient d’y être envoyé. Pensez à regarder les spams." };
        fail(ip);
        if (!r || !r.e || r.locked) { log(tid, "Code mail demandé (aucun envoi)", b.name, ip); return send(res, 200, generic); }
        const mk = tid + "\0" + sl, m = mailCodes.get(mk) || { sent: [] }; m.sent = m.sent.filter(t => Date.now() - t < 3600e3);
        if (m.sent.length && Date.now() - m.sent[m.sent.length - 1] < 60e3) return send(res, 429, { error: "Un code vient d’être envoyé. Attendez une minute avant d’en redemander un." });
        if (m.sent.length >= 5) return send(res, 429, { error: "Trop de codes demandés. Réessayez dans une heure ou demandez au MJ." });
        const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0"); m.s = crypto.randomBytes(16).toString("hex"); m.h = hashPin(code, m.s); m.exp = Date.now() + 15 * 60e3; m.tries = 0; m.sent.push(Date.now()); mailCodes.set(mk, m);
        try {
          await sendMail(r.e, "Votre code : " + code, "Bonjour " + r.n + ",\n\nVoici votre code pour changer votre mot de passe sur la table « " + tab(tid).name + " » :\n\n    " + code + "\n\nIl est valable 15 minutes. Si vous n’avez rien demandé, ignorez ce message : votre mot de passe actuel reste valable.\n\nLa Table Daggerheart");
          log(tid, "Code envoyé par mail", r.n, ip);
        } catch (e) { m.sent.pop(); delete m.h; log(tid, "Échec d’envoi du mail : " + e.message, r.n, ip); console.error("Mail :", e.message); return send(res, 502, { error: "L’envoi du mail a échoué. Réessayez plus tard ou demandez au MJ." }); }
        return send(res, 200, generic);
      }
      if (u.pathname === "/api/forgot/confirm" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {}, tid = findTable(H("x-table"));
        if (!tid) { fail(ip); return send(res, 401, { error: "Code de table incorrect." }); }
        const sl = slug(b.name), r = rec(tid, sl), m = mailCodes.get(tid + "\0" + sl), code = String(b.code || "").replace(/\D/g, "");
        if (!r || !m || !m.h || Date.now() > m.exp) { fail(ip); return send(res, 401, { error: "Code expiré ou invalide. Demandez-en un nouveau." }); }
        if (r.locked) return send(res, 403, { error: "Ce compte est bloqué. Contactez le MJ." });
        if (code.length !== 6 || !same(hashPin(code, m.s), m.h)) { m.tries++; fail(ip, tid, "Code mail incorrect", r.n, ip); if (m.tries >= 5) delete m.h; return send(res, 401, { error: m.h ? "Code incorrect." : "Trop d’erreurs. Demandez un nouveau code." }); }
        if (!okPin(b.pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        delete m.h; setPin(r, b.pin); kick(tid, sl); persist(); log(tid, "Mot de passe changé par code mail", r.n, ip);
        return send(res, 200, { ok: true, name: r.n });
      }

      const w = who(req, u.pathname === "/api/events" ? u.searchParams : null);
      if (!w) { fail(ip); return send(res, 401, { error: "Non autorisé." }); }
      const ns = NS(w.tid);

      /* Mon compte */
      if (u.pathname === "/api/account/pin" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {};
        if (!okPin(b.pin)) return send(res, 400, { error: "Mot de passe : 4 caractères minimum." });
        const r = rec(w.tid, w.sl); setPin(r, b.pin); const recovery = r.rh ? "" : newRecovery(r);
        persist(); log(w.tid, w.tmp ? "Mot de passe choisi après code provisoire" : "Mot de passe modifié", r.n, ip);
        return send(res, 200, { ok: true, recovery });
      }
      if (u.pathname === "/api/account/email" && req.method === "POST") {
        const b = (await body(req).catch(() => null)) || {}, r = rec(w.tid, w.sl), em = String(b.email || "").trim().toLowerCase();
        if (em && !EMAIL.test(em)) return send(res, 400, { error: "Adresse mail invalide." });
        if (em && mailOn()) { try { await sendMail(em, "Adresse enregistrée", "Bonjour " + r.n + ",\n\nCette adresse est maintenant liée à votre compte sur la table « " + tab(w.tid).name + " ». Elle servira uniquement à vous envoyer un code si vous oubliez votre mot de passe.\n\nLa Table Daggerheart"); } catch (e) { log(w.tid, "Échec d’envoi du mail : " + e.message, r.n, ip); return send(res, 502, { error: "Impossible d’envoyer un mail à cette adresse. Vérifiez-la." }); } }
        if (em) r.e = em; else delete r.e; persist(); log(w.tid, em ? "Adresse mail enregistrée" : "Adresse mail retirée", r.n, ip);
        return send(res, 200, { ok: true, email: r.e || "" });
      }
      if (u.pathname === "/api/account/recovery" && req.method === "POST") { const r = rec(w.tid, w.sl); const recovery = newRecovery(r); persist(); log(w.tid, "Nouveau code de récupération", r.n, ip); return send(res, 200, { ok: true, recovery }); }
      if (w.tmp) return send(res, 403, { error: "Choisissez d’abord votre nouveau mot de passe." });

      if (u.pathname.startsWith("/api/admin/")) return tableAdmin(req, res, u, w, ip);
      if (u.pathname === "/api/resetpin" && req.method === "POST") return tableAdmin(req, res, new URL("/api/admin/reset?" + u.searchParams, "http://x"), w, ip);
      if (u.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\n\n");
        clients.set(res, { tid: w.tid, sl: w.sl }); req.on("close", () => clients.delete(res));
        return;
      }
      const p = u.searchParams.get("p") || "";
      if (!validPath(p)) return send(res, 400, { error: "Chemin invalide." });
      if (u.pathname === "/api/doc") {
        if (req.method === "GET") { if (!canRead(p, w)) return send(res, 200, { exists: false }); return send(res, 200, store[ns + p] === undefined ? { exists: false } : { exists: true, data: store[ns + p] }); }
        if (!canWrite(p, w)) return send(res, 403, { error: "Accès refusé." });
        if (req.method === "PUT") { const d = await body(req); if (!d || typeof d !== "object" || Array.isArray(d)) return send(res, 400, { error: "Document invalide." }); store[ns + p] = d; persist(); broadcast(w.tid, p); return send(res, 200, { ok: true }); }
        if (req.method === "DELETE") { delete store[ns + p]; persist(); broadcast(w.tid, p); return send(res, 200, { ok: true }); }
        return send(res, 405, { error: "Méthode non permise." });
      }
      if (u.pathname === "/api/col" && req.method === "GET") {
        if (!canRead(p, w)) return send(res, 200, []);
        const pre = ns + p + "/", out = [];
        for (const k of keysWith(pre)) if (!k.slice(pre.length).includes("/")) { const id = k.slice(pre.length); if (canRead(p + "/" + id, w)) out.push({ id, data: store[k] }); }
        return send(res, 200, out);
      }
      return send(res, 404, { error: "Introuvable." });
    }
    // Fichiers statiques
    let f = decodeURIComponent(u.pathname); if (f === "/") f = "/index.html"; if (f === "/admin" || f === "/admin/") f = "/admin.html";
    const fp = path.normalize(path.join(ROOT, "public", f));
    if (!fp.startsWith(path.join(ROOT, "public")) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("Introuvable"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream", "Cache-Control": /\.html$|sw\.js$/.test(f) ? "no-cache" : "public, max-age=3600" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: "Erreur serveur." }); }
});
server.listen(CFG.port, () => console.log("Table Daggerheart en ligne sur le port " + CFG.port + " : " + tableIds().length + " table(s)" + (mailOn() ? ", mails via " + MAIL.user : ", mails désactivés")));
