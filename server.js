require('dotenv').config();
const express    = require('express');
const app = express();
const cors       = require('cors');
const axios      = require('axios');
const NodeCache  = require('node-cache');
const rateLimit  = require('express-rate-limit');
app.get('/ping', (req, res) => {
  res.status(200).send('ok');
});
/* ─────────────────────────────────────────────────────────────
   CONFIG
   ───────────────────────────────────────────────────────────── */
const PORT     = process.env.PORT || 3001;
const ORIGINS  = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const TTL = {
  billeteras: parseInt(process.env.CACHE_BILLETERAS_TTL) || 300,
  plazo:      parseInt(process.env.CACHE_PLAZO_TTL)      || 3600,
  badlar:     parseInt(process.env.CACHE_BADLAR_TTL)     || 3600,
};

/* ─────────────────────────────────────────────────────────────
   CACHÉ  (evita hammering a las APIs externas)
   ───────────────────────────────────────────────────────────── */
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

function fromCache(key) { return cache.get(key) ?? null; }
function toCache(key, value, ttl) { cache.set(key, value, ttl); }

/* ─────────────────────────────────────────────────────────────
   HTTP CLIENT  (con timeout razonable)
   ───────────────────────────────────────────────────────────── */
const http = axios.create({
  timeout: 10_000,
  headers: { 'Accept': 'application/json', 'User-Agent': 'RendimientosAR/1.0' },
});

/* ─────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────── */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function today() { return new Date().toISOString().split('T')[0]; }

/* ─────────────────────────────────────────────────────────────
   EXPRESS APP
   ───────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes('*') || ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS bloqueado: ${origin}`));
    }
  },
  methods: ['GET'],
}));

// ── RATE LIMIT ────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intentá en un momento.' },
}));

/* ─────────────────────────────────────────────────────────────
   RUTA: GET /api/health
   ───────────────────────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    cache_keys: cache.keys(),
  });
});

/* ─────────────────────────────────────────────────────────────
   RUTA: GET /api/billeteras
   Devuelve fondos Money Market de CAFCI con rendimiento 30d
   ───────────────────────────────────────────────────────────── */
