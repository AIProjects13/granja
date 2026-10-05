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
import { mountChart, exportChartPng, downloadBlob, PALETTE } from './charts.js';

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
const LINEAS = ['Postura', 'Engorde'];
const LINEA_ICON = { Postura: 'egg', Engorde: 'bird' };
const SECCION_ICON = {
    'Información de origen': 'globe',
    'Información de incubadora': 'egg',
    'Programa de vacunación incubadora': 'syringe',
    'Información granja': 'warehouse',
};
const LISTA_LABEL = {
    Pais: 'Países', Raza: 'Razas', SistemaAlojamiento: 'Sistemas de alojamiento',
    EmpresaIncubadora: 'Empresas incubadoras', Vacuna: 'Vacunas',
};
const PRESETS = [[30, '30 días'], [90, '90 días'], [180, '6 meses'], [365, '1 año'], [0, 'Todo']];
const AGRUPAR = [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']];

window.__granjasIniciada = true;   // avisa a boot-check.js que la app sí arrancó
hydrateIcons();

const auth = initializeAuth(initializeApp(CONFIG.firebase), { persistence: browserSessionPersistence });

// ==========================================================================
// 2. ESTADO
// ==========================================================================

const emptyDb = () => ({
    granjas: [], perfiles: [], users: [], listas: [],
    campos: { perfil: [], Postura: [], Engorde: [] }, tiposLista: [],
});

const state = {
    user: null,
    me: null,
    db: emptyDb(),
    busy: 0,
    granjaId: null,          // representante: granja activa (cada granja se trabaja por separado)
    linea: 'Postura',
    f: { desde: daysAgo(CONFIG.RANGO_INICIAL_DIAS), hasta: today(), granjas: [], agrupar: 'semana', eliminados: false },
    cache: new Map(),        // respuestas de lectura (registros, bitácora…) por solicitud
    loading: new Set(),
    sort: {},
    q: {},
    audit: null,
    ddOpen: false,
    registros: new Map(),    // RegistroID → registro visible (para las acciones de la tabla)
};

const tables = {};
const charts = {};
let chartUnmounts = [];

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
const READ_ACTIONS = new Set(['getSnapshot', 'getRegistros', 'getResumen', 'getBitacora', 'getAccesos', 'verifyAudit']);
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
        withBusy(() => api(action, payload))
            .then(data => state.cache.set(key, { ok: true, data }))
            .catch(e => state.cache.set(key, { ok: false, error: e.message, code: e.code }))
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
function lineasDisponibles(ids) {
    return LINEAS.filter(l => ids.some(id => perfilDe(id, l)?.Estado === 'Activo'));
}
function ensureLinea(ids) {
    const d = lineasDisponibles(ids);
    if (d.length && !d.includes(state.linea)) state.linea = d[0];
    return d;
}
/** Granjas que se piden al servidor (el servidor vuelve a validar el acceso). */
function apiGranjas() {
    if (!isAdmin()) return state.granjaId ? [state.granjaId] : [];
    return state.f.granjas.length ? [...state.f.granjas] : undefined;
}
function registrosPayload(extra = {}) {
    return {
        Linea: state.linea, GranjaIDs: apiGranjas(),
        desde: state.f.desde || undefined, hasta: state.f.hasta || undefined, ...extra,
    };
}
const camposDe = linea => state.db.campos[linea] || [];
const camposNumericos = linea => camposDe(linea).filter(c => c.agg);
function camposComunes() {
    const eng = new Set(camposDe('Engorde').map(c => c.k));
    return camposDe('Postura').filter(c => eng.has(c.k) && c.k !== 'Comentarios');
}

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
    return `${key.slice(5)} ${key.slice(0, 4)}`;
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

/** Gráficos por línea: [campo, nombre de la serie, color, punteada]. */
const CHARTS = {
    Postura: [
        { id: 'postura', title: 'Postura (%)', icon: 'egg', unit: '%', type: 'line', series: [['PosturaPorcentaje', 'Postura real', 'primary'], ['PosturaTabla', 'Tabla', 'secondary', true]] },
        { id: 'mortalidad', title: 'Mortalidad (%)', icon: 'activity', unit: '%', type: 'line', series: [['MortalidadPorcentaje', 'Mortalidad real', 'primary'], ['MortalidadIdeal', 'Ideal', 'tertiary', true]] },
        { id: 'consumo', title: 'Consumo de alimento (g/ave/día)', icon: 'wheat', unit: 'g', type: 'line', series: [['ConsumoGramosAveDia', 'Consumo real', 'primary'], ['ConsumoTabla', 'Tabla', 'secondary', true]] },
        { id: 'huevo', title: 'Clasificación de huevo', icon: 'chart-column', type: 'bar', series: [['HuevoPiwi', 'Piwi', 'slate'], ['HuevoMediano', 'Mediano', 'secondary'], ['HuevoGrande', 'Grande', 'primary'], ['HuevoExtragrande', 'Extragrande', 'tertiary']], stack: true },
        { id: 'densidad', title: 'Densidad', icon: 'warehouse', type: 'line', series: [['DensidadReal', 'Densidad real', 'primary'], ['DensidadIdeal', 'Ideal', 'tertiary', true]] },
        { id: 'aves', title: 'Mortalidad (aves)', icon: 'bird', type: 'bar', series: [['MortalidadNominal', 'Mortalidad (aves)', 'amber']] },
    ],
    Engorde: [
        { id: 'peso', title: 'Peso corporal', icon: 'scale', type: 'line', series: [['PesoCorporalReal', 'Peso real', 'primary'], ['PesoCorporalTabla', 'Tabla', 'secondary', true]] },
        { id: 'mortalidad', title: 'Mortalidad (%)', icon: 'activity', unit: '%', type: 'line', series: [['MortalidadPorcentaje', 'Mortalidad real', 'primary'], ['MortalidadIdeal', 'Ideal', 'tertiary', true]] },
        { id: 'consumo', title: 'Consumo de alimento (g/ave/día)', icon: 'wheat', unit: 'g', type: 'line', series: [['ConsumoGramosAveDia', 'Consumo real', 'primary'], ['ConsumoTabla', 'Tabla', 'secondary', true]] },
        { id: 'pesoideal', title: 'Peso corporal ideal (%)', icon: 'trending-up', unit: '%', type: 'line', series: [['PesoCorporalIdealPorcentaje', 'Peso ideal (%)', 'tertiary']] },
        { id: 'aves', title: 'Mortalidad (aves)', icon: 'bird', type: 'bar', series: [['MortalidadNominal', 'Mortalidad (aves)', 'amber']] },
        { id: 'consumototal', title: 'Consumo total (quintales)', icon: 'wheat', type: 'bar', series: [['ConsumoQuintalesTotal', 'Quintales', 'secondary']] },
    ],
};

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
    chartUnmounts = $$('canvas[data-chart]').map(cv => mountChart(cv, charts[cv.dataset.chart]));
}

