/* ==========================================================================
   Granjas · Frontend (ES Modules, sin frameworks)
   --------------------------------------------------------------------------
    1. Configuración           7. Navegación y estructura
    2. Estado                  8. Vistas: dashboard y registros
    3. Utilidades              9. Vistas: granjas, perfiles y usuarios
    4. API (backend)          10. Vistas: listas, bitácora y seguridad
    5. Datos y agregaciones   11. Modales y formularios
    6. Tablas y gráficos      12. Acciones, autenticación y arranque
   La interfaz solo oculta lo que cada rol no puede usar: los permisos reales
   (qué granjas ve cada quien) los aplica el servidor en cada solicitud.
   ========================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    initializeAuth, browserSessionPersistence, onAuthStateChanged, signInWithEmailAndPassword,
    signOut, sendPasswordResetEmail, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { ico, hydrateIcons } from './icons.js';
import { mountChart, mountHeatmap, exportChartPng, downloadBlob, PALETTE } from './charts.js';

// ==========================================================================
// 1. CONFIGURACIÓN
// ==========================================================================

const CONFIG = {
    // Analytics no se usa (no se envían datos a terceros).
    firebase: {
        apiKey: 'AIzaSyAMXTdCrgzvyyFxsByJ6Byl4Cooq1M6wRI',
        authDomain: 'granjas-c1fd1.firebaseapp.com',
        projectId: 'granjas-c1fd1',
        messagingSenderId: '946552384503',
        appId: '1:946552384503:web:c7f2e8dac34740b2631cf2',
    },
    // URL de la implementación "Aplicación web" de Apps Script (termina en /exec).
    API_URL: 'https://script.google.com/macros/s/AKfycbzn504S2TE-r9JaFIYudjApmL6QQqCpogRyLGU8GCmTX5dsEo5LEbS7GhdQ4HDQ3vTJ/exec',
    INACTIVIDAD_MIN: 30,        // cierre automático de sesión por inactividad
    MIN_CLAVE: 10,              // longitud mínima de la contraseña definitiva
    MIN_JUSTIFICACION: 10,
    RANGO_INICIAL_DIAS: 90,
    MAX_FILAS_TABLA: 1000,      // filas dibujadas por tabla (el CSV incluye todas)
};

const ROLES = { ADMIN: 'ADMIN', REPRESENTANTE: 'REPRESENTANTE' };
const ROLE_LABEL = { ADMIN: 'Administrador', REPRESENTANTE: 'Representante' };
const LINEAS = ['Reproductora', 'Incubadora', 'Engorde', 'Postura'];
const LINEA_ICON = { Reproductora: 'bird', Incubadora: 'archive', Engorde: 'drumstick', Postura: 'egg' };
const SECCION_ICON = {
    'Información de origen': 'globe',
    'Información de incubadora': 'egg',
    'Programa de vacunación incubadora': 'syringe',
    'Información granja': 'warehouse',
};
const LISTA_LABEL = {
    Pais: 'Países', Raza: 'Razas', SistemaAlojamiento: 'Sistemas de alojamiento',
    EmpresaIncubadora: 'Empresas incubadoras', Vacuna: 'Vacunas',
    GeneticaPostura: 'Líneas genéticas · postura', GeneticaEngorde: 'Líneas genéticas · engorde',
};
const PRESETS = [[30, '30 días'], [90, '90 días'], [180, '6 meses'], [365, '1 año'], [0, 'Todo']];
const AGRUPAR = [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']];
/** Pesos: el servidor guarda gramos; aquí solo se convierte para escribir y mostrar. */
const UNIDADES = { g: 1, kg: 1000, lb: 453.59237 };
const UNIDAD_NOMBRE = { g: 'gramos', kg: 'kilogramos', lb: 'libras' };
/** Colores del índice de estrés calórico (nivel → color). */
const IEC_COLOR = { verde: '#3FBF7F', amarillo: '#F2C94C', naranja: '#F2994A', rojo: '#C62828' };

window.__granjasIniciada = true;   // avisa a boot-check.js que la app sí arrancó
hydrateIcons();

const auth = initializeAuth(initializeApp(CONFIG.firebase), { persistence: browserSessionPersistence });

// ==========================================================================
// 2. ESTADO
// ==========================================================================

const emptyDb = () => ({
    granjas: [], perfiles: [], users: [], listas: [], sectores: [], naves: [], lotes: [],
    campos: { perfil: [], Reproductora: [], Incubadora: [], Engorde: [], Postura: [] }, tiposLista: [],
    geneticaDe: {}, iecRangos: [], diasRetroactivos: 7, maxMuestra: 1000, estandares: [], tiposEstandar: [],
    enfermedades: [], metodosSerologia: [], pruebasSerologia: {},
});
const filtrosIniciales = () => ({ desde: daysAgo(CONFIG.RANGO_INICIAL_DIAS), hasta: today(), granjas: [], agrupar: 'semana', eliminados: false, sector: '', nave: '' });

const state = {
    user: null,
    me: null,
    db: emptyDb(),
    busy: 0,
    granjaId: null,          // representante: granja activa (cada granja se trabaja por separado)
    linea: 'Postura',
    f: filtrosIniciales(),
    unidad: leerPref('granjas.unidad', 'kg'),   // unidad para ver pesos (g, kg, lb)
    cache: new Map(),        // respuestas de lectura (registros, pesajes, bitácora…) por solicitud
    loading: new Set(),
    sort: {},
    q: {},
    audit: null,
    ddOpen: false,
    registros: new Map(),    // RegistroID → registro visible (para las acciones de la tabla)
    pesajes: new Map(),      // PesajeID → pesaje visible
    lecturas: new Map(),     // LecturaID → lectura visible
    compras: new Map(),      // CompraID → compra de concentrado visible
    serologias: new Map(),   // SerologiaID → muestreo serológico visible
    srEnf: '',               // Serología: enfermedad y método elegidos en los filtros
    srMetodo: '',
    estFilas: new Map(),     // EstandarID → fila de la curva visible
    estGen: '',              // Pesos estándar: línea genética y tabla elegidas
    estTipo: 'Comercial',
    bitGranja: '',
};

const tables = {};
const charts = {};
let chartUnmounts = [];
/** Captura de pesos en curso (modal de pesaje). */
let pz = null;
/** Cambia en cada cierre de sesión (ver limpiarSesion). */
let sesionN = 0;

function leerPref(k, def) {
    try { return localStorage.getItem(k) || def; } catch { return def; }
}
function guardarPref(k, v) {
    try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ }
}

// ==========================================================================
// 3. UTILIDADES
// ==========================================================================

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Escapa todo texto dinámico antes de insertarlo como HTML. */
function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 2 });
function toNum(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function fmtNum(v) { const n = toNum(v); return n === null ? '—' : nf.format(n); }
const nfQ = new Intl.NumberFormat('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Quetzales: "Q 6.50". */
function fmtQ(v) { const n = toNum(v); return n === null ? '—' : `Q ${nfQ.format(n)}`; }
function today() { return new Date().toLocaleDateString('en-CA'); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); }
function fmtDate(s) {
    if (!s) return '—';
    const [y, m, d] = String(s).slice(0, 10).split('-');
    return d ? `${d}/${m}/${y}` : String(s);
}
function fmtDateTime(s) {
    if (!s) return '—';
    return String(s).length > 10 ? `${fmtDate(s)} ${String(s).slice(11, 16)}` : fmtDate(s);
}
function norm(s) { return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'datos'; }
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(); }
const isAdmin = () => state.me?.Rol === ROLES.ADMIN;
const granjaById = id => state.db.granjas.find(g => g.GranjaID === id);
const granjaName = id => granjaById(id)?.NombreGranja || '—';
const userById = id => state.db.users.find(u => u.ID === id);

function badgeEstado(estado) {
    return estado === 'Activo'
        ? '<span class="badge badge-ok">Activo</span>'
        : `<span class="badge badge-warn">${esc(estado || '—')}</span>`;
}
function emptyState(msg, icon = 'inbox', actionHtml = '') {
    return `<div class="card"><div class="empty"><span class="empty-icon">${ico(icon)}</span><p>${esc(msg)}</p>${actionHtml}</div></div>`;
}
function kpi(label, value, sub, icon) {
    return `<div class="kpi"><span class="kpi-icon">${ico(icon)}</span><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${esc(value)}</span>${sub ? `<span class="kpi-sub">${esc(sub)}</span>` : ''}</div>`;
}
function alertBox(type, icon, html) { return `<div class="alert alert-${type}">${ico(icon)}<span>${html}</span></div>`; }

// ==========================================================================
// 4. API (backend)
// ==========================================================================

class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

// Mensajes para el usuario: nunca mencionan tecnologías. El detalle técnico va a la consola.
const MSG = {
    CONFIG: 'La plataforma no está disponible en este momento. Contacta al administrador.',
    NETWORK: 'No hay conexión. Revisa tu internet e intenta de nuevo.',
    BAD_RESPONSE: 'No pudimos confirmar si la operación se completó. Revisa la información actualizada antes de intentarlo de nuevo.',
};
const READ_ACTIONS = new Set(['getSnapshot', 'getRegistros', 'getResumen', 'getPesajes', 'getAmbiente', 'getBitacora', 'getAccesos', 'verifyAudit']);
const ACCESS_CODES = new Set(['NOT_REGISTERED', 'SUSPENDED', 'ACCOUNT_LOCKED']);

async function api(action, payload = {}, { forceRefresh = false, retried = false } = {}) {
    const idToken = await auth.currentUser?.getIdToken(forceRefresh);
    if (!idToken) throw new ApiError('UNAUTHENTICATED', 'Tu sesión no está iniciada.');

    let res;
    try {
        // text/plain evita el preflight CORS (el servidor no lo admite).
        res = await fetch(CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, payload, idToken }),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
    } catch (e) {
        console.error(`[Granjas] Falló la conexión (${action}):`, e);
        throw new ApiError('NETWORK', MSG.NETWORK);
    }
    const text = await res.text().catch(() => '');
    let json;
    try { json = JSON.parse(text); } catch {
        console.error(`[Granjas] Respuesta no válida (${action}) · HTTP ${res.status}\n`, text.slice(0, 1500));
        if (!retried && READ_ACTIONS.has(action)) return api(action, payload, { forceRefresh, retried: true });
        throw new ApiError('BAD_RESPONSE', MSG.BAD_RESPONSE);
    }
    if (json.ok && !Object.prototype.hasOwnProperty.call(json, 'data')) {
        if (!retried && READ_ACTIONS.has(action)) return api(action, payload, { forceRefresh, retried: true });
        throw new ApiError('BAD_RESPONSE', MSG.BAD_RESPONSE);
    }
    if (!json.ok) {
        const err = new ApiError(json.error?.code || 'ERROR', json.error?.message || 'Error desconocido.');
        if (state.me) {
            if (err.code === 'PASSWORD_CHANGE_REQUIRED') showPasswordScreen();
            else if (err.code === 'UNAUTHENTICATED') setTimeout(() => signOut(auth), 1500);
            else if (ACCESS_CODES.has(err.code)) showAccessDenied(err);
        }
        throw err;
    }
    return json.data;
}

async function loadSnapshot(opts) {
    const data = await api('getSnapshot', {}, opts);
    state.me = data.me;
    state.mustChangePassword = !!data.mustChangePassword;
    state.db = { ...emptyDb(), ...data };
    if (!isAdmin()) {
        const ids = state.db.granjas.map(g => g.GranjaID);
        if (!ids.includes(state.granjaId)) state.granjaId = ids[0] || null;
    } else {
        state.f.granjas = state.f.granjas.filter(id => granjaById(id));
    }
}

async function withBusy(fn) {
    state.busy++;
    $('#busy-bar').classList.add('is-active');
    try { return await fn(); } finally {
        state.busy--;
        if (!state.busy) $('#busy-bar').classList.remove('is-active');
    }
}

/** Recarga todo (datos base y consultas) y vuelve a dibujar. */
async function refreshAll() {
    state.cache.clear();
    await withBusy(() => loadSnapshot());
    renderChrome();
    render();
}

/**
 * Lectura con caché: devuelve { ok, data } o { ok:false, error }, o null mientras carga
 * (al terminar vuelve a dibujar la vista).
 */
function need(action, payload) {
    const key = action + JSON.stringify(payload);
    if (state.cache.has(key)) return state.cache.get(key);
    if (!state.loading.has(key)) {
        state.loading.add(key);
        const sesion = sesionN;
        const guardar = (v) => { if (sesion === sesionN) state.cache.set(key, v); };
        withBusy(() => api(action, payload))
            .then(data => guardar({ ok: true, data }))
            .catch(e => guardar({ ok: false, error: e.message, code: e.code }))
            .finally(() => { state.loading.delete(key); if (state.me) render(); });
    }
    return null;
}

function loadingBlock(n = 1) {
    return Array.from({ length: n }, () => '<div class="skeleton" aria-hidden="true"></div>').join('');
}
function errorBlock(r) {
    return `<div class="card"><div class="empty"><span class="empty-icon">${ico('alert-triangle')}</span><p>${esc(r.error)}</p>
        <button type="button" class="btn btn-primary" data-action="retry">${ico('rotate-cw')}Reintentar</button></div></div>`;
}

// ==========================================================================
// 5. DATOS Y AGREGACIONES
// ==========================================================================

function perfilDe(granjaId, linea) {
    return state.db.perfiles.find(p => p.GranjaID === granjaId && p.Linea === linea) || null;
}

/** Granjas del contexto actual. Representante: SOLO la granja activa. Admin: filtro o todas. */
function ctxIds() {
    if (!isAdmin()) return state.granjaId ? [state.granjaId] : [];
    return state.f.granjas.length ? [...state.f.granjas] : state.db.granjas.map(g => g.GranjaID);
}
/** Una línea solo se muestra si alguna granja del contexto tiene su ficha activa. */
function lineasDisponibles(ids) {
    return LINEAS.filter(l => ids.some(id => perfilDe(id, l)?.Estado === 'Activo'));
}
function ensureLinea(ids) {
    const d = lineasDisponibles(ids);
    if (d.length && !d.includes(state.linea)) { state.linea = d[0]; state.f.sector = ''; state.f.nave = ''; }
    return d;
}
/** Granjas que se piden al servidor (el servidor vuelve a validar el acceso). */
function apiGranjas() {
    if (!isAdmin()) return state.granjaId ? [state.granjaId] : [];
    return state.f.granjas.length ? [...state.f.granjas] : undefined;
}

// ---------- Estructura: sectores → naves → lotes ----------
function byNombre(a, b) { return String(a.Nombre).localeCompare(String(b.Nombre), 'es', { numeric: true }); }
const sectorById = id => state.db.sectores.find(s => s.SectorID === id);
const naveById = id => state.db.naves.find(n => n.NaveID === id);
const loteById = id => state.db.lotes.find(l => l.LoteID === id);
const sectoresDe = (granjaId, linea) => state.db.sectores.filter(s => s.GranjaID === granjaId && s.Linea === linea).sort(byNombre);
const navesDe = sectorId => state.db.naves.filter(n => n.SectorID === sectorId).sort(byNombre);
const lotesDe = naveId => state.db.lotes.filter(l => l.NaveID === naveId).sort((a, b) => (a.FechaInicio < b.FechaInicio ? 1 : -1));
const loteActivo = naveId => state.db.lotes.find(l => l.NaveID === naveId && l.Estado === 'Activo') || null;
/** Lote que ocupaba la nave en una fecha (igual que el servidor). */
function loteEn(naveId, fecha) {
    return lotesDe(naveId).find(l => l.FechaInicio <= fecha && (!l.FechaCierre || l.FechaCierre >= fecha)) || null;
}

// ---------- Edad de las aves y peso esperado (mismas fórmulas que el servidor) ----------
/** Edad en días en una fecha: edad al iniciar (semanas) × 7 + días desde el inicio; null sin edad inicial. */
function edadDias(lote, fecha) {
    const semanas = toNum(lote?.EdadInicialSemanas);
    if (semanas === null || !lote.FechaInicio || !fecha) return null;
    const [a, b] = [lote.FechaInicio, String(fecha).slice(0, 10)].map(s => s.split('-').map(Number));
    return Math.round(semanas * 7) + Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}
const tipoEstandar = linea => (linea === 'Incubadora' ? null : linea === 'Reproductora' ? 'Reproductora' : 'Comercial');
/** Peso esperado { minimoG, estandarG, maximoG, fuente } por interpolación, o null fuera de la curva. */
function esperado(genetica, tipo, dias) {
    if (dias === null || !tipo) return null;
    const filas = state.db.estandares.filter(x => x.LineaGenetica === genetica && x.Tipo === tipo)
        .map(x => ({ d: Number(x.EdadDias), min: toNum(x.MinimoG), std: toNum(x.EstandarG), max: toNum(x.MaximoG), fuente: x.Fuente }))
        .sort((p, q) => p.d - q.d);
    if (!filas.length || dias < filas[0].d || dias > filas[filas.length - 1].d) return null;
    let i = 0;
    while (i < filas.length - 1 && filas[i + 1].d <= dias) i++;
    const a = filas[i], b = filas[Math.min(i + 1, filas.length - 1)];
    const f = b.d === a.d ? 0 : (dias - a.d) / (b.d - a.d);
    const mezcla = k => (a[k] === null || b[k] === null ? null : a[k] + (b[k] - a[k]) * f);
    return { minimoG: mezcla('min'), estandarG: mezcla('std'), maximoG: mezcla('max'), fuente: f < 0.5 ? a.fuente : b.fuente };
}
/** "Semana 23 (día 163)". */
function textoEdad(dias) { return dias === null ? '' : `Semana ${Math.floor(dias / 7)} (día ${dias})`; }
/** Insignia del estado del pesaje contra la tabla (con texto, no solo color). */
function badgeEstadoPeso(estado) {
    const cls = { Bajo: 'badge-danger', Sobre: 'badge-warn', Dentro: 'badge-ok' }[estado] || 'badge-muted';
    return estado ? `<span class="badge ${cls}">${esc(estado)}</span>` : '—';
}
/** Naves que admiten datos nuevos: nave y sector activos. */
function navesActivas(granjaId, linea) {
    return sectoresDe(granjaId, linea).filter(s => s.Estado === 'Activo')
        .flatMap(s => navesDe(s.SectorID).filter(n => n.Estado === 'Activo').map(n => ({ s, n })));
}
/** Filtro de sector/nave: solo cuando el contexto es UNA granja. */
function filtroUbicacion() {
    const ids = ctxIds();
    if (ids.length !== 1) return {};
    const s = state.f.sector && sectorById(state.f.sector);
    const n = state.f.nave && naveById(state.f.nave);
    return {
        SectorID: s && s.GranjaID === ids[0] && s.Linea === state.linea ? s.SectorID : undefined,
        NaveID: n && n.GranjaID === ids[0] && n.Linea === state.linea ? n.NaveID : undefined,
    };
}
function registrosPayload(extra = {}) {
    return {
        Linea: state.linea, GranjaIDs: apiGranjas(), ...filtroUbicacion(),
        desde: state.f.desde || undefined, hasta: state.f.hasta || undefined, ...extra,
    };
}
function fechaMinima() { return isAdmin() ? '' : daysAgo(state.db.diasRetroactivos || 7); }
/** El representante edita o elimina solo datos de hasta N días atrás (el servidor lo vuelve a validar). */
function modificable(fecha) { return isAdmin() || String(fecha || '').slice(0, 10) >= fechaMinima(); }
function sinPermisoFecha() {
    const msg = `Solo la administración modifica datos de más de ${state.db.diasRetroactivos} días atrás`;
    return `<span class="icon-btn icon-btn-sm muted" title="${esc(msg)}" aria-label="${esc(msg)}">${ico('lock')}</span>`;
}

// ---------- Campos ----------
const camposDe = linea => state.db.campos[linea] || [];
const camposNumericos = linea => camposDe(linea).filter(c => c.agg);
const camposEntrada = linea => camposDe(linea).filter(c => !c.calc);
const campoDe = (linea, k) => camposDe(linea).find(c => c.k === k);

// ---------- Pesos (gramos ⇄ unidad elegida) ----------
const factorDe = u => UNIDADES[u] || 1;
function enUnidad(g, u = state.unidad) { const n = toNum(g); return n === null ? null : n / factorDe(u); }
function decimalesPeso(u = state.unidad) { return u === 'g' ? 1 : 3; }
function fmtPeso(g, u = state.unidad) {
    const v = enUnidad(g, u);
    return v === null ? '—' : `${new Intl.NumberFormat('es-GT', { maximumFractionDigits: decimalesPeso(u) }).format(v)} ${u}`;
}
function etiquetaCampo(c) { return c.peso ? `${c.l} (${state.unidad})` : c.l; }
/** Valor de un campo para mostrar o graficar (los pesos, en la unidad elegida). */
function valorCampo(c, v) { return c.peso ? enUnidad(v) : v; }

/** Clave de periodo: día AAAA-MM-DD · semana ISO AAAA-Sss · mes AAAA-MM (igual que el servidor). */
function periodo(fecha, agrupar) {
    const dia = String(fecha).slice(0, 10);
    if (agrupar === 'dia') return dia;
    if (agrupar === 'mes') return dia.slice(0, 7);
    const p = dia.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    const wd = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - wd);
    const y = d.getUTCFullYear();
    const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return `${y}-S${String(w).padStart(2, '0')}`;
}
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function periodoLabel(key, agrupar) {
    if (agrupar === 'dia') return fmtDate(key).slice(0, 5) + '/' + key.slice(2, 4);
    if (agrupar === 'mes') return `${MESES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    if (key.startsWith('E')) return `Semana ${Number(key.slice(1))}`;   // semana de edad del lote
    return `Sem. ${rangoSemanaIso(key)}`;
}
/** Semana de calendario ISO "AAAA-Sww" → "13–19 oct" (o "29 sep–5 oct"). */
function rangoSemanaIso(key) {
    const [y, w] = [Number(key.slice(0, 4)), Number(key.slice(6))];
    const ene4 = new Date(Date.UTC(y, 0, 4));
    const lunes = new Date(ene4.getTime() + ((w - 1) * 7 - ((ene4.getUTCDay() || 7) - 1)) * 86400000);
    const domingo = new Date(lunes.getTime() + 6 * 86400000);
    const d = x => `${x.getUTCDate()} ${MESES[x.getUTCMonth()]}`;
    return lunes.getUTCMonth() === domingo.getUTCMonth() ? `${lunes.getUTCDate()}–${d(domingo)}` : `${d(lunes)}–${d(domingo)}`;
}
/** Clave de semana de un registro: semana de edad de su lote ("E023"), o de calendario si el lote no tiene edad. */
function claveSemana(r) {
    const dias = edadDias(loteById(r.LoteID), r.Fecha);
    return dias === null ? periodo(r.Fecha, 'semana') : `E${String(Math.floor(dias / 7)).padStart(3, '0')}`;
}

function aggregate(regs, campos, keyFn) {
    const map = new Map();
    regs.forEach((r) => {
        const k = keyFn(r);
        let g = map.get(k);
        if (!g) { g = { key: k, n: 0, s: {}, c: {} }; map.set(k, g); }
        g.n++;
        campos.forEach((c) => {
            const v = toNum(r[c.k]);
            if (v === null) return;
            g.s[c.k] = (g.s[c.k] || 0) + v;
            g.c[c.k] = (g.c[c.k] || 0) + 1;
        });
    });
    return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
const gAvg = (g, k) => (g?.c[k] ? g.s[k] / g.c[k] : null);
const gSum = (g, k) => (g?.c[k] ? g.s[k] : null);
const gVal = (g, c) => (c.agg === 'suma' ? gSum(g, c.k) : gAvg(g, c.k));
/** Valor agregado listo para mostrar (pesos convertidos, 2–3 decimales). */
function gShow(g, c) {
    const v = gVal(g, c);
    if (v === null) return null;
    return c.peso ? round(enUnidad(v), decimalesPeso()) : round(v);
}
function round(v, d = 2) { return v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d; }

/** Gráficos por línea: [campo, nombre de la serie, color, punteada]. Los pesos usan la unidad elegida. */
const CHARTS_ZOO = [
    { id: 'peso', title: 'Peso corporal', icon: 'scale', type: 'line', peso: true, banda: true, series: [['PesoCorporalReal', 'Peso real (pesaje)', 'primary'], ['PesoCorporalTabla', 'Estándar de la línea genética', 'tabla', true]] },
    { id: 'conversion', title: 'Conversión alimenticia', icon: 'wheat', type: 'line', series: [['ConversionAlimenticia', 'Conversión (kg alimento / kg ganado)', 'primary']] },
    { id: 'mortalidad', title: 'Mortalidad (%)', icon: 'activity', unit: '%', type: 'line', series: [['MortalidadPorcentaje', 'Mortalidad real', 'primary'], ['MortalidadIdeal', 'Ideal', 'tabla', true]] },
    { id: 'consumo', title: 'Consumo de alimento (g/ave/día)', icon: 'wheat', unit: 'g', type: 'area', series: [['ConsumoGramosAveDia', 'Consumo real', 'primary'], ['ConsumoTabla', 'Tabla', 'tabla', true]] },
    { id: 'iec', title: 'Índice de estrés calórico (máx. del día)', icon: 'thermometer', type: 'line', series: [['IndiceEstresCalorico', 'IEC (°C + % HR)', 'primary']] },
    { id: 'muertes', title: 'Mortalidad (aves)', icon: 'bird', type: 'bar', series: [['MortalidadNominal', 'Mortalidad (aves)', 'primary']] },
];
/** Mínimo y máximo de la tabla de la línea genética (los calcula el servidor en cada registro). */
const CAMPOS_BANDA = [{ k: 'PesoTablaMinimo', agg: 'promedio', peso: true }, { k: 'PesoTablaMaximo', agg: 'promedio', peso: true }];
const CHARTS = {
    Reproductora: CHARTS_ZOO,
    Engorde: CHARTS_ZOO,
    Postura: [
        { id: 'postura', title: 'Postura / huevo (%)', icon: 'egg', unit: '%', type: 'area', series: [['PosturaPorcentaje', 'Postura real', 'primary'], ['PosturaTabla', 'Tabla', 'tabla', true]] },
        { id: 'huevo', title: 'Clasificación de huevo', icon: 'chart-column', type: 'bar', stack: true, series: [['HuevoPiwi', 'Piwi', 'o1'], ['HuevoMediano', 'Mediano', 'o2'], ['HuevoGrande', 'Grande', 'o3'], ['HuevoExtragrande', 'Extragrande', 'o4']] },
    ].concat(CHARTS_ZOO),
    Incubadora: [
        { id: 'nacimiento', title: '% de nacimiento', icon: 'egg', unit: '%', type: 'area', series: [['PorcentajeNacimiento', 'Nacimiento ÷ huevo incubable', 'primary']] },
        { id: 'huevos', title: 'Huevos y nacimientos', icon: 'chart-column', type: 'bar', series: [['HuevoIncubable', 'Huevo incubable', 'o1'], ['HuevoTransferencia', 'Huevo de transferencia', 'o3'], ['Nacimiento', 'Nacimiento', 'o4']] },
        { id: 'pesohuevo', title: 'Peso de huevo', icon: 'scale', type: 'line', peso: true, series: [['PesoHuevo', 'Peso promedio (pesaje)', 'primary']] },
        { id: 'mortalidad', title: 'Mortalidad (%)', icon: 'activity', unit: '%', type: 'line', series: [['MortalidadPorcentaje', 'Mortalidad', 'primary']] },
    ],
};
/** Indicador principal de cada línea para el comparativo (real y tabla). */
const COMPARATIVO = {
    Reproductora: ['PesoCorporalReal', 'PesoCorporalTabla', 'Peso corporal'],
    Engorde: ['PesoCorporalReal', 'PesoCorporalTabla', 'Peso corporal'],
    Postura: ['PosturaPorcentaje', 'PosturaTabla', 'Postura (%)'],
    Incubadora: ['PorcentajeNacimiento', null, '% de nacimiento'],
};

/** Nivel del índice de estrés calórico (rangos del servidor). */
function nivelIec(v) {
    const n = toNum(v);
    if (n === null) return null;
    return state.db.iecRangos.find(r => r.hasta === null || n < r.hasta) || state.db.iecRangos[state.db.iecRangos.length - 1];
}
function badgeIec(v, nivel) {
    const r = nivel ? state.db.iecRangos.find(x => x.nivel === nivel) : nivelIec(v);
    if (!r) return '—';
    return `<span class="badge badge-iec iec-${esc(r.color)}">${esc(r.nivel)}</span>`;
}

// ==========================================================================
// 6. TABLAS (ordenar A-Z / Z-A, buscar, CSV) Y GRÁFICOS (PNG)
// ==========================================================================

/**
 * columns: [{ k, l, t: 'text'|'num'|'date'|'datetime', get?(r), html?(r), csv?(r), sticky?, wrap?, nocsv? }]
 */
function table(id, { title, icon = 'table', columns, rows, actions, rowClass, empty = 'No hay datos para mostrar.', csv }) {
    tables[id] = { title, columns, rows, actions, rowClass, empty, csv };
    const n = visibleRows(id).length;
    return `<div class="card table-card">
        <div class="table-tools">
            <h3>${ico(icon)}${esc(title)} <span class="badge badge-muted" id="tcount-${id}">${nf.format(n)}</span></h3>
            <div class="tools">
                <div class="search">${ico('search', 'icon-sm')}<input class="input" type="search" placeholder="Buscar en la tabla" aria-label="Buscar en ${esc(title)}" data-input="table-q" data-table="${id}" value="${esc(state.q[id] || '')}"></div>
                <button type="button" class="btn btn-sm" data-action="csv" data-table="${id}" title="Descargar CSV">${ico('file-spreadsheet')}CSV</button>
            </div>
        </div>
        <div class="table-wrap" id="tw-${id}">${tableInner(id)}</div>
    </div>`;
}

function cellValue(c, r) { return c.get ? c.get(r) : r[c.k]; }
function cellText(c, r) {
    const v = cellValue(c, r);
    if (c.t === 'datetime') return fmtDateTime(v);
    if (c.t === 'date') return fmtDate(v);
    return v ?? '';
}
function compare(c, a, b) {
    const va = cellValue(c, a), vb = cellValue(c, b);
    if (c.t === 'num') return toNum(va) - toNum(vb);
    if (c.t === 'date' || c.t === 'datetime') return String(va).localeCompare(String(vb));
    return String(va).localeCompare(String(vb), 'es', { sensitivity: 'base', numeric: true });
}
function isBlank(c, r) { const v = cellValue(c, r); return v === '' || v === null || v === undefined || (c.t === 'num' && toNum(v) === null); }

function visibleRows(id) {
    const t = tables[id];
    let rows = t.rows;
    const q = norm(state.q[id]);
    if (q) rows = rows.filter(r => t.columns.some(c => norm(cellText(c, r)).includes(q)));
    const s = state.sort[id];
    const c = s && t.columns.find(x => x.k === s.k);
    if (c) {
        const dir = s.dir === 'asc' ? 1 : -1;
        rows = [...rows].sort((a, b) => {
            const ba = isBlank(c, a), bb = isBlank(c, b);
            if (ba || bb) return ba === bb ? 0 : ba ? 1 : -1;   // vacíos siempre al final
            return compare(c, a, b) * dir;
        });
    }
    return rows;
}

function tableInner(id) {
    const t = tables[id];
    const rows = visibleRows(id);
    if (!rows.length) {
        return `<div class="empty"><span class="empty-icon">${ico('inbox')}</span><p>${esc(state.q[id] ? 'Ninguna fila coincide con la búsqueda.' : t.empty)}</p></div>`;
    }
    const s = state.sort[id];
    const head = t.columns.map((c) => {
        const sorted = s?.k === c.k;
        const iconName = !sorted ? 'arrow-up-down' : s.dir === 'asc' ? 'arrow-down-a-z' : 'arrow-down-z-a';
        const aria = sorted ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        const next = sorted && s.dir === 'asc' ? 'Z-A' : 'A-Z';
        return `<th scope="col" class="${c.sticky ? 'sticky-col' : ''}" aria-sort="${aria}"><button type="button" class="th-sort${sorted ? ' is-sorted' : ''}" data-action="sort" data-table="${id}" data-k="${esc(c.k)}" title="Ordenar ${next}">${esc(c.l)}${ico(iconName)}</button></th>`;
    }).join('') + (t.actions ? '<th scope="col" class="actions">Acciones</th>' : '');

    const shown = rows.slice(0, CONFIG.MAX_FILAS_TABLA);
    const body = shown.map((r) => {
        const cells = t.columns.map((c) => {
            const cls = [c.sticky && 'sticky-col', c.t === 'num' && 'num', c.wrap && 'wrap'].filter(Boolean).join(' ');
            const html = c.html ? c.html(r)
                : c.t === 'num' ? fmtNum(cellValue(c, r))
                    : esc(cellText(c, r) === '' ? '—' : cellText(c, r));
            return `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;
        }).join('');
        const act = t.actions ? `<td class="actions"><div class="row">${t.actions(r)}</div></td>` : '';
        const rc = t.rowClass?.(r);
        return `<tr${rc ? ` class="${rc}"` : ''}>${cells}${act}</tr>`;
    }).join('');
    const foot = rows.length > shown.length
        ? `<div class="table-foot">Se muestran ${nf.format(shown.length)} de ${nf.format(rows.length)} filas. El CSV incluye todas.</div>` : '';
    return `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${foot}`;
}

