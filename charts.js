/* ==========================================================================
   Granjas · Gráficos en canvas (sin librerías externas)
   - Líneas (con series punteadas para valores "tabla"/ideales) y barras
     agrupadas o apiladas.
   - Responsive (se redibuja al cambiar de tamaño) y nítido en pantallas HiDPI.
   - Tooltip al pasar el cursor o tocar (móvil).
   - Exportación a PNG con título, leyenda y fondo blanco.
   spec = { title, type: 'line'|'bar', labels: [], unit?, series: [{ name, data: [], color, dashed?, stack? }] }
   ========================================================================== */

export const PALETTE = {
    primary: '#0B3D91',
    secondary: '#3BA7F2',
    tertiary: '#2BB5A0',      // versión legible del terciario #7FE7D6 para líneas
    tertiaryLight: '#7FE7D6',
    amber: '#E0A030',
    slate: '#6B84A3',
    grid: 'rgba(11, 61, 145, 0.09)',
    axis: '#5B7290',
    text: '#0F2747',
};

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const nf = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('es-GT', { notation: 'compact', maximumFractionDigits: 1 });

export function fmt(v) {
    return v === null || v === undefined || !isFinite(v) ? '—' : nf.format(v);
}

function axisFmt(v) {
    return Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v);
}

/** Escalas "redondas" para el eje Y. */
function niceScale(min, max, ticks = 5) {
    if (min === max) { min = min === 0 ? 0 : min * 0.9; max = max === 0 ? 1 : max * 1.1; }
    const range = max - min;
    const rough = range / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
    return { lo, hi, ticks: out };
}

function valueRange(spec) {
    let min = Infinity, max = -Infinity;
    if (spec.type === 'bar') {
        const stacks = {};
        spec.series.forEach((s) => {
            s.data.forEach((v, i) => {
                if (v === null || v === undefined) return;
                if (s.stack) {
                    const k = s.stack + '|' + i;
                    stacks[k] = (stacks[k] || 0) + v;
                    max = Math.max(max, stacks[k]);
                } else max = Math.max(max, v);
                min = Math.min(min, v);
            });
        });
        min = Math.min(0, min);
    } else {
        spec.series.forEach(s => s.data.forEach((v) => {
            if (v === null || v === undefined) return;
            min = Math.min(min, v); max = Math.max(max, v);
        }));
        if (min > 0 && min < (max - min) * 0.6) min = 0;
    }
    if (!isFinite(min)) { min = 0; max = 1; }
    return niceScale(min, max);
}

