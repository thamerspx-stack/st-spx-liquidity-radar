const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
const CHAT_ID = process.env.SPX_CHAT_ID;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const BASE_URL = 'https://api.massive.com';

const TEST_MODE = true;

const INTERVAL_MS = 5 * 60 * 1000;
const SEND_EVERY_MS = 15 * 60 * 1000;

let lastSentSignature = '';
let lastSentAt = 0;

function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.from?.id || ''));
}

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

async function getSpxPrice() {
  const symbols = ['I:SPX', 'SPX'];

  for (const symbol of symbols) {
    try {
      const url = `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true&apiKey=${API_KEY}`;
      const res = await axios.get(url);
      const price = res.data?.results?.[0]?.c;

      if (price) return price;
    } catch (err) {
      console.log(`Price failed for ${symbol}:`, err.response?.data || err.message);
    }
  }

  return null;
}

async function getOptionsChain(symbol) {
  let results = [];
  let url = `${BASE_URL}/v3/snapshot/options/${encodeURIComponent(symbol)}?limit=250&apiKey=${API_KEY}`;

  for (let i = 0; i < 8; i++) {
    const res = await axios.get(url);
    results = results.concat(res.data?.results || []);

    if (!res.data?.next_url) break;

    url = res.data.next_url.includes('apiKey=')
      ? res.data.next_url
      : `${res.data.next_url}&apiKey=${API_KEY}`;
  }

  return results;
}

function calcGex(contract) {
  const gamma = Number(contract?.greeks?.gamma || 0);
  const oi = Number(contract?.open_interest || 0);
  const strike = Number(contract?.details?.strike_price || 0);
  const type = String(contract?.details?.contract_type || '').toLowerCase();

  if (!gamma || !oi || !strike) return 0;

  let gex = gamma * oi * 100 * strike;

  if (type === 'put') gex *= -1;

  return gex;
}

function topGamma(chain, type) {
  return chain
    .filter(c => String(c?.details?.contract_type || '').toLowerCase() === type)
    .map(c => ({
      strike: c.details?.strike_price,
      gex: calcGex(c),
      gamma: Number(c?.greeks?.gamma || 0),
      volume: Number(c?.day?.volume || 0),
      oi: Number(c?.open_interest || 0)
    }))
    .filter(x => x.strike && Math.abs(x.gex) > 0)
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 3);
}

function gammaFlip(chain) {
  const levels = {};

  for (const c of chain) {
    const strike = Number(c?.details?.strike_price || 0);
    if (!strike) continue;

    const gex = calcGex(c);
    if (!gex) continue;

    levels[strike] = (levels[strike] || 0) + gex;
  }

  const sorted = Object.entries(levels)
    .map(([strike, gex]) => ({ strike: Number(strike), gex }))
    .sort((a, b) => a.strike - b.strike);

  if (!sorted.length) return null;

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
    const type = String(c?.details?.contract_type || '').toLowerCase();
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

  return { callPct, putPct, bias, callVolume, putVolume };
}

function liquidityText(flow) {
  if (flow.bias === 'إيجابي') {
    return `تم رصد تفوق واضح في تدفقات CALL على عقود SPX،
مما يدعم الزخم الإيجابي الحالي بشرط ثبات السعر فوق مناطق الدعم.`;
  }

  if (flow.bias === 'سلبي') {
    return `تم رصد تفوق واضح في تدفقات PUT على عقود SPX،
مما يعكس ضغطًا بيعيًا وحذرًا في حركة السوق الحالية.`;
  }

  return `تدفقات عقود SPX متوازنة حاليًا بين CALL و PUT،
ولا توجد سيطرة واضحة مع استمرار التذبذب العرضي.`;
}

function aiSummary(price, flip, flow, topCall, topPut, hasGamma) {
  if (!hasGamma) {
    return `بيانات GEX / Gamma غير متوفرة حاليًا من الاشتراك أو من مزود البيانات.

القراءة الحالية مبنية فقط على حجم تدفق العقود CALL / PUT، لذلك لا يتم اعتماد Gamma Flip حتى تتوفر بيانات Greeks.`;
  }

  if (!flip || !price) return 'لا توجد قراءة كافية حاليًا لتحديد موقع السعر مقابل Gamma Flip.';

  if (price > flip && flow.bias === 'إيجابي') {
    return `السوق يميل للإيجابية طالما SPX فوق Gamma Flip ${fmt(flip)}.

اختراق ${fmt(topCall?.strike)} قد يدعم استمرار الزخم الصاعد،
بينما كسر ${fmt(topPut?.strike)} قد يضعف القراءة الإيجابية.`;
  }

  if (price < flip && flow.bias === 'سلبي') {
    return `السوق يميل للسلبية طالما SPX تحت Gamma Flip ${fmt(flip)}.

الثبات تحت ${fmt(flip)} يبقي الضغط البيعي قائمًا،
وأقرب منطقة دفاع مهمة عند ${fmt(topPut?.strike)}.`;
  }

  return `السوق متذبذب حاليًا قرب مستويات الجاما.

لا توجد سيطرة واضحة بين CALL و PUT،
والأفضل مراقبة Gamma Flip عند ${fmt(flip)} قبل ترجيح الاتجاه.`;
}

