/**
 * ╔══════════════════════════════════════════════════════╗
 * ║         MINES GAME — Backend  (Node.js/Express)     ║
 * ║  Single-player · REST API · Provably Fair · 5×5     ║
 * ╚══════════════════════════════════════════════════════╝
 */

'use strict';
const express   = require('express');
const { Telegraf, Markup } = require('telegraf');
const http      = require('http');
const mongoose  = require('mongoose');
const crypto    = require('crypto');
const httpsLib  = require('https');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── ENV CONSTANTS ─────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mines-frontend.vercel.app';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://mines-backend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'mines_game_bot';

// Game limits
const MIN_BET   = 1000;
const MAX_BET   = 5000;
const GRID_SIZE = 25;   // 5×5
const RTP       = 0.95; // 95% return-to-player → 5% house edge

// ── DUAL MONGODB CONNECT ──────────────────────────────────────────────────
let isConnected = false;
let activeURI   = '';

async function connectDB() {
  const uris = [process.env.MONGODB_URI1, process.env.MONGODB_URI2].filter(Boolean);
  if (!uris.length) { console.error('❌ No MongoDB URI set'); return; }
  for (const uri of uris) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
      isConnected = true;
      activeURI   = uri.slice(0, 30) + '...';
      console.log(`✅ MongoDB connected (${activeURI})`);
      return;
    } catch (e) { console.error(`❌ MongoDB URI failed: ${e.message}`); }
  }
  console.error('❌ All MongoDB URIs failed — retrying in 15s');
  setTimeout(connectDB, 15000);
}
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.warn('⚠️ MongoDB disconnected — reconnecting...');
  setTimeout(connectDB, 5000);
});
mongoose.connection.on('reconnected', () => { isConnected = true; });
connectDB();

// ══════════════════════════════════════════════════════════════════════════
//  SCHEMAS
// ══════════════════════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  telegramId:   { type: Number, required: true, unique: true, index: true },
  username:     { type: String, default: '' },
  firstName:    { type: String, default: '' },
  balance:      { type: Number, default: 0, min: 0 },
  referredBy:   { type: Number, default: null },   // Agent's telegramId
  referralCode: { type: String, unique: true, sparse: true, index: true },
  totalBet:     { type: Number, default: 0 },
  totalWon:     { type: Number, default: 0 },
  gamesPlayed:  { type: Number, default: 0 },
  isBanned:     { type: Boolean, default: false },
  role:         { type: String, enum: ['user','agent','admin'], default: 'user' },
  lastActive:   { type: Date, default: Date.now },
  createdAt:    { type: Date, default: Date.now }
}, { minimize: true });

const gameSchema = new mongoose.Schema({
  gameId:        { type: String, required: true, unique: true, index: true },
  userId:        { type: Number, required: true, index: true },
  betAmount:     { type: Number, required: true },
  bombCount:     { type: Number, required: true },
  serverSeed:    { type: String, required: true },   // revealed after game ends
  serverSeedHash:{ type: String, required: true },   // shown before game starts
  clientSeed:    { type: String, default: '' },
  bombPositions: [Number],                           // hidden until game ends
  revealedTiles: [Number],
  status:        { type: String, enum: ['active','cashout','exploded'], default: 'active' },
  multiplier:    { type: Number, default: 0 },
  payout:        { type: Number, default: 0 },
  createdAt:     { type: Date, default: Date.now, expires: 86400 } // TTL 1 day
});

