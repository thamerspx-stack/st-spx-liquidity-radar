const TelegramBot = require('node-telegram-bot-api');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

const API_KEY = process.env.MASSIVE_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CHAT_ID = process.env.SIGNALS_CHAT_ID || '-1002840761137';
const THREAD_ID = Number(process.env.SIGNALS_THREAD_ID || 0);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

// =====================
// SPX Settings
// =====================

const SYMBOL = 'SPX';
const UNDERLYING_SYMBOL = 'I:SPX';

const activeTrades = new Map();
let botPaused = false;

const SCAN_INTERVAL_MS = 60 * 1000;
const UPDATE_INTERVAL_MS = 30 * 1000;

const MIN_CONTRACT_PRICE = 2.00;
const MAX_CONTRACT_PRICE = 3.00;

const MIN_VOLUME = 100;
const MIN_OI = 100;
const MIN_DELTA = 0.25;
const MAX_DELTA = 0.40;
const MIN_GAMMA = 0.01;
const MAX_SPREAD_PERCENT = 25;
const MAX_DTE = 1;

const TAKE_PROFIT_PERCENT = 30;
const STOP_LOSS_PERCENT = 22;

const NEAR_TARGET_PERCENT = 15;
const NEAR_STOP_PERCENT = -15;

const UPDATE_STEP = 0.10;

const MIN_TECHNICAL_SCORE = 65;
const MIN_TOTAL_SCORE = 75;

const MAX_TRADES_PER_DAY = 4;

let tradesToday = 0;
let todayMemoryKey = new Date().toISOString().slice(0, 10);

// =====================
// Helpers
// =====================

function isAdmin(msg) {
  const fromId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');
  return ADMIN_IDS.includes(fromId) || ADMIN_IDS.includes(chatId);
}

function sendToSameTopic(msg, text) {
  return bot.sendMessage(
    msg.chat.id,
    text,
    { message_thread_id: msg.message_thread_id }
  );
}

function sendToSignals(text) {
  const options = THREAD_ID ? { message_thread_id: THREAD_ID } : {};
  return bot.sendMessage(CHAT_ID, text, options);
}

function sendPhotoToSignals(image, caption) {
  const options = {
    caption,
    ...(THREAD_ID ? { message_thread_id: THREAD_ID } : {})
  };

  return bot.sendPhoto(CHAT_ID, image, options);
}

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toFixed(2);
}

function fmtLevel(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return 'غير متوفر';
  return `${Number(n).toFixed(2)}%`;
}

function pnlPercent(entry, current) {
  if (!entry || !current) return 0;
  return Number((((current - entry) / entry) * 100).toFixed(2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyMemoryIfNeeded() {
  const key = todayKey();

  if (key !== todayMemoryKey) {
    todayMemoryKey = key;
    tradesToday = 0;
  }
}

function tradeKey() {
  return SYMBOL;
}

function alreadyHasActiveTrade() {
  return activeTrades.has(tradeKey());
}

function removeTrade() {
  activeTrades.delete(tradeKey());
}

function sideArabic(side) {
  return side === 'CALL' ? 'كول' : 'بوت';
}

function contractLabel(trade) {
  const letter = trade.type === 'CALL' ? 'C' : 'P';
  return `${trade.symbol} ${trade.strike}${letter}`;
}

function getContractType(item) {
  return String(item?.details?.contract_type || '').toUpperCase();
}

function getStrike(item) {
  return Number(item?.details?.strike_price || 0);
}

function getExpiration(item) {
  return item?.details?.expiration_date || null;
}

function getContractTicker(item) {
  return item?.details?.ticker || item?.ticker || null;
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getDelta(item) {
  return Number(item?.greeks?.delta || 0);
}

function getGamma(item) {
  return Number(item?.greeks?.gamma || 0);
}

function getTheta(item) {
  return Number(item?.greeks?.theta || 0);
}

function getIV(item) {
  return Number(item?.implied_volatility || 0);
}

function getBid(item) {
  return Number(item?.last_quote?.bid || 0);
}

function getAsk(item) {
  return Number(item?.last_quote?.ask || 0);
}

function getLastTradePrice(item) {
  return Number(item?.last_trade?.price || item?.day?.close || 0);
}

function getMidPrice(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }

  const last = getLastTradePrice(item);
  if (last > 0) return Number(last.toFixed(2));

  return 0;
}

function spreadPercent(item) {
  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMidPrice(item);

  if (!bid || !ask || !mid) return 999;

  return ((ask - bid) / mid) * 100;
}

function distancePercent(strike, price) {
  if (!strike || !price) return 999;
  return Math.abs(((Number(strike) - Number(price)) / Number(price)) * 100);
}

function daysToExpiration(dateStr) {
  if (!dateStr) return 999;

  const now = new Date();
  const exp = new Date(`${dateStr}T23:59:59Z`);

  return Math.ceil(
    (exp.getTime() - now.getTime()) /
    (1000 * 60 * 60 * 24)
  );
}

function gammaText(gamma) {
  const g = Number(gamma);

  if (!g || isNaN(g)) return 'غير متوفر';
  if (g >= 0.08) return 'مرتفع جدًا';
  if (g >= 0.04) return 'مرتفع';
  if (g >= 0.02) return 'متوسط';

  return 'منخفض';
}

function nowKsaMinutes() {
  const now = new Date();
  const sa = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })
  );

  return sa.getHours() * 60 + sa.getMinutes();
}