function refreshTable(id) {
    const wrap = $(`#tw-${id}`);
    if (wrap) wrap.innerHTML = tableInner(id);
    const count = $(`#tcount-${id}`);
    if (count) count.textContent = nf.format(visibleRows(id).length);
}

/** CSV con BOM (acentos correctos en Excel) y celdas neutralizadas contra fórmulas. */
function downloadCsv(id) {
    const t = tables[id];
    if (!t) return;
    const cols = t.columns.filter(c => !c.nocsv);
    const rows = visibleRows(id);
    const cell = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
        return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map(c => cell(c.l)).join(',')].concat(
        rows.map(r => cols.map(c => cell(c.csv ? c.csv(r) : cellValue(c, r))).join(',')));
    downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${slug(t.csv || t.title)}_${today()}.csv`);
    toast(`CSV descargado (${nf.format(rows.length)} filas).`, 'success');
}

function chartCard(id, spec) {
    charts[id] = spec;
    return `<div class="card chart-card">
        <div class="card-head"><h3>${ico(spec.icon || 'chart-line')}${esc(spec.title)}</h3>
            <button type="button" class="btn btn-sm" data-action="png" data-chart="${id}" title="Descargar PNG">${ico('image-down')}PNG</button></div>
        <div class="chart-box"><canvas data-chart="${id}"></canvas></div>
    </div>`;
}

function mountCharts() {
    chartUnmounts.forEach(f => f());
    chartUnmounts = $$('canvas[data-chart]').map((cv) => {
        const spec = charts[cv.dataset.chart];
        return spec.type === 'heatmap' ? mountHeatmap(cv, spec) : mountChart(cv, spec);
    });
}

// ==========================================================================
// 7. NAVEGACIÓN Y ESTRUCTURA
// ==========================================================================

const NAV = {
    ADMIN: [['dashboard', 'Dashboard', 'layout-dashboard'], ['registros', 'Registros', 'clipboard-list'],
        ['pesajes', 'Pesajes', 'scale'], ['serologia', 'Serología', 'syringe'], ['ambiente', 'Estrés calórico', 'thermometer'], ['concentrado', 'Concentrado', 'wheat'],
        ['granjas', 'Granjas', 'warehouse'], ['usuarios', 'Usuarios', 'users'], ['listas', 'Listas', 'list'], ['estandares', 'Pesos estándar', 'chart-line'],
        ['bitacora', 'Bitácora', 'history'], ['seguridad', 'Seguridad', 'shield-check']],
    REPRESENTANTE: [['granja', 'Mi granja', 'warehouse'], ['dashboard', 'Dashboard', 'layout-dashboard'],
        ['registros', 'Registros', 'clipboard-list'], ['pesajes', 'Pesajes', 'scale'], ['serologia', 'Serología', 'syringe'], ['ambiente', 'Estrés calórico', 'thermometer'],
        ['concentrado', 'Concentrado', 'wheat'], ['bitacora', 'Bitácora', 'history']],
};
const HOME = { ADMIN: 'dashboard', REPRESENTANTE: 'granja' };
const A = [ROLES.ADMIN], ALL = [ROLES.ADMIN, ROLES.REPRESENTANTE];
const VIEWS = {
    dashboard: { roles: ALL, title: 'Dashboard', render: viewDashboard },
    registros: { roles: ALL, title: 'Registros diarios', render: viewRegistros },
    pesajes: { roles: ALL, title: 'Pesajes por muestra', render: viewPesajes },
    serologia: { roles: ALL, title: 'Serología por lote', render: viewSerologia },
    ambiente: { roles: ALL, title: 'Estrés calórico', render: viewAmbiente },
    concentrado: { roles: ALL, title: 'Compras de concentrado', render: viewConcentrado },
    estandares: { roles: A, title: 'Pesos estándar por línea genética', render: viewEstandares },
    granja: { roles: ALL, title: 'Granja', render: viewGranja },
    granjas: { roles: A, title: 'Granjas', render: viewGranjas },
    usuarios: { roles: A, title: 'Usuarios', render: viewUsuarios },
    listas: { roles: A, title: 'Listas desplegables', render: viewListas },
    bitacora: { roles: ALL, title: 'Bitácora de cambios', render: viewBitacora },
    seguridad: { roles: A, title: 'Seguridad', render: viewSeguridad },
};

function parseHash() {
    const [view, param] = location.hash.replace(/^#\/?/, '').split('/');
    return { view: view || '', param: param ? decodeURIComponent(param) : null };
}
function go(view, param = null) {
    const h = `#/${view}${param ? '/' + encodeURIComponent(param) : ''}`;
    if (location.hash === h) render(); else location.hash = h;
}

function render() {
    if (!state.me || $('#screen-app').hidden) return;
    const { view, param } = parseHash();
    const v = VIEWS[view];
    if (!v || !v.roles.includes(state.me.Rol)) { go(HOME[state.me.Rol]); return; }
    Object.keys(tables).forEach(k => delete tables[k]);
    Object.keys(charts).forEach(k => delete charts[k]);
    $('#page-title').textContent = view === 'granja' && !isAdmin() ? 'Mi granja' : v.title;
    document.title = `${$('#page-title').textContent} · Granjas`;
    $$('#nav a').forEach(a => a.classList.toggle('is-active', a.dataset.view === view || (view === 'granja' && a.dataset.view === 'granjas')));
    $('#view').innerHTML = v.render(param);
    mountCharts();
}

function renderChrome() {
    $('#nav').innerHTML = NAV[state.me.Rol].map(([view, label, icon]) =>
        `<a href="#/${view}" data-view="${view}">${ico(icon)}<span>${esc(label)}</span></a>`).join('');
    $('#user-chip').innerHTML = `<span class="avatar" aria-hidden="true">${esc(initials(state.me.Nombre))}</span>
        <span class="user-chip-text"><strong>${esc(state.me.Nombre)}</strong><span>${esc(ROLE_LABEL[state.me.Rol] || state.me.Rol)}</span></span>`;
}

function showScreen(name) {
    ['loading', 'login', 'denied', 'password', 'app'].forEach(s => { $(`#screen-${s}`).hidden = s !== name; });
    if (name !== 'app') closeModal();
}

// Menú: en computadora la hamburguesa oculta/muestra la barra lateral; en celular arranca oculta.
const mqMobile = matchMedia('(max-width: 959px)');
function sidebarVisible() {
    const shell = $('#screen-app');
    return mqMobile.matches ? shell.classList.contains('sidebar-open') : !shell.classList.contains('sidebar-collapsed');
}
function syncMenuButton() { $('#menu-btn').setAttribute('aria-expanded', String(sidebarVisible())); }
function toggleSidebar(force) {
    const shell = $('#screen-app');
    if (mqMobile.matches) {
        shell.classList.toggle('sidebar-open', force ?? !shell.classList.contains('sidebar-open'));
    } else {
        const collapsed = force === undefined ? !shell.classList.contains('sidebar-collapsed') : !force;
        shell.classList.toggle('sidebar-collapsed', collapsed);
        try { localStorage.setItem('granjas.menu', collapsed ? 'oculto' : 'visible'); } catch { /* sin almacenamiento */ }
    }
    syncMenuButton();
}
(function initSidebar() {
    let pref = 'visible';
    try { pref = localStorage.getItem('granjas.menu') || 'visible'; } catch { /* sin almacenamiento */ }
    $('#screen-app').classList.toggle('sidebar-collapsed', pref === 'oculto');
    mqMobile.addEventListener('change', () => { $('#screen-app').classList.remove('sidebar-open'); syncMenuButton(); });
    syncMenuButton();
})();

// ----------------------------------------------------------------------------
// Componentes de filtros
// ----------------------------------------------------------------------------

/** Representante: SOLO sus granjas, una a la vez (cada granja se trabaja por separado). */
function granjaSwitch() {
    const gs = state.db.granjas;
    if (gs.length <= 1) {
        return `<div class="filter-group"><span class="field-label">Granja</span><span class="badge">${ico('warehouse', 'icon-sm')}${esc(gs[0]?.NombreGranja || '—')}</span></div>`;
    }
    return `<label class="field"><span>Granja</span><select data-change="granja-activa">${gs.map(g =>
        `<option value="${esc(g.GranjaID)}"${g.GranjaID === state.granjaId ? ' selected' : ''}>${esc(g.NombreGranja)}</option>`).join('')}</select></label>`;
}

/** Administrador: todas las granjas o las que elija. */
function granjaPicker() {
    const sel = state.f.granjas;
    const label = !sel.length ? 'Todas las granjas' : sel.length === 1 ? granjaName(sel[0]) : `${sel.length} granjas`;
    return `<div class="filter-group"><span class="field-label">Granjas</span>
        <details class="dropdown"${state.ddOpen ? ' open' : ''}>
            <summary>${ico('filter', 'icon-sm')}<span>${esc(label)}</span>${ico('chevron-down', 'icon-sm')}</summary>
            <div class="dropdown-panel">
                <label class="check"><input type="checkbox" data-change="f-granja-all"${!sel.length ? ' checked' : ''}> Todas las granjas</label>
                ${state.db.granjas.map(g => `<label class="check"><input type="checkbox" data-change="f-granja" value="${esc(g.GranjaID)}"${sel.includes(g.GranjaID) ? ' checked' : ''}> ${esc(g.NombreGranja)}${g.Estado !== 'Activo' ? ' <span class="badge badge-warn">Suspendida</span>' : ''}</label>`).join('')}
            </div>
        </details></div>`;
}

/** Solo aparecen las líneas que la granja tiene (las demás no se muestran). */
function lineaTabs(disp) {
    return `<div class="filter-group"><span class="field-label">Línea</span><div class="segmented${disp.length > 2 ? ' seg-lineas' : ''}" role="group" aria-label="Línea de producción">${disp.map(l =>
        `<button type="button" class="seg${l === state.linea ? ' is-active' : ''}" data-action="set-linea" data-linea="${l}" aria-pressed="${l === state.linea}">${ico(LINEA_ICON[l])}${l}</button>`).join('')}</div></div>`;
}

/** Sector y nave: solo con UNA granja en contexto. Incluye los inactivos (para ver su historial). */
function ubicacionFilters() {
    const ids = ctxIds();
    if (ids.length !== 1) return '';
    const secs = sectoresDe(ids[0], state.linea);
    if (!secs.length) return '';
    if (state.f.sector && !secs.some(s => s.SectorID === state.f.sector)) state.f.sector = '';
    const naves = (state.f.sector ? [sectorById(state.f.sector)] : secs).flatMap(s => navesDe(s.SectorID).map(n => ({ s, n })));
    if (state.f.nave && !naves.some(x => x.n.NaveID === state.f.nave)) state.f.nave = '';
    const inactivo = x => (x.Estado !== 'Activo' ? ' (inactiva)' : '');
    return `<label class="field"><span>Sector</span><select data-change="f-sector"><option value="">Todos</option>${secs.map(s =>
        `<option value="${esc(s.SectorID)}"${s.SectorID === state.f.sector ? ' selected' : ''}>${esc(s.Nombre)}${s.Estado !== 'Activo' ? ' (inactivo)' : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Nave</span><select data-change="f-nave"><option value="">Todas</option>${naves.map(({ s, n }) =>
        `<option value="${esc(n.NaveID)}"${n.NaveID === state.f.nave ? ' selected' : ''}>${state.f.sector ? '' : esc(s.Nombre) + ' / '}${esc(n.Nombre)}${inactivo(n)}</option>`).join('')}</select></label>`;
}

function unidadToggle() {
    return `<div class="filter-group"><span class="field-label">Ver pesos en</span><div class="segmented" role="group" aria-label="Unidad de peso">${Object.keys(UNIDADES).map(u =>
        `<button type="button" class="seg${u === state.unidad ? ' is-active' : ''}" data-action="set-unidad" data-unidad="${u}" aria-pressed="${u === state.unidad}" title="${UNIDAD_NOMBRE[u]}">${u}</button>`).join('')}</div></div>`;
}

function dateFilters() {
    return `<div class="date-range"><label class="field"><span>Desde</span><input type="date" data-change="f-desde" value="${esc(state.f.desde)}"${state.f.hasta ? ` max="${esc(state.f.hasta)}"` : ''}></label>
        <label class="field"><span>Hasta</span><input type="date" data-change="f-hasta" value="${esc(state.f.hasta)}"${state.f.desde ? ` min="${esc(state.f.desde)}"` : ''}></label></div>
        <div class="filter-group"><span class="field-label">Rango rápido</span><div class="presets">${PRESETS.map(([d, l]) =>
        `<button type="button" class="btn btn-sm" data-action="preset" data-days="${d}">${l}</button>`).join('')}</div></div>`;
}

function filtersCard({ lineas = true, fechas = true, agrupar = false, eliminados = false, ubicacion = true, unidad = false, extra = '' } = {}) {
    const disp = lineas ? ensureLinea(ctxIds()) : [];
    return `<div class="card filters-card"><div class="filters">
        ${isAdmin() ? granjaPicker() : granjaSwitch()}
        ${lineas ? lineaTabs(disp) : ''}
        ${lineas && ubicacion ? ubicacionFilters() : ''}
        ${extra}
        ${fechas ? dateFilters() : ''}
        ${agrupar ? `<div class="filter-group"><span class="field-label">Agrupar por</span><div class="segmented" role="group" aria-label="Agrupar por">${AGRUPAR.map(([k, l]) =>
        `<button type="button" class="seg${state.f.agrupar === k ? ' is-active' : ''}" data-action="set-agrupar" data-agrupar="${k}" aria-pressed="${state.f.agrupar === k}">${l}</button>`).join('')}</div></div>` : ''}
        ${unidad ? unidadToggle() : ''}
        ${eliminados && isAdmin() ? `<label class="check"><input type="checkbox" data-change="f-eliminados"${state.f.eliminados ? ' checked' : ''}> Incluir eliminados</label>` : ''}
    </div></div>`;
}

function noGranjas() {
    return isAdmin()
        ? emptyState('Aún no hay granjas registradas.', 'warehouse', `<button type="button" class="btn btn-primary" data-action="new-granja">${ico('plus')}Nueva granja</button>`)
        : emptyState('No tienes granjas asignadas. Contacta a la administración.', 'warehouse');
}

function sinLineas() {
    return emptyState(isAdmin()
        ? 'Las granjas seleccionadas aún no tienen ninguna línea de producción (ficha) activa.'
        : 'Tu granja aún no tiene líneas de producción activas. Contacta a la administración.', 'clipboard-list');
}

/** Aviso cuando no hay dónde ingresar datos (sin sectores, naves activas o lotes). */
function sinEstructura(linea) {
    const ids = ctxIds();
    const hay = ids.some(id => navesActivas(id, linea).some(({ n }) => loteActivo(n.NaveID)));
    if (hay) return '';
    const destino = ids.length === 1 ? `<button type="button" class="btn btn-sm" data-action="open-granja" data-id="${esc(ids[0])}">${ico('layout-grid')}Ir a sectores y naves</button>` : '';
    return `<div class="alert alert-info">${ico('info')}<span>Para ingresar datos de ${esc(linea.toLowerCase())} se necesita al menos un sector, una nave activa y un lote iniciado.</span>${destino}</div>`;
}

// ==========================================================================
// 8. VISTAS: DASHBOARD, REGISTROS, PESAJES Y AMBIENTE
// ==========================================================================

/** Columna de tabla para un campo de registro (los pesos, en la unidad elegida). */
function colCampo(c) {
    return {
        k: c.k, l: etiquetaCampo(c), t: c.agg ? 'num' : 'text', wrap: c.t === 'textoLargo',
        get: c.peso ? (r => enUnidad(r[c.k])) : undefined,
    };
}
const COLS_UBICACION = [{ k: 'Sector', l: 'Sector' }, { k: 'Nave', l: 'Nave' }, { k: 'NumeroLote', l: 'Lote' }];
function colsGranja() { return isAdmin() ? [{ k: 'GranjaID', l: 'Granja', get: x => granjaName(x.GranjaID) }] : []; }

function viewDashboard() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ agrupar: true, unidad: true });
    if (!lineasDisponibles(ids).length) return head + sinLineas();

    const r = need('getRegistros', registrosPayload());
    if (!r) return head + `<div class="kpis">${loadingBlock(1)}</div><div class="grid-2">${loadingBlock(2)}</div>`;
    if (!r.ok) return head + errorBlock(r);

    const linea = state.linea;
    const regs = r.data.registros;
    const campos = camposNumericos(linea);
    const agr = state.f.agrupar;
    const rango = state.f.desde || state.f.hasta ? `${fmtDate(state.f.desde) || 'inicio'} a ${fmtDate(state.f.hasta) || 'hoy'}` : 'Todo el historial';
    const ub = filtroUbicacion();
    const contexto = [isAdmin() ? (state.f.granjas.length ? state.f.granjas.map(granjaName).join(', ') : 'Todas las granjas') : granjaName(state.granjaId),
        ub.SectorID && sectorById(ub.SectorID)?.Nombre, ub.NaveID && naveById(ub.NaveID)?.Nombre].filter(Boolean).join(' · ');

    let html = head;
    if (r.data.truncado) html += alertBox('warn', 'alert-triangle', 'Hay más registros de los que se pueden analizar a la vez. Reduce el rango de fechas para ver todo.');
    if (!regs.length) return html + sinEstructura(linea) + emptyState(`No hay registros de ${linea.toLowerCase()} en el rango seleccionado.`, 'chart-line');

    // KPIs del rango completo
    const tot = aggregate(regs, campos, () => 'total')[0];
    const ultimo = new Map();
    regs.forEach((x) => { const k = x.NaveID || x.GranjaID; if (!ultimo.has(k)) ultimo.set(k, toNum(x.NumeroAves)); });   // de más reciente a más antiguo
    const aves = [...ultimo.values()].reduce((a, v) => a + (v || 0), 0);
    const pc = k => campoDe(linea, k);
    let k = kpi('Registros', nf.format(regs.length), rango, 'clipboard-list') + kpi('Aves', nf.format(aves), 'Último registro de cada nave', 'bird');
    if (linea === 'Incubadora') {
        const inc = gSum(tot, 'HuevoIncubable'), nac = gSum(tot, 'Nacimiento');
        k += kpi('Huevo incubable', fmtNum(inc), `Transferencia ${fmtNum(gSum(tot, 'HuevoTransferencia'))}`, 'egg')
            + kpi('Nacimiento', fmtNum(nac), inc ? `${fmtNum(round(nac / inc * 100))} % del incubable` : '', 'trending-up')
            + kpi('Peso de huevo', fmtPeso(gAvg(tot, 'PesoHuevo')), 'Promedio de los pesajes', 'scale');
    } else {
        k += kpi('Mortalidad', fmtNum(gSum(tot, 'MortalidadNominal')), `Promedio ${fmtNum(gAvg(tot, 'MortalidadPorcentaje'))} %`, 'activity')
            + kpi('Consumo', `${fmtNum(gSum(tot, 'ConsumoQuintalesTotal'))} qq`, `${fmtNum(gAvg(tot, 'ConsumoGramosAveDia'))} g/ave/día`, 'wheat')
            + kpi('Peso corporal', fmtPeso(gAvg(tot, 'PesoCorporalReal')), `Tabla ${fmtPeso(gAvg(tot, 'PesoCorporalTabla'))}`, 'scale')
            + kpi('Conversión', fmtNum(gAvg(tot, 'ConversionAlimenticia')), 'kg alimento / kg ganado', 'wheat');
        if (linea === 'Postura') k += kpi('Postura', `${fmtNum(gAvg(tot, 'PosturaPorcentaje'))} %`, `Tabla ${fmtNum(gAvg(tot, 'PosturaTabla'))}`, 'egg');
    }
    html += `<div class="kpis">${k}</div>`;

    // Panorama (como un tablero de Power BI): medidor, dona y comparativo horizontal.
    html += panorama(linea, regs, campos, tot, rango);

    // Tendencias por periodo
    // Por semana: semana de EDAD del lote ("Semana 23"); día y mes, de calendario.
    const grupos = aggregate(regs, campos.concat(CAMPOS_BANDA), x => (agr === 'semana' ? claveSemana(x) : periodo(x.Fecha, agr)));
    const labels = grupos.map(g => periodoLabel(g.key, agr));
    const sub = `${contexto} · ${rango} · por ${AGRUPAR.find(a => a[0] === agr)[1].toLowerCase()}`;
    html += '<div class="grid-2">' + CHARTS[linea].map((def) => {
        const spec = {
            title: def.peso ? `${def.title} (${state.unidad})` : def.title, subtitle: sub, icon: def.icon, type: def.type,
            unit: def.peso ? state.unidad : def.unit, labels,
            series: def.series.map(([key, name, color, dashed]) => ({
                name, color: PALETTE[color], dashed, stack: def.stack ? 'h' : undefined,
                data: grupos.map(g => { const c = pc(key); return c ? gShow(g, c) : null; }),
            })),
        };
        // Banda mín–máx de la tabla de la línea genética (solo si hay datos).
        if (def.banda) {
            const lo = grupos.map(g => gShow(g, CAMPOS_BANDA[0])), hi = grupos.map(g => gShow(g, CAMPOS_BANDA[1]));
            if (lo.some(v => v !== null)) spec.band = { name: 'Rango de la tabla', lo, hi, color: PALETTE.tabla };
        }
        return chartCard(`${linea}-${def.id}`, spec);
    }).join('') + '</div>';

    // Comparativo: por granja (admin con varias) o por nave (una granja), en tabla.
    const varias = isAdmin() && new Set(regs.map(x => x.GranjaID)).size > 1;
    const porNave = !varias && new Set(regs.map(x => x.NaveID).filter(Boolean)).size > 1;
    if (varias || porNave) {
        const clave = varias ? (x => x.GranjaID) : (x => x.NaveID || '—');
        const nombre = varias ? granjaName : nombreNave;
        const grupo = aggregate(regs, campos, clave);
        html += table('comparativo', {
            title: `Comparativo por ${varias ? 'granja' : 'nave'}`, icon: varias ? 'warehouse' : 'house', csv: `comparativo-${linea}`,
            columns: [{ k: 'nombre', l: varias ? 'Granja' : 'Nave', sticky: true }, { k: 'n', l: 'Registros', t: 'num' }]
                .concat(campos.map(c => ({ k: c.k, l: `${etiquetaCampo(c)}${c.agg === 'suma' ? ' (total)' : ' (prom.)'}`, t: 'num' }))),
            rows: grupo.map(g => Object.assign({ nombre: nombre(g.key), n: g.n }, ...campos.map(c => ({ [c.k]: gShow(g, c) })))),
        });
    }

    // Resumen por periodo
    html += table('resumen', {
        title: `Resumen por ${AGRUPAR.find(a => a[0] === agr)[1].toLowerCase()}`, icon: 'calendar-range', csv: `resumen-${linea}-${agr}`,
        columns: [{ k: 'key', l: 'Periodo', sticky: true, html: x => esc(periodoLabel(x.key, agr)), csv: x => x.key }, { k: 'n', l: 'Registros', t: 'num' }]
            .concat(campos.map(c => ({ k: c.k, l: `${etiquetaCampo(c)}${c.agg === 'suma' ? ' (total)' : ' (prom.)'}`, t: 'num' }))),
        rows: grupos.map(g => Object.assign({ key: g.key, n: g.n }, ...campos.map(c => ({ [c.k]: gShow(g, c) })))),
    });
    return html;
}

function nombreNave(id) {
    const n = naveById(id);
    return n ? `${sectorById(n.SectorID)?.Nombre || ''} / ${n.Nombre}` : '—';
}

/**
 * Fila de panorama: un medidor con el indicador principal de la línea, una dona (partes de un
 * total) y barras horizontales que comparan granjas (admin con varias) o naves (una granja).
 * Cada gráfico mide UNA sola cosa (sin mezclar unidades en un mismo eje).
 */
function panorama(linea, regs, campos, tot, rango) {
    const pc = k => campoDe(linea, k);
    const tarjetas = [];

    // 1. Medidor
    let g;
    if (linea === 'Postura') {
        const tabla = gAvg(tot, 'PosturaTabla');
        g = { title: 'Postura promedio', value: round(gAvg(tot, 'PosturaPorcentaje'), 1), max: 100, unit: '%', target: tabla !== null && tabla <= 100 ? round(tabla, 1) : null, targetLabel: 'Tabla', caption: rango };
    } else if (linea === 'Incubadora') {
        const inc = gSum(tot, 'HuevoIncubable'), nac = gSum(tot, 'Nacimiento');
        g = { title: 'Nacimiento sobre huevo incubable', value: inc ? round(nac / inc * 100, 1) : null, max: 100, unit: '%', caption: rango };
    } else {
        const v = gAvg(tot, 'PesoCorporalIdealPorcentaje');
        g = { title: 'Peso corporal frente a la tabla', value: round(v, 1), max: Math.max(120, Math.ceil(((v || 0) * 1.1) / 10) * 10), unit: '%', target: 100, targetLabel: 'Meta (100 % de la tabla)', caption: rango };
    }
    tarjetas.push(chartCard(`${linea}-medidor`, { type: 'gauge', icon: 'activity', subtitle: rango, ...g }));

    // 2. Dona
    let d;
    if (linea === 'Postura') {
        const k = ['HuevoPiwi', 'HuevoMediano', 'HuevoGrande', 'HuevoExtragrande'];
        d = { title: 'Clasificación de huevo', labels: ['Piwi', 'Mediano', 'Grande', 'Extragrande'], values: k.map(x => gSum(tot, x) || 0), colors: [PALETTE.o1, PALETTE.o2, PALETTE.o3, PALETTE.o4], centerLabel: 'huevos' };
    } else if (linea === 'Incubadora') {
        const inc = gSum(tot, 'HuevoIncubable') || 0, nac = gSum(tot, 'Nacimiento') || 0;
        d = { title: 'Huevo incubable: nacidos y no nacidos', labels: ['Nacimiento', 'No nacidos'], values: [nac, Math.max(0, inc - nac)], colors: [PALETTE.primary, PALETTE.tabla], centerLabel: 'huevos incubables' };
    } else {
        // Aves actuales por nave (o por granja): último registro de cada una.
        const porGranja = isAdmin() && new Set(regs.map(x => x.GranjaID)).size > 1;
        const ult = new Map();
        regs.forEach((x) => { const k = porGranja ? `${x.GranjaID}|${x.NaveID}` : x.NaveID || x.GranjaID; if (!ult.has(k)) ult.set(k, { x, v: toNum(x.NumeroAves) || 0 }); });
        const suma = new Map();
        ult.forEach(({ x, v }) => { const k = porGranja ? granjaName(x.GranjaID) : nombreNave(x.NaveID); suma.set(k, (suma.get(k) || 0) + v); });
        let filas = [...suma.entries()].sort((a, b) => b[1] - a[1]);
        if (filas.length > 6) filas = filas.slice(0, 5).concat([['Otras', filas.slice(5).reduce((a, f) => a + f[1], 0)]]);
        d = { title: `Aves por ${porGranja ? 'granja' : 'nave'} (último registro)`, labels: filas.map(f => f[0]), values: filas.map(f => f[1]),
            colors: filas.map((f, i) => (f[0] === 'Otras' ? PALETTE.tabla : PALETTE.cat[i])), centerLabel: 'aves' };
    }
    tarjetas.push(chartCard(`${linea}-dona`, { type: 'donut', icon: 'chart-column', subtitle: rango, ...d }));

    // 3. Comparativo horizontal (solo si hay más de una granja o nave)
    const varias = isAdmin() && new Set(regs.map(x => x.GranjaID)).size > 1;
    const porNave = !varias && new Set(regs.map(x => x.NaveID).filter(Boolean)).size > 1;
    if (varias || porNave) {
        const [real, tabla, titulo] = COMPARATIVO[linea];
        const cReal = pc(real), cTabla = tabla && pc(tabla);
        const grupo = aggregate(regs, campos, varias ? (x => x.GranjaID) : (x => x.NaveID || '—'))
            .map(gr => ({ nombre: varias ? granjaName(gr.key) : nombreNave(gr.key), v: gShow(gr, cReal), t: cTabla ? gShow(gr, cTabla) : null }))
            .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
        const unidad = cReal.peso ? state.unidad : linea === 'Postura' || linea === 'Incubadora' ? '%' : '';
        tarjetas.push(chartCard(`${linea}-comparativo`, {
            type: 'hbar', title: `${titulo} por ${varias ? 'granja' : 'nave'}`, subtitle: rango, icon: varias ? 'warehouse' : 'house',
            labels: grupo.map(x => x.nombre), values: grupo.map(x => x.v), unit: unidad,
            target: cTabla ? grupo.map(x => x.t) : null, valueName: 'Real (promedio)', targetName: 'Tabla (promedio)',
        }));
    }
    return `<div class="grid-3 panorama">${tarjetas.join('')}</div>`;
}

function viewRegistros() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ eliminados: true, unidad: true });
    if (!lineasDisponibles(ids).length) return head + sinLineas();

    const linea = state.linea;
    const aviso = sinEstructura(linea);
    const nuevo = aviso || `<div class="row row-center"><button type="button" class="btn btn-primary" data-action="new-registro">${ico('plus')}Nuevo registro de ${linea.toLowerCase()}</button></div>`;
    const r = need('getRegistros', registrosPayload({ incluirEliminados: isAdmin() && state.f.eliminados ? true : undefined }));
    if (!r) return head + nuevo + loadingBlock(1);
    if (!r.ok) return head + nuevo + errorBlock(r);

    state.registros = new Map(r.data.registros.map(x => [x.RegistroID, x]));
    const columns = [{ k: 'Fecha', l: 'Fecha', t: 'date', sticky: true }]
        .concat(colsGranja(), COLS_UBICACION, [{ k: 'LineaGenetica', l: 'Línea genética' }])
        .concat(camposDe(linea).map(c => (c.k !== 'PesoCorporalTabla' ? colCampo(c) : {
            // Peso tabla: de la línea genética; "manual" si es un valor escrito antes de esta versión.
            ...colCampo(c), csv: x => enUnidad(x.PesoCorporalTabla),
            html: x => `${fmtNum(round(enUnidad(x.PesoCorporalTabla), decimalesPeso()))}${x.PesoCorporalTablaOrigen === 'Manual' ? ' <span class="badge badge-muted" title="Escrito a mano antes de usar la tabla de la línea genética">manual</span>' : ''}`,
        })))
        .concat(isAdmin() && state.f.eliminados ? [{ k: 'Estado', l: 'Estado', html: x => badgeEstado(x.Estado === 'Activo' ? 'Activo' : 'Eliminado') }] : [])
        .concat([{ k: 'CreadoPor', l: 'Registrado por' }, { k: 'ActualizadoEn', l: 'Última edición', t: 'datetime' }]);

    let html = head + nuevo;
    if (r.data.truncado) html += alertBox('warn', 'alert-triangle', `Se muestran los ${nf.format(r.data.registros.length)} registros más recientes de ${nf.format(r.data.total)}. Reduce el rango de fechas para ver los demás.`);
    html += table('registros', {
        title: `Registros de ${linea.toLowerCase()}`, icon: LINEA_ICON[linea], csv: `registros-${linea}`,
        empty: `No hay registros de ${linea.toLowerCase()} en el rango seleccionado.`,
        columns, rows: r.data.registros,
        rowClass: x => (x.Estado !== 'Activo' ? 'is-deleted' : ''),
        actions: (x) => {
            const flag = x.Alterado ? `<span class="badge badge-danger" title="Modificado fuera de la plataforma">${ico('lock', 'icon-sm')}</span>` : '';
            if (x.Estado !== 'Activo') {
                return flag + (isAdmin() ? `<button type="button" class="icon-btn icon-btn-sm" data-action="restore-registro" data-id="${esc(x.RegistroID)}" title="Restaurar" aria-label="Restaurar registro">${ico('rotate-ccw')}</button>` : '');
            }
            if (!modificable(x.Fecha)) return flag + sinPermisoFecha();
            return flag + `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-registro" data-id="${esc(x.RegistroID)}" title="Editar" aria-label="Editar registro">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-registro" data-id="${esc(x.RegistroID)}" title="Eliminar" aria-label="Eliminar registro">${ico('trash')}</button>`;
        },
    });
    return html;
}

function viewPesajes() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ unidad: true, eliminados: true });
    if (!lineasDisponibles(ids).length) return head + sinLineas();
    const linea = state.linea;
    const tipo = linea === 'Incubadora' ? 'huevo' : 'ave';
    const aviso = sinEstructura(linea);
    const nuevo = aviso || `<div class="section-head"><p class="muted">Se elige la nave, la unidad y el tamaño de la muestra, y se pesa ${tipo === 'huevo' ? 'cada huevo' : 'cada ave'} por separado. El promedio pasa al registro de ese día.</p>
        <button type="button" class="btn btn-primary" data-action="new-pesaje">${ico('scale')}Nuevo pesaje</button></div>`;
    const r = need('getPesajes', registrosPayload({ incluirEliminados: isAdmin() && state.f.eliminados ? true : undefined }));
    if (!r) return head + nuevo + loadingBlock(1);
    if (!r.ok) return head + nuevo + errorBlock(r);

    state.pesajes = new Map(r.data.pesajes.map(x => [x.PesajeID, x]));
    const pesoCol = (k, l) => ({ k, l: `${l} (${state.unidad})`, t: 'num', get: x => round(enUnidad(x[k]), decimalesPeso()) });
    const columns = [{ k: 'Fecha', l: 'Fecha', t: 'date', sticky: true }]
        .concat(colsGranja(), COLS_UBICACION, [
            { k: 'Muestra', l: 'Muestra', t: 'num' },
            pesoCol('PromedioG', 'Promedio'), pesoCol('MinimoG', 'Mínimo'), pesoCol('MaximoG', 'Máximo'),
            { k: 'CV', l: 'CV (%)', t: 'num' }, { k: 'Uniformidad', l: 'Uniformidad (%)', t: 'num' },
        ])
        .concat(linea === 'Incubadora' ? [] : [
            // Comparación con la curva de la línea genética a la edad de las aves.
            { k: 'SemanaEdad', l: 'Semana de edad', t: 'num' },
            pesoCol('EsperadoG', 'Esperado'),
            { k: 'DiferenciaG', l: `Diferencia (${state.unidad})`, t: 'num', get: x => round(enUnidad(x.DiferenciaG), decimalesPeso()) },
            { k: 'DiferenciaPct', l: 'Diferencia (%)', t: 'num' },
            { k: 'EstadoPeso', l: 'Contra la tabla', html: x => badgeEstadoPeso(x.EstadoPeso) },
            { k: 'ConversionAlimenticia', l: 'Conversión alimenticia', t: 'num' },
        ])
        .concat([{ k: 'Unidad', l: 'Capturado en' }, { k: 'Pesos', l: 'Pesos individuales', nocsv: false, wrap: true, html: x => `<span class="muted">${esc(String(x.Pesos || '').split(',').length)} pesos</span>` },
            { k: 'CreadoPor', l: 'Registrado por' }])
        .concat(isAdmin() && state.f.eliminados ? [{ k: 'Estado', l: 'Estado', html: x => badgeEstado(x.Estado === 'Activo' ? 'Activo' : 'Eliminado') }] : []);

    return head + nuevo + table('pesajes', {
        title: `Pesajes de ${linea.toLowerCase()}`, icon: 'scale', csv: `pesajes-${linea}`,
        empty: 'No hay pesajes en el rango seleccionado.', columns, rows: r.data.pesajes,
        rowClass: x => (x.Estado !== 'Activo' ? 'is-deleted' : ''),
        actions: x => `<button type="button" class="icon-btn icon-btn-sm" data-action="ver-pesaje" data-id="${esc(x.PesajeID)}" title="Ver los pesos" aria-label="Ver los pesos">${ico('list-checks')}</button>`
            + (x.Estado === 'Activo' && !modificable(x.Fecha) ? sinPermisoFecha() : '')
            + (x.Estado === 'Activo' && modificable(x.Fecha) ? `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-pesaje" data-id="${esc(x.PesajeID)}" title="Editar" aria-label="Editar pesaje">${ico('pencil')}</button>
               <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-pesaje" data-id="${esc(x.PesajeID)}" title="Eliminar" aria-label="Eliminar pesaje">${ico('trash')}</button>` : ''),
    });
}

