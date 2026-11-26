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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Нет токена авторизации" });

    const uid = await verifyFirebaseToken(token, process.env.PROJECT_ID);
    const { action, ...body } = req.body || {};

    const gToken = await getGoogleAccessToken(process.env.CLIENT_EMAIL, process.env.PRIVATE_KEY);
    const dbUrl = `https://googleapis.com{process.env.PROJECT_ID}/databases/(default)/documents`;

    const getDoc = async (path) => {
      const r = await fetch(`${dbUrl}/${path}`, { headers: { Authorization: `Bearer ${gToken}` } });
      if (!r.ok) return null;
      return fromFs(await r.json());
    };

    const patchDoc = async (path, data) => {
      const fields = toFs(data).mapValue.fields;
      const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      const r = await fetch(`${dbUrl}/${path}?${mask}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
      });
      if (!r.ok) throw new Error(await r.text());
    };

    const me = await getDoc(`users/${uid}`);
    if (!me) return res.status(404).json({ error: "Профиль не найден" });
    if (me.banned) return res.status(403).json({ error: "Аккаунт заблокирован" });

    if (action === "claim") {
      const now = Date.now();
      if (now - (me.lastBonus || 0) < DAY) return res.status(400).json({ error: "Бонус ещё не готов" });
      await patchDoc(`users/${uid}`, { coins: (me.coins || 0) + BONUS, lastBonus: now });
      return res.status(200).json({ ok: true });
    }

    if (action === "sellGift") {
      const { ts, g: gid } = body;
      const g = GIFTS[gid];
      if (!g) return res.status(400).json({ error: "Неизвестный подарок" });
      const arr = [...(me.gifts || [])];
      const idx = arr.findIndex(x => x.ts === ts && x.g === gid);
      if (idx < 0) return res.status(400).json({ error: "Подарок не найден у вас" });
      arr.splice(idx, 1);
      const payout = Math.floor(g.c * SELL);
      await patchDoc(`users/${uid}`, { gifts: arr, coins: (me.coins || 0) + payout });
      return res.status(200).json({ ok: true, payout });
    }

    if (action === "giveGift") {
      const { toUid, gid, text = "", free = false, nf = null } = body;
      const g = GIFTS[gid];
      if (!g) return res.status(400).json({ error: "Подарок не найден" });
      if (free && me.username !== "admin") return res.status(403).json({ error: "Бесплатная выдача только для админа" });
      if (!free && (me.coins || 0) < g.c) return res.status(400).json({ error: "Недостаточно монет" });

      const target = await getDoc(`users/${toUid}`);
      if (!target) return res.status(404).json({ error: "Получатель не найден" });

      let no = 0;
      if (g.max) {
        const nftDoc = (await getDoc(`nft/${gid}`)) || {};
        const minted = nftDoc.minted || 0;
        if (minted >= g.max) return res.status(400).json({ error: "Лимит NFT исчерпан" });
        no = minted + 1;
        await patchDoc(`nft/${gid}`, { minted: no });
      }

      const ts = Date.now();
      const entry = { g: gid, by: uid, n: me.name, t: String(text).slice(0, 140), ts, ...(g.max ? { no, nf } : {}) };
      if (!free) await patchDoc(`users/${uid}`, { coins: (me.coins || 0) - g.c });
      const freshTarget = toUid === uid ? await getDoc(`users/${uid}`) : target;
      await patchDoc(`users/${toUid}`, { gifts: [...(freshTarget.gifts || []), entry] });
      return res.status(200).json({ ok: true, entry });
    }

    if (action === "marketBuy") {
      const { lotId } = body;
      const lot = await getDoc(`market/${lotId}`);
      if (!lot) return res.status(404).json({ error: "Лот уже продан или снят" });
      if (lot.seller === uid) return res.status(400).json({ error: "Нельзя купить свой лот" });
      if ((me.coins || 0) < lot.price) return res.status(400).json({ error: "Недостаточно монет" });

      const seller = await getDoc(`users/${lot.seller}`);
      const cleanItem = { ...lot.item, by: lot.seller, ts: Date.now() };
      await patchDoc(`users/${uid}`, { coins: (me.coins || 0) - lot.price, gifts: [...(me.gifts || []), cleanItem] });
      if (seller) await patchDoc(`users/${lot.seller}`, { coins: (seller.coins || 0) + lot.price });
      await fetch(`${dbUrl}/market/${lotId}`, { method: "DELETE", headers: { Authorization: `Bearer ${gToken}` } });
      return res.status(200).json({ ok: true });
    }

    if (action === "admin") {
      if (me.username !== "admin") return res.status(403).json({ error: "Только для админа" });
      const { targetUid, patch } = body;
      await patchDoc(`users/${targetUid}`, patch);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Неизвестное действие" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function verifyFirebaseToken(token, projectId) {
  const [, pB64] = token.split(".");
  if (!pB64) throw new Error("Неверный формат токена");
  const payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8"));
  if (payload.aud !== projectId || payload.exp * 1000 < Date.now()) throw new Error("Токен просрочен");
  return payload.user_id || payload.sub;
}

async function getGoogleAccessToken(email, rawKey) {
  const crypto = await import("node:crypto");
  const key = rawKey.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const enc = s => Buffer.from(JSON.stringify(s)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: email, scope: "https://googleapis.com", aud: "https://googleapis.com", exp: now + 3600, iat: now })}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(key, "base64url")}`;
  const r = await fetch("https://googleapis.com", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Ошибка ключа Firebase Admin");
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