function gexLine(item, type) {
  if (!item) {
    return `${type} N/A
📊 GEX Exposure: غير متوفر`;
  }

  const sign = type === 'CALL' ? '+' : '-';

  return `${type} ${item.strike}
📊 GEX Exposure: ${sign}${fmt(Math.abs(item.gex))}`;
}

function gammaStatusText(price, flip, hasGamma) {
  if (!hasGamma) return 'بيانات Gamma غير متوفرة من مزود البيانات حاليًا ⚠️';
  if (!price || !flip) return 'لا يمكن تحديد موقع السعر مقابل Gamma Flip حاليًا ⚠️';

  return price > flip
    ? 'السعر فوق Gamma Flip ✅'
    : 'السعر تحت Gamma Flip 🔻';
}

function buildSignature(data) {
  return [
    data.flow.bias,
    data.flip || 'NO_FLIP',
    data.calls.map(x => x.strike).join(',') || 'NO_CALL_GEX',
    data.puts.map(x => x.strike).join(',') || 'NO_PUT_GEX',
    data.flow.callPct,
    data.flow.putPct
  ].join('|');
}

async function buildReport() {
  const price = await getSpxPrice();

  // مهم: لعقود المؤشرات نستخدم I:SPX
  const spxChain = await getOptionsChain('I:SPX');

  const calls = topGamma(spxChain, 'call');
  const puts = topGamma(spxChain, 'put');
  const flip = gammaFlip(spxChain);
  const flow = flowSummary(spxChain);

  const hasGamma = calls.length > 0 || puts.length > 0 || flip !== null;

  const data = { price, calls, puts, flip, flow };
  const signature = buildSignature(data);

  const text = `
🧠 ST SPX Liquidity Radar

📊 SPX: ${fmt(price)}
📈 الحالة: ${flow.bias === 'إيجابي' ? '🟢 إيجابية' : flow.bias === 'سلبي' ? '🔴 سلبية' : '🟡 عرضية'}
⏱ التحديث: الآن

━━━━━━━━━━━━━━
🟩 أعلى Gamma CALLS

1. ${gexLine(calls[0], 'CALL')}

2. ${gexLine(calls[1], 'CALL')}

3. ${gexLine(calls[2], 'CALL')}

━━━━━━━━━━━━━━
🟥 أعلى Gamma PUTS

1. ${gexLine(puts[0], 'PUT')}

2. ${gexLine(puts[1], 'PUT')}

3. ${gexLine(puts[2], 'PUT')}

━━━━━━━━━━━━━━
🎯 Gamma Flip

📍 المستوى: ${flip ? fmt(flip) : 'غير متوفر'}

${gammaStatusText(price, flip, hasGamma)}

━━━━━━━━━━━━━━
🔥 Options Flow

🟢 سيطرة الكول: ${flow.callPct}%
🔴 سيطرة البوت: ${flow.putPct}%

حجم CALL: ${fmt(flow.callVolume)}
حجم PUT: ${fmt(flow.putVolume)}

━━━━━━━━━━━━━━
🌑 السيولة المؤسسية

${liquidityText(flow)}

━━━━━━━━━━━━━━
🤖 AI Market Summary

${aiSummary(price, flip, flow, calls[0], puts[0], hasGamma)}

━━━━━━━━━━━━━━
⚠️ هذه متابعة تحليلية وليست توصية شراء أو بيع.
`;

  return { text, signature };
}

async function scanAndSend(force = false) {
  try {
    if (!isMarketTime()) {
      console.log('Market closed. Skipping scan.');
      return;
    }

    const { text, signature } = await buildReport();

    const now = Date.now();
    const changed = signature !== lastSentSignature;
    const timePassed = now - lastSentAt >= SEND_EVERY_MS;

    if (force || changed || timePassed) {
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

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  return bot.sendMessage(
    msg.chat.id,
    `👑 لوحة الإدارة

✅ البوت شغال
🧪 TEST_MODE: ${TEST_MODE ? 'مفعل' : 'مغلق'}
👤 عدد المدراء: ${ADMIN_IDS.length}

الأوامر الحالية:
/admin
/status
/test`
  );
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `✅ ST SPX Liquidity Radar شغال
⏱ الفحص كل 5 دقائق
🧪 TEST_MODE: ${TEST_MODE ? 'مفعل' : 'مغلق'}`
  );
});

bot.onText(/\/test/, async (msg) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  await bot.sendMessage(msg.chat.id, '⏳ جاري إرسال تقرير تجريبي...');
  await scanAndSend(true);
});

scanAndSend(true);
setInterval(scanAndSend, INTERVAL_MS);

console.log('ST SPX Liquidity Radar is running...');
