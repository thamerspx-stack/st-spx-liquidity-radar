const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log('Telegram bot connected');

bot.on('message', (msg) => {
  console.log('Message:', msg.text);
});

const API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const CHAT_ID = process.env.SPX_CHAT_ID || '';

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BASE_URL = 'https://api.massive.com';

const TEST_MODE = false;

// يفحص كل دقيقة، لكن لا يرسل إلا عند تغيير مهم
const INTERVAL_MS = 60 * 1000;

// منع تكرار نفس التنبيه بسرعة
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

let lastState = null;
let lastAlertSignature = '';
let lastAlertAt = 0;
let botStarted = false;
let intervalStarted = false;

function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.from?.id || ''));
}

function fmtLevel(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'N/A';

  const abs = Math.abs(Number(n));
  const sign = Number(n) >= 0 ? '+' : '-';

  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;

  return `${sign}${abs.toFixed(2)}`;
}

function nowNewYork() {
  return new Date(new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York'
  }));
}

function nowKsa() {
  return new Date(new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Riyadh'
  }));
}

function shortKsaTime() {
  const d = nowKsa();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function nyDateString() {
  const d = nowNewYork();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isMarketTime() {
  if (TEST_MODE) return true;

  const d = nowNewYork();
  const day = d.getDay();
  const h = d.getHours();
  const m = d.getMinutes();
  const minutes = h * 60 + m;

  if (day === 0 || day === 6) return false;

  const open = 9 * 60 + 30;
  const close = 16 * 60;

  return minutes >= open && minutes <= close;
}

function randomCode(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ST-';

  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function hasActiveSubscription(userId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', String(userId))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('Subscription check error:', error.message);
    return false;
  }

  return !!data;
}

async function getActiveSubscribers() {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('user_id, expires_at')
    .gt('expires_at', new Date().toISOString());

  if (error) {
    console.error('Get subscribers error:', error.message);
    return [];
  }

  return data || [];
}

async function createAccessCode(days, createdBy) {
  const code = randomCode();

  const { error } = await supabase.from('access_codes').insert({
    code,
    days,
    created_by: String(createdBy)
  });

  if (error) throw error;

  return code;
}

async function redeemCode(code, user) {
  const cleanCode = String(code || '').trim().toUpperCase();

  const { data: accessCode, error: codeError } = await supabase
    .from('access_codes')
    .select('*')
    .eq('code', cleanCode)
    .maybeSingle();

  if (codeError) throw codeError;

  if (!accessCode) return { ok: false, message: '❌ الكود غير صحيح.' };
  if (accessCode.used) return { ok: false, message: '❌ هذا الكود مستخدم مسبقًا.' };

  const userId = String(user.id);

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const now = new Date();
  const baseDate =
    sub && new Date(sub.expires_at) > now
      ? new Date(sub.expires_at)
      : now;

  const expiresAt = new Date(
    baseDate.getTime() + accessCode.days * 24 * 60 * 60 * 1000
  );

  const { error: upsertError } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      username: user.username || '',
      first_name: user.first_name || '',
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString()
    });

  if (upsertError) throw upsertError;

  const { error: usedError } = await supabase
    .from('access_codes')
    .update({
      used: true,
      used_by: userId,
      used_at: new Date().toISOString()
    })
    .eq('code', cleanCode);

  if (usedError) throw usedError;

  return {
    ok: true,
    expiresAt,
    days: accessCode.days
  };
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

async function getLiveSPXPrice() {
  if (FINNHUB_KEY) {
    const symbols = ['^GSPC', 'SPX'];

    for (const symbol of symbols) {
      try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
        const res = await axios.get(url);
        const price = Number(res.data?.c);

        if (price && price > 1000) {
          console.log(`Live SPX price from Finnhub ${symbol}: ${price}`);
          return Number(price);
        }
      } catch (err) {
        console.log(`Finnhub price failed for ${symbol}:`, err.response?.data || err.message);
      }
    }
  }

  const today = nyDateString();

  const urls = [
    `${BASE_URL}/v3/snapshot/indices?ticker=I:SPX&apiKey=${API_KEY}`,
    `${BASE_URL}/v3/snapshot/indices/I:SPX?apiKey=${API_KEY}`,
    `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent('I:SPX')}/range/1/minute/${today}/${today}?adjusted=true&sort=desc&limit=1&apiKey=${API_KEY}`,
    `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent('I:SPX')}/prev?adjusted=true&apiKey=${API_KEY}`
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url);
      const body = res.data;

      const candidates = [
        body?.results?.[0]?.value,
        body?.results?.[0]?.session?.close,
        body?.results?.[0]?.session?.previous_close,
        body?.results?.[0]?.c,
        body?.results?.[0]?.vw,
        body?.value,
        body?.session?.close,
        body?.session?.previous_close
      ];

      for (const p of candidates) {
        if (p && Number(p) > 1000) {
          console.log(`SPX fallback price from Massive: ${p}`);
          return Number(p);
        }
      }
    } catch (err) {
      console.log('SPX fallback price failed:', err.response?.data || err.message);
    }
  }

  return null;
}

