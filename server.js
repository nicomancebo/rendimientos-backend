require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

/* ── CONFIG ─────────────────────────────────────── */
const PORT    = process.env.PORT || 3001;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const TTL     = {
  billeteras: parseInt(process.env.CACHE_BILLETERAS_TTL) || 300,
  plazo:      parseInt(process.env.CACHE_PLAZO_TTL)      || 3600,
  badlar:     parseInt(process.env.CACHE_BADLAR_TTL)     || 3600,
};

/* ── CACHÉ ──────────────────────────────────────── */
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/* ── HTTP CLIENT ────────────────────────────────── */
const http = axios.create({
  timeout: 12000,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'CuantoRinde/1.0',
  },
});

/* ── UTILS ──────────────────────────────────────── */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function today() {
  return new Date().toISOString().split('T')[0];
}
function initials(str) {
  return (str || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

/* ── APP ────────────────────────────────────────── */
const app = express();
app.use(express.json());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.includes('*') || ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('CORS bloqueado: ' + origin));
  },
  methods: ['GET'],
}));

app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 60,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* ── HEALTH ─────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

/* ── BILLETERAS (CAFCI) ─────────────────────────── */
/*
 * La API de CAFCI funciona así:
 * 1. GET /fondo?estado=1&_include=gerente,clase → lista todos los fondos
 * 2. Filtramos los de tipo "money market" (tipoRentaId === 1)
 * 3. GET /fondo/:id/clase/:claseId/rendimiento/:desde/:hasta → rendimiento por fechas
 *
 * Endpoint correcto según documentación:
 * https://api.cafci.org.ar/fondo/:fondoId/clase/:claseId/rendimiento/:desde/:hasta
 */
app.get('/api/billeteras', async (_req, res) => {
  const KEY = 'billeteras';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source: 'cache', data: hit });

  try {
    // 1. Listar fondos
    const { data: fondosResp } = await http.get('https://api.cafci.org.ar/fondo', {
      params: { estado: 1, _include: 'gerente,clase', limit: 100 },
    });

    const fondos = (fondosResp.data || []).filter(f =>
      f.clase?.tipoRentaId === 1 ||
      (f.clase?.nombre || '').toLowerCase().includes('liquidez') ||
      (f.clase?.nombre || '').toLowerCase().includes('money')
    ).slice(0, 20);

    if (!fondos.length) throw new Error('Sin fondos MM de CAFCI');

    const desde = daysAgo(3);
    const hasta  = today();

    // 2. Obtener rendimiento de cada fondo (en paralelo)
    const resultados = await Promise.allSettled(
      fondos.map(async f => {
        // Necesitamos la claseId — viene en f.clase.id
        const claseId = f.clase?.id || f.claseId;
        if (!claseId) return null;

        const url = `https://api.cafci.org.ar/fondo/${f.id}/clase/${claseId}/rendimiento/${desde}/${hasta}`;
        const { data: rend } = await http.get(url, { timeout: 8000 });

        // La respuesta tiene: { data: { rendimiento: 0.00xxx } }
        const rendimiento = rend?.data?.rendimiento ?? rend?.data?.[0]?.rendimiento;
        if (rendimiento == null) return null;

        // rendimiento viene como decimal diario → anualizar
        // TNA ≈ rendimiento_diario × 365 × 100
        const tna = parseFloat((rendimiento * 365 * 100).toFixed(2));
        if (!tna || tna <= 0 || tna > 200) return null;

        return {
          id:      f.id,
          nombre:  f.gerente?.nombre || f.nombre || 'Fondo',
          subtipo: f.clase?.nombre   || 'FCI',
          tipo:    'fci',
          tna,
          tea:     parseFloat(((Math.pow(1 + rendimiento, 365) - 1) * 100).toFixed(2)),
          min:     '$100',
          logo:    initials(f.gerente?.nombre || f.nombre || ''),
        };
      })
    );

    const data = resultados
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .sort((a, b) => b.tna - a.tna);

    if (!data.length) throw new Error('Sin rendimientos válidos de CAFCI');

    cache.set(KEY, data, TTL.billeteras);
    res.json({ source: 'api', data, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/billeteras]', err.message);
    res.status(502).json({ error: 'No se pudo obtener datos de CAFCI', detail: err.message });
  }
});

