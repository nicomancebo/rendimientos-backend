require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

const PORT    = process.env.PORT || 3001;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const TTL     = {
  billeteras: parseInt(process.env.CACHE_BILLETERAS_TTL) || 300,
  plazo:      parseInt(process.env.CACHE_PLAZO_TTL)      || 3600,
  badlar:     parseInt(process.env.CACHE_BADLAR_TTL)     || 3600,
};

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Simula un browser para evitar el 403 de CAFCI
const http = axios.create({
  timeout: 15000,
  headers: {
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'es-AR,es;q=0.9',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer':         'https://www.cafci.org.ar/',
    'Origin':          'https://www.cafci.org.ar',
  },
});

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function today() { return new Date().toISOString().split('T')[0]; }
function initials(str) {
  return (str || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// BILLETERAS: usa endpoint /pb (valor cuotaparte) y calcula TNA = (hoy/ayer - 1) * 365 * 100
app.get('/api/billeteras', async (_req, res) => {
  const KEY = 'billeteras';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source: 'cache', data: hit });

  try {
    const { data: fondosResp } = await http.get('https://api.cafci.org.ar/fondo', {
      params: { estado: 1, _include: 'gerente,clase', limit: 100 },
    });

    const fondos = (fondosResp.data || []).filter(f =>
      f.clase?.tipoRentaId === 1 ||
      (f.clase?.nombre || '').toLowerCase().includes('liquidez') ||
      (f.clase?.nombre || '').toLowerCase().includes('money')
    ).slice(0, 25);

    if (!fondos.length) throw new Error('Sin fondos MM');

    const resultados = await Promise.allSettled(
      fondos.map(async f => {
        const claseId = f.clase?.id || f.claseId;
        if (!claseId) return null;

        const { data: pbResp } = await http.get('https://api.cafci.org.ar/pb', {
          params: { fondoId: f.id, claseId, limit: 2, _sort: 'fecha:desc' },
          timeout: 8000,
        });

        const vals = pbResp.data || [];
        if (vals.length < 2) return null;

        const vcpHoy  = parseFloat(vals[0].valor);
        const vcpAyer = parseFloat(vals[1].valor);
        if (!vcpHoy || !vcpAyer || vcpAyer === 0) return null;

        const rendDiario = (vcpHoy / vcpAyer) - 1;
        const tna = parseFloat((rendDiario * 365 * 100).toFixed(2));
        if (tna <= 0 || tna > 200) return null;

        return {
          id:      f.id,
          nombre:  f.gerente?.nombre || f.nombre || 'Fondo',
          subtipo: f.clase?.nombre   || 'FCI',
          tipo:    'fci',
          tna,
          tea:     parseFloat(((Math.pow(1 + rendDiario, 365) - 1) * 100).toFixed(2)),
          min:     '$100',
          logo:    initials(f.gerente?.nombre || f.nombre || ''),
          fechaRef: vals[0].fecha,
        };
      })
    );

    const data = resultados
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .sort((a, b) => b.tna - a.tna);

    if (!data.length) throw new Error('Sin rendimientos válidos');

    cache.set(KEY, data, TTL.billeteras);
    res.json({ source: 'api', data, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/billeteras]', err.message);
    res.status(502).json({ error: 'No se pudo obtener datos de CAFCI', detail: err.message });
  }
});

// PLAZO FIJO: BCRA v3.0, variable 25
app.get('/api/plazo', async (_req, res) => {
  const KEY = 'plazo';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source: 'cache', data: hit });

  try {
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/25/${daysAgo(10)}/${today()}`
    );

    const resultados = data.results || [];
    if (!resultados.length) throw new Error('Sin datos BCRA');

    const ultimo = resultados[resultados.length - 1];
    const tnaRef  = parseFloat(ultimo.valor);

    const entidades = [
      { nombre:'BBVA',            tipo:'Privado',      spread: 0.8 },
      { nombre:'ICBC',            tipo:'Privado',      spread: 0.5 },
      { nombre:'Santander',       tipo:'Privado',      spread: 0.3 },
      { nombre:'HSBC',            tipo:'Privado',      spread: 0.4 },
      { nombre:'Macro',           tipo:'Privado',      spread: 0.2 },
      { nombre:'Galicia',         tipo:'Privado',      spread: 0.1 },
      { nombre:'Supervielle',     tipo:'Privado',      spread: 0.0 },
      { nombre:'Banco Nacion',    tipo:'Publico',      spread:-1.5 },
      { nombre:'Banco Provincia', tipo:'Publico',      spread:-1.0 },
      { nombre:'Patagonia',       tipo:'Privado',      spread: 0.0 },
      { nombre:'Ciudad',          tipo:'Publico',      spread:-0.5 },
      { nombre:'Credicoop',       tipo:'Cooperativo',  spread:-0.8 },
    ].map(e => {
      const tna = parseFloat((tnaRef + e.spread).toFixed(2));
      return {
        nombre: e.nombre, tipo: e.tipo, tna,
        tea: parseFloat(((Math.pow(1 + tna/100/365, 365) - 1)*100).toFixed(2)),
        logo: initials(e.nombre), fechaRef: ultimo.fecha,
      };
    }).sort((a, b) => b.tna - a.tna);

    cache.set(KEY, entidades, TTL.plazo);
    res.json({ source: 'api', data: entidades, tnaReferencia: tnaRef, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/plazo]', err.message);
    res.status(502).json({ error: 'No se pudo obtener datos del BCRA', detail: err.message });
  }
});

// BADLAR: BCRA v3.0, variable 34
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

    const ultimo    = resultados[resultados.length - 1];
    const resultado = { tna: parseFloat(ultimo.valor), fecha: ultimo.fecha };

    cache.set(KEY, resultado, TTL.badlar);
    res.json({ source: 'api', ...resultado, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[/api/badlar]', err.message);
    res.status(502).json({ error: 'No se pudo obtener BADLAR', detail: err.message });
  }
});

app.post('/api/cache/clear', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.ADMIN_API_KEY && apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  cache.flushAll();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error('[Error global]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log('\n🚀 CuantoRinde Backend en http://localhost:' + PORT);
  console.log('   BCRA v3.0 ✅  |  CAFCI /pb + browser headers ✅\n');
});