// ==========================================================================
// 7. NAVEGACIÓN Y ESTRUCTURA
// ==========================================================================

const NAV = {
    ADMIN: [['dashboard', 'Dashboard', 'layout-dashboard'], ['registros', 'Registros', 'clipboard-list'],
        ['granjas', 'Granjas', 'warehouse'], ['usuarios', 'Usuarios', 'users'], ['listas', 'Listas', 'list'],
        ['bitacora', 'Bitácora', 'history'], ['seguridad', 'Seguridad', 'shield-check']],
    REPRESENTANTE: [['granja', 'Mi granja', 'warehouse'], ['dashboard', 'Dashboard', 'layout-dashboard'],
        ['registros', 'Registros', 'clipboard-list'], ['bitacora', 'Bitácora', 'history']],
};
const HOME = { ADMIN: 'dashboard', REPRESENTANTE: 'granja' };
const A = [ROLES.ADMIN], ALL = [ROLES.ADMIN, ROLES.REPRESENTANTE];
const VIEWS = {
    dashboard: { roles: ALL, title: 'Dashboard', render: viewDashboard },
    registros: { roles: ALL, title: 'Registros de producción', render: viewRegistros },
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

function lineaTabs(disp) {
    return `<div class="filter-group"><span class="field-label">Línea</span><div class="segmented" role="group" aria-label="Línea de producción">${LINEAS.map((l) => {
        const ok = disp.includes(l);
        return `<button type="button" class="seg${l === state.linea && ok ? ' is-active' : ''}" data-action="set-linea" data-linea="${l}"${ok ? '' : ` disabled title="Sin perfil de ${l.toLowerCase()} en ${isAdmin() ? 'las granjas seleccionadas' : 'esta granja'}"`} aria-pressed="${l === state.linea && ok}">${ico(LINEA_ICON[l])}${l}</button>`;
    }).join('')}</div></div>`;
}

function dateFilters() {
    return `<div class="date-range"><label class="field"><span>Desde</span><input type="date" data-change="f-desde" value="${esc(state.f.desde)}"${state.f.hasta ? ` max="${esc(state.f.hasta)}"` : ''}></label>
        <label class="field"><span>Hasta</span><input type="date" data-change="f-hasta" value="${esc(state.f.hasta)}"${state.f.desde ? ` min="${esc(state.f.desde)}"` : ''}></label></div>
        <div class="filter-group"><span class="field-label">Rango rápido</span><div class="presets">${PRESETS.map(([d, l]) =>
        `<button type="button" class="btn btn-sm" data-action="preset" data-days="${d}">${l}</button>`).join('')}</div></div>`;
}

function filtersCard({ lineas = true, fechas = true, agrupar = false, eliminados = false } = {}) {
    const disp = lineas ? ensureLinea(ctxIds()) : [];
    return `<div class="card"><div class="filters">
        ${isAdmin() ? granjaPicker() : granjaSwitch()}
        ${lineas ? lineaTabs(disp) : ''}
        ${fechas ? dateFilters() : ''}
        ${agrupar ? `<div class="filter-group"><span class="field-label">Agrupar por</span><div class="segmented" role="group" aria-label="Agrupar por">${AGRUPAR.map(([k, l]) =>
        `<button type="button" class="seg${state.f.agrupar === k ? ' is-active' : ''}" data-action="set-agrupar" data-agrupar="${k}" aria-pressed="${state.f.agrupar === k}">${l}</button>`).join('')}</div></div>` : ''}
        ${eliminados && isAdmin() ? `<label class="check"><input type="checkbox" data-change="f-eliminados"${state.f.eliminados ? ' checked' : ''}> Incluir eliminados</label>` : ''}
    </div></div>`;
}

function noGranjas() {
    return isAdmin()
        ? emptyState('Aún no hay granjas registradas.', 'warehouse', `<button type="button" class="btn btn-primary" data-action="new-granja">${ico('plus')}Nueva granja</button>`)
        : emptyState('No tienes granjas asignadas. Contacta a la administración.', 'warehouse');
}

// ==========================================================================
// 8. VISTAS: DASHBOARD Y REGISTROS
// ==========================================================================

function viewDashboard() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ agrupar: true });
    const disp = lineasDisponibles(ids);
    if (!disp.length) return head + emptyState('Las granjas seleccionadas aún no tienen perfil de postura ni de engorde.', 'clipboard-list');

    const r = need('getRegistros', registrosPayload());
    if (!r) return head + `<div class="kpis">${loadingBlock(1)}</div><div class="grid-2">${loadingBlock(2)}</div>`;
    if (!r.ok) return head + errorBlock(r);

    const linea = state.linea;
    const regs = r.data.registros;
    const campos = camposNumericos(linea);
    const agr = state.f.agrupar;
    const rango = state.f.desde || state.f.hasta ? `${fmtDate(state.f.desde) || 'inicio'} a ${fmtDate(state.f.hasta) || 'hoy'}` : 'Todo el historial';
    const contexto = isAdmin() ? (state.f.granjas.length ? state.f.granjas.map(granjaName).join(', ') : 'Todas las granjas') : granjaName(state.granjaId);

    let html = head;
    if (r.data.truncado) html += alertBox('warn', 'alert-triangle', 'Hay más registros de los que se pueden analizar a la vez. Reduce el rango de fechas para ver todo.');
    if (!regs.length) return html + emptyState(`No hay registros de ${linea.toLowerCase()} en el rango seleccionado.`, 'chart-line');

    // KPIs del rango completo
    const tot = aggregate(regs, campos, () => 'total')[0];
    const ultimo = new Map();
    regs.forEach((x) => { if (!ultimo.has(x.GranjaID)) ultimo.set(x.GranjaID, toNum(x.NumeroAves)); });   // vienen de más reciente a más antiguo
    const aves = [...ultimo.values()].reduce((a, v) => a + (v || 0), 0);
    html += `<div class="kpis">
        ${kpi('Registros', nf.format(regs.length), rango, 'clipboard-list')}
        ${kpi('Aves', nf.format(aves), ultimo.size > 1 ? 'Último registro de cada granja' : 'Último registro', 'bird')}
        ${kpi('Mortalidad', fmtNum(gSum(tot, 'MortalidadNominal')), `Promedio ${fmtNum(gAvg(tot, 'MortalidadPorcentaje'))} %`, 'activity')}
        ${kpi('Consumo', `${fmtNum(gSum(tot, 'ConsumoQuintalesTotal'))} qq`, `${fmtNum(gAvg(tot, 'ConsumoGramosAveDia'))} g/ave/día`, 'wheat')}
        ${linea === 'Postura'
            ? kpi('Postura', `${fmtNum(gAvg(tot, 'PosturaPorcentaje'))} %`, `Tabla ${fmtNum(gAvg(tot, 'PosturaTabla'))}`, 'egg')
            : kpi('Peso corporal', fmtNum(gAvg(tot, 'PesoCorporalReal')), `Tabla ${fmtNum(gAvg(tot, 'PesoCorporalTabla'))}`, 'scale')}
    </div>`;

    // Gráficos por periodo
    const grupos = aggregate(regs, campos, x => periodo(x.Fecha, agr));
    const labels = grupos.map(g => periodoLabel(g.key, agr));
    const sub = `${contexto} · ${rango} · por ${AGRUPAR.find(a => a[0] === agr)[1].toLowerCase()}`;
    html += '<div class="grid-2">' + CHARTS[linea].map((def) => {
        const spec = {
            title: def.title, subtitle: sub, icon: def.icon, type: def.type, unit: def.unit, labels,
            series: def.series.map(([k, name, color, dashed]) => ({
                name, color: PALETTE[color], dashed, stack: def.stack ? 'h' : undefined,
                data: grupos.map(g => { const c = campos.find(x => x.k === k); return c ? round(gVal(g, c)) : null; }),
            })),
        };
        return chartCard(`${linea}-${def.id}`, spec);
    }).join('') + '</div>';

    // Comparativo por granja (administrador con varias granjas)
    const porGranja = aggregate(regs, campos, x => x.GranjaID);
    if (isAdmin() && porGranja.length > 1) {
        const main = linea === 'Postura' ? ['PosturaPorcentaje', 'PosturaTabla', 'Postura (%)'] : ['PesoCorporalReal', 'PesoCorporalTabla', 'Peso corporal'];
        html += chartCard(`${linea}-granjas`, {
            title: `${main[2]} por granja`, subtitle: rango, icon: 'warehouse', type: 'bar',
            labels: porGranja.map(g => granjaName(g.key)),
            series: [
                { name: 'Real (promedio)', color: PALETTE.primary, data: porGranja.map(g => round(gAvg(g, main[0]))) },
                { name: 'Tabla (promedio)', color: PALETTE.secondary, data: porGranja.map(g => round(gAvg(g, main[1]))) },
                { name: 'Mortalidad (%)', color: PALETTE.amber, data: porGranja.map(g => round(gAvg(g, 'MortalidadPorcentaje'))) },
            ],
        });
        html += table('comparativo', {
            title: 'Comparativo por granja', icon: 'warehouse', csv: `comparativo-${linea}`,
            columns: [{ k: 'granja', l: 'Granja', sticky: true }, { k: 'n', l: 'Registros', t: 'num' }]
                .concat(campos.map(c => ({ k: c.k, l: `${c.l}${c.agg === 'suma' ? ' (total)' : ' (prom.)'}`, t: 'num' }))),
            rows: porGranja.map(g => Object.assign({ granja: granjaName(g.key), n: g.n }, ...campos.map(c => ({ [c.k]: round(gVal(g, c)) })))),
        });
    }

    // Resumen por periodo
    html += table('resumen', {
        title: `Resumen por ${AGRUPAR.find(a => a[0] === agr)[1].toLowerCase()}`, icon: 'calendar-range', csv: `resumen-${linea}-${agr}`,
        columns: [{ k: 'key', l: 'Periodo', sticky: true, html: x => esc(periodoLabel(x.key, agr)), csv: x => x.key }, { k: 'n', l: 'Registros', t: 'num' }]
            .concat(campos.map(c => ({ k: c.k, l: `${c.l}${c.agg === 'suma' ? ' (total)' : ' (prom.)'}`, t: 'num' }))),
        rows: grupos.map(g => Object.assign({ key: g.key, n: g.n }, ...campos.map(c => ({ [c.k]: round(gVal(g, c)) })))),
    });
    return html;
}

