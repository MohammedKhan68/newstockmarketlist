// server.js
// Express proxy: Finnhub (quotes) + Twelve Data (daily history) + FMP (price target)
// CommonJS, no top-level await. Requires env vars: FINNHUB_KEY, TWELVE_KEY, FMP_KEY (FMP optional)

const express = require('express');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const pLimit = require('p-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const TWELVE_KEY = process.env.TWELVE_KEY || '';
const FMP_KEY = process.env.FMP_KEY || ''; // optional

if (!FINNHUB_KEY) {
  console.warn('Warning: FINNHUB_KEY is not set. Quotes will fail without it.');
}
if (!TWELVE_KEY) {
  console.warn('Warning: TWELVE_KEY is not set. Candle/history will fail without it.');
}

const CACHE_TTL = 30; // seconds - increase if you want fewer external calls
const cache = new NodeCache({ stdTTL: CACHE_TTL });
const concurrencyLimit = 6;
const limit = pLimit(concurrencyLimit);

// helper: fetch JSON with retries
async function fetchJson(url, opts = {}, retries = 2, backoff = 700) {
  for (let i = 0; i <= retries; ++i) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
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

// Finnhub: quote
async function getQuote(symbol) {
  if (!FINNHUB_KEY) throw new Error('FINNHUB_KEY not set');
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  return await fetchJson(url);
}

// Twelve Data: daily time series -> returns { s:'ok', c:[], t:[] } (c = closes, t = unix timestamps)
async function getCandles(symbol) {
  if (!TWELVE_KEY) throw new Error('TWELVE_KEY not set');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=500&format=JSON&apikey=${TWELVE_KEY}`;
  const json = await fetchJson(url);
  // Twelve Data returns { status: 'ok', meta: {...}, values: [{datetime, close}, ...] } or error object
  if (!json || json.status === 'error' || !Array.isArray(json.values) || json.values.length === 0) {
    throw new Error('TwelveData error: ' + JSON.stringify(json).slice(0,300));
  }
  // values are newest-first; convert to oldest->newest arrays
  const values = json.values.slice().reverse();
  const c = values.map(v => Number(v.close));
  const t = values.map(v => Math.floor(new Date(v.datetime).getTime() / 1000));
  return { s: 'ok', c, t, meta: json.meta || null };
}

// FinancialModelingPrep: price target (returns number or null)
async function getTarget(symbol) {
  if (!FMP_KEY) {
    // If not configured, simply return null silently
    return null;
  }
  // FMP endpoint returns array or object
  const url = `https://financialmodelingprep.com/api/v3/price-target/${encodeURIComponent(symbol)}?apikey=${FMP_KEY}`;
  const json = await fetchJson(url);
  if (!json) return null;
  if (Array.isArray(json) && json.length > 0) {
    const first = json[0];
    const val = first.price || first.target || first.targetMean || first['1yTargetMean'] || null;
    return val ? Number(val) : null;
  }
  if (typeof json === 'object') {
    const val = json.price || json.target || json.targetMean || json['1yTargetMean'] || null;
    return val ? Number(val) : null;
  }
  return null;
}

// Simple CORS allow-all for public proxy
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Health
app.get('/', (req, res) => res.send('rot-proxy ok'));

// Main endpoint: /api/watch?symbols=AAPL,MSFT,...
app.get('/api/watch', async (req, res) => {
  try {
    const symbolsParam = req.query.symbols || 'META,AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,CRM,SHOP,ADBE';
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const cacheKey = 'watch:' + symbols.join(',');
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ cached: true, results: cached });
    }

    const tasks = symbols.map(sym => limit(async () => {
      const out = { symbol: sym, quote: null, candles: null, target: null, errors: {} };

      // quote (finnhub)
      try {
        out.quote = await getQuote(sym);
      } catch (e) {
        out.errors.quote = String(e.message || e);
      }

      // candles (twelve data)
      try {
        const c = await getCandles(sym);
        if (!c || c.s !== 'ok' || !Array.isArray(c.c) || c.c.length === 0) {
          out.errors.candles = 'Invalid candles response: ' + JSON.stringify(c).slice(0,300);
        } else {
          out.candles = c;
        }
      } catch (e) {
        out.errors.candles = String(e.message || e);
      }

      // price target (FMP)
      try {
        const t = await getTarget(sym);
        out.target = t !== undefined ? t : null;
      } catch (e) {
        out.errors.target = String(e.message || e);
      }

      return out;
    }));

    const results = await Promise.all(tasks);
    cache.set(cacheKey, results);
    return res.json({ cached: false, results });
  } catch (err) {
    console.error('Server error /api/watch:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`rot-proxy listening on port ${PORT}`);
});