/** Dibuja el gráfico completo en un contexto 2D de w×h (px CSS). */
function draw(ctx, w, h, spec, { hover = null, exporting = false } = {}) {
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (exporting) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }

    const n = spec.labels.length;
    const fs = exporting ? 15 : 12;
    let top = exporting ? 20 : 8;

    if (exporting && spec.title) {
        ctx.fillStyle = PALETTE.text;
        ctx.font = `800 ${fs + 7}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(spec.title, w / 2, top);
        top += fs + 18;
        if (spec.subtitle) {
            ctx.fillStyle = PALETTE.axis;
            ctx.font = `500 ${fs}px ${FONT}`;
            ctx.fillText(spec.subtitle, w / 2, top);
            top += fs + 10;
        }
    }

    // Leyenda centrada (con salto de línea si no cabe).
    ctx.font = `600 ${fs}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const items = spec.series.map(s => ({ s, w: 26 + ctx.measureText(s.name).width + 18 }));
    const rows = [[]];
    let rowW = 0;
    items.forEach((it) => {
        if (rowW + it.w > w - 24 && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
        rows[rows.length - 1].push(it); rowW += it.w;
    });
    const lh = fs + 10;
    rows.forEach((row, ri) => {
        const total = row.reduce((a, it) => a + it.w, 0) - 18;
        let x = (w - total) / 2;
        const y = top + ri * lh + lh / 2;
        row.forEach(({ s, w: iw }) => {
            ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 3;
            if (spec.type === 'bar' && !s.line) {
                roundRect(ctx, x, y - 6, 18, 12, 3); ctx.fill();
            } else {
                ctx.setLineDash(s.dashed ? [5, 4] : []);
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 18, y); ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.fillStyle = PALETTE.text;
            ctx.textAlign = 'left';
            ctx.fillText(s.name, x + 26, y);
            x += iw;
        });
    });
    top += rows.length * lh + 8;

    // Área del gráfico
    const { lo, hi, ticks } = valueRange(spec);
    ctx.font = `500 ${fs - 1}px ${FONT}`;
    const yLabelW = Math.max(...ticks.map(t => ctx.measureText(axisFmt(t)).width)) + 12;
    const L = Math.max(36, yLabelW), R = 14, B = fs + 22, T = top;
    const pw = Math.max(10, w - L - R), ph = Math.max(10, h - T - B);
    const y = v => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const band = pw / Math.max(n, 1);
    const xc = i => L + band * (i + 0.5);

    // Cuadrícula y eje Y
    ctx.strokeStyle = PALETTE.grid; ctx.lineWidth = 1;
    ctx.fillStyle = PALETTE.axis; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ticks.forEach((t) => {
        const yy = Math.round(y(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + pw, yy); ctx.stroke();
        ctx.fillText(axisFmt(t), L - 8, yy);
    });

    // Etiquetas del eje X (se saltan las que no caben)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const maxLabelW = Math.max(1, ...spec.labels.map(l => ctx.measureText(String(l)).width)) + 10;
    const step = Math.max(1, Math.ceil(maxLabelW / band));
    spec.labels.forEach((l, i) => {
        if (i % step !== 0 && i !== n - 1) return;
        if (i === n - 1 && i % step !== 0 && (n - 1) % step < step / 2) return;
        ctx.fillText(String(l), xc(i), T + ph + 8);
    });

    if (!n) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = PALETTE.axis; ctx.font = `600 ${fs + 1}px ${FONT}`;
        ctx.fillText('Sin datos en el rango seleccionado', L + pw / 2, T + ph / 2);
        ctx.restore();
        return { L, T, pw, ph, band, n };
    }

    if (hover !== null) {
        ctx.fillStyle = 'rgba(59, 167, 242, 0.10)';
        ctx.fillRect(L + band * hover, T, band, ph);
    }

    // Barras
    const bars = spec.series.filter(s => spec.type === 'bar' && !s.line);
    if (bars.length) {
        const groups = [];
        bars.forEach((s) => {
            const g = s.stack ? 'stack:' + s.stack : 'solo:' + s.name;
            if (!groups.includes(g)) groups.push(g);
        });
        const inner = band * 0.72;
        const gw = inner / groups.length;
        const base = {};
        bars.forEach((s) => {
            const gi = groups.indexOf(s.stack ? 'stack:' + s.stack : 'solo:' + s.name);
            ctx.fillStyle = s.color;
            s.data.forEach((v, i) => {
                if (v === null || v === undefined) return;
                const k = gi + '|' + i;
                const b0 = base[k] || 0;
                const x = xc(i) - inner / 2 + gi * gw + gw * 0.08;
                const y1 = y(b0 + v), y0 = y(b0);
                roundRect(ctx, x, Math.min(y0, y1), Math.max(1, gw * 0.84), Math.max(1, Math.abs(y0 - y1)), Math.min(4, gw / 4));
                ctx.fill();
                if (s.stack) base[k] = b0 + v;
            });
        });
    }

    // Líneas
    spec.series.filter(s => spec.type === 'line' || s.line).forEach((s) => {
        ctx.strokeStyle = s.color; ctx.lineWidth = exporting ? 3 : 2.5;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(s.dashed ? [6, 5] : []);
        ctx.beginPath();
        let open = false;
        s.data.forEach((v, i) => {
            if (v === null || v === undefined) { open = false; return; }
            if (!open) { ctx.moveTo(xc(i), y(v)); open = true; } else ctx.lineTo(xc(i), y(v));
        });
        ctx.stroke();
        ctx.setLineDash([]);
        if (n <= 60) {
            s.data.forEach((v, i) => {
                if (v === null || v === undefined) return;
                ctx.beginPath(); ctx.arc(xc(i), y(v), hover === i ? 5 : 3, 0, Math.PI * 2);
                ctx.fillStyle = s.dashed ? '#FFFFFF' : s.color; ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = s.color; ctx.stroke();
            });
        }
    });

    if (hover !== null) drawTooltip(ctx, spec, hover, xc(hover), T, w, fs);
    ctx.restore();
    return { L, T, pw, ph, band, n };
}

function drawTooltip(ctx, spec, i, x, T, w, fs) {
    const lines = spec.series.map(s => ({ s, text: `${s.name}: ${fmt(s.data[i])}${s.data[i] !== null && s.data[i] !== undefined && spec.unit ? ' ' + spec.unit : ''}` }));
    ctx.font = `700 ${fs}px ${FONT}`;
    const title = String(spec.labels[i]);
    let bw = ctx.measureText(title).width;
    ctx.font = `500 ${fs}px ${FONT}`;
    lines.forEach(l => { bw = Math.max(bw, ctx.measureText(l.text).width + 16); });
    bw += 20;
    const lh = fs + 7;
    const bh = 14 + lh * (lines.length + 1);
    let bx = x + 14;
    if (bx + bw > w - 4) bx = x - 14 - bw;
    bx = Math.max(4, bx);
    const by = T + 4;
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.shadowColor = 'rgba(11, 61, 145, 0.22)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = PALETTE.text; ctx.font = `700 ${fs}px ${FONT}`;
    ctx.fillText(title, bx + 10, by + 7 + lh / 2);
    ctx.font = `500 ${fs}px ${FONT}`;
    lines.forEach((l, k) => {
        const yy = by + 7 + lh * (k + 1) + lh / 2;
        ctx.fillStyle = l.s.color;
        ctx.beginPath(); ctx.arc(bx + 14, yy, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = PALETTE.text;
        ctx.fillText(l.text, bx + 24, yy);
    });
}

function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Monta un gráfico interactivo en un <canvas>. Devuelve una función para desmontarlo. */
export function mountChart(canvas, spec) {
    let hover = null;
    let layout = null;
    const box = canvas.parentElement;

    function paint() {
        const dpr = window.devicePixelRatio || 1;
        const w = box.clientWidth;
        const h = canvas.clientHeight || 280;
        if (!w) return;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        layout = draw(ctx, w, h, spec, { hover });
    }

    function pick(ev) {
        if (!layout || !layout.n) return;
        const r = canvas.getBoundingClientRect();
        const x = ev.clientX - r.left;
        const i = Math.floor((x - layout.L) / layout.band);
        const next = i >= 0 && i < layout.n ? i : null;
        if (next !== hover) { hover = next; paint(); }
    }
    const leave = () => { if (hover !== null) { hover = null; paint(); } };
    canvas.addEventListener('pointermove', pick);
    canvas.addEventListener('pointerdown', pick);
    canvas.addEventListener('pointerleave', leave);

    const ro = new ResizeObserver(() => paint());
    ro.observe(box);
    paint();
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.title || 'Gráfico');
    return () => { ro.disconnect(); };
}

// ----------------------------------------------------------------------------
// Mapa de calor (filas × columnas). spec = { type:'heatmap', title, subtitle?, rows:[nombres],
//   cols:[etiquetas], values:[[número|null]], color(v) → color, legend:[{color, label}],
//   tip(r, c) → [líneas de texto] }
// ----------------------------------------------------------------------------

const HM = { rowH: 30, minCell: 10 };

function heatmapLayout(ctx, w, spec, exporting) {
    const fs = exporting ? 15 : 12;
    let top = exporting ? 20 : 8;
    if (exporting && spec.title) top += fs + 18 + (spec.subtitle ? fs + 10 : 0);
    // Leyenda (puede ocupar varias filas)
    ctx.font = `600 ${fs}px ${FONT}`;
    const items = spec.legend.map(it => ({ it, w: 22 + ctx.measureText(it.label).width + 18 }));
    const rows = [[]];
    let rw = 0;
    items.forEach((x) => {
        if (rw + x.w > w - 24 && rows[rows.length - 1].length) { rows.push([]); rw = 0; }
        rows[rows.length - 1].push(x); rw += x.w;
    });
    const legendTop = top;
    const lh = fs + 10;
    top += rows.length * lh + 8;
    ctx.font = `600 ${fs - 1}px ${FONT}`;
    const L = Math.min(w * 0.38, Math.max(60, ...spec.rows.map(r => ctx.measureText(String(r)).width)) + 16);
    const R = 12;
    const pw = Math.max(10, w - L - R);
    const cw = pw / Math.max(spec.cols.length, 1);
    const rowH = HM.rowH;
    const B = fs + 22;
    const height = top + Math.max(spec.rows.length, 1) * rowH + B;
    return { fs, legendTop, legendRows: rows, lh, top, L, pw, cw, rowH, height };
}

/** Alto en px CSS que necesita el mapa de calor para un ancho dado. */
export function heatmapHeight(spec, w, exporting = false) {
    const c = document.createElement('canvas').getContext('2d');
    return heatmapLayout(c, w, spec, exporting).height;
}

function drawHeatmap(ctx, w, h, spec, { hover = null, exporting = false } = {}) {
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (exporting) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }
    const lay = heatmapLayout(ctx, w, spec, exporting);
    const { fs, L, pw, cw, rowH, top } = lay;

    if (exporting && spec.title) {
        ctx.fillStyle = PALETTE.text; ctx.font = `800 ${fs + 7}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(spec.title, w / 2, 20);
        if (spec.subtitle) { ctx.fillStyle = PALETTE.axis; ctx.font = `500 ${fs}px ${FONT}`; ctx.fillText(spec.subtitle, w / 2, 20 + fs + 18); }
    }
    // Leyenda centrada
    ctx.font = `600 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
    lay.legendRows.forEach((row, ri) => {
        const total = row.reduce((a, x) => a + x.w, 0) - 18;
        let x = (w - total) / 2;
        const y = lay.legendTop + ri * lay.lh + lay.lh / 2;
        row.forEach(({ it, w: iw }) => {
            ctx.fillStyle = it.color; roundRect(ctx, x, y - 7, 14, 14, 3); ctx.fill();
            ctx.fillStyle = PALETTE.text; ctx.textAlign = 'left'; ctx.fillText(it.label, x + 22, y);
            x += iw;
        });
    });

    if (!spec.rows.length || !spec.cols.length) {
        ctx.textAlign = 'center'; ctx.fillStyle = PALETTE.axis; ctx.font = `600 ${fs + 1}px ${FONT}`;
        ctx.fillText('Sin lecturas en el rango seleccionado', w / 2, top + rowH);
        ctx.restore();
        return lay;
    }

    // Etiquetas de filas
    ctx.font = `600 ${fs - 1}px ${FONT}`; ctx.textAlign = 'right'; ctx.fillStyle = PALETTE.text;
    spec.rows.forEach((r, i) => ctx.fillText(String(r), L - 10, top + i * rowH + rowH / 2));

    // Celdas
    const gap = cw > 6 ? 2 : 0.5;
    spec.values.forEach((fila, i) => fila.forEach((v, j) => {
        ctx.fillStyle = v === null || v === undefined ? 'rgba(107, 132, 163, 0.12)' : spec.color(v);
        roundRect(ctx, L + j * cw + gap / 2, top + i * rowH + 2, Math.max(1, cw - gap), rowH - 4, Math.min(5, cw / 3));
        ctx.fill();
    }));
    if (hover) {
        ctx.strokeStyle = PALETTE.text; ctx.lineWidth = 2;
        roundRect(ctx, L + hover.c * cw + 1, top + hover.r * rowH + 1, Math.max(2, cw - 2), rowH - 2, 4);
        ctx.stroke();
    }

    // Etiquetas de columnas (se saltan las que no caben)
    ctx.fillStyle = PALETTE.axis; ctx.font = `500 ${fs - 1}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const maxW = Math.max(1, ...spec.cols.map(c => ctx.measureText(String(c)).width)) + 10;
    const step = Math.max(1, Math.ceil(maxW / cw));
    const yLab = top + spec.rows.length * rowH + 8;
    spec.cols.forEach((c, j) => { if (j % step === 0) ctx.fillText(String(c), L + j * cw + cw / 2, yLab); });

    if (hover && spec.tip) {
        const lines = spec.tip(hover.r, hover.c);
        ctx.font = `600 ${fs}px ${FONT}`;
        const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 24;
        const bh = 12 + lines.length * (fs + 7);
        let bx = L + hover.c * cw + cw + 10;
        if (bx + bw > w - 4) bx = L + hover.c * cw - bw - 10;
        bx = Math.max(4, bx);
        let by = top + hover.r * rowH - bh / 2 + rowH / 2;
        by = Math.max(4, Math.min(by, h - bh - 4));
        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        ctx.shadowColor = 'rgba(11, 61, 145, 0.22)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
        roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = PALETTE.text;
        lines.forEach((l, k) => { ctx.font = `${k === 0 ? 700 : 500} ${fs}px ${FONT}`; ctx.fillText(l, bx + 12, by + 6 + k * (fs + 7) + (fs + 7) / 2); });
    }
    ctx.restore();
    return lay;
}

/** Monta un mapa de calor interactivo. El alto del canvas se ajusta al número de filas. */
export function mountHeatmap(canvas, spec) {
    let hover = null;
    let lay = null;
    const box = canvas.parentElement;
    function paint() {
        const dpr = window.devicePixelRatio || 1;
        const w = box.clientWidth;
        if (!w) return;
        const h = heatmapHeight(spec, w);
        canvas.style.height = h + 'px';
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lay = drawHeatmap(ctx, w, h, spec, { hover });
    }
    function pick(ev) {
        if (!lay) return;
        const r = canvas.getBoundingClientRect();
        const c = Math.floor((ev.clientX - r.left - lay.L) / lay.cw);
        const f = Math.floor((ev.clientY - r.top - lay.top) / lay.rowH);
        const next = c >= 0 && c < spec.cols.length && f >= 0 && f < spec.rows.length ? { r: f, c } : null;
        if (JSON.stringify(next) !== JSON.stringify(hover)) { hover = next; paint(); }
    }
    const leave = () => { if (hover) { hover = null; paint(); } };
    canvas.addEventListener('pointermove', pick);
    canvas.addEventListener('pointerdown', pick);
    canvas.addEventListener('pointerleave', leave);
    const ro = new ResizeObserver(() => paint());
    ro.observe(box);
    paint();
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', spec.title || 'Mapa de calor');
    return () => ro.disconnect();
}

/** Descarga el gráfico como PNG (1400×720, alta resolución, fondo blanco). */
export function exportChartPng(spec, filename) {
    const w = 1400, scale = 2;
    const h = spec.type === 'heatmap' ? heatmapHeight(spec, w, true) : 720;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    if (spec.type === 'heatmap') drawHeatmap(ctx, w, h, spec, { exporting: true });
    else draw(ctx, w, h, spec, { exporting: true });
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, filename);
            resolve(!!blob);
        }, 'image/png');
    });
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