function round(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }

function viewRegistros() {
    const ids = ctxIds();
    if (!ids.length) return noGranjas();
    const head = filtersCard({ eliminados: true });
    const disp = lineasDisponibles(ids);
    if (!disp.length) return head + emptyState('Las granjas seleccionadas aún no tienen perfil de postura ni de engorde.', 'clipboard-list');

    const linea = state.linea;
    const nuevo = `<div class="row row-center"><button type="button" class="btn btn-primary" data-action="new-registro">${ico('plus')}Nuevo registro de ${linea.toLowerCase()}</button></div>`;
    const r = need('getRegistros', registrosPayload({ incluirEliminados: isAdmin() && state.f.eliminados ? true : undefined }));
    if (!r) return head + nuevo + loadingBlock(1);
    if (!r.ok) return head + nuevo + errorBlock(r);

    state.registros = new Map(r.data.registros.map(x => [x.RegistroID, x]));
    const varias = isAdmin() && ctxIds().length > 1;
    const columns = [{ k: 'Fecha', l: 'Fecha', t: 'datetime', sticky: true }]
        .concat(varias || isAdmin() ? [{ k: 'GranjaID', l: 'Granja', get: x => granjaName(x.GranjaID) }] : [])
        .concat([{ k: 'NumeroLote', l: 'Lote' }])
        .concat(camposDe(linea).map(c => ({ k: c.k, l: c.l, t: c.agg ? 'num' : 'text', wrap: c.t === 'textoLargo' })))
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
            return flag + `<button type="button" class="icon-btn icon-btn-sm" data-action="edit-registro" data-id="${esc(x.RegistroID)}" title="Editar" aria-label="Editar registro">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-registro" data-id="${esc(x.RegistroID)}" title="Eliminar" aria-label="Eliminar registro">${ico('trash')}</button>`;
        },
    });
    return html;
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
        _postura: perfilDe(g.GranjaID, 'Postura'),
        _engorde: perfilDe(g.GranjaID, 'Engorde'),
        _reps: representantesDe(g.GranjaID).length,
    }));
    const lineaBadge = p => (!p ? '<span class="badge badge-muted">No</span>' : p.Estado === 'Activo' ? '<span class="badge badge-ok">Sí</span>' : '<span class="badge badge-warn">Suspendido</span>');
    return `<div class="section-head"><p class="muted">Cada granja puede tener una línea de postura y una de engorde, cada una con su propia ficha.</p>
        <button type="button" class="btn btn-primary" data-action="new-granja">${ico('plus')}Nueva granja</button></div>`
        + table('granjas', {
            title: 'Granjas', icon: 'warehouse', empty: 'Aún no hay granjas registradas.',
            columns: [
                { k: 'NombreGranja', l: 'Granja', sticky: true, html: g => `<button type="button" class="btn btn-link" data-action="open-granja" data-id="${esc(g.GranjaID)}">${esc(g.NombreGranja)}</button>${g.Alterado ? ` <span class="badge badge-danger" title="Modificada fuera de la plataforma">${ico('lock', 'icon-sm')}</span>` : ''}` },
                { k: 'Propietario', l: 'Propietario' },
                { k: 'Ubicacion', l: 'Ubicación' },
                { k: '_postura', l: 'Postura', get: g => (g._postura ? g._postura.Estado : 'No'), html: g => lineaBadge(g._postura) },
                { k: '_engorde', l: 'Engorde', get: g => (g._engorde ? g._engorde.Estado : 'No'), html: g => lineaBadge(g._engorde) },
                { k: '_reps', l: 'Representantes', t: 'num' },
                { k: 'Estado', l: 'Estado', html: g => badgeEstado(g.Estado) },
                { k: 'FechaAlta', l: 'Alta', t: 'date' },
            ],
            rows,
            actions: g => `<button type="button" class="icon-btn icon-btn-sm" data-action="open-granja" data-id="${esc(g.GranjaID)}" title="Ver ficha" aria-label="Ver ficha">${ico('arrow-up-right')}</button>
                <button type="button" class="icon-btn icon-btn-sm" data-action="edit-granja" data-id="${esc(g.GranjaID)}" title="Editar" aria-label="Editar granja">${ico('pencil')}</button>
                <button type="button" class="icon-btn icon-btn-sm" data-action="estado-granja" data-id="${esc(g.GranjaID)}" title="${g.Estado === 'Activo' ? 'Suspender' : 'Activar'}" aria-label="${g.Estado === 'Activo' ? 'Suspender' : 'Activar'} granja">${ico(g.Estado === 'Activo' ? 'circle-pause' : 'circle-play')}</button>
                <button type="button" class="icon-btn icon-btn-sm danger" data-action="delete-granja" data-id="${esc(g.GranjaID)}" title="Eliminar" aria-label="Eliminar granja">${ico('trash')}</button>`,
        });
}

