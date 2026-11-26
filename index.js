// BunkMESS API (Render). Verifies Firebase ID tokens and performs every money/gift operation in Firestore transactions.
const http = require("node:http");
const admin = require("firebase-admin");

const KEY = process.env.FIREBASE_KEY_FILE || "/etc/secrets/firebase-key.json"; // Render "Secret File"
admin.initializeApp({ credential: admin.credential.cert(require(KEY)) });
const db = admin.firestore(), FV = admin.firestore.FieldValue;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // set to your site URL, e.g. https://bunkmess.netlify.app
const BONUS = 250, DAY = 864e5, SELL = 0.8, SELL_MS = 3 * DAY, ADMIN = "admin";

// ---- catalog (must match the client: ids, prices, supply) ----
const REG = { heart: 50, star: 50, choco: 50, fire: 55, rose: 55, party: 60, cake: 60, teddy: 70, champ: 75, rocket: 80, trophy: 80, diamond: 90, ring: 90, crown: 95, car: 100, cash: 100 };
const NFTS = { plushpepe: [50000, 5], durovscap: [45000, 6], preciouspeach: [35000, 10], astralshard: [28000, 12], iongem: [25000, 15], perfumebottle: [22000, 18], minioscar: [20000, 20], magicpotion: [18000, 22], lootbag: [16000, 25], genielamp: [15000, 28], scaredcat: [14500, 30], resistancedog: [14000, 30], swisswatch: [13500, 32], skullflower: [13000, 35], signetring: [11000, 36], hexpot: [9500, 40], snoopdogg: [9000, 45], vintagecigar: [8000, 50], kissedfrog: [7500, 55], voodoodoll: [7000, 60], toybear: [6500, 65], spicedwine: [6000, 68], crystalball: [5500, 75], homemadecake: [5000, 80], jellybunny: [4800, 85], santahat: [4500, 90] };
const GIFTS = {};
for (const [k, c] of Object.entries(REG)) GIFTS[k] = { c };
for (const [k, [c, max]] of Object.entries(NFTS)) GIFTS["n_" + k] = { c, max };

const rnd = n => Math.floor(Math.random() * n);
const rollNft = () => ({ bd: rnd(24), pt: rnd(14), pl: rnd(2), sy: rnd(5), fr: rnd(4), an: rnd(360) });
const fail = (m, s = 400) => { const e = new Error(m); e.status = s; return e; };
const U = uid => db.collection("users").doc(uid);
const need = snap => { const m = snap.data(); if (!m) throw fail("Профиль не найден", 404); if (m.banned) throw fail("Аккаунт заблокирован", 403); return m; };
const hits = new Map();
const limited = uid => { const n = Date.now(), a = (hits.get(uid) || []).filter(t => n - t < 6e4); a.push(n); hits.set(uid, a); return a.length > 40; };

