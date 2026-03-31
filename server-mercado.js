/**
 * ═══════════════════════════════════════════════════════════════════
 *  MercadoHoy — Rutas de mercado para agregar a tu server.js
 * ═══════════════════════════════════════════════════════════════════
 *
 *  INSTALACIÓN (en tu proyecto de Render):
 *  npm install yahoo-finance2 rss-parser node-fetch
 *
 *  CÓMO USARLO:
 *  En tu server.js principal, agregá al principio:
 *
 *    const mercadoRoutes = require('./server-mercado');
 *    app.use('/api', mercadoRoutes);
 *
 *  Y listo. Tus endpoints quedan en:
 *    GET /api/dolar
 *    GET /api/fx
 *    GET /api/quotes?market=ar
 *    GET /api/quotes?market=us
 *    GET /api/quotes?market=global
 *    GET /api/news?category=all
 * ═══════════════════════════════════════════════════════════════════
 */

const express  = require('express');
const router   = express.Router();
const yahooFinance = require('yahoo-finance2').default;
const Parser   = require('rss-parser');
const rssParser = new Parser({ timeout: 8000 });

// ─── Suprimir warnings de Yahoo Finance ───────────────────────────
yahooFinance.suppressNotices(['yahooSurvey']);

// ─── Tickers por mercado ──────────────────────────────────────────
const TICKERS = {
  ar: [
    // Acciones Merval
    { ticker: 'GGAL.BA',  name: 'Grupo Galicia',       market: 'AR' },
    { ticker: 'YPF.BA',   name: 'YPF',                 market: 'AR' },
    { ticker: 'PAMP.BA',  name: 'Pampa Energía',        market: 'AR' },
    { ticker: 'BMA.BA',   name: 'Banco Macro',          market: 'AR' },
    { ticker: 'TXAR.BA',  name: 'Ternium Argentina',    market: 'AR' },
    { ticker: 'ALUA.BA',  name: 'Aluar',                market: 'AR' },
    { ticker: 'TECO2.BA', name: 'Telecom Argentina',    market: 'AR' },
    { ticker: 'SUPV.BA',  name: 'Grupo Supervielle',    market: 'AR' },
    { ticker: 'LOMA.BA',  name: 'Loma Negra',           market: 'AR' },
    { ticker: 'BBAR.BA',  name: 'BBVA Argentina',       market: 'AR' },
  ],
  us: [
    { ticker: 'NVDA',  name: 'Nvidia',              market: 'US' },
    { ticker: 'AAPL',  name: 'Apple',               market: 'US' },
    { ticker: 'MSFT',  name: 'Microsoft',           market: 'US' },
    { ticker: 'AMZN',  name: 'Amazon',              market: 'US' },
    { ticker: 'TSLA',  name: 'Tesla',               market: 'US' },
    { ticker: 'META',  name: 'Meta Platforms',      market: 'US' },
    { ticker: 'GOOGL', name: 'Alphabet',            market: 'US' },
    { ticker: 'JPM',   name: 'JPMorgan Chase',      market: 'US' },
    { ticker: 'V',     name: 'Visa',                market: 'US' },
    { ticker: 'BAC',   name: 'Bank of America',     market: 'US' },
  ],
  global: [
    { ticker: '^GSPC',   name: 'S&P 500',       market: 'GL' },
    { ticker: '^IXIC',   name: 'Nasdaq',         market: 'GL' },
    { ticker: '^DJI',    name: 'Dow Jones',      market: 'GL' },
    { ticker: '^FTSE',   name: 'FTSE 100',       market: 'GL' },
    { ticker: '^GDAXI',  name: 'DAX',            market: 'GL' },
    { ticker: '^N225',   name: 'Nikkei 225',     market: 'GL' },
    { ticker: 'GC=F',    name: 'Oro (Gold)',     market: 'GL' },
    { ticker: 'CL=F',    name: 'Petróleo WTI',  market: 'GL' },
    { ticker: 'BTC-USD', name: 'Bitcoin',        market: 'GL' },
    { ticker: 'ZS=F',    name: 'Soja',           market: 'GL' },
  ],
};