function viewAmbiente() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard();
    if (!lineasDisponibles(ids).length) return head + sinLineas();
    const linea = state.linea;
    const hayNaves = ids.some(id => navesActivas(id, linea).length);
    const acciones = hayNaves
        ? `<div class="section-head"><p class="muted">Índice de estrés calórico (IEC) = temperatura ambiente en °C + humedad relativa en %. Cada lectura queda guardada con su fecha y hora.</p>
            <button type="button" class="btn btn-primary" data-action="new-lectura">${ico('thermometer')}Nueva lectura</button></div>`
        : `<div class="alert alert-info">${ico('info')}<span>Para registrar lecturas se necesita al menos una nave activa de ${esc(linea.toLowerCase())}.</span></div>`;
    const leyenda = `<div class="card"><div class="card-head card-title-center"><h3>${ico('thermometer')}Escala del índice de estrés calórico</h3></div>
        <div class="iec-scale">${state.db.iecRangos.map((x, i) => {
        const prev = state.db.iecRangos[i - 1];
        const rango = !prev ? `Menor a ${x.hasta}` : x.hasta === null ? `Mayor a ${Math.floor(prev.hasta)}` : `${prev.hasta} a ${Math.floor(x.hasta)}`;
        return `<div class="iec-item iec-${esc(x.color)}"><strong>${esc(rango)}</strong><span class="iec-desc">${esc(x.descripcion)}</span><span class="muted">${esc(x.comportamiento)}</span></div>`;
    }).join('')}</div></div>`;
    const payload = { Linea: linea, GranjaIDs: apiGranjas(), ...filtroUbicacion(), desde: state.f.desde || undefined, hasta: state.f.hasta || undefined };
    const r = need('getAmbiente', payload);
    if (!r) return head + acciones + leyenda + loadingBlock(1);
    if (!r.ok) return head + acciones + leyenda + errorBlock(r);

    const lecturas = r.data.lecturas;
    state.lecturas = new Map(lecturas.map(x => [x.LecturaID, x]));
    return head + acciones + chartCard(`iec-${linea}`, heatmapSpec(lecturas)) + leyenda + table('lecturas', {
        title: 'Lecturas de temperatura y humedad', icon: 'thermometer', csv: `ambiente-${linea}`,
        empty: 'No hay lecturas en el rango seleccionado.',
        columns: [{ k: 'FechaHora', l: 'Fecha y hora', t: 'datetime', sticky: true }]
            .concat(colsGranja(), [{ k: 'Sector', l: 'Sector' }, { k: 'Nave', l: 'Nave' },
                { k: 'Temperatura', l: 'Temperatura (°C)', t: 'num' }, { k: 'Humedad', l: 'Humedad relativa (%)', t: 'num' },
                { k: 'Indice', l: 'IEC', t: 'num' }, { k: 'Nivel', l: 'Nivel', html: x => badgeIec(x.Indice, x.Nivel) },
                { k: 'CreadoPor', l: 'Registrado por' }]),
        rows: lecturas,
        actions: x => (!modificable(x.FechaHora) ? sinPermisoFecha() : `<button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-lectura" data-id="${esc(x.LecturaID)}" title="Eliminar" aria-label="Eliminar lectura">${ico('trash')}</button>`),
    });
}

/** Mapa de calor: filas = naves, columnas = días (o semanas si el rango es largo); celda = IEC máximo. */
function heatmapSpec(lecturas) {
    const dias = lecturas.map(x => String(x.FechaHora).slice(0, 10));
    const desde = state.f.desde || (dias.length ? dias.reduce((a, b) => (a < b ? a : b)) : today());
    const hasta = state.f.hasta || today();
    const todos = [];
    for (let d = desde; d <= hasta && todos.length < 1000; d = sumarDias(d, 1)) todos.push(d);
    const semanal = todos.length > 92;
    const cols = [...new Set(todos.map(d => (semanal ? periodo(d, 'semana') : d)))];
    const naves = new Map();
    lecturas.forEach((x) => {
        if (!naves.has(x.NaveID)) naves.set(x.NaveID, `${isAdmin() && ctxIds().length > 1 ? granjaName(x.GranjaID) + ' · ' : ''}${x.Sector} / ${x.Nave}`);
    });
    const filas = [...naves.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es', { numeric: true }));
    const max = {};
    const cuenta = {};
    lecturas.forEach((x) => {
        const d = String(x.FechaHora).slice(0, 10);
        const k = `${x.NaveID}|${semanal ? periodo(d, 'semana') : d}`;
        const v = toNum(x.Indice);
        if (v === null) return;
        if (!(k in max) || v > max[k]) max[k] = v;
        cuenta[k] = (cuenta[k] || 0) + 1;
    });
    const values = filas.map(([id]) => cols.map(c => (`${id}|${c}` in max ? max[`${id}|${c}`] : null)));
    const etiqueta = c => (semanal ? periodoLabel(c, 'semana') : fmtDate(c).slice(0, 5));
    return {
        type: 'heatmap', title: 'Mapa de calor del estrés calórico', icon: 'thermometer',
        subtitle: `${semanal ? 'IEC máximo por semana' : 'IEC máximo por día'} · ${fmtDate(desde)} a ${fmtDate(hasta)}`,
        rows: filas.map(f => f[1]), cols: cols.map(etiqueta), values,
        color: v => IEC_COLOR[nivelIec(v)?.color] || '#ccc',
        legend: state.db.iecRangos.map(x => ({ color: IEC_COLOR[x.color], label: x.nivel })).concat([{ color: PALETTE.track, label: 'Sin lectura' }]),
        tip: (ri, ci) => {
            const v = values[ri][ci];
            const k = `${filas[ri][0]}|${cols[ci]}`;
            return [filas[ri][1], `${semanal ? 'Semana del ' + rangoSemanaIso(cols[ci]) : fmtDate(cols[ci])}`,
                v === null ? 'Sin lectura' : `IEC máximo ${fmtNum(v)} · ${nivelIec(v)?.nivel || ''}`, v === null ? '' : `${cuenta[k]} lectura(s)`].filter(Boolean);
        },
    };
}

function sumarDias(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const x = new Date(Date.UTC(y, m - 1, d + n));
    return x.toISOString().slice(0, 10);
}

// ==========================================================================
// 9. VISTAS: GRANJAS, PERFILES Y USUARIOS
// ==========================================================================

function representantesDe(granjaId) {
    return state.db.users.filter(u => u.Rol === ROLES.REPRESENTANTE && String(u.GranjaIDs || '').split(',').includes(granjaId));
}

function viewGranjas() {
    const rows = state.db.granjas.map(g => ({
        ...g,
        _lineas: LINEAS.filter(l => perfilDe(g.GranjaID, l)),
        _naves: state.db.naves.filter(n => n.GranjaID === g.GranjaID && n.Estado === 'Activo').length,
        _reps: representantesDe(g.GranjaID).length,
    }));
    const lineasBadges = g => (g._lineas.length ? g._lineas.map((l) => {
        const p = perfilDe(g.GranjaID, l);
        return `<span class="badge ${p.Estado === 'Activo' ? '' : 'badge-warn'}" title="${p.Estado === 'Activo' ? '' : 'Suspendida'}">${ico(LINEA_ICON[l], 'icon-sm')}${esc(l)}</span>`;
    }).join(' ') : '<span class="badge badge-muted">Sin líneas</span>');
    return `<div class="section-head"><p class="muted">Cada granja tiene sus propias líneas (reproductora, incubadora, engorde y postura), cada una con su ficha, sus sectores y sus naves.</p>
        <button type="button" class="btn btn-primary" data-action="new-granja">${ico('plus')}Nueva granja</button></div>`
        + table('granjas', {
            title: 'Granjas', icon: 'warehouse', empty: 'Aún no hay granjas registradas.',
            columns: [
                { k: 'NombreGranja', l: 'Granja', sticky: true, html: g => `<button type="button" class="btn btn-link" data-action="open-granja" data-id="${esc(g.GranjaID)}">${esc(g.NombreGranja)}</button>${g.Alterado ? ` <span class="badge badge-danger" title="Modificada fuera de la plataforma">${ico('lock', 'icon-sm')}</span>` : ''}` },
                { k: 'Propietario', l: 'Propietario' },
                { k: 'Ubicacion', l: 'Ubicación' },
                { k: '_lineas', l: 'Líneas', get: g => g._lineas.join(', '), html: lineasBadges },
                { k: '_naves', l: 'Naves activas', t: 'num' },
                { k: '_reps', l: 'Representantes', t: 'num' },
                { k: 'Estado', l: 'Estado', html: g => badgeEstado(g.Estado) },
                { k: 'FechaAlta', l: 'Alta', t: 'date' },
            ],
            rows,
            actions: g => `<button type="button" class="icon-btn icon-btn-sm" data-action="open-granja" data-id="${esc(g.GranjaID)}" title="Ver granja" aria-label="Ver granja">${ico('arrow-up-right')}</button>
                <button type="button" class="icon-btn icon-btn-sm" data-action="edit-granja" data-id="${esc(g.GranjaID)}" title="Editar" aria-label="Editar granja">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm" data-action="estado-granja" data-id="${esc(g.GranjaID)}" title="${g.Estado === 'Activo' ? 'Suspender' : 'Activar'}" aria-label="${g.Estado === 'Activo' ? 'Suspender' : 'Activar'} granja">${ico(g.Estado === 'Activo' ? 'circle-pause' : 'circle-play')}</button>
                <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-granja" data-id="${esc(g.GranjaID)}" title="Eliminar" aria-label="Eliminar granja">${ico('trash')}</button>`,
        });
}

/**
 * Granja: datos generales + cada línea que tiene (ficha, sectores, naves y lotes).
 * Las líneas que la granja no tiene no se muestran (el admin puede agregarlas).
 */
function viewGranja(param) {
    const id = isAdmin() ? param : state.granjaId;
    if (!state.db.granjas.length && !isAdmin()) return noGranjas();
    const g = id && granjaById(id);
    if (!g) {
        return emptyState('Granja no encontrada.', 'warehouse', isAdmin() ? `<button type="button" class="btn" data-action="nav" data-view="granjas">${ico('arrow-left')}Volver a granjas</button>` : '');
    }
    const admin = isAdmin();
    let html = '';
    if (!admin && state.db.granjas.length > 1) html += `<div class="card filters-card"><div class="filters">${granjaSwitch()}</div></div>`;

    const meta = [
        g.Propietario && `<span>${ico('user', 'icon-sm')}${esc(g.Propietario)}</span>`,
        g.Ubicacion && `<span>${ico('map-pin', 'icon-sm')}${esc(g.Ubicacion)}</span>`,
        g.Telefono && `<span>${ico('phone', 'icon-sm')}${esc(g.Telefono)}</span>`,
        g.EmailContacto && `<span>${ico('mail', 'icon-sm')}${esc(g.EmailContacto)}</span>`,
        g.FechaAlta && `<span>${ico('calendar-range', 'icon-sm')}Alta ${esc(fmtDate(g.FechaAlta))}</span>`,
    ].filter(Boolean).join('');
    html += `<div class="card farm-hero">
        <div class="brand-mark" aria-hidden="true">${ico('warehouse')}</div>
        <h2>${esc(g.NombreGranja)}</h2>
        <div class="row row-center">${badgeEstado(g.Estado)}${g.Alterado ? `<span class="badge badge-danger">${ico('lock', 'icon-sm')}Modificada fuera de la plataforma</span>` : ''}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${g.Notas ? `<p class="muted">${esc(g.Notas)}</p>` : ''}
        <div class="row row-center">
            <button type="button" class="btn btn-sm" data-action="goto-dashboard" data-id="${esc(g.GranjaID)}">${ico('layout-dashboard')}Dashboard</button>
            <button type="button" class="btn btn-sm" data-action="goto-registros" data-id="${esc(g.GranjaID)}">${ico('clipboard-list')}Registros</button>
            ${admin ? `<button type="button" class="btn btn-sm" data-action="edit-granja" data-id="${esc(g.GranjaID)}">${ico('pencil')}Editar</button>
            <button type="button" class="btn btn-sm" data-action="estado-granja" data-id="${esc(g.GranjaID)}">${ico(g.Estado === 'Activo' ? 'circle-pause' : 'circle-play')}${g.Estado === 'Activo' ? 'Suspender' : 'Activar'}</button>` : ''}
        </div>
    </div>`;

    const lineas = LINEAS.filter(l => perfilDe(g.GranjaID, l));
    if (!lineas.length) {
        html += emptyState('Esta granja aún no tiene líneas de producción. Agrega la primera abajo.', 'clipboard-list');
    }
    html += lineas.map(l => lineaCard(g, l)).join('');

    // Agregar líneas: el admin en cualquier granja; el representante en la suya (si está activa).
    const faltan = LINEAS.filter(l => !perfilDe(g.GranjaID, l));
    if (faltan.length && (admin || g.Estado === 'Activo')) {
        html += `<div class="card"><div class="card-head card-title-center"><h3>${ico('plus')}Agregar línea de producción</h3></div>
            <p class="muted center">Cada línea tiene su propia ficha. Solo se muestran las líneas que la granja tiene.</p>
            <div class="row row-center">${faltan.map(l => `<button type="button" class="btn btn-sm" data-action="new-perfil" data-granja="${esc(g.GranjaID)}" data-linea="${l}">${ico(LINEA_ICON[l])}${l}</button>`).join('')}</div></div>`;
    }

    if (admin) {
        const reps = representantesDe(g.GranjaID);
        html += `<div class="card"><div class="card-head card-title-center"><h3>${ico('users')}Representantes</h3></div>
            ${reps.length ? `<div class="chips">${reps.map(u => `<span class="chip">${ico('user', 'icon-sm')}${esc(u.Nombre)} · ${esc(u.Email)} ${badgeEstado(u.Estado)}</span>`).join('')}</div>`
                : '<p class="muted center">Esta granja aún no tiene representantes.</p>'}
            <div class="row row-center"><button type="button" class="btn btn-sm" data-action="new-user" data-granja="${esc(g.GranjaID)}">${ico('user-plus')}Agregar representante</button></div></div>`;
    }
    return html;
}

function lineaCard(g, linea) {
    const p = perfilDe(g.GranjaID, linea);
    const admin = isAdmin();
    const activa = p.Estado === 'Activo';
    const secciones = [];
    state.db.campos.perfil.forEach((c) => {
        let s = secciones.find(x => x.s === c.s);
        if (!s) { s = { s: c.s, campos: [] }; secciones.push(s); }
        s.campos.push(c);
    });
    const valor = (c) => {
        const v = p[c.k];
        if (v === '' || v === undefined) return '<dd class="empty">—</dd>';
        return `<dd>${esc(c.t === 'fecha' ? fmtDate(v) : c.k === 'EdadReproductoraSemanas' ? `${v} semanas` : v)}</dd>`;
    };
    const sectores = sectoresDe(g.GranjaID, linea);
    return `<div class="card linea-card${activa ? '' : ' is-disabled'}">
        <div class="card-head card-title-center"><h2>${ico(LINEA_ICON[linea])}Línea de ${esc(linea.toLowerCase())}</h2>${badgeEstado(p.Estado)}${p.Alterado ? `<span class="badge badge-danger">${ico('lock', 'icon-sm')}Modificada fuera de la plataforma</span>` : ''}</div>
        <details class="ficha"><summary>${ico('clipboard-list', 'icon-sm')}Ficha de la línea${ico('chevron-down', 'icon-sm')}</summary>
            <div class="stack">${secciones.map(s => `<section class="profile-section"><h3>${ico(SECCION_ICON[s.s] || 'list')}${esc(s.s)}</h3>
                <dl class="kv">${s.campos.map(c => `<div><dt>${esc(c.l)}</dt>${valor(c)}</div>`).join('')}</dl></section>`).join('')}
            ${p.ActualizadoEn ? `<p class="muted center">Última actualización ${esc(fmtDateTime(p.ActualizadoEn))}</p>` : ''}
            ${!admin && activa ? `<div class="row row-center"><button type="button" class="btn btn-sm" data-action="edit-perfil" data-id="${esc(p.PerfilID)}">${ico('pencil')}Editar ficha</button></div>` : ''}
            ${admin ? `<div class="row row-center">
                <button type="button" class="btn btn-sm" data-action="edit-perfil" data-id="${esc(p.PerfilID)}">${ico('pencil')}Editar ficha</button>
                <button type="button" class="btn btn-sm" data-action="estado-perfil" data-id="${esc(p.PerfilID)}">${ico(activa ? 'circle-pause' : 'circle-play')}${activa ? 'Suspender línea' : 'Activar línea'}</button>
                <button type="button" class="btn btn-sm btn-danger" data-action="delete-perfil" data-id="${esc(p.PerfilID)}">${ico('trash')}Eliminar línea</button></div>` : ''}</div>
        </details>
        <div class="estructura">
            <div class="row row-between"><h3 class="estructura-titulo">${ico('layout-grid')}Sectores y naves</h3>
                ${activa ? `<button type="button" class="btn btn-sm" data-action="new-sector" data-granja="${esc(g.GranjaID)}" data-linea="${linea}">${ico('plus')}Nuevo sector</button>` : ''}</div>
            ${sectores.length ? sectores.map(sectorBlock).join('') : `<p class="muted center">${activa ? 'Aún no hay sectores. Crea el primero para registrar datos.' : 'Línea suspendida.'}</p>`}
        </div>
    </div>`;
}

function sectorBlock(s) {
    const naves = navesDe(s.SectorID);
    const activo = s.Estado === 'Activo';
    return `<section class="sector${activo ? '' : ' is-inactive'}">
        <div class="sector-head">
            <strong>${ico('layout-grid', 'icon-sm')}${esc(s.Nombre)}</strong>${activo ? '' : badgeEstado('Inactivo')}
            <div class="row">
                ${activo ? `<button type="button" class="btn btn-sm" data-action="new-nave" data-id="${esc(s.SectorID)}">${ico('plus')}Nave</button>` : ''}
                <button type="button" class="icon-btn icon-btn-sm" data-action="edit-sector" data-id="${esc(s.SectorID)}" title="Renombrar" aria-label="Renombrar sector">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm" data-action="estado-sector" data-id="${esc(s.SectorID)}" title="${activo ? 'Desactivar' : 'Activar'}" aria-label="${activo ? 'Desactivar' : 'Activar'} sector">${ico(activo ? 'circle-pause' : 'circle-play')}</button>
                ${naves.length ? '' : `<button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-sector" data-id="${esc(s.SectorID)}" title="Eliminar" aria-label="Eliminar sector">${ico('trash')}</button>`}
            </div>
        </div>
        ${naves.length ? `<div class="naves">${naves.map(naveCard).join('')}</div>` : '<p class="muted center">Sin naves.</p>'}
    </section>`;
}

function naveCard(n) {
    const activa = n.Estado === 'Activo';
    const lote = loteActivo(n.NaveID);
    const historial = lotesDe(n.NaveID).filter(l => l.Estado !== 'Activo');
    const tieneLotes = lotesDe(n.NaveID).length > 0;
    const dias = lote ? edadDias(lote, today()) : null;
    const costo = lote ? toNum(lote.CostoPorAve) : null;
    const total = costo !== null && toNum(lote.AvesIniciales) ? costo * toNum(lote.AvesIniciales) : null;
    const loteHtml = lote
        ? `<div class="lote">${ico('tag', 'icon-sm')}<span><strong>Lote ${esc(lote.NumeroLote)}</strong> · ${esc(lote.LineaGenetica)}<br><span class="muted">Desde ${esc(fmtDate(lote.FechaInicio))}${lote.AvesIniciales ? ` · ${esc(fmtNum(lote.AvesIniciales))} aves` : ''}</span>
            ${dias !== null ? `<br><span class="muted">Hoy: ${esc(textoEdad(dias))}</span>` : `<br><span class="muted">${n.Linea === 'Incubadora' ? '' : 'Sin edad inicial: edita el lote para comparar con la tabla.'}</span>`}
            ${costo !== null ? `<br><span class="muted">${esc(fmtQ(costo))} por ave${total !== null ? ` · ${esc(fmtQ(total))} el lote` : ''}</span>` : ''}</span></div>`
        : '<div class="lote muted">Sin lote activo</div>';
    return `<div class="nave${activa ? '' : ' is-inactive'}">
        <div class="nave-head"><strong>${ico('house', 'icon-sm')}${esc(n.Nombre)}</strong>${activa ? '' : badgeEstado('Inactivo')}</div>
        ${loteHtml}
        <div class="row row-center">
            ${activa && !lote ? `<button type="button" class="btn btn-sm btn-primary" data-action="new-lote" data-id="${esc(n.NaveID)}">${ico('tag')}Iniciar lote</button>` : ''}
            ${lote ? `<button type="button" class="btn btn-sm" data-action="edit-lote" data-id="${esc(lote.LoteID)}">${ico('tag')}Editar lote</button>
                <button type="button" class="btn btn-sm" data-action="cerrar-lote" data-id="${esc(lote.LoteID)}">Cerrar lote</button>` : ''}
            <button type="button" class="icon-btn icon-btn-sm" data-action="edit-nave" data-id="${esc(n.NaveID)}" title="Renombrar nave" aria-label="Renombrar nave">${ico('pencil')}</button>
            <button type="button" class="icon-btn icon-btn-sm" data-action="estado-nave" data-id="${esc(n.NaveID)}" title="${activa ? 'Desactivar' : 'Activar'} nave" aria-label="${activa ? 'Desactivar' : 'Activar'} nave">${ico(activa ? 'circle-pause' : 'circle-play')}</button>
            ${tieneLotes ? '' : `<button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-nave" data-id="${esc(n.NaveID)}" title="Eliminar nave" aria-label="Eliminar nave">${ico('trash')}</button>`}
        </div>
        ${historial.length ? `<details class="historial"><summary>Lotes anteriores (${historial.length})</summary><ul>${historial.map((l, i) => `<li><span>${esc(l.NumeroLote)} · ${esc(l.LineaGenetica)} · ${esc(fmtDate(l.FechaInicio))} a ${esc(fmtDate(l.FechaCierre))}</span>
            ${i === 0 && !lote ? `<button type="button" class="btn btn-link" data-action="reabrir-lote" data-id="${esc(l.LoteID)}">Reabrir</button>` : ''}</li>`).join('')}</ul></details>` : ''}
    </div>`;
}

function viewUsuarios() {
    return `<div class="section-head"><p class="muted">Solo la administración crea cuentas. La contraseña temporal se muestra una sola vez.</p>
        <button type="button" class="btn btn-primary" data-action="new-user">${ico('user-plus')}Nuevo usuario</button></div>`
        + table('usuarios', {
            title: 'Usuarios', icon: 'users',
            columns: [
                { k: 'Nombre', l: 'Nombre', sticky: true, html: u => `${esc(u.Nombre)}${u.Alterado ? ` <span class="badge badge-danger" title="Modificado fuera de la plataforma">${ico('lock', 'icon-sm')}</span>` : ''}` },
                { k: 'Email', l: 'Correo' },
                { k: 'Rol', l: 'Nivel', get: u => ROLE_LABEL[u.Rol] || u.Rol, html: u => `<span class="badge ${u.Rol === ROLES.ADMIN ? 'badge-solid' : ''}">${esc(ROLE_LABEL[u.Rol] || u.Rol)}</span>` },
                { k: 'GranjaIDs', l: 'Granjas', get: u => (u.Rol === ROLES.ADMIN ? 'Todas' : String(u.GranjaIDs || '').split(',').filter(Boolean).map(granjaName).join(', ')), wrap: true },
                { k: 'Telefono', l: 'Teléfono' },
                { k: 'Estado', l: 'Estado', html: u => badgeEstado(u.Estado) },
                { k: 'DebeCambiarClave', l: 'Contraseña', get: u => (u.DebeCambiarClave === 'SI' ? 'Temporal' : 'Definitiva'), html: u => (u.DebeCambiarClave === 'SI' ? '<span class="badge badge-warn">Temporal</span>' : '<span class="badge badge-ok">Definitiva</span>') },
                { k: 'FechaCreacion', l: 'Creado', t: 'datetime' },
            ],
            rows: state.db.users,
            actions: (u) => {
                const self = u.ID === state.me.ID;
                return `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-user" data-id="${esc(u.ID)}" title="Editar" aria-label="Editar usuario">${ico('pencil')}</button>
                    <button type="button" class="icon-btn icon-btn-sm" data-action="estado-user" data-id="${esc(u.ID)}" title="${u.Estado === 'Activo' ? 'Suspender' : 'Activar'}" aria-label="${u.Estado === 'Activo' ? 'Suspender' : 'Activar'} usuario"${self ? ' disabled' : ''}>${ico(u.Estado === 'Activo' ? 'circle-pause' : 'circle-play')}</button>
                    <button type="button" class="icon-btn icon-btn-sm" data-action="reset-user" data-id="${esc(u.ID)}" title="Nueva contraseña temporal" aria-label="Restablecer contraseña"${self ? ' disabled' : ''}>${ico('key-round')}</button>
                    <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-user" data-id="${esc(u.ID)}" title="Eliminar" aria-label="Eliminar usuario"${self ? ' disabled' : ''}>${ico('trash')}</button>`;
            },
        });
}

