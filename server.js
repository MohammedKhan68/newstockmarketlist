// server.js (CommonJS) - safe, with retries, caching and CORS
const express = require('express');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const pLimit = require('p-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
  console.error('ERROR: FINNHUB_KEY env var is not set. Set it in Render environment variables.');
  // continue so Render logs this clearly
}

const CACHE_TTL = 30; // seconds
const cache = new NodeCache({ stdTTL: CACHE_TTL });
const limit = pLimit(6); // server-side concurrency for external calls

// helper fetch with timeout + retries
async function fetchJson(url, opts = {}, retries = 2, backoff = 700) {
  for (let i = 0; i <= retries; ++i) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(()=>'');
        throw new Error(`HTTP ${res.status} ${txt}`);
      }
      const json = await res.json();
      return json;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, backoff * (i + 1)));
    }
  }
}

// Finnhub wrappers
async function getQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  return await fetchJson(url);
}

async function getCandles(symbol) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - (450 * 24 * 3600); // ~450 days for safe history
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
  return await fetchJson(url);
}

async function getTarget(symbol) {
  const url = `https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  return await fetchJson(url);
}

// CORS middleware - allow all origins (safe for a public proxy)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// API endpoint
app.get('/api/watch', async (req, res) => {
  try {
    const symbolsParam = req.query.symbols || 'META,AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,CRM,SHOP,ADBE';
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const cacheKey = 'watch:' + symbols.join(',');
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ cached: true, results: cached });
    }

    // create limited parallel tasks
    const tasks = symbols.map(sym => limit(async () => {
      const out = { symbol: sym, quote: null, candles: null, target: null, errors: {} };

      // fetch quote
      try {
        out.quote = await getQuote(sym);
      } catch (e) {
        out.errors.quote = String(e.message || e);
      }

      // fetch candles
      try {
        const c = await getCandles(sym);
        // validate
        if (!c || c.s !== 'ok' || !Array.isArray(c.c) || c.c.length === 0) {
          out.errors.candles = 'Invalid candles response: ' + JSON.stringify(c).slice(0,256);
        } else {
          out.candles = c;
        }
      } catch (e) {
        out.errors.candles = String(e.message || e);
      }

      // fetch price target (optional)
      try {
        const t = await getTarget(sym);
        out.target = t || null;
      } catch (e) {
        out.errors.target = String(e.message || e);
      }

      return out;
    }));

    const results = await Promise.all(tasks);
    cache.set(cacheKey, results);
    return res.json({ cached: false, results });
  } catch (err) {
    console.error('Server error in /api/watch:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// health
app.get('/', (req, res) => res.send('rot-proxy ok'));

// start
app.listen(PORT, () => {
  console.log(`rot-proxy listening on port ${PORT}`);
});
