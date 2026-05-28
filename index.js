const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const CHAT_ID = process.env.SPX_CHAT_ID;

const BASE_URL = 'https://api.massive.com';

const TEST_MODE = true;

const INTERVAL_MS = 5 * 60 * 1000;
const SEND_EVERY_MS = 15 * 60 * 1000;

let lastSentSignature = '';
let lastSentAt = 0;

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function nowKsa() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
}

function isMarketTime() {
  if (TEST_MODE) return true;

  const d = nowKsa();
  const day = d.getDay();
  const h = d.getHours();
  const m = d.getMinutes();
  const minutes = h * 60 + m;

  if (day === 5 || day === 6) return false;

  const open = 16 * 60 + 30;
  const close = 23 * 60;

  return minutes >= open && minutes <= close;
}

async function getSpyPrice() {
  const url = `${BASE_URL}/v2/aggs/ticker/SPY/prev?adjusted=true&apiKey=${API_KEY}`;
  const res = await axios.get(url);
  return res.data?.results?.[0]?.c || null;
}

async function getOptionsChain(symbol) {
  let results = [];
  let url = `${BASE_URL}/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  for (let i = 0; i < 4; i++) {
    const res = await axios.get(url);
    results = results.concat(res.data?.results || []);

    if (!res.data?.next_url) break;
    url = `${res.data.next_url}&apiKey=${API_KEY}`;
  }

  return results;
}

function calcGex(contract) {
  const gamma = Number(contract?.greeks?.gamma || 0);
  const oi = Number(contract?.open_interest || 0);
  const strike = Number(contract?.details?.strike_price || 0);
  const type = contract?.details?.contract_type;

  let gex = gamma * oi * 100 * strike;

  if (type === 'put') gex *= -1;

  return gex;
}

function topGamma(chain, type) {
  return chain
    .filter(c => c?.details?.contract_type === type)
    .map(c => ({
      strike: c.details.strike_price,
      gex: calcGex(c),
      volume: c.day?.volume || 0,
      oi: c.open_interest || 0
    }))
    .filter(x => x.strike && Math.abs(x.gex) > 0)
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 3);
}

function gammaFlip(chain) {
  const levels = {};

  for (const c of chain) {
    const strike = c?.details?.strike_price;
    if (!strike) continue;
    levels[strike] = (levels[strike] || 0) + calcGex(c);
  }

  const sorted = Object.entries(levels)
    .map(([strike, gex]) => ({ strike: Number(strike), gex }))
    .sort((a, b) => a.strike - b.strike);

  let cumulative = 0;

  for (const lvl of sorted) {
    cumulative += lvl.gex;
    if (cumulative > 0) return lvl.strike;
  }

  return null;
}

function flowSummary(chain) {
  let callVolume = 0;
  let putVolume = 0;

  for (const c of chain) {
    const type = c?.details?.contract_type;
    const volume = Number(c?.day?.volume || 0);

    if (type === 'call') callVolume += volume;
    if (type === 'put') putVolume += volume;
  }

  const total = callVolume + putVolume || 1;

  const callPct = Math.round((callVolume / total) * 100);
  const putPct = Math.round((putVolume / total) * 100);

  let bias = 'عرضي';
  if (callPct >= 58) bias = 'إيجابي';
  if (putPct >= 58) bias = 'سلبي';

  return { callPct, putPct, bias };
}

function institutionalText(flow) {
  if (flow.bias === 'إيجابي') {
    return `تم رصد تدفقات CALL مؤسسية على SPY و QQQ،
مما يدعم استمرار الزخم الإيجابي في السوق.`;
  }

  if (flow.bias === 'سلبي') {
    return `تم رصد زيادة في تدفقات PUT على SPY و QQQ،
مع استمرار الضغط البيعي وضعف الزخم الصاعد.`;
  }

  return `التدفقات المؤسسية على SPY و QQQ متوازنة حاليًا،
ولا توجد سيطرة واضحة مع استمرار التذبذب العرضي.`;
}

function aiSummary(price, flip, flow, topCall, topPut) {
  if (!flip) return 'لا توجد قراءة كافية حاليًا لتحديد Gamma Flip.';

  if (price > flip && flow.bias === 'إيجابي') {
    return `السوق يميل للإيجابية طالما السعر فوق Gamma Flip ${fmt(flip)}.

اختراق ${fmt(topCall?.strike)} قد يدعم استمرار الزخم الصاعد،
بينما كسر ${fmt(topPut?.strike)} قد يضعف القراءة الإيجابية.`;
  }

  if (price < flip && flow.bias === 'سلبي') {
    return `السوق يميل للسلبية طالما السعر تحت Gamma Flip ${fmt(flip)}.

الثبات تحت ${fmt(flip)} يبقي الضغط البيعي قائمًا،
وأقرب منطقة دفاع مهمة عند ${fmt(topPut?.strike)}.`;
  }

  return `السوق متذبذب حاليًا قرب مستويات الجاما.

لا توجد سيطرة واضحة بين CALL و PUT،
والأفضل مراقبة Gamma Flip عند ${fmt(flip)} قبل ترجيح الاتجاه.`;
}

function buildSignature(data) {
  return [
    data.flow.bias,
    data.flip,
    data.calls.map(x => x.strike).join(','),
    data.puts.map(x => x.strike).join(',')
  ].join('|');
}

async function buildReport() {
  const price = await getSpyPrice();
  const spxChain = await getOptionsChain('SPX');

  const calls = topGamma(spxChain, 'call');
  const puts = topGamma(spxChain, 'put');
  const flip = gammaFlip(spxChain);
  const flow = flowSummary(spxChain);

  const data = { price, calls, puts, flip, flow };
  const signature = buildSignature(data);

  const text = `
🧠 ST SPX Liquidity Radar

📊 SPX: ${fmt(price)}
📈 الحالة: ${flow.bias === 'إيجابي' ? '🟢 إيجابية' : flow.bias === 'سلبي' ? '🔴 سلبية' : '🟡 عرضية'}
⏱ التحديث: الآن

━━━━━━━━━━━━━━
🟩 أعلى Gamma CALLS

1. CALL ${calls[0]?.strike || 'N/A'}
📊 GEX Exposure: +${fmt(Math.abs(calls[0]?.gex || 0))}

2. CALL ${calls[1]?.strike || 'N/A'}
📊 GEX Exposure: +${fmt(Math.abs(calls[1]?.gex || 0))}

3. CALL ${calls[2]?.strike || 'N/A'}
📊 GEX Exposure: +${fmt(Math.abs(calls[2]?.gex || 0))}

━━━━━━━━━━━━━━
🟥 أعلى Gamma PUTS

1. PUT ${puts[0]?.strike || 'N/A'}
📊 GEX Exposure: -${fmt(Math.abs(puts[0]?.gex || 0))}

2. PUT ${puts[1]?.strike || 'N/A'}
📊 GEX Exposure: -${fmt(Math.abs(puts[1]?.gex || 0))}

3. PUT ${puts[2]?.strike || 'N/A'}
📊 GEX Exposure: -${fmt(Math.abs(puts[2]?.gex || 0))}

━━━━━━━━━━━━━━
🎯 Gamma Flip

📍 المستوى: ${fmt(flip)}

${price > flip ? 'السعر فوق Gamma Flip ✅' : 'السعر تحت Gamma Flip 🔻'}

━━━━━━━━━━━━━━
🔥 Options Flow

🟢 سيطرة الكول: ${flow.callPct}%
🔴 سيطرة البوت: ${flow.putPct}%

━━━━━━━━━━━━━━
🌑 السيولة المؤسسية

${institutionalText(flow)}

━━━━━━━━━━━━━━
🤖 AI Market Summary

${aiSummary(price, flip, flow, calls[0], puts[0])}

━━━━━━━━━━━━━━
⚠️ هذه متابعة تحليلية وليست توصية شراء أو بيع.
`;

  return { text, signature };
}

async function scanAndSend() {
  try {
    if (!isMarketTime()) {
      console.log('Market closed. Skipping scan.');
      return;
    }

    const { text, signature } = await buildReport();

    const now = Date.now();
    const changed = signature !== lastSentSignature;
    const timePassed = now - lastSentAt >= SEND_EVERY_MS;

    if (changed || timePassed) {
      await bot.sendMessage(CHAT_ID, text);
      lastSentSignature = signature;
      lastSentAt = now;
      console.log('SPX report sent.');
    } else {
      console.log('No important change. Skipping message.');
    }
  } catch (err) {
    console.error('SPX BOT ERROR:', err.response?.data || err.message);
  }
}

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `✅ ST SPX Liquidity Radar شغال
⏱ الفحص كل 5 دقائق
🧪 TEST_MODE: ${TEST_MODE ? 'مفعل' : 'مغلق'}`
  );
});

scanAndSend();
setInterval(scanAndSend, INTERVAL_MS);

console.log('ST SPX Liquidity Radar is running...');