/** Información general de la granja: datos + las dos líneas lado a lado (la que no existe, en gris). */
function viewGranja(param) {
    const id = isAdmin() ? param : state.granjaId;
    if (!state.db.granjas.length && !isAdmin()) return noGranjas();
    const g = id && granjaById(id);
    if (!g) {
        return emptyState('Granja no encontrada.', 'warehouse', isAdmin() ? `<button type="button" class="btn" data-action="nav" data-view="granjas">${ico('arrow-left')}Volver a granjas</button>` : '');
    }
    const admin = isAdmin();
    let html = '';
    if (!admin && state.db.granjas.length > 1) html += `<div class="card"><div class="filters">${granjaSwitch()}</div></div>`;

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

    html += `<div class="grid-2">${LINEAS.map(l => perfilCard(g, l)).join('')}</div>`;

    if (admin) {
        const reps = representantesDe(g.GranjaID);
        html += `<div class="card"><div class="card-head card-title-center"><h3>${ico('users')}Representantes</h3></div>
            ${reps.length ? `<div class="chips">${reps.map(u => `<span class="chip">${ico('user', 'icon-sm')}${esc(u.Nombre)} · ${esc(u.Email)} ${badgeEstado(u.Estado)}</span>`).join('')}</div>`
                : '<p class="muted center">Esta granja aún no tiene representantes.</p>'}
            <div class="row row-center"><button type="button" class="btn btn-sm" data-action="new-user" data-granja="${esc(g.GranjaID)}">${ico('user-plus')}Agregar representante</button></div></div>`;
    }
    return html;
}