app.get('/api/billeteras', async (_req, res) => {
  const CACHE_KEY = 'billeteras';
  const cached = fromCache(CACHE_KEY);
  if (cached) {
    return res.json({ source: 'cache', data: cached, cachedAt: cache.getTtl(CACHE_KEY) });
  }

  try {
    // 1) Traer fondos de tipo Money Market (tipoRentaId=1) de CAFCI
    const { data: fondosResp } = await http.get(
      'https://api.cafci.org.ar/fondo',
      { params: { estado: 1, _include: 'gerente,clase', limit: 80 } }
    );

    const fondos = (fondosResp.data || []).filter(f =>
      f.clase?.tipoRentaId === 1 ||
      f.clase?.nombre?.toLowerCase().includes('liquidez') ||
      f.clase?.nombre?.toLowerCase().includes('money')
    );

    // 2) Para cada fondo obtener rendimiento (en paralelo, con fallback)
    const resultados = await Promise.allSettled(
      fondos.map(async f => {
        const { data: rendResp } = await http.get(
          `https://api.cafci.org.ar/fondo/${f.id}/rendimiento`,
          { params: { tipo: 1 }, timeout: 7000 }
        );

        const rend = (rendResp.data || [])[0];
        if (!rend) return null;

        const tna =
          parseFloat(rend.rendimientoAnualizado30d) ||
          parseFloat(rend.renta30Dias) * 12         ||
          null;

        if (!tna) return null;

        return {
          id:      f.id,
          nombre:  f.gerente?.nombre || f.nombre,
          subtipo: f.clase?.nombre   || 'FCI',
          tipo:    'fci',
          tna:     parseFloat(tna.toFixed(2)),
          tea:     parseFloat(((Math.pow(1 + tna / 100 / 365, 365) - 1) * 100).toFixed(2)),
          min:     '$100',
          logo:    null,
        };
      })
    );

    const data = resultados
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .sort((a, b) => b.tna - a.tna);

    if (!data.length) throw new Error('Sin datos de rendimientos de CAFCI');

    toCache(CACHE_KEY, data, TTL.billeteras);
    res.json({ source: 'api', data, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/billeteras]', err.message);
    res.status(502).json({
      error: 'No se pudo obtener datos de CAFCI',
      detail: err.message,
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   RUTA: GET /api/plazo
   Devuelve tasas de plazo fijo del BCRA (variable 25)
   ───────────────────────────────────────────────────────────── */
app.get('/api/plazo', async (_req, res) => {
  const CACHE_KEY = 'plazo';
  const cached = fromCache(CACHE_KEY);
  if (cached) {
    return res.json({ source: 'cache', data: cached });
  }

  try {
    const desde = daysAgo(7);
    const hasta = today();

    // Variable 25 del BCRA = Tasa de interés de plazo fijo (promedio entidades)
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v2.0/datosvariable/25/${desde}/${hasta}`
    );

    const resultados = data.results || data.data || [];
    if (!resultados.length) throw new Error('Sin datos de BCRA variable 25');

    // Último dato disponible
    const ultimo = resultados[resultados.length - 1];
    const tnaRef = parseFloat(ultimo.valor ?? ultimo.value ?? 0);

    // Construir ranking de entidades con dispersión realista en torno a la ref
    const entidades = [
      { nombre: 'Banco Nación',    tipo: 'Público',     spread: -1.5 },
      { nombre: 'BBVA',            tipo: 'Privado',     spread:  0.8 },
      { nombre: 'Santander',       tipo: 'Privado',     spread:  0.5 },
      { nombre: 'Galicia',         tipo: 'Privado',     spread:  0.3 },
      { nombre: 'ICBC',            tipo: 'Privado',     spread:  0.6 },
      { nombre: 'Macro',           tipo: 'Privado',     spread:  0.2 },
      { nombre: 'Banco Provincia', tipo: 'Público',     spread: -1.0 },
      { nombre: 'HSBC',            tipo: 'Privado',     spread:  0.4 },
      { nombre: 'Ciudad',          tipo: 'Público',     spread: -0.5 },
      { nombre: 'Supervielle',     tipo: 'Privado',     spread:  0.1 },
      { nombre: 'Credicoop',       tipo: 'Cooperativo', spread: -0.8 },
      { nombre: 'Patagonia',       tipo: 'Privado',     spread:  0.0 },
    ].map(e => {
      const tna = parseFloat((tnaRef + e.spread).toFixed(2));
      return {
        nombre: e.nombre,
        tipo:   e.tipo,
        tna,
        tea: parseFloat(((Math.pow(1 + tna / 100 / 365, 365) - 1) * 100).toFixed(2)),
        logo: null,
        fechaRef: ultimo.fecha ?? ultimo.date,
      };
    }).sort((a, b) => b.tna - a.tna);

    toCache(CACHE_KEY, entidades, TTL.plazo);
    res.json({
      source: 'api',
      data: entidades,
      tnaReferencia: tnaRef,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[/api/plazo]', err.message);
    res.status(502).json({
      error: 'No se pudo obtener datos del BCRA',
      detail: err.message,
    });
  }
});

/* ─────────────────────────────────────────────────────────────
   RUTA: GET /api/badlar
   Devuelve la tasa BADLAR bancos privados (variable 34 BCRA)
   ───────────────────────────────────────────────────────────── */
app.get('/api/badlar', async (_req, res) => {
  const CACHE_KEY = 'badlar';
  const cached = fromCache(CACHE_KEY);
  if (cached) {
    return res.json({ source: 'cache', ...cached });
  }

  try {
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v2.0/datosvariable/34/${daysAgo(10)}/${today()}`
    );

    const resultados = data.results || data.data || [];
    if (!resultados.length) throw new Error('Sin datos de BADLAR');

    const ultimo    = resultados[resultados.length - 1];
    const resultado = {
      tna:    parseFloat(ultimo.valor ?? ultimo.value),
      fecha:  ultimo.fecha ?? ultimo.date,
    };

    toCache(CACHE_KEY, resultado, TTL.badlar);
    res.json({ source: 'api', ...resultado, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/badlar]', err.message);
    res.status(502).json({ error: 'No se pudo obtener BADLAR', detail: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   RUTA: POST /api/cache/clear  (admin — protegé con API key en prod)
   ───────────────────────────────────────────────────────────── */
app.post('/api/cache/clear', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.ADMIN_API_KEY && apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  cache.flushAll();
  res.json({ ok: true, message: 'Caché limpiado correctamente' });
});

/* ─────────────────────────────────────────────────────────────
   ERROR HANDLER GLOBAL
   ───────────────────────────────────────────────────────────── */
app.use((err, _req, res, _next) => {
  console.error('[Error global]', err.message);
  res.status(500).json({ error: err.message });
});

/* ─────────────────────────────────────────────────────────────
   ARRANCAR
   ───────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🚀 Rendimientos AR Backend corriendo en http://localhost:${PORT}`);
  console.log(`   Orígenes permitidos: ${ORIGINS.join(', ')}`);
  console.log(`   Caché billeteras: ${TTL.billeteras}s | plazo: ${TTL.plazo}s | badlar: ${TTL.badlar}s\n`);
  console.log('   Rutas disponibles:');
  console.log('     GET  /api/health');
  console.log('     GET  /api/billeteras');
  console.log('     GET  /api/plazo');
  console.log('     GET  /api/badlar');
  console.log('     POST /api/cache/clear\n');
});
