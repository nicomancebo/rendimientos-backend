/**
 * MercadoHoy — Rutas de mercado
 * Sin dependencias externas para cotizaciones — usa fetch directo a Yahoo Finance.
 *
 * En tu server.js agregá:
 *   const mercadoRoutes = require('./server-mercado');
 *   app.use('/api', mercadoRoutes);
 */

const express   = require('express');
const router    = express.Router();
const Parser    = require('rss-parser');
const rssParser = new Parser({ timeout: 8000 });

// ─── Tickers por mercado ──────────────────────────────────────────
const TICKERS = {
  ar: [
    { ticker: 'GGAL.BA',  name: 'Grupo Galicia',     market: 'AR' },
    { ticker: 'YPF.BA',   name: 'YPF',               market: 'AR' },
    { ticker: 'PAMP.BA',  name: 'Pampa Energía',     market: 'AR' },
    { ticker: 'BMA.BA',   name: 'Banco Macro',       market: 'AR' },
    { ticker: 'TXAR.BA',  name: 'Ternium Argentina', market: 'AR' },
    { ticker: 'ALUA.BA',  name: 'Aluar',             market: 'AR' },
    { ticker: 'TECO2.BA', name: 'Telecom Argentina', market: 'AR' },
    { ticker: 'SUPV.BA',  name: 'Supervielle',       market: 'AR' },
    { ticker: 'LOMA.BA',  name: 'Loma Negra',        market: 'AR' },
    { ticker: 'BBAR.BA',  name: 'BBVA Argentina',    market: 'AR' },
  ],
  us: [
    { ticker: 'NVDA',  name: 'Nvidia',          market: 'US' },
    { ticker: 'AAPL',  name: 'Apple',           market: 'US' },
    { ticker: 'MSFT',  name: 'Microsoft',       market: 'US' },
    { ticker: 'AMZN',  name: 'Amazon',          market: 'US' },
    { ticker: 'TSLA',  name: 'Tesla',           market: 'US' },
    { ticker: 'META',  name: 'Meta Platforms',  market: 'US' },
    { ticker: 'GOOGL', name: 'Alphabet',        market: 'US' },
    { ticker: 'JPM',   name: 'JPMorgan Chase',  market: 'US' },
    { ticker: 'V',     name: 'Visa',            market: 'US' },
    { ticker: 'BAC',   name: 'Bank of America', market: 'US' },
  ],
  global: [
    { ticker: '%5EGSPC',   name: 'S&P 500',     market: 'GL' },
    { ticker: '%5EIXIC',   name: 'Nasdaq',       market: 'GL' },
    { ticker: '%5EDJI',    name: 'Dow Jones',    market: 'GL' },
    { ticker: '%5EFTSE',   name: 'FTSE 100',     market: 'GL' },
    { ticker: '%5EGDAXI',  name: 'DAX',          market: 'GL' },
    { ticker: '%5EN225',   name: 'Nikkei 225',   market: 'GL' },
    { ticker: 'GC%3DF',    name: 'Oro',          market: 'GL' },
    { ticker: 'CL%3DF',    name: 'Petróleo WTI', market: 'GL' },
    { ticker: 'BTC-USD',   name: 'Bitcoin',      market: 'GL' },
    { ticker: 'ZS%3DF',    name: 'Soja',         market: 'GL' },
  ],
};

// ─── Fetch de cotizaciones via Yahoo Finance v7 API (sin paquete npm) ───
const fetchYahooQuotes = async (symbols) => {
  // Yahoo Finance v7 acepta hasta ~10 símbolos separados por coma
  const joined = symbols.join(',');
  const url    = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MercadoHoy/1.0)',
      'Accept': 'application/json',
      'Accept-Language': 'es-AR,es;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const data = await res.json();
  return data?.quoteResponse?.result || [];
};

