'use strict';
const express  = require('express');
const { Telegraf, Markup } = require('telegraf');
const http     = require('http');
const mongoose = require('mongoose');
const crypto   = require('crypto');
const https    = require('https');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);

// ── CORS (allow all origins for Telegram WebApp) ──────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://minefrontend.vercel.app';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://minebackend-dyyq.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'mines_bot';
const MIN_BET      = 1000;
const MAX_BET      = 5000;
const TOTAL_TILES  = 25;
const RTP          = 0.95;

// ── MONGODB (Dual URI Failover) ───────────────────────────────────────────
let isConnected = false;

async function connectDB() {
  const uris = [process.env.MONGODB_URI1, process.env.MONGODB_URI2].filter(Boolean);
  if (!uris.length) { console.error('❌ MONGODB_URI1 မထည့်ရသေး'); return; }
  for (const uri of uris) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
      isConnected = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (e) { console.error('MongoDB fail:', e.message); }
  }
  console.log('Retrying MongoDB in 10s...');
  setTimeout(connectDB, 10000);
}
mongoose.connection.on('disconnected', () => { isConnected = false; setTimeout(connectDB, 5000); });
mongoose.connection.on('reconnected',  () => { isConnected = true; });
connectDB();

// ── SCHEMAS ───────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  telegramId:   { type: Number, required: true, unique: true },
  username:     { type: String, default: '' },
  firstName:    { type: String, default: '' },
  balance:      { type: Number, default: 0 },
  referredBy:   { type: Number, default: null },
  referralCode: { type: String, unique: true, sparse: true },
  totalBet:     { type: Number, default: 0 },
  totalWon:     { type: Number, default: 0 },
  gamesPlayed:  { type: Number, default: 0 },
  isBanned:     { type: Boolean, default: false },
  role:         { type: String, enum: ['user','agent'], default: 'user' },
  createdAt:    { type: Date, default: Date.now }
});

const gameSchema = new mongoose.Schema({
  gameId:         { type: String, required: true, unique: true },
  userId:         { type: Number, required: true },
  betAmount:      { type: Number, required: true },
  bombCount:      { type: Number, required: true },
  serverSeed:     String,
  serverSeedHash: String,
  clientSeed:     String,
  bombPositions:  [Number],
  revealedTiles:  [Number],
  status:         { type: String, enum: ['active','cashout','exploded'], default: 'active' },
  multiplier:     { type: Number, default: 0 },
  payout:         { type: Number, default: 0 },
  createdAt:      { type: Date, default: Date.now, expires: 86400 }
});

const depositSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  kpayName:      String,
  transactionId: { type: String, required: true, unique: true },
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  processedBy:   { type: String, enum: ['admin','agent'], default: 'admin' },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date,
  expireAt:      { type: Date, default: null }
});
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const withdrawalSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  kpayName:      String,
  kpayNumber:    String,
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date,
  expireAt:      { type: Date, default: null }
});
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const agentSchema = new mongoose.Schema({
  telegramId:      { type: Number, required: true, unique: true },
  referralCode:    String,
  depositPct:      { type: Number, default: 0 },
  turnoverPct:     { type: Number, default: 0 },
  totalDepComm:    { type: Number, default: 0 },
  totalTurnComm:   { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  agentKpayNumber: { type: String, default: '' },
  agentKpayName:   { type: String, default: '' },
  hasWave:         { type: Boolean, default: false },
  waveNumber:      { type: String, default: '' },
  isActive:        { type: Boolean, default: true },
  createdAt:       { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const redeemSchema   = new mongoose.Schema({
  code:     { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:   { type: Number, required: true },
  maxUses:  { type: Number, default: 1 },
  usedBy:   [Number],
  isActive: { type: Boolean, default: true },
  createdAt:{ type: Date, default: Date.now }
});

const User       = mongoose.model('User',      userSchema);
const Game       = mongoose.model('MinesGame', gameSchema);
const Deposit    = mongoose.model('Deposit',   depositSchema);
const Withdrawal = mongoose.model('Withdrawal',withdrawalSchema);
const Agent      = mongoose.model('Agent',     agentSchema);
const Settings   = mongoose.model('Settings',  settingsSchema);
const Redeem     = mongoose.model('Redeem',    redeemSchema);

// ── HELPERS ───────────────────────────────────────────────────────────────
const genId      = (n=16) => crypto.randomBytes(n).toString('hex');
const sha256     = s      => crypto.createHash('sha256').update(s).digest('hex');
const genRefCode = id     => 'MNS' + id.toString(36).toUpperCase() + genId(3).toUpperCase();

async function getSetting(key, def) {
  try { const s = await Settings.findOne({ key }).lean(); return s ? s.value : def; } catch { return def; }
}
async function setSetting(key, value) {
  return Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
}

function verifyTg(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p    = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const data = [...p.entries()].filter(([k]) => k !== 'hash').sort().map(([k,v]) => `${k}=${v}`).join('\n');
    const key  = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', key).update(data).digest('hex');
    if (hmac !== hash) return null;
    return JSON.parse(p.get('user') || 'null');
  } catch { return null; }
}

// ── PROVABLY FAIR: Bomb placement ─────────────────────────────────────────
function placeBombs(serverSeed, clientSeed, bombCount) {
  const combined = `${serverSeed}:${clientSeed}`;
  let hex = crypto.createHmac('sha256', serverSeed).update(combined).digest('hex');
  let pos = 0;
  function nextByte() {
    if (pos >= hex.length - 1) { hex = crypto.createHmac('sha256', hex).update(combined).digest('hex'); pos = 0; }
    const b = parseInt(hex.slice(pos, pos+2), 16); pos += 2; return b;
  }
  const tiles = Array.from({ length: TOTAL_TILES }, (_, i) => i);
  for (let i = TOTAL_TILES - 1; i > 0; i--) {
    let r = 0;
    for (let b = 0; b < 4; b++) r = (r * 256 + nextByte()) >>> 0;
    const j = r % (i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, bombCount).sort((a,b) => a - b);
}

// ── MULTIPLIER: Fair × RTP (5% house edge) ────────────────────────────────
function calcMult(bombCount, safeRevealed) {
  if (safeRevealed === 0) return 1.00;
  const safe = TOTAL_TILES - bombCount;
  let prob = 1;
  for (let i = 0; i < safeRevealed; i++) prob *= (safe - i) / (TOTAL_TILES - i);
  return parseFloat(((1 / prob) * RTP).toFixed(4));
}
function calcPayout(bet, mult) { return Math.floor(bet * mult); }

// ── AGENT COMMISSION ──────────────────────────────────────────────────────
async function payTurnoverComm(userId, bet) {
  try {
    const user = await User.findOne({ telegramId: userId }).select('referredBy').lean();
    if (!user?.referredBy) return;
    const ag = await Agent.findOne({ telegramId: user.referredBy, isActive: true }).lean();
    if (!ag || ag.turnoverPct <= 0) return;
    const comm = Math.floor(bet * ag.turnoverPct / 100);
    if (comm <= 0) return;
    await Promise.all([
      User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: comm } }),
      Agent.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { totalTurnComm: comm, totalCommission: comm } })
    ]);
  } catch(e) { console.error('turnoverComm err:', e.message); }
}

async function payDepositComm(userId, amount) {
  try {
    const user = await User.findOne({ telegramId: userId }).select('referredBy').lean();
    if (!user?.referredBy) return;
    const ag = await Agent.findOne({ telegramId: user.referredBy, isActive: true }).lean();
    if (!ag || ag.depositPct <= 0) return;
    const comm = Math.floor(amount * ag.depositPct / 100);
    if (comm <= 0) return;
    await Promise.all([
      User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: comm } }),
      Agent.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { totalDepComm: comm, totalCommission: comm } })
    ]);
  } catch(e) { console.error('depositComm err:', e.message); }
}

// ── BOT ───────────────────────────────────────────────────────────────────
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      const id   = ctx.from.id;
      const args = ctx.payload || '';
      const maint = await getSetting('maintenance', false);
      if (maint && id !== ADMIN_ID) return ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေပါသည်').catch(()=>{});
      let user = await User.findOne({ telegramId: id });
      if (!user) {
        user = new User({ telegramId: id, username: ctx.from.username||'', firstName: ctx.from.first_name||'', referralCode: genRefCode(id) });
        if (args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
      }
      ctx.reply(
        `💣 မင်္ဂလာပါ <b>${ctx.from.first_name}</b>!\n\n💰 လက်ကျန်: <b>${user.balance.toLocaleString()} MMK</b>\n🎮 ကစားမှု: ${user.gamesPlayed} ပွဲ`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([
          [Markup.button.webApp('💣 Mines ကစားမည်', FRONTEND_URL)],
          [Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]
        ])}
      ).catch(()=>{});
    } catch(e) { console.error('start err:', e.message); }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      ctx.reply(`💰 လက်ကျန်: <b>${u.balance.toLocaleString()} MMK</b>\n🎮 ${u.gamesPlayed} ပွဲ`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]]) }).catch(()=>{});
    } catch {}
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      ctx.reply(`🔗 Referral Link\n\nမိတ်ဆွေ ငွေဖြည့်/ဆော့တိုင်း Commission ရမည်!\n\n<code>${link}</code>`,
        { parse_mode:'HTML' }).catch(()=>{});
    } catch {}
  });

  bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('🛡️ Admin Panel', Markup.inlineKeyboard([[Markup.button.webApp('ဝင်မည်', `${FRONTEND_URL}/admin.html`)]])).catch(()=>{});
  });

  bot.command('agent', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id }).lean();
    if (!u || u.role !== 'agent') return ctx.reply('🚫 Agent မဟုတ်သေးပါ').catch(()=>{});
    ctx.reply('🎯 Agent Panel', Markup.inlineKeyboard([[Markup.button.webApp('ဝင်မည်', `${FRONTEND_URL}/agent.html`)]])).catch(()=>{});
  });

  bot.catch(e => console.error('Bot err:', e.message));
  bot.launch().then(() => console.log('✅ Bot launched')).catch(e => console.error('Bot err:', e.message));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