function perfilCard(g, linea) {
    const p = perfilDe(g.GranjaID, linea);
    const admin = isAdmin();
    if (!p) {
        return `<div class="card is-disabled" aria-disabled="true">
            <div class="card-head card-title-center"><h2>${ico(LINEA_ICON[linea])}Línea de ${linea.toLowerCase()}</h2></div>
            <div class="empty-line">${ico(LINEA_ICON[linea], 'icon-lg')}<p>Esta granja no tiene línea de ${linea.toLowerCase()}.</p>
            ${admin ? `<button type="button" class="btn btn-sm" data-action="new-perfil" data-granja="${esc(g.GranjaID)}" data-linea="${linea}">${ico('plus')}Crear perfil de ${linea.toLowerCase()}</button>` : ''}</div>
        </div>`;
    }
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
    return `<div class="card${p.Estado !== 'Activo' ? ' is-disabled' : ''}">
        <div class="card-head card-title-center"><h2>${ico(LINEA_ICON[linea])}Línea de ${linea.toLowerCase()}</h2>${badgeEstado(p.Estado)}${p.Alterado ? `<span class="badge badge-danger">${ico('lock', 'icon-sm')}Modificado fuera de la plataforma</span>` : ''}</div>
        ${secciones.map(s => `<section class="profile-section"><h3>${ico(SECCION_ICON[s.s] || 'list')}${esc(s.s)}</h3>
            <dl class="kv">${s.campos.map(c => `<div><dt>${esc(c.l)}</dt>${valor(c)}</div>`).join('')}</dl></section>`).join('')}
        ${p.ActualizadoEn ? `<p class="muted center">Última actualización ${esc(fmtDateTime(p.ActualizadoEn))}</p>` : ''}
        ${admin ? `<div class="row row-center">
            <button type="button" class="btn btn-sm" data-action="edit-perfil" data-id="${esc(p.PerfilID)}">${ico('pencil')}Editar ficha</button>
            <button type="button" class="btn btn-sm" data-action="estado-perfil" data-id="${esc(p.PerfilID)}">${ico(p.Estado === 'Activo' ? 'circle-pause' : 'circle-play')}${p.Estado === 'Activo' ? 'Suspender' : 'Activar'}</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete-perfil" data-id="${esc(p.PerfilID)}">${ico('trash')}Eliminar</button></div>` : ''}
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
    const head = `<div class="card"><div class="filters">${granjaSel}${dateFilters()}</div></div>`;
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
    const head = `<div class="card"><div class="filters">${dateFilters()}</div></div>`;
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

const TABLA_LABEL = {
    Usuarios: 'Usuarios', Granjas: 'Granjas', Perfiles: 'Fichas de línea', Listas: 'Listas',
    Registros_Postura: 'Registros de postura', Registros_Engorde: 'Registros de engorde',
};
const ACCION_LABEL = {
    getSnapshot: 'Ingreso', getRegistros: 'Consulta de registros', getResumen: 'Consulta de resumen', getBitacora: 'Consulta de bitácora',
    saveRegistro: 'Guardar registro', deleteRegistro: 'Eliminar registro', passwordChanged: 'Cambio de contraseña',
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
        dlg.addEventListener('close', () => { dlg.innerHTML = ''; resolve(result); }, { once: true });
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

function inputFor(c, value = '') {
    const req = c.req ? ' required' : '';
    const lbl = `<span>${esc(c.l)}${c.req ? ' <span class="req">*</span>' : ''}</span>`;
    const v = esc(value ?? '');
    if (c.t === 'textoLargo') return `<label class="field span-all">${lbl}<textarea name="${c.k}" maxlength="1000"${req}>${v}</textarea></label>`;
    if (c.t === 'entero' || c.t === 'numero') {
        return `<label class="field">${lbl}<input type="number" name="${c.k}" inputmode="${c.t === 'entero' ? 'numeric' : 'decimal'}" step="${c.t === 'entero' ? '1' : 'any'}"${c.min !== undefined ? ` min="${c.min}"` : ''}${c.max !== undefined ? ` max="${c.max}"` : ''} value="${v}"${req}></label>`;
    }
    if (c.t === 'fecha') return `<label class="field">${lbl}<input type="date" name="${c.k}" value="${v}"${req}></label>`;
    return `<label class="field">${lbl}<input type="text" name="${c.k}" maxlength="${c.max || 150}"${c.lista ? ` list="dl-${c.lista}"` : ''} value="${v}" autocomplete="off"${req}></label>`;
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

// ---------- Registros ----------
async function openRegistroModal(reg = null) {
    const linea = state.linea;
    const campos = camposDe(linea);
    const comunes = new Set(camposComunes().map(c => c.k));
    let granjaHtml;
    if (reg) {
        granjaHtml = `<label class="field"><span>Granja</span><input value="${esc(granjaName(reg.GranjaID))}" readonly></label>
            <label class="field"><span>Fecha del registro</span><input value="${esc(fmtDateTime(reg.Fecha))}" readonly></label>`;
    } else if (!isAdmin()) {
        granjaHtml = `<label class="field"><span>Granja</span><input value="${esc(granjaName(state.granjaId))}" readonly></label>
            <label class="field"><span>Fecha</span><input value="Automática" readonly></label>`;
    } else {
        const opciones = ctxIds().filter(id => perfilDe(id, linea)?.Estado === 'Activo' && granjaById(id)?.Estado === 'Activo');
        if (!opciones.length) return toast(`Ninguna granja activa seleccionada tiene perfil de ${linea.toLowerCase()}.`, 'error');
        granjaHtml = `<label class="field"><span>Granja <span class="req">*</span></span><select name="GranjaID" required>${opciones.map(id =>
            `<option value="${esc(id)}">${esc(granjaName(id))}</option>`).join('')}</select></label>
            <label class="field"><span>Fecha</span><input value="Automática" readonly></label>`;
    }
    const sec = (title, icon, list) => `<section class="form-section"><h3>${ico(icon)}${esc(title)}</h3><div class="form-grid">${list.map(c => inputFor(c, reg?.[c.k])).join('')}</div></section>`;
    const body = `<section class="form-section"><div class="form-grid">${granjaHtml}</div></section>
        ${sec('Datos generales', 'bird', campos.filter(c => comunes.has(c.k)))}
        ${sec(linea === 'Postura' ? 'Producción de huevo' : 'Peso corporal', linea === 'Postura' ? 'egg' : 'scale', campos.filter(c => !comunes.has(c.k) && c.k !== 'Comentarios'))}
        ${sec('Observaciones', 'clipboard-list', campos.filter(c => c.k === 'Comentarios'))}
        ${reg ? `<section class="form-section">${justField('Explica qué se corrige y por qué.')}</section>` : ''}`;

    await openModal({
        title: reg ? `Editar registro de ${linea.toLowerCase()}` : `Nuevo registro de ${linea.toLowerCase()}`,
        wide: true, body, submitLabel: reg ? 'Guardar cambios' : 'Guardar registro',
        onSubmit: async (fd) => {
            const p = formPayload(fd);
            const payload = { ...p, Linea: linea };
            if (reg) payload.RegistroID = reg.RegistroID;
            else if (!isAdmin()) payload.GranjaID = state.granjaId;
            const aves = toNum(p.NumeroAves), muertas = toNum(p.MortalidadNominal);
            if (aves !== null && muertas !== null && muertas > aves) throw new Error('La mortalidad no puede ser mayor que el número de aves.');
            await save('saveRegistro', payload, reg ? 'Registro actualizado.' : 'Registro guardado.', { snapshot: false });
        },
    });
}

async function deleteRegistroFlow(reg) {
    await openModal({
        title: 'Eliminar registro', danger: true, submitLabel: 'Eliminar',
        body: `<p class="center">Registro del <strong>${esc(fmtDateTime(reg.Fecha))}</strong> · ${esc(granjaName(reg.GranjaID))} · ${esc(fmtNum(reg.NumeroAves))} aves.</p>
            <p class="muted center">Dejará de verse y de contarse en el dashboard. Queda guardado en el historial${isAdmin() ? ' y puedes restaurarlo' : ' y la administración puede restaurarlo'}.</p>
            ${justField()}`,
        onSubmit: async fd => save('deleteRegistro', { Linea: state.linea, RegistroID: reg.RegistroID, justificacion: fd.get('justificacion') }, 'Registro eliminado.', { snapshot: false }),
    });
}

async function restoreRegistroFlow(reg) {
    await openModal({
        title: 'Restaurar registro', submitLabel: 'Restaurar',
        body: `<p class="center">Registro del <strong>${esc(fmtDateTime(reg.Fecha))}</strong> · ${esc(granjaName(reg.GranjaID))}.</p>${justField()}`,
        onSubmit: async fd => save('restoreRegistro', { Linea: state.linea, RegistroID: reg.RegistroID, justificacion: fd.get('justificacion') }, 'Registro restaurado.', { snapshot: false }),
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
    const otra = LINEAS.find(l => l !== linea);
    const fuente = !p ? perfilDe(granjaId, otra) : null;
    const secciones = [];
    state.db.campos.perfil.forEach((c) => {
        let s = secciones.find(x => x.s === c.s);
        if (!s) { s = { s: c.s, campos: [] }; secciones.push(s); }
        s.campos.push(c);
    });
    // Valores sugeridos al crear: los datos de la granja (el resto se puede copiar de la otra línea).
    const inicial = p || { NombreGranja: g?.NombreGranja || '', Ubicacion: g?.Ubicacion || '' };
    const body = (fuente ? alertBox('info', 'copy', `Esta granja ya tiene ficha de ${otra.toLowerCase()}. <button type="button" class="btn btn-sm" data-action="copy-perfil" data-from="${esc(fuente.PerfilID)}">${ico('copy')}Copiar sus datos como sugerencia</button>`) : '')
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

    // Filtros
    'set-linea': (el) => { state.linea = el.dataset.linea; render(); },
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
    'delete-lista': async (el) => {
        try { await save('deleteLista', { ListaID: el.dataset.id }, 'Valor eliminado.'); } catch (e) { toast(e.message, 'error'); }
    },

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
    ensureLinea(ctxIds());
}

const INPUTS = {
    'table-q': (el) => { state.q[el.dataset.table] = el.value; refreshTable(el.dataset.table); },
};

const CHANGES = {
    'granja-activa': (el) => { state.granjaId = el.value; ensureLinea(ctxIds()); render(); },
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
        state.me = null;
        state.db = emptyDb();
        state.cache.clear();
        state.audit = null;
        state.registros = new Map();
        $('#login-form').reset();
        showScreen('login');
        return;
    }
    bootSession();
});
