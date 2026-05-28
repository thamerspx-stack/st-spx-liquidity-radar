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

const TOP_N = 5;
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

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
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

async function getOptionsChain(symbol) {
  let results = [];
  let url = `${BASE_URL}/v3/snapshot/options/${encodeURIComponent(symbol)}?limit=250&apiKey=${API_KEY}`;

  for (let i = 0; i < 12; i++) {
    const res = await axios.get(url);
    results = results.concat(res.data?.results || []);

    if (!res.data?.next_url) break;

    url = res.data.next_url.includes('apiKey=')
      ? res.data.next_url
      : `${res.data.next_url}&apiKey=${API_KEY}`;
  }

  return results;
}

function getUnderlyingPrice(chain) {
  for (const c of chain) {
    const p =
      c?.underlying_asset?.price ||
      c?.underlying_asset?.last_price ||
      c?.underlying_asset?.value;

    if (p && Number(p) > 0) return Number(p);
  }

  return null;
}

function calcGexRaw(contract) {
  const gamma = Number(contract?.greeks?.gamma || 0);
  const oi = Number(contract?.open_interest || 0);
  const strike = Number(contract?.details?.strike_price || 0);

  if (!gamma || !oi || !strike) return 0;

  return gamma * oi * 100 * strike;
}

function contractType(contract) {
  return String(contract?.details?.contract_type || '').toLowerCase();
}

function aggregateGammaByStrike(chain) {
  const calls = new Map();
  const puts = new Map();
  const netByStrike = new Map();

  let totalCallGamma = 0;
  let totalPutGamma = 0;
  let callVolume = 0;
  let putVolume = 0;

  for (const c of chain) {
    const type = contractType(c);
    const strike = Number(c?.details?.strike_price || 0);
    const volume = Number(c?.day?.volume || 0);
    const oi = Number(c?.open_interest || 0);
    const gammaRaw = calcGexRaw(c);

    if (!strike) continue;

    if (type === 'call') {
      callVolume += volume;
      totalCallGamma += gammaRaw;

      const old = calls.get(strike) || { strike, gamma: 0, volume: 0, oi: 0 };
      old.gamma += gammaRaw;
      old.volume += volume;
      old.oi += oi;
      calls.set(strike, old);

      netByStrike.set(strike, (netByStrike.get(strike) || 0) + gammaRaw);
    }

    if (type === 'put') {
      putVolume += volume;
      totalPutGamma -= gammaRaw;

      const old = puts.get(strike) || { strike, gamma: 0, volume: 0, oi: 0 };
      old.gamma -= gammaRaw;
      old.volume += volume;
      old.oi += oi;
      puts.set(strike, old);

      netByStrike.set(strike, (netByStrike.get(strike) || 0) - gammaRaw);
    }
  }

  const topCalls = Array.from(calls.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, TOP_N);

  const topPuts = Array.from(puts.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, TOP_N);

  return {
    topCalls,
    topPuts,
    totalCallGamma,
    totalPutGamma,
    netGamma: totalCallGamma + totalPutGamma,
    callVolume,
    putVolume,
    netByStrike
  };
}

function gammaFlipNearPrice(netByStrike, price) {
  const levelsAll = Array.from(netByStrike.entries())
    .map(([strike, gamma]) => ({ strike: Number(strike), gamma: Number(gamma) }))
    .filter(x => x.strike > 0 && x.gamma !== 0)
    .sort((a, b) => a.strike - b.strike);

  if (!levelsAll.length) return null;

  const levels = price
    ? levelsAll.filter(x => x.strike >= price * 0.75 && x.strike <= price * 1.25)
    : levelsAll;

  if (!levels.length) return null;

  let best = null;

  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1];
    const curr = levels[i];

    const crossed =
      (prev.gamma < 0 && curr.gamma > 0) ||
      (prev.gamma > 0 && curr.gamma < 0);

    if (crossed) {
      const mid = (prev.strike + curr.strike) / 2;
      const distance = price ? Math.abs(mid - price) : Math.abs(mid);

      if (!best || distance < best.distance) {
        best = { strike: mid, distance };
      }
    }
  }

  if (best) return best.strike;

  const nearestSmallestAbs = levels
    .map(x => ({
      strike: x.strike,
      distance: price ? Math.abs(x.strike - price) : Math.abs(x.strike),
      absGamma: Math.abs(x.gamma)
    }))
    .sort((a, b) => a.distance - b.distance || a.absGamma - b.absGamma)[0];

  return nearestSmallestAbs?.strike || null;
}

function flowSummary(callVolume, putVolume) {
  const total = callVolume + putVolume || 1;

  const callPct = Math.round((callVolume / total) * 100);
  const putPct = Math.round((putVolume / total) * 100);

  let bias = 'عرضي';
  if (callPct >= 58) bias = 'إيجابي';
  if (putPct >= 58) bias = 'سلبي';

  return { callPct, putPct, bias };
}

function marketBiasByGamma(netGamma, flow) {
  if (netGamma > 0 && flow.bias === 'إيجابي') return '🟢 إيجابية';
  if (netGamma < 0 && flow.bias === 'سلبي') return '🔴 سلبية';
  if (netGamma < 0) return '🟠 سلبية / متذبذبة';
  if (netGamma > 0) return '🟢 إيجابية / مستقرة';
  return '🟡 عرضية';
}