function getFallbackUnderlyingPrice(chain) {
  for (const c of chain) {
    const p =
      c?.underlying_asset?.price ||
      c?.underlying_asset?.last_price ||
      c?.underlying_asset?.value;

    if (p && Number(p) > 1000) return Number(p);
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

  return {
    callsMap: calls,
    putsMap: puts,
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
    ? levelsAll.filter(x => x.strike >= price * 0.9 && x.strike <= price * 1.1)
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

function getLevels(gamma, price) {
  if (!price) {
    return {
      resistance1: null,
      resistance2: null,
      support1: null,
      support2: null,
      balance: null
    };
  }

  const callLevels = Array.from(gamma.callsMap.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => a.strike - b.strike);

  const putLevels = Array.from(gamma.putsMap.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => a.strike - b.strike);

  const resistanceList = callLevels
    .filter(x => x.strike > price)
    .sort((a, b) => a.strike - b.strike);

  const supportList = putLevels
    .filter(x => x.strike < price)
    .sort((a, b) => b.strike - a.strike);

  const sharedLevels = Array.from(gamma.callsMap.keys())
    .filter(strike => gamma.putsMap.has(strike))
    .map(strike => {
      const call = gamma.callsMap.get(strike);
      const put = gamma.putsMap.get(strike);

      return {
        strike,
        callGamma: Math.abs(call?.gamma || 0),
        putGamma: Math.abs(put?.gamma || 0),
        totalGamma: Math.abs(call?.gamma || 0) + Math.abs(put?.gamma || 0),
        distance: Math.abs(strike - price)
      };
    })
    .filter(x => x.totalGamma > 0)
    .sort((a, b) => a.distance - b.distance || b.totalGamma - a.totalGamma);

  return {
    resistance1: resistanceList[0] || null,
    resistance2: resistanceList[1] || null,
    support1: supportList[0] || null,
    support2: supportList[1] || null,
    balance: sharedLevels[0] || null
  };
}

function flowSummary(callVolume, putVolume) {
  const total = callVolume + putVolume || 1;
  const callPct = Math.round((callVolume / total) * 100);
  const putPct = Math.round((putVolume / total) * 100);
  return { callPct, putPct };
}

function levelLine(item) {
  if (!item) return 'N/A';
  return fmtLevel(item.strike);
}

function buildCurrentState() {
  return null;
}

function buildSignature(state) {
  return [
    state.price || 'NO_PRICE',
    state.netGamma,
    state.flow.callPct,
    state.flow.putPct,
    state.flip || 'NO_FLIP',
    state.levels?.resistance1?.strike || 'NO_R1',
    state.levels?.resistance2?.strike || 'NO_R2',
    state.levels?.support1?.strike || 'NO_S1',
    state.levels?.support2?.strike || 'NO_S2',
    state.levels?.balance?.strike || 'NO_BAL'
  ].join('|');
}

function detectAlert(prev, curr) {
  if (!prev) {
    return {
      type: 'INIT',
      title: '📡 ST Gamma Radar — SPX',
      shouldSend: false
    };
  }

  const price = curr.price;
  const prevPrice = prev.price;

  const magnet = curr.levels.balance?.strike;
  const prevMagnet = prev.levels.balance?.strike;

  const flip = curr.flip;
  const prevFlip = prev.flip;

  const resistance1 = curr.levels.resistance1?.strike;
  const resistance2 = curr.levels.resistance2?.strike;
  const support1 = curr.levels.support1?.strike;
  const support2 = curr.levels.support2?.strike;

  const prevCall = prev.flow.callPct;
  const prevPut = prev.flow.putPct;
  const call = curr.flow.callPct;
  const put = curr.flow.putPct;

  const netGammaChangePct =
    prev.netGamma && curr.netGamma
      ? Math.abs((curr.netGamma - prev.netGamma) / prev.netGamma) * 100
      : 0;

  const crossedAboveMagnet =
    magnet && prevPrice && price && prevPrice < magnet && price >= magnet;

  const crossedBelowMagnet =
    magnet && prevPrice && price && prevPrice > magnet && price <= magnet;

  const crossedBelowFlip =
    flip && prevPrice && price && prevPrice > flip && price <= flip;

  const crossedAboveFlip =
    flip && prevPrice && price && prevPrice < flip && price >= flip;

  const magnetChanged =
    magnet && prevMagnet && magnet !== prevMagnet;

  const flowShiftToCall =
    call >= 58 && prevCall < 58;

  const flowShiftToPut =
    put >= 58 && prevPut < 58;

  const nearResistance =
    resistance1 && price && Math.abs(price - resistance1) <= 2;

  const nearSupport =
    support1 && price && Math.abs(price - support1) <= 2;

  if (crossedBelowFlip) {
    return {
      type: 'FLIP_BREAKDOWN',
      shouldSend: true,
      title: '⚠️ Volatility Alert — SPX',
      text:
`السعر كسر Gamma Flip عند ${fmtLevel(flip)}.

🔴 هذا قد يرفع سرعة الحركة والتذبذب.

المناطق الأقرب:
${fmtLevel(support1)} → ${fmtLevel(support2)}

أي عودة فوق ${fmtLevel(flip)} تهدئ القراءة.`
    };
  }

  if (crossedAboveFlip) {
    return {
      type: 'FLIP_RECOVERY',
      shouldSend: true,
      title: '🟢 Gamma Recovery — SPX',
      text:
`السعر استعاد Gamma Flip عند ${fmtLevel(flip)}.

هذا يعيد السوق إلى بيئة أكثر توازنًا.

المقاومات الأقرب:
${fmtLevel(resistance1)} → ${fmtLevel(resistance2)}`
    };
  }

  if (crossedAboveMagnet) {
    return {
      type: 'MAGNET_BREAKOUT',
      shouldSend: true,
      title: '🚨 Gamma Breakout — SPX',
      text:
`السعر اخترق Magnet Zone عند ${fmtLevel(magnet)}.

🟢 هذا يدعم امتداد الحركة نحو:
${fmtLevel(resistance1)} → ${fmtLevel(resistance2)}

⚠️ العودة تحت ${fmtLevel(magnet)} تضعف الزخم.`
    };
  }

  if (crossedBelowMagnet) {
    return {
      type: 'MAGNET_REJECTION',
      shouldSend: true,
      title: '⚠️ Gamma Rejection — SPX',
      text:
`السعر فشل في الثبات فوق Magnet Zone عند ${fmtLevel(magnet)}.

هذا قد يعيد السوق للتماسك أو الضغط نحو:
${fmtLevel(support1)} → ${fmtLevel(support2)}

اختراق ${fmtLevel(magnet)} مرة أخرى يعيد الزخم.`
    };
  }

  if (magnetChanged) {
    return {
      type: 'MAGNET_SHIFT',
      shouldSend: true,
      title: '🧲 Magnet Shift — SPX',
      text:
`تغيرت منطقة الجذب الرئيسية:

من ${fmtLevel(prevMagnet)}
إلى ${fmtLevel(magnet)}

هذا يعني أن تمركز Gamma انتقل،
وقد يبدأ السوق بالتماسك حول المنطقة الجديدة.`
    };
  }

  if (flowShiftToCall) {
    return {
      type: 'CALL_FLOW_SHIFT',
      shouldSend: true,
      title: '🟢 Flow Shift — SPX',
      text:
`CALL Flow ارتفع إلى ${call}%.

هذا يدعم الزخم الإيجابي بشرط الثبات فوق:
${fmtLevel(support1)}

الأهداف الأقرب:
${fmtLevel(resistance1)} → ${fmtLevel(resistance2)}`
    };
  }

  if (flowShiftToPut) {
    return {
      type: '🔴 PUT_FLOW_SHIFT',
      shouldSend: true,
      title: '🔴 Flow Shift — SPX',
      text:
`PUT Flow ارتفع إلى ${put}%.

هذا يعني أن التحوط أو الضغط البيعي بدأ يزيد.

كسر ${fmtLevel(support1)} قد يفتح الطريق نحو:
${fmtLevel(support2)}`
    };
  }

  if (nearResistance) {
    return {
      type: 'NEAR_RESISTANCE',
      shouldSend: true,
      title: '🟥 Gamma Resistance Test — SPX',
      text:
`السعر يختبر مقاومة Gamma عند ${fmtLevel(resistance1)}.

اختراقها قد يدفع السوق نحو:
${fmtLevel(resistance2)}

الفشل عندها قد يعيد السعر نحو:
${fmtLevel(support1)}`
    };
  }

  if (nearSupport) {
    return {
      type: 'NEAR_SUPPORT',
      shouldSend: true,
      title: '🟩 Gamma Support Test — SPX',
      text:
`السعر يختبر دعم Gamma عند ${fmtLevel(support1)}.

الثبات فوقه يحافظ على التماسك.

كسره قد يرفع التذبذب نحو:
${fmtLevel(support2)}`
    };
  }

  if (netGammaChangePct >= 15) {
    return {
      type: 'NET_GAMMA_CHANGE',
      shouldSend: true,
      title: '⚖️ Net Gamma Shift — SPX',
      text:
`تغير واضح في Net Gamma.

السابق: ${fmtCompact(prev.netGamma)}
الحالي: ${fmtCompact(curr.netGamma)}

هذا يعني تغيرًا في قوة استقرار السوق أو حساسية الحركة.`
    };
  }

  return {
    type: 'NO_ALERT',
    shouldSend: false
  };
}

function buildAlertMessage(alert, state) {
  return `
${alert.title}
🕒 ${shortKsaTime()}

${alert.text}

━━━━━━━━━━━━━━
📊 الحالة الحالية

Price: ${state.price ? fmtLevel(state.price) : 'N/A'}
Net Gamma: ${fmtCompact(state.netGamma)}
Gamma Flip: ${state.flip ? fmtLevel(state.flip) : 'N/A'}
Magnet: ${state.levels.balance ? fmtLevel(state.levels.balance.strike) : 'N/A'}

CALL ${state.flow.callPct}% | PUT ${state.flow.putPct}%

━━━━━━━━━━━━━━
⚠️ متابعة تحليلية وليست توصية.
`;
}

async function buildState() {
  const chain = await getOptionsChain('I:SPX');

  const livePrice = await getLiveSPXPrice();
  const fallbackPrice = getFallbackUnderlyingPrice(chain);
  const price = livePrice || fallbackPrice;

  const gamma = aggregateGammaByStrike(chain);
  const flow = flowSummary(gamma.callVolume, gamma.putVolume);
  const levels = getLevels(gamma, price);
  const flip = gammaFlipNearPrice(gamma.netByStrike, price);

  return {
    price,
    netGamma: gamma.netGamma,
    flow,
    levels,
    flip
  };
}

async function buildSnapshotReport() {
  const state = await buildState();

  const text = `
📡 ST Gamma Radar — SPX
🕒 ${shortKsaTime()}

🟢/🔴 الحالة حسب Gamma:
Net Gamma: ${fmtCompact(state.netGamma)}
Gamma Flip: ${state.flip ? fmtLevel(state.flip) : 'N/A'}
Magnet: ${state.levels.balance ? fmtLevel(state.levels.balance.strike) : 'N/A'}

━━━━━━━━━━━━━━
📌 المستويات المهمة

🟥 مقاومة: ${levelLine(state.levels.resistance1)} → ${levelLine(state.levels.resistance2)}
🟩 دعم: ${levelLine(state.levels.support1)} → ${levelLine(state.levels.support2)}

━━━━━━━━━━━━━━
🔥 Flow

CALL ${state.flow.callPct}% | PUT ${state.flow.putPct}%

━━━━━━━━━━━━━━
⚠️ متابعة تحليلية وليست توصية.
`;

  return { text, state };
}

async function sendReportToActiveSubscribers(text) {
  const subscribers = await getActiveSubscribers();
  const targets = new Set();

  for (const sub of subscribers) {
    if (sub.user_id) targets.add(String(sub.user_id));
  }

  if (CHAT_ID) {
    targets.add(String(CHAT_ID));
  }

  for (const chatId of targets) {
    try {
      await bot.sendMessage(chatId, text);
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
    }
  }
}

async function scanAndAlert(force = false, targetChatId = null) {
  try {
    if (!isMarketTime()) {
      console.log('Market closed. Skipping scan.');
      return;
    }

    if (force && targetChatId) {
      const snapshot = await buildSnapshotReport();
      await bot.sendMessage(targetChatId, snapshot.text);
      lastState = snapshot.state;
      return;
    }

    const curr = await buildState();
    const alert = detectAlert(lastState, curr);
    const signature = alert.type + '|' + buildSignature(curr);

    lastState = curr;

    if (!alert.shouldSend) {
      console.log('No important Gamma alert.');
      return;
    }

    const now = Date.now();

    if (signature === lastAlertSignature && now - lastAlertAt < ALERT_COOLDOWN_MS) {
      console.log('Duplicate alert skipped.');
      return;
    }

    const msg = buildAlertMessage(alert, curr);

    await sendReportToActiveSubscribers(msg);

    lastAlertSignature = signature;
    lastAlertAt = now;

    console.log('Gamma alert sent:', alert.type);

  } catch (err) {
    console.error('SPX BOT ERROR:', err.response?.data || err.message);
  }
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `هلا بك في ST Gamma Radar.

البوت لا يرسل رسائل مكررة كل 5 دقائق.
يرسل فقط عند وجود تغير مهم في Gamma / Flow / Magnet / Flip.

لتفعيل الاشتراك:
أرسل كود الاشتراك مباشرة هنا.

مثال:
ST-ABCDEFG123

لمعرفة حالة اشتراكك:
/my`
  );
});

bot.onText(/\/create(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  const days = Number(match[1] || 30);

  if (!days || days < 1 || days > 365) {
    return bot.sendMessage(msg.chat.id, '❌ استخدم الأمر بهذا الشكل:\n/create 30');
  }

  try {
    const code = await createAccessCode(days, msg.from.id);

    await bot.sendMessage(
      msg.chat.id,
      `✅ تم إنشاء كود اشتراك

الكود:
${code}

المدة:
${days} يوم`
    );
  } catch (err) {
    console.error('Create code error:', err.message);
    await bot.sendMessage(msg.chat.id, '❌ حدث خطأ أثناء إنشاء الكود.');
  }
});

bot.on('message', async (msg) => {
  const text = String(msg.text || '').trim().toUpperCase();

  if (!text) return;
  if (text.startsWith('/')) return;
  if (!text.startsWith('ST-')) return;

  try {
    const result = await redeemCode(text, msg.from);

    if (!result.ok) {
      return bot.sendMessage(msg.chat.id, result.message);
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ تم تفعيل اشتراكك بنجاح

المدة المضافة: ${result.days} يوم
ينتهي الاشتراك:
${result.expiresAt.toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' })}`
    );
  } catch (err) {
    console.error('Redeem direct code error:', err.message);
    await bot.sendMessage(msg.chat.id, '❌ حدث خطأ أثناء تفعيل الكود.');
  }
});

bot.onText(/\/my/, async (msg) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', String(msg.from.id))
    .maybeSingle();

  if (error) {
    return bot.sendMessage(msg.chat.id, '❌ حدث خطأ أثناء فحص الاشتراك.');
  }

  if (!data) {
    return bot.sendMessage(msg.chat.id, '❌ لا يوجد اشتراك مفعل على حسابك.');
  }

  const expiresAt = new Date(data.expires_at);
  const active = expiresAt > new Date();

  await bot.sendMessage(
    msg.chat.id,
    `${active ? '✅ اشتراكك فعال' : '❌ اشتراكك منتهي'}

ينتهي في:
${expiresAt.toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' })}`
  );
});

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  const subscribers = await getActiveSubscribers();

  return bot.sendMessage(
    msg.chat.id,
    `👑 لوحة الإدارة

✅ البوت شغال
🧪 TEST_MODE: ${TEST_MODE ? 'مفعل' : 'مغلق'}
👤 عدد المدراء: ${ADMIN_IDS.length}
✅ المشتركين النشطين: ${subscribers.length}

وضع التشغيل:
Alerts only

الأوامر:
/create 30
/my
/test
/status`
  );
});

