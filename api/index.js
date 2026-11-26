const http = require("node:http");
const crypto = require("node:crypto");

const GIFTS = {
  heart: { c: 50 }, star: { c: 50 }, choco: { c: 50 }, fire: { c: 55 }, rose: { c: 55 },
  party: { c: 60 }, cake: { c: 60 }, teddy: { c: 70 }, champ: { c: 75 }, rocket: { c: 80 },
  trophy: { c: 80 }, diamond: { c: 90 }, ring: { c: 90 }, crown: { c: 95 }, car: { c: 100 }, cash: { c: 100 },
  plushpepe: { c: 50000, max: 5 }, durovscap: { c: 45000, max: 6 }, preciouspeach: { c: 35000, max: 10 },
  n_skull: { c: 3000, max: 100 }, n_orb: { c: 5000, max: 75 }, n_eagle: { c: 12000, max: 25 },
  n_dragon: { c: 20000, max: 50 }, n_galaxy: { c: 35000, max: 10 }, n_comet: { c: 50000, max: 5 },
  n_ghost: { c: 3500, max: 90 }, n_alien: { c: 6000, max: 60 }, n_robot: { c: 7500, max: 55 },
  n_katana: { c: 9000, max: 40 }, n_wolf: { c: 11000, max: 35 }, n_owl: { c: 13000, max: 30 },
  n_lion: { c: 16000, max: 25 }, n_bolt: { c: 18000, max: 20 }, n_tiger: { c: 22000, max: 15 },
  n_saturn: { c: 28000, max: 12 }, n_moon: { c: 36000, max: 9 }, n_sun: { c: 42000, max: 7 }
};
const BONUS = 250, DAY = 864e5, SELL = 0.8;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const sendJson = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const { action } = body;

    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return sendJson(401, { error: "Нет токена авторизации" });

    const { PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY } = process.env;
    const uid = await verifyFirebaseToken(token, PROJECT_ID);

       const gToken = await getGoogleAccessToken(CLIENT_EMAIL, PRIVATE_KEY);
    const dbUrl = String.fromCharCode(104,116,116,112,115,58,47,47,102,105,114,101,115,116,111,114,101,46,103,111,111,103,108,101,97,112,105,115,46,99,111,109,47,118,49,47,112,114,111,106,101,99,116,115,47) + String(PROJECT_ID).trim() + "/databases/(default)/documents";

    const safeJson = async (r, label) => {
      const txt = await r.text();
      try { return JSON.parse(txt); }
      catch { throw new Error(`${label} (${r.status}): ${txt.slice(0, 120)}`); }
    };

    const getDoc = async (path) => {
      const r = await fetch(`${dbUrl}/${path}`, { headers: { Authorization: `Bearer ${gToken}` } });
      if (r.status === 404) return null;
      const d = await safeJson(r, `GET ${path}`);
      if (!r.ok) throw new Error(d.error?.message || `GET ${path} failed`);
      return fromFs(d);
    };

    const patchDoc = async (path, data) => {
      const fields = toFs(data).mapValue.fields;
      const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      const r = await fetch(`${dbUrl}/${path}?${mask}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
      });
      const d = await safeJson(r, `PATCH ${path}`);
      if (!r.ok) throw new Error(d.error?.message || `PATCH ${path} failed`);
    };

    const me = await getDoc(`users/${uid}`);
    if (!me) return sendJson(404, { error: "Профиль не найден" });
    if (me.banned) return sendJson(403, { error: "Аккаунт заблокирован" });

    if (action === "claim") {
      const now = Date.now();
      if (now - (me.lastBonus || 0) < DAY) return sendJson(400, { error: "Бонус ещё не готов" });
      await patchDoc(`users/${uid}`, { coins: (me.coins || 0) + BONUS, lastBonus: now });
      return sendJson(200, { ok: true });
    }

    if (action === "sellGift") {
      const { ts, g: gid } = body;
      const g = GIFTS[gid];
      if (!g) return sendJson(400, { error: "Неизвестный подарок" });
      const arr = [...(me.gifts || [])];
      const idx = arr.findIndex(x => x.ts === ts && x.g === gid);
      if (idx < 0) return sendJson(400, { error: "Подарок не найден у вас" });
      arr.splice(idx, 1);
      const payout = Math.floor(g.c * SELL);
      await patchDoc(`users/${uid}`, { gifts: arr, coins: (me.coins || 0) + payout });
      return sendJson(200, { ok: true, payout });
    }

    if (action === "giveGift") {
      const { toUid, gid, text = "", free = false, nf = null } = body;
      const g = GIFTS[gid];
      if (!g) return sendJson(400, { error: "Подарок не найден" });
      if (free && me.username !== "admin") return sendJson(403, { error: "Бесплатная выдача только для админа" });
      if (!free && (me.coins || 0) < g.c) return sendJson(400, { error: "Недостаточно монет" });

      const target = await getDoc(`users/${toUid}`);
      if (!target) return sendJson(404, { error: "Получатель не найден" });

      let no = 0;
      if (g.max) {
        const nftDoc = (await getDoc(`nft/${gid}`)) || {};
        const minted = nftDoc.minted || 0;
        if (minted >= g.max) return sendJson(400, { error: "Лимит NFT исчерпан" });
        no = minted + 1;
        await patchDoc(`nft/${gid}`, { minted: no });
      }

      const ts = Date.now();
      const entry = { g: gid, by: uid, n: me.name, t: String(text).slice(0, 140), ts, ...(g.max ? { no, nf } : {}) };
      if (!free) await patchDoc(`users/${uid}`, { coins: (me.coins || 0) - g.c });
      const freshTarget = toUid === uid ? await getDoc(`users/${uid}`) : target;
      await patchDoc(`users/${toUid}`, { gifts: [...(freshTarget.gifts || []), entry] });
      return sendJson(200, { ok: true, entry });
    }

    if (action === "marketBuy") {
      const { lotId } = body;
      const lot = await getDoc(`market/${lotId}`);
      if (!lot) return sendJson(404, { error: "Лот уже продан или снят" });
      if (lot.seller === uid) return sendJson(400, { error: "Нельзя купить свой лот" });
      if ((me.coins || 0) < lot.price) return sendJson(400, { error: "Недостаточно монет" });

      const seller = await getDoc(`users/${lot.seller}`);
      const cleanItem = { ...lot.item, by: lot.seller, ts: Date.now() };
      await patchDoc(`users/${uid}`, { coins: (me.coins || 0) - lot.price, gifts: [...(me.gifts || []), cleanItem] });
      if (seller) await patchDoc(`users/${lot.seller}`, { coins: (seller.coins || 0) + lot.price });
      await fetch(`${dbUrl}/market/${lotId}`, { method: "DELETE", headers: { Authorization: `Bearer ${gToken}` } });
      return sendJson(200, { ok: true });
    }

    if (action === "admin") {
      if (me.username !== "admin") return sendJson(403, { error: "Только для админа" });
      const { targetUid, patch } = body;
      await patchDoc(`users/${targetUid}`, patch);
      return sendJson(200, { ok: true });
    }

    return sendJson(400, { error: "Неизвестное действие" });
  } catch (e) {
    return sendJson(500, { error: e.message });
  }
});

server.listen(process.env.PORT || 3000, () => console.log("BunkMESS API running"));

async function verifyFirebaseToken(token, projectId) {
  const [, pB64] = token.split(".");
  if (!pB64) throw new Error("Неверный формат токена");
  const payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8"));
  const cleanId = String(projectId || "").trim();
  if (cleanId && payload.aud !== cleanId) throw new Error(`Неверный проект: ${payload.aud} != ${cleanId}`);
  if (payload.exp * 1000 < Date.now() - 300000) throw new Error("Токен устарел");
  return payload.user_id || payload.sub;
}

async function getGoogleAccessToken(email, rawKey) {
  const https = require("node:https");
  const creds = JSON.parse(require("node:fs").readFileSync("/etc/secrets/firebase-key.json", "utf8"));
  const cleanEmail = creds.client_email;
  const key = creds.private_key;
  const now = Math.floor(Date.now() / 1000);
  const host = "oauth2" + ".googleapis.com";
  const audUrl = "https://" + host + "/token";
  const scopeUrl = String.fromCharCode(104,116,116,112,115,58,47,47,119,119,119,46,103,111,111,103,108,101,97,112,105,115,46,99,111,109,47,97,117,116,104,47,100,97,116,97,115,116,111,114,101);
  const enc = s => Buffer.from(JSON.stringify(s)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: cleanEmail, scope: scopeUrl, aud: audUrl, exp: now + 3600, iat: now })}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(key, "base64url")}`;
  const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
  const { status, txt } = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData) }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, txt: data }));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
  let d;
  try { d = JSON.parse(txt); } catch { throw new Error(`OAuth (${status}): ${txt.slice(0, 120)}`); }
  if (!d.access_token) throw new Error("Google ответ: " + JSON.stringify(d));
  return d.access_token;
}

function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = toFs(v[k]);
  return { mapValue: { fields } };
}

function fromFs(doc) {
  if (!doc || !doc.fields) return null;
  const parse = val => {
    if ("nullValue" in val) return null;
    if ("booleanValue" in val) return val.booleanValue;
    if ("integerValue" in val) return Number(val.integerValue);
    if ("doubleValue" in val) return Number(val.doubleValue);
    if ("stringValue" in val) return val.stringValue;
    if ("arrayValue" in val) return (val.arrayValue.values || []).map(parse);
    if ("mapValue" in val) {
      const o = {};
      for (const k of Object.keys(val.mapValue.fields || {})) o[k] = parse(val.mapValue.fields[k]);
      return o;
    }
    return null;
  };
  const res = {};
  for (const k of Object.keys(doc.fields)) res[k] = parse(doc.fields[k]);
  return res;
}