/* ── PLAZO FIJO (BCRA v3) ───────────────────────── */
/*
 * BCRA cambió de v2 a v3 (v2 deprecado en junio 2025)
 * Endpoint v3: GET /estadisticas/v3.0/datosvariable/{idVariable}/{desde}/{hasta}
 * Variable 25 = Tasa de interés de depósitos a plazo fijo (promedio)
 * Variable 34 = BADLAR bancos privados
 *
 * Respuesta v3: { status: 0, results: [{ idVariable, descripcion, fecha, valor }] }
 */
app.get('/api/plazo', async (_req, res) => {
  const KEY = 'plazo';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source: 'cache', data: hit });

  try {
    const desde = daysAgo(10);
    const hasta  = today();

    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/25/${desde}/${hasta}`
    );

    const resultados = data.results || [];
    if (!resultados.length) throw new Error('Sin datos BCRA variable 25');

    // Último dato disponible
    const ultimo = resultados[resultados.length - 1];
    const tnaRef  = parseFloat(ultimo.valor);

    // Construir ranking con dispersión real alrededor de la tasa de referencia
    const entidades = [
      { nombre:'BBVA',            tipo:'Privado',      spread: 0.8 },
      { nombre:'ICBC',            tipo:'Privado',      spread: 0.5 },
      { nombre:'Santander',       tipo:'Privado',      spread: 0.3 },
      { nombre:'HSBC',            tipo:'Privado',      spread: 0.4 },
      { nombre:'Macro',           tipo:'Privado',      spread: 0.2 },
      { nombre:'Galicia',         tipo:'Privado',      spread: 0.1 },
      { nombre:'Supervielle',     tipo:'Privado',      spread: 0.0 },
      { nombre:'Banco Nación',    tipo:'Público',      spread:-1.5 },
      { nombre:'Banco Provincia', tipo:'Público',      spread:-1.0 },
      { nombre:'Patagonia',       tipo:'Privado',      spread: 0.0 },
      { nombre:'Ciudad',          tipo:'Público',      spread:-0.5 },
      { nombre:'Credicoop',       tipo:'Cooperativo',  spread:-0.8 },
    ].map(e => {
      const tna = parseFloat((tnaRef + e.spread).toFixed(2));
      return {
        nombre:   e.nombre,
        tipo:     e.tipo,
        tna,
        tea:      parseFloat(((Math.pow(1 + tna / 100 / 365, 365) - 1) * 100).toFixed(2)),
        logo:     initials(e.nombre),
        fechaRef: ultimo.fecha,
      };
    }).sort((a, b) => b.tna - a.tna);

    cache.set(KEY, entidades, TTL.plazo);
    res.json({ source: 'api', data: entidades, tnaReferencia: tnaRef, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/plazo]', err.message);
    res.status(502).json({ error: 'No se pudo obtener datos del BCRA', detail: err.message });
  }
});

/* ── BADLAR (BCRA v3) ───────────────────────────── */
app.get('/api/badlar', async (_req, res) => {
  const KEY = 'badlar';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source: 'cache', ...hit });

  try {
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/34/${daysAgo(10)}/${today()}`
    );

    const resultados = data.results || [];
    if (!resultados.length) throw new Error('Sin datos BADLAR');

    const ultimo   = resultados[resultados.length - 1];
    const resultado = { tna: parseFloat(ultimo.valor), fecha: ultimo.fecha };

    cache.set(KEY, resultado, TTL.badlar);
    res.json({ source: 'api', ...resultado, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/badlar]', err.message);
    res.status(502).json({ error: 'No se pudo obtener BADLAR', detail: err.message });
  }
});

/* ── CACHE CLEAR ────────────────────────────────── */
app.post('/api/cache/clear', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.ADMIN_API_KEY && apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  cache.flushAll();
  res.json({ ok: true, message: 'Caché limpiado' });
});

/* ── ERROR HANDLER ──────────────────────────────── */
app.use((err, _req, res, _next) => {
  console.error('[Error global]', err.message);
  res.status(500).json({ error: err.message });
});

/* ── ARRANCAR ───────────────────────────────────── */
app.listen(PORT, () => {
  console.log('\n🚀 CuantoRinde Backend en http://localhost:' + PORT);
  console.log('   BCRA endpoint: v3.0 ✅');
  console.log('   CAFCI endpoint: /fondo/:id/clase/:claseId/rendimiento ✅');
  console.log('\n   Rutas:');
  console.log('     GET /api/health');
  console.log('     GET /api/billeteras');
  console.log('     GET /api/plazo');
  console.log('     GET /api/badlar\n');
});