// ─── Formateador de precio ────────────────────────────────────────
const fmtPrice = (price, market) => {
  if (price == null) return '—';
  if (market === 'AR') {
    return `$${price.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  return `${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtChange = (pct) => {
  if (pct == null) return '0.00%';
  return `${Math.abs(pct).toFixed(2)}%`;
};

// ─── Cache simple en memoria ──────────────────────────────────────
const cache = {};
const CACHE_TTL = {
  quotes: 2 * 60 * 1000,   // 2 minutos
  dolar:  3 * 60 * 1000,   // 3 minutos
  fx:     10 * 60 * 1000,  // 10 minutos
  news:   5 * 60 * 1000,   // 5 minutos
};

const getCache = (key) => {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL[entry.type]) { delete cache[key]; return null; }
  return entry.data;
};

const setCache = (key, type, data) => { cache[key] = { ts: Date.now(), type, data }; };

// ─── RSS fuentes de noticias ──────────────────────────────────────
const NEWS_SOURCES = {
  all:      'https://news.google.com/rss/search?q=mercado+financiero+Argentina+acciones+bonos&hl=es-419&gl=AR&ceid=AR:es-419',
  acciones: 'https://news.google.com/rss/search?q=acciones+Merval+bolsa+Argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  bonos:    'https://news.google.com/rss/search?q=bonos+soberanos+Argentina+deuda&hl=es-419&gl=AR&ceid=AR:es-419',
  riesgo:   'https://news.google.com/rss/search?q=riesgo+pais+Argentina+FMI&hl=es-419&gl=AR&ceid=AR:es-419',
  materias: 'https://news.google.com/rss/search?q=soja+petroleo+oro+commodities+Argentina&hl=es-419&gl=AR&ceid=AR:es-419',
  wall:     'https://news.google.com/rss/search?q=Wall+Street+S%26P500+Nasdaq+bolsa&hl=es-419&gl=AR&ceid=AR:es-419',
  macro:    'https://news.google.com/rss/search?q=economia+Argentina+inflacion+BCRA+dolar&hl=es-419&gl=AR&ceid=AR:es-419',
};

// Categoría a partir del título/fuente
const detectCategory = (title = '', category) => {
  const t = title.toLowerCase();
  if (category !== 'all') return category;
  if (t.includes('merval') || t.includes('accion') || t.includes('ypf') || t.includes('galicia')) return 'acciones';
  if (t.includes('bono') || t.includes('deuda') || t.includes('lecap') || t.includes('tasa')) return 'bonos';
  if (t.includes('riesgo país') || t.includes('fmi') || t.includes('riesgo pais')) return 'riesgo';
  if (t.includes('soja') || t.includes('petróleo') || t.includes('oro') || t.includes('commodity')) return 'materias';
  if (t.includes('wall street') || t.includes('s&p') || t.includes('nasdaq') || t.includes('fed')) return 'wall';
  return 'macro';
};

const detectSentiment = (title = '') => {
  const t = title.toLowerCase();
  const pos = ['sube', 'subió', 'avanza', 'avanzó', 'gana', 'ganó', 'récord', 'máximo', 'rebota', 'crecimiento', 'alza', 'positivo', 'mejora', 'acuerdo'];
  const neg = ['baja', 'bajó', 'cae', 'cayó', 'pierde', 'perdió', 'mínimo', 'crisis', 'devaluación', 'recesión', 'colapso', 'riesgo', 'negativo', 'caída'];
  if (pos.some(p => t.includes(p))) return 'positivo';
  if (neg.some(p => t.includes(p))) return 'negativo';
  return 'neutro';
};

// ══════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// ─── GET /api/dolar ───────────────────────────────────────────────
router.get('/dolar', async (req, res) => {
  try {
    const cached = getCache('dolar');
    if (cached) return res.json(cached);

    const resp = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'MercadoHoy/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error('dolarapi error');
    const data = await resp.json();
    setCache('dolar', 'dolar', data);
    res.json(data);
  } catch (err) {
    console.error('[/api/dolar]', err.message);
    res.status(502).json({ error: 'No se pudo obtener cotización del dólar' });
  }
});

// ─── GET /api/fx ──────────────────────────────────────────────────
router.get('/fx', async (req, res) => {
  try {
    const cached = getCache('fx');
    if (cached) return res.json(cached);

    const resp = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error('er-api error');
    const data = await resp.json();
    setCache('fx', 'fx', data);
    res.json(data);
  } catch (err) {
    console.error('[/api/fx]', err.message);
    res.status(502).json({ error: 'No se pudo obtener tipos de cambio' });
  }
});

// ─── GET /api/quotes?market=ar|us|global ─────────────────────────
router.get('/quotes', async (req, res) => {
  const market = (req.query.market || 'ar').toLowerCase();
  if (!TICKERS[market]) return res.status(400).json({ error: 'market inválido. Usá: ar, us, global' });

  const cacheKey = `quotes_${market}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const tickerList = TICKERS[market];
    const symbols = tickerList.map(t => t.ticker);

    // Yahoo Finance quoteSummary en paralelo (más confiable que quote batch)
    const results = await Promise.allSettled(
      symbols.map(sym =>
        yahooFinance.quote(sym, { fields: ['regularMarketPrice', 'regularMarketChangePercent', 'regularMarketVolume', 'regularMarketChange'] })
      )
    );

    const assets = results.map((result, i) => {
      const meta = tickerList[i];
      if (result.status === 'rejected' || !result.value) {
        return { ticker: meta.ticker.replace('.BA',''), name: meta.name, price: '—', change: '0.00%', changePositive: false, volume: '—', market: meta.market };
      }
      const q = result.value;
      const pct = q.regularMarketChangePercent ?? 0;
      const vol = q.regularMarketVolume;
      const volStr = vol >= 1_000_000 ? `${(vol/1_000_000).toFixed(1)}M`
                   : vol >= 1_000     ? `${(vol/1_000).toFixed(0)}K`
                   : vol?.toString() ?? '—';
      return {
        ticker:         meta.ticker.replace('.BA','').replace('^','').replace('=F',''),
        name:           meta.name,
        price:          fmtPrice(q.regularMarketPrice, meta.market),
        change:         fmtChange(pct),
        changePositive: pct >= 0,
        volume:         volStr,
        market:         meta.market,
      };
    });

    const payload = { assets, updatedAt: new Date().toISOString() };
    setCache(cacheKey, 'quotes', payload);
    res.json(payload);
  } catch (err) {
    console.error(`[/api/quotes?market=${market}]`, err.message);
    res.status(502).json({ error: 'No se pudieron obtener cotizaciones de Yahoo Finance' });
  }
});

// ─── GET /api/news?category=all|acciones|bonos|riesgo|materias|wall|macro ──
router.get('/news', async (req, res) => {
  const category = (req.query.category || 'all').toLowerCase();
  const rssUrl = NEWS_SOURCES[category] || NEWS_SOURCES.all;
  const cacheKey = `news_${category}`;

  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const feed = await rssParser.parseURL(rssUrl);
    const articles = (feed.items || []).slice(0, 8).map(item => ({
      title:    item.title?.replace(/\s*-\s*[^-]+$/, '').trim() || '—',  // Quitar "- Fuente" del título
      summary:  item.contentSnippet?.slice(0, 200).trim() || item.title || '—',
      link:     item.link || '#',
      source:   item.creator || new URL(rssUrl).hostname.replace('news.google.com','Google News'),
      pubDate:  item.pubDate || new Date().toISOString(),
      category: detectCategory(item.title, category),
      sentiment: detectSentiment(item.title),
    }));

    const payload = { articles, updatedAt: new Date().toISOString() };
    setCache(cacheKey, 'news', payload);
    res.json(payload);
  } catch (err) {
    console.error(`[/api/news?category=${category}]`, err.message);
    res.status(502).json({ error: 'No se pudieron obtener noticias', articles: [] });
  }
});

// ─── GET /api/health ─────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MercadoHoy API', ts: new Date().toISOString() });
});

module.exports = router;
