/**
 * MercadoHoy — Rutas de mercado
 * Cotizaciones via stooq.com (gratuito, sin API key, sin bloqueos de cloud IPs)
 *
 * En tu server.js agregá:
 *   const mercadoRoutes = require('./server-mercado');
 *   app.use('/api', mercadoRoutes);
 */

const express   = require('express');
const router    = express.Router();
const Parser    = require('rss-parser');
const rssParser = new Parser({ timeout: 8000 });

// ─── Tickers por mercado (formato stooq) ─────────────────────────
// stooq usa lowercase y sufijos propios: .ba (Buenos Aires), .us (NYSE/Nasdaq)
// índices con ^, commodities con .f
const TICKERS = {
  ar: [
    { ticker: 'ggal.ba',  name: 'Grupo Galicia',     market: 'AR', display: 'GGAL'  },
    { ticker: 'ypfd.ba',  name: 'YPF',               market: 'AR', display: 'YPFD'  },
    { ticker: 'pamp.ba',  name: 'Pampa Energía',     market: 'AR', display: 'PAMP'  },
    { ticker: 'bma.ba',   name: 'Banco Macro',       market: 'AR', display: 'BMA'   },
    { ticker: 'txar.ba',  name: 'Ternium Argentina', market: 'AR', display: 'TXAR'  },
    { ticker: 'alua.ba',  name: 'Aluar',             market: 'AR', display: 'ALUA'  },
    { ticker: 'teco2.ba', name: 'Telecom Argentina', market: 'AR', display: 'TECO2' },
    { ticker: 'supv.ba',  name: 'Supervielle',       market: 'AR', display: 'SUPV'  },
    { ticker: 'loma.ba',  name: 'Loma Negra',        market: 'AR', display: 'LOMA'  },
    { ticker: 'bbar.ba',  name: 'BBVA Argentina',    market: 'AR', display: 'BBAR'  },
  ],
  us: [
    { ticker: 'nvda.us',  name: 'Nvidia',          market: 'US', display: 'NVDA'  },
    { ticker: 'aapl.us',  name: 'Apple',           market: 'US', display: 'AAPL'  },
    { ticker: 'msft.us',  name: 'Microsoft',       market: 'US', display: 'MSFT'  },
    { ticker: 'amzn.us',  name: 'Amazon',          market: 'US', display: 'AMZN'  },
    { ticker: 'tsla.us',  name: 'Tesla',           market: 'US', display: 'TSLA'  },
    { ticker: 'meta.us',  name: 'Meta Platforms',  market: 'US', display: 'META'  },
    { ticker: 'googl.us', name: 'Alphabet',        market: 'US', display: 'GOOGL' },
    { ticker: 'jpm.us',   name: 'JPMorgan Chase',  market: 'US', display: 'JPM'   },
    { ticker: 'v.us',     name: 'Visa',            market: 'US', display: 'V'     },
    { ticker: 'bac.us',   name: 'Bank of America', market: 'US', display: 'BAC'   },
  ],
  global: [
    { ticker: '^spx',    name: 'S&P 500',      market: 'GL', display: 'SPX'  },
    { ticker: '^ndq',    name: 'Nasdaq 100',   market: 'GL', display: 'NDQ'  },
    { ticker: '^dji',    name: 'Dow Jones',    market: 'GL', display: 'DJI'  },
    { ticker: '^ftse',   name: 'FTSE 100',     market: 'GL', display: 'FTSE' },
    { ticker: '^dax',    name: 'DAX',          market: 'GL', display: 'DAX'  },
    { ticker: '^n225',   name: 'Nikkei 225',   market: 'GL', display: 'N225' },
    { ticker: 'xauusd',  name: 'Oro (USD/oz)', market: 'GL', display: 'GOLD' },
    { ticker: 'cl.f',    name: 'Petróleo WTI', market: 'GL', display: 'WTI'  },
    { ticker: 'btcusd',  name: 'Bitcoin',      market: 'GL', display: 'BTC'  },
    { ticker: 'zs.f',    name: 'Soja',         market: 'GL', display: 'SOJA' },
  ],
};

// ─── Fetch de stooq (CSV con historial diario) ────────────────────
// Devuelve las últimas N filas: Date,Open,High,Low,Close,Volume
const fetchStooqOne = async (ticker) => {
  const url = `https://stooq.com/q/d/l/?s=${ticker}&i=d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status} for ${ticker}`);

  const text  = await res.text();
  const lines = text.trim().split('\n').filter(l => l && !l.startsWith('Date'));

  if (lines.length < 2) return null; // sin datos suficientes

  const parseRow = (line) => {
    const cols = line.split(',');
    return {
      close:  parseFloat(cols[4]),
      volume: parseFloat(cols[5]) || 0,
    };
  };

  const today     = parseRow(lines[lines.length - 1]);
  const yesterday = parseRow(lines[lines.length - 2]);

  if (isNaN(today.close)) return null;

  const changePct = yesterday.close
    ? ((today.close - yesterday.close) / yesterday.close) * 100
    : 0;

  return { close: today.close, changePct, volume: today.volume };
};

// ─── Formateo ─────────────────────────────────────────────────────
const fmtPrice = (price, market) => {
  if (price == null || isNaN(price)) return '—';
  if (market === 'AR') {
    return `$${price.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
  }
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtVol = (vol) => {
  if (!vol || isNaN(vol)) return '';
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000)     return `${(vol / 1_000).toFixed(0)}K`;
  return String(Math.round(vol));
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
  if (!TICKERS[market]) {
    return res.status(400).json({ error: 'market inválido. Usá: ar, us, global' });
  }

  const cacheKey = `quotes_${market}`;
  const cached   = getCache(cacheKey, 'quotes');
  if (cached) return res.json(cached);

  try {
    const tickerList = TICKERS[market];

    // Fetch en paralelo — stooq tolera bien las solicitudes simultáneas
    const results = await Promise.allSettled(
      tickerList.map(meta => fetchStooqOne(meta.ticker))
    );

    const assets = results.map((result, i) => {
      const meta = tickerList[i];

      if (result.status === 'rejected' || !result.value) {
        console.warn(`[stooq] sin datos para ${meta.ticker}:`, result.reason?.message || 'null');
        return {
          ticker:         meta.display,
          name:           meta.name,
          price:          '—',
          change:         '0.00%',
          changePositive: false,
          volume:         '',
          market:         meta.market,
        };
      }

      const { close, changePct, volume } = result.value;
      return {
        ticker:         meta.display,
        name:           meta.name,
        price:          fmtPrice(close, meta.market),
        change:         `${Math.abs(changePct).toFixed(2)}%`,
        changePositive: changePct >= 0,
        volume:         fmtVol(volume),
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

router.get('/debug-stooq', async (req, res) => {
  const ticker = req.query.t || 'ggal.ba';
  try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${ticker}&i=d`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    res.send(`<pre>STATUS: ${r.status}\n\nBODY:\n${text.slice(0, 1000)}</pre>`);
  } catch (err) {
    res.send(`ERROR: ${err.message}`);
  }
});

module.exports = router;
