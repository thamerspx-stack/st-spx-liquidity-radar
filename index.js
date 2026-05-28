async function getLiveSPXPrice() {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

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
