const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://minefrontend.vercel.app';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://minebackend-dyyq.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME  || 'winnermine_bot';

// 3 days TTL constant
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// ===== MongoDB Dual Connection =====
let isConnected = false;
async function connectDB() {
  const uris = [process.env.MONGODB_URI1, process.env.MONGODB_URI2].filter(Boolean);
  for (const uri of uris) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      isConnected = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (e) { console.error('❌ MongoDB failed:', e.message); }
  }
  setTimeout(connectDB, 10000);
}
mongoose.connection.on('disconnected', () => { isConnected = false; });
mongoose.connection.on('reconnected',  () => { isConnected = true; });
connectDB();

// ===== Schemas =====
const userSchema = new mongoose.Schema({
  telegramId:   { type: Number, required: true, unique: true },
  username:     { type: String, default: '' },
  firstName:    { type: String, default: '' },
  balance:      { type: Number, default: 0 },
  referredBy:   { type: Number, default: null },
  referralCode: { type: String, unique: true, sparse: true },
  totalGames:   { type: Number, default: 0 },
  wins:         { type: Number, default: 0 },
  losses:       { type: Number, default: 0 },
  totalWon:     { type: Number, default: 0 },
  totalWagered: { type: Number, default: 0 },
  isBanned:     { type: Boolean, default: false },
  role:         { type: String, enum: ['user','agent'], default: 'user' },
  lastActive:   { type: Date, default: Date.now },
  createdAt:    { type: Date, default: Date.now },
  // 4-level referral commission earnings
  refEarnings:  {
    level1: { type: Number, default: 0 },  // Direct invitees' bets
    level2: { type: Number, default: 0 },
    level3: { type: Number, default: 0 },
    level4: { type: Number, default: 0 },
    total:  { type: Number, default: 0 }
  }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });

// ── Deposit Schema ──────────────────────────────────────────────────────────
// expireAt is set on ALL records at creation (pending → 3 days from now).
// When confirmed/rejected, expireAt resets to 3 days from processedAt.
// MongoDB TTL index fires at expireAt=0 meaning "expire when this date passes".
const depositSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  kpayName:      String,
  transactionId: { type: String, required: true, unique: true },
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status:        { type: String, enum: ['pending','confirming','confirmed','rejected'], default: 'pending' },
  processedBy:   { type: String, enum: ['admin','agent'], default: 'admin' },
  rejectionNote: { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date,
  expireAt:      { type: Date, default: () => new Date(Date.now() + THREE_DAYS_MS) }
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ userId: 1 });
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// ── Withdrawal Schema ───────────────────────────────────────────────────────
const withdrawalSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  kpayName:      String,
  kpayNumber:    String,
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status:        { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  rejectionNote: { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
  processedAt:   Date,
  expireAt:      { type: Date, default: () => new Date(Date.now() + THREE_DAYS_MS) }
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ userId: 1 });
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// Mines Game Schema
const minesGameSchema = new mongoose.Schema({
  gameId:           { type: String, required: true, unique: true },
  userId:           { type: Number, required: true },
  betAmount:        { type: Number, required: true },
  bombCount:        { type: Number, required: true },
  serverSeed:       { type: String, required: true },
  hashedServerSeed: { type: String, required: true },
  clientSeed:       { type: String, required: true },
  bombPositions:    [Number],
  revealedCells:    { type: [Number], default: [] },
  currentMultiplier:{ type: Number, default: 1 },
  status:           { type: String, enum: ['active','cashout','exploded'], default: 'active' },
  winAmount:        { type: Number, default: 0 },
  explodedCell:     { type: Number, default: null },
  createdAt:        { type: Date, default: Date.now, expires: 86400 * 3 }   // 3 days
});
minesGameSchema.index({ userId: 1, status: 1 });
minesGameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const redeemCodeSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:    { type: Number, required: true },
  maxUses:   { type: Number, default: 1 },
  usedBy:    [{ type: Number }],
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
redeemCodeSchema.index({ code: 1 });

const agentSchema = new mongoose.Schema({
  telegramId:            { type: Number, required: true, unique: true },
  referralCode:          { type: String },
  agentKpayNumber:       { type: String, default: '' },
  agentKpayName:         { type: String, default: '' },
  hasWave:               { type: Boolean, default: false },
  agentWaveNumber:       { type: String, default: '' },
  agentWaveName:         { type: String, default: '' },
  depositCommission:     { type: Number, default: 0, min: 0, max: 50 },
  turnoverCommission:    { type: Number, default: 0, min: 0, max: 10 },
  totalCommissionEarned: { type: Number, default: 0 },
  isActive:              { type: Boolean, default: true },
  createdAt:             { type: Date, default: Date.now }
});
agentSchema.index({ telegramId: 1 });

const User       = mongoose.model('User',       userSchema);
const Deposit    = mongoose.model('Deposit',    depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const MinesGame  = mongoose.model('MinesGame',  minesGameSchema);
const Settings   = mongoose.model('Settings',   settingsSchema);
const RedeemCode = mongoose.model('RedeemCode', redeemCodeSchema);
const Agent      = mongoose.model('Agent',      agentSchema);

// ===== Helpers =====
function genRefCode(id) {
  return 'MINE' + id.toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
}
function genGameId() {
  return 'mg' + Date.now() + Math.random().toString(36).substr(2,5);
}

function verifyTgAuth(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const check = Array.from(p.entries())
      .filter(([k]) => k !== 'hash')
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256',secret).update(check).digest('hex');
    if (hmac !== hash) return null;
    const u = p.get('user');
    return u ? JSON.parse(u) : null;
  } catch { return null; }
}

async function getSetting(key, def) {
  try { const s = await Settings.findOne({key}).lean(); return s ? s.value : def; } catch { return def; }
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({key},{value},{upsert:true});
}

// ===== Mines Game Core Logic =====
const TOTAL_TILES = 25;