function isAdmin(req, res, next) {
  const id = parseInt(req.headers['x-admin-id'] || req.query.adminId);
  if (!id || id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
  next();
}
async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const u = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!u) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentTid = tid; req.agentUser = u; next();
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════

// Health check (Render uses this to verify the service is alive)
app.get('/',       (_, res) => res.json({ ok: true, game: 'Mines', version: '2.0' }));
app.get('/health', (_, res) => res.json({
  ok: true,
  mongo: isConnected ? 'connected' : 'disconnected'
}));

// ── AUTH ──────────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  try {
    const { initData, telegramId: devId } = req.body;
    let tid, username, firstName;
    if (initData) {
      const u = verifyTg(initData);
      if (!u) return res.status(401).json({ error: 'Telegram auth မှား' });
      tid = u.id; username = u.username||''; firstName = u.first_name||'';
    } else if (devId) {
      tid = parseInt(devId); username = 'dev'; firstName = 'Dev';
    } else return res.status(401).json({ error: 'Auth required' });

    const maint = await getSetting('maintenance', false);
    if (maint && tid !== ADMIN_ID) return res.status(503).json({ error: '🔧 ဆာဗာ ပြင်ဆင်နေပါသည်' });

    let user = await User.findOne({ telegramId: tid });
    if (!user) {
      user = new User({ telegramId: tid, username, firstName, referralCode: genRefCode(tid) });
      await user.save();
    } else {
      if (username && user.username !== username) user.username = username;
      if (firstName && user.firstName !== firstName) user.firstName = firstName;
      await user.save();
    }
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားပါသည်' });

    res.json({
      ok: true,
      telegramId:  user.telegramId,
      username:    user.username || user.firstName || `User${tid}`,
      firstName:   user.firstName,
      balance:     user.balance,
      referralCode:user.referralCode,
      gamesPlayed: user.gamesPlayed,
      role:        user.role
    });
  } catch(e) { console.error('auth err:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const u = await User.findOne({ telegramId: parseInt(req.params.id) })
      .select('balance gamesPlayed totalBet totalWon role').lean();
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    res.json({ ok: true, ...u });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── MINES GAME ────────────────────────────────────────────────────────────
app.post('/api/mines/start', async (req, res) => {
  try {
    const { telegramId, betAmount, bombCount, clientSeed='' } = req.body;
    const tid   = parseInt(telegramId);
    const bet   = parseInt(betAmount);
    const bombs = parseInt(bombCount);

    if (!tid || isNaN(bet) || isNaN(bombs))
      return res.status(400).json({ error: 'betAmount / bombCount / telegramId လိုအပ်သည်' });
    if (bet < MIN_BET || bet > MAX_BET)
      return res.status(400).json({ error: `လောင်းကြေး ${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()} ကျပ် ဖြစ်ရမည်` });
    if (bombs < 1 || bombs > 24)
      return res.status(400).json({ error: 'ဗုံး ၁–၂၄ လုံး ဖြစ်ရမည်' });

    const existing = await Game.findOne({ userId: tid, status: 'active' }).lean();
    if (existing) return res.status(400).json({ error: 'ဆော့နေဆဲ ဂိမ်းရှိသည်', gameId: existing.gameId });

    const user = await User.findOneAndUpdate(
      { telegramId: tid, balance: { $gte: bet }, isBanned: { $ne: true } },
      { $inc: { balance: -bet } },
      { new: true }
    );
    if (!user) {
      const u = await User.findOne({ telegramId: tid }).select('balance isBanned').lean();
      if (!u)         return res.status(404).json({ error: 'User မတွေ့ပါ' });
      if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
      return res.status(400).json({ error: `လောင်းကြေး မလောက်ပါ (ကျန်: ${u.balance.toLocaleString()} MMK)`, balance: u.balance });
    }

    const serverSeed     = genId(32);
    const serverSeedHash = sha256(serverSeed);
    const cSeed          = clientSeed.trim() || String(tid);
    const bombPositions  = placeBombs(serverSeed, cSeed, bombs);
    const gameId         = 'MG' + Date.now().toString(36).toUpperCase() + genId(3).toUpperCase();

    await new Game({ gameId, userId: tid, betAmount: bet, bombCount: bombs, serverSeed, serverSeedHash, clientSeed: cSeed, bombPositions, revealedTiles: [], status: 'active' }).save();

    res.json({ ok: true, gameId, serverSeedHash, clientSeed: cSeed, bombCount: bombs, betAmount: bet, newBalance: user.balance });
  } catch(e) { console.error('mines/start:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mines/reveal', async (req, res) => {
  try {
    const { gameId, tileIndex, telegramId } = req.body;
    const tid  = parseInt(telegramId);
    const tile = parseInt(tileIndex);
    if (isNaN(tile) || tile < 0 || tile >= TOTAL_TILES)
      return res.status(400).json({ error: 'Tile index မမှန်ပါ' });

    const game = await Game.findOne({ gameId, userId: tid, status: 'active' });
    if (!game) return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (game.revealedTiles.includes(tile)) return res.status(400).json({ error: 'ဖွင့်ပြီးသားဖြစ်သည်' });

    const isBomb = game.bombPositions.includes(tile);

    if (isBomb) {
      game.status = 'exploded'; game.multiplier = 0; game.payout = 0;
      game.revealedTiles.push(tile);
      await game.save();
      await User.findOneAndUpdate({ telegramId: tid }, { $inc: { gamesPlayed: 1, totalBet: game.betAmount } });
      await payTurnoverComm(tid, game.betAmount);
      const u = await User.findOne({ telegramId: tid }).select('balance').lean();
      return res.json({ ok: true, result: 'bomb', tile, bombPositions: game.bombPositions, serverSeed: game.serverSeed, clientSeed: game.clientSeed, serverSeedHash: game.serverSeedHash, payout: 0, newBalance: u?.balance||0 });
    }

    game.revealedTiles.push(tile);
    const mult   = calcMult(game.bombCount, game.revealedTiles.length);
    const payout = calcPayout(game.betAmount, mult);
    const allSafe = game.revealedTiles.length >= TOTAL_TILES - game.bombCount;

    if (allSafe) {
      game.status = 'cashout'; game.multiplier = mult; game.payout = payout;
      await game.save();
      const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: payout, gamesPlayed: 1, totalBet: game.betAmount, totalWon: payout } }, { new: true });
      await payTurnoverComm(tid, game.betAmount);
      return res.json({ ok: true, result: 'gem', tile, multiplier: mult, payout, newBalance: u.balance, autoWin: true, bombPositions: game.bombPositions, serverSeed: game.serverSeed, clientSeed: game.clientSeed, serverSeedHash: game.serverSeedHash, revealedTiles: game.revealedTiles });
    }

    game.multiplier = mult;
    await game.save();
    res.json({ ok: true, result: 'gem', tile, multiplier: mult, payout, revealedTiles: game.revealedTiles, revealedCount: game.revealedTiles.length });
  } catch(e) { console.error('mines/reveal:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mines/cashout', async (req, res) => {
  try {
    const { gameId, telegramId } = req.body;
    const tid = parseInt(telegramId);
    const game = await Game.findOne({ gameId, userId: tid, status: 'active' });
    if (!game) return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (game.revealedTiles.length === 0) return res.status(400).json({ error: 'ကွက်တစ်ကွက် ဦးဖွင့်ပါ' });

    const mult   = calcMult(game.bombCount, game.revealedTiles.length);
    const payout = calcPayout(game.betAmount, mult);
    game.status = 'cashout'; game.multiplier = mult; game.payout = payout;
    await game.save();
    const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: payout, gamesPlayed: 1, totalBet: game.betAmount, totalWon: payout } }, { new: true });
    await payTurnoverComm(tid, game.betAmount);
    res.json({ ok: true, multiplier: mult, payout, newBalance: u.balance, bombPositions: game.bombPositions, serverSeed: game.serverSeed, clientSeed: game.clientSeed, serverSeedHash: game.serverSeedHash });
  } catch(e) { console.error('mines/cashout:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mines/active/:tid', async (req, res) => {
  try {
    const game = await Game.findOne({ userId: parseInt(req.params.tid), status: 'active' }).lean();
    if (!game) return res.json({ active: false });
    const mult = calcMult(game.bombCount, game.revealedTiles.length);
    res.json({ active: true, gameId: game.gameId, betAmount: game.betAmount, bombCount: game.bombCount, serverSeedHash: game.serverSeedHash, clientSeed: game.clientSeed, revealedTiles: game.revealedTiles, multiplier: mult, payout: calcPayout(game.betAmount, mult) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mines/history/:tid', async (req, res) => {
  try {
    const list = await Game.find({ userId: parseInt(req.params.tid), status: { $ne: 'active' } })
      .sort({ createdAt: -1 }).limit(20).select('gameId betAmount bombCount multiplier payout status createdAt revealedTiles').lean();
    res.json(list);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── DEPOSIT / WITHDRAW ────────────────────────────────────────────────────
app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount, paymentMethod } = req.body;
    if (!telegramId||!kpayName||!transactionId||!amount) return res.status(400).json({ error: 'ကွင်းလပ်တွေ ဖြည့်ပေးပါ' });
    const amt = parseInt(amount);
    if (amt < 500) return res.status(400).json({ error: 'အနည်းဆုံး 500 MMK' });
    const u = await User.findOne({ telegramId: parseInt(telegramId) }).lean();
    if (!u)         return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    if (await Deposit.findOne({ transactionId }).lean()) return res.status(400).json({ error: 'Transaction ID ကို အသုံးပြုပြီးသည်' });
    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    await new Deposit({ userId: u.telegramId, kpayName, transactionId, amount: amt, paymentMethod: method }).save();
    if (bot && ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID,
      `💰 <b>Deposit တောင်းဆိုမှု</b>\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ် (${method.toUpperCase()})\n📝 ${kpayName}\n🔢 <code>${transactionId}</code>`,
      { parse_mode:'HTML' }).catch(()=>{});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount, paymentMethod } = req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount) return res.status(400).json({ error: 'ကွင်းလပ်တွေ ဖြည့်ပေးပါ' });
    const amt = parseInt(amount); const tid = parseInt(telegramId);
    if (amt < 2500) return res.status(400).json({ error: 'အနည်းဆုံး 2,500 MMK' });
    const u = await User.findOne({ telegramId: tid }).select('balance isBanned firstName username').lean();
    if (!u)         return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    if (u.balance < amt) return res.status(400).json({ error: `လက်ကျန် မလောက်ပါ (ကျန်: ${u.balance.toLocaleString()})` });
    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    const wd = await new Withdrawal({ userId: tid, kpayName, kpayNumber, amount: amt, paymentMethod: method }).save();
    const upd = await User.findOneAndUpdate({ telegramId: tid, balance: { $gte: amt } }, { $inc: { balance: -amt } }, { new: true });
    if (!upd) { await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{}); return res.status(400).json({ error: 'လက်ကျန် မလောက်ပါ' }); }
    if (bot && ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID,
      `💸 <b>Withdrawal တောင်းဆိုမှု</b>\n👤 ${u.firstName||u.username} (${tid})\n💵 ${amt.toLocaleString()} ကျပ် (${method.toUpperCase()})\n📱 ${kpayNumber} — ${kpayName}`,
      { parse_mode:'HTML' }).catch(()=>{});
    res.json({ ok: true, newBalance: upd.balance });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── PAYMENT INFO ──────────────────────────────────────────────────────────
app.get('/api/payment-info/:tid', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: parseInt(req.params.tid) }).select('referredBy').lean();
    const def = { kpayNumber: process.env.ADMIN_KPAY_NUMBER||'09000000000', kpayName: process.env.ADMIN_KPAY_NAME||'Admin', hasWave: !!(process.env.ADMIN_WAVE_NUMBER), waveNumber: process.env.ADMIN_WAVE_NUMBER||'', waveName: process.env.ADMIN_WAVE_NAME||'', isAgent: false };
    if (!user?.referredBy) return res.json(def);
    const ag = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!ag?.agentKpayNumber) return res.json(def);
    res.json({ kpayNumber: ag.agentKpayNumber, kpayName: ag.agentKpayName||'', hasWave: ag.hasWave, waveNumber: ag.waveNumber||'', waveName: ag.agentKpayName||'', isAgent: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── REFERRALS / REDEEM ────────────────────────────────────────────────────
app.get('/api/referrals/:tid', async (req, res) => {
  try {
    const refs = await User.find({ referredBy: parseInt(req.params.tid) }).select('firstName username balance gamesPlayed createdAt').sort({ createdAt:-1 }).lean();
    res.json({ total: refs.length, referrals: refs.map(u => ({ name: u.firstName||u.username||`User`, username: u.username, balance: u.balance, gamesPlayed: u.gamesPlayed, joinedAt: u.createdAt })) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/redeem', async (req, res) => {
  try {
    const { telegramId, code } = req.body;
    const tid = parseInt(telegramId);
    const u   = await User.findOne({ telegramId: tid }).lean();
    if (!u||u.isBanned) return res.status(403).json({ error: 'မတွေ့ပါ' });
    const rc = await Redeem.findOne({ code: code?.toUpperCase().trim() });
    if (!rc||!rc.isActive) return res.status(400).json({ error: 'Code မမှန်ပါ' });
    if (rc.usedBy.includes(tid)) return res.status(400).json({ error: 'Code သုံးပြီး' });
    if (rc.maxUses>0 && rc.usedBy.length>=rc.maxUses) return res.status(400).json({ error: 'Code ကုန်ဆုံးပြီ' });
    await Redeem.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const upd = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: rc.amount } }, { new: true });
    res.json({ ok: true, amount: rc.amount, newBalance: upd.balance });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────
app.post('/api/admin/verify', async (req, res) => {
  const tid = parseInt(req.body.telegramId);
  if (!tid||tid!==ADMIN_ID) return res.status(403).json({ error: 'Admin မဟုတ်ပါ' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', isAdmin, async (_, res) => {
  try {
    const [users, games, pdep, pwd] = await Promise.all([User.countDocuments(), Game.countDocuments({ status: { $ne:'active' } }), Deposit.countDocuments({ status:'pending' }), Withdrawal.countDocuments({ status:'pending' })]);
    const [depAgg, wdAgg, gameAgg] = await Promise.all([
      Deposit.aggregate([{ $match:{ status:'confirmed' } },{ $group:{ _id:null,t:{ $sum:'$amount' } } }]),
      Withdrawal.aggregate([{ $match:{ status:'confirmed' } },{ $group:{ _id:null,t:{ $sum:'$amount' } } }]),
      Game.aggregate([{ $match:{ status:{ $ne:'active' } } },{ $group:{ _id:null,bet:{ $sum:'$betAmount' },won:{ $sum:'$payout' } } }])
    ]);
    res.json({ users, games, pdep, pwd, totalDeposited: depAgg[0]?.t||0, totalWithdrawn: wdAgg[0]?.t||0, totalBet: gameAgg[0]?.bet||0, totalWon: gameAgg[0]?.won||0, houseProfit: (gameAgg[0]?.bet||0)-(gameAgg[0]?.won||0), activeGames: await Game.countDocuments({ status:'active' }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', isAdmin, async (_, res) => {
  const maint = await getSetting('maintenance', false);
  res.json({ maintenance: maint, minBet: MIN_BET, maxBet: MAX_BET, rtp: RTP });
});

app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
  await setSetting('maintenance', !!req.body.enabled);
  res.json({ ok: true, maintenance: !!req.body.enabled });
});

app.get('/api/admin/deposits', isAdmin, async (req, res) => {
  try {
    const agentIds = (await User.find({ role:'agent' }).select('telegramId').lean()).map(a=>a.telegramId);
    const refIds   = agentIds.length ? (await User.find({ referredBy:{ $in:agentIds } }).select('telegramId').lean()).map(u=>u.telegramId) : [];
    const q = { status: req.query.status||'pending' };
    if (refIds.length) q.userId = { $nin: refIds };
    const deps = await Deposit.find(q).sort({ createdAt:-1 }).limit(50).lean();
    const out  = await Promise.all(deps.map(async d => { const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean(); return {...d,userName:u?.firstName||u?.username||String(d.userId)}; }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findOneAndUpdate({ _id:req.params.id,status:'pending' }, { status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*3600*1000) }, { new:true });
    if (!dep) return res.status(404).json({ error: 'Deposit မတွေ့ပါ' });
    await User.findOneAndUpdate({ telegramId:dep.userId }, { $inc:{ balance:dep.amount } });
    await payDepositComm(dep.userId, dep.amount);
    if (bot) bot.telegram.sendMessage(dep.userId, `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် ဖြည့်မှု အတည်ပြုပြီး 🎉`, Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်',FRONTEND_URL)]])).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findByIdAndUpdate(req.params.id, { status:'rejected',processedAt:new Date(),expireAt:new Date(Date.now()+72*3600*1000) }, { new:true });
    if (!dep) return res.status(404).json({ error: 'မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(dep.userId, `❌ ငွေဖြည့် ပယ်ချပြီ${req.body.reason?'\n'+req.body.reason:''}`).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const wds = await Withdrawal.find({ status:req.query.status||'pending' }).sort({ createdAt:-1 }).limit(50).lean();
    const out = await Promise.all(wds.map(async w => { const u=await User.findOne({telegramId:w.userId}).select('firstName username balance').lean(); return {...w,userName:u?.firstName||u?.username||String(w.userId),userBalance:u?.balance}; }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findOneAndUpdate({ _id:req.params.id,status:'pending' }, { status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*3600*1000) }, { new:true });
    if (!wd) return res.status(404).json({ error: 'မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(wd.userId, `✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး 🎉`).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd||wd.status!=='pending') return res.status(400).json({ error: 'မတွေ့ပါ / ပြင်ဆင်ပြီး' });
    wd.status='rejected'; wd.processedAt=new Date(); wd.expireAt=new Date(Date.now()+72*3600*1000);
    await wd.save();
    await User.findOneAndUpdate({ telegramId:wd.userId }, { $inc:{ balance:wd.amount } });
    if (bot) bot.telegram.sendMessage(wd.userId, `❌ ငွေထုတ် ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const { search='', page=1 } = req.query;
    const q = search ? { $or:[{ telegramId:isNaN(search)?-1:parseInt(search) },{ username:{ $regex:search,$options:'i' } },{ firstName:{ $regex:search,$options:'i' } }] } : {};
    const [users,total] = await Promise.all([User.find(q).sort({ createdAt:-1 }).skip((+page-1)*20).limit(20).lean(), User.countDocuments(q)]);
    res.json({ users, total, pages: Math.ceil(total/20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async (req, res) => {
  try {
    const u = await User.findOneAndUpdate({ telegramId:parseInt(req.params.tid) }, { $inc:{ balance:parseInt(req.body.amount) } }, { new:true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    res.json({ ok:true, newBalance:u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async (req, res) => {
  try {
    await User.findOneAndUpdate({ telegramId:parseInt(req.params.tid) }, { isBanned:!!req.body.ban });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/role', isAdmin, async (req, res) => {
  try {
    const tid=parseInt(req.params.tid); const role=req.body.role;
    const u=await User.findOneAndUpdate({ telegramId:tid }, { role }, { new:true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (role==='agent') {
      await Agent.findOneAndUpdate({ telegramId:tid }, { $setOnInsert:{ telegramId:tid,referralCode:u.referralCode,depositPct:0,turnoverPct:0 } }, { upsert:true });
      if (bot) bot.telegram.sendMessage(tid, `🎯 Agent အဖြစ် ခွင့်ပြုပြီ!\n/agent နှိပ်ပါ`).catch(()=>{});
    }
    res.json({ ok:true, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { search='', page=1 } = req.query;
    const q = { role:'agent' };
    if (search) { const tid=isNaN(search)?null:parseInt(search); q.$or=[...(tid?[{telegramId:tid}]:[]),{username:{$regex:search,$options:'i'}},{firstName:{$regex:search,$options:'i'}}]; }
    const [agents,total] = await Promise.all([User.find(q).sort({ createdAt:-1 }).skip((+page-1)*20).limit(20).lean(), User.countDocuments(q)]);
    const out = await Promise.all(agents.map(async u => { const ag=await Agent.findOne({telegramId:u.telegramId}).lean(); const cnt=await User.countDocuments({referredBy:u.telegramId}); return {...u,agentData:ag,referralCount:cnt}; }));
    res.json({ agents:out, total, pages:Math.ceil(total/20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/commission', isAdmin, async (req, res) => {
  try {
    const { depositPct, turnoverPct } = req.body;
    const ag = await Agent.findOneAndUpdate({ telegramId:parseInt(req.params.tid) }, { $set:{ depositPct:+depositPct, turnoverPct:+turnoverPct } }, { new:true, upsert:true });
    res.json({ ok:true, depositPct:ag.depositPct, turnoverPct:ag.turnoverPct });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/kpay', isAdmin, async (req, res) => {
  try {
    const { kpayNumber, kpayName, hasWave, waveNumber } = req.body;
    await Agent.findOneAndUpdate({ telegramId:parseInt(req.params.tid) }, { $set:{ agentKpayNumber:kpayNumber||'',agentKpayName:kpayName||'',hasWave:!!hasWave,waveNumber:waveNumber||'' } }, { upsert:true });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const u=await User.findOneAndUpdate({ telegramId:parseInt(req.params.tid),role:'agent' }, { $inc:{ balance:parseInt(req.body.amount) } }, { new:true });
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    res.json({ ok:true, newBalance:u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
  const { message, buttonText, buttonUrl } = req.body;
  if (!message||!bot) return res.status(400).json({ error: 'message required' });
  res.json({ ok:true });
  setImmediate(async () => {
    const users=await User.find({ isBanned:{$ne:true} }).select('telegramId').lean();
    const kb=buttonText&&buttonUrl?{ inline_keyboard:[[{text:buttonText,url:buttonUrl}]] }:undefined;
    for (let i=0;i<users.length;i+=25) {
      await Promise.allSettled(users.slice(i,i+25).map(async u => { try { await bot.telegram.sendMessage(u.telegramId,message,{parse_mode:'HTML',reply_markup:kb}); } catch {} }));
      if (i+25<users.length) await new Promise(r=>setTimeout(r,1000));
    }
  });
});

app.post('/api/admin/redeem/create', isAdmin, async (req, res) => {
  try {
    const { code, amount, maxUses=1 } = req.body;
    if (!code||!amount) return res.status(400).json({ error: 'code + amount လိုသည်' });
    const rc=await new Redeem({ code:code.toUpperCase().trim(), amount:parseInt(amount), maxUses:parseInt(maxUses) }).save();
    res.json({ ok:true, code:rc });
  } catch(e) { if(e.code===11000) return res.status(400).json({ error:'Code ရှိပြီး' }); res.status(500).json({ error:e.message }); }
});

app.get('/api/admin/redeem', isAdmin, async (_, res) => { res.json(await Redeem.find().sort({ createdAt:-1 }).lean()); });
app.delete('/api/admin/redeem/:id', isAdmin, async (req, res) => { await Redeem.findByIdAndDelete(req.params.id); res.json({ ok:true }); });

// ── AGENT ROUTES ──────────────────────────────────────────────────────────
app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const ag  = await Agent.findOne({ telegramId:req.agentTid }).lean();
    const cnt = await User.countDocuments({ referredBy:req.agentTid });
    const refs = (await User.find({ referredBy:req.agentTid }).select('telegramId').lean()).map(u=>u.telegramId);
    const salesAgg = refs.length ? await Deposit.aggregate([{ $match:{ userId:{ $in:refs },status:'confirmed' } },{ $group:{ _id:null,t:{ $sum:'$amount' } } }]) : [];
    res.json({ ok:true, ...req.agentUser, agentData:ag, referralCount:cnt, totalSales:salesAgg[0]?.t||0, botUsername:BOT_USERNAME });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const refs=await User.find({ referredBy:req.agentTid }).select('firstName username balance gamesPlayed createdAt').sort({ createdAt:-1 }).lean();
    res.json({ total:refs.length, referrals:refs.map(u=>({ name:u.firstName||u.username||'User', username:u.username, balance:u.balance, gamesPlayed:u.gamesPlayed, joinedAt:u.createdAt })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const refs=await User.find({ referredBy:req.agentTid }).select('telegramId firstName username').lean();
    if (!refs.length) return res.json([]);
    const refIds=refs.map(u=>u.telegramId);
    const userMap=Object.fromEntries(refs.map(u=>[u.telegramId,u.firstName||u.username||`User${u.telegramId}`]));
    const deps=await Deposit.find({ userId:{ $in:refIds },status:req.query.status||'pending' }).sort({ createdAt:-1 }).limit(50).lean();
    res.json(deps.map(d=>({ ...d, userName:userMap[d.userId]||String(d.userId) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const dep=await Deposit.findOneAndUpdate({ _id:req.params.id,status:'pending' },{ $set:{ status:'confirming' } },{ new:false });
    if (!dep) return res.status(400).json({ error: 'မတွေ့ပါ / ပြင်ဆင်ပြီး' });
    const user=await User.findOne({ telegramId:dep.userId }).lean();
    if (!user||user.referredBy!==req.agentTid) { await Deposit.findByIdAndUpdate(dep._id,{ $set:{ status:'pending' } }); return res.status(403).json({ error: 'ဤ User သင့် Referral မဟုတ်ပါ' }); }
    const ag=await User.findOne({ telegramId:req.agentTid }).lean();
    if (!ag||ag.balance<dep.amount) { await Deposit.findByIdAndUpdate(dep._id,{ $set:{ status:'pending' } }); return res.status(402).json({ error: `Agent balance မလောက်ပါ (ကျန်: ${ag?.balance||0})`, insufficientBalance:true }); }
    await Deposit.findByIdAndUpdate(dep._id,{ $set:{ status:'confirmed',processedAt:new Date(),processedBy:'agent',expireAt:new Date(Date.now()+72*3600*1000) } });
    await User.findOneAndUpdate({ telegramId:req.agentTid },{ $inc:{ balance:-dep.amount } });
    await User.findOneAndUpdate({ telegramId:dep.userId  },{ $inc:{ balance: dep.amount } });
    await payDepositComm(dep.userId, dep.amount);
    if (bot) bot.telegram.sendMessage(dep.userId, `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် ဖြည့်မှု အတည်ပြုပြီး 🎉`, Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်',FRONTEND_URL)]])).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const dep=await Deposit.findOneAndUpdate({ _id:req.params.id,status:'pending' },{ status:'rejected',processedAt:new Date(),processedBy:'agent',expireAt:new Date(Date.now()+72*3600*1000) },{ new:true });
    if (!dep) return res.status(400).json({ error: 'မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(dep.userId, `❌ ငွေဖြည့် ပယ်ချပြီ${req.body.reason?'\n'+req.body.reason:''}`).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KEEP ALIVE (Render free tier) ─────────────────────────────────────────
setInterval(() => {
  https.get(`${BACKEND_URL}/health`, ()=>{}).on('error', ()=>{});
}, 4 * 60 * 1000);

process.on('unhandledRejection', r => console.error('Unhandled:', r));
process.on('uncaughtException',  e => console.error('Uncaught:', e.message));

// ── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ==============================`);
  console.log(`   Mines Backend started`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Frontend: ${FRONTEND_URL}`);
  console.log(`   Backend:  ${BACKEND_URL}`);
  console.log(`================================\n`);
});