// ==========================================================================
// 10. VISTAS: LISTAS, BITÁCORA Y SEGURIDAD
// ==========================================================================

function viewListas() {
    const tipos = state.db.tiposLista.length ? state.db.tiposLista : Object.keys(LISTA_LABEL);
    return `<div class="card"><div class="card-head card-title-center"><h3>${ico('plus')}Agregar valor</h3></div>
        <form class="filters" data-submit="add-lista">
            <label class="field"><span>Lista</span><select name="Tipo" required>${tipos.map(t => `<option value="${esc(t)}">${esc(LISTA_LABEL[t] || t)}</option>`).join('')}</select></label>
            <label class="field"><span>Valor</span><input name="Valor" required maxlength="150" autocomplete="off"></label>
            <button type="submit" class="btn btn-primary">${ico('plus')}Agregar</button>
        </form>
        <p class="muted center">Estos valores aparecen como sugerencias al llenar las fichas; se puede escribir otro valor si hace falta.</p></div>
        <div class="grid-3">${tipos.map((t) => {
        const vals = state.db.listas.filter(l => l.Tipo === t).sort((a, b) => (toNum(a.Orden) ?? 1e9) - (toNum(b.Orden) ?? 1e9) || String(a.Valor).localeCompare(String(b.Valor), 'es'));
        return `<div class="card"><div class="card-head card-title-center"><h3>${ico('list')}${esc(LISTA_LABEL[t] || t)}</h3></div>
                ${vals.length ? `<div class="chips">${vals.map(v => `<span class="chip">${esc(v.Valor)}<button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-lista" data-id="${esc(v.ListaID)}" aria-label="Quitar ${esc(v.Valor)}" title="Quitar">${ico('x')}</button></span>`).join('')}</div>`
                : '<p class="muted center">Sin valores.</p>'}</div>`;
    }).join('')}</div>`;
}

function viewBitacora() {
    if (!isAdmin() && !state.granjaId) return noGranjas();
    const granjaSel = isAdmin()
        ? `<label class="field"><span>Granja</span><select data-change="bit-granja"><option value="">Todas</option>${state.db.granjas.map(g =>
            `<option value="${esc(g.GranjaID)}"${state.bitGranja === g.GranjaID ? ' selected' : ''}>${esc(g.NombreGranja)}</option>`).join('')}</select></label>`
        : granjaSwitch();
    const head = `<div class="card filters-card"><div class="filters">${granjaSel}${dateFilters()}</div></div>`;
    const payload = {
        GranjaID: isAdmin() ? (state.bitGranja || undefined) : state.granjaId,
        desde: state.f.desde || undefined, hasta: state.f.hasta || undefined,
    };
    const r = need('getBitacora', payload);
    if (!r) return head + loadingBlock(1);
    if (!r.ok) return head + errorBlock(r);
    return head + (r.data.truncado ? alertBox('info', 'info', 'Se muestran los cambios más recientes. Reduce el rango de fechas para ver los anteriores.') : '')
        + table('bitacora', {
            title: 'Cambios registrados', icon: 'history', csv: 'bitacora',
            columns: [
                { k: 'Fecha', l: 'Fecha', t: 'datetime', sticky: true },
                { k: 'GranjaID', l: 'Granja', get: b => (b.GranjaID ? granjaName(b.GranjaID) : '') },
                { k: 'Entidad', l: 'Elemento' },
                { k: 'Accion', l: 'Acción' },
                { k: 'Detalle', l: 'Detalle', wrap: true },
                { k: 'Justificacion', l: 'Justificación', wrap: true },
                { k: 'ModificadoPor', l: 'Realizado por' },
            ],
            rows: r.data.bitacora,
        });
}

function viewSeguridad() {
    let html = `<div class="card"><div class="card-head card-title-center"><h2>${ico('shield-check')}Integridad de la base de datos</h2></div>
        <p class="muted center">Comprueba que nadie haya modificado, borrado o insertado datos directamente en la hoja, fuera de la plataforma.</p>
        <div class="row row-center"><button type="button" class="btn btn-primary" data-action="verify-audit">${ico('shield-check')}Verificar integridad</button></div>
        ${state.audit ? auditHtml(state.audit) : ''}</div>`;
    const head = `<div class="card filters-card"><div class="filters">${dateFilters()}</div></div>`;
    const r = need('getAccesos', { desde: state.f.desde || undefined, hasta: state.f.hasta || undefined });
    html += head;
    if (!r) return html + loadingBlock(1);
    if (!r.ok) return html + errorBlock(r);
    return html + table('accesos', {
        title: 'Ingresos e intentos rechazados', icon: 'lock', csv: 'accesos',
        columns: [
            { k: 'Fecha', l: 'Fecha', t: 'datetime', sticky: true },
            { k: 'Email', l: 'Correo' },
            { k: 'UsuarioID', l: 'Usuario', get: a => userById(a.UsuarioID)?.Nombre || (a.UsuarioID ? a.UsuarioID : 'Sin cuenta') },
            { k: 'Accion', l: 'Acción', get: a => ACCION_LABEL[a.Accion] || a.Accion },
            { k: 'Resultado', l: 'Resultado', get: a => RESULTADO_LABEL[a.Resultado] || a.Resultado, html: a => `<span class="badge ${a.Resultado === 'OK' ? 'badge-ok' : 'badge-danger'}">${esc(RESULTADO_LABEL[a.Resultado] || a.Resultado)}</span>` },
        ],
        rows: r.data.accesos,
    });
}

/**
 * Compras de concentrado: registro aparte (no toca lotes, naves ni cálculos). El representante ve
 * su granja; el admin una, varias o todas, con el costo promedio por quintal ponderado.
 */
function viewConcentrado() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ lineas: false });
    const nueva = `<div class="section-head"><p class="muted">Cada compra guarda cuánto se compró, cuánto costó y qué fechas cubre. Por ahora es un registro aparte: no cambia ningún otro cálculo.</p>
        <button type="button" class="btn btn-primary" data-action="new-compra">${ico('plus')}Nueva compra</button></div>`;
    const r = need('getConcentrado', { GranjaIDs: apiGranjas(), desde: state.f.desde || undefined, hasta: state.f.hasta || undefined });
    if (!r) return head + nueva + loadingBlock(1);
    if (!r.ok) return head + nueva + errorBlock(r);
    const { compras, totales, porGranja } = r.data;
    state.compras = new Map(compras.map(c => [c.CompraID, c]));
    let html = head + nueva + `<div class="kpis">
        ${kpi('Compras', nf.format(compras.length), state.f.desde || state.f.hasta ? `${fmtDate(state.f.desde) || 'inicio'} a ${fmtDate(state.f.hasta) || 'hoy'}` : 'Todo el historial', 'clipboard-list')}
        ${kpi('Quintales comprados', `${fmtNum(totales.quintales)} qq`, '', 'wheat')}
        ${kpi('Costo total', fmtQ(totales.costo), '', 'file-spreadsheet')}
        ${kpi('Costo promedio', totales.costoPorQuintal ? `${fmtQ(totales.costoPorQuintal)} / qq` : '—', 'Ponderado por cantidad', 'scale')}</div>`;
    if (isAdmin() && porGranja.length > 1) {
        html += table('concentrado-granjas', {
            title: 'Por granja', icon: 'warehouse', csv: 'concentrado-por-granja',
            columns: [{ k: 'GranjaID', l: 'Granja', sticky: true, get: g => granjaName(g.GranjaID) }, { k: 'quintales', l: 'Quintales', t: 'num' },
                { k: 'costo', l: 'Costo total (Q)', t: 'num' }, { k: 'costoPorQuintal', l: 'Costo por quintal (Q)', t: 'num' }],
            rows: porGranja,
        });
    }
    return html + table('compras', {
        title: 'Compras de concentrado', icon: 'wheat', csv: 'compras-concentrado',
        empty: 'No hay compras en el rango seleccionado.',
        columns: [{ k: 'Desde', l: 'Desde', t: 'date', sticky: true }, { k: 'Hasta', l: 'Hasta', t: 'date' }].concat(colsGranja(), [
            { k: 'CantidadQuintales', l: 'Cantidad (qq)', t: 'num' }, { k: 'CostoTotal', l: 'Costo total (Q)', t: 'num' },
            { k: 'CostoPorQuintal', l: 'Costo por quintal (Q)', t: 'num' }, { k: 'Comentarios', l: 'Comentarios', wrap: true },
            { k: 'CreadoPor', l: 'Registrado por' }, { k: 'CreadoEn', l: 'Registrado el', t: 'datetime' }]),
        rows: compras,
        actions: c => (!modificable(c.CreadoEn) ? sinPermisoFecha()
            : `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-compra" data-id="${esc(c.CompraID)}" title="Editar" aria-label="Editar compra">${ico('pencil')}</button>
               <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-compra" data-id="${esc(c.CompraID)}" title="Eliminar" aria-label="Eliminar compra">${ico('trash')}</button>`),
    });
}

/**
 * Serología: muestreos por lote (un título por ave) con su resumen, gráficos por edad y los
 * métodos o kits. Los gráficos solo comparan una enfermedad con un método (los kits no se mezclan).
 */
function viewSerologia() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    if (state.srEnf && !enfermedadById(state.srEnf)) state.srEnf = '';
    const metodos = state.srEnf ? metodosDe(state.srEnf, ids) : [];
    if (state.srMetodo && !metodos.some(m => m.MetodoID === state.srMetodo)) state.srMetodo = '';
    const metodo = metodoById(state.srMetodo);
    const selectores = `<label class="field"><span>Enfermedad</span><select data-change="sr-f-enf"><option value="">Todas</option>${state.db.enfermedades.map(e =>
        `<option value="${esc(e.EnfermedadID)}"${e.EnfermedadID === state.srEnf ? ' selected' : ''}>${esc(e.Nombre)}</option>`).join('')}</select></label>
        <label class="field"><span>Método</span><select data-change="sr-f-metodo"${state.srEnf ? '' : ' disabled'}><option value="">${state.srEnf ? 'Todos' : 'Elige la enfermedad'}</option>${metodos.map(m =>
        `<option value="${esc(m.MetodoID)}"${m.MetodoID === state.srMetodo ? ' selected' : ''}>${esc(nombreMetodo(m))}</option>`).join('')}</select></label>`;
    const head = filtersCard({ eliminados: true, extra: selectores });
    if (!lineasDisponibles(ids).length) return head + sinLineas();
    const linea = state.linea;
    const aviso = sinEstructura(linea);
    const nuevo = aviso || `<div class="section-head"><p class="muted">Se elige la nave, la fecha del muestreo, la enfermedad y el método, y se escribe el resultado de cada ave. La plataforma calcula el resumen.</p>
        <button type="button" class="btn btn-primary" data-action="new-serologia">${ico('syringe')}Nuevo muestreo</button></div>`;
    const r = need('getSerologias', registrosPayload({
        EnfermedadID: state.srEnf || undefined, MetodoID: state.srMetodo || undefined,
        incluirEliminados: isAdmin() && state.f.eliminados ? true : undefined,
    }));
    const cuerpo = (() => {
        if (!r) return loadingBlock(1);
        if (!r.ok) return errorBlock(r);
        const filas = r.data.serologias;
        state.serologias = new Map(filas.map(x => [x.SerologiaID, x]));
        const graficos = metodo
            ? seroCharts(filas, metodo)
            : `<div class="alert alert-info">${ico('info')}<span>Elige una enfermedad y un método para ver los gráficos por edad. Los resultados de métodos distintos no se comparan entre sí.</span></div>`;
        return graficos + table('serologias', {
            title: `Muestreos de ${linea.toLowerCase()}`, icon: 'syringe', csv: `serologia-${linea}`,
            empty: 'No hay muestreos en el rango seleccionado.', rows: filas,
            columns: [{ k: 'Fecha', l: 'Fecha', t: 'date', sticky: true }].concat(colsGranja(), COLS_UBICACION, [
                { k: 'EdadDias', l: 'Edad (días)', t: 'num' }, { k: 'SemanaEdad', l: 'Semana de edad', t: 'num' },
                { k: 'Enfermedad', l: 'Enfermedad' }, { k: 'Metodo', l: 'Método' }, { k: 'Prueba', l: 'Prueba' },
                { k: 'Muestra', l: 'Muestra', t: 'num' },
                { k: 'Resumen', l: 'Resumen', t: 'num', get: x => toNum(valorResumen(x)) },
                { k: 'Maximo', l: 'Dato mayor', t: 'num' }, { k: 'CV', l: 'CV (%)', t: 'num' },
                { k: 'PctPositivos', l: 'Positivas (%)', t: 'num' }, { k: 'PctProtegidas', l: 'Protegidas (%)', t: 'num' },
            ], linea === 'Incubadora' ? [{ k: 'LoteOrigen', l: 'Lote de origen' }] : [], [
                { k: 'Laboratorio', l: 'Laboratorio' }, { k: 'Valores', l: 'Resultados', nocsv: false, wrap: true, html: x => `<span class="muted">${esc(String(x.Valores || '').split(',').filter(Boolean).length)} resultados</span>` },
                { k: 'CreadoPor', l: 'Registrado por' }, { k: 'CreadoEn', l: 'Registrado el', t: 'datetime' },
            ], isAdmin() && state.f.eliminados ? [{ k: 'Estado', l: 'Estado', html: x => badgeEstado(x.Estado === 'Activo' ? 'Activo' : 'Eliminado') }] : []),
            rowClass: x => (x.Estado !== 'Activo' ? 'is-deleted' : ''),
            actions: x => `<button type="button" class="icon-btn icon-btn-sm" data-action="ver-serologia" data-id="${esc(x.SerologiaID)}" title="Ver los resultados" aria-label="Ver los resultados">${ico('list-checks')}</button>`
                + (x.Estado === 'Activo' && !modificable(x.CreadoEn) ? sinPermisoFecha() : '')
                + (x.Estado === 'Activo' && modificable(x.CreadoEn) ? `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-serologia" data-id="${esc(x.SerologiaID)}" title="Editar" aria-label="Editar muestreo">${ico('pencil')}</button>
                   <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-serologia" data-id="${esc(x.SerologiaID)}" title="Eliminar" aria-label="Eliminar muestreo">${ico('trash')}</button>` : ''),
        });
    })();
    return head + nuevo + cuerpo + metodosTabla(ids);
}

/** Métodos o kits visibles en el contexto: generales y los propios de las granjas elegidas. */
function metodosTabla(ids) {
    const filas = state.db.metodosSerologia.filter(m => !m.GranjaID || ids.includes(m.GranjaID))
        .filter(m => !state.srEnf || m.EnfermedadID === state.srEnf);
    const puedeEditar = m => isAdmin() || !!m.GranjaID;
    return `<div class="section-head"><p class="muted">Cada granja usa su propio método o kit. El corte de positivo y el nivel protector se anotan solo si están publicados (inserto del kit o documento del laboratorio), con su fuente.</p>
        <button type="button" class="btn" data-action="new-metodo">${ico('plus')}Nuevo método</button></div>` + table('metodos-serologia', {
        title: 'Métodos o kits', icon: 'list-checks', csv: 'metodos-serologia',
        empty: 'No hay métodos para la enfermedad elegida.', rows: filas,
        columns: [
            { k: 'EnfermedadID', l: 'Enfermedad', sticky: true, get: m => enfermedadById(m.EnfermedadID)?.Nombre || '—' },
            { k: 'Nombre', l: 'Método' }, { k: 'Prueba', l: 'Prueba' }, { k: 'Unidad', l: 'Unidad' },
            { k: 'GranjaID', l: 'De', get: m => (m.GranjaID ? granjaName(m.GranjaID) : 'General (todas)') },
            { k: 'Laboratorio', l: 'Laboratorio' }, { k: 'CortePositivo', l: 'Positivo desde', t: 'num' },
            { k: 'NivelProtector', l: 'Nivel protector', t: 'num' }, { k: 'Fuente', l: 'Fuente', wrap: true },
        ],
        actions: m => (puedeEditar(m)
            ? `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-metodo" data-id="${esc(m.MetodoID)}" title="Editar" aria-label="Editar método">${ico('pencil')}</button>
               <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-metodo" data-id="${esc(m.MetodoID)}" title="Eliminar" aria-label="Eliminar método">${ico('trash')}</button>`
            : `<span class="icon-btn icon-btn-sm muted" title="Método general: lo modifica la administración" aria-label="Método general: lo modifica la administración">${ico('lock')}</span>`),
    });
}

/** Valor que resume el muestreo según su prueba (HI: promedio log2; ELISA: media geométrica; placa: % positivas). */
function valorResumen(x) {
    return x.Prueba === 'HI' ? x.Promedio : x.Prueba === 'ELISA' ? x.MediaGeometrica : x.PctPositivos;
}

/**
 * Gráficos por edad (días) de una enfermedad y un método: una serie por granja (vista global con
 * varias granjas) o por nave. Varios muestreos de la misma serie y edad se combinan (ELISA con
 * media geométrica; el resto, promedio). El corte y el nivel protector van como líneas punteadas.
 */
function seroCharts(filas, metodo) {
    const activos = filas.filter(x => x.Estado === 'Activo' && x.EdadDias !== '');
    if (!activos.length) {
        return `<div class="alert alert-info">${ico('info')}<span>${filas.some(x => x.Estado === 'Activo')
            ? 'Los muestreos de lotes sin la edad de las aves al iniciar no se pueden ubicar por edad. Completa la edad en "Editar lote".'
            : 'No hay muestreos de este método en el rango seleccionado.'}</span></div>`;
    }
    const porGranja = isAdmin() && new Set(activos.map(x => x.GranjaID)).size > 1;
    const clave = x => (porGranja ? granjaName(x.GranjaID) : [x.Sector, x.Nave].filter(Boolean).join(' / '));
    const dias = [...new Set(activos.map(x => Number(x.EdadDias)))].sort((a, b) => a - b);
    const combinar = (vals, geo) => (geo ? 10 ** (vals.reduce((a, v) => a + Math.log10(Math.max(v, 1)), 0) / vals.length) : vals.reduce((a, v) => a + v, 0) / vals.length);
    const series = (campo, geo) => {
        const grupos = new Map();
        activos.forEach((x) => {
            const v = toNum(x[campo]);
            if (v === null) return;
            if (!grupos.has(clave(x))) grupos.set(clave(x), new Map());
            const g = grupos.get(clave(x));
            const d = Number(x.EdadDias);
            if (!g.has(d)) g.set(d, []);
            g.get(d).push(v);
        });
        return [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true })).map(([k, g], i) => ({
            name: k, color: PALETTE.cat[i % PALETTE.cat.length],
            data: dias.map(d => (g.has(d) ? round(combinar(g.get(d), geo), 2) : null)),
        }));
    };
    const referencias = [];
    if (metodo.Prueba !== 'PLACA' && metodo.CortePositivo !== '') {
        referencias.push({ name: `Positivo desde ${fmtNum(metodo.CortePositivo)}`, color: PALETTE.tabla, dashed: true, data: dias.map(() => Number(metodo.CortePositivo)) });
    }
    if (metodo.Prueba !== 'PLACA' && metodo.NivelProtector !== '') {
        referencias.push({ name: `Nivel protector ${fmtNum(metodo.NivelProtector)}`, color: PALETTE.o4, dashed: true, data: dias.map(() => Number(metodo.NivelProtector)) });
    }
    const enf = enfermedadById(metodo.EnfermedadID)?.Nombre || '';
    const labels = dias.map(d => `Día ${d}`);
    const titulo = { HI: 'Promedio de títulos HI (log2) por edad', ELISA: 'Media geométrica de títulos ELISA por edad', PLACA: 'Aves positivas (%) por edad' }[metodo.Prueba];
    const campo = { HI: 'Promedio', ELISA: 'MediaGeometrica', PLACA: 'PctPositivos' }[metodo.Prueba];
    let html = chartCard('sero-resumen', {
        type: 'line', icon: 'syringe', title: `${enf} · ${titulo}`, labels, unir: true,
        unit: metodo.Prueba === 'PLACA' ? '%' : '', series: series(campo, metodo.Prueba === 'ELISA').concat(referencias),
    });
    if (metodo.Prueba === 'ELISA') {
        html += chartCard('sero-cv', { type: 'line', icon: 'activity', title: `${enf} · CV (%) por edad`, labels, unir: true, unit: '%', series: series('CV', false) });
    }
    if (metodo.Prueba !== 'PLACA' && metodo.CortePositivo !== '') {
        html += chartCard('sero-positivas', { type: 'line', icon: 'chart-line', title: `${enf} · Aves positivas (%) por edad`, labels, unir: true, unit: '%', series: series('PctPositivos', false) });
    }
    return `<div class="grid-2">${html}</div>`;
}