const ACTIONS = {
  async claim(uid) {
    return db.runTransaction(async tx => {
      const m = need(await tx.get(U(uid)));
      if (Date.now() - (m.lastBonus || 0) < DAY) throw fail("Бонус ещё не готов");
      tx.update(U(uid), { coins: FV.increment(BONUS), lastBonus: Date.now() });
      return { ok: true };
    });
  },

  async sellGift(uid, { ts, g }) {
    const G = GIFTS[g]; if (!G) throw fail("Неизвестный подарок");
    return db.runTransaction(async tx => {
      const m = need(await tx.get(U(uid))), arr = [...(m.gifts || [])];
      const i = arr.findIndex(x => x.ts === ts && x.g === g);
      if (i < 0) throw fail("Подарок не найден у вас");
      if (Date.now() - arr[i].ts > SELL_MS) throw fail("Срок продажи истёк");
      const payout = Math.floor(G.c * SELL);
      arr.splice(i, 1);
      tx.update(U(uid), { gifts: arr, coins: FV.increment(payout) });
      return { ok: true, payout };
    });
  },

  async giveGift(uid, { toUid, gid, text = "", free = false }) {
    const G = GIFTS[gid]; if (!G) throw fail("Неизвестный подарок");
    if (typeof toUid !== "string" || !toUid || toUid === uid) throw fail("Неверный получатель");
    return db.runTransaction(async tx => {
      const m = need(await tx.get(U(uid)));
      if (free && m.username !== ADMIN) throw fail("Бесплатная выдача только для админа", 403);
      if (!(await tx.get(U(toUid))).exists) throw fail("Получатель не найден", 404);
      if (!free && (m.coins || 0) < G.c) throw fail("Недостаточно монет");
      const nref = db.collection("nft").doc(gid);
      let no = 0;
      if (G.max) {
        const minted = ((await tx.get(nref)).data() || {}).minted || 0;
        if (minted >= G.max) throw fail("Лимит NFT исчерпан");
        no = minted + 1;
        tx.set(nref, { minted: no }, { merge: true });
      }
      const ts = Date.now(), t = String(text).slice(0, 100), nf = G.max ? rollNft() : null;
      const entry = { g: gid, by: uid, n: m.name, t, ts, ...(G.max ? { no, nf } : {}) };
      if (!free) tx.update(U(uid), { coins: FV.increment(-G.c) });
      tx.update(U(toUid), { gifts: FV.arrayUnion(entry) });
      tx.set(db.collection("messages").doc(), { from: uid, to: toUid, participants: [uid, toUid], type: "gift", gift: gid, text: t, ts, read: false, ...(G.max ? { no, nf } : {}) });
      tx.set(db.collection("stats").doc("global"), { gifts: FV.increment(1), messages: FV.increment(1) }, { merge: true });
      return { ok: true, entry };
    });
  },

  async marketList(uid, { ts, g, no, price }) {
    price = Math.floor(Number(price));
    if (!(price >= 1 && price <= 1e7)) throw fail("Неверная цена");
    if (!(GIFTS[g] && GIFTS[g].max)) throw fail("На рынок можно выставлять только NFT");
    return db.runTransaction(async tx => {
      const m = need(await tx.get(U(uid))), arr = [...(m.gifts || [])];
      const i = arr.findIndex(x => x.ts === ts && x.g === g && x.no === no);
      if (i < 0) throw fail("NFT не найден у вас");
      const [item] = arr.splice(i, 1);
      tx.update(U(uid), { gifts: arr });
      tx.set(db.collection("market").doc(), { seller: uid, sellerName: m.name, price, item, ts: Date.now() });
      return { ok: true };
    });
  },

  async marketCancel(uid, { lotId }) {
    return db.runTransaction(async tx => {
      const lr = db.collection("market").doc(String(lotId)), l = await tx.get(lr);
      if (!l.exists || l.data().seller !== uid) throw fail("Лот не найден", 404);
      need(await tx.get(U(uid)));
      tx.delete(lr);
      tx.update(U(uid), { gifts: FV.arrayUnion(l.data().item) });
      return { ok: true };
    });
  },

  async marketBuy(uid, { lotId }) {
    return db.runTransaction(async tx => {
      const lr = db.collection("market").doc(String(lotId)), l = await tx.get(lr);
      if (!l.exists) throw fail("Лот уже продан или снят", 404);
      const lot = l.data(), buyer = need(await tx.get(U(uid)));
      if (lot.seller === uid) throw fail("Нельзя купить свой лот");
      if ((buyer.coins || 0) < lot.price) throw fail("Недостаточно монет");
      const sellerSnap = await tx.get(U(lot.seller));
      tx.delete(lr);
      tx.update(U(uid), { coins: FV.increment(-lot.price), gifts: FV.arrayUnion({ ...lot.item, by: lot.seller }) });
      if (sellerSnap.exists) tx.update(U(lot.seller), { coins: FV.increment(lot.price) });
      return { ok: true };
    });
  }
};

http.createServer(async (req, res) => {
  const send = (s, d) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") return send(405, { error: "Method not allowed" });
  try {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 20000) throw fail("Слишком большой запрос", 413); }
    const body = raw ? JSON.parse(raw) : {};
    const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!tok) throw fail("Нет токена авторизации", 401);
    let uid;
    try { uid = (await admin.auth().verifyIdToken(tok)).uid; } catch { throw fail("Неверный или просроченный токен", 401); }
    if (limited(uid)) throw fail("Слишком много запросов", 429);
    const fn = ACTIONS[body.action];
    if (!fn) throw fail("Неизвестное действие");
    send(200, await fn(uid, body));
  } catch (e) {
    if (!e.status) console.error(e);
    send(e.status || 500, { error: e.status ? e.message : "Ошибка сервера" });
  }
}).listen(process.env.PORT || 3000, () => console.log("BunkMESS API running"));