function isAllowedSignalTime() {
  const minutes = nowKsaMinutes();

  const start = 16 * 60 + 30;
  const end = 24 * 60;

  return minutes >= start && minutes <= end;
}
// =====================
// Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      'API Error'
    );
  }

  return data;
}

async function isMarketOpenNow() {
  try {
    const url =
      `https://api.massive.com/v1/marketstatus/now?apiKey=${API_KEY}`;

    const data = await apiGet(url);

    return (
      data?.market === 'open' ||
      data?.exchanges?.nasdaq === 'open' ||
      data?.exchanges?.nyse === 'open'
    );
  } catch (err) {
    console.error('Market Status Error:', err.message);
    return false;
  }
}

async function getSPXSnapshot() {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

  if (FINNHUB_KEY) {
    const symbols = ['^GSPC', 'SPX'];

    for (const symbol of symbols) {
      try {
        const url =
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;

        const data = await apiGet(url);
        const price = Number(data?.c);
        const open = Number(data?.o);
        const high = Number(data?.h);
        const low = Number(data?.l);

        if (price && price > 1000) {
          console.log(`Live SPX price from Finnhub ${symbol}: ${price}`);

          return {
            symbol: SYMBOL,
            price,
            open,
            high,
            low,
            volume: 0,
            change: open ? ((price - open) / open) * 100 : 0
          };
        }
      } catch (err) {
        console.log(`Finnhub SPX price failed ${symbol}:`, err.message);
      }
    }
  }

  console.log('⚠️ لم أستطع جلب سعر SPX من Finnhub.');
  return null;
}

async function getIntradayCandles() {
  const to = new Date();
  const from = new Date();

  from.setDate(from.getDate() - 3);

  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);

  const url =
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(UNDERLYING_SYMBOL)}/range/1/minute/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=5000&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
}

async function getOptionsChain() {
  let results = [];
  let url =
    `https://api.massive.com/v3/snapshot/options/${encodeURIComponent(UNDERLYING_SYMBOL)}?limit=250&apiKey=${API_KEY}`;

  for (let i = 0; i < 12; i++) {
    const data = await apiGet(url);

    results = results.concat(data?.results || []);

    if (!data?.next_url) break;

    url = data.next_url.includes('apiKey=')
      ? data.next_url
      : `${data.next_url}&apiKey=${API_KEY}`;
  }

  return results;
}

async function getOptionSnapshot(contractTicker) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${encodeURIComponent(UNDERLYING_SYMBOL)}/${encodeURIComponent(contractTicker)}?apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || data;
}

// =====================
// Image Card
// =====================

