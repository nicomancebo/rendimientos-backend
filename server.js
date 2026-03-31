require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const mercadoRoutes = require('./server-mercado');

const PORT    = process.env.PORT || 3001;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const TTL     = {
  plazo:  parseInt(process.env.CACHE_PLAZO_TTL)  || 3600,
  badlar: parseInt(process.env.CACHE_BADLAR_TTL) || 3600,
};

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const http = axios.create({
  timeout: 12000,
  headers: { 'Accept': 'application/json', 'User-Agent': 'CuantoRinde/1.0' },
});

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function today() { return new Date().toISOString().split('T')[0]; }
function initials(s) { return (s||'').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase(); }

const app = express();
app.use(express.json());
app.use(cors({
  origin: (o, cb) => (!o || ORIGINS.includes('*') || ORIGINS.includes(o)) ? cb(null,true) : cb(new Error('CORS')),
  methods: ['GET'],
}));
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS)||60000,
  max: parseInt(process.env.RATE_LIMIT_MAX)||60,
  standardHeaders: true, legacyHeaders: false,
}));

/* ── HEALTH ── */
app.get('/api/health', (_,res) => res.json({ status:'ok', uptime:Math.floor(process.uptime()) }));

app.use('/api', mercadoRoutes);

/* ─────────────────────────────────────────────────────────────────
   BILLETERAS — datos curados manualmente
   CAFCI bloquea servidores externos (401/403). Sus tasas se
   actualizan semanalmente, así que mantenemos una lista curada
   que refleja la realidad del mercado.
   Última actualización: marzo 2026
   ───────────────────────────────────────────────────────────────── */
const BILLETERAS = [
  { nombre:'Carrefour Banco', subtipo:'Cuenta Digital',     tipo:'billetera', tna:26.0, logo:'CF', min:'Sin mínimo' },
  { nombre:'Banco Bica',      subtipo:'Cuenta Remunerada',  tipo:'billetera', tna:28.0, logo:'BC', min:'Sin mínimo' },
  { nombre:'Naranja X',       subtipo:'Frascos Fijos',      tipo:'billetera', tna:25.0, logo:'NX', min:'Sin mínimo' },
  { nombre:'Ualá',            subtipo:'Alpha Ahorro',       tipo:'billetera', tna:24.0, logo:'UL', min:'Sin mínimo' },
  { nombre:'Cocos Pay',       subtipo:'FCI Cocos Daruma',   tipo:'fci',       tna:23.8, logo:'CO', min:'$100' },
  { nombre:'Adcap',           subtipo:'FCI Money Market',   tipo:'mm',        tna:23.5, logo:'AD', min:'$1.000' },
  { nombre:'InvertirOnline',  subtipo:'FCI Liquidez',       tipo:'mm',        tna:23.0, logo:'IO', min:'$1.000' },
  { nombre:'Prex',            subtipo:'FCI Liquidez',       tipo:'fci',       tna:22.8, logo:'PX', min:'Sin mínimo' },
  { nombre:'Personal Pay',    subtipo:'Cuenta remunerada',  tipo:'billetera', tna:22.5, logo:'PP', min:'Sin mínimo' },
  { nombre:'Cuenta DNI',      subtipo:'Provincia FCI',      tipo:'billetera', tna:22.0, logo:'DN', min:'Sin mínimo' },
  { nombre:'Mercado Pago',    subtipo:'Mercado Fondo',      tipo:'billetera', tna:21.7, logo:'MP', min:'Sin mínimo' },
  { nombre:'BruBank',         subtipo:'Ahorro BruBank',     tipo:'billetera', tna:21.0, logo:'BR', min:'Sin mínimo' },
  { nombre:'BBVA',            subtipo:'FCI Renta Total',    tipo:'fci',       tna:20.5, logo:'BV', min:'$1.000' },
  { nombre:'Bind',            subtipo:'FCI Money Market',   tipo:'mm',        tna:20.0, logo:'BI', min:'$5.000' },
].map(b => ({
  ...b,
  tea: parseFloat(((Math.pow(1 + b.tna/100/365, 365) - 1)*100).toFixed(2)),
  updatedAt: '2026-03-28',
}));

app.get('/api/billeteras', (_,res) => {
  res.json({
    source: 'curated',
    notice: 'Datos actualizados manualmente. CAFCI no permite acceso desde servidores externos.',
    updatedAt: '2026-03-28',
    data: BILLETERAS,
  });
});

/* ─────────────────────────────────────────────────────────────────
   PLAZO FIJO — BCRA v3 (funciona correctamente)
   Variable 25 = Tasa depósitos a plazo fijo promedio
   ───────────────────────────────────────────────────────────────── */
app.get('/api/plazo', async (_,res) => {
  const KEY = 'plazo';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source:'cache', data:hit });

  try {
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/25/${daysAgo(10)}/${today()}`
    );
    const results = data.results || [];
    if (!results.length) throw new Error('Sin datos BCRA');

    const ultimo = results[results.length - 1];
    const tnaRef = parseFloat(ultimo.valor);

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
        tea: parseFloat(((Math.pow(1+tna/100/365,365)-1)*100).toFixed(2)),
        logo: initials(e.nombre), fechaRef: ultimo.fecha,
      };
    }).sort((a,b) => b.tna - a.tna);

    cache.set(KEY, entidades, TTL.plazo);
    res.json({ source:'api', data:entidades, tnaReferencia:tnaRef, fetchedAt:new Date().toISOString() });

  } catch(err) {
    console.error('[/api/plazo]', err.message);
    res.status(502).json({ error:'No se pudo obtener datos del BCRA', detail:err.message });
  }
});

/* ── BADLAR — BCRA v3 ── */
app.get('/api/badlar', async (_,res) => {
  const KEY = 'badlar';
  const hit = cache.get(KEY);
  if (hit) return res.json({ source:'cache', ...hit });

  try {
    const { data } = await http.get(
      `https://api.bcra.gob.ar/estadisticas/v3.0/datosvariable/34/${daysAgo(10)}/${today()}`
    );
    const results = data.results || [];
    if (!results.length) throw new Error('Sin datos');
    const ultimo = results[results.length-1];
    const resultado = { tna: parseFloat(ultimo.valor), fecha: ultimo.fecha };
    cache.set(KEY, resultado, TTL.badlar);
    res.json({ source:'api', ...resultado, fetchedAt:new Date().toISOString() });
  } catch(err) {
    console.error('[/api/badlar]', err.message);
    res.status(502).json({ error:'No se pudo obtener BADLAR', detail:err.message });
  }
});

app.post('/api/cache/clear', (req,res) => {
  const key = req.headers['x-api-key'];
  if (process.env.ADMIN_API_KEY && key !== process.env.ADMIN_API_KEY)
    return res.status(401).json({ error:'No autorizado' });
  cache.flushAll();
  res.json({ ok:true });
});

app.use((err,_,res,__) => res.status(500).json({ error:err.message }));

app.listen(PORT, () => {
  console.log('\n🚀 CuantoRinde Backend - http://localhost:' + PORT);
  console.log('   Billeteras: datos curados ✅');
  console.log('   Plazo fijo: BCRA v3.0 ✅');
  console.log('   BADLAR: BCRA v3.0 ✅\n');
});