/** Pesos estándar (admin): curva de cada línea genética por edad, con su fuente; se puede corregir. */
function viewEstandares() {
    const r = need('getEstandares', {});
    if (!r) return loadingBlock(2);
    if (!r.ok) return errorBlock(r);
    const filas = r.data.estandares;
    const tiposGen = new Set(Object.values(state.db.geneticaDe || {}).flat());
    const geneticas = [...new Set(state.db.listas.filter(l => tiposGen.has(l.Tipo)).map(l => l.Valor))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    const tipos = state.db.tiposEstandar?.length ? state.db.tiposEstandar : ['Comercial', 'Reproductora'];
    const conTabla = new Set(filas.map(x => `${x.LineaGenetica}|${x.Tipo}`));
    if (!state.estGen || !geneticas.includes(state.estGen)) state.estGen = geneticas.find(g => conTabla.has(`${g}|Comercial`)) || geneticas[0] || '';
    if (!tipos.includes(state.estTipo)) state.estTipo = 'Comercial';
    const curva = filas.filter(x => x.LineaGenetica === state.estGen && x.Tipo === state.estTipo);
    state.estFilas = new Map(curva.map(x => [x.EstandarID, x]));
    const cobertura = geneticas.map(g => `<span class="chip">${esc(g)} ${tipos.map(t => `<span class="badge ${conTabla.has(`${g}|${t}`) ? 'badge-ok' : 'badge-muted'}" title="${esc(t)}">${esc(t === 'Comercial' ? 'C' : 'R')}${conTabla.has(`${g}|${t}`) ? '' : ' —'}</span>`).join(' ')}</span>`).join('');
    const filtros = `<div class="card filters-card"><div class="filters">
        <label class="field"><span>Línea genética</span><select data-change="est-gen">${geneticas.map(g => `<option${g === state.estGen ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <div class="filter-group"><span class="field-label">Tabla</span><div class="segmented" role="group" aria-label="Tabla">${tipos.map(t =>
        `<button type="button" class="seg${t === state.estTipo ? ' is-active' : ''}" data-action="est-tipo" data-tipo="${esc(t)}" aria-pressed="${t === state.estTipo}">${esc(t === 'Comercial' ? 'Comercial (postura y engorde)' : 'Hembra reproductora')}</button>`).join('')}</div></div>
    </div></div>`;
    let html = filtros + `<div class="section-head"><p class="muted">Peso esperado por edad, tomado de la guía oficial de cada casa genética. Con esta tabla se juzga cada pesaje. Corrige una fila solo si la guía cambió (pide justificación y queda en la bitácora).</p>
        <button type="button" class="btn btn-primary" data-action="new-estandar">${ico('plus')}Agregar edad</button></div>`;
    if (!curva.length) {
        html += emptyState(`${state.estGen} no tiene tabla ${state.estTipo === 'Comercial' ? 'comercial' : 'de hembra reproductora'}. Sus pesajes quedan "Sin tabla" hasta que se cargue una guía oficial.`, 'chart-line');
    } else {
        const semanal = curva.length > 2 && Number(curva[1].EdadDias) - Number(curva[0].EdadDias) >= 7;
        const etq = x => (semanal ? `Sem. ${Math.round(Number(x.EdadDias) / 7)}` : `Día ${x.EdadDias}`);
        const spec = {
            title: `${state.estGen} · ${state.estTipo === 'Comercial' ? 'comercial' : 'hembra reproductora'} (${state.unidad})`, subtitle: curva[0].Fuente, icon: 'chart-line', type: 'line', unit: state.unidad,
            labels: curva.map(etq),
            series: [{ name: 'Estándar', color: PALETTE.primary, data: curva.map(x => round(enUnidad(x.EstandarG), decimalesPeso())) }],
        };
        if (curva.some(x => x.MinimoG !== '')) {
            spec.band = { name: 'Rango mín–máx', color: PALETTE.tabla, lo: curva.map(x => (x.MinimoG === '' ? null : round(enUnidad(x.MinimoG), decimalesPeso()))), hi: curva.map(x => (x.MaximoG === '' ? null : round(enUnidad(x.MaximoG), decimalesPeso()))) };
        }
        html += chartCard('estandar', spec) + table('estandares', {
            title: 'Tabla de pesos', icon: 'table', csv: `pesos-estandar-${state.estGen}-${state.estTipo}`,
            columns: [{ k: 'EdadDias', l: 'Edad (días)', t: 'num', sticky: true }, { k: 'semana', l: 'Semana', t: 'num', get: x => Math.floor(Number(x.EdadDias) / 7) },
                { k: 'MinimoG', l: 'Mínimo (g)', t: 'num' }, { k: 'EstandarG', l: 'Estándar (g)', t: 'num' }, { k: 'MaximoG', l: 'Máximo (g)', t: 'num' },
                { k: 'Fuente', l: 'Fuente', wrap: true, html: x => `${esc(x.Fuente)}${x.Alterado ? ` <span class="badge badge-danger" title="Modificada fuera de la plataforma">${ico('lock', 'icon-sm')}</span>` : ''}` }],
            rows: curva,
            actions: x => `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-estandar" data-id="${esc(x.EstandarID)}" title="Corregir" aria-label="Corregir fila">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-estandar" data-id="${esc(x.EstandarID)}" title="Borrar" aria-label="Borrar fila">${ico('trash')}</button>`,
        });
    }
    return html + `<div class="card"><div class="card-head card-title-center"><h3>${ico('list-checks')}Cobertura de las líneas genéticas</h3></div>
        <p class="muted center">C = tabla comercial · R = hembra reproductora · "—" = sin guía oficial cargada.</p><div class="chips">${cobertura}</div></div>`;
}

const TABLA_LABEL = {
    Usuarios: 'Usuarios', Granjas: 'Granjas', Perfiles: 'Fichas de línea', Listas: 'Listas',
    Sectores: 'Sectores', Naves: 'Naves', Lotes: 'Lotes', Pesajes: 'Pesajes', Ambiente: 'Lecturas de ambiente',
    Registros_Reproductora: 'Registros de reproductora', Registros_Incubadora: 'Registros de incubadora',
    Registros_Engorde: 'Registros de engorde', Registros_Postura: 'Registros de postura',
    PesosEstandar: 'Pesos estándar', Concentrado: 'Compras de concentrado',
    Enfermedades: 'Enfermedades', MetodosSerologia: 'Métodos serológicos', Serologias: 'Muestreos serológicos',
};
/** Una etiqueta por cada acción del servidor (los rechazos de cualquier acción quedan en Accesos). */
const ACCION_LABEL = {
    getSnapshot: 'Ingreso', passwordChanged: 'Cambio de contraseña',
    getRegistros: 'Consulta de registros', getResumen: 'Consulta de resumen', getBitacora: 'Consulta de bitácora',
    saveRegistro: 'Guardar registro', deleteRegistro: 'Eliminar registro', restoreRegistro: 'Restaurar registro',
    getPesajes: 'Consulta de pesajes', savePesaje: 'Guardar pesaje', deletePesaje: 'Eliminar pesaje',
    getAmbiente: 'Consulta de ambiente', saveLectura: 'Guardar lectura', deleteLectura: 'Eliminar lectura',
    saveSector: 'Guardar sector', setSectorEstado: 'Activar o desactivar sector', deleteSector: 'Eliminar sector',
    saveNave: 'Guardar nave', setNaveEstado: 'Activar o desactivar nave', deleteNave: 'Eliminar nave',
    saveLote: 'Guardar lote', cerrarLote: 'Cerrar lote', reabrirLote: 'Reabrir lote', deleteLote: 'Eliminar lote',
    saveGranja: 'Guardar granja', setGranjaEstado: 'Suspender o activar granja', deleteGranja: 'Eliminar granja',
    savePerfil: 'Guardar ficha', deletePerfil: 'Eliminar ficha',
    saveUser: 'Guardar usuario', setUserEstado: 'Suspender o activar usuario', resetPassword: 'Restablecer contraseña', deleteUser: 'Eliminar usuario',
    saveLista: 'Guardar valor de lista', deleteLista: 'Quitar valor de lista',
    getAccesos: 'Consulta de accesos', verifyAudit: 'Verificar integridad',
    getEstandares: 'Consulta de pesos estándar', saveEstandar: 'Guardar peso estándar', deleteEstandar: 'Borrar peso estándar',
    getConcentrado: 'Consulta de concentrado', saveCompra: 'Guardar compra de concentrado', deleteCompra: 'Eliminar compra de concentrado',
    getSerologias: 'Consulta de serología', saveSerologia: 'Guardar muestreo serológico', deleteSerologia: 'Eliminar muestreo serológico',
    saveMetodoSerologia: 'Guardar método serológico', deleteMetodoSerologia: 'Eliminar método serológico',
};
const RESULTADO_LABEL = {
    OK: 'Correcto', NOT_REGISTERED: 'Cuenta sin acceso', SUSPENDED: 'Acceso suspendido',
    ACCOUNT_LOCKED: 'Cuenta bloqueada por alteración', FORBIDDEN: 'Acción no permitida',
};

function auditHtml(r) {
    if (r.ok) return alertBox('ok', 'circle-check', `Todo íntegro. Verificado el ${esc(fmtDateTime(r.verificadoEn))}.`);
    const items = [];
    (r.bitacora?.errores || []).forEach(e => items.push(`Bitácora${e.fila ? `, fila ${e.fila}` : ''}: ${esc(e.motivo)}`));
    (r.alteradas || []).forEach(a => items.push(`${esc(TABLA_LABEL[a.tabla] || a.tabla)}, fila ${esc(a.fila)} (${esc(a.id)}): modificada fuera de la plataforma.`));
    (r.faltantes || []).forEach(f => items.push(`${esc(TABLA_LABEL[f.tabla] || f.tabla)} (${esc(f.id)}): ${esc(f.motivo)}`));
    return alertBox('danger', 'alert-triangle', 'Se detectaron cambios no autorizados. Las filas alteradas quedan bloqueadas hasta que el dueño de la base de datos las revise y apruebe.')
        + `<ul class="issue-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
}

// ==========================================================================
// 11. MODALES Y FORMULARIOS
// ==========================================================================

/**
 * Abre un modal con formulario. onSubmit(FormData, form) puede lanzar un error:
 * se muestra dentro del modal sin perder lo escrito.
 */
function openModal({ title, body, submitLabel = 'Guardar', danger = false, wide = false, onSubmit, cancelLabel = 'Cancelar' }) {
    const dlg = $('#modal');
    // El evento "close" del modal anterior puede llegar después de abrir este: se da por terminado
    // aquí, para que ese evento tardío no borre este contenido ni termine la promesa equivocada.
    terminarModal?.();
    dlg.className = `modal${wide ? ' modal-wide' : ''}`;
    dlg.innerHTML = `<form class="modal-card" novalidate>
        <header class="modal-head"><span></span><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">${ico('x')}</button></header>
        <div class="modal-body">${body}</div>
        <p class="form-error" role="alert" hidden></p>
        <footer class="modal-foot">
            ${cancelLabel ? `<button type="button" class="btn" data-close>${esc(cancelLabel)}</button>` : ''}
            ${onSubmit ? `<button type="submit" class="btn ${danger ? 'btn-danger btn-solid' : 'btn-primary'}">${esc(submitLabel)}</button>` : ''}
        </footer></form>`;

    return new Promise((resolve) => {
        const form = dlg.querySelector('form');
        let result = null;
        dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
        // Si al llegar el evento el diálogo ya está abierto otra vez, es el "close" tardío de un modal anterior.
        const alCerrar = () => { if (dlg.open) return; dlg.innerHTML = ''; terminar(); };
        const terminar = () => {
            dlg.removeEventListener('close', alCerrar);
            if (terminarModal === terminar) terminarModal = null;
            resolve(result);
        };
        terminarModal = terminar;
        dlg.addEventListener('close', alCerrar);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!onSubmit) return dlg.close();
            const err = form.querySelector('.form-error');
            if (!form.checkValidity()) {
                const bad = form.querySelector('.modal-body :invalid');
                const label = bad?.closest('.field')?.querySelector('span')?.textContent.replace('*', '').trim();
                err.textContent = label ? `${label}: ${validityMsg(bad)}` : 'Revisa los campos marcados.';
                err.hidden = false;
                bad?.focus();
                return;
            }
            const btn = form.querySelector('[type="submit"]');
            btn.disabled = true; btn.classList.add('is-loading'); err.hidden = true;
            try {
                result = (await onSubmit(new FormData(form), form)) ?? true;
                dlg.close();
            } catch (ex) {
                if (ex.code === 'BAD_RESPONSE') {
                    dlg.close();
                    toast(ex.message, 'info', 9000);
                    refreshAll().catch(() => {});
                    return;
                }
                err.textContent = ex.message; err.hidden = false;
            } finally {
                btn.disabled = false; btn.classList.remove('is-loading');
            }
        });
        dlg.showModal();
        form.querySelector('.modal-body input:not([disabled]):not([readonly]):not([type=hidden]), .modal-body select, .modal-body textarea')?.focus();
    });
}
function closeModal() { const d = $('#modal'); if (d.open) d.close(); }
/** Termina el modal en curso (quita su escucha de "close" y resuelve su promesa); ver openModal. */
let terminarModal = null;

/** Mensajes de validación propios (en español, sin depender del idioma del navegador). */
function validityMsg(el) {
    const v = el.validity;
    if (v.valueMissing) return 'es obligatorio.';
    if (v.badInput) return 'escribe un número válido.';
    if (v.tooShort) return `debe tener al menos ${el.minLength} caracteres.`;
    if (v.rangeUnderflow || v.rangeOverflow) return `debe estar entre ${nf.format(Number(el.min))} y ${nf.format(Number(el.max))}.`;
    if (v.stepMismatch) return 'debe ser un número entero.';
    if (v.typeMismatch) return el.type === 'email' ? 'escribe un correo válido.' : 'formato no válido.';
    if (v.patternMismatch) return 'formato no válido.';
    return 'valor no válido.';
}

function toast(msg, type = 'info', ms = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 220); }, ms);
}

function justField(help = 'Explica el motivo. Queda registrado en la bitácora.') {
    return `<label class="field span-all"><span>Justificación <span class="req">*</span></span>
        <textarea name="justificacion" required minlength="${CONFIG.MIN_JUSTIFICACION}" maxlength="1000"></textarea>
        <small class="field-hint">${esc(help)} Mínimo ${CONFIG.MIN_JUSTIFICACION} caracteres.</small></label>`;
}

function inputFor(c, value = '', { unidad = 'g' } = {}) {
    const req = c.req ? ' required' : '';
    const maxBase = c.peso && c.max !== undefined ? round(c.max / factorDe(unidad), 4) : c.max;
    const k = esc(c.k), min = esc(c.min ?? ''), max = esc(maxBase ?? '');
    const lbl = `<span>${esc(c.l)}${c.peso ? ` (<span data-unidad-label>${esc(unidad)}</span>)` : ''}${c.req ? ' <span class="req">*</span>' : ''}</span>`;
    const v = esc(value ?? '');
    if (c.t === 'textoLargo') return `<label class="field span-all">${lbl}<textarea name="${k}" maxlength="1000"${req}>${v}</textarea></label>`;
    if (c.t === 'entero' || c.t === 'numero') {
        return `<label class="field">${lbl}<input type="number" name="${k}"${c.peso ? ` data-peso data-max-g="${esc(c.max ?? '')}"` : ''} inputmode="${c.t === 'entero' ? 'numeric' : 'decimal'}" step="${c.t === 'entero' ? '1' : 'any'}"${min !== '' ? ` min="${min}"` : ''}${max !== '' ? ` max="${max}"` : ''} value="${v}"${req}></label>`;
    }
    if (c.t === 'fecha') return `<label class="field">${lbl}<input type="date" name="${k}" value="${v}"${req}></label>`;
    return `<label class="field">${lbl}<input type="text" name="${k}" maxlength="${esc(c.max || 150)}"${c.lista ? ` list="dl-${esc(c.lista)}"` : ''} value="${v}" autocomplete="off"${req}></label>`;
}

function datalists() {
    const tipos = [...new Set(state.db.listas.map(l => l.Tipo))];
    return tipos.map(t => `<datalist id="dl-${esc(t)}">${state.db.listas.filter(l => l.Tipo === t).map(l => `<option value="${esc(l.Valor)}"></option>`).join('')}</datalist>`).join('');
}

/** Guarda en el servidor, avisa y recarga. `snapshot` = también recargar granjas/usuarios/perfiles. */
async function save(action, payload, msg, { snapshot = true } = {}) {
    const r = await withBusy(() => api(action, payload));
    state.cache.clear();
    if (snapshot) await withBusy(() => loadSnapshot());
    if (msg) toast(typeof msg === 'function' ? msg(r) : msg, 'success');
    render();
    return r ?? true;
}

function formPayload(fd) {
    const o = {};
    fd.forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
    return o;
}

// ---------- Ubicación (nave + fecha) para registros y pesajes ----------
/** Selector de nave activa (agrupado por granja/sector) y fecha de trabajo. */
function ubicacionInputs(linea, { naveId = '', fecha = today(), conFecha = true, sinVentana = false } = {}) {
    const granjas = isAdmin() ? ctxIds() : [state.granjaId];
    const opciones = granjas.flatMap(gid => navesActivas(gid, linea).map(x => ({ gid, ...x })));
    if (!opciones.length) return null;
    const grupos = new Map();
    opciones.forEach(({ gid, s, n }) => {
        const k = `${granjas.length > 1 ? granjaName(gid) + ' · ' : ''}${s.Nombre}`;
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(n);
    });
    const elegida = naveId || (state.f.nave && opciones.some(o => o.n.NaveID === state.f.nave) ? state.f.nave : opciones[0].n.NaveID);
    const select = `<label class="field"><span>Nave <span class="req">*</span></span><select name="NaveID" required data-change="ubic-info">${[...grupos.entries()].map(([k, naves]) =>
        `<optgroup label="${esc(k)}">${naves.map(n => `<option value="${esc(n.NaveID)}"${n.NaveID === elegida ? ' selected' : ''}>${esc(n.Nombre)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
    const min = sinVentana ? '' : fechaMinima();
    const ayuda = sinVentana ? 'Día en que se tomaron las muestras (los resultados pueden llegar después).'
        : isAdmin() ? 'Hoy o cualquier día anterior.' : `Hoy o hasta ${state.db.diasRetroactivos} días atrás.`;
    const fechaHtml = conFecha ? `<label class="field"><span>${sinVentana ? 'Fecha del muestreo' : 'Fecha'} <span class="req">*</span></span><input type="date" name="Fecha" required value="${esc(fecha)}" max="${today()}"${min ? ` min="${min}"` : ''} data-change="ubic-info">
        <small class="field-hint">${ayuda}</small></label>` : '';
    return `${select}${fechaHtml}<div class="span-all" data-ubic-info>${infoUbicacion(elegida, fecha)}</div>`;
}
function infoUbicacion(naveId, fecha) {
    const n = naveById(naveId);
    if (!n) return '';
    const l = loteEn(naveId, fecha);
    if (!l) return `<div class="alert alert-warn">${ico('alert-triangle')}<span>${esc(n.Nombre)} no tenía un lote activo el ${esc(fmtDate(fecha))}. Inicia el lote en la vista de la granja.</span></div>`;
    const dias = edadDias(l, fecha);
    const tipo = tipoEstandar(n.Linea);
    const esp = esperado(l.LineaGenetica, tipo, dias);
    const costo = toNum(l.CostoPorAve);
    let extra = costo !== null ? ` · ${esc(fmtQ(costo))} por ave` : '';
    let boton = '';
    if (tipo && dias === null) {
        extra += '<br>El lote no tiene la edad de las aves al iniciar: sin ella no se compara con la tabla de su línea genética.';
        boton = `<button type="button" class="btn btn-sm" data-action="lote-desde-form" data-id="${esc(l.LoteID)}">${ico('tag')}Completar el lote</button>`;
    } else if (tipo) {
        extra += `<br>Edad: <strong>${esc(textoEdad(dias))}</strong>` + (esp
            ? ` · Peso esperado (${esc(l.LineaGenetica)}): <strong>${esc(fmtPeso(esp.estandarG))}</strong>${esp.minimoG !== null ? ` (rango ${esc(fmtPeso(esp.minimoG))} – ${esc(fmtPeso(esp.maximoG))})` : ''}`
            : ` · Sin tabla de peso de ${esc(l.LineaGenetica)} para esta edad.`);
    }
    return `<div class="alert alert-info">${ico('tag')}<span>Lote <strong>${esc(l.NumeroLote)}</strong> · Línea genética <strong>${esc(l.LineaGenetica)}</strong> · desde ${esc(fmtDate(l.FechaInicio))}${extra}</span>${boton}</div>`;
}
/** Peso esperado (g) de la nave en esa fecha, según la línea genética de su lote y la edad. */
function esperadoPesaje(naveId, fecha) {
    const n = naveById(naveId);
    const l = n && loteEn(naveId, fecha);
    return l ? esperado(l.LineaGenetica, tipoEstandar(n.Linea), edadDias(l, fecha)) : null;
}
/** Estado del promedio (g) contra el rango: igual que el servidor. */
function estadoPeso(promG, esp) {
    if (!esp) return 'Sin tabla';
    if (esp.minimoG === null || esp.maximoG === null) return 'Sin rango';
    return promG < esp.minimoG ? 'Bajo' : promG > esp.maximoG ? 'Sobre' : 'Dentro';
}
/** Registro: si el lote tiene edad inicial, "Edad (semanas)" se calcula y no se escribe. */
function syncEdadRegistro(form, lote, fecha) {
    const input = form?.elements.EdadSemanas;
    if (!input) return;
    const dias = edadDias(lote, fecha);
    input.readOnly = dias !== null;
    if (dias !== null) input.value = String(round(dias / 7, 1));
    else if (input.dataset.auto) input.value = '';
    input.dataset.auto = dias !== null ? '1' : '';
    input.title = dias !== null ? 'Se calcula con la edad del lote' : '';
}

// ---------- Registros ----------
async function openRegistroModal(reg = null) {
    const linea = state.linea;
    const campos = camposEntrada(linea);
    const calculados = camposDe(linea).filter(c => c.calc);
    const conPeso = campos.some(c => c.peso);
    const unidad = state.unidad;
    let ubic;
    if (reg) {
        ubic = `<label class="field"><span>Granja</span><input value="${esc(granjaName(reg.GranjaID))}" readonly></label>
            <label class="field"><span>Sector / nave</span><input value="${esc([reg.Sector, reg.Nave].filter(Boolean).join(' / ') || '—')}" readonly></label>
            <label class="field"><span>Lote</span><input value="${esc([reg.NumeroLote, reg.LineaGenetica].filter(Boolean).join(' · ') || '—')}" readonly></label>
            <label class="field"><span>Fecha</span><input value="${esc(fmtDate(reg.Fecha))}" readonly></label>`;
    } else {
        ubic = ubicacionInputs(linea);
        if (!ubic) return toast(`No hay naves activas de ${linea.toLowerCase()} donde registrar.`, 'error');
    }
    // Grupos de campos: generales, propios de la línea y observaciones.
    const zoo = new Set(camposEntrada('Engorde').map(c => c.k));
    const generales = campos.filter(c => (linea === 'Incubadora' ? ['NumeroAves', 'EdadSemanas', 'MortalidadPorcentaje'].includes(c.k) : zoo.has(c.k)) && c.k !== 'Comentarios');
    const propios = campos.filter(c => !generales.includes(c) && c.k !== 'Comentarios');
    const valor = c => (c.peso ? (reg ? round(enUnidad(reg[c.k], unidad), 4) : '') : reg?.[c.k]);
    const sec = (title, icon, list) => (list.length ? `<section class="form-section"><h3>${ico(icon)}${esc(title)}</h3><div class="form-grid">${list.map(c => inputFor(c, valor(c), { unidad })).join('')}</div></section>` : '');
    const body = `<section class="form-section"><div class="form-grid">${ubic}</div></section>
        ${conPeso ? `<section class="form-section"><div class="row row-center"><span class="field-label">Los pesos de este formulario están en</span>${unidadSelect('UnidadPeso', unidad)}</div></section>` : ''}
        ${sec('Datos zootécnicos', LINEA_ICON[linea], generales)}
        ${sec(linea === 'Postura' ? 'Producción de huevo' : linea === 'Incubadora' ? 'Incubación' : 'Otros datos', linea === 'Postura' ? 'egg' : 'archive', propios)}
        ${sec('Observaciones', 'clipboard-list', campos.filter(c => c.k === 'Comentarios'))}
        ${calculados.length ? alertBox('info', 'info', `Se calculan automáticamente: ${calculados.map(c => esc(c.l)).join(', ')}.`) : ''}
        ${reg ? `<section class="form-section">${justField('Explica qué se corrige y por qué.')}</section>` : ''}`;

    const promesa = openModal({
        title: reg ? `Editar registro de ${linea.toLowerCase()}` : `Nuevo registro de ${linea.toLowerCase()}`,
        wide: true, body, submitLabel: reg ? 'Guardar cambios' : 'Guardar registro',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            const payload = { ...p, Linea: linea };
            if (reg) payload.RegistroID = reg.RegistroID;
            const aves = toNum(p.NumeroAves), muertas = toNum(p.MortalidadNominal);
            if (aves !== null && muertas !== null && muertas > aves) throw new Error('La mortalidad no puede ser mayor que el número de aves.');
            const inc = toNum(p.HuevoIncubable), nac = toNum(p.Nacimiento);
            if (inc !== null && nac !== null && nac > inc) throw new Error('Los nacimientos no pueden ser más que los huevos incubables.');
            await save('saveRegistro', payload, reg ? 'Registro actualizado.' : 'Registro guardado.', { snapshot: false });
        },
    });
    const form = $('#modal form');
    if (reg) syncEdadRegistro(form, loteById(reg.LoteID), reg.Fecha);
    else if (form) syncEdadRegistro(form, loteEn(form.NaveID.value, form.Fecha.value), form.Fecha.value);
    await promesa;
}

function unidadSelect(name, actual) {
    return `<select class="select select-inline" name="${esc(name)}" data-change="form-unidad" data-prev="${esc(actual)}" aria-label="Unidad de peso">${Object.keys(UNIDADES).map(u =>
        `<option value="${u}"${u === actual ? ' selected' : ''}>${UNIDAD_NOMBRE[u]} (${u})</option>`).join('')}</select>`;
}

async function deleteRegistroFlow(reg) {
    await openModal({
        title: 'Eliminar registro', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">Registro del <strong>${esc(fmtDate(reg.Fecha))}</strong> · ${esc([granjaName(reg.GranjaID), reg.Sector, reg.Nave].filter(Boolean).join(' / '))} · ${esc(fmtNum(reg.NumeroAves))} aves.</p>
            <p class="muted center">Dejará de verse y de contarse en el dashboard. Queda guardado en el historial${isAdmin() ? ' y puedes restaurarlo' : ' y la administración puede restaurarlo'}.</p>
            ${justField()}`,
        onSubmit: async fd => save('deleteRegistro', { Linea: state.linea, RegistroID: reg.RegistroID, justificacion: fd.get('justificacion') }, 'Registro eliminado.', { snapshot: false }),
    });
}

async function restoreRegistroFlow(reg) {
    await openModal({
        title: 'Restaurar registro', submitLabel: 'Restaurar',
        body: `<p class="center">Registro del <strong>${esc(fmtDate(reg.Fecha))}</strong> · ${esc([granjaName(reg.GranjaID), reg.Sector, reg.Nave].filter(Boolean).join(' / '))}.</p>${justField()}`,
        onSubmit: async fd => save('restoreRegistro', { Linea: state.linea, RegistroID: reg.RegistroID, justificacion: fd.get('justificacion') }, 'Registro restaurado.', { snapshot: false }),
    });
}