function liquidityText(flow, netGamma) {
  if (flow.bias === 'إيجابي' && netGamma > 0) {
    return `تدفقات CALL متقدمة مع Net Gamma إيجابي،
وهذا يدعم بيئة أكثر استقرارًا وإيجابية طالما السعر فوق مناطق الدعم.`;
  }

  if (flow.bias === 'سلبي' && netGamma < 0) {
    return `تدفقات PUT متقدمة مع Net Gamma سلبي،
وهذا يعكس ضغطًا بيعيًا واحتمالية حركة أكثر عنفًا في السوق.`;
  }

  if (netGamma < 0) {
    return `رغم توازن التدفقات، Net Gamma ما زال سلبيًا،
وهذا يعني أن السوق قابل للتذبذب والحركات السريعة.`;
  }

  return `التدفقات الحالية متوازنة نسبيًا،
ولا توجد سيطرة واضحة بين CALL و PUT في هذه اللحظة.`;
}

function aiSummary(price, flip, flow, netGamma, topCall, topPut) {
  const netText = netGamma > 0 ? 'إيجابي' : netGamma < 0 ? 'سلبي' : 'محايد';

  if (!price || !flip) {
    return `القراءة الحالية تعتمد على GEX وOptions Flow.

Net Gamma: ${netText}
سيطرة الكول: ${flow.callPct}%
سيطرة البوت: ${flow.putPct}%`;
  }

  if (price > flip && flow.bias === 'إيجابي' && netGamma > 0) {
    return `السوق يميل للإيجابية طالما SPX فوق Gamma Flip عند ${fmt(flip)}.

أقوى مقاومة Gamma قريبة عند ${fmt(topCall?.strike)}،
وأقوى دعم Gamma قريب عند ${fmt(topPut?.strike)}.`;
  }

  if (price < flip && netGamma < 0) {
    return `السوق تحت Gamma Flip عند ${fmt(flip)} مع Net Gamma سلبي.

هذا يعني بيئة أكثر خطورة وتذبذبًا،
وأقرب دعم Gamma مهم عند ${fmt(topPut?.strike)}.`;
  }

  if (netGamma < 0) {
    return `Net Gamma سلبي، لذلك السوق قابل لحركة عنيفة حتى لو كانت التدفقات متوازنة.

راقب ${fmt(topPut?.strike)} كدعم مهم،
وراقب ${fmt(topCall?.strike)} كمقاومة مؤثرة.`;
  }

  return `السوق حاليًا في وضع متوازن نسبيًا.

راقب Gamma Flip عند ${fmt(flip)}،
واختراق ${fmt(topCall?.strike)} أو كسر ${fmt(topPut?.strike)} هو الأهم.`;
}

function gammaLine(item, type) {
  if (!item) {
    return `- ${type} N/A | Gamma: غير متوفر`;
  }

  return `- Strike: ${fmtMoney(item.strike)} | Gamma: ${fmt(item.gamma)}`;
}

function buildSignature(data) {
  return [
    data.price || 'NO_PRICE',
    data.flip || 'NO_FLIP',
    data.netGamma,
    data.flow.callPct,
    data.flow.putPct,
    data.topCalls.map(x => x.strike).join(','),
    data.topPuts.map(x => x.strike).join(',')
  ].join('|');
}

async function buildReport() {
  const chain = await getOptionsChain('I:SPX');

  const price = getUnderlyingPrice(chain);

  const gamma = aggregateGammaByStrike(chain);
  const flow = flowSummary(gamma.callVolume, gamma.putVolume);
  const flip = gammaFlipNearPrice(gamma.netByStrike, price);

  const state = marketBiasByGamma(gamma.netGamma, flow);

  const data = {
    price,
    flip,
    netGamma: gamma.netGamma,
    flow,
    topCalls: gamma.topCalls,
    topPuts: gamma.topPuts
  };

  const signature = buildSignature(data);

  const text = `
📊 SPX Gamma Exposure Update
🕒 ${nowKsa().toISOString().replace('T', ' ').slice(0, 19)}
💵 Current Price: ${fmtMoney(price)}
📈 الحالة: ${state}

━━━━━━━━━━━━━━
🟩 Top ${TOP_N} Call Positions
Positive Gamma

${gamma.topCalls.map(x => gammaLine(x, 'CALL')).join('\n') || '- لا توجد بيانات CALL Gamma'}

━━━━━━━━━━━━━━
🟥 Top ${TOP_N} Put Positions
Negative Gamma

${gamma.topPuts.map(x => gammaLine(x, 'PUT')).join('\n') || '- لا توجد بيانات PUT Gamma'}

━━━━━━━━━━━━━━
⚖️ Gamma Summary

Total Call Gamma: ${fmt(gamma.totalCallGamma)}
Total Put Gamma: ${fmt(gamma.totalPutGamma)}
Net Gamma: ${fmt(gamma.netGamma)}

━━━━━━━━━━━━━━
🎯 Gamma Flip

المستوى الأقرب للسعر: ${flip ? fmtMoney(flip) : 'غير متوفر'}

${price && flip ? (price > flip ? 'السعر فوق Gamma Flip ✅' : 'السعر تحت Gamma Flip 🔻') : 'لا يمكن تحديد موقع السعر حاليًا ⚠️'}

━━━━━━━━━━━━━━
🔥 Options Flow

🟢 سيطرة الكول: ${flow.callPct}%
🔴 سيطرة البوت: ${flow.putPct}%

حجم CALL: ${fmt(gamma.callVolume)}
حجم PUT: ${fmt(gamma.putVolume)}

━━━━━━━━━━━━━━
🌑 السيولة المؤسسية

${liquidityText(flow, gamma.netGamma)}

━━━━━━━━━━━━━━
🤖 AI Market Summary

${aiSummary(price, flip, flow, gamma.netGamma, gamma.topCalls[0], gamma.topPuts[0])}

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