const depositSchema = new mongoose.Schema({
  userId:        { type: Number, required: true, index: true },
  kpayName:      String,
  transactionId: { type: String, required: true, unique: true },
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending', index: true },
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
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending', index: true },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date,
  expireAt:      { type: Date, default: null }
});
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const agentSchema = new mongoose.Schema({
  telegramId:      { type: Number, required: true, unique: true, index: true },
  referralCode:    String,
  // ──── PERCENTAGE COMMISSION (replaces milestone boxes) ────
  depositPct:      { type: Number, default: 0 },    // % of deposit → agent earns
  turnoverPct:     { type: Number, default: 0 },    // % of bet turnover → agent earns
  // ─────────────────────────────────────────────────────────
  totalDepComm:    { type: Number, default: 0 },
  totalTurnComm:   { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  // KPay info for their users' deposits
  agentKpayNumber: { type: String, default: '' },
  agentKpayName:   { type: String, default: '' },
  hasWave:         { type: Boolean, default: false },
  waveNumber:      { type: String, default: '' },
  isActive:        { type: Boolean, default: true },
  createdAt:       { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const redeemSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:    { type: Number, required: true },
  maxUses:   { type: Number, default: 1 },
  usedBy:    [{ type: Number }],
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const User       = mongoose.model('User',       userSchema);
const Game       = mongoose.model('MinesGame',  gameSchema);
const Deposit    = mongoose.model('Deposit',    depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Agent      = mongoose.model('Agent',      agentSchema);
const Settings   = mongoose.model('Settings',   settingsSchema);
const Redeem     = mongoose.model('Redeem',     redeemSchema);

// ══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════
const genId   = (len=8) => crypto.randomBytes(len).toString('hex');
const sha256  = (s)     => crypto.createHash('sha256').update(s).digest('hex');
const genRefCode = (id) => 'MNS' + id.toString(36).toUpperCase() + genId(2).toUpperCase();

async function getSetting(key, def) {
  try { const s = await Settings.findOne({ key }).lean(); return s ? s.value : def; }
  catch { return def; }
}
async function setSetting(key, value) {
  return Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
}

/** Verify Telegram WebApp initData */
function verifyTg(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p    = new URLSearchParams(initData);
    const hash = p.get('hash'); if (!hash) return null;
    const data = [...p.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const key  = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', key).update(data).digest('hex');
    if (hmac !== hash) return null;
    return JSON.parse(p.get('user') || 'null');
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════
//  PROVABLY FAIR — BOMB PLACEMENT
//  Uses HMAC-SHA256 + Fisher-Yates shuffle to deterministically place bombs
// ══════════════════════════════════════════════════════════════════════════
function placeBombs(serverSeed, clientSeed, bombCount) {
  const combined = `${serverSeed}:${clientSeed}`;
  let hexStream  = crypto.createHmac('sha256', serverSeed).update(combined).digest('hex');
  let pos        = 0;

  function nextByte() {
    if (pos >= hexStream.length - 1) {
      hexStream = crypto.createHmac('sha256', hexStream).update(combined).digest('hex');
      pos       = 0;
    }
    const byte = parseInt(hexStream.slice(pos, pos + 2), 16);
    pos += 2;
    return byte;
  }

  // Fisher-Yates shuffle of 0..24
  const tiles = Array.from({ length: GRID_SIZE }, (_, i) => i);
  for (let i = GRID_SIZE - 1; i > 0; i--) {
    // Build a 4-byte number to reduce modulo bias
    let r = 0;
    for (let b = 0; b < 4; b++) r = (r * 256 + nextByte()) >>> 0;
    const j = r % (i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, bombCount).sort((a, b) => a - b);
}

// ══════════════════════════════════════════════════════════════════════════
//  MULTIPLIER FORMULA  (House Edge 5%, RTP 95%)
//
//  Fair probability of hitting k safe tiles in a row:
//    P(k) = product_{i=0}^{k-1} [ (safe-i) / (total-i) ]
//  Fair multiplier = 1 / P(k)
//  After house edge: multiplier_k = (1 / P(k)) * RTP
// ══════════════════════════════════════════════════════════════════════════
function calcMultiplier(bombCount, safeRevealed) {
  if (safeRevealed === 0) return 1.00;
  const safe  = GRID_SIZE - bombCount;
  let   prob  = 1;
  for (let i = 0; i < safeRevealed; i++) {
    prob *= (safe - i) / (GRID_SIZE - i);
  }
  return parseFloat(((1 / prob) * RTP).toFixed(4));
}

// Payout = bet × multiplier (floored to integer)
function calcPayout(bet, multiplier) { return Math.floor(bet * multiplier); }

// ══════════════════════════════════════════════════════════════════════════
//  AGENT COMMISSION — AUTO-PAY
// ══════════════════════════════════════════════════════════════════════════
async function payTurnoverCommission(userId, betAmount) {
  try {
    const user  = await User.findOne({ telegramId: userId, referredBy: { $ne: null } }).select('referredBy').lean();
    if (!user?.referredBy) return;
    const agent = await Agent.findOne({ telegramId: user.referredBy, isActive: true }).lean();
    if (!agent || agent.turnoverPct <= 0) return;
    const comm = Math.floor(betAmount * agent.turnoverPct / 100);
    if (comm <= 0) return;
    await Promise.all([
      User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: comm } }),
      Agent.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { totalTurnComm: comm, totalCommission: comm } })
    ]);
    if (bot) bot.telegram.sendMessage(user.referredBy,
      `💹 Turnover Commission\n💰 +${comm.toLocaleString()} MMK (${agent.turnoverPct}% of ${betAmount.toLocaleString()})`,
      { parse_mode: 'HTML' }).catch(()=>{});
  } catch (e) { console.error('payTurnoverComm:', e.message); }
}

async function payDepositCommission(userId, depositAmount) {
  try {
    const user  = await User.findOne({ telegramId: userId, referredBy: { $ne: null } }).select('referredBy').lean();
    if (!user?.referredBy) return;
    const agent = await Agent.findOne({ telegramId: user.referredBy, isActive: true }).lean();
    if (!agent || agent.depositPct <= 0) return;
    const comm = Math.floor(depositAmount * agent.depositPct / 100);
    if (comm <= 0) return;
    await Promise.all([
      User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: comm } }),
      Agent.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { totalDepComm: comm, totalCommission: comm } })
    ]);
    if (bot) bot.telegram.sendMessage(user.referredBy,
      `💳 Deposit Commission\n💰 +${comm.toLocaleString()} MMK (${agent.depositPct}% of ${depositAmount.toLocaleString()})`,
      { parse_mode: 'HTML' }).catch(()=>{});
  } catch (e) { console.error('payDepositComm:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════
//  TELEGRAM BOT
// ══════════════════════════════════════════════════════════════════════════
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
        user = new User({
          telegramId:   id,
          username:     ctx.from.username  || '',
          firstName:    ctx.from.first_name|| '',
          referralCode: genRefCode(id)
        });
        if (args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
        // Create agent doc if role=agent later
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp('💣 Mines ကစားမည်', FRONTEND_URL)],
        [Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]
      ]);
      await ctx.reply(
        `💣 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: <b>${user.balance.toLocaleString()} MMK</b>\n🎮 ကစားမှု: ${user.gamesPlayed} ပွဲ`,
        { parse_mode:'HTML', ...keyboard }
      ).catch(()=>{});
    } catch(e) { console.error('start err:', e.message); }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      ctx.reply(`💰 လက်ကျန်: <b>${u.balance.toLocaleString()} MMK</b>\n🎮 ကစားမှု: ${u.gamesPlayed}`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]]) }).catch(()=>{});
    } catch {}
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      ctx.reply(`🔗 <b>Referral Link</b>\n\nမိတ်ဆွေ ဖြည့်တိုင်း/ဆော့တိုင်း Commission ရမည်!\n\n<code>${link}</code>`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.url('📤 Share',`https://t.me/share/url?url=${encodeURIComponent(link)}`)]])}
      ).catch(()=>{});
    } catch {}
  });

  bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.reply('🛡️ Admin Panel',
      Markup.inlineKeyboard([[Markup.button.webApp('🛡️ ဝင်ရောက်မည်', `${FRONTEND_URL}/admin.html`)]])
    ).catch(()=>{});
  });

  bot.command('agent', async (ctx) => {
    const u = await User.findOne({ telegramId: ctx.from.id }).lean();
    if (!u || u.role !== 'agent') return ctx.reply('🚫 Agent မဟုတ်သေးပါ').catch(()=>{});
    ctx.reply('🎯 Agent Panel',
      Markup.inlineKeyboard([[Markup.button.webApp('🎯 ဝင်ရောက်မည်', `${FRONTEND_URL}/agent.html`)]])
    ).catch(()=>{});
  });

  bot.catch((err) => { console.error('Bot err:', err.message); });
  bot.launch().then(()=>console.log('✅ Bot launched')).catch(e=>console.error('Bot launch err:', e.message));
}

