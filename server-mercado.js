/**
 * ═══════════════════════════════════════════════════════════════════
 *  MercadoHoy — Rutas de mercado
 *  En tu server.js agregá:
 *    const mercadoRoutes = require('./server-mercado');
 *    app.use('/api', mercadoRoutes);
 * ═══════════════════════════════════════════════════════════════════
 */

const express   = require('express');
const router    = express.Router();
const Parser    = require('rss-parser');
const rssParser = new Parser({ timeout: 8000 });

// yahoo-finance2 es ESM — se importa dinámicamente dentro de cada handler
const getYahoo = async () => {
  const mod = await import('yahoo-finance2');
  const yf  = mod.default;
  yf.suppressNotices(['yahooSurvey']);
  return yf;
};

// ─── Tickers por mercado ──────────────────────────────────────────
const TICKERS = {
  ar: [
    { ticker: 'GGAL.BA',  name: 'Grupo Galicia',    market: 'AR' },
    { ticker: 'YPF.BA',   name: 'YPF',              market: 'AR' },
    { ticker: 'PAMP.BA',  name: 'Pampa Energía',    market: 'AR' },
    { ticker: 'BMA.BA',   name: 'Banco Macro',      market: 'AR' },
    { ticker: 'TXAR.BA',  name: 'Ternium Argentina',market: 'AR' },
    { ticker: 'ALUA.BA',  name: 'Aluar',            market: 'AR' },
    { ticker: 'TECO2.BA', name: 'Telecom Argentina',market: 'AR' },
    { ticker: 'SUPV.BA',  name: 'Supervielle',      market: 'AR' },
    { ticker: 'LOMA.BA',  name: 'Loma Negra',       market: 'AR' },
    { ticker: 'BBAR.BA',  name: 'BBVA Argentina',   market: 'AR' },
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
    { ticker: '^GSPC',   name: 'S&P 500',      market: 'GL' },
    { ticker: '^IXIC',   name: 'Nasdaq',        market: 'GL' },
    { ticker: '^DJI',    name: 'Dow Jones',     market: 'GL' },
    { ticker: '^FTSE',   name: 'FTSE 100',      market: 'GL' },
    { ticker: '^GDAXI',  name: 'DAX',           market: 'GL' },
    { ticker: '^N225',   name: 'Nikkei 225',    market: 'GL' },
    { ticker: 'GC=F',    name: 'Oro',           market: 'GL' },
    { ticker: 'CL=F',    name: 'Petróleo WTI',  market: 'GL' },
    { ticker: 'BTC-USD', name: 'Bitcoin',       market: 'GL' },
    { ticker: 'ZS=F',    name: 'Soja',          market: 'GL' },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────
const fmtPrice = (price, market) => {
  if (price == null) return '—';
  if (market === 'AR') return `$${price.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtVol = (vol) => {
  if (!vol) return '—';
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000)     return `${(vol / 1_000).toFixed(0)}K`;
  return String(vol);
};

// ─── Cache en memoria ─────────────────────────────────────────────
const cache = {};
const TTL   = { quotes: 120_000, dolar: 180_000, fx: 600_000, news: 300_000 };

const getCache = (key, type) => {
  const e = cache[key];
  if (!e || Date.now() - e.ts > TTL[type]) { delete cache[key]; return null; }
  return e.data;
};
const setCache = (key, type, data) => { cache[key] = { ts: Date.now(), data }; };

// ─── Fuentes de noticias (Google News RSS) ────────────────────────
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
  const t = title.toLowerCase();
  if (fallback !== 'all') return fallback;
  if (t.match(/merval|accion|ypf|galicia|cedear/))           return 'acciones';
  if (t.match(/bono|deuda|lecap|tasa|al30|gd30/))            return 'bonos';
  if (t.match(/riesgo.?pa[ií]s|fmi|spreads/))                return 'riesgo';
  if (t.match(/soja|petr[oó]leo|oro|commodity|commodities/)) return 'materias';
  if (t.match(/wall street|s&p|nasdaq|fed |reserva federal/))return 'wall';
  return 'macro';
};

const detectSent = (title = '') => {
  const t = title.toLowerCase();
  if (t.match(/sube|subi[oó]|avanza|avanz[oó]|gan[oó]|r[eé]cord|m[aá]ximo|rebota|alza|acuerdo|crecimiento/)) return 'positivo';
  if (t.match(/baja|baj[oó]|cae|cay[oó]|pierde|perdi[oó]|m[ií]nimo|crisis|devaluaci[oó]n|riesgo|colapso/))  return 'negativo';
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
    const yf = await getYahoo();
    const tickerList = TICKERS[market];

    const results = await Promise.allSettled(
      tickerList.map(({ ticker }) =>
        yf.quote(ticker, { fields: ['regularMarketPrice', 'regularMarketChangePercent', 'regularMarketVolume'] })
      )
    );

    const assets = results.map((result, i) => {
      const meta = tickerList[i];
      const cleanTicker = meta.ticker.replace('.BA', '').replace('^', '').replace('=F', '');

      if (result.status === 'rejected' || !result.value) {
        return { ticker: cleanTicker, name: meta.name, price: '—', change: '0.00%', changePositive: false, volume: '—', market: meta.market };
      }

      const q   = result.value;
      const pct = q.regularMarketChangePercent ?? 0;

      return {
        ticker:         cleanTicker,
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
    res.status(502).json({ error: 'No se pudieron obtener cotizaciones' });
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