// ---------- Pesajes por muestra ----------
const borradorKey = (naveId, fecha) => `granjas.pesaje.${naveId}.${fecha}`;
function leerBorrador(naveId, fecha) {
    try { return JSON.parse(sessionStorage.getItem(borradorKey(naveId, fecha)) || 'null'); } catch { return null; }
}
function guardarBorrador() {
    if (!pz || pz.editando || !pz.naveId) return;
    try { sessionStorage.setItem(borradorKey(pz.naveId, pz.fecha), JSON.stringify({ unidad: pz.unidad, muestra: pz.muestra, pesos: pz.pesos })); } catch { /* sin almacenamiento */ }
}
function borrarBorrador(naveId, fecha) {
    try { sessionStorage.removeItem(borradorKey(naveId, fecha)); } catch { /* sin almacenamiento */ }
}

/** Estadísticas de la muestra en la unidad de captura (las mismas fórmulas que el servidor). */
function statsMuestra(pesos) {
    if (!pesos.length) return null;
    const prom = pesos.reduce((a, b) => a + b, 0) / pesos.length;
    const sd = pesos.length > 1 ? Math.sqrt(pesos.reduce((a, v) => a + (v - prom) ** 2, 0) / (pesos.length - 1)) : 0;
    const dentro = pesos.filter(v => Math.abs(v - prom) <= prom * 0.1).length;
    return { prom, min: Math.min(...pesos), max: Math.max(...pesos), cv: prom ? sd / prom * 100 : 0, unif: dentro / pesos.length * 100 };
}

function pzRender() {
    const box = $('[data-pz]');
    if (!box || !pz) return;
    const n = pz.pesos.length;
    const total = pz.muestra || 0;
    const quien = pz.tipo === 'huevo' ? 'huevo' : 'ave';
    box.querySelector('[data-pz-count]').textContent = `${nf.format(n)} de ${nf.format(total)}`;
    box.querySelector('[data-pz-bar]').style.width = `${total ? Math.min(100, n / total * 100) : 0}%`;
    box.querySelector('[data-pz-bar]').classList.toggle('is-full', n === total && total > 0);
    const input = box.querySelector('#pz-input');
    input.placeholder = n < total ? `Peso del ${quien} #${n + 1} (${pz.unidad})` : 'Muestra completa';
    input.disabled = n >= total;
    const st = statsMuestra(pz.pesos);
    const f = v => new Intl.NumberFormat('es-GT', { maximumFractionDigits: pz.unidad === 'g' ? 1 : 3 }).format(v);
    // Comparación en vivo con el peso esperado de la línea genética (en la unidad de captura).
    const esp = pz.tipo === 'huevo' ? null : pz.esperado;
    const promG = st ? st.prom * factorDe(pz.unidad) : null;
    const comparacion = st && esp ? (() => {
        const dif = promG - esp.estandarG;
        const estado = estadoPeso(promG, esp);
        return `<div><dt>Esperado</dt><dd>${esc(fmtPeso(esp.estandarG, pz.unidad))}</dd></div>
            <div><dt>Diferencia</dt><dd>${esc(`${dif >= 0 ? '+' : ''}${fmtPeso(dif, pz.unidad)} (${dif >= 0 ? '+' : ''}${fmtNum(dif / esp.estandarG * 100)} %)`)}</dd></div>
            <div><dt>Estado</dt><dd>${badgeEstadoPeso(estado)}</dd></div>`;
    })() : '';
    box.querySelector('[data-pz-stats]').innerHTML = st
        ? [['Promedio', `${f(st.prom)} ${pz.unidad}`], ['Mínimo', `${f(st.min)} ${pz.unidad}`], ['Máximo', `${f(st.max)} ${pz.unidad}`], ['CV', `${fmtNum(st.cv)} %`], ['Uniformidad', `${fmtNum(st.unif)} %`]]
            .map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join('') + comparacion
        : `<p class="muted center">Ingresa el primer peso.${esp ? ` Peso esperado: ${esc(fmtPeso(esp.estandarG, pz.unidad))}${esp.minimoG !== null ? ` (rango ${esc(fmtPeso(esp.minimoG, pz.unidad))} – ${esc(fmtPeso(esp.maximoG, pz.unidad))})` : ''}.` : ''}</p>`;
    box.querySelector('[data-pz-list]').innerHTML = pz.pesos.map((v, i) =>
        `<li><span class="pz-num">${i + 1}</span>${esc(f(v))}<button type="button" class="icon-btn icon-btn-sm danger" data-action="pz-del" data-i="${i}" aria-label="Quitar el peso ${i + 1}" title="Quitar">${ico('x')}</button></li>`).join('');
    const excedente = n > total;
    box.querySelector('[data-pz-aviso]').innerHTML = excedente ? alertBox('warn', 'alert-triangle', `Hay ${n - total} peso(s) de más para una muestra de ${total}. Quita los sobrantes o aumenta la muestra.`) : '';
    guardarBorrador();
}

/** Agrega uno o varios pesos (separados por espacio, coma, punto y coma o salto de línea). */
function pzAgregar(texto) {
    if (!pz) return;
    const partes = String(texto).split(/[\s;,]+/).map(s => s.trim()).filter(Boolean);
    const malos = [];
    partes.forEach((s) => {
        const v = Number(s);
        if (!Number.isFinite(v) || v <= 0) { malos.push(s); return; }
        if (pz.pesos.length < pz.muestra) pz.pesos.push(v);
    });
    if (malos.length) toast(`No se agregaron valores no válidos: ${malos.slice(0, 5).join(' ')}`, 'error');
    pzRender();
}

async function openPesajeModal(pes = null) {
    const linea = pes ? pes.Linea : state.linea;
    const tipo = linea === 'Incubadora' ? 'huevo' : 'ave';
    let ubic;
    if (pes) {
        ubic = `<label class="field"><span>Sector / nave</span><input value="${esc([pes.Sector, pes.Nave].join(' / '))}" readonly></label>
            <label class="field"><span>Fecha</span><input value="${esc(fmtDate(pes.Fecha))}" readonly></label>`;
    } else {
        ubic = ubicacionInputs(linea);
        if (!ubic) return toast(`No hay naves activas de ${linea.toLowerCase()}.`, 'error');
    }
    pz = pes
        ? { editando: true, tipo, unidad: pes.Unidad || 'g', muestra: toNum(pes.Muestra) || 0, pesos: String(pes.Pesos || '').split(',').map(Number).filter(Number.isFinite) }
        : { editando: false, tipo, unidad: state.unidad === 'g' || tipo === 'huevo' ? 'g' : state.unidad, muestra: 100, pesos: [] };
    const body = `<section class="form-section"><div class="form-grid">${ubic}</div></section>
        <section class="form-section"><h3>${ico('list-checks')}Muestra</h3><div class="form-grid">
            <label class="field"><span>Unidad de pesaje <span class="req">*</span></span><select name="Unidad" data-change="pz-config">${Object.keys(UNIDADES).map(u => `<option value="${u}"${u === pz.unidad ? ' selected' : ''}>${UNIDAD_NOMBRE[u]} (${u})</option>`).join('')}</select>
                <small class="field-hint">Se usa para toda la muestra.</small></label>
            <label class="field"><span>Tamaño de la muestra <span class="req">*</span></span><input type="number" name="Muestra" min="1" max="${state.db.maxMuestra}" step="1" inputmode="numeric" required value="${pz.muestra}" data-change="pz-config">
                <small class="field-hint">Número de ${tipo === 'huevo' ? 'huevos' : 'aves'} que se van a pesar.</small></label>
        </div></section>
        <section class="form-section pz" data-pz>
            <h3>${ico('scale')}Peso de cada ${tipo}</h3>
            <div class="pz-progress"><div class="pz-bar" data-pz-bar></div></div>
            <p class="center"><strong data-pz-count></strong> pesados</p>
            <div class="pz-entrada">
                <input id="pz-input" class="input" type="text" inputmode="decimal" autocomplete="off" aria-label="Peso">
                <button type="button" class="btn btn-primary" data-action="pz-add">${ico('plus')}Agregar</button>
                <button type="button" class="btn" data-action="pz-undo" title="Quitar el último">${ico('undo')}Deshacer</button>
            </div>
            <small class="field-hint center">Presiona Enter después de cada peso. También puedes pegar varios separados por espacios o comas.</small>
            <div data-pz-aviso></div>
            <dl class="kv pz-stats" data-pz-stats></dl>
            <ol class="pz-list" data-pz-list></ol>
        </section>
        ${pes ? `<section class="form-section">${justField('Explica qué se corrige (por ejemplo, un peso mal digitado).')}</section>` : ''}`;

    // Si hay una muestra a medias guardada en este dispositivo, se recupera.
    if (!pes) {
        const sel = /name="NaveID"[^>]*>[\s\S]*?<option value="([^"]+)" selected/.exec(ubic);
        const b = sel && leerBorrador(sel[1], today());
        if (b && b.pesos?.length) { Object.assign(pz, { unidad: b.unidad, muestra: b.muestra, pesos: b.pesos }); setTimeout(() => toast(`Se recuperó una muestra sin guardar (${b.pesos.length} pesos).`, 'info'), 300); }
    }

    const promesa = openModal({
        title: pes ? 'Editar pesaje' : `Nuevo pesaje · ${linea.toLowerCase()}`, wide: true, body,
        submitLabel: pes ? 'Guardar cambios' : 'Guardar pesaje',
        onSubmit: async (fd) => {
            pz.unidad = fd.get('Unidad');
            pz.muestra = toNum(fd.get('Muestra'));
            if (pz.pesos.length !== pz.muestra) {
                throw new Error(`La muestra es de ${pz.muestra} y hay ${pz.pesos.length} pesos. Deben ser exactamente ${pz.muestra}.`);
            }
            const payload = { Unidad: pz.unidad, Muestra: pz.muestra, Pesos: pz.pesos };
            if (pes) Object.assign(payload, { PesajeID: pes.PesajeID, justificacion: fd.get('justificacion') });
            else Object.assign(payload, { Linea: linea, NaveID: fd.get('NaveID'), Fecha: fd.get('Fecha') });
            await save('savePesaje', payload, pes ? 'Pesaje actualizado.' : 'Pesaje guardado.', { snapshot: false });
            if (!pes) borrarBorrador(payload.NaveID, payload.Fecha);
        },
    });
    const form = $('#modal form');
    if (!pes && form) { pz.naveId = form.NaveID.value; pz.fecha = form.Fecha.value; pz.esperado = esperadoPesaje(pz.naveId, pz.fecha); }
    if (pes) {
        const l = loteById(pes.LoteID);
        pz.esperado = l ? esperado(l.LineaGenetica, tipoEstandar(pes.Linea), edadDias(l, pes.Fecha)) : null;
    }
    pzRender();
    $('#pz-input')?.focus();
    await promesa;
    pz = null;
}

async function verPesajeModal(pes) {
    const valores = String(pes.Pesos || '').split(',').filter(Boolean);
    await openModal({
        title: `Pesaje del ${fmtDate(pes.Fecha)}`, cancelLabel: 'Cerrar', wide: true,
        body: `<p class="center">${esc([granjaName(pes.GranjaID), pes.Sector, pes.Nave, pes.NumeroLote ? 'Lote ' + pes.NumeroLote : ''].filter(Boolean).join(' / '))}</p>
            <dl class="kv">${[['Muestra', pes.Muestra], ['Promedio', fmtPeso(pes.PromedioG)], ['Mínimo', fmtPeso(pes.MinimoG)], ['Máximo', fmtPeso(pes.MaximoG)],
            ['CV', `${fmtNum(pes.CV)} %`], ['Uniformidad', `${fmtNum(pes.Uniformidad)} %`], ['Conversión alimenticia', pes.ConversionAlimenticia ? fmtNum(pes.ConversionAlimenticia) : '—']]
            .map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
            <section class="form-section"><h3>${ico('list-checks')}Pesos individuales (${esc(pes.Unidad)})</h3>
            <ol class="pz-list">${valores.map((v, i) => `<li><span class="pz-num">${i + 1}</span>${esc(v)}</li>`).join('')}</ol></section>`,
    });
}

async function deletePesajeFlow(pes) {
    await openModal({
        title: 'Eliminar pesaje', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">Pesaje del <strong>${esc(fmtDate(pes.Fecha))}</strong> · ${esc([pes.Sector, pes.Nave].join(' / '))} · muestra de ${esc(pes.Muestra)}.</p>${justField()}`,
        onSubmit: async fd => save('deletePesaje', { PesajeID: pes.PesajeID, justificacion: fd.get('justificacion') }, 'Pesaje eliminado.', { snapshot: false }),
    });
}

// ---------- Ambiente (estrés calórico) ----------
async function openLecturaModal() {
    const ubic = ubicacionInputs(state.linea, { conFecha: false });
    if (!ubic) return toast('No hay naves activas.', 'error');
    await openModal({
        title: 'Nueva lectura de ambiente',
        body: `<div class="form-grid">${ubic}
            <label class="field"><span>Temperatura ambiente en grados Celsius (°C) <span class="req">*</span></span><input type="number" name="Temperatura" step="any" min="-20" max="60" inputmode="decimal" required data-input="iec-calc">
                <small class="field-hint">Escríbela en °C (no en °F).</small></label>
            <label class="field"><span>Humedad relativa (%) <span class="req">*</span></span><input type="number" name="Humedad" step="any" min="0" max="100" inputmode="decimal" required data-input="iec-calc"></label>
            <div class="span-all" data-iec-preview><p class="muted center">IEC = temperatura (°C) + humedad (%).</p></div>
        </div>
        <p class="muted center">La fecha y la hora se registran automáticamente al guardar.</p>`,
        submitLabel: 'Guardar lectura',
        onSubmit: async fd => save('saveLectura', { NaveID: fd.get('NaveID'), Temperatura: fd.get('Temperatura'), Humedad: fd.get('Humedad') }, (r) => `Lectura guardada: IEC ${fmtNum(r.Indice)} (${r.Nivel}).`, { snapshot: false }),
    });
}

async function deleteLecturaFlow(x) {
    await openModal({
        title: 'Eliminar lectura', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">${esc(fmtDateTime(x.FechaHora))} · ${esc([x.Sector, x.Nave].join(' / '))} · IEC ${esc(fmtNum(x.Indice))}.</p>${justField()}`,
        onSubmit: async fd => save('deleteLectura', { LecturaID: x.LecturaID, justificacion: fd.get('justificacion') }, 'Lectura eliminada.', { snapshot: false }),
    });
}

// ---------- Estructura: sectores, naves y lotes ----------
async function openSectorModal(granjaId, linea, s = null) {
    await openModal({
        title: s ? `Renombrar ${s.Nombre}` : `Nuevo sector · ${linea.toLowerCase()}`,
        body: `<div class="form-grid"><label class="field span-all"><span>Nombre del sector <span class="req">*</span></span><input name="Nombre" required maxlength="80" value="${esc(s?.Nombre || '')}" autocomplete="off"></label>
            ${s ? justField('Los registros anteriores conservan el nombre que tenían.') : ''}</div>`,
        submitLabel: s ? 'Guardar' : 'Crear sector',
        onSubmit: async (fd) => {
            const p = { Nombre: fd.get('Nombre') };
            if (s) Object.assign(p, { SectorID: s.SectorID, justificacion: fd.get('justificacion') });
            else Object.assign(p, { GranjaID: granjaId, Linea: linea });
            await save('saveSector', p, s ? 'Sector renombrado.' : 'Sector creado.');
        },
    });
}

async function openNaveModal(sectorId, n = null) {
    const s = sectorById(sectorId || n?.SectorID);
    await openModal({
        title: n ? `Renombrar ${n.Nombre}` : `Nueva nave en ${s?.Nombre || ''}`,
        body: `<div class="form-grid"><label class="field span-all"><span>Nombre de la nave <span class="req">*</span></span><input name="Nombre" required maxlength="80" value="${esc(n?.Nombre || '')}" autocomplete="off"></label>
            ${n ? justField('Los registros anteriores conservan el nombre que tenían.') : ''}</div>`,
        submitLabel: n ? 'Guardar' : 'Crear nave',
        onSubmit: async (fd) => {
            const p = { Nombre: fd.get('Nombre') };
            if (n) Object.assign(p, { NaveID: n.NaveID, justificacion: fd.get('justificacion') });
            else p.SectorID = sectorId;
            await save('saveNave', p, n ? 'Nave renombrada.' : 'Nave creada.');
        },
    });
}

/** Activar/desactivar un sector o una nave (lo pasado no cambia; lo nuevo se bloquea). */
async function estadoEstructuraFlow(tipo, row) {
    const activar = row.Estado !== 'Activo';
    const nombre = tipo === 'sector' ? 'el sector' : 'la nave';
    await openModal({
        title: `${activar ? 'Activar' : 'Desactivar'} ${row.Nombre}`, danger: !activar, submitLabel: activar ? 'Activar' : 'Desactivar',
        body: `<p class="center">${activar ? `Se podrán volver a ingresar datos en ${nombre}.` : `No se podrán ingresar datos nuevos en ${nombre}${tipo === 'sector' ? ' ni en sus naves' : ''}. Todo su historial se conserva y sigue visible.`}</p>${justField()}`,
        onSubmit: async (fd) => {
            const p = { Estado: activar ? 'Activo' : 'Inactivo', justificacion: fd.get('justificacion') };
            if (tipo === 'sector') p.SectorID = row.SectorID; else p.NaveID = row.NaveID;
            await save(tipo === 'sector' ? 'setSectorEstado' : 'setNaveEstado', p, activar ? 'Activado.' : 'Desactivado.');
        },
    });
}

async function deleteEstructuraFlow(tipo, row) {
    await openModal({
        title: `Eliminar ${row.Nombre}`, danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">Solo es posible si ${tipo === 'sector' ? 'el sector no tiene naves' : 'la nave nunca tuvo lotes ni datos'}. Si ya se usó, desactívala para conservar el historial.</p>${justField()}`,
        onSubmit: async (fd) => {
            const p = { justificacion: fd.get('justificacion') };
            if (tipo === 'sector') p.SectorID = row.SectorID; else p.NaveID = row.NaveID;
            await save(tipo === 'sector' ? 'deleteSector' : 'deleteNave', p, 'Eliminado.');
        },
    });
}

/** Opciones de línea genética según la línea de producción (desplegable con grupos). */
function geneticaSelect(linea, actual = '') {
    const tipos = state.db.geneticaDe?.[linea] || [];
    const grupos = tipos.map(t => [t, state.db.listas.filter(l => l.Tipo === t).sort((a, b) => String(a.Valor).localeCompare(String(b.Valor), 'es', { numeric: true }))]);
    return `<select name="LineaGenetica" required><option value="">Elige la línea genética…</option>${grupos.map(([t, vals]) =>
        `<optgroup label="${esc(LISTA_LABEL[t] || t)}">${vals.map(v => `<option${v.Valor === actual ? ' selected' : ''}>${esc(v.Valor)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}

async function openLoteModal(naveId, lote = null) {
    const n = naveById(naveId || lote?.NaveID);
    // Al iniciar es obligatoria (salvo Incubadora, que pesa huevos); un lote anterior se edita sin ella.
    const edadObligatoria = !lote && n?.Linea !== 'Incubadora';
    await openModal({
        title: lote ? `Editar lote ${lote.NumeroLote}` : `Iniciar lote en ${n?.Nombre || ''}`,
        body: `<div class="form-grid">
            <label class="field"><span>Número de lote <span class="req">*</span></span><input name="NumeroLote" required maxlength="60" value="${esc(lote?.NumeroLote || '')}" autocomplete="off"></label>
            <label class="field"><span>Línea genética <span class="req">*</span></span>${geneticaSelect(n.Linea, lote?.LineaGenetica)}</label>
            <label class="field"><span>Fecha de inicio <span class="req">*</span></span><input type="date" name="FechaInicio" required max="${today()}" value="${esc(lote?.FechaInicio || today())}"></label>
            <label class="field"><span>Aves iniciales</span><input type="number" name="AvesIniciales" min="0" step="1" inputmode="numeric" value="${esc(lote?.AvesIniciales || '')}"></label>
            <label class="field"><span>Edad de las aves al iniciar (semanas)${edadObligatoria ? ' <span class="req">*</span>' : ''}</span><input type="number" name="EdadInicialSemanas" min="0" max="200" step="any" inputmode="decimal" value="${esc(lote?.EdadInicialSemanas ?? '')}"${edadObligatoria ? ' required' : ''}>
                <small class="field-hint">0 si son pollitos de un día; por ejemplo 17 si llegan pollas a postura. Con ella se calcula la edad de cada pesaje.</small></label>
            <label class="field"><span>Costo por ave (Q)${lote ? '' : ' <span class="req">*</span>'}</span><input type="number" name="CostoPorAve" min="0" max="100000" step="0.01" inputmode="decimal" value="${esc(lote?.CostoPorAve ?? '')}"${lote ? '' : ' required'}></label>
            ${lote ? justField('Si cambias el número de lote o la línea genética, se actualizan también sus registros y pesajes.') : ''}
        </div>
        ${lote ? '' : '<p class="muted center">La nave solo puede tener un lote activo. Ciérralo cuando termine para iniciar el siguiente.</p>'}`,
        submitLabel: lote ? 'Guardar cambios' : 'Iniciar lote',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            if (lote) p.LoteID = lote.LoteID; else p.NaveID = n.NaveID;
            await save('saveLote', p, lote ? 'Lote actualizado.' : 'Lote iniciado.');
        },
    });
}

async function cerrarLoteFlow(lote) {
    await openModal({
        title: `Cerrar lote ${lote.NumeroLote}`, submitLabel: 'Cerrar lote',
        body: `<div class="form-grid"><label class="field span-all"><span>Fecha de cierre <span class="req">*</span></span><input type="date" name="FechaCierre" required min="${esc(lote.FechaInicio)}" max="${today()}" value="${today()}"></label>
            <label class="field span-all"><span>Comentario</span><textarea name="justificacion" maxlength="1000"></textarea></label></div>
            <p class="muted center">Después del cierre no se podrán ingresar datos de este lote. Sus datos se conservan.</p>`,
        onSubmit: async fd => save('cerrarLote', { LoteID: lote.LoteID, FechaCierre: fd.get('FechaCierre'), justificacion: fd.get('justificacion') }, 'Lote cerrado.'),
    });
}

async function reabrirLoteFlow(lote) {
    await openModal({
        title: `Reabrir lote ${lote.NumeroLote}`, submitLabel: 'Reabrir',
        body: `<p class="center">El lote volverá a quedar activo y se podrán ingresar datos.</p>${justField()}`,
        onSubmit: async fd => save('reabrirLote', { LoteID: lote.LoteID, justificacion: fd.get('justificacion') }, 'Lote reabierto.'),
    });
}

// ---------- Granjas ----------
async function openGranjaModal(g = null) {
    const f = (k, l, attrs = '', req = false) => `<label class="field"><span>${l}${req ? ' <span class="req">*</span>' : ''}</span><input name="${k}" value="${esc(g?.[k] || '')}" ${attrs}${req ? ' required' : ''}></label>`;
    await openModal({
        title: g ? `Editar ${g.NombreGranja}` : 'Nueva granja', wide: true,
        body: `<div class="form-grid">
            ${f('NombreGranja', 'Nombre de la granja', 'maxlength="150" autocomplete="off"', true)}
            ${f('Propietario', 'Propietario', 'maxlength="150"')}
            ${f('Ubicacion', 'Ubicación', 'maxlength="250"')}
            ${f('Telefono', 'Teléfono', 'type="tel" inputmode="tel" maxlength="30" pattern="[0-9+()\\-\\s]{6,30}"')}
            ${f('EmailContacto', 'Correo de contacto', 'type="email" maxlength="254"')}
            <label class="field span-all"><span>Notas</span><textarea name="Notas" maxlength="1000">${esc(g?.Notas || '')}</textarea></label>
            ${g ? justField() : ''}</div>
            ${g ? '' : '<p class="muted center">Después de crearla, agrega su ficha de postura y/o de engorde desde la vista de la granja.</p>'}`,
        submitLabel: g ? 'Guardar cambios' : 'Crear granja',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            if (g) p.GranjaID = g.GranjaID;
            const r = await save('saveGranja', p, g ? 'Granja actualizada.' : 'Granja creada.');
            if (!g && r?.GranjaID) go('granja', r.GranjaID);
        },
    });
}

async function estadoGranjaFlow(g) {
    const activar = g.Estado !== 'Activo';
    await openModal({
        title: `${activar ? 'Activar' : 'Suspender'} ${g.NombreGranja}`, danger: !activar, submitLabel: activar ? 'Activar' : 'Suspender',
        body: `<p class="center">${activar ? 'Sus representantes volverán a tener acceso.' : 'Sus representantes perderán el acceso de inmediato. Los datos se conservan.'}</p>${justField()}`,
        onSubmit: async fd => save('setGranjaEstado', { GranjaID: g.GranjaID, Estado: activar ? 'Activo' : 'Suspendido', justificacion: fd.get('justificacion') }, activar ? 'Granja activada.' : 'Granja suspendida.'),
    });
}

async function deleteGranjaFlow(g) {
    await openModal({
        title: `Eliminar ${g.NombreGranja}`, danger: true, submitLabel: 'Eliminar granja',
        body: '<p class="center">Solo es posible si la granja no tiene registros de producción. Se eliminan también sus fichas. Si tiene registros, suspéndela.</p>' + justField(),
        onSubmit: async (fd) => {
            await save('deleteGranja', { GranjaID: g.GranjaID, justificacion: fd.get('justificacion') }, 'Granja eliminada.');
            go('granjas');
        },
    });
}

// ---------- Perfiles (ficha de cada línea) ----------
async function openPerfilModal(granjaId, linea, p = null) {
    const g = granjaById(granjaId);
    const fuentes = p ? [] : LINEAS.filter(l => l !== linea).map(l => perfilDe(granjaId, l)).filter(Boolean);
    const secciones = [];
    state.db.campos.perfil.forEach((c) => {
        let s = secciones.find(x => x.s === c.s);
        if (!s) { s = { s: c.s, campos: [] }; secciones.push(s); }
        s.campos.push(c);
    });
    // Valores sugeridos al crear: los datos de la granja (el resto se puede copiar de la otra línea).
    const inicial = p || { NombreGranja: g?.NombreGranja || '', Ubicacion: g?.Ubicacion || '' };
    const body = (fuentes.length ? alertBox('info', 'copy', `Puedes partir de otra ficha de esta granja y luego ajustarla: ${fuentes.map(f => `<button type="button" class="btn btn-sm" data-action="copy-perfil" data-from="${esc(f.PerfilID)}">${ico(LINEA_ICON[f.Linea])}${esc(f.Linea)}</button>`).join(' ')}`) : '')
        + secciones.map(s => `<section class="form-section"><h3>${ico(SECCION_ICON[s.s] || 'list')}${esc(s.s)}</h3><div class="form-grid">${s.campos.map(c => inputFor(c, inicial[c.k])).join('')}</div></section>`).join('')
        + (p ? `<section class="form-section"><div class="form-grid">${justField('Explica qué se actualiza (por ejemplo, un lote nuevo).')}</div></section>` : '')
        + datalists();
    await openModal({
        title: `${p ? 'Editar' : 'Crear'} ficha de ${linea.toLowerCase()} · ${g?.NombreGranja || ''}`, wide: true, body,
        submitLabel: p ? 'Guardar cambios' : 'Crear perfil',
        onSubmit: async (fd) => {
            const payload = formPayload(fd);
            if (p) payload.PerfilID = p.PerfilID;
            else Object.assign(payload, { GranjaID: granjaId, Linea: linea });
            await save('savePerfil', payload, p ? 'Ficha actualizada.' : 'Perfil creado.');
        },
    });
}

/** Al editar el estado se reenvía la ficha completa (el servidor valida todos los campos). */
async function estadoPerfilFlow(p) {
    const activar = p.Estado !== 'Activo';
    await openModal({
        title: `${activar ? 'Activar' : 'Suspender'} línea de ${p.Linea.toLowerCase()}`, danger: !activar, submitLabel: activar ? 'Activar' : 'Suspender',
        body: `<p class="center">${activar ? 'Se podrán volver a ingresar registros de esta línea.' : 'No se podrán ingresar registros nuevos de esta línea. Los existentes se conservan.'}</p>${justField()}`,
        onSubmit: async (fd) => {
            const payload = { PerfilID: p.PerfilID, Estado: activar ? 'Activo' : 'Suspendido', justificacion: fd.get('justificacion') };
            state.db.campos.perfil.forEach((c) => { payload[c.k] = p[c.k] ?? ''; });
            await save('savePerfil', payload, activar ? 'Línea activada.' : 'Línea suspendida.');
        },
    });
}

async function deletePerfilFlow(p) {
    await openModal({
        title: `Eliminar línea de ${p.Linea.toLowerCase()}`, danger: true, submitLabel: 'Eliminar',
        body: '<p class="center">Solo es posible si la línea no tiene registros de producción. Si los tiene, suspéndela.</p>' + justField(),
        onSubmit: async fd => save('deletePerfil', { PerfilID: p.PerfilID, justificacion: fd.get('justificacion') }, 'Perfil eliminado.'),
    });
}

// ---------- Usuarios ----------
async function openUserModal(u = null, granjaPre = null) {
    const rol = u?.Rol || ROLES.REPRESENTANTE;
    const asignadas = String(u?.GranjaIDs || granjaPre || '').split(',').filter(Boolean);
    const self = u?.ID === state.me.ID;
    await openModal({
        title: u ? `Editar ${u.Nombre}` : 'Nuevo usuario', wide: true,
        body: `<div class="form-grid">
            <label class="field"><span>Nombre <span class="req">*</span></span><input name="Nombre" required maxlength="120" value="${esc(u?.Nombre || '')}"></label>
            <label class="field"><span>Correo electrónico <span class="req">*</span></span><input name="Email" type="email" required maxlength="254" value="${esc(u?.Email || '')}"${u ? ' readonly' : ''} autocomplete="off"></label>
            <label class="field"><span>Nivel de acceso <span class="req">*</span></span><select name="Rol" data-change="user-rol"${self ? ' disabled' : ''}>
                <option value="REPRESENTANTE"${rol === 'REPRESENTANTE' ? ' selected' : ''}>Representante de granja</option>
                <option value="ADMIN"${rol === 'ADMIN' ? ' selected' : ''}>Administrador</option></select>
                ${self ? '<input type="hidden" name="Rol" value="ADMIN"><small class="field-hint">No puedes cambiar tu propio nivel.</small>' : ''}</label>
            <label class="field"><span>Teléfono</span><input name="Telefono" type="tel" inputmode="tel" maxlength="30" value="${esc(u?.Telefono || '')}"></label>
            <fieldset class="field span-all" data-granjas${rol === 'ADMIN' ? ' hidden' : ''}>
                <span class="field-label">Granjas a las que tendrá acceso <span class="req">*</span></span>
                <div class="chips">${state.db.granjas.length ? state.db.granjas.map(g => `<label class="chip check"><input type="checkbox" name="GranjaIDs" value="${esc(g.GranjaID)}"${asignadas.includes(g.GranjaID) ? ' checked' : ''}> ${esc(g.NombreGranja)}</label>`).join('') : '<p class="muted">Primero crea una granja.</p>'}</div>
                <small class="field-hint center">Si tiene varias, verá cada granja por separado.</small>
            </fieldset>
            ${u ? justField() : ''}</div>
            ${u ? '' : '<p class="muted center">Se generará una contraseña temporal. En su primer ingreso deberá crear su propia contraseña.</p>'}`,
        submitLabel: u ? 'Guardar cambios' : 'Crear usuario',
        onSubmit: async (fd) => {
            const p = { Nombre: fd.get('Nombre'), Rol: fd.get('Rol'), Telefono: fd.get('Telefono'), GranjaIDs: fd.getAll('GranjaIDs') };
            if (p.Rol === ROLES.ADMIN) p.GranjaIDs = [];
            else if (!p.GranjaIDs.length) throw new Error('Selecciona al menos una granja.');
            if (u) { p.ID = u.ID; p.justificacion = fd.get('justificacion'); } else p.Email = fd.get('Email');
            const r = await save('saveUser', p, u ? 'Usuario actualizado.' : null);
            if (!u && r?.claveTemporal) setTimeout(() => showTempPassword(p.Email, r.claveTemporal, r.cuentaExistente), 50);
        },
    });
}

async function showTempPassword(email, clave, existente) {
    await openModal({
        title: 'Contraseña temporal', cancelLabel: 'Listo',
        body: `<p class="center">Entrégale estos datos a la persona por un medio seguro. <strong>No se volverán a mostrar.</strong></p>
            <div class="stack"><span class="field-label center">Correo</span><div class="secret">${esc(email)}</div>
            <span class="field-label center">Contraseña temporal</span><div class="secret" id="temp-pass">${esc(clave)}</div></div>
            <div class="row row-center"><button type="button" class="btn btn-primary" data-action="copy-temp">${ico('copy')}Copiar contraseña</button></div>
            ${existente ? alertBox('info', 'info', 'Esta cuenta ya existía; se le asignó esta contraseña temporal.') : ''}
            <p class="muted center">En su primer ingreso deberá crear su propia contraseña.</p>`,
    });
}

async function estadoUserFlow(u) {
    const activar = u.Estado !== 'Activo';
    await openModal({
        title: `${activar ? 'Activar' : 'Suspender'} a ${u.Nombre}`, danger: !activar, submitLabel: activar ? 'Activar' : 'Suspender',
        body: `<p class="center">${activar ? 'Podrá volver a iniciar sesión.' : 'Su sesión se cerrará y no podrá volver a entrar hasta que la actives.'}</p>${justField()}`,
        onSubmit: async fd => save('setUserEstado', { ID: u.ID, Estado: activar ? 'Activo' : 'Suspendido', justificacion: fd.get('justificacion') }, activar ? 'Usuario activado.' : 'Usuario suspendido.'),
    });
}

async function resetUserFlow(u) {
    await openModal({
        title: `Nueva contraseña para ${u.Nombre}`, submitLabel: 'Generar contraseña temporal',
        body: `<p class="center">Se cerrarán sus sesiones abiertas y deberá crear una contraseña nueva al entrar.</p>${justField()}`,
        onSubmit: async (fd) => {
            const r = await save('resetPassword', { ID: u.ID, justificacion: fd.get('justificacion') }, null);
            if (r?.claveTemporal) setTimeout(() => showTempPassword(u.Email, r.claveTemporal, false), 50);
        },
    });
}

async function deleteUserFlow(u) {
    await openModal({
        title: `Eliminar a ${u.Nombre}`, danger: true, submitLabel: 'Eliminar usuario',
        body: `<p class="center">Se elimina su cuenta y su acceso. Los registros que ingresó se conservan.</p>${justField()}`,
        onSubmit: async fd => save('deleteUser', { ID: u.ID, justificacion: fd.get('justificacion') }, 'Usuario eliminado.'),
    });
}

// ---------- Compras de concentrado ----------
async function openCompraModal(c = null) {
    const granjas = isAdmin() ? state.db.granjas.filter(g => g.Estado === 'Activo') : state.db.granjas.filter(g => g.GranjaID === state.granjaId);
    if (!c && !granjas.length) return toast('No hay granjas activas donde registrar la compra.', 'error');
    const pre = c?.GranjaID || (isAdmin() && state.f.granjas.length === 1 ? state.f.granjas[0] : granjas[0]?.GranjaID);
    const granjaHtml = c
        ? `<label class="field"><span>Granja</span><input value="${esc(granjaName(c.GranjaID))}" readonly></label>`
        : `<label class="field"><span>Granja <span class="req">*</span></span><select name="GranjaID" required${granjas.length === 1 ? ' disabled' : ''}>${granjas.map(g => `<option value="${esc(g.GranjaID)}"${g.GranjaID === pre ? ' selected' : ''}>${esc(g.NombreGranja)}</option>`).join('')}</select>
            ${granjas.length === 1 ? `<input type="hidden" name="GranjaID" value="${esc(granjas[0].GranjaID)}">` : ''}</label>`;
    await openModal({
        title: c ? 'Editar compra de concentrado' : 'Nueva compra de concentrado', wide: true,
        body: `<div class="form-grid">${granjaHtml}
            <label class="field"><span>Cubre desde <span class="req">*</span></span><input type="date" name="Desde" required max="${today()}" value="${esc(c?.Desde || today())}"></label>
            <label class="field"><span>Cubre hasta <span class="req">*</span></span><input type="date" name="Hasta" required value="${esc(c?.Hasta || '')}"></label>
            <label class="field"><span>Cantidad comprada (quintales) <span class="req">*</span></span><input type="number" name="CantidadQuintales" required min="0.01" step="any" inputmode="decimal" value="${esc(c?.CantidadQuintales || '')}" data-input="compra-calc"></label>
            <label class="field"><span>Costo total (Q) <span class="req">*</span></span><input type="number" name="CostoTotal" required min="0" step="0.01" inputmode="decimal" value="${esc(c?.CostoTotal || '')}" data-input="compra-calc"></label>
            <div class="span-all" data-compra-calc>${costoQuintalHtml(c?.CantidadQuintales, c?.CostoTotal)}</div>
            <label class="field span-all"><span>Comentarios</span><textarea name="Comentarios" maxlength="1000">${esc(c?.Comentarios || '')}</textarea></label>
            ${c ? justField() : ''}</div>
            <p class="muted center">La fecha y la hora de registro las pone la plataforma al guardar.</p>`,
        submitLabel: c ? 'Guardar cambios' : 'Guardar compra',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            if (p.Hasta < p.Desde) throw new Error('La fecha "hasta" no puede ser anterior a "desde".');
            if (c) Object.assign(p, { CompraID: c.CompraID, GranjaID: c.GranjaID });
            await save('saveCompra', p, c ? 'Compra actualizada.' : 'Compra guardada.', { snapshot: false });
        },
    });
}
function costoQuintalHtml(q, costo) {
    const n = toNum(q), cst = toNum(costo);
    return n && cst !== null ? `<div class="alert alert-info">${ico('wheat')}<span>Costo por quintal: <strong>${esc(fmtQ(cst / n))}</strong></span></div>` : '';
}
async function deleteCompraFlow(c) {
    await openModal({
        title: 'Eliminar compra de concentrado', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">${esc(fmtNum(c.CantidadQuintales))} qq por ${esc(fmtQ(c.CostoTotal))}, del ${esc(fmtDate(c.Desde))} al ${esc(fmtDate(c.Hasta))}.</p>${justField()}`,
        onSubmit: async fd => save('deleteCompra', { CompraID: c.CompraID, justificacion: fd.get('justificacion') }, 'Compra eliminada.', { snapshot: false }),
    });
}