// ══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════
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
  req.agentTid = tid;
  req.agentUser = u;
  next();
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTH & USER
// ══════════════════════════════════════════════════════════════════════════
app.get('/', (_, res) => res.json({ ok: true, game: 'Mines', version: '2.0' }));
app.get('/health', (_, res) => res.json({
  ok: true, mongo: isConnected ? 'connected' : 'disconnected',
  uri: activeURI, activeGamesInDB: '(see /api/admin/stats)'
}));

app.post('/api/auth', async (req, res) => {
  try {
    const { initData, telegramId: devId } = req.body;
    let tid, username, firstName;

    if (initData) {
      const u = verifyTg(initData);
      if (!u) return res.status(401).json({ error: 'Telegram auth မှား' });
      ({ id: tid, username = '', first_name: firstName = '' } = u);
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
      if (username   && user.username   !== username)   user.username   = username;
      if (firstName  && user.firstName  !== firstName)  user.firstName  = firstName;
      user.lastActive = new Date();
      await user.save();
    }
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားပါသည်' });

    res.json({
      telegramId: user.telegramId,
      username:   user.username || user.firstName || `User${tid}`,
      firstName:  user.firstName,
      balance:    user.balance,
      referralCode: user.referralCode,
      gamesPlayed: user.gamesPlayed,
      role:       user.role
    });
  } catch (e) { console.error('auth err:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const u = await User.findOne({ telegramId: parseInt(req.params.id) })
      .select('balance gamesPlayed totalBet totalWon role').lean();
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    res.json(u);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  MINES GAME API
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/mines/start
 * Validates bet, deducts balance, creates provably-fair game.
 */
app.post('/api/mines/start', async (req, res) => {
  try {
    const { telegramId, betAmount, bombCount, clientSeed = '' } = req.body;
    const tid   = parseInt(telegramId);
    const bet   = parseInt(betAmount);
    const bombs = parseInt(bombCount);

    // ── Input validation ──────────────────────────────────
    if (!tid || isNaN(bet) || isNaN(bombs))
      return res.status(400).json({ error: 'betAmount / bombCount / telegramId လိုအပ်သည်' });
    if (bet < MIN_BET || bet > MAX_BET)
      return res.status(400).json({ error: `လောင်းကြေး ${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()} ကျပ် ဖြစ်ရမည်` });
    if (bombs < 1 || bombs > 24)
      return res.status(400).json({ error: 'ဗုံး ၁–၂၄ လုံး ဖြစ်ရမည်' });

    // ── Check existing active game ────────────────────────
    const existing = await Game.findOne({ userId: tid, status: 'active' }).lean();
    if (existing) return res.status(400).json({
      error: 'ဆော့နေဆဲ ဂိမ်းရှိသည် — Cash Out ဦးပေးပါ',
      gameId: existing.gameId
    });

    // ── Atomically deduct balance (backend security) ──────
    const user = await User.findOneAndUpdate(
      { telegramId: tid, balance: { $gte: bet }, isBanned: { $ne: true } },
      { $inc: { balance: -bet }, lastActive: new Date() },
      { new: true }
    );
    if (!user) {
      const u = await User.findOne({ telegramId: tid }).select('balance isBanned').lean();
      if (!u)          return res.status(404).json({ error: 'User မတွေ့ပါ' });
      if (u.isBanned)  return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားသည်' });
      return res.status(400).json({ error: `လောင်းကြေး မလောက်ပါ (ကျန်: ${u.balance.toLocaleString()} MMK)`, balance: u.balance });
    }

    // ── Provably fair setup ───────────────────────────────
    const serverSeed     = genId(32);
    const serverSeedHash = sha256(serverSeed);
    const usedClientSeed = clientSeed.trim() || String(tid);
    const bombs_pos      = placeBombs(serverSeed, usedClientSeed, bombs);
    const gameId         = 'MG' + Date.now().toString(36).toUpperCase() + genId(3).toUpperCase();

    await new Game({
      gameId, userId: tid, betAmount: bet, bombCount: bombs,
      serverSeed, serverSeedHash, clientSeed: usedClientSeed,
      bombPositions: bombs_pos, revealedTiles: [], status: 'active'
    }).save();

    // Multiplier preview table (1 safe tile → all safe tiles)
    const safe    = GRID_SIZE - bombs;
    const preview = [];
    for (let k = 1; k <= Math.min(safe, 10); k++) preview.push({ step: k, mult: calcMultiplier(bombs, k) });

    res.json({
      ok:              true,
      gameId,
      serverSeedHash,
      clientSeed:      usedClientSeed,
      bombCount:       bombs,
      betAmount:       bet,
      newBalance:      user.balance,
      multiplierPreview: preview,
      currentMultiplier: 1.00
    });
  } catch (e) { console.error('mines/start:', e.message); res.status(500).json({ error: 'Server error' }); }
});

/**
 * POST /api/mines/reveal
 * Reveal one tile. Returns gem/bomb + updated multiplier.
 */
app.post('/api/mines/reveal', async (req, res) => {
  try {
    const { gameId, tileIndex, telegramId } = req.body;
    const tid  = parseInt(telegramId);
    const tile = parseInt(tileIndex);

    if (isNaN(tile) || tile < 0 || tile >= GRID_SIZE)
      return res.status(400).json({ error: 'Tile index မမှန်ပါ' });

    const game = await Game.findOne({ gameId, userId: tid, status: 'active' });
    if (!game) return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (game.revealedTiles.includes(tile))
      return res.status(400).json({ error: 'ကွက်ဒီနေရာ ဖွင့်ပြီးသားဖြစ်သည်' });

    const isBomb = game.bombPositions.includes(tile);

    if (isBomb) {
      // ── BOMB HIT ──────────────────────────────────────────
      game.status     = 'exploded';
      game.multiplier = 0;
      game.payout     = 0;
      game.revealedTiles.push(tile);
      await game.save();

      await User.findOneAndUpdate({ telegramId: tid }, { $inc: { gamesPlayed: 1, totalBet: game.betAmount } });
      await payTurnoverCommission(tid, game.betAmount);

      res.json({
        ok:           true,
        result:       'bomb',
        tile,
        bombPositions: game.bombPositions,  // reveal all bombs
        serverSeed:   game.serverSeed,      // reveal seed for verification
        clientSeed:   game.clientSeed,
        serverSeedHash: game.serverSeedHash,
        payout:       0,
        newBalance:   (await User.findOne({ telegramId: tid }).select('balance').lean())?.balance || 0
      });

    } else {
      // ── GEM FOUND ─────────────────────────────────────────
      game.revealedTiles.push(tile);
      const safeCount  = game.revealedTiles.length;
      const multiplier = calcMultiplier(game.bombCount, safeCount);
      const payout     = calcPayout(game.betAmount, multiplier);

      // Check if all safe tiles revealed → auto cashout
      const allSafeRevealed = (safeCount >= GRID_SIZE - game.bombCount);
      if (allSafeRevealed) {
        game.status     = 'cashout';
        game.multiplier = multiplier;
        game.payout     = payout;
        await game.save();

        const u = await User.findOneAndUpdate(
          { telegramId: tid },
          { $inc: { balance: payout, gamesPlayed: 1, totalBet: game.betAmount, totalWon: payout } },
          { new: true }
        );
        await payTurnoverCommission(tid, game.betAmount);

        return res.json({
          ok:           true,
          result:       'gem',
          tile,
          multiplier,
          payout,
          newBalance:   u.balance,
          autoWin:      true,
          bombPositions: game.bombPositions,
          serverSeed:   game.serverSeed,
          clientSeed:   game.clientSeed,
          serverSeedHash: game.serverSeedHash,
          revealedTiles: game.revealedTiles
        });
      }

      game.multiplier = multiplier;
      await game.save();

      res.json({
        ok:            true,
        result:        'gem',
        tile,
        multiplier,
        payout,          // potential payout if cashed out now
        revealedTiles:  game.revealedTiles,
        revealedCount:  safeCount
      });
    }
  } catch (e) { console.error('mines/reveal:', e.message); res.status(500).json({ error: 'Server error' }); }
});

/**
 * POST /api/mines/cashout
 * Cash out current winnings.
 */
app.post('/api/mines/cashout', async (req, res) => {
  try {
    const { gameId, telegramId } = req.body;
    const tid = parseInt(telegramId);

    const game = await Game.findOne({ gameId, userId: tid, status: 'active' });
    if (!game) return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (game.revealedTiles.length === 0)
      return res.status(400).json({ error: 'အနည်းဆုံး ကွက်တစ်ကွက် ဖွင့်မှ Cash Out လုပ်နိုင်သည်' });

    const multiplier = calcMultiplier(game.bombCount, game.revealedTiles.length);
    const payout     = calcPayout(game.betAmount, multiplier);

    game.status     = 'cashout';
    game.multiplier = multiplier;
    game.payout     = payout;
    await game.save();

    const u = await User.findOneAndUpdate(
      { telegramId: tid },
      { $inc: { balance: payout, gamesPlayed: 1, totalBet: game.betAmount, totalWon: payout } },
      { new: true }
    );
    await payTurnoverCommission(tid, game.betAmount);

    res.json({
      ok:           true,
      multiplier,
      payout,
      newBalance:   u.balance,
      bombPositions: game.bombPositions,
      serverSeed:   game.serverSeed,
      clientSeed:   game.clientSeed,
      serverSeedHash: game.serverSeedHash,
      revealedTiles: game.revealedTiles
    });
  } catch (e) { console.error('mines/cashout:', e.message); res.status(500).json({ error: 'Server error' }); }
});

/**
 * GET /api/mines/active/:telegramId
 * Resume active game on page reload.
 */
app.get('/api/mines/active/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const game = await Game.findOne({ userId: tid, status: 'active' }).lean();
    if (!game) return res.json({ active: false });
    res.json({
      active:         true,
      gameId:         game.gameId,
      betAmount:      game.betAmount,
      bombCount:      game.bombCount,
      serverSeedHash: game.serverSeedHash,
      clientSeed:     game.clientSeed,
      revealedTiles:  game.revealedTiles,
      multiplier:     calcMultiplier(game.bombCount, game.revealedTiles.length),
      payout:         calcPayout(game.betAmount, calcMultiplier(game.bombCount, game.revealedTiles.length))
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

/**
 * GET /api/mines/history/:telegramId
 * Last 20 completed games for a user.
 */
app.get('/api/mines/history/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const list = await Game.find({ userId: tid, status: { $ne: 'active' } })
      .sort({ createdAt: -1 }).limit(20)
      .select('gameId betAmount bombCount multiplier payout status createdAt revealedTiles').lean();
    res.json(list);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  DEPOSIT / WITHDRAW
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount, paymentMethod } = req.body;
    if (!telegramId || !kpayName || !transactionId || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်တွေ ဖြည့်ပေးပါ' });
    const amt = parseInt(amount);
    if (amt < 500) return res.status(400).json({ error: 'အနည်းဆုံး 500 MMK' });

    const u = await User.findOne({ telegramId: parseInt(telegramId) }).lean();
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    if (await Deposit.findOne({ transactionId }).lean())
      return res.status(400).json({ error: 'Transaction ID ကို အသုံးပြုပြီးသည်' });

    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    const dep    = await new Deposit({ userId: u.telegramId, kpayName, transactionId, amount: amt, paymentMethod: method }).save();

    if (bot && ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID,
      `💰 <b>Deposit တောင်းဆိုမှု</b>\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ် (${method.toUpperCase()})\n📝 ${kpayName}\n🔢 <code>${transactionId}</code>`,
      { parse_mode:'HTML' }).catch(()=>{});

    res.json({ ok: true, depositId: dep._id });
  } catch (e) { console.error('deposit:', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount, paymentMethod } = req.body;
    if (!telegramId || !kpayName || !kpayNumber || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်တွေ ဖြည့်ပေးပါ' });
    const amt = parseInt(amount);
    const tid = parseInt(telegramId);
    if (amt < 2500) return res.status(400).json({ error: 'အနည်းဆုံး 2,500 MMK' });

    const u = await User.findOne({ telegramId: tid }).select('balance isBanned firstName username').lean();
    if (!u)        return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    if (u.balance < amt) return res.status(400).json({ error: `လက်ကျန် မလောက်ပါ (ကျန်: ${u.balance.toLocaleString()})`, balance: u.balance });

    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    const wd     = await new Withdrawal({ userId: tid, kpayName, kpayNumber, amount: amt, paymentMethod: method }).save();
    const upd    = await User.findOneAndUpdate({ telegramId: tid, balance: { $gte: amt } }, { $inc: { balance: -amt } }, { new: true });
    if (!upd) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      return res.status(400).json({ error: 'လက်ကျန် မလောက်ပါ' });
    }

    if (bot && ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID,
      `💸 <b>Withdrawal တောင်းဆိုမှု</b>\n👤 ${u.firstName||u.username} (${tid})\n💵 ${amt.toLocaleString()} ကျပ် (${method.toUpperCase()})\n📱 ${kpayNumber} — ${kpayName}`,
      { parse_mode:'HTML' }).catch(()=>{});

    res.json({ ok: true, newBalance: upd.balance });
  } catch (e) { console.error('withdraw:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  REFERRAL / REDEEM
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/referrals/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const refs = await User.find({ referredBy: tid }).select('firstName username balance gamesPlayed createdAt').sort({ createdAt: -1 }).lean();
    res.json({ total: refs.length, referrals: refs.map(u => ({
      name: u.firstName || u.username || `User${u.telegramId}`,
      username: u.username, balance: u.balance,
      gamesPlayed: u.gamesPlayed, joinedAt: u.createdAt
    })) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/redeem', async (req, res) => {
  try {
    const { telegramId, code } = req.body;
    const tid = parseInt(telegramId);
    const u   = await User.findOne({ telegramId: tid }).lean();
    if (!u)        return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (u.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    const rc = await Redeem.findOne({ code: code?.toUpperCase().trim() });
    if (!rc || !rc.isActive) return res.status(400).json({ error: 'Code မမှန်ပါ' });
    if (rc.usedBy.includes(tid)) return res.status(400).json({ error: 'Code အသုံးပြုပြီး' });
    if (rc.maxUses > 0 && rc.usedBy.length >= rc.maxUses) return res.status(400).json({ error: 'Code ကုန်ဆုံးပြီ' });
    await Redeem.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const upd = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: rc.amount } }, { new: true });
    res.json({ ok: true, amount: rc.amount, newBalance: upd.balance });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  PAYMENT INFO (admin / agent kpay)
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/payment-info/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const user = await User.findOne({ telegramId: tid }).select('referredBy').lean();
    const def  = {
      kpayNumber: process.env.ADMIN_KPAY_NUMBER || '09000000000',
      kpayName:   process.env.ADMIN_KPAY_NAME   || 'Admin',
      hasWave:    !!(process.env.ADMIN_WAVE_NUMBER),
      waveNumber: process.env.ADMIN_WAVE_NUMBER  || '',
      waveName:   process.env.ADMIN_WAVE_NAME    || '',
      isAgent:    false
    };
    if (!user?.referredBy) return res.json(def);
    const ag = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!ag?.agentKpayNumber) return res.json(def);
    res.json({
      kpayNumber: ag.agentKpayNumber,
      kpayName:   ag.agentKpayName || '',
      hasWave:    ag.hasWave,
      waveNumber: ag.waveNumber || '',
      waveName:   ag.agentKpayName || '',
      isAgent:    true
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/verify', async (req, res) => {
  const tid = parseInt(req.body.telegramId);
  if (!tid || tid !== ADMIN_ID) return res.status(403).json({ error: 'Admin မဟုတ်ပါ' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', isAdmin, async (_, res) => {
  try {
    const [users, games, pdep, pwd] = await Promise.all([
      User.countDocuments(), Game.countDocuments({ status: { $ne: 'active' } }),
      Deposit.countDocuments({ status: 'pending' }), Withdrawal.countDocuments({ status: 'pending' })
    ]);
    const [depAgg, wdAgg, gameAgg] = await Promise.all([
      Deposit.aggregate([{ $match: { status:'confirmed' } }, { $group: { _id:null, t:{ $sum:'$amount' } } }]),
      Withdrawal.aggregate([{ $match: { status:'confirmed' } }, { $group: { _id:null, t:{ $sum:'$amount' } } }]),
      Game.aggregate([{ $match:{ status:{ $ne:'active' } } }, { $group:{ _id:null, bet:{ $sum:'$betAmount' }, won:{ $sum:'$payout' }, games:{ $sum:1 } } }])
    ]);
    const totalBet = gameAgg[0]?.bet || 0;
    const totalWon = gameAgg[0]?.won || 0;
    res.json({
      users, games, pdep, pwd,
      totalDeposited: depAgg[0]?.t || 0,
      totalWithdrawn: wdAgg[0]?.t || 0,
      totalBet, totalWon,
      houseProfit:    totalBet - totalWon,
      activeGames:    await Game.countDocuments({ status: 'active' })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', isAdmin, async (_, res) => {
  const maint = await getSetting('maintenance', false);
  res.json({ maintenance: maint, minBet: MIN_BET, maxBet: MAX_BET, rtp: RTP, gridSize: GRID_SIZE });
});

app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
  await setSetting('maintenance', !!req.body.enabled);
  res.json({ ok: true, maintenance: !!req.body.enabled });
});

// Deposits (admin)
app.get('/api/admin/deposits', isAdmin, async (req, res) => {
  try {
    // Exclude agent-referred users (agents handle those)
    const agentIds   = (await User.find({ role: 'agent' }).select('telegramId').lean()).map(a => a.telegramId);
    const refUserIds = agentIds.length
      ? (await User.find({ referredBy: { $in: agentIds } }).select('telegramId').lean()).map(u => u.telegramId)
      : [];
    const q = { status: req.query.status || 'pending' };
    if (refUserIds.length) q.userId = { $nin: refUserIds };
    const deps = await Deposit.find(q).sort({ createdAt: -1 }).limit(50).lean();
    const out  = await Promise.all(deps.map(async d => {
      const u = await User.findOne({ telegramId: d.userId }).select('firstName username').lean();
      return { ...d, userName: u?.firstName || u?.username || String(d.userId) };
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { status: 'confirmed', processedAt: new Date(), expireAt: new Date(Date.now() + 72*3600*1000) },
      { new: true }
    );
    if (!dep) return res.status(404).json({ error: 'Deposit မတွေ့ပါ' });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });
    await payDepositCommission(dep.userId, dep.amount);
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် ဖြည့်မှု အတည်ပြုပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async (req, res) => {
  try {
    const dep = await Deposit.findByIdAndUpdate(req.params.id,
      { status:'rejected', processedAt: new Date(), expireAt: new Date(Date.now()+72*3600*1000) }, { new:true });
    if (!dep) return res.status(404).json({ error: 'Deposit မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေဖြည့် ပယ်ချပြီ${req.body.reason ? `\nအကြောင်းပြချက်: ${req.body.reason}` : ''}`).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Withdrawals (admin)
app.get('/api/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const wds = await Withdrawal.find({ status: req.query.status || 'pending' }).sort({ createdAt: -1 }).limit(50).lean();
    const out = await Promise.all(wds.map(async w => {
      const u = await User.findOne({ telegramId: w.userId }).select('firstName username balance').lean();
      return { ...w, userName: u?.firstName||u?.username||String(w.userId), userBalance: u?.balance };
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { status:'confirmed', processedAt: new Date(), expireAt: new Date(Date.now()+72*3600*1000) },
      { new: true }
    );
    if (!wd) return res.status(404).json({ error: 'Withdrawal မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(wd.userId, `✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး 🎉`).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async (req, res) => {
  try {
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'မတွေ့ပါ / ပြင်ဆင်ပြီး' });
    wd.status = 'rejected'; wd.processedAt = new Date(); wd.expireAt = new Date(Date.now()+72*3600*1000);
    await wd.save();
    await User.findOneAndUpdate({ telegramId: wd.userId }, { $inc: { balance: wd.amount } });
    if (bot) bot.telegram.sendMessage(wd.userId, `❌ ငွေထုတ် ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Users (admin)
app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const { search='', page=1 } = req.query;
    const q = search ? { $or:[
      { telegramId: isNaN(search) ? -1 : parseInt(search) },
      { username:   { $regex: search, $options:'i' } },
      { firstName:  { $regex: search, $options:'i' } }
    ]} : {};
    const [users, total] = await Promise.all([
      User.find(q).sort({ createdAt:-1 }).skip((+page-1)*20).limit(20).lean(),
      User.countDocuments(q)
    ]);
    res.json({ users, total, pages: Math.ceil(total/20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async (req, res) => {
  try {
    const u = await User.findOneAndUpdate({ telegramId: parseInt(req.params.tid) },
      { $inc: { balance: parseInt(req.body.amount) } }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(u.telegramId,
      `💰 Admin မှ ${parseInt(req.body.amount)>0?'+':''}${parseInt(req.body.amount).toLocaleString()} ကျပ်${req.body.reason?'\n'+req.body.reason:''}\nကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});
    res.json({ ok: true, newBalance: u.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async (req, res) => {
  try {
    const u = await User.findOneAndUpdate({ telegramId: parseInt(req.params.tid) },
      { isBanned: !!req.body.ban }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/role', isAdmin, async (req, res) => {
  try {
    const tid  = parseInt(req.params.tid);
    const role = req.body.role; // 'user' | 'agent'
    const u    = await User.findOneAndUpdate({ telegramId: tid }, { role }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (role === 'agent') {
      await Agent.findOneAndUpdate({ telegramId: tid },
        { $setOnInsert: { telegramId: tid, referralCode: u.referralCode, depositPct: 0, turnoverPct: 0 } },
        { upsert: true });
      if (bot) bot.telegram.sendMessage(tid,
        `🎯 Agent အဖြစ် ခွင့်ပြုပြီ!\n/agent နှိပ်ပါ`, { parse_mode:'HTML' }).catch(()=>{});
    }
    res.json({ ok: true, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Agent commission ─────────────────────────────────────────────────────
app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { page=1, search='' } = req.query;
    const q = { role:'agent' };
    if (search) {
      const tid = isNaN(search) ? null : parseInt(search);
      q.$or = [...(tid?[{telegramId:tid}]:[]),{username:{$regex:search,$options:'i'}},{firstName:{$regex:search,$options:'i'}}];
    }
    const [agents, total] = await Promise.all([
      User.find(q).sort({ createdAt:-1 }).skip((+page-1)*20).limit(20).lean(),
      User.countDocuments(q)
    ]);
    const out = await Promise.all(agents.map(async u => {
      const ag  = await Agent.findOne({ telegramId: u.telegramId }).lean();
      const cnt = await User.countDocuments({ referredBy: u.telegramId });
      return { ...u, agentData: ag, referralCount: cnt };
    }));
    res.json({ agents: out, total, pages: Math.ceil(total/20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Admin sets per-agent commission percentages */
app.post('/api/admin/agents/:tid/commission', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { depositPct, turnoverPct } = req.body;
    if (depositPct  < 0 || depositPct  > 100) return res.status(400).json({ error: 'depositPct 0–100' });
    if (turnoverPct < 0 || turnoverPct > 100) return res.status(400).json({ error: 'turnoverPct 0–100' });
    const ag = await Agent.findOneAndUpdate(
      { telegramId: tid },
      { $set: { depositPct: +depositPct, turnoverPct: +turnoverPct } },
      { new: true, upsert: true }
    );
    if (bot) bot.telegram.sendMessage(tid,
      `💹 Commission အပ်ဒိတ်\nDeposit: ${depositPct}% | Turnover: ${turnoverPct}%`).catch(()=>{});
    res.json({ ok: true, depositPct: ag.depositPct, turnoverPct: ag.turnoverPct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/kpay', isAdmin, async (req, res) => {
  try {
    const { kpayNumber, kpayName, hasWave, waveNumber } = req.body;
    await Agent.findOneAndUpdate({ telegramId: parseInt(req.params.tid) },
      { $set: { agentKpayNumber: kpayNumber||'', agentKpayName: kpayName||'', hasWave:!!hasWave, waveNumber:waveNumber||'' } },
      { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const amt = parseInt(req.body.amount);
    if (isNaN(amt)) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const u = await User.findOneAndUpdate({ telegramId: tid, role:'agent' },
      { $inc: { balance: amt } }, { new: true });
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(tid,
      `💰 Admin မှ ${amt>0?'+':''}${amt.toLocaleString()} ကျပ\nကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});
    res.json({ ok: true, newBalance: u.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Broadcast
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
  const { message, buttonText, buttonUrl } = req.body;
  if (!message || !bot) return res.status(400).json({ error: 'message required' });
  res.json({ ok: true });
  setImmediate(async () => {
    const users = await User.find({ isBanned: { $ne:true } }).select('telegramId').lean();
    const kb    = buttonText && buttonUrl ? { inline_keyboard:[[{ text:buttonText, url:buttonUrl }]] } : undefined;
    let sent=0;
    for (let i=0; i<users.length; i+=25) {
      await Promise.allSettled(users.slice(i,i+25).map(async u => {
        try { await bot.telegram.sendMessage(u.telegramId, message, { parse_mode:'HTML', reply_markup: kb }); sent++; }
        catch {}
      }));
      if (i+25 < users.length) await new Promise(r=>setTimeout(r,1000));
    }
    console.log(`Broadcast done: ${sent}/${users.length}`);
  });
});

// Redeem (admin)
app.post('/api/admin/redeem/create', isAdmin, async (req, res) => {
  try {
    const { code, amount, maxUses=1 } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code + amount လိုသည်' });
    const rc = await new Redeem({ code: code.toUpperCase().trim(), amount: parseInt(amount), maxUses: parseInt(maxUses) }).save();
    res.json({ ok: true, code: rc });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Code ရှိပြီး' });
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/admin/redeem', isAdmin, async (_, res) => {
  res.json(await Redeem.find().sort({ createdAt:-1 }).lean());
});
app.delete('/api/admin/redeem/:id', isAdmin, async (req, res) => {
  await Redeem.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ── Agent deposit management ─────────────────────────────────────────────
app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const ag  = await Agent.findOne({ telegramId: req.agentTid }).lean();
    const cnt = await User.countDocuments({ referredBy: req.agentTid });
    const refs = (await User.find({ referredBy: req.agentTid }).select('telegramId').lean()).map(u=>u.telegramId);
    const salesAgg = refs.length ? await Deposit.aggregate([
      { $match: { userId:{ $in:refs }, status:'confirmed' } },
      { $group: { _id:null, t:{ $sum:'$amount' } } }
    ]) : [];
    res.json({
      ...req.agentUser,
      agentData:      ag,
      referralCount:  cnt,
      totalSales:     salesAgg[0]?.t || 0,
      botUsername:    BOT_USERNAME
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const refs = await User.find({ referredBy: req.agentTid })
      .select('firstName username balance gamesPlayed createdAt').sort({ createdAt:-1 }).lean();
    res.json({ total: refs.length, referrals: refs.map(u=>({
      name: u.firstName||u.username||`User${u.telegramId}`,
      username: u.username, balance: u.balance,
      gamesPlayed: u.gamesPlayed, joinedAt: u.createdAt
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const refs    = await User.find({ referredBy: req.agentTid }).select('telegramId firstName username').lean();
    if (!refs.length) return res.json([]);
    const refIds  = refs.map(u=>u.telegramId);
    const userMap = Object.fromEntries(refs.map(u=>[u.telegramId, u.firstName||u.username||`User${u.telegramId}`]));
    const deps    = await Deposit.find({ userId:{ $in:refIds }, status: req.query.status||'pending' })
      .sort({ createdAt:-1 }).limit(50).lean();
    res.json(deps.map(d=>({ ...d, userName: userMap[d.userId]||String(d.userId) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status:'pending' },
      { $set:{ status:'confirming' } }, { new:false }
    );
    if (!dep) return res.status(400).json({ error: 'မတွေ့ပါ / ပြင်ဆင်ပြီး' });
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== req.agentTid) {
      await Deposit.findByIdAndUpdate(dep._id, { $set:{ status:'pending' } });
      return res.status(403).json({ error: 'ဤ User သင့် Referral မဟုတ်ပါ' });
    }
    const ag = await User.findOne({ telegramId: req.agentTid }).lean();
    if (!ag || ag.balance < dep.amount) {
      await Deposit.findByIdAndUpdate(dep._id, { $set:{ status:'pending' } });
      return res.status(402).json({ error: `Agent balance မလောက်ပါ (ကျန်: ${ag?.balance||0})`, insufficientBalance:true });
    }
    await Deposit.findByIdAndUpdate(dep._id,
      { $set:{ status:'confirmed', processedAt:new Date(), processedBy:'agent', expireAt:new Date(Date.now()+72*3600*1000) } });
    await User.findOneAndUpdate({ telegramId: req.agentTid }, { $inc:{ balance: -dep.amount } });
    await User.findOneAndUpdate({ telegramId: dep.userId   }, { $inc:{ balance:  dep.amount } });
    await payDepositCommission(dep.userId, dep.amount);
    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် ဖြည့်မှု အတည်ပြုပြီး 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status:'pending' },
      { status:'rejected', processedAt:new Date(), processedBy:'agent', expireAt:new Date(Date.now()+72*3600*1000) },
      { new:true }
    );
    if (!dep) return res.status(400).json({ error: 'မတွေ့ပါ' });
    if (dep.userId && bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေဖြည့် ပယ်ချပြီ${req.body.reason?'\n'+req.body.reason:''}`).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Self-ping (keep Render free-tier alive) ──────────────────────────────
setInterval(() => {
  httpsLib.get(`${BACKEND_URL}/health`, ()=>{}).on('error', ()=>{});
}, 4 * 60 * 1000); // every 4 min

// ── Global error handlers ─────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('UnhandledRejection:', r));
process.on('uncaughtException',  e => console.error('UncaughtException:', e.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Mines backend on port ${PORT}`));
