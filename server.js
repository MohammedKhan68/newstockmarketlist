// server.js
const express = require('express');
const fetch = require('node-fetch');
const pLimit = require('p-limit'); // add dependency
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY; // set in Render/Heroku env
if(!FINNHUB_KEY) {
  console.error('Set FINNHUB_KEY env var');
  process.exit(1);
}

const cache = new NodeCache({ stdTTL: 25 }); // short cache
const limit = pLimit(6); // concurrency for external calls

async function getQuote(symbol){
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
  if(!res.ok) throw new Error('quote HTTP '+res.status);
  return res.json();
}

async function getCandles(symbol){
  const to = Math.floor(Date.now()/1000);
  const from = to - (400*24*3600);
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('candles HTTP '+res.status);
  return res.json();
}

async function getTarget(symbol){
  const url = `https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('target HTTP '+res.status);
  return res.json();
}

app.get('/api/watch', async (req,res)=>{
  try {
    const symbolsParam = req.query.symbols || 'META,AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,CRM,SHOP,ADBE';
    const symbols = symbolsParam.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const cacheKey = 'watch:' + symbols.join(',');
    const cached = cache.get(cacheKey);
    if(cached) return res.json({ cached: true, results: cached });

    const tasks = symbols.map(sym => limit(async () => {
      // For each symbol, attempt quote, candles, target and capture errors
      const result = { symbol: sym, quote: null, candles: null, target: null, errors: {} };

      try {
        const q = await getQuote(sym);
        result.quote = q;
      } catch(e){
        result.errors.quote = e.message || String(e);
      }

      try {
        const c = await getCandles(sym);
        // Validate response: Finnhub returns { s: 'ok', c: [...], t: [...] }
        if(!c || c.s !== 'ok' || !Array.isArray(c.c) || c.c.length === 0) {
          throw new Error('Invalid candles response: ' + JSON.stringify(c).slice(0,200));
        }
        result.candles = c;
      } catch(e){
        result.errors.candles = e.message || String(e);
      }

      try {
        const t = await getTarget(sym);
        // Accept null/empty as legitimate — but include raw value if present
        result.target = t || null;
      } catch(e){
        result.errors.target = e.message || String(e);
      }

      return result;
    }));

    const results = await Promise.all(tasks);
    cache.set(cacheKey, results);
    res.json({ cached: false, results });
  } catch (err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


    const results = await Promise.all(tasks);
    cache.set(cacheKey, results);
    res.json({ cached: false, results });
  } catch (err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, ()=> console.log('Listening on', PORT));