async function createTradeImage(type) {
  const color = type === 'CALL' ? '#00ff99' : '#ff2d55';
  const title = type === 'CALL' ? 'CALL' : 'PUT';

  const svg = `
  <svg width="800" height="450" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="50%" r="70%">
        <stop offset="0%" stop-color="#111936"/>
        <stop offset="100%" stop-color="#050816"/>
      </radialGradient>
    </defs>

    <rect width="800" height="450" fill="url(#bg)" />

    <rect
      x="20"
      y="20"
      width="760"
      height="410"
      rx="30"
      ry="30"
      fill="none"
      stroke="${color}"
      stroke-width="8"
    />

    <circle cx="400" cy="225" r="115" fill="${color}" opacity="0.16" />
    <circle cx="400" cy="225" r="70" fill="${color}" opacity="0.22" />

    <line x1="160" y1="225" x2="640" y2="225"
      stroke="${color}" stroke-width="4" opacity="0.35" />

    <line x1="400" y1="80" x2="400" y2="370"
      stroke="${color}" stroke-width="4" opacity="0.18" />

    <text
      x="400"
      y="235"
      font-size="72"
      font-weight="bold"
      text-anchor="middle"
      fill="${color}"
      font-family="Arial">
      SPX ${title}
    </text>

    <text
      x="400"
      y="310"
      font-size="32"
      text-anchor="middle"
      fill="#ffffff"
      font-family="Arial">
      ST SPX OPTIONS BOT
    </text>
  </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// =====================
// Technical Engine
// =====================

function ema(values, length) {
  if (!values.length) return null;

  const k = 2 / (length + 1);
  let emaValue = values[0];

  for (let i = 1; i < values.length; i++) {
    emaValue = values[i] * k + emaValue * (1 - k);
  }

  return emaValue;
}

function calculateVWAP(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical =
      (Number(c.h) + Number(c.l) + Number(c.c)) / 3;

    const v = Number(c.v || 0);

    pv += typical * v;
    volume += v;
  }

  if (!volume) return null;

  return pv / volume;
}

function candleStrength(candle) {
  if (!candle) return 0;

  const open = Number(candle.o);
  const close = Number(candle.c);
  const high = Number(candle.h);
  const low = Number(candle.l);

  const range = high - low;

  if (!range) return 0;

  return Math.abs(close - open) / range;
}

function getRecentRange(candles, length = 10) {
  const recent = candles.slice(-length - 1, -1);

  if (!recent.length) {
    return { high: null, low: null };
  }

  return {
    high: Math.max(...recent.map(c => Number(c.h))),
    low: Math.min(...recent.map(c => Number(c.l)))
  };
}

async function getTechnicalBias() {
  try {
    const candles = await getIntradayCandles();

    if (!candles || candles.length < 60) {
      return {
        side: 'NEUTRAL',
        score: 0,
        reason: 'بيانات الشموع غير كافية'
      };
    }

    const closes = candles.map(c => Number(c.c));
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const previous20 = candles.slice(-21, -1);

    const price = Number(last.c);
    const prevClose = Number(prev.c);

    const ema9 = ema(closes.slice(-40), 9);
    const ema21 = ema(closes.slice(-80), 21);
    const vwap = calculateVWAP(candles.slice(-120));

    const { high: recentHigh, low: recentLow } =
      getRecentRange(candles, 10);

    const strength = candleStrength(last);
    const volume = Number(last.v || 0);

    const avgVolume =
      previous20.reduce((sum, c) => sum + Number(c.v || 0), 0) /
      previous20.length;

    let callScore = 0;
    let putScore = 0;

    if (price > ema9) callScore += 15;
    if (price < ema9) putScore += 15;

    if (price > ema21) callScore += 20;
    if (price < ema21) putScore += 20;

    if (vwap && price > vwap) callScore += 20;
    if (vwap && price < vwap) putScore += 20;

    if (recentHigh && price > recentHigh) callScore += 20;
    if (recentLow && price < recentLow) putScore += 20;

    if (price > prevClose) callScore += 5;
    if (price < prevClose) putScore += 5;

    if (volume > avgVolume * 1.15) {
      callScore += 10;
      putScore += 10;
    }

    if (strength >= 0.55) {
      if (price > Number(last.o)) callScore += 15;
      if (price < Number(last.o)) putScore += 15;
    }

    if (
      callScore >= MIN_TECHNICAL_SCORE &&
      callScore > putScore + 15
    ) {
      return {
        side: 'CALL',
        score: callScore,
        reason: 'اختراق وزخم صاعد فوق VWAP/EMA'
      };
    }

    if (
      putScore >= MIN_TECHNICAL_SCORE &&
      putScore > callScore + 15
    ) {
      return {
        side: 'PUT',
        score: putScore,
        reason: 'كسر وزخم هابط تحت VWAP/EMA'
      };
    }

    return {
      side: 'NEUTRAL',
      score: Math.max(callScore, putScore),
      reason: 'الاتجاه غير حاسم'
    };

  } catch (err) {
    console.error('Technical Bias Error:', err.message);

    return {
      side: 'NEUTRAL',
      score: 0,
      reason: 'تعذر حساب الفلتر الفني'
    };
  }
}
// =====================
// Contract Scoring
// =====================

function contractQualityScore(item, stock) {
  const type = getContractType(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const mid = getMidPrice(item);
  const dist = distancePercent(getStrike(item), stock.price);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));

  if (!['CALL', 'PUT'].includes(type)) return 0;

  let score = 0;

  if (mid >= MIN_CONTRACT_PRICE && mid <= MAX_CONTRACT_PRICE) score += 25;

  if (delta >= 0.28 && delta <= 0.36) score += 25;
  else if (delta >= MIN_DELTA && delta <= MAX_DELTA) score += 15;

  if (gamma >= 0.06) score += 20;
  else if (gamma >= 0.03) score += 15;
  else if (gamma >= MIN_GAMMA) score += 8;

  if (spread <= 8) score += 15;
  else if (spread <= 15) score += 10;
  else if (spread <= MAX_SPREAD_PERCENT) score += 5;

  if (dist <= 0.20) score += 15;
  else if (dist <= 0.50) score += 10;
  else if (dist <= 1.00) score += 5;

  if (volume >= 1000) score += 10;
  else if (volume >= MIN_VOLUME) score += 5;

  if (oi >= 1000) score += 5;
  else if (oi >= MIN_OI) score += 3;

  if (dte === 0) score += 10;
  else if (dte === 1) score += 6;

  return Math.min(score, 100);
}

function flowItemScore(item, stock) {
  const type = getContractType(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const mid = getMidPrice(item);
  const dist = distancePercent(getStrike(item), stock.price);
  const spread = spreadPercent(item);

  if (!['CALL', 'PUT'].includes(type)) return 0;
  if (!mid || mid <= 0) return 0;

  let score = 0;

  score += Math.min(volume / 50, 300);
  score += Math.min(oi / 100, 150);

  if (volume > oi) score += 180;
  if (volume > oi * 2) score += 150;

  if (gamma >= 0.06) score += 250;
  else if (gamma >= 0.03) score += 160;
  else if (gamma >= 0.01) score += 80;

  if (delta >= 0.25 && delta <= 0.40) score += 120;

  if (dist <= 0.20) score += 180;
  else if (dist <= 0.50) score += 120;
  else if (dist <= 1.00) score += 60;

  if (spread <= 10) score += 80;
  else if (spread <= 20) score += 40;

  return score;
}

function getFlowBias(chain, stock) {
  let callScore = 0;
  let putScore = 0;

  for (const item of chain) {
    const type = getContractType(item);
    const score = flowItemScore(item, stock);

    if (type === 'CALL') callScore += score;
    if (type === 'PUT') putScore += score;
  }

  if (callScore > putScore * 1.25) {
    return {
      side: 'CALL',
      strength: 'STRONG',
      callScore,
      putScore
    };
  }

  if (putScore > callScore * 1.25) {
    return {
      side: 'PUT',
      strength: 'STRONG',
      callScore,
      putScore
    };
  }

  if (callScore > putScore * 1.10) {
    return {
      side: 'CALL',
      strength: 'MILD',
      callScore,
      putScore
    };
  }

  if (putScore > callScore * 1.10) {
    return {
      side: 'PUT',
      strength: 'MILD',
      callScore,
      putScore
    };
  }

  return {
    side: 'NEUTRAL',
    strength: 'NEUTRAL',
    callScore,
    putScore
  };
}

function isCandidateContract(item, stock, technicalBias, flowBias) {
  const type = getContractType(item);
  const mid = getMidPrice(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const gamma = Number(getGamma(item) || 0);
  const spread = spreadPercent(item);
  const dte = daysToExpiration(getExpiration(item));
  const dist = distancePercent(getStrike(item), stock.price);

  if (!['CALL', 'PUT'].includes(type)) return false;

  if (!technicalBias || technicalBias.side === 'NEUTRAL') return false;
  if (type !== technicalBias.side) return false;
  if (technicalBias.score < MIN_TECHNICAL_SCORE) return false;

  if (mid < MIN_CONTRACT_PRICE || mid > MAX_CONTRACT_PRICE) return false;
  if (volume < MIN_VOLUME) return false;
  if (oi < MIN_OI) return false;
  if (delta < MIN_DELTA || delta > MAX_DELTA) return false;
  if (gamma < MIN_GAMMA) return false;
  if (spread > MAX_SPREAD_PERCENT) return false;
  if (dte < 0 || dte > MAX_DTE) return false;
  if (dist > 1.20) return false;

  if (
    flowBias &&
    flowBias.side !== 'NEUTRAL' &&
    flowBias.strength === 'STRONG' &&
    flowBias.side !== type
  ) {
    return false;
  }

  return true;
}

function contractScore(item, stock, technicalBias, flowBias) {
  const type = getContractType(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);
  const delta = Math.abs(Number(getDelta(item) || 0));
  const mid = getMidPrice(item);
  const spread = spreadPercent(item);
  const dist = distancePercent(getStrike(item), stock.price);
  const dte = daysToExpiration(getExpiration(item));

  const quality = contractQualityScore(item, stock);
  const flowScore = flowItemScore(item, stock);

  let score = 0;

  score += quality * 3;
  score += Math.min(flowScore / 10, 300);

  if (technicalBias && technicalBias.side === type) {
    score += technicalBias.score * 3;
  }

  if (flowBias && flowBias.side === type) {
    score += flowBias.strength === 'STRONG' ? 220 : 100;
  }

  if (flowBias && flowBias.side !== 'NEUTRAL' && flowBias.side !== type) {
    score -= flowBias.strength === 'STRONG' ? 250 : 100;
  }

  if (mid >= 2.00 && mid <= 3.00) score += 200;

  if (delta >= 0.28 && delta <= 0.36) score += 180;
  else if (delta >= 0.25 && delta <= 0.40) score += 100;

  if (gamma >= 0.06) score += 200;
  else if (gamma >= 0.03) score += 120;

  if (spread <= 8) score += 120;
  else if (spread <= 15) score += 60;

  if (dist <= 0.20) score += 150;
  else if (dist <= 0.50) score += 90;

  if (volume >= 1000) score += 100;
  else if (volume >= 300) score += 50;

  if (oi >= 1000) score += 50;
  else if (oi >= 300) score += 25;

  if (dte === 0) score += 120;
  else if (dte === 1) score += 60;

  return Math.round(score);
}

function selectBestContract(stock, chain, technicalBias) {
  const flowBias = getFlowBias(chain, stock);

  const candidates = chain
    .filter(item => isCandidateContract(item, stock, technicalBias, flowBias))
    .map(item => ({
      item,
      score: contractScore(item, stock, technicalBias, flowBias)
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const best = candidates[0];

  if (best.score < MIN_TOTAL_SCORE) return null;

  const item = best.item;

  const type = getContractType(item);
  const strike = getStrike(item);
  const expiration = getExpiration(item);
  const contractTicker = getContractTicker(item);
  const entry = getMidPrice(item);

  if (!type || !strike || !expiration || !contractTicker || !entry) {
    return null;
  }

  const target = Number(
    (entry * (1 + TAKE_PROFIT_PERCENT / 100)).toFixed(2)
  );

  const stop = Number(
    (entry * (1 - STOP_LOSS_PERCENT / 100)).toFixed(2)
  );

  if (stop <= 0) return null;

  return {
    symbol: SYMBOL,
    type,
    strike,
    expiration,
    contractTicker,

    entry,
    current: entry,
    highestPrice: entry,
    lastUpdatePrice: entry,

    target,
    stop,

    score: best.score,
    status: 'OPEN',

    technicalBias: technicalBias.side,
    technicalScore: technicalBias.score,
    technicalReason: technicalBias.reason,

    flowBias: flowBias.side,
    flowStrength: flowBias.strength,

    contractQuality: contractQualityScore(item, stock),
    smartFlow: Math.round(flowItemScore(item, stock) / 10),

    volume: getVolume(item),
    oi: getOI(item),
    delta: getDelta(item),
    gamma: getGamma(item),
    theta: getTheta(item),
    iv: getIV(item),
    bid: getBid(item),
    ask: getAsk(item),

    dte: daysToExpiration(expiration),

    messageId: null,

    profit10Sent: false,
    profit20Sent: false,
    profit30Sent: false,
    nearTargetSent: false,
    nearStopSent: false
  };
}
// =====================
// Supabase
// =====================

async function saveTradeToSupabase(trade) {
  try {
    const { error } = await supabase
      .from('active_trades')
      .insert({
        symbol: trade.symbol,
        side: trade.type,
        contract_symbol: trade.contractTicker,
        strike: Number(trade.strike),
        expiration: trade.expiration,
        entry_price: trade.entry,
        current_price: trade.current,
        highest_price: trade.highestPrice,
        target_price: trade.target,
        stop_price: trade.stop,
        status: 'active'
      });

    if (error) {
      console.error('Supabase Insert Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Insert Error:', err.message);
  }
}

async function updateTradeInSupabase(trade) {
  try {
    const { error } = await supabase
      .from('active_trades')
      .update({
        current_price: trade.current,
        highest_price: trade.highestPrice,
        status: trade.status === 'OPEN' ? 'active' : trade.status,
        updated_at: new Date().toISOString()
      })
      .eq('contract_symbol', trade.contractTicker)
      .eq('status', 'active');

    if (error) {
      console.error('Supabase Update Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Update Error:', err.message);
  }
}

async function closeTradeInSupabase(trade) {
  try {
    const { error } = await supabase
      .from('active_trades')
      .update({
        current_price: trade.current,
        highest_price: trade.highestPrice,
        status: trade.status,
        updated_at: new Date().toISOString()
      })
      .eq('contract_symbol', trade.contractTicker)
      .eq('status', 'active');

    if (error) {
      console.error('Supabase Close Error:', error.message);
    }
  } catch (err) {
    console.error('Supabase Close Error:', err.message);
  }
}

function markTradeActive(trade) {
  activeTrades.set(tradeKey(), trade);
  saveTradeToSupabase(trade);
}

async function loadOpenTradesFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('active_trades')
      .select('*')
      .eq('status', 'active')
      .eq('symbol', SYMBOL);

    if (error) {
      console.error('Load Open Trades Error:', error.message);
      return;
    }

    for (const row of data || []) {
      if (!row.contract_symbol) continue;

      const type = String(row.side || '').toUpperCase();

      const trade = {
        symbol: SYMBOL,
        type,
        strike: Number(row.strike),
        expiration: row.expiration,
        contractTicker: row.contract_symbol,

        entry: Number(row.entry_price),
        current: Number(row.current_price),
        highestPrice: Number(row.highest_price || row.current_price || row.entry_price),
        lastUpdatePrice: Number(row.current_price || row.entry_price),

        target: Number(row.target_price),
        stop: Number(row.stop_price),

        score: null,
        status: 'OPEN',

        technicalBias: 'LOADED',
        technicalScore: 0,
        technicalReason: 'تم تحميل الصفقة من قاعدة البيانات',

        flowBias: 'LOADED',
        flowStrength: 'LOADED',

        contractQuality: null,
        smartFlow: null,

        volume: null,
        oi: null,
        delta: null,
        gamma: null,
        theta: null,
        iv: null,
        bid: null,
        ask: null,

        dte: daysToExpiration(row.expiration),

        messageId: null,

        profit10Sent: false,
        profit20Sent: false,
        profit30Sent: false,
        nearTargetSent: false,
        nearStopSent: false
      };

      activeTrades.set(tradeKey(), trade);
    }

    console.log(`✅ Loaded ${activeTrades.size} open SPX trades`);
  } catch (err) {
    console.error('Load Open Trades Error:', err.message);
  }
}

// =====================
// Trade Messages
// =====================

function buildTradeCaption(trade, mode = 'entry') {
  const percent = pnlPercent(trade.entry, trade.current);

  const title =
    mode === 'update'
      ? '🔄 تحديث صفقة SPX'
      : '🚨 صفقة ST SPX مؤكدة';

  const statusLine =
    trade.status === 'TARGET'
      ? '🎯 الحالة: تم تحقيق الهدف'
      : trade.status === 'STOPPED'
        ? '🛑 الحالة: ضرب وقف الخسارة'
        : '🟢 الحالة: الصفقة مفتوحة';

  return `${title}

${statusLine}

📈 النوع: ${trade.type} / ${sideArabic(trade.type)}
📄 العقد: ${contractLabel(trade)}
📅 الانتهاء: ${trade.expiration}

💵 دخول العقد: $${fmtPrice(trade.entry)}
💰 السعر الحالي: $${fmtPrice(trade.current)}
📊 أعلى سعر وصل له: $${fmtPrice(trade.highestPrice)}
📈 الربح/الخسارة: ${fmtPercent(percent)}

🎯 الهدف: $${fmtPrice(trade.target)}
🛑 الوقف: $${fmtPrice(trade.stop)}

━━━━━━━━━━━━━━

✅ التأكيدات:
• إشارة فنية: ${trade.technicalBias}
• سبب الدخول: ${trade.technicalReason}
• Flow Bias: ${trade.flowBias} / ${trade.flowStrength}
• جودة العقد: ${fmt(trade.contractQuality)}
• قوة التدفق: ${fmt(trade.smartFlow)}
• جودة الفلترة: ${fmt(trade.score)}

━━━━━━━━━━━━━━

📦 Volume: ${fmt(trade.volume)}
📂 OI: ${fmt(trade.oi)}
Δ Delta: ${
    trade.delta !== undefined && trade.delta !== null
      ? Number(trade.delta).toFixed(2)
      : 'غير متوفر'
  }
Γ Gamma: ${gammaText(trade.gamma)}
IV: ${
    trade.iv !== undefined && trade.iv !== null
      ? fmtPercent(Number(trade.iv) * 100)
      : 'غير متوفر'
  }

⏱ آخر تحديث:
${new Date().toLocaleString('ar-SA', {
    timeZone: 'Asia/Riyadh'
  })}

⚠️ متابعة تعليمية وليست توصية شراء أو بيع.`;
}

async function sendTradeEntry(trade) {
  const image = await createTradeImage(trade.type);
  const text = buildTradeCaption(trade, 'entry');

  const sent = await sendPhotoToSignals(image, text);

  trade.messageId = sent.message_id;

  return sent;
}

async function editTradeCaption(trade) {
  if (!trade.messageId) return false;

  try {
    await bot.editMessageCaption(
      buildTradeCaption(trade, 'update'),
      {
        chat_id: CHAT_ID,
        message_id: Number(trade.messageId)
      }
    );

    return true;
  } catch (err) {
    console.error('Edit Caption Error:', err.response?.body || err.message);
    return false;
  }
}

async function sendTradeUpdate(trade) {
  await updateTradeInSupabase(trade);

  const edited = await editTradeCaption(trade);

  if (edited) return;

  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`🔄 تحديث صفقة SPX

📈 ${contractLabel(trade)}
📅 الانتهاء: ${trade.expiration}

💵 الدخول: $${fmtPrice(trade.entry)}
💰 الحالي: $${fmtPrice(trade.current)}
📊 أعلى سعر وصل له: $${fmtPrice(trade.highestPrice)}

📈 الربح/الخسارة: ${fmtPercent(percent)}

🎯 الهدف: $${fmtPrice(trade.target)}
🛑 الوقف: $${fmtPrice(trade.stop)}

⚠️ متابعة تعليمية وليست توصية.`;

  await sendToSignals(text);
}

async function sendProfitUpdate(trade, level) {
  const percent = pnlPercent(trade.entry, trade.current);

  await updateTradeInSupabase(trade);
  await editTradeCaption(trade);

  const text =
`🚀 تحديث ربح صفقة SPX

📈 ${contractLabel(trade)}

💵 الدخول: $${fmtPrice(trade.entry)}
💰 الحالي: $${fmtPrice(trade.current)}
📊 أعلى سعر وصل له: $${fmtPrice(trade.highestPrice)}

📈 الربح الحالي: ${fmtPercent(percent)}
🎯 وصل الربح: +${level}%

الهدف: $${fmtPrice(trade.target)}
الوقف: $${fmtPrice(trade.stop)}

🔥 ST SPX OPTIONS`;

  await sendToSignals(text);
}

async function sendNearTarget(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`⚠️ الصفقة قريبة من الهدف

📈 ${contractLabel(trade)}

💵 الدخول: $${fmtPrice(trade.entry)}
💰 الحالي: $${fmtPrice(trade.current)}
🎯 الهدف: $${fmtPrice(trade.target)}

📈 الربح الحالي: ${fmtPercent(percent)}

راقب إدارة الصفقة.`;

  await sendToSignals(text);
}

async function sendNearStop(trade) {
  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`⚠️ الصفقة قريبة من وقف الخسارة

📈 ${contractLabel(trade)}

💵 الدخول: $${fmtPrice(trade.entry)}
💰 الحالي: $${fmtPrice(trade.current)}
🛑 الوقف: $${fmtPrice(trade.stop)}

📉 النتيجة الحالية: ${fmtPercent(percent)}

📊 أعلى سعر وصل له العقد: $${fmtPrice(trade.highestPrice)}`;

  await sendToSignals(text);
}

async function sendTargetHit(trade) {
  trade.status = 'TARGET';

  await closeTradeInSupabase(trade);
  await editTradeCaption(trade);

  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`✅ تحقق الهدف

📈 ${contractLabel(trade)}

💵 الدخول: $${fmtPrice(trade.entry)}
💰 الخروج: $${fmtPrice(trade.current)}
📊 أعلى سعر وصل له العقد: $${fmtPrice(trade.highestPrice)}

🎯 الهدف: $${fmtPrice(trade.target)}
📈 النتيجة: ${fmtPercent(percent)}

🔥 ST SPX OPTIONS`;

  await sendToSignals(text);
}

async function sendStopHit(trade) {
  trade.status = 'STOPPED';

  await closeTradeInSupabase(trade);
  await editTradeCaption(trade);

  const percent = pnlPercent(trade.entry, trade.current);

  const text =
`🛑 ضرب وقف الخسارة

📈 ${contractLabel(trade)}

💵 الدخول: $${fmtPrice(trade.entry)}
📊 أعلى سعر وصل له العقد: $${fmtPrice(trade.highestPrice)}
🛑 الوقف: $${fmtPrice(trade.stop)}

📉 النتيجة: ${fmtPercent(percent)}

⚠️ متابعة تعليمية وليست توصية.`;

  await sendToSignals(text);
}
// =====================
// Trade Updates
// =====================

function normalizeOptionSnapshot(snapshot) {
  return snapshot?.results || snapshot?.ticker || snapshot;
}

function applySnapshotToTrade(trade, item) {
  if (!item) return;

  const bid = getBid(item);
  const ask = getAsk(item);
  const volume = getVolume(item);
  const oi = getOI(item);

  if (bid > 0) trade.bid = bid;
  if (ask > 0) trade.ask = ask;

  if (volume > 0) trade.volume = volume;
  if (oi > 0) trade.oi = oi;

  const delta = getDelta(item);
  const gamma = getGamma(item);
  const theta = getTheta(item);
  const iv = getIV(item);

  if (delta !== undefined && delta !== null) trade.delta = delta;
  if (gamma !== undefined && gamma !== null) trade.gamma = gamma;
  if (theta !== undefined && theta !== null) trade.theta = theta;
  if (iv !== undefined && iv !== null) trade.iv = iv;

  trade.dte = daysToExpiration(trade.expiration);
}

async function refreshTradeData(trade) {
  const snapshot = await getOptionSnapshot(trade.contractTicker);

  if (!snapshot) return null;

  const data = normalizeOptionSnapshot(snapshot);

  applySnapshotToTrade(trade, data);

  const bid = Number(data?.last_quote?.bid || 0);
  const ask = Number(data?.last_quote?.ask || 0);
  const last = Number(data?.last_trade?.price || data?.day?.close || 0);

  let current = 0;

  if (bid > 0 && ask > 0) {
    current = (bid + ask) / 2;
  } else if (last > 0) {
    current = last;
  }

  if (!current || current <= 0) {
    console.log(`⚠️ لم يتم تحديث سعر العقد: ${trade.contractTicker}`);
    return null;
  }

  return Number(current.toFixed(2));
}

async function updateActiveTrades() {
  for (const [key, trade] of activeTrades.entries()) {
    try {
      if (trade.status !== 'OPEN') continue;

      const current = await refreshTradeData(trade);
      if (!current) continue;

      trade.current = current;
      trade.highestPrice = Math.max(
        Number(trade.highestPrice || trade.entry),
        Number(current)
      );

      const profitNow = pnlPercent(trade.entry, trade.current);

      if (profitNow >= 10 && !trade.profit10Sent) {
        trade.profit10Sent = true;
        await sendProfitUpdate(trade, 10);
      }

      if (profitNow >= 20 && !trade.profit20Sent) {
        trade.profit20Sent = true;
        await sendProfitUpdate(trade, 20);
      }

      if (profitNow >= 30 && !trade.profit30Sent) {
        trade.profit30Sent = true;
        await sendProfitUpdate(trade, 30);
      }

      if (
        !trade.nearTargetSent &&
        trade.current >= trade.target * 0.90
      ) {
        trade.nearTargetSent = true;
        await sendNearTarget(trade);
      }

      if (
        !trade.nearStopSent &&
        profitNow <= NEAR_STOP_PERCENT
      ) {
        trade.nearStopSent = true;
        await sendNearStop(trade);
      }

      await updateTradeInSupabase(trade);

      if (trade.current >= trade.target) {
        await sendTargetHit(trade);
        removeTrade();
        continue;
      }

      if (trade.current <= trade.stop) {
        await sendStopHit(trade);
        removeTrade();
        continue;
      }

      if (
        Math.abs(trade.current - trade.lastUpdatePrice) >= UPDATE_STEP
      ) {
        await sendTradeUpdate(trade);
        trade.lastUpdatePrice = trade.current;
      }

    } catch (err) {
      console.error('Update Trade Error:', err.message);
    }
  }
}

// =====================
// Scanner
// =====================

async function scanSingleSPX(force = false) {
  resetDailyMemoryIfNeeded();

  if (botPaused && !force) {
    return {
      ok: false,
      message: '⏸ البوت متوقف عن طرح صفقات جديدة.'
    };
  }

  if (!force && tradesToday >= MAX_TRADES_PER_DAY) {
    return {
      ok: false,
      message: `⛔ تم الوصول للحد اليومي للصفقات: ${MAX_TRADES_PER_DAY}`
    };
  }

  if (alreadyHasActiveTrade()) {
    return {
      ok: false,
      message: '⚠️ توجد صفقة SPX مفتوحة مسبقًا.'
    };
  }

  const marketOpen = await isMarketOpenNow();

  if (!marketOpen) {
    return {
      ok: false,
      message: '⛔ السوق مغلق حاليًا.'
    };
  }

  if (!isAllowedSignalTime()) {
    return {
      ok: false,
      message: '⛔ الوقت الحالي خارج وقت طرح صفقات SPX.'
    };
  }

  const stock = await getSPXSnapshot();

  if (!stock || !stock.price) {
    return {
      ok: false,
      message: '⚠️ لم أستطع جلب بيانات SPX.'
    };
  }

  const technicalBias = await getTechnicalBias();

  if (!technicalBias || technicalBias.side === 'NEUTRAL') {
    return {
      ok: false,
      message: `⚠️ SPX: لا يوجد اتجاه فني واضح. ${technicalBias?.reason || ''}`
    };
  }

  const chain = await getOptionsChain();

  if (!chain.length) {
    return {
      ok: false,
      message: '⚠️ لا توجد عقود SPX متاحة.'
    };
  }

  const trade = selectBestContract(stock, chain, technicalBias);

  if (!trade) {
    return {
      ok: false,
      message: '⚠️ لا توجد صفقة SPX قوية مطابقة للشروط.'
    };
  }

  await sendTradeEntry(trade);

  markTradeActive(trade);

  tradesToday++;

  return {
    ok: true,
    message: `✅ تم إرسال صفقة SPX ${trade.type}.`
  };
}

async function scanForTrades() {
  try {
    if (botPaused) {
      console.log('⏸ SPX Bot paused.');
      return;
    }

    const result = await scanSingleSPX(false);

    console.log(result.message);

  } catch (err) {
    console.error('SPX Scan Error:', err.message);
  }
}

// =====================
// Bot Commands
// =====================

bot.onText(/\/start/, async (msg) => {
  await sendToSameTopic(
    msg,
    `🚀 ST SPX Options Bot يعمل بنجاح

الأوامر:
/spx
/scan
/update
/botstatus
/pause
/resume`
  );
});

bot.onText(/\/id/, async (msg) => {
  await sendToSameTopic(
    msg,
`🆔 بياناتك:

from.id:
${msg.from?.id}

chat.id:
${msg.chat?.id}

thread.id:
${msg.message_thread_id || 'لا يوجد'}`
  );
});

bot.onText(/\/pause/, async (msg) => {
  if (!isAdmin(msg)) return;

  botPaused = true;

  await sendToSameTopic(
    msg,
    '⏸ تم إيقاف طرح صفقات SPX الجديدة.'
  );
});

bot.onText(/\/resume/, async (msg) => {
  if (!isAdmin(msg)) return;

  botPaused = false;

  await sendToSameTopic(
    msg,
    '▶️ تم تشغيل طرح صفقات SPX من جديد.'
  );
});

bot.onText(/\/botstatus/, async (msg) => {
  if (!isAdmin(msg)) return;

  const openTrades =
    [...activeTrades.values()]
      .map(
        t =>
          `• ${contractLabel(t)} | دخول $${fmtPrice(t.entry)} | حالي $${fmtPrice(t.current)} | أعلى $${fmtPrice(t.highestPrice)}`
      )
      .join('\n');

  await sendToSameTopic(
    msg,
`📊 حالة بوت SPX

الحالة:
${botPaused ? '⏸ متوقف' : '▶️ يعمل'}

الفحص:
كل ${SCAN_INTERVAL_MS / 1000} ثانية

تحديث الصفقات:
كل ${UPDATE_INTERVAL_MS / 1000} ثانية

صفقات اليوم:
${tradesToday}/${MAX_TRADES_PER_DAY}

عدد الصفقات المفتوحة:
${activeTrades.size}

الصفقات المفتوحة:
${openTrades || 'لا توجد صفقات'}`
  );
});

bot.onText(/\/spx/, async (msg) => {
  if (!isAdmin(msg)) return;

  await sendToSameTopic(
    msg,
    '🔎 جاري فحص SPX يدويًا...'
  );

  const result = await scanSingleSPX(true);

  await sendToSameTopic(
    msg,
    result.message
  );
});

bot.onText(/\/scan/, async (msg) => {
  if (!isAdmin(msg)) return;

  await sendToSameTopic(
    msg,
    '🔎 جاري فحص SPX...'
  );

  await scanForTrades();

  await sendToSameTopic(
    msg,
    '✅ انتهى الفحص.'
  );
});

bot.onText(/\/update/, async (msg) => {
  if (!isAdmin(msg)) return;

  await sendToSameTopic(
    msg,
    '🔄 جاري تحديث صفقة SPX المفتوحة...'
  );

  await updateActiveTrades();

  await sendToSameTopic(
    msg,
    '✅ انتهى تحديث الصفقات.'
  );
});

bot.onText(/\/stoptrade/, async (msg) => {
  if (!isAdmin(msg)) return;

  if (!activeTrades.has(tradeKey())) {
    await sendToSameTopic(
      msg,
      'لا توجد صفقة SPX مفتوحة.'
    );

    return;
  }

  const trade = activeTrades.get(tradeKey());

  trade.status = 'STOPPED';

  await closeTradeInSupabase(trade);

  removeTrade();

  await sendToSameTopic(
    msg,
    '🛑 تم إغلاق صفقة SPX يدويًا.'
  );
});
// =====================
// Safety Logs
// =====================

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// =====================
// Start Bot
// =====================

(async () => {
  console.log('🚀 Starting ST SPX Options Bot...');

  await loadOpenTradesFromSupabase();

  await updateActiveTrades();

  await scanForTrades();

  setInterval(
    scanForTrades,
    SCAN_INTERVAL_MS
  );

  setInterval(
    updateActiveTrades,
    UPDATE_INTERVAL_MS
  );

  console.log('🚀 ST SPX Options Bot Started');
})();