// ---------- Serología ----------
const PRUEBA_NOMBRE = { HI: 'HI (inhibición de la hemaglutinación)', ELISA: 'ELISA', PLACA: 'Aglutinación en placa' };
const enfermedadById = id => state.db.enfermedades.find(e => e.EnfermedadID === id) || null;
const metodoById = id => state.db.metodosSerologia.find(m => m.MetodoID === id) || null;
const nombreMetodo = m => `${m.Nombre.includes(m.Prueba) ? m.Nombre : `${m.Nombre} · ${m.Prueba}`}${m.GranjaID ? '' : ' (general)'}`;
/** Métodos de una enfermedad que sirven en esas granjas: los generales y los propios de ellas. */
function metodosDe(enfId, granjaIds) {
    return state.db.metodosSerologia.filter(m => m.EnfermedadID === enfId && (!m.GranjaID || granjaIds.includes(m.GranjaID))).sort(byNombre);
}

/** Lee los resultados escritos o pegados (separados por espacios, comas, punto y coma o saltos de línea). */
function leerValoresSero(texto, prueba) {
    const partes = String(texto || '').split(/[\s;,]+/).map(s => s.trim()).filter(Boolean);
    const def = state.db.pruebasSerologia[prueba] || {};
    const valores = [], malos = [];
    partes.forEach((s) => {
        if (prueba === 'PLACA') {
            const v = s.toUpperCase();
            if (v === 'P' || v === 'N') valores.push(v); else malos.push(s);
            return;
        }
        const v = Number(s);
        if (!Number.isFinite(v) || v < def.min || v > def.max || (def.entero && !Number.isInteger(v))) malos.push(s); else valores.push(v);
    });
    return { valores, malos };
}

/** El mismo resumen que el servidor (ver resumenSerologia_ en el backend). */
function resumenSerologia(prueba, valores) {
    const n = valores.length;
    if (!n) return null;
    if (prueba === 'PLACA') {
        const pos = valores.filter(v => v === 'P').length;
        return { Positivos: pos, PctPositivos: pos / n * 100 };
    }
    const suma = valores.reduce((a, b) => a + b, 0);
    const o = { Maximo: Math.max(...valores), Minimo: Math.min(...valores) };
    if (prueba === 'HI') return { ...o, Promedio: suma / n };
    const media = suma / n;
    const sd = n > 1 ? Math.sqrt(valores.reduce((a, v) => a + (v - media) ** 2, 0) / (n - 1)) : 0;
    return { ...o, MediaGeometrica: suma === 0 ? 0 : 10 ** (valores.reduce((a, v) => a + Math.log10(Math.max(v, 1)), 0) / n), CV: media ? sd / media * 100 : 0 };
}

function resumenSeroHtml(prueba, valores, metodo) {
    const st = resumenSerologia(prueba, valores);
    if (!st) return '<p class="muted center">Escribe o pega los resultados para ver el resumen.</p>';
    const filas = prueba === 'PLACA'
        ? [['Positivas', `${st.Positivos} de ${valores.length}`], ['Positivas (%)', `${fmtNum(st.PctPositivos)} %`]]
        : [[prueba === 'HI' ? 'Promedio (log2)' : 'Media geométrica', fmtNum(prueba === 'HI' ? st.Promedio : st.MediaGeometrica)],
            ['Dato mayor', fmtNum(st.Maximo)], ['Dato menor', fmtNum(st.Minimo)]].concat(prueba === 'ELISA' ? [['CV', `${fmtNum(st.CV)} %`]] : []);
    if (prueba !== 'PLACA' && metodo?.CortePositivo !== '' && metodo?.CortePositivo !== undefined) {
        const pos = valores.filter(v => v >= Number(metodo.CortePositivo)).length;
        filas.push(['Positivas', `${pos} de ${valores.length} (${fmtNum(pos / valores.length * 100)} %)`]);
    }
    return filas.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

/** Opciones de método para la enfermedad y la granja de la nave elegida en el formulario. */
function srMetodosHtml(enfId, granjaId, elegido) {
    const lista = enfId ? metodosDe(enfId, granjaId ? [granjaId] : []) : [];
    return lista.length
        ? lista.map(m => `<option value="${esc(m.MetodoID)}"${m.MetodoID === elegido ? ' selected' : ''}>${esc(nombreMetodo(m))}</option>`).join('')
        : '<option value="">Sin métodos para esta enfermedad</option>';
}

/** Recalcula el formulario de muestreo: métodos de la enfermedad, prueba, conteo y resumen. */
function srRender(form, { metodos = false } = {}) {
    if (!form?.querySelector('[data-sr]')) return;
    const naveId = form.NaveID?.value || form.dataset.nave;
    const granjaId = naveById(naveId)?.GranjaID || '';
    if (metodos && form.MetodoID?.tagName === 'SELECT') form.MetodoID.innerHTML = srMetodosHtml(form.EnfermedadID.value, granjaId, form.MetodoID.value);
    const metodo = metodoById(form.MetodoID?.value);
    const sin = form.querySelector('[data-sr-sin-metodo]');
    if (sin) sin.hidden = !!metodo;
    const prueba = metodo?.Prueba || '';
    const def = state.db.pruebasSerologia[prueba];
    form.querySelector('[data-sr-prueba]').innerHTML = metodo
        ? `Prueba: <strong>${esc(PRUEBA_NOMBRE[prueba])}</strong> · ${prueba === 'PLACA' ? 'escribe P (positivo) o N (negativo) por ave' : `título en ${esc(def.unidad)}${def.entero ? ', números enteros' : ''} de ${esc(fmtNum(def.min))} a ${esc(fmtNum(def.max))}`}`
            + (metodo.CortePositivo !== '' && prueba !== 'PLACA' ? ` · Positivo desde ${esc(fmtNum(metodo.CortePositivo))}` : '')
        : 'Elige un método para saber qué escribir.';
    const { valores, malos } = prueba ? leerValoresSero(form.Valores.value, prueba) : { valores: [], malos: [] };
    const total = Math.max(0, Math.floor(toNum(form.Muestra.value) || 0));
    form.querySelector('[data-sr-count]').textContent = `${nf.format(valores.length)} de ${nf.format(total)}`;
    form.querySelector('[data-sr-aviso]').innerHTML = malos.length
        ? alertBox('warn', 'alert-triangle', `No válidos: ${esc(malos.slice(0, 8).join(' '))}${malos.length > 8 ? '…' : ''}`)
        : valores.length > total ? alertBox('warn', 'alert-triangle', `Hay ${valores.length - total} resultado(s) de más para una muestra de ${total}.`) : '';
    form.querySelector('[data-sr-resumen]').innerHTML = prueba ? resumenSeroHtml(prueba, valores, metodo) : '';
}

/**
 * Nuevo muestreo o edición. Al crear, la casilla "agregar otra enfermedad" reabre el formulario
 * con la misma nave, fecha y muestra (el laboratorio analiza los mismos sueros para varias).
 */
async function openSerologiaModal(s = null, preset = {}) {
    const linea = s ? s.Linea : state.linea;
    let ubic;
    if (s) {
        ubic = `<label class="field"><span>Sector / nave</span><input value="${esc([s.Sector, s.Nave].join(' / '))}" readonly></label>
            <label class="field"><span>Fecha del muestreo</span><input value="${esc(fmtDate(s.Fecha))}" readonly></label>
            <label class="field"><span>Enfermedad</span><input value="${esc(s.Enfermedad)}" readonly></label>
            <label class="field"><span>Método</span><input value="${esc(s.Metodo)} · ${esc(s.Prueba)}" readonly></label>
            <input type="hidden" name="MetodoID" value="${esc(s.MetodoID)}">`;
    } else {
        ubic = ubicacionInputs(linea, { naveId: preset.naveId, fecha: preset.fecha || today(), sinVentana: true });
        if (!ubic) return toast(`No hay naves activas de ${linea.toLowerCase()}.`, 'error');
    }
    const enfInicial = preset.enfId || state.srEnf || state.db.enfermedades[0]?.EnfermedadID || '';
    const naveInicial = s ? s.NaveID : (/name="NaveID"[^>]*>[\s\S]*?<option value="([^"]+)" selected/.exec(ubic) || [])[1];
    const granjaInicial = naveById(naveInicial)?.GranjaID || '';
    const valores = s ? String(s.Valores || '').split(',').filter(Boolean).join(' ') : '';
    const body = `<section class="form-section"><div class="form-grid">${ubic}
        ${s ? '' : `<label class="field"><span>Enfermedad <span class="req">*</span></span><select name="EnfermedadID" required data-change="sr-enf">${state.db.enfermedades.map(e =>
        `<option value="${esc(e.EnfermedadID)}"${e.EnfermedadID === enfInicial ? ' selected' : ''}>${esc(e.Nombre)}</option>`).join('')}</select></label>
            <label class="field"><span>Método o kit <span class="req">*</span></span><select name="MetodoID" required data-change="sr-metodo">${srMetodosHtml(enfInicial, granjaInicial, preset.metodoId || state.srMetodo)}</select></label>
            <div class="span-all" data-sr-sin-metodo hidden><div class="alert alert-info">${ico('info')}<span>Esta enfermedad aún no tiene un método para esta granja.</span><button type="button" class="btn btn-sm" data-action="metodo-desde-form">${ico('plus')}Crear método</button></div></div>`}
    </div></section>
    <section class="form-section" data-sr><h3>${ico('syringe')}Resultados por ave</h3>
        <p class="field-hint center" data-sr-prueba></p>
        <div class="form-grid">
            <label class="field"><span>Tamaño de la muestra <span class="req">*</span></span><input type="number" name="Muestra" min="1" max="${state.db.maxMuestra}" step="1" inputmode="numeric" required value="${esc(s?.Muestra || preset.muestra || 20)}" data-input="sr-calc">
                <small class="field-hint">Número de aves (sueros) analizadas.</small></label>
            <label class="field span-all"><span>Resultado de cada ave <span class="req">*</span> <span class="muted" data-sr-count></span></span><textarea name="Valores" rows="4" required data-input="sr-calc" placeholder="Por ejemplo: 6 7 5 8 6 …">${esc(valores)}</textarea>
                <small class="field-hint">Cópialos del reporte del laboratorio, en orden, separados por espacios, comas o saltos de línea.</small></label>
        </div>
        <div data-sr-aviso></div>
        <dl class="kv pz-stats" data-sr-resumen></dl>
    </section>
    <section class="form-section"><div class="form-grid">
        ${linea === 'Incubadora' ? `<label class="field"><span>Lote reproductora de origen</span><input name="LoteOrigen" maxlength="80" value="${esc(s?.LoteOrigen || '')}">
            <small class="field-hint">Lote de las madres de estos pollitos (opcional).</small></label>` : ''}
        <label class="field"><span>Laboratorio</span><input name="Laboratorio" maxlength="120" value="${esc(s?.Laboratorio || preset.laboratorio || '')}"></label>
        <label class="field span-all"><span>Comentarios</span><textarea name="Comentarios" maxlength="1000">${esc(s?.Comentarios || '')}</textarea></label>
        ${s ? justField('Explica qué se corrige (por ejemplo, un resultado mal digitado).') : `<label class="check span-all"><input type="checkbox" name="otra"${preset.otra ? ' checked' : ''}> Al guardar, agregar otra enfermedad para esta misma nave y fecha</label>`}
    </div></section>`;
    let siguiente = null;
    const promesa = openModal({
        title: s ? 'Editar muestreo serológico' : `Nuevo muestreo serológico · ${linea.toLowerCase()}`, wide: true, body,
        submitLabel: s ? 'Guardar cambios' : 'Guardar muestreo',
        onSubmit: async (fd) => {
            const metodo = metodoById(fd.get('MetodoID')) || (s && { Prueba: s.Prueba });
            if (!metodo) throw new Error('Elige el método o kit (o crea uno para esta enfermedad).');
            const { valores: v, malos } = leerValoresSero(fd.get('Valores'), metodo.Prueba);
            const muestra = toNum(fd.get('Muestra'));
            if (malos.length) throw new Error(`Hay resultados no válidos: ${malos.slice(0, 8).join(' ')}.`);
            if (v.length !== muestra) throw new Error(`La muestra es de ${muestra} y hay ${v.length} resultados. Deben ser exactamente ${muestra}.`);
            const p = { Muestra: muestra, Valores: v, Laboratorio: fd.get('Laboratorio') || '', Comentarios: fd.get('Comentarios') || '', LoteOrigen: fd.get('LoteOrigen') || '' };
            if (s) Object.assign(p, { SerologiaID: s.SerologiaID, justificacion: fd.get('justificacion') });
            else Object.assign(p, { Linea: linea, NaveID: fd.get('NaveID'), Fecha: fd.get('Fecha'), EnfermedadID: fd.get('EnfermedadID'), MetodoID: fd.get('MetodoID') });
            await save('saveSerologia', p, s ? 'Muestreo actualizado.' : 'Muestreo guardado.', { snapshot: false });
            if (!s && fd.get('otra')) siguiente = { naveId: p.NaveID, fecha: p.Fecha, muestra, laboratorio: p.Laboratorio, otra: true };
        },
    });
    const form = $('#modal form');
    if (form && s) form.dataset.nave = s.NaveID;
    srRender(form);
    await promesa;
    if (siguiente) setTimeout(() => openSerologiaModal(null, siguiente), 60);
}

async function verSerologiaModal(s) {
    const valores = String(s.Valores || '').split(',').filter(Boolean);
    const filas = [['Enfermedad', s.Enfermedad], ['Método', `${s.Metodo} · ${s.Prueba}`], ['Edad', s.EdadDias !== '' ? textoEdad(Number(s.EdadDias)) : '—'], ['Muestra', s.Muestra]]
        .concat(s.Prueba === 'PLACA' ? [] : [[s.Prueba === 'HI' ? 'Promedio (log2)' : 'Media geométrica', fmtNum(valorResumen(s))], ['Dato mayor', fmtNum(s.Maximo)], ['Dato menor', fmtNum(s.Minimo)]])
        .concat(s.Prueba === 'ELISA' ? [['CV', `${fmtNum(s.CV)} %`]] : [])
        .concat(s.PctPositivos !== '' ? [['Positivas', `${s.Positivos} (${fmtNum(s.PctPositivos)} %)`]] : [])
        .concat(s.PctProtegidas !== '' ? [['Protegidas', `${fmtNum(s.PctProtegidas)} %`]] : [])
        .concat(s.LoteOrigen ? [['Lote de origen', s.LoteOrigen]] : []).concat(s.Laboratorio ? [['Laboratorio', s.Laboratorio]] : []);
    await openModal({
        title: `Muestreo del ${fmtDate(s.Fecha)}`, cancelLabel: 'Cerrar', wide: true,
        body: `<p class="center">${esc([granjaName(s.GranjaID), s.Sector, s.Nave, s.NumeroLote ? 'Lote ' + s.NumeroLote : ''].filter(Boolean).join(' / '))}</p>
            <dl class="kv">${filas.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
            <section class="form-section"><h3>${ico('list-checks')}Resultado de cada ave</h3>
            <ol class="pz-list">${valores.map((v, i) => `<li><span class="pz-num">${i + 1}</span>${esc(v)}</li>`).join('')}</ol></section>`,
    });
}

async function deleteSerologiaFlow(s) {
    await openModal({
        title: 'Eliminar muestreo serológico', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">${esc(s.Enfermedad)} · ${esc(fmtDate(s.Fecha))} · ${esc([s.Sector, s.Nave].join(' / '))} · muestra de ${esc(s.Muestra)}.</p>${justField()}`,
        onSubmit: async fd => save('deleteSerologia', { SerologiaID: s.SerologiaID, justificacion: fd.get('justificacion') }, 'Muestreo eliminado.', { snapshot: false }),
    });
}

/** Método o kit: general (solo admin) o propio de una granja. */
async function openMetodoModal(m = null, preset = {}) {
    const granjas = isAdmin() ? state.db.granjas.filter(g => g.Estado === 'Activo') : state.db.granjas.filter(g => g.GranjaID === state.granjaId);
    const granjaHtml = m
        ? `<label class="field"><span>De</span><input value="${esc(m.GranjaID ? granjaName(m.GranjaID) : 'General (todas las granjas)')}" readonly></label>`
        : isAdmin()
            ? `<label class="field"><span>De <span class="req">*</span></span><select name="GranjaID"><option value="">General (todas las granjas)</option>${granjas.map(g =>
                `<option value="${esc(g.GranjaID)}"${g.GranjaID === preset.granjaId ? ' selected' : ''}>${esc(g.NombreGranja)}</option>`).join('')}</select>
                <small class="field-hint">Un método general lo pueden usar todas las granjas.</small></label>`
            : `<label class="field"><span>De</span><input value="${esc(granjaName(state.granjaId))}" readonly><input type="hidden" name="GranjaID" value="${esc(state.granjaId)}"></label>`;
    const enfId = m?.EnfermedadID || preset.enfId || state.srEnf || state.db.enfermedades[0]?.EnfermedadID;
    const pruebasDe = id => String(enfermedadById(id)?.Pruebas || '').split(',').filter(Boolean);
    const opcionesPrueba = (id, elegida) => pruebasDe(id).map(p => `<option value="${p}"${p === elegida ? ' selected' : ''}>${esc(PRUEBA_NOMBRE[p])}</option>`).join('');
    const pruebaIni = m?.Prueba || pruebasDe(enfId)[0];
    await openModal({
        title: m ? 'Editar método o kit' : 'Nuevo método o kit', wide: true,
        body: `<div class="form-grid">${granjaHtml}
            <label class="field"><span>Enfermedad <span class="req">*</span></span><select name="EnfermedadID" required data-change="met-enf">${state.db.enfermedades.map(e =>
            `<option value="${esc(e.EnfermedadID)}"${e.EnfermedadID === enfId ? ' selected' : ''}>${esc(e.Nombre)}</option>`).join('')}</select></label>
            <label class="field"><span>Prueba <span class="req">*</span></span><select name="Prueba" required data-change="met-prueba">${opcionesPrueba(enfId, pruebaIni)}</select></label>
            <label class="field"><span>Nombre del método o kit <span class="req">*</span></span><input name="Nombre" required maxlength="80" value="${esc(m?.Nombre || '')}" placeholder="Por ejemplo: IDEXX IBD"></label>
            <label class="field"><span>Laboratorio</span><input name="Laboratorio" maxlength="120" value="${esc(m?.Laboratorio || '')}"></label>
            <label class="field" data-met-corte><span>Positivo desde</span><input type="number" name="CortePositivo" min="0" step="any" inputmode="decimal" value="${esc(m?.CortePositivo || '')}">
                <small class="field-hint">Título a partir del cual un ave cuenta como positiva.</small></label>
            <label class="field" data-met-corte><span>Nivel protector</span><input type="number" name="NivelProtector" min="0" step="any" inputmode="decimal" value="${esc(m?.NivelProtector || '')}">
                <small class="field-hint">Título a partir del cual un ave se considera protegida.</small></label>
            <label class="field span-all" data-met-corte><span>Fuente del corte o del nivel</span><input name="Fuente" maxlength="300" value="${esc(m?.Fuente || '')}" placeholder="Por ejemplo: inserto del kit, versión y página">
                <small class="field-hint">Escribe un corte o un nivel solo si está publicado. Si no hay fuente, déjalos vacíos: no se inventan.</small></label>
            ${m ? justField() : ''}</div>`,
        submitLabel: m ? 'Guardar cambios' : 'Guardar método',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            if ((p.CortePositivo || p.NivelProtector) && !p.Fuente) throw new Error('Indica la fuente del corte o del nivel protector.');
            if (m) Object.assign(p, { MetodoID: m.MetodoID });
            await save('saveMetodoSerologia', p, m ? 'Método actualizado.' : 'Método guardado.');
        },
    });
}

