const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_KEY = process.env.MASSIVE_API_KEY;
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

  if (!accessCode) {
    return { ok: false, message: '❌ الكود غير صحيح.' };
  }

  if (accessCode.used) {
    return { ok: false, message: '❌ هذا الكود مستخدم مسبقًا.' };
  }

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

  const expiresAt = new Date(baseDate.getTime() + accessCode.days * 24 * 60 * 60 * 1000);

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

  const topCalls = Array.from(calls.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, TOP_N);

  const topPuts = Array.from(puts.values())
    .filter(x => Math.abs(x.gamma) > 0)
    .sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))
    .slice(0, TOP_N);

  return {
    callsMap: calls,
    putsMap: puts,
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

function nearestGammaLevels(gamma, price) {
  if (!price) {
    return { resistance: null, support: null, balance: null };
  }

  const callLevels = Array.from(gamma.callsMap.values())
    .filter(x => x.strike > price && Math.abs(x.gamma) > 0)
    .sort((a, b) => a.strike - b.strike);

  const putLevels = Array.from(gamma.putsMap.values())
    .filter(x => x.strike < price && Math.abs(x.gamma) > 0)
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
    resistance: callLevels[0] || null,
    support: putLevels[0] || null,
    balance: sharedLevels[0] || null
  };
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
وهذا يدعم بيئة أكثر استقرارًا وإيجابية.`;
  }

  if (flow.bias === 'سلبي' && netGamma < 0) {
    return `تدفقات PUT متقدمة مع Net Gamma سلبي،
وهذا يعكس ضغطًا بيعيًا واحتمالية حركة أكثر عنفًا.`;
  }

  if (netGamma < 0) {
    return `رغم توازن التدفقات، Net Gamma ما زال سلبيًا،
وهذا يعني أن السوق قابل للتذبذب والحركات السريعة.`;
  }

  return `التدفقات الحالية متوازنة نسبيًا،
ولا توجد سيطرة واضحة بين CALL و PUT في هذه اللحظة.`;
}

function gammaLine(item) {
  if (!item) return `- Strike: N/A | Gamma: غير متوفر`;
  return `- Strike: ${fmtMoney(item.strike)} | Gamma: ${fmt(item.gamma)}`;
}

function nearestLine(item) {
  if (!item) return 'غير متوفر';
  return `${fmtMoney(item.strike)} | Gamma: ${fmt(item.gamma)}`;
}

function balanceLine(item) {
  if (!item) return 'غير متوفر';

  return `${fmtMoney(item.strike)}
CALL Gamma: ${fmt(item.callGamma)}
PUT Gamma: -${fmt(item.putGamma)}`;
}

function aiSummary(flow, netGamma, nearest) {
  const resistance = nearest?.resistance?.strike;
  const support = nearest?.support?.strike;
  const balance = nearest?.balance?.strike;

  if (netGamma > 0) {
    return `Net Gamma إيجابي، وهذا يعطي بيئة أكثر استقرارًا.

🟥 أقرب مقاومة Gamma: ${fmtMoney(resistance)}
🟩 أقرب دعم Gamma: ${fmtMoney(support)}
🟨 منطقة التوازن الحالية: ${fmtMoney(balance)}`;
  }

  if (netGamma < 0) {
    return `Net Gamma سلبي، لذلك السوق قابل لحركة عنيفة حتى لو كانت التدفقات متوازنة.

🟥 أقرب مقاومة Gamma: ${fmtMoney(resistance)}
🟩 أقرب دعم Gamma: ${fmtMoney(support)}
🟨 منطقة التوازن الحالية: ${fmtMoney(balance)}`;
  }

  return `السوق حاليًا في وضع متوازن نسبيًا.

سيطرة الكول: ${flow.callPct}%
سيطرة البوت: ${flow.putPct}%`;
}

function buildSignature(data) {
  return [
    data.netGamma,
    data.flow.callPct,
    data.flow.putPct,
    data.topCalls.map(x => x.strike).join(','),
    data.topPuts.map(x => x.strike).join(','),
    data.nearest?.resistance?.strike || 'NO_RES',
    data.nearest?.support?.strike || 'NO_SUP',
    data.nearest?.balance?.strike || 'NO_BAL'
  ].join('|');
}

async function buildReport() {
  const chain = await getOptionsChain('I:SPX');
  const price = getFallbackUnderlyingPrice(chain);

  const gamma = aggregateGammaByStrike(chain);
  const flow = flowSummary(gamma.callVolume, gamma.putVolume);
  const nearest = nearestGammaLevels(gamma, price);
  const state = marketBiasByGamma(gamma.netGamma, flow);

  const data = {
    netGamma: gamma.netGamma,
    flow,
    topCalls: gamma.topCalls,
    topPuts: gamma.topPuts,
    nearest
  };

  const signature = buildSignature(data);

  const text = `
📊 SPX Gamma Exposure Update
🕒 ${nowKsa().toISOString().replace('T', ' ').slice(0, 19)}
📈 الحالة: ${state}

━━━━━━━━━━━━━━
🟩 Top ${TOP_N} Call Positions
Positive Gamma

${gamma.topCalls.map(gammaLine).join('\n') || '- لا توجد بيانات CALL Gamma'}

━━━━━━━━━━━━━━
🟥 Top ${TOP_N} Put Positions
Negative Gamma

${gamma.topPuts.map(gammaLine).join('\n') || '- لا توجد بيانات PUT Gamma'}

━━━━━━━━━━━━━━
📍 أقرب مستويات Gamma

🟥 أقرب مقاومة:
${nearestLine(nearest.resistance)}

🟩 أقرب دعم:
${nearestLine(nearest.support)}

🟨 منطقة التوازن:
${balanceLine(nearest.balance)}

━━━━━━━━━━━━━━
⚖️ Gamma Summary

Total Call Gamma: ${fmt(gamma.totalCallGamma)}
Total Put Gamma: ${fmt(gamma.totalPutGamma)}
Net Gamma: ${fmt(gamma.netGamma)}

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

${aiSummary(flow, gamma.netGamma, nearest)}

━━━━━━━━━━━━━━
⚠️ هذه متابعة تحليلية وليست توصية شراء أو بيع.
`;

  return { text, signature };
}

async function sendReportToActiveSubscribers(text) {
  const subscribers = await getActiveSubscribers();

  for (const sub of subscribers) {
    try {
      await bot.sendMessage(sub.user_id, text);
    } catch (err) {
      console.error(`Failed to send to ${sub.user_id}:`, err.message);
    }
  }

  if (CHAT_ID) {
    try {
      await bot.sendMessage(CHAT_ID, text);
    } catch (err) {
      console.error('Failed to send to CHAT_ID:', err.message);
    }
  }
}

async function scanAndSend(force = false, targetChatId = null) {
  try {
    if (!isMarketTime()) {
      console.log('Market closed. Skipping scan.');
      return;
    }

    const { text, signature } = await buildReport();

    if (targetChatId) {
      await bot.sendMessage(targetChatId, text);
      return;
    }

    const now = Date.now();
    const changed = signature !== lastSentSignature;
    const timePassed = now - lastSentAt >= SEND_EVERY_MS;

    if (force || changed || timePassed) {
      await sendReportToActiveSubscribers(text);
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

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `هلا بك في بوت سيولة وقاما SPX.

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
    `✅ ST SPX Liquidity Radar شغال
⏱ الفحص كل 5 دقائق
🧪 TEST_MODE: ${TEST_MODE ? 'مفعل' : 'مغلق'}
🔐 اشتراكك: ${active ? 'فعال ✅' : 'غير فعال ❌'}`
  );
});

bot.onText(/\/test/, async (msg) => {
  if (!isAdmin(msg)) {
    return bot.sendMessage(msg.chat.id, '❌ هذا الأمر خاص بالإدارة.');
  }

  await bot.sendMessage(msg.chat.id, '⏳ جاري إرسال تقرير تجريبي...');
  await scanAndSend(true, msg.chat.id);
});

scanAndSend(true);
setInterval(scanAndSend, INTERVAL_MS);

console.log('ST SPX Liquidity Radar is running...');