function generateBombPositions(serverSeed, clientSeed, bombCount) {
  const combined = `${clientSeed}`;
  const hmac = crypto.createHmac('sha256', serverSeed).update(combined).digest('hex');
  const positions = Array.from({length: TOTAL_TILES}, (_, i) => i);
  for (let i = TOTAL_TILES - 1; i > 0; i--) {
    const offset = (i * 4) % (hmac.length - 4);
    const rand = parseInt(hmac.slice(offset, offset + 4), 16);
    const j = rand % (i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, bombCount).sort((a, b) => a - b);
}

function calcMultiplier(bombCount, revealed) {
  if (revealed === 0) return 1.00;
  let mult = 1;
  for (let i = 0; i < revealed; i++) {
    mult *= (TOTAL_TILES - i) / (TOTAL_TILES - bombCount - i);
  }
  mult *= 0.94; // 6% house edge
  return Math.max(1.01, Math.round(mult * 100) / 100);
}

// ═══════════════════════════════════════════════════════════════════
// 4-LEVEL REFERRAL COMMISSION SYSTEM
//
//  Level 1 (direct inviter of bettor):  1.000% of bet
//  Level 2 (inviter's inviter):          0.500% of bet
//  Level 3 (3 levels up):               0.250% of bet
//  Level 4 (4 levels up):               0.125% of bet
//
//  These stack on top of Agent % commission (if the upline is an agent).
// ═══════════════════════════════════════════════════════════════════
const REF_RATES = [0.01, 0.005, 0.0025, 0.00125]; // L1 … L4

async function distributeReferralCommission(bettorId, betAmount) {
  try {
    let currentId = bettorId;

    for (let level = 0; level < REF_RATES.length; level++) {
      // Walk up one step in the referral chain
      const player = await User.findOne({ telegramId: currentId })
        .select('referredBy').lean();
      if (!player || !player.referredBy) break; // chain ended

      const uplineId    = player.referredBy;
      const rate        = REF_RATES[level];
      const commission  = Math.floor(betAmount * rate);   // floor to integer MMK
      if (commission <= 0) { currentId = uplineId; continue; }

      const levelKey = `refEarnings.level${level + 1}`;

      // Credit upline balance + track per-level earnings
      await User.findOneAndUpdate(
        { telegramId: uplineId },
        { $inc: { balance: commission, [levelKey]: commission, 'refEarnings.total': commission } }
      );

      // If upline is an agent, also track in Agent collection
      const uplineUser = await User.findOne({ telegramId: uplineId })
        .select('role').lean();
      if (uplineUser?.role === 'agent') {
        await Agent.findOneAndUpdate(
          { telegramId: uplineId },
          { $inc: { totalCommissionEarned: commission } }
        );
      }

      // Telegram notification (non-blocking, only for level 1 to avoid spam)
      if (bot && level === 0) {
        bot.telegram.sendMessage(uplineId,
          `💰 <b>Referral Commission!</b>\n🎮 Level ${level + 1}: <b>+${commission.toLocaleString()} MMK</b>\n(${(rate * 100).toFixed(3)}% of ${betAmount.toLocaleString()} MMK)`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      currentId = uplineId; // move further up the chain
    }
  } catch(e) { console.error('distributeReferralCommission err:', e.message); }
}

// ===== Agent % Commission Helper (Deposit commission for agents) =====
async function creditAgentCommission(userId, amount, type = 'turnover') {
  try {
    const user = await User.findOne({ telegramId: userId }).select('referredBy').lean();
    if (!user?.referredBy) return;

    const agentUser = await User.findOne({ telegramId: user.referredBy, role: 'agent' }).lean();
    if (!agentUser) return;

    const agentDoc = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!agentDoc) return;

    const rate = type === 'deposit' ? (agentDoc.depositCommission || 0) : (agentDoc.turnoverCommission || 0);
    if (rate <= 0) return;

    const commission = Math.floor(amount * rate / 100);
    if (commission <= 0) return;

    await User.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { balance: commission } });
    await Agent.findOneAndUpdate({ telegramId: user.referredBy }, { $inc: { totalCommissionEarned: commission } });

    if (bot) {
      const label = type === 'deposit' ? '💵 Deposit' : '🎮 Turnover';
      bot.telegram.sendMessage(user.referredBy,
        `💰 <b>Agent Commission ရရှိ!</b>\n${label}: <b>+${commission.toLocaleString()} MMK</b>\n(${rate}% of ${amount.toLocaleString()} MMK)`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch(e) { console.error('creditAgentCommission err:', e.message); }
}

// ===== Telegram Bot =====
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const CHANNEL_USERNAME = 'EzMoneyPayy';
  const CHANNEL_LINK = 'https://t.me/EzMoneyPayy';

  async function isChannelMember(userId) {
    try {
      const m = await bot.telegram.getChatMember(`@${CHANNEL_USERNAME}`, userId);
      return ['member','administrator','creator'].includes(m.status);
    } catch { return false; }
  }

  bot.start(async (ctx) => {
    try {
      const id = ctx.from.id;
      const args = ctx.payload;
      const maint = await getSetting('maintenance', false);
      if (maint && id !== ADMIN_ID) {
        await ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေသောကြောင့် ယာယီပိတ်ထားပါသည်။').catch(() => {});
        return;
      }
      let user = await User.findOne({ telegramId: id });
      if (!user) {
        user = new User({ telegramId: id, username: ctx.from.username||'', firstName: ctx.from.first_name||'', referralCode: genRefCode(id) });
        if (args && args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
      }
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply(
          `👋 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💣 <b>Mines Game</b> ကစားရန် Channel ကို Join ဖြစ်ရပါမည်!`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.url('📢 Channel Join ရန်', CHANNEL_LINK)],
            [Markup.button.callback('✅ Join ပြီးပြီ', 'check_join')]
          ])}
        ).catch(() => {});
        return;
      }
      await ctx.reply(
        `💣 မင်္ဂလာပါ <b>${ctx.from.first_name}</b>!\n\n💰 လက်ကျန်: <b>${user.balance.toLocaleString()} MMK</b>\n🎮 ကစားမှု: ${user.totalGames}  •  🏆 အနိုင်: ${user.wins}`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.webApp('💣 MINES ကစားမည်', FRONTEND_URL)],
          [Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]
        ])}
      ).catch(() => {});
    } catch(e) { console.error('/start err:', e.message); }
  });

  bot.action('check_join', async (ctx) => {
    try {
      await ctx.answerCbQuery('စစ်ဆေးနေပါသည်...').catch(() => {});
      const id = ctx.from.id;
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply('❌ Channel Join မပြုလုပ်ရသေးပါ!', Markup.inlineKeyboard([
          [Markup.button.url('📢 Channel Join', CHANNEL_LINK)],
          [Markup.button.callback('✅ စစ်ဆေးပါ', 'check_join')]
        ])).catch(() => {});
        return;
      }
      const user = await User.findOne({ telegramId: id }).lean();
      await ctx.reply(
        `✅ Join အောင်မြင်!\n💣 Mines Game မင်္ဂလာပါ!\n💰 လက်ကျန်: ${(user?.balance||0).toLocaleString()} MMK`,
        Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])
      ).catch(() => {});
    } catch(e) {}
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      await ctx.reply(
        `💰 လက်ကျန်: <b>${u.balance.toLocaleString()} MMK</b>\n🎮 ကစားမှု: ${u.totalGames} • 🏆 ${u.wins} နိုင် • ❌ ${u.losses} ရှုံး`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])}
      ).catch(() => {});
    } catch(e) {}
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      await ctx.reply(
        `🔗 <b>Referral Link</b>\n\n<code>${link}</code>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('💣 Mines Game ကစားပြီးငွေရှာကြစို့!')}`)]])}
      ).catch(() => {});
    } catch(e) {}
  });

  bot.command('admin', async (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) { await ctx.reply('🚫 Admin မဟုတ်ပါ').catch(() => {}); return; }
    await ctx.reply('🛡️ Admin Panel', { ...Markup.inlineKeyboard([[Markup.button.webApp('🛡️ Admin Panel', `${FRONTEND_URL}/admin.html`)]]) }).catch(() => {});
  });

  bot.command('agent', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!user) { await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(() => {}); return; }
      if (user.role !== 'agent') { await ctx.reply('🚫 Agent မဟုတ်သေးပါ\n\nAdmin ကို ဆက်သွယ်ပါ').catch(() => {}); return; }
      await ctx.reply('🎯 Agent Panel', { ...Markup.inlineKeyboard([[Markup.button.webApp('🎯 Agent Panel', `${FRONTEND_URL}/agent.html`)]]) }).catch(() => {});
    } catch(e) {}
  });

  bot.catch((err, ctx) => {
    if (err.response?.error_code === 403) return;
    console.error('Bot error:', err.message);
  });

  bot.launch().then(() => console.log('✅ Bot launched')).catch(e => console.error('Bot err:', e.message));
}