async function deleteMetodoFlow(m) {
    await openModal({
        title: 'Eliminar método o kit', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">${esc(nombreMetodo(m))} · ${esc(enfermedadById(m.EnfermedadID)?.Nombre || '')}.</p>
            <p class="muted center">Solo se puede eliminar si no tiene muestreos.</p>${justField()}`,
        onSubmit: async fd => save('deleteMetodoSerologia', { MetodoID: m.MetodoID, justificacion: fd.get('justificacion') }, 'Método eliminado.'),
    });
}

// ---------- Pesos estándar ----------
async function openEstandarModal(x = null) {
    const gen = x?.LineaGenetica || state.estGen, tipo = x?.Tipo || state.estTipo;
    const ultima = [...(state.estFilas?.values() || [])].pop();
    await openModal({
        title: x ? `Corregir día ${x.EdadDias} · ${gen}` : `Agregar edad · ${gen}`, wide: true,
        body: `<p class="center">${esc(gen)} · tabla ${esc(tipo === 'Comercial' ? 'comercial' : 'de hembra reproductora')}. Los pesos van en gramos.</p>
            <div class="form-grid">
            <label class="field"><span>Edad (días) <span class="req">*</span></span><input type="number" name="EdadDias" required min="0" max="1000" step="1" value="${esc(x?.EdadDias ?? '')}">
                <small class="field-hint">Semana × 7 (por ejemplo, semana 17 = 119 días).</small></label>
            <label class="field"><span>Mínimo (g)</span><input type="number" name="MinimoG" min="0" step="any" value="${esc(x?.MinimoG ?? '')}"></label>
            <label class="field"><span>Estándar (g) <span class="req">*</span></span><input type="number" name="EstandarG" required min="0" step="any" value="${esc(x?.EstandarG ?? '')}"></label>
            <label class="field"><span>Máximo (g)</span><input type="number" name="MaximoG" min="0" step="any" value="${esc(x?.MaximoG ?? '')}"></label>
            <label class="field span-all"><span>Fuente (guía, edición y página) <span class="req">*</span></span><input name="Fuente" required maxlength="300" value="${esc(x?.Fuente || ultima?.Fuente || '')}"></label>
            ${x ? justField('Explica qué cambió en la guía.') : ''}</div>`,
        submitLabel: x ? 'Guardar corrección' : 'Agregar',
        onSubmit: async (fd) => {
            const p = { ...formPayload(fd), LineaGenetica: gen, Tipo: tipo };
            if (x) p.EstandarID = x.EstandarID;
            await save('saveEstandar', p, x ? 'Peso corregido.' : 'Edad agregada.');
        },
    });
}
async function deleteEstandarFlow(x) {
    await openModal({
        title: `Borrar día ${x.EdadDias} · ${x.LineaGenetica}`, danger: true, submitLabel: 'Borrar',
        body: `<p class="center">Estándar ${esc(fmtNum(x.EstandarG))} g. Los pesajes de esa edad se compararán con las edades vecinas.</p>${justField()}`,
        onSubmit: async fd => save('deleteEstandar', { EstandarID: x.EstandarID, justificacion: fd.get('justificacion') }, 'Fila borrada.'),
    });
}

// ---------- Listas ----------
async function deleteListaFlow(l) {
    if (!l) return;
    await openModal({
        title: `Quitar "${l.Valor}"`, danger: true, submitLabel: 'Quitar',
        body: `<p class="center">Se quita de la lista <strong>${esc(LISTA_LABEL[l.Tipo] || l.Tipo)}</strong>. Los datos ya guardados no cambian.</p>
            <p class="muted center">Una línea genética que ya usa algún lote no se puede quitar.</p>${justField()}`,
        onSubmit: async fd => save('deleteLista', { ListaID: l.ListaID, justificacion: fd.get('justificacion') }, 'Valor eliminado.'),
    });
}

// ==========================================================================
// 12. ACCIONES, AUTENTICACIÓN Y ARRANQUE
// ==========================================================================

function setFiltro(patch) {
    Object.assign(state.f, patch);
    render();
}

const ACTIONS = {
    'toggle-password': btn => setPasswordVisible(btn, btn.getAttribute('aria-pressed') !== 'true'),
    'toggle-sidebar': () => toggleSidebar(),
    'logout': async () => { closeModal(); await signOut(auth); },
    'sync': async () => {
        try { await refreshAll(); toast('Datos actualizados.'); } catch (e) { toast(e.message, 'error'); }
    },
    'retry': () => { state.cache.clear(); render(); },
    'retry-session': () => bootSession(true),
    'forgot-password': async () => {
        const email = $('#login-form [name=email]').value.trim();
        if (!email) return showLoginError('Escribe tu correo y vuelve a presionar "¿Olvidaste tu contraseña?".');
        try {
            await sendPasswordResetEmail(auth, email);
            toast('Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.', 'success', 7000);
        } catch (e) { showLoginError(authErrorMsg(e)); }
    },
    'nav': el => go(el.dataset.view),
    'set-unidad': (el) => { state.unidad = el.dataset.unidad; guardarPref('granjas.unidad', state.unidad); render(); },

    // Pesajes
    'new-pesaje': () => openPesajeModal(),
    'edit-pesaje': el => openPesajeModal(state.pesajes.get(el.dataset.id)),
    'ver-pesaje': el => verPesajeModal(state.pesajes.get(el.dataset.id)),
    'delete-pesaje': el => deletePesajeFlow(state.pesajes.get(el.dataset.id)),
    'pz-add': () => { const i = $('#pz-input'); if (i && i.value.trim()) { pzAgregar(i.value); i.value = ''; i.focus(); } },
    'pz-undo': () => { if (pz?.pesos.length) { pz.pesos.pop(); pzRender(); $('#pz-input')?.focus(); } },
    'pz-del': (el) => { if (pz) { pz.pesos.splice(Number(el.dataset.i), 1); pzRender(); } },

    // Ambiente
    'new-lectura': () => openLecturaModal(),
    'delete-lectura': el => deleteLecturaFlow(state.lecturas.get(el.dataset.id)),

    // Estructura de la granja
    'new-sector': el => openSectorModal(el.dataset.granja, el.dataset.linea),
    'edit-sector': (el) => { const s = sectorById(el.dataset.id); openSectorModal(s.GranjaID, s.Linea, s); },
    'estado-sector': el => estadoEstructuraFlow('sector', sectorById(el.dataset.id)),
    'delete-sector': el => deleteEstructuraFlow('sector', sectorById(el.dataset.id)),
    'new-nave': el => openNaveModal(el.dataset.id),
    'edit-nave': el => openNaveModal(null, naveById(el.dataset.id)),
    'estado-nave': el => estadoEstructuraFlow('nave', naveById(el.dataset.id)),
    'delete-nave': el => deleteEstructuraFlow('nave', naveById(el.dataset.id)),
    'new-lote': el => openLoteModal(el.dataset.id),
    'edit-lote': el => openLoteModal(null, loteById(el.dataset.id)),
    'cerrar-lote': el => cerrarLoteFlow(loteById(el.dataset.id)),
    'reabrir-lote': el => reabrirLoteFlow(loteById(el.dataset.id)),
    // Desde el formulario de registro o de pesaje: cierra ese formulario y abre el del lote.
    'lote-desde-form': (el) => {
        const lote = loteById(el.dataset.id);
        closeModal();
        setTimeout(() => openLoteModal(null, lote), 60);
    },

    // Filtros
    'set-linea': (el) => { state.linea = el.dataset.linea; state.f.sector = ''; state.f.nave = ''; render(); },
    'set-agrupar': el => setFiltro({ agrupar: el.dataset.agrupar }),
    'preset': (el) => {
        const d = Number(el.dataset.days);
        setFiltro(d ? { desde: daysAgo(d), hasta: today() } : { desde: '', hasta: '' });
    },
    'goto-dashboard': (el) => { focusGranja(el.dataset.id); go('dashboard'); },
    'goto-registros': (el) => { focusGranja(el.dataset.id); go('registros'); },

    // Tablas y gráficos
    'sort': (el) => {
        const { table: id, k } = el.dataset;
        const s = state.sort[id];
        state.sort[id] = { k, dir: s?.k === k && s.dir === 'asc' ? 'desc' : 'asc' };
        refreshTable(id);
    },
    'csv': el => downloadCsv(el.dataset.table),
    'png': async (el) => {
        const spec = charts[el.dataset.chart];
        if (!spec) return;
        await exportChartPng(spec, `${slug(spec.title)}_${today()}.png`);
        toast('Gráfico descargado.', 'success');
    },

    // Registros
    'new-registro': () => openRegistroModal(),
    'edit-registro': el => openRegistroModal(state.registros.get(el.dataset.id)),
    'delete-registro': el => deleteRegistroFlow(state.registros.get(el.dataset.id)),
    'restore-registro': el => restoreRegistroFlow(state.registros.get(el.dataset.id)),

    // Granjas y perfiles
    'new-granja': () => openGranjaModal(),
    'open-granja': el => go('granja', el.dataset.id),
    'edit-granja': el => openGranjaModal(granjaById(el.dataset.id)),
    'estado-granja': el => estadoGranjaFlow(granjaById(el.dataset.id)),
    'delete-granja': el => deleteGranjaFlow(granjaById(el.dataset.id)),
    'new-perfil': el => openPerfilModal(el.dataset.granja, el.dataset.linea),
    'edit-perfil': (el) => { const p = state.db.perfiles.find(x => x.PerfilID === el.dataset.id); openPerfilModal(p.GranjaID, p.Linea, p); },
    'estado-perfil': el => estadoPerfilFlow(state.db.perfiles.find(x => x.PerfilID === el.dataset.id)),
    'delete-perfil': el => deletePerfilFlow(state.db.perfiles.find(x => x.PerfilID === el.dataset.id)),
    'copy-perfil': (el) => {
        const src = state.db.perfiles.find(x => x.PerfilID === el.dataset.from);
        const form = el.closest('form');
        if (!src || !form) return;
        state.db.campos.perfil.forEach((c) => { if (form.elements[c.k]) form.elements[c.k].value = src[c.k] ?? ''; });
        toast('Datos copiados como sugerencia. Revísalos y ajusta lo que sea distinto.', 'success');
    },

    // Usuarios
    'new-user': el => openUserModal(null, el.dataset.granja || null),
    'edit-user': el => openUserModal(userById(el.dataset.id)),
    'estado-user': el => estadoUserFlow(userById(el.dataset.id)),
    'reset-user': el => resetUserFlow(userById(el.dataset.id)),
    'delete-user': el => deleteUserFlow(userById(el.dataset.id)),
    'copy-temp': async () => {
        const txt = $('#temp-pass')?.textContent || '';
        try { await navigator.clipboard.writeText(txt); toast('Contraseña copiada.', 'success'); } catch {
            const r = document.createRange(); r.selectNodeContents($('#temp-pass'));
            getSelection().removeAllRanges(); getSelection().addRange(r);
            toast('Selecciónala y cópiala manualmente.', 'info');
        }
    },

    // Listas
    'delete-lista': el => deleteListaFlow(state.db.listas.find(l => l.ListaID === el.dataset.id)),

    // Concentrado y pesos estándar
    // Serología
    'new-serologia': () => openSerologiaModal(),
    'edit-serologia': el => openSerologiaModal(state.serologias.get(el.dataset.id)),
    'ver-serologia': el => verSerologiaModal(state.serologias.get(el.dataset.id)),
    'delete-serologia': el => deleteSerologiaFlow(state.serologias.get(el.dataset.id)),
    'new-metodo': () => openMetodoModal(null, { enfId: state.srEnf }),
    'edit-metodo': el => openMetodoModal(metodoById(el.dataset.id)),
    'delete-metodo': el => deleteMetodoFlow(metodoById(el.dataset.id)),
    'metodo-desde-form': (el) => {
        const f = el.closest('form');
        const preset = { enfId: f?.EnfermedadID?.value, granjaId: naveById(f?.NaveID?.value)?.GranjaID };
        closeModal();
        setTimeout(() => openMetodoModal(null, preset), 60);
    },
    'new-compra': () => openCompraModal(),
    'edit-compra': el => openCompraModal(state.compras.get(el.dataset.id)),
    'delete-compra': el => deleteCompraFlow(state.compras.get(el.dataset.id)),
    'est-tipo': (el) => { state.estTipo = el.dataset.tipo; render(); },
    'new-estandar': () => openEstandarModal(),
    'edit-estandar': el => openEstandarModal(state.estFilas.get(el.dataset.id)),
    'delete-estandar': el => deleteEstandarFlow(state.estFilas.get(el.dataset.id)),

    // Seguridad
    'verify-audit': async (el) => {
        el.disabled = true; el.classList.add('is-loading');
        try { state.audit = await withBusy(() => api('verifyAudit')); render(); } catch (e) { toast(e.message, 'error'); } finally { el.disabled = false; el.classList.remove('is-loading'); }
    },
};

/** Al saltar a dashboard/registros desde una granja, se filtra por esa granja. */
function focusGranja(id) {
    if (isAdmin()) state.f.granjas = [id];
    else if (state.db.granjas.some(g => g.GranjaID === id)) state.granjaId = id;
    state.f.sector = '';
    state.f.nave = '';
    ensureLinea(ctxIds());
}

const INPUTS = {
    'sr-calc': el => srRender(el.form),
    'compra-calc': (el) => {
        const box = el.form.querySelector('[data-compra-calc]');
        if (box) box.innerHTML = costoQuintalHtml(el.form.CantidadQuintales.value, el.form.CostoTotal.value);
    },
    'table-q': (el) => { state.q[el.dataset.table] = el.value; refreshTable(el.dataset.table); },
    'iec-calc': (el) => {
        const t = toNum(el.form.Temperatura.value), h = toNum(el.form.Humedad.value);
        const box = el.form.querySelector('[data-iec-preview]');
        if (t === null || h === null) { box.innerHTML = '<p class="muted center">IEC = temperatura (°C) + humedad (%).</p>'; return; }
        const v = round(t + h);
        const r = nivelIec(v);
        box.innerHTML = `<div class="iec-preview iec-${esc(r?.color || '')}"><strong>IEC ${esc(fmtNum(v))}</strong><span>${esc(r?.nivel || '')} · ${esc(r?.descripcion || '')}</span></div>`;
    },
};

const CHANGES = {
    'granja-activa': (el) => { state.granjaId = el.value; state.f.sector = ''; state.f.nave = ''; ensureLinea(ctxIds()); render(); },
    'f-sector': el => setFiltro({ sector: el.value, nave: '' }),
    'f-nave': el => setFiltro({ nave: el.value }),
    'ubic-info': (el) => {
        const f = el.form;
        const box = f.querySelector('[data-ubic-info]');
        const fecha = f.Fecha ? f.Fecha.value : today();
        if (box) box.innerHTML = infoUbicacion(f.NaveID.value, fecha || today());
        syncEdadRegistro(f, loteEn(f.NaveID.value, fecha || today()), fecha || today());
        if (pz) pz.esperado = esperadoPesaje(f.NaveID.value, fecha || today());
        srRender(f, { metodos: true });
        if (pz && !pz.editando) {
            pz.naveId = f.NaveID.value; pz.fecha = fecha;
            const b = leerBorrador(pz.naveId, pz.fecha);
            if (b?.pesos?.length && !pz.pesos.length) {
                Object.assign(pz, { unidad: b.unidad, muestra: b.muestra, pesos: b.pesos });
                f.Unidad.value = b.unidad; f.Muestra.value = b.muestra;
                toast(`Se recuperó una muestra sin guardar (${b.pesos.length} pesos).`, 'info');
            }
            pzRender();
        }
    },
    'pz-config': (el) => {
        if (!pz) return;
        const f = el.form;
        if (el.name === 'Unidad' && pz.pesos.length && el.value !== pz.unidad) {
            if (!confirm('Cambiar la unidad convertirá los pesos ya ingresados. ¿Continuar?')) { el.value = pz.unidad; return; }
            const fx = factorDe(pz.unidad) / factorDe(el.value);
            pz.pesos = pz.pesos.map(v => Math.round(v * fx * 1e6) / 1e6);
        }
        pz.unidad = f.Unidad.value;
        pz.muestra = Math.max(0, Math.floor(toNum(f.Muestra.value) || 0));
        pzRender();
    },
    'form-unidad': (el) => {
        // Convierte los pesos ya escritos a la nueva unidad y ajusta etiquetas y máximos.
        const antes = el.dataset.prev, ahora = el.value;
        const fx = factorDe(antes) / factorDe(ahora);
        el.form.querySelectorAll('input[data-peso]').forEach((i) => {
            if (i.value !== '') i.value = String(Math.round(Number(i.value) * fx * 1e4) / 1e4);
            if (i.dataset.maxG) i.max = String(round(Number(i.dataset.maxG) / factorDe(ahora), 4));
        });
        el.form.querySelectorAll('[data-unidad-label]').forEach((s) => { s.textContent = ahora; });
        el.dataset.prev = ahora;
    },
    'f-granja': (el) => {
        const set = new Set(state.f.granjas);
        if (el.checked) set.add(el.value); else set.delete(el.value);
        state.ddOpen = true;
        setFiltro({ granjas: [...set] });
    },
    'f-granja-all': () => { state.ddOpen = true; setFiltro({ granjas: [] }); },
    'f-desde': el => setFiltro({ desde: el.value }),
    'f-hasta': el => setFiltro({ hasta: el.value }),
    'f-eliminados': el => setFiltro({ eliminados: el.checked }),
    'bit-granja': (el) => { state.bitGranja = el.value; render(); },
    'est-gen': (el) => { state.estGen = el.value; render(); },
    'sr-f-enf': (el) => { state.srEnf = el.value; state.srMetodo = ''; render(); },
    'sr-f-metodo': (el) => { state.srMetodo = el.value; render(); },
    'sr-enf': el => srRender(el.form, { metodos: true }),
    'sr-metodo': el => srRender(el.form),
    'met-enf': (el) => {
        const pruebas = String(enfermedadById(el.value)?.Pruebas || '').split(',').filter(Boolean);
        el.form.Prueba.innerHTML = pruebas.map(p => `<option value="${p}">${esc(PRUEBA_NOMBRE[p])}</option>`).join('');
        CHANGES['met-prueba'](el.form.Prueba);
    },
    'met-prueba': (el) => {
        // La aglutinación en placa da positivo o negativo: no lleva corte ni nivel.
        el.form.querySelectorAll('[data-met-corte]').forEach((x) => { x.hidden = el.value === 'PLACA'; });
    },
    'user-rol': (el) => {
        const fs = el.form?.querySelector('[data-granjas]');
        if (fs) fs.hidden = el.value === ROLES.ADMIN;
    },
};

const SUBMITS = {
    login: async (form) => {
        const email = form.email.value.trim();
        const password = form.password.value;
        if (!email || !password) return showLoginError('Escribe tu correo y tu contraseña.');
        hideAllPasswords();
        const btn = form.querySelector('[type=submit]');
        btn.classList.add('is-loading'); btn.disabled = true;
        showLoginError('');
        try { await signInWithEmailAndPassword(auth, email, password); } catch (e) { showLoginError(authErrorMsg(e)); } finally { btn.classList.remove('is-loading'); btn.disabled = false; }
    },
    'change-password': async (form) => {
        const err = form.querySelector('.form-error');
        const fail = (msg) => { err.textContent = msg; err.hidden = false; };
        err.hidden = true;
        const p1 = form.p1.value;
        const problema = passwordProblem(p1);
        if (problema) return fail(problema);
        if (p1 !== form.p2.value) return fail('Las contraseñas no coinciden.');
        hideAllPasswords();
        const btn = form.querySelector('[type=submit]');
        btn.classList.add('is-loading'); btn.disabled = true;
        try {
            await updatePassword(auth.currentUser, p1);
            // El servidor confirma el cambio consultando a Firebase: no confía en el navegador.
            await api('passwordChanged', {}, { forceRefresh: true });
            form.reset();
            toast('Contraseña actualizada.', 'success');
            await bootSession(true);
        } catch (e) {
            if (e.code === 'auth/requires-recent-login') {
                fail('Por seguridad, vuelve a iniciar sesión con la contraseña temporal y cámbiala de inmediato.');
                setTimeout(() => signOut(auth), 3000);
            } else if (e.code === 'auth/weak-password' || e.code === 'auth/password-does-not-meet-requirements') {
                fail('Esa contraseña no cumple los requisitos de seguridad. Elige otra.');
            } else {
                fail(String(e.code || '').startsWith('auth/') ? authErrorMsg(e) : (e.message || authErrorMsg(e)));
            }
        } finally { btn.classList.remove('is-loading'); btn.disabled = false; }
    },
    'add-lista': async (form) => {
        if (!form.checkValidity()) return form.reportValidity();
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        try { await save('saveLista', { Tipo: form.Tipo.value, Valor: form.Valor.value.trim() }, 'Valor agregado.'); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
    },
};

function setPasswordVisible(btn, visible) {
    const input = btn.closest('.password-field')?.querySelector('input');
    if (!input) return;
    input.type = visible ? 'text' : 'password';
    btn.innerHTML = ico(visible ? 'eye-off' : 'eye');
    btn.setAttribute('aria-pressed', String(visible));
    const label = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    input.focus({ preventScroll: true });
}
function hideAllPasswords() {
    $$('.password-toggle[aria-pressed="true"]').forEach(btn => setPasswordVisible(btn, false));
    document.activeElement?.blur?.();
}
function passwordProblem(pw) {
    if (pw.length < CONFIG.MIN_CLAVE) return `Debe tener al menos ${CONFIG.MIN_CLAVE} caracteres.`;
    if (!/[a-zñ]/.test(pw) || !/[A-ZÑ]/.test(pw) || !/\d/.test(pw)) return 'Debe combinar mayúsculas, minúsculas y números.';
    const local = String(auth.currentUser?.email || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'No uses tu correo dentro de la contraseña.';
    if (/^(.)\1+$/.test(pw) || /1234567|abcdefg|qwerty|password|contrase/i.test(pw)) return 'Esa contraseña es demasiado fácil de adivinar.';
    return '';
}

document.addEventListener('click', (ev) => {
    // Cierra el selector de granjas al hacer clic fuera de él.
    const dd = $('details.dropdown[open]');
    if (dd && !dd.contains(ev.target)) { dd.open = false; state.ddOpen = false; }
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    ev.preventDefault();
    Promise.resolve(fn(el, ev)).catch((e) => { console.error('[Granjas]', e); toast(e.message || 'No se pudo completar la acción.', 'error'); });
});
document.addEventListener('toggle', (ev) => {
    if (ev.target.matches?.('details.dropdown')) state.ddOpen = ev.target.open;
}, true);
document.addEventListener('paste', (ev) => {
    // Pegar varios pesos de una vez (separados por espacios, comas o saltos de línea).
    if (ev.target.id !== 'pz-input') return;
    const texto = ev.clipboardData?.getData('text') || '';
    if (/[\s,;]/.test(texto.trim())) { ev.preventDefault(); pzAgregar(texto); }
});
document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-input]');
    if (el) INPUTS[el.dataset.input]?.(el, ev);
});
document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (el) CHANGES[el.dataset.change]?.(el, ev);
});
document.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-submit]');
    if (!form) return;
    ev.preventDefault();
    SUBMITS[form.dataset.submit]?.(form, ev);
});
document.addEventListener('keydown', (ev) => {
    // Pesaje: Enter agrega el peso y deja el cursor listo para el siguiente.
    if (ev.key === 'Enter' && ev.target.id === 'pz-input') {
        ev.preventDefault();
        if (ev.target.value.trim()) { pzAgregar(ev.target.value); ev.target.value = ''; }
        return;
    }
    if (ev.key === 'Escape' && mqMobile.matches && $('#screen-app').classList.contains('sidebar-open')) toggleSidebar(false);
});
window.addEventListener('hashchange', () => {
    if (mqMobile.matches) toggleSidebar(false);   // en celular el menú se cierra al navegar
    state.ddOpen = false;
    render();
    window.scrollTo({ top: 0 });
});

function authErrorMsg(e) {
    const map = {
        'auth/invalid-credential': 'Correo o contraseña incorrectos.',
        'auth/invalid-login-credentials': 'Correo o contraseña incorrectos.',
        'auth/wrong-password': 'Correo o contraseña incorrectos.',
        'auth/user-not-found': 'Correo o contraseña incorrectos.',
        'auth/invalid-email': 'El correo no es válido.',
        'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
        'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
        'auth/user-disabled': 'Esta cuenta está suspendida. Contacta a la administración.',
    };
    if (!map[e?.code]) console.error('[Granjas] Error de autenticación:', e);
    return map[e?.code] || 'No se pudo completar la operación. Intenta de nuevo.';
}
function showLoginError(msg) {
    const el = $('#login-form .form-error');
    el.textContent = msg;
    el.hidden = !msg;
}
function showDenied(title, text, actionsHtml = '') {
    $('#denied-title').textContent = title;
    $('#denied-text').textContent = text;
    $('#denied-actions').innerHTML = actionsHtml;
    showScreen('denied');
}
function showAccessDenied(e) {
    const titles = { NOT_REGISTERED: 'Cuenta sin acceso', SUSPENDED: 'Acceso suspendido', ACCOUNT_LOCKED: 'Cuenta en revisión' };
    state.me = null;
    showDenied(titles[e.code] || 'Sin acceso', e.message);
}
function showPasswordScreen() {
    $('#password-email').textContent = auth.currentUser?.email || '';
    $('#password-form .form-error').hidden = true;
    showScreen('password');
}

async function bootSession(forceRefresh = false) {
    showScreen('loading');
    $('#loading-text').textContent = 'Cargando tu información…';
    try {
        await loadSnapshot({ forceRefresh });
        if (state.mustChangePassword) return showPasswordScreen();
        renderChrome();
        showScreen('app');
        syncMenuButton();
        if (!location.hash || !VIEWS[parseHash().view]) history.replaceState(null, '', `#/${HOME[state.me.Rol]}`);
        render();
    } catch (e) {
        if (ACCESS_CODES.has(e.code) || e.code === 'FORBIDDEN') return showAccessDenied(e);
        if (!(e instanceof ApiError)) console.error('[Granjas] Error al cargar la sesión:', e);
        showDenied('No se pudo conectar', e instanceof ApiError ? e.message : MSG.BAD_RESPONSE,
            '<button type="button" class="btn btn-primary btn-block" data-action="retry-session">Reintentar</button>');
    }
}

/**
 * Al cerrar sesión no queda nada del usuario anterior: ni datos en memoria ni la vista
 * dibujada (oculta, pero legible en el código de la página en un equipo compartido).
 */
function limpiarSesion() {
    state.me = null;
    state.db = emptyDb();
    state.cache.clear();
    state.audit = null;
    state.granjaId = null;
    state.f = filtrosIniciales();
    state.q = {};
    state.sort = {};
    state.bitGranja = '';
    state.registros = new Map();
    state.pesajes = new Map();
    state.lecturas = new Map();
    state.compras = new Map();
    state.estFilas = new Map();
    pz = null;
    chartUnmounts.forEach(f => f());
    chartUnmounts = [];
    Object.keys(tables).forEach(k => delete tables[k]);
    Object.keys(charts).forEach(k => delete charts[k]);
    ['#view', '#nav', '#user-chip', '#page-title'].forEach(s => $(s).replaceChildren());
    sesionN++;   // una consulta que llegue tarde ya no entra a la caché de la sesión siguiente
    document.title = 'Granjas · Registro avícola';
}

// Cierre de sesión automático por inactividad (equipos compartidos).
let lastActivity = Date.now();
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type =>
    window.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
    if (!auth.currentUser || Date.now() - lastActivity < CONFIG.INACTIVIDAD_MIN * 60000) return;
    signOut(auth);
    toast(`Tu sesión se cerró tras ${CONFIG.INACTIVIDAD_MIN} minutos de inactividad.`, 'info', 10000);
}, 30000);

onAuthStateChanged(auth, (user) => {
    state.user = user;
    lastActivity = Date.now();
    if (!user) {
        limpiarSesion();
        $('#login-form').reset();
        showScreen('login');
        return;
    }
    bootSession();
});