// ─── Helpers ──────────────────────────────────────────────────────
const fmtPrice = (price, market) => {
  if (price == null) return '—';
  if (market === 'AR') {
    return `$${price.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
  }
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtVol = (vol) => {
  if (!vol) return '';
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000)     return `${(vol / 1_000).toFixed(0)}K`;
  return String(vol);
};

const cleanTicker = (t) =>
  t.replace('.BA', '').replace('%5E', '').replace('%3DF', '').replace('-USD', '').replace('BTC', 'BTC');

// ─── Cache en memoria ─────────────────────────────────────────────
const cache = {};
const TTL   = { quotes: 120_000, dolar: 180_000, fx: 600_000, news: 300_000 };

const getCache = (key, type) => {
  const e = cache[key];
  if (!e || Date.now() - e.ts > TTL[type]) { delete cache[key]; return null; }
  return e.data;
};
const setCache = (key, type, data) => { cache[key] = { ts: Date.now(), data }; };

// ─── Google News RSS ──────────────────────────────────────────────
const RSS = {
  all:      'https://news.google.com/rss/search?q=mercado+financiero+Argentina+acciones+bonos&hl=es-419&gl=AR&ceid=AR:es-419',
  acciones: 'https://news.google.com/rss/search?q=acciones+Merval+bolsa+Argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  bonos:    'https://news.google.com/rss/search?q=bonos+soberanos+Argentina+deuda&hl=es-419&gl=AR&ceid=AR:es-419',
  riesgo:   'https://news.google.com/rss/search?q=riesgo+pais+Argentina+FMI&hl=es-419&gl=AR&ceid=AR:es-419',
  materias: 'https://news.google.com/rss/search?q=soja+petroleo+oro+commodities+Argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  wall:     'https://news.google.com/rss/search?q=Wall+Street+S%26P500+Nasdaq&hl=es-419&gl=AR&ceid=AR:es-419',
  macro:    'https://news.google.com/rss/search?q=economia+Argentina+inflacion+BCRA+dolar&hl=es-419&gl=AR&ceid=AR:es-419',
};

const detectCat = (title = '', fallback = 'macro') => {
  if (fallback !== 'all') return fallback;
  const t = title.toLowerCase();
  if (t.match(/merval|accion|ypf|galicia|cedear/))            return 'acciones';
  if (t.match(/bono|deuda|lecap|tasa|al30|gd30/))             return 'bonos';
  if (t.match(/riesgo.?pa[ií]s|fmi|spreads/))                 return 'riesgo';
  if (t.match(/soja|petr[oó]leo|oro|commodity|commodities/))  return 'materias';
  if (t.match(/wall street|s&p|nasdaq|fed |reserva federal/)) return 'wall';
  return 'macro';
};

const detectSent = (title = '') => {
  const t = title.toLowerCase();
  if (t.match(/sube|subi[oó]|avanza|avanz[oó]|gan[oó]|r[eé]cord|m[aá]ximo|rebota|alza|acuerdo|crecimiento/)) return 'positivo';
  if (t.match(/baja|baj[oó]|cae|cay[oó]|pierde|perdi[oó]|m[ií]nimo|crisis|devaluaci[oó]n|colapso/))         return 'negativo';
  return 'neutro';
};

// ══════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// GET /api/health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MercadoHoy API', ts: new Date().toISOString() });
});

// GET /api/dolar
router.get('/dolar', async (req, res) => {
  const cached = getCache('dolar', 'dolar');
  if (cached) return res.json(cached);
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'MercadoHoy/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`dolarapi ${r.status}`);
    const data = await r.json();
    setCache('dolar', 'dolar', data);
    res.json(data);
  } catch (err) {
    console.error('[/api/dolar]', err.message);
    res.status(502).json({ error: 'No se pudo obtener cotización del dólar' });
  }
});

// GET /api/fx
router.get('/fx', async (req, res) => {
  const cached = getCache('fx', 'fx');
  if (cached) return res.json(cached);
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`er-api ${r.status}`);
    const data = await r.json();
    setCache('fx', 'fx', data);
    res.json(data);
  } catch (err) {
    console.error('[/api/fx]', err.message);
    res.status(502).json({ error: 'No se pudo obtener tipos de cambio' });
  }
});

// GET /api/quotes?market=ar|us|global
router.get('/quotes', async (req, res) => {
  const market = (req.query.market || 'ar').toLowerCase();
  if (!TICKERS[market]) return res.status(400).json({ error: 'market inválido. Usá: ar, us, global' });

  const cacheKey = `quotes_${market}`;
  const cached   = getCache(cacheKey, 'quotes');
  if (cached) return res.json(cached);

  try {
    const tickerList = TICKERS[market];
    const symbols    = tickerList.map(t => t.ticker);
    const yahooData  = await fetchYahooQuotes(symbols);

    // Mapear resultados de Yahoo por símbolo
    const bySymbol = {};
    yahooData.forEach(q => { bySymbol[q.symbol] = q; });

    const assets = tickerList.map(meta => {
      // Yahoo devuelve el símbolo decodificado (^GSPC, GC=F, etc.)
      const decodedTicker = decodeURIComponent(meta.ticker);
      const q = bySymbol[decodedTicker] || bySymbol[meta.ticker];
      const clean = cleanTicker(meta.ticker);

      if (!q) {
        return { ticker: clean, name: meta.name, price: '—', change: '0.00%', changePositive: false, volume: '', market: meta.market };
      }

      const pct = q.regularMarketChangePercent ?? 0;
      return {
        ticker:         clean,
        name:           meta.name,
        price:          fmtPrice(q.regularMarketPrice, meta.market),
        change:         `${Math.abs(pct).toFixed(2)}%`,
        changePositive: pct >= 0,
        volume:         fmtVol(q.regularMarketVolume),
        market:         meta.market,
      };
    });

    const payload = { assets, updatedAt: new Date().toISOString() };
    setCache(cacheKey, 'quotes', payload);
    res.json(payload);

  } catch (err) {
    console.error(`[/api/quotes?market=${market}]`, err.message);
    res.status(502).json({ error: 'No se pudieron obtener cotizaciones', detail: err.message });
  }
});

// GET /api/news?category=all|acciones|bonos|riesgo|materias|wall|macro
router.get('/news', async (req, res) => {
  const category = (req.query.category || 'all').toLowerCase();
  const rssUrl   = RSS[category] || RSS.all;
  const cacheKey = `news_${category}`;

  const cached = getCache(cacheKey, 'news');
  if (cached) return res.json(cached);

  try {
    const feed     = await rssParser.parseURL(rssUrl);
    const articles = (feed.items || []).slice(0, 8).map(item => ({
      title:     item.title?.replace(/\s*-\s*[^-]+$/, '').trim() || '—',
      summary:   item.contentSnippet?.slice(0, 200).trim() || item.title || '—',
      link:      item.link || '#',
      source:    item.creator || 'Google News',
      pubDate:   item.pubDate || new Date().toISOString(),
      category:  detectCat(item.title, category),
      sentiment: detectSent(item.title),
    }));

    const payload = { articles, updatedAt: new Date().toISOString() };
    setCache(cacheKey, 'news', payload);
    res.json(payload);

  } catch (err) {
    console.error(`[/api/news?category=${category}]`, err.message);
    res.status(502).json({ error: 'No se pudieron obtener noticias', articles: [] });
  }
});

module.exports = router;