// ===== Middleware =====
function isAdmin(req, res, next) {
  const aid = parseInt(req.headers['x-admin-id'] || req.query.adminId);
  if (!aid || aid !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!user) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentUser = user;
  next();
}

// ===== Status Routes =====
app.get('/', (_, res) => res.json({ ok: true, game: 'mines' }));
app.get('/health', (_, res) => res.json({ ok: true, mongodb: isConnected ? 'connected' : 'disconnected' }));

// ===== Auth =====
app.post('/api/auth', async (req, res) => {
  try {
    const { initData, telegramId: devId } = req.body;
    let tid, username, firstName;
    if (initData) {
      const u = verifyTgAuth(initData);
      if (!u) return res.status(401).json({ error: 'Telegram auth မှား' });
      tid = u.id; username = u.username||''; firstName = u.first_name||'';
    } else if (devId) {
      tid = parseInt(devId); username = ''; firstName = 'User';
    } else return res.status(401).json({ error: 'Auth required' });

    const maint = await getSetting('maintenance', false);
    if (maint && tid !== ADMIN_ID) return res.status(503).json({ error: '🔧 ဆာဗာ ပြင်ဆင်နေပါသည်' });

    let user = await User.findOne({ telegramId: tid });
    if (!user) {
      user = new User({ telegramId: tid, username, firstName, referralCode: genRefCode(tid) });
      await user.save();
    } else {
      let d = false;
      if (username && user.username !== username) { user.username = username; d = true; }
      if (firstName && user.firstName !== firstName) { user.firstName = firstName; d = true; }
      if (d) await user.save();
    }
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားပါသည်' });

    res.json({
      telegramId: user.telegramId,
      username: user.username || user.firstName || `User${user.telegramId}`,
      firstName: user.firstName,
      balance: user.balance,
      referralCode: user.referralCode,
      totalGames: user.totalGames,
      wins: user.wins,
      losses: user.losses
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const u = await User.findOne({ telegramId: parseInt(req.params.id) }).select('balance totalGames wins losses').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json(u);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ===== Mines Game API =====

app.post('/api/mines/start', async (req, res) => {
  try {
    const { telegramId, betAmount, bombCount, clientSeed: userClientSeed } = req.body;
    if (!telegramId || !betAmount || !bombCount)
      return res.status(400).json({ error: 'telegramId, betAmount, bombCount လိုသည်' });

    const bet   = parseInt(betAmount);
    const bombs = parseInt(bombCount);

    if (isNaN(bet)   || bet < 1000)           return res.status(400).json({ error: 'အနည်းဆုံး ၁,၀၀၀ ကျပ်မှ စတင်၍ ကစားနိုင်ပါသည်' });
    if (isNaN(bombs) || bombs < 1 || bombs > 24) return res.status(400).json({ error: 'Bomb 1–24 ဖြစ်ရမည်' });

    const tid = parseInt(telegramId);
    const user = await User.findOne({ telegramId: tid, isBanned: { $ne: true } }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (user.balance < bet) return res.status(400).json({ error: `လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${user.balance.toLocaleString()} MMK)` });

    const existing = await MinesGame.findOne({ userId: tid, status: 'active' }).lean();
    if (existing) return res.status(400).json({ error: 'ဂိမ်း ဆော့နေဆဲ ဖြစ်သည်', gameId: existing.gameId });

    const serverSeed       = crypto.randomBytes(32).toString('hex');
    const hashedServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const clientSeed       = userClientSeed || crypto.randomBytes(8).toString('hex');

    const bombPositions = generateBombPositions(serverSeed, clientSeed, bombs);

    const updated = await User.findOneAndUpdate(
      { telegramId: tid, balance: { $gte: bet }, isBanned: { $ne: true } },
      { $inc: { balance: -bet } },
      { new: true }
    );
    if (!updated) return res.status(400).json({ error: 'ငွေ ဆုတ်ယူ မအောင်မြင်' });

    const gameId = genGameId();
    await new MinesGame({ gameId, userId: tid, betAmount: bet, bombCount: bombs, serverSeed, hashedServerSeed, clientSeed, bombPositions, revealedCells: [], currentMultiplier: 1, status: 'active', winAmount: 0 }).save();

    // Agent % commission
    creditAgentCommission(tid, bet, 'turnover').catch(() => {});
    // 4-level referral commission (1% / 0.5% / 0.25% / 0.125%)
    distributeReferralCommission(tid, bet).catch(() => {});

    res.json({
      gameId, hashedServerSeed, clientSeed,
      betAmount: bet, bombCount: bombs,
      newBalance: updated.balance,
      nextMultiplier: calcMultiplier(bombs, 1)
    });
  } catch(e) { console.error('mines/start err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mines/reveal', async (req, res) => {
  try {
    const { gameId, cellIndex, telegramId } = req.body;
    if (gameId === undefined || cellIndex === undefined || !telegramId)
      return res.status(400).json({ error: 'gameId, cellIndex, telegramId လိုသည်' });

    const cell = parseInt(cellIndex);
    if (isNaN(cell) || cell < 0 || cell > 24) return res.status(400).json({ error: 'Invalid cell' });

    const tid  = parseInt(telegramId);
    const game = await MinesGame.findOne({ gameId, userId: tid, status: 'active' });
    if (!game) return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (game.revealedCells.includes(cell)) return res.status(400).json({ error: 'Cell already opened' });

    const HOUSE_EDGE_PCT = 0.06; // 6% dynamic house edge
    const dynamicBomb = Math.random() < HOUSE_EDGE_PCT;
    const presetBomb = game.bombPositions.includes(cell);
    const isBomb = dynamicBomb || presetBomb;

    if (isBomb) {
      if (!game.bombPositions.includes(cell)) {
        game.bombPositions.push(cell);
      }

      game.status       = 'exploded';
      game.explodedCell = cell;
      game.winAmount    = 0;
      await game.save();
      await User.findOneAndUpdate(
        { telegramId: tid },
        { $inc: { totalGames: 1, losses: 1, totalWagered: game.betAmount } }
      );

      return res.json({
        result: 'bomb', cell,
        bombPositions: game.bombPositions,
        serverSeed: game.serverSeed,
        clientSeed: game.clientSeed,
        revealedCells: game.revealedCells,
        status: 'exploded', winAmount: 0
      });
    }

    game.revealedCells.push(cell);
    const revealed = game.revealedCells.length;
    game.currentMultiplier = calcMultiplier(game.bombCount, revealed);
    const totalSafe = TOTAL_TILES - game.bombCount;

    if (revealed >= totalSafe) {
      const winAmount = Math.floor(game.betAmount * game.currentMultiplier);
      game.status    = 'cashout';
      game.winAmount = winAmount;
      await game.save();
      await User.findOneAndUpdate(
        { telegramId: tid },
        { $inc: { balance: winAmount, totalGames: 1, wins: 1, totalWon: winAmount, totalWagered: game.betAmount } }
      );

      return res.json({
        result: 'diamond', cell,
        currentMultiplier: game.currentMultiplier,
        revealedCells: game.revealedCells,
        winAmount, status: 'cashout',
        bombPositions: game.bombPositions,
        serverSeed: game.serverSeed,
        clientSeed: game.clientSeed,
        allSafeRevealed: true
      });
    }

    await game.save();
    res.json({
      result: 'diamond', cell,
      currentMultiplier: game.currentMultiplier,
      nextMultiplier: calcMultiplier(game.bombCount, revealed + 1),
      revealedCells: game.revealedCells,
      status: 'active'
    });
  } catch(e) { console.error('mines/reveal err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mines/cashout', async (req, res) => {
  try {
    const { gameId, telegramId } = req.body;
    if (!gameId || !telegramId) return res.status(400).json({ error: 'gameId, telegramId လိုသည်' });

    const tid  = parseInt(telegramId);
    const game = await MinesGame.findOne({ gameId, userId: tid, status: 'active' });
    if (!game)                       return res.status(404).json({ error: 'Active game မတွေ့ပါ' });
    if (!game.revealedCells.length)  return res.status(400).json({ error: 'Cell အနည်းဆုံး ၁ ခု ဖွင့်ပါ' });

    const winAmount    = Math.floor(game.betAmount * game.currentMultiplier);
    game.status        = 'cashout';
    game.winAmount     = winAmount;
    await game.save();

    const updated = await User.findOneAndUpdate(
      { telegramId: tid },
      { $inc: { balance: winAmount, totalGames: 1, wins: 1, totalWon: winAmount, totalWagered: game.betAmount } },
      { new: true }
    );

    res.json({
      winAmount, multiplier: game.currentMultiplier,
      newBalance: updated.balance,
      bombPositions: game.bombPositions,
      serverSeed: game.serverSeed,
      clientSeed: game.clientSeed,
      revealedCells: game.revealedCells,
      status: 'cashout'
    });
  } catch(e) { console.error('mines/cashout err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mines/current/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const game = await MinesGame.findOne({ userId: tid, status: 'active' }).lean();
    if (!game) return res.json({ hasActiveGame: false });
    res.json({
      hasActiveGame: true,
      gameId: game.gameId,
      betAmount: game.betAmount,
      bombCount: game.bombCount,
      hashedServerSeed: game.hashedServerSeed,
      clientSeed: game.clientSeed,
      revealedCells: game.revealedCells,
      currentMultiplier: game.currentMultiplier,
      nextMultiplier: calcMultiplier(game.bombCount, game.revealedCells.length + 1)
    });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mines/verify/:gameId', async (req, res) => {
  try {
    const game = await MinesGame.findOne({ gameId: req.params.gameId }).lean();
    if (!game)                  return res.status(404).json({ error: 'Game မတွေ့ပါ' });
    if (game.status === 'active') return res.status(400).json({ error: 'ဂိမ်း မပြီးသေးပါ' });

    const verifiedHash    = crypto.createHash('sha256').update(game.serverSeed).digest('hex');
    const hashVerified    = verifiedHash === game.hashedServerSeed;
    const computedPositions = generateBombPositions(game.serverSeed, game.clientSeed, game.bombCount);
    const positionsMatch  = JSON.stringify(computedPositions) === JSON.stringify(game.bombPositions);

    res.json({
      gameId: game.gameId,
      serverSeed: game.serverSeed,
      hashedServerSeed: game.hashedServerSeed,
      clientSeed: game.clientSeed,
      bombCount: game.bombCount,
      actualBombPositions: game.bombPositions,
      computedBombPositions: computedPositions,
      hashVerified, positionsMatch,
      status: game.status,
      winAmount: game.winAmount
    });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mines/history/:telegramId', async (req, res) => {
  try {
    const games = await MinesGame.find({ userId: parseInt(req.params.telegramId), status: { $ne: 'active' } })
      .sort({ createdAt: -1 }).limit(20)
      .select('gameId betAmount bombCount winAmount status revealedCells createdAt').lean();
    res.json(games);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ===== Deposit / Withdraw =====
app.post('/api/deposit', async (req, res) => {
  try {
    const { telegramId, kpayName, transactionId, amount, paymentMethod } = req.body;
    if (!telegramId || !kpayName || !transactionId || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်များ ဖြည့်ပေးပါ' });
    if (parseInt(amount) < 2500) return res.status(400).json({ error: 'အနည်းဆုံး 2,500 MMK ဖြည့်ပါ' });
    const u = await User.findOne({ telegramId: parseInt(telegramId) }).lean();
    if (!u)          return res.status(404).json({ error: 'User not found' });
    if (u.isBanned)  return res.status(403).json({ error: 'ကောင်ပိတ်ဆို့ထားသည်' });
    const dup = await Deposit.findOne({ transactionId }).lean();
    if (dup)         return res.status(400).json({ error: 'Transaction ID ကို အသုံးပြုပြီးသည်' });
    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    // expireAt auto-set by schema default to 3 days from now
    const dep = await new Deposit({ userId: u.telegramId, kpayName, transactionId, amount: parseInt(amount), paymentMethod: method }).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💰 *ငွေသွင်း*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} ကျပ်\n📱 ${method === 'wave' ? '🌊 Wave' : '📱 KPay'}\n📝 ${kpayName}\n🔢 \`${transactionId}\``,
      { parse_mode: 'Markdown' }).catch(() => {});
    res.json({ success: true, depositId: dep._id });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegramId, kpayName, kpayNumber, amount, paymentMethod } = req.body;
    if (!telegramId || !kpayName || !kpayNumber || !amount)
      return res.status(400).json({ error: 'ကွင်းလပ်များ ဖြည့်ပေးပါ' });
    const amt = parseInt(amount);
    if (isNaN(amt) || amt < 5000) return res.status(400).json({ error: 'အနည်းဆုံး 5,000 MMK ထုတ်ယူနိုင်သည်' });
    const tid = parseInt(telegramId);
    const chk = await User.findOne({ telegramId: tid }).select('balance isBanned firstName username').lean();
    if (!chk)          return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (chk.isBanned)  return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားသည်' });
    if (chk.balance < amt) return res.status(400).json({ error: `လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)` });
    const method = paymentMethod === 'wave' ? 'wave' : 'kpay';
    // expireAt auto-set by schema default to 3 days from now
    let wd;
    try { wd = await new Withdrawal({ userId: tid, kpayName, kpayNumber, amount: amt, paymentMethod: method }).save(); }
    catch { return res.status(500).json({ error: 'Record သိမ်းမရပါ' }); }
    const u = await User.findOneAndUpdate(
      { telegramId: tid, balance: { $gte: amt }, isBanned: { $ne: true } },
      { $inc: { balance: -amt } }, { new: true }
    );
    if (!u) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(() => {});
      return res.status(400).json({ error: 'ငွေ ဆုတ်ယူ မအောင်မြင်' });
    }
    if (bot) bot.telegram.sendMessage(ADMIN_ID,
      `💸 *ငွေထုတ်*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ်\n📱 ${method === 'wave' ? '🌊 Wave' : '📱 KPay'}: ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()}`,
      { parse_mode: 'Markdown' }).catch(() => {});
    res.json({ success: true, withdrawalId: wd._id, newBalance: u.balance });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/referrals/:telegramId', async (req, res) => {
  try {
    const tid = parseInt(req.params.telegramId);
    const me  = await User.findOne({ telegramId: tid }).select('refEarnings').lean();
    const referrals = await User.find({ referredBy: tid })
      .select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    res.json({
      total: referrals.length,
      // Per-level commission summary for this user
      commissionSummary: {
        level1: me?.refEarnings?.level1 || 0,
        level2: me?.refEarnings?.level2 || 0,
        level3: me?.refEarnings?.level3 || 0,
        level4: me?.refEarnings?.level4 || 0,
        total:  me?.refEarnings?.total  || 0
      },
      referrals: referrals.map(u => ({
        name: u.firstName || u.username || `User${u.telegramId}`,
        username: u.username || '',
        balance: u.balance || 0,
        joinedAt: u.createdAt
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Admin Routes =====
app.post('/api/admin/verify', async (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
    const tid = parseInt(telegramId);
    if (!ADMIN_ID || tid !== ADMIN_ID) return res.status(403).json({ error: 'Admin မဟုတ်ပါ' });
    res.json({ ok: true, adminId: tid });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/stats', isAdmin, async (_, res) => {
  try {
    const [tu, pd, pw, tg] = await Promise.all([
      User.countDocuments(),
      Deposit.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      MinesGame.countDocuments({ status: { $ne: 'active' } })
    ]);
    const [depAgg, wdAgg, minesAgg] = await Promise.all([
      Deposit.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
      Withdrawal.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
      MinesGame.aggregate([{ $match: { status: { $ne: 'active' } } }, { $group: { _id: null, bet: { $sum: '$betAmount' }, win: { $sum: '$winAmount' } } }])
    ]);
    res.json({
      totalUsers: tu, totalGames: tg, pendingDeposits: pd, pendingWithdrawals: pw,
      totalDeposited: depAgg[0]?.t || 0, totalWithdrawn: wdAgg[0]?.t || 0,
      totalBetAmount: minesAgg[0]?.bet || 0, totalWinAmount: minesAgg[0]?.win || 0,
      houseProfit: (minesAgg[0]?.bet || 0) - (minesAgg[0]?.win || 0)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', isAdmin, async (_, res) => {
  const maint = await getSetting('maintenance', false);
  res.json({ maintenance: maint });
});

app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
  await setSetting('maintenance', !!req.body.enabled);
  res.json({ success: true, maintenance: !!req.body.enabled });
});

// ── Deposits (with status filter: pending / confirmed / rejected) ──────────
app.get('/api/admin/deposits', isAdmin, async (req, res) => {
  try {
    const status  = req.query.status || 'pending';
    const page    = parseInt(req.query.page) || 1;
    const limit   = 30;
    const query   = { status };

    // Exclude agent-managed deposits from admin list when pending
    if (status === 'pending') {
      const agents = await User.find({ role: 'agent' }).select('telegramId').lean();
      const agentIds = agents.map(a => a.telegramId);
      if (agentIds.length) {
        const agentReferredIds = (await User.find({ referredBy: { $in: agentIds } }).select('telegramId').lean()).map(u => u.telegramId);
        if (agentReferredIds.length) query.userId = { $nin: agentReferredIds };
      }
    }

    const [deps, total] = await Promise.all([
      Deposit.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean(),
      Deposit.countDocuments(query)
    ]);
    const out = await Promise.all(deps.map(async d => {
      const u = await User.findOne({ telegramId: d.userId }).select('firstName username').lean();
      return { ...d, userName: u?.firstName || u?.username || String(d.userId) };
    }));
    res.json({ deposits: out, total, pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async (req, res) => {
  try {
    const now = new Date();
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: {
        status: 'confirmed',
        processedAt: now,
        expireAt: new Date(now.getTime() + THREE_DAYS_MS)  // reset TTL from processedAt
      }},
      { new: true }
    );
    if (!dep) return res.status(400).json({ error: 'Deposit မတွေ့ပါ' });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });

    const depositor = await User.findOne({ telegramId: dep.userId }).lean();
    if (depositor?.referredBy && dep.amount >= 2500) {
      const prevConfirmed = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
      if (prevConfirmed === 0) {
        const referrer = await User.findOne({ telegramId: depositor.referredBy }).lean();
        const isAgentReferrer = referrer?.role === 'agent';
        const bonus = isAgentReferrer ? 200 : 100;
        await User.findOneAndUpdate({ telegramId: depositor.referredBy }, { $inc: { balance: bonus } });
        if (bot) bot.telegram.sendMessage(depositor.referredBy,
          `🎉 သင့် Referral မှ ပထမဆုံး ငွေဖြည့်သောကြောင့် <b>+${bonus} MMK</b> ရရှိပါပြီ!`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    creditAgentCommission(dep.userId, dep.amount, 'deposit').catch(() => {});

    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး! 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const now = new Date();
    const dep = await Deposit.findByIdAndUpdate(req.params.id,
      { status: 'rejected', processedAt: now, rejectionNote: reason||'',
        expireAt: new Date(now.getTime() + THREE_DAYS_MS) },
      { new: true });
    if (!dep) return res.status(404).json({ error: 'မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reason ? `\n${reason}` : ''}`).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Withdrawals (with status filter) ──────────────────────────────────────
app.get('/api/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const page   = parseInt(req.query.page) || 1;
    const limit  = 30;
    const [wds, total] = await Promise.all([
      Withdrawal.find({ status }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean(),
      Withdrawal.countDocuments({ status })
    ]);
    const out = await Promise.all(wds.map(async w => {
      const u = await User.findOne({ telegramId: w.userId }).select('firstName username balance').lean();
      return { ...w, userName: u?.firstName || u?.username || String(w.userId), userBalance: u?.balance };
    }));
    res.json({ withdrawals: out, total, pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async (req, res) => {
  try {
    const now = new Date();
    const wd = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: {
        status: 'confirmed',
        processedAt: now,
        expireAt: new Date(now.getTime() + THREE_DAYS_MS)
      }},
      { new: true }
    );
    if (!wd) return res.status(400).json({ error: 'Withdrawal မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(wd.userId,
      `✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး! 🎉\n${wd.paymentMethod === 'wave' ? '🌊 Wave' : '📱 KPay'}: ${wd.kpayNumber}`).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const wd = await Withdrawal.findById(req.params.id);
    if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'ပြင်ဆင်မရပါ' });
    const now = new Date();
    wd.status = 'rejected'; wd.processedAt = now; wd.rejectionNote = reason||'';
    wd.expireAt = new Date(now.getTime() + THREE_DAYS_MS);
    await wd.save();
    await User.findOneAndUpdate({ telegramId: wd.userId }, { $inc: { balance: wd.amount } });
    if (bot) bot.telegram.sendMessage(wd.userId,
      `❌ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ${reason ? `\n${reason}` : ''}`).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const q = search ? { $or: [
      { telegramId: isNaN(search) ? -1 : parseInt(search) },
      { username:   { $regex: search, $options: 'i' } },
      { firstName:  { $regex: search, $options: 'i' } }
    ]} : {};
    const users = await User.find(q).sort({ createdAt: -1 }).skip((page-1)*20).limit(20).lean();
    const total = await User.countDocuments(q);
    res.json({ users, total, pages: Math.ceil(total/20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const u = await User.findOneAndUpdate({ telegramId: parseInt(req.params.tid) }, { $inc: { balance: parseInt(amount) } }, { new: true });
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (bot) bot.telegram.sendMessage(u.telegramId,
      `💰 Admin မှ ${amount > 0 ? '+' : ''}${parseInt(amount).toLocaleString()} ကျပ်${reason ? `\n${reason}` : ''}\nလက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(() => {});
    res.json({ success: true, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async (req, res) => {
  try {
    const { ban } = req.body;
    const u = await User.findOneAndUpdate({ telegramId: parseInt(req.params.tid) }, { isBanned: !!ban }, { new: true });
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (bot && ban) bot.telegram.sendMessage(u.telegramId, '🚫 ကောင်ပိတ်ဆို့ထားပါသည်').catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
  try {
    const { message, buttonText, buttonUrl } = req.body;
    if (!message || !bot) return res.status(400).json({ error: 'Message required' });
    res.json({ success: true, msg: 'Broadcast started' });
    setImmediate(async () => {
      const users = await User.find({ isBanned: { $ne: true } }).select('telegramId').lean();
      const kb = buttonText && buttonUrl ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] } : undefined;
      for (let i = 0; i < users.length; i += 30) {
        await Promise.allSettled(users.slice(i, i+30).map(u =>
          bot.telegram.sendMessage(u.telegramId, message, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
        ));
        if (i + 30 < users.length) await new Promise(r => setTimeout(r, 1000));
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/message', isAdmin, async (req, res) => {
  try {
    const { telegramId, message } = req.body;
    await bot?.telegram.sendMessage(parseInt(telegramId), message, { parse_mode: 'HTML' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: mines game history
app.get('/api/admin/mines', isAdmin, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = 30;
    const games = await MinesGame.find({ status: { $ne: 'active' } })
      .sort({ createdAt: -1 }).skip((parseInt(page)-1)*limit).limit(limit).lean();
    const total = await MinesGame.countDocuments({ status: { $ne: 'active' } });
    const out = await Promise.all(games.map(async g => {
      const u = await User.findOne({ telegramId: g.userId }).select('firstName username').lean();
      return { ...g, userName: u?.firstName || u?.username || `User${g.userId}` };
    }));
    res.json({ games: out, total, pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Agent API =====
app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) { agent = new Agent({ telegramId: user.telegramId, referralCode: user.referralCode }); await agent.save(); }

    const totalReferrals = await User.countDocuments({ referredBy: user.telegramId });
    const referredIds = (await User.find({ referredBy: user.telegramId }).select('telegramId').lean()).map(u => u.telegramId);

    let totalSales = 0, totalTurnover = 0;
    if (referredIds.length) {
      const [sAgg, tAgg] = await Promise.all([
        Deposit.aggregate([{ $match: { userId: { $in: referredIds }, status: 'confirmed' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
        MinesGame.aggregate([{ $match: { userId: { $in: referredIds }, status: { $ne: 'active' } } }, { $group: { _id: null, t: { $sum: '$betAmount' } } }])
      ]);
      totalSales = sAgg[0]?.t || 0;
      totalTurnover = tAgg[0]?.t || 0;
    }

    res.json({
      telegramId: user.telegramId, firstName: user.firstName, username: user.username,
      balance: user.balance, referralCode: user.referralCode, botUsername: BOT_USERNAME,
      depositCommission: agent.depositCommission || 0,
      turnoverCommission: agent.turnoverCommission || 0,
      totalCommissionEarned: agent.totalCommissionEarned || 0,
      agentKpayNumber: agent.agentKpayNumber || '',
      agentKpayName:   agent.agentKpayName   || '',
      hasWave:         agent.hasWave         || false,
      agentWaveNumber: agent.agentWaveNumber || '',
      agentWaveName:   agent.agentWaveName   || '',
      totalReferrals, totalSales, totalTurnover
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const referrals = await User.find({ referredBy: req.agentUser.telegramId })
      .select('telegramId firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(referrals.map(async u => {
      const depAgg = await Deposit.aggregate([
        { $match: { userId: u.telegramId, status: 'confirmed' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);
      return {
        telegramId: u.telegramId,
        name: u.firstName || u.username || `User${u.telegramId}`,
        username: u.username || '',
        balance: u.balance || 0,
        joinedAt: u.createdAt,
        totalDeposited: depAgg[0]?.total || 0,
        depositCount: depAgg[0]?.count || 0
      };
    }));
    res.json({ total: enriched.length, referrals: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const referredUsers = await User.find({ referredBy: agentId }).select('telegramId firstName username').lean();
    if (!referredUsers.length) return res.json({ deposits: [], total: 0 });
    const referredIds = referredUsers.map(u => u.telegramId);
    const userMap = {};
    referredUsers.forEach(u => { userMap[u.telegramId] = u.firstName || u.username || `User${u.telegramId}`; });
    const status = req.query.status || 'pending';
    const page   = parseInt(req.query.page) || 1;
    const limit  = 30;
    const [deps, total] = await Promise.all([
      Deposit.find({ userId: { $in: referredIds }, status }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean(),
      Deposit.countDocuments({ userId: { $in: referredIds }, status })
    ]);
    res.json({ deposits: deps.map(d => ({ ...d, userName: userMap[d.userId] || String(d.userId) })), total, pages: Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'confirming' } },
      { new: false }
    );
    if (!dep) {
      const ex = await Deposit.findById(req.params.id).lean();
      if (!ex) return res.status(404).json({ error: 'မတွေ့ပါ' });
      return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' });
    }
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) {
      await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } });
      return res.status(403).json({ error: 'ဤ User မဟုတ်ပါ' });
    }
    const agentFresh = await User.findOne({ telegramId: agentId }).lean();
    if (!agentFresh || agentFresh.balance < dep.amount) {
      await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } });
      return res.status(402).json({ error: `လက်ကျန်ငွေ မလောက်ပါ (ကျန်: ${(agentFresh?.balance||0).toLocaleString()})`, insufficientBalance: true, agentBalance: agentFresh?.balance||0, required: dep.amount });
    }
    const now = new Date();
    await Deposit.findByIdAndUpdate(dep._id, { $set: {
      status: 'confirmed', processedAt: now, processedBy: 'agent',
      expireAt: new Date(now.getTime() + THREE_DAYS_MS)
    }});
    await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: -dep.amount } });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });

    if (dep.amount >= 2500) {
      const prevConfirmed = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
      if (prevConfirmed === 0) {
        await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: 200 } });
        if (bot) bot.telegram.sendMessage(agentId,
          `🎉 Referral မှ ပထမဆုံး ငွေဖြည့်သောကြောင့် <b>+200 MMK</b> Bonus ရရှိပါပြီ!`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    const agentDoc = await Agent.findOne({ telegramId: agentId }).lean();
    if (agentDoc?.depositCommission > 0) {
      const commission = Math.floor(dep.amount * agentDoc.depositCommission / 100);
      if (commission > 0) {
        await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: commission } });
        await Agent.findOneAndUpdate({ telegramId: agentId }, { $inc: { totalCommissionEarned: commission } });
        if (bot) bot.telegram.sendMessage(agentId,
          `💰 <b>Deposit Commission!</b>\n+${commission.toLocaleString()} MMK (${agentDoc.depositCommission}% of ${dep.amount.toLocaleString()})`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
    }

    if (bot) bot.telegram.sendMessage(dep.userId,
      `✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး! 🎉`,
      Markup.inlineKeyboard([[Markup.button.webApp('💣 ကစားမည်', FRONTEND_URL)]])).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const { reason } = req.body;
    const now = new Date();
    const dep = await Deposit.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: {
        status: 'rejected', processedAt: now, processedBy: 'agent',
        rejectionNote: reason||'',
        expireAt: new Date(now.getTime() + THREE_DAYS_MS)
      }},
      { new: true }
    );
    if (!dep) return res.status(400).json({ error: 'ပြင်ဆင်မရပါ' });
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) return res.status(403).json({ error: 'ဤ User မဟုတ်ပါ' });
    if (bot) bot.telegram.sendMessage(dep.userId,
      `❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် ပယ်ချပြီ\nTxn: ${dep.transactionId}${reason ? `\n${reason}` : ''}`).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Payment info
app.get('/api/payment-info/:telegramId', async (req, res) => {
  try {
    const tid  = parseInt(req.params.telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const defaultInfo = {
      kpayNumber: process.env.ADMIN_KPAY_NUMBER || '09792310926',
      kpayName:   process.env.ADMIN_KPAY_NAME   || 'Admin',
      hasWave:    true,
      waveNumber: process.env.ADMIN_WAVE_NUMBER  || '09792310926',
      waveName:   process.env.ADMIN_WAVE_NAME    || 'Admin',
      isAgentPayment: false
    };
    if (!user.referredBy) return res.json(defaultInfo);
    const agentDoc = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!agentDoc || !agentDoc.agentKpayNumber) return res.json(defaultInfo);
    res.json({ kpayNumber: agentDoc.agentKpayNumber, kpayName: agentDoc.agentKpayName||'', hasWave: agentDoc.hasWave||false, waveNumber: agentDoc.agentWaveNumber||'', waveName: agentDoc.agentWaveName||'', isAgentPayment: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Admin Agent Routes =====
app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { page = 1, search = '' } = req.query;
    const q = { role: 'agent' };
    if (search) {
      const tid = isNaN(search) ? null : parseInt(search);
      q.$or = [...(tid ? [{ telegramId: tid }] : []), { username: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }];
    }
    const agents = await User.find(q).sort({ createdAt: -1 }).skip((page-1)*20).limit(20).lean();
    const total  = await User.countDocuments(q);
    const enriched = await Promise.all(agents.map(async u => {
      const agentDoc      = await Agent.findOne({ telegramId: u.telegramId }).lean();
      const totalReferrals = await User.countDocuments({ referredBy: u.telegramId });
      return { ...u, agentData: agentDoc, totalReferrals };
    }));
    res.json({ agents: enriched, total, pages: Math.ceil(total/20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agent-referrals', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' }).select('telegramId firstName username balance').sort({ createdAt: -1 }).lean();
    const result = await Promise.all(agents.map(async agent => {
      const referredUsers = await User.find({ referredBy: agent.telegramId }).select('telegramId firstName username balance createdAt').lean();
      const referredIds   = referredUsers.map(u => u.telegramId);
      let activeCount = 0, totalSales = 0;
      if (referredIds.length) {
        const depositors = await Deposit.aggregate([{ $match: { userId: { $in: referredIds }, status: 'confirmed' } }, { $group: { _id: '$userId', total: { $sum: '$amount' } } }]);
        activeCount = depositors.length;
        totalSales  = depositors.reduce((s, d) => s + d.total, 0);
      }
      const agentDoc = await Agent.findOne({ telegramId: agent.telegramId }).lean();
      return {
        agentId: agent.telegramId,
        agentName: agent.firstName || agent.username || `Agent${agent.telegramId}`,
        agentBalance: agent.balance || 0,
        agentRefCode: agent.referralCode || '',
        depositCommission: agentDoc?.depositCommission || 0,
        turnoverCommission: agentDoc?.turnoverCommission || 0,
        totalCommissionEarned: agentDoc?.totalCommissionEarned || 0,
        agentKpayNumber: agentDoc?.agentKpayNumber || '',
        agentKpayName: agentDoc?.agentKpayName || '',
        hasWave: agentDoc?.hasWave || false,
        agentWaveNumber: agentDoc?.agentWaveNumber || '',
        agentWaveName: agentDoc?.agentWaveName || '',
        totalReferrals: referredUsers.length, activeReferrals: activeCount, totalSales,
        referrals: referredUsers.map(u => ({ telegramId: u.telegramId, name: u.firstName || u.username || `User${u.telegramId}`, username: u.username || '', balance: u.balance || 0, joinedAt: u.createdAt }))
      };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/make-agent', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { isAgent: makeAgent } = req.body;
    const u = await User.findOneAndUpdate({ telegramId: tid }, { role: makeAgent ? 'agent' : 'user' }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (makeAgent) {
      await Agent.findOneAndUpdate({ telegramId: tid }, { $setOnInsert: { telegramId: tid, referralCode: u.referralCode } }, { upsert: true });
      if (bot) bot.telegram.sendMessage(tid, `🎯 <b>Agent ခွင့်ပြုပြီ!</b>\n\n/agent ရိုက်ပြီး Panel ဝင်ပါ`, { parse_mode: 'HTML' }).catch(() => {});
    }
    res.json({ success: true, role: makeAgent ? 'agent' : 'user' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/commission', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const dc  = Math.min(50, Math.max(0, parseFloat(req.body.depositCommission)  || 0));
    const tc  = Math.min(10, Math.max(0, parseFloat(req.body.turnoverCommission) || 0));
    const agent = await Agent.findOneAndUpdate({ telegramId: tid }, { depositCommission: dc, turnoverCommission: tc }, { new: true, upsert: false });
    if (!agent) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(tid,
      `📊 <b>Commission Rate ပြောင်းလဲပြီ</b>\n💵 Deposit: <b>${dc}%</b>\n🎮 Turnover: <b>${tc}%</b>`,
      { parse_mode: 'HTML' }).catch(() => {});
    res.json({ success: true, depositCommission: dc, turnoverCommission: tc });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/payment-info', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { kpayNumber, kpayName, hasWave, waveNumber, waveName } = req.body;
    if (!kpayNumber) return res.status(400).json({ error: 'KPay နံပါတ် လိုသည်' });
    const agent = await Agent.findOneAndUpdate({ telegramId: tid }, { $set: { agentKpayNumber: kpayNumber, agentKpayName: kpayName||'', hasWave: !!hasWave, agentWaveNumber: waveNumber||'', agentWaveName: waveName||'' } }, { new: true, upsert: false });
    if (!agent) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const amt = parseInt(req.body.amount);
    if (isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Amount မှားသည်' });
    const u = await User.findOneAndUpdate({ telegramId: tid, role: 'agent' }, { $inc: { balance: amt } }, { new: true });
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) bot.telegram.sendMessage(tid,
      `💰 <b>Balance Update</b>\n${amt > 0 ? '+' : ''}${amt.toLocaleString()} ကျပ${req.body.reason ? `\n${req.body.reason}` : ''}\n🏦 ကျန်: ${u.balance.toLocaleString()} ကျပ်`,
      { parse_mode: 'HTML' }).catch(() => {});
    res.json({ success: true, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Redeem Codes =====
app.post('/api/redeem', async (req, res) => {
  try {
    const { telegramId, code } = req.body;
    if (!telegramId || !code) return res.status(400).json({ error: 'telegramId, code လိုသည်' });
    const tid  = parseInt(telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user)         return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (user.isBanned) return res.status(403).json({ error: '🚫 ပိတ်ဆို့ထားသည်' });
    const rc = await RedeemCode.findOne({ code: code.toUpperCase().trim() });
    if (!rc || !rc.isActive) return res.status(400).json({ error: '❌ Code မမှန်ပါ' });
    if (rc.usedBy.includes(tid)) return res.status(400).json({ error: '⚠️ Code ကို အသုံးပြုပြီးသည်' });
    if (rc.maxUses > 0 && rc.usedBy.length >= rc.maxUses) return res.status(400).json({ error: '⚠️ Code ကုန်ဆုံးပြီ' });
    await RedeemCode.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const updated = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: rc.amount } }, { new: true });
    res.json({ success: true, amount: rc.amount, newBalance: updated.balance });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/redeem/create', isAdmin, async (req, res) => {
  try {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code, amount လိုသည်' });
    const rc = await new RedeemCode({ code: code.toUpperCase().trim(), amount: parseInt(amount), maxUses: parseInt(maxUses)||1 }).save();
    res.json({ success: true, code: rc });
  } catch(e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Code ရှိပြီးသားဖြစ်သည်' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/redeem/list', isAdmin, async (_, res) => {
  try { res.json(await RedeemCode.find().sort({ createdAt: -1 }).lean()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/redeem/:id/toggle', isAdmin, async (req, res) => {
  try {
    const rc = await RedeemCode.findById(req.params.id);
    if (!rc) return res.status(404).json({ error: 'Not found' });
    rc.isActive = !rc.isActive; await rc.save();
    res.json({ success: true, isActive: rc.isActive });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/redeem/:id', isAdmin, async (req, res) => {
  try { await RedeemCode.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Self-Ping =====
setInterval(() => {
  try { https.get(`${BACKEND_URL}/health`, () => {}).on('error', () => {}); } catch {}
}, 5 * 60 * 1000);

process.on('unhandledRejection', r => console.error('Rejection:', r));
process.on('uncaughtException',  e => console.error('Exception:', e));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Mines Game server on port ${PORT}`));
