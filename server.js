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
      // parallel server-side
      const [quote, candles, target] = await Promise.allSettled([
        getQuote(sym),
        getCandles(sym),
        getTarget(sym)
      ]);
      return {
        symbol: sym,
        quote: quote.status === 'fulfilled' ? quote.value : null,
        candles: candles.status === 'fulfilled' ? candles.value : null,
        target: target.status === 'fulfilled' ? target.value : null
      };
    }));

    const results = await Promise.all(tasks);
    cache.set(cacheKey, results);
    res.json({ cached: false, results });
  } catch (err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, ()=> console.log('Listening on', PORT));