bot.onText(/\/status/, async (msg) => {
  const active = await hasActiveSubscription(msg.from.id);

  await bot.sendMessage(
    msg.chat.id,
    `✅ ST Gamma Radar شغال
⚡ الوضع: Alerts only
⏱ الفحص كل دقيقة
🔐 اشتراكك: ${active ? 'فعال ✅' : 'غير فعال ❌'}`
  );
});

bot.onText(/\/test/, async (msg) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  await bot.sendMessage(msg.chat.id, '⏳ جاري إرسال Snapshot تجريبي...');
  await scanAndAlert(true, msg.chat.id);
});

console.log('ST Gamma Radar is running...');

async function startBot() {
  if (botStarted) {
    console.log('Bot already started.');
    return;
  }

  botStarted = true;

  try {
    // أول قراءة فقط لتخزين الحالة، بدون إرسال
    if (isMarketTime()) {
      lastState = await buildState();
      console.log('Initial Gamma state loaded.');
    }

    if (!intervalStarted) {
      intervalStarted = true;

      setInterval(async () => {
        try {
          await scanAndAlert(false);
        } catch (err) {
          console.log('Interval scan error:', err.response?.data || err.message);
        }
      }, INTERVAL_MS);
    }

    console.log('Gamma alert loop started.');

  } catch (err) {
    console.log('Bot startup error:', err.response?.data || err.message);
  }
}

const express = require('express');

const app = express();

app.use(express.json());

app.post('/webhook', async (req, res) => {

  try {

    console.log('Webhook received:', req.body);

    const {
      symbol,
      side,
      price
    } = req.body;

    if (!symbol || !side) {
      return res.status(400).send('Missing fields');
    }

    await bot.sendMessage(
      CHAT_ID,
      `🚨 TradingView Signal\n\n📊 ${symbol}\n📈 ${side}\n💵 Price: ${price || 'N/A'}`
    );

    res.send('OK');

  } catch (err) {

    console.log('Webhook error:', err.message);

    res.status(500).send('ERROR');

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Webhook server running on ${PORT}`);
});

startBot();
