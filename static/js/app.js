/* =====================================================================
   app.js — capa de presentación del Portal B2B.
   Todos los cálculos (cobertura, sumas, días de inventario por fila) vienen
   del servidor (db.py). Aquí solo se piden datos, se arma HTML y se dibuja.
   ===================================================================== */

// ---------------------------------------------------------------------
//  Formatos y utilidades
// ---------------------------------------------------------------------
const nf0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmt = n => nf0.format(Math.round(n || 0));
const fmt1 = n => nf1.format(n || 0);
const money = n => 'S/ ' + fmt(n);
// Con céntimos: en segmentos, S/ 119.68 es B y no debe verse como "S/ 120".
const nf2 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const money2 = n => 'S/ ' + nf2.format(n || 0);
function compact(n, pre = '') {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return pre + nf1.format(n / 1e6) + ' M';
  if (a >= 1e4) return pre + nf1.format(n / 1e3) + ' K';
  return pre + fmt(n);
}
const moneyC = n => compact(n, 'S/ ');
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
const icon = (name, extra = '') => `<i data-lucide="${name}" ${extra}></i>`;
const icons = () => window.lucide && lucide.createIcons();
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_SEM = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const mesLabel = k => { const [y, m] = k.split('-'); return `${MESES[+m - 1]} ${y.slice(2)}`; };
const fechaCorta = iso => { const [, m, d] = iso.split('-'); return `${+d} ${MESES[+m - 1]}`; };
const ISO = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ISO(d); };
const finDeMes = ym => ISO(new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)));
const sumarMeses = (ym, n) => ISO(new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1))).slice(0, 7);
const mesLargo = ym => `${MESES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
// "nov 2025" si el período son meses completos; si no, "1 nov – 17 nov 2025".
function etiquetaPeriodo(ini, fin) {
  if (ini.slice(8) === '01' && fin === finDeMes(fin.slice(0, 7))) {
    return ini.slice(0, 7) === fin.slice(0, 7) ? mesLargo(ini) : `${mesLargo(ini)} – ${mesLargo(fin)}`;
  }
  return `${fechaCorta(ini)} – ${fechaCorta(fin)} ${fin.slice(0, 4)}`;
}

const PAL = ['#e30613', '#2563eb', '#12a37a', '#f59e0b', '#7c5cff', '#0891b2', '#ec4899', '#84cc16', '#64748b', '#0f172a'];

// ---------------------------------------------------------------------
//  Carga (barra superior + skeletons)
// ---------------------------------------------------------------------
let PENDIENTES = 0;
function cargando(delta) {
  PENDIENTES = Math.max(0, PENDIENTES + delta);
  const b = document.getElementById('topload');
  if (!b) return;
  if (PENDIENTES > 0) { b.className = 'topload'; void b.offsetWidth; b.className = 'topload on'; }
  else { b.className = 'topload done'; }
}

async function api(path) {
  cargando(1);
  try {
    const r = await fetch(path);
    if (r.status === 401) { location.href = '/login'; throw new Error('Sesión no autenticada'); }
    if (!r.ok) throw new Error(`Error HTTP ${r.status} en ${path}`);
    return await r.json();
  } finally {
    cargando(-1);
  }
}

const skKpis = n => `<div class="grid g-kpi">${'<div class="sk sk-kpi"></div>'.repeat(n)}</div>`;
const skCharts = (cls = 'g-21', n = 2) => `<div class="grid ${cls}">${'<div class="sk sk-chart"></div>'.repeat(n)}</div>`;

// ---------------------------------------------------------------------
//  Componentes
// ---------------------------------------------------------------------
function card(titulo, cuerpo, { ic, sub, tono = 't-slate', extra = '' } = {}) {
  return `<div class="card"><div class="card-h">${ic ? `<div class="ic ${tono}">${icon(ic)}</div>` : ''}
    <div><h3>${titulo}</h3>${sub ? `<small>${sub}</small>` : ''}</div><div class="grow"></div>${extra}</div>${cuerpo}</div>`;
}
const chWrap = (id, cls = '') => `<div class="ch ${cls}"><canvas id="${id}"></canvas></div>`;

function deltaHtml(d) {
  if (d == null || !isFinite(d)) return '';
  const up = d >= 0;
  return `<span class="delta ${up ? 'up' : 'down'}">${icon(up ? 'arrow-up-right' : 'arrow-down-right')}${fmt1(Math.abs(d))}%</span>`;
}
function kpi(lbl, val, foot, { ic = 'activity', tono = 't-slate', delta = null, hero = false } = {}) {
  return `<div class="card kpi ${hero ? 'hero' : ''}">
    <div class="kpi-top"><span class="lbl">${lbl}</span><span class="kpi-ic ${tono}">${icon(ic)}</span></div>
    <div class="val">${val}</div>
    <div class="foot">${deltaHtml(delta)}<span>${foot}</span></div></div>`;
}

function table(cols, rows) {
  if (!rows.length) return vacio('Sin datos para los filtros elegidos', 'search-x');
  const head = cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.h}</th>`).join('');
  const body = rows.map(r => '<tr>' + r.map((v, i) => `<td class="${cols[i].n ? 'n' : ''}">${cols[i].f ? cols[i].f(v) : esc(v)}</td>`).join('') + '</tr>').join('');
  return `<div class="ov"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const barra = p => `<div class="bar"><i style="width:${Math.max(2, Math.min(100, p))}%"></i></div>`;

// Stock como lo lee el equipo comercial: "124 cj + 6 und" (en el Excel Stock-DI, 124.006).
// Solo se puede cuando la fila es de un único producto (un solo factor); si mezcla
// productos con distinto factor, se muestran cajas. El total decimal va en el tooltip.
function stockCaja(v) {
  const { c, u, f } = v || {};
  if (!f || f <= 0 || u == null) return fmt(c);
  const cajas = Math.floor(Math.round(u) / f), sueltas = Math.round(u) - cajas * f;
  return `<span title="${fmt1(c)} cajas · ${fmt(u)} unidades">${fmt(cajas)} cj${sueltas ? ` + ${fmt(sueltas)} und` : ''}</span>`;
}
const vacio = (t, ic = 'inbox', sub = '') => `<div class="empty">${icon(ic)}<h3>${t}</h3>${sub ? `<div>${sub}</div>` : ''}</div>`;
const nota = (txt, ic = 'info', cls = '') => `<div class="note ${cls}">${icon(ic)}<div>${txt}</div></div>`;

// ---------------------------------------------------------------------
//  Gráficos (Chart.js)
// ---------------------------------------------------------------------
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = '#64748b';
Chart.defaults.borderColor = '#eef1f6';
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.tooltip.backgroundColor = '#0f172a';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };

const CHARTS = {};
function chart(id, cfg) {
  if (CHARTS[id]) CHARTS[id].destroy();
  const el = document.getElementById(id); if (!el) return;
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }, cfg.options || {});
  const c = new Chart(el, cfg);
  c._centerText = cfg._centerText; c._centerSub = cfg._centerSub;
  CHARTS[id] = c;
}
Chart.register({
  id: 'centerText',
  afterDraw(c) {
    if (!c._centerText) return;
    const { ctx, chartArea: { width, height, top, left } } = c;
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 16px Inter'; ctx.fillStyle = '#0f172a';
    ctx.fillText(c._centerText, left + width / 2, top + height / 2 - 8);
    ctx.font = '500 10px Inter'; ctx.fillStyle = '#64748b';
    ctx.fillText(c._centerSub || '', left + width / 2, top + height / 2 + 11);
    ctx.restore();
  }
});
const tickMoney = { callback: v => compact(v) };
const gradiente = color => ctx => {
  const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
  g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00'); return g;
};
function barrasH(id, etiquetas, valores, { color = PAL[0], fmtV = money, colores } = {}) {
  chart(id, {
    type: 'bar',
    data: { labels: etiquetas, datasets: [{ data: valores, backgroundColor: colores || color, borderRadius: 6, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtV(c.raw) } } }, scales: { x: { ticks: { callback: v => compact(v) }, grid: { color: '#f1f3f8' } }, y: { grid: { display: false }, ticks: { autoSkip: false } } } }
  });
}
function dona(id, etiquetas, valores, centro, sub, fmtV = money) {
  chart(id, {
    type: 'doughnut',
    data: { labels: etiquetas, datasets: [{ data: valores, backgroundColor: PAL, borderWidth: 0, borderRadius: 5, spacing: 2 }] },
    options: { cutout: '70%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => ` ${c.label}: ${fmtV(c.raw)} (${fmt1(pct(c.raw, c.dataset.data.reduce((a, b) => a + b, 0)))}%)` } } } },
    _centerText: centro, _centerSub: sub
  });
}
// Agrupa en "Otros" lo que pasa del top N (para donas legibles).
function topMasOtros(filas, n = 6, campo = 'venta') {
  const ord = [...filas].sort((a, b) => b[campo] - a[campo]);
  const top = ord.slice(0, n);
  const resto = ord.slice(n).reduce((a, b) => a + b[campo], 0);
  if (resto > 0) top.push({ clave: 'Otros', [campo]: resto });
  return top;
}

// ---------------------------------------------------------------------
//  Estado
// ---------------------------------------------------------------------
const TABS = [
  { id: 'resumen', label: 'Resumen', ic: 'layout-dashboard', sub: 'Indicadores principales del período' },
  { id: 'ventas', label: 'Análisis de ventas', ic: 'chart-column-big', sub: 'Explora la venta por cualquier dimensión' },
  { id: 'inventario', label: 'Inventario', ic: 'warehouse', sub: 'Stock actual y días de inventario' },
  { id: 'segmentos', label: 'Segmentos de clientes', ic: 'medal', sub: 'Clientes A–E según su compra mensual', nuevo: true },
  { id: 'paquete', label: 'Descargas', ic: 'download', sub: 'Reportes de ventas y stock listos para Excel' },
];

// Filtros de la barra superior (mismos nombres que db.FILTROS_VENTAS).
const FILTROS = [
  { k: 'sede', l: 'Sede', ic: 'building-2', stock: true, falta: 'Llega cuando el CSV de ventas traiga la columna Sucursal.' },
  { k: 'distrito', l: 'Distrito', ic: 'map-pin', falta: 'Llega cuando el CSV de ventas traiga la columna Distrito.' },
  { k: 'canal', l: 'Canal', ic: 'store' },
  { k: 'tipo_negocio', l: 'Tipo de negocio', ic: 'shopping-basket' },
  { k: 'jefe_ventas', l: 'Jefe de ventas', ic: 'user-cog' },
  { k: 'supervisor', l: 'Supervisor', ic: 'users' },
  { k: 'marca', l: 'Marca', ic: 'award', stock: true },
  { k: 'categoria', l: 'Categoría', ic: 'tags', stock: true, falta: 'Completa la categoría en la tabla productos de Supabase.' },
  { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash', stock: true, falta: 'Completa el código proveedor en la tabla productos de Supabase.' },
  { k: 'codigo_producto', l: 'Producto', ic: 'package', stock: true },
];
const FILTRO_DEF = Object.fromEntries(FILTROS.map(f => [f.k, f]));
const SIN_DATO = /^SIN /;

let TAB = 'resumen';
let RANGO = { min: null, max: null };
// El período se elige por meses (pedido PEUSAC, nov 2026); FECHAS guarda el
// primer y último día con datos de esos meses, que es lo que recibe la API.
let FECHAS = { ini: null, fin: null, desde: null, hasta: null, preset: 'mes' };
let SEL = {};              // { campo: [valores] }
let OPC = {};              // opciones de cada filtro (desde /api/filtros)
let ABIERTO = null;        // filtro desplegado
let BORRADOR = new Set();  // selección en edición dentro del desplegable

function qs(extra = {}, { fechas = true, soloStock = false } = {}) {
  const p = new URLSearchParams();
  if (fechas && FECHAS.ini) p.set('desde', FECHAS.ini);
  if (fechas && FECHAS.fin) p.set('hasta', FECHAS.fin);
  Object.entries(SEL).forEach(([k, vals]) => {
    if (soloStock && !FILTRO_DEF[k].stock) return;
    vals.forEach(v => p.append(k, v));
  });
  Object.entries(extra).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') p.set(k, v); });
  const q = p.toString();
  return q ? '?' + q : '';
}
const hayFiltros = () => Object.values(SEL).some(v => v.length);

// ---------------------------------------------------------------------
//  Barra de filtros
// ---------------------------------------------------------------------
const PRESETS = [
  { k: 'mes', l: 'Este mes' }, { k: 'mesant', l: 'Mes anterior' },
  { k: '3m', l: 'Últimos 3 meses' }, { k: 'anio', l: 'Año en curso' },
];
function mesesDisponibles() {
  const lista = [];
  for (let ym = RANGO.min.slice(0, 7); ym <= RANGO.max.slice(0, 7); ym = sumarMeses(ym, 1)) lista.push(ym);
  return lista.reverse();
}
function aplicarMeses(desde, hasta, preset = null) {
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  const ini = `${desde}-01`, fin = finDeMes(hasta);
  FECHAS = { desde, hasta, preset, ini: ini < RANGO.min ? RANGO.min : ini, fin: fin > RANGO.max ? RANGO.max : fin };
  render();
}
function aplicarPreset(k) {
  const ult = RANGO.max.slice(0, 7);
  if (k === 'mes') aplicarMeses(ult, ult, k);
  if (k === 'mesant') aplicarMeses(sumarMeses(ult, -1), sumarMeses(ult, -1), k);
  if (k === '3m') aplicarMeses(sumarMeses(ult, -2), ult, k);
  if (k === 'anio') aplicarMeses(`${ult.slice(0, 4)}-01`, ult, k);
}
function cambiarMes(campo, ym) {
  if (!ym) return;
  const sel = { desde: FECHAS.desde, hasta: FECHAS.hasta, [campo]: ym };
  aplicarMeses(sel.desde, sel.hasta);
}

function opcionesDe(k) {
  if (k === 'codigo_producto') return (OPC.codigo_producto || []).map(o => ({ v: o.valor, t: o.etiqueta || o.valor, s: o.valor }));
  return (OPC[k] || []).map(v => ({ v, t: v }));
}

function renderFiltros() {
  const tabStock = TAB === 'inventario';
  const usaFechas = !tabStock;
  const apagado = 'opacity:.45;pointer-events:none';
  const el = document.getElementById('filterbar');
  const drops = FILTROS.map(f => {
    const n = (SEL[f.k] || []).length;
    const inactivo = tabStock && !f.stock;
    return `<div class="fdrop ${n ? 'act' : ''}" style="${inactivo ? 'opacity:.45' : ''}" title="${inactivo ? 'Este filtro no aplica al inventario' : ''}">
      <button onclick="abrirFiltro('${f.k}')">${icon(f.ic)}${f.l}${n ? `<span class="badge">${n}</span>` : icon('chevron-down')}</button>
      ${ABIERTO === f.k ? popFiltro(f) : ''}</div>`;
  }).join('');

  const chips = [];
  Object.entries(SEL).forEach(([k, vals]) => vals.forEach(v => {
    const etiqueta = k === 'codigo_producto' ? (opcionesDe(k).find(o => o.v === v)?.t || v) : v;
    chips.push(`<span class="chip"><b>${FILTRO_DEF[k].l}:</b>${esc(etiqueta)}<button onclick="quitarFiltro('${k}', ${esc(JSON.stringify(v))})" aria-label="Quitar">${icon('x')}</button></span>`);
  }));

  el.innerHTML = `
    <div class="fb-row">
      <div class="fb-dates" style="${usaFechas ? '' : apagado}" title="${usaFechas ? '' : 'El inventario es una foto actual: no depende de fechas'}">
        ${icon('calendar-days')}
        <select onchange="cambiarMes('desde', this.value)" aria-label="Mes inicial">${opcionesMes(FECHAS.desde)}</select>
        <span>→</span>
        <select onchange="cambiarMes('hasta', this.value)" aria-label="Mes final">${opcionesMes(FECHAS.hasta)}</select>
      </div>
      <div class="presets" style="${usaFechas ? '' : apagado}">${PRESETS.map(p => `<button class="${FECHAS.preset === p.k ? 'on' : ''}" onclick="aplicarPreset('${p.k}')">${p.l}</button>`).join('')}</div>
      <div class="fb-sep"></div>
      ${drops}
    </div>
    ${chips.length ? `<div class="chips">${chips.join('')}<button class="link" onclick="limpiarFiltros()">Limpiar todo</button></div>` : ''}`;
  icons();
  const buscador = el.querySelector('.fpop-search input');
  if (buscador) buscador.focus();
}

const opcionesMes = actual => mesesDisponibles().map(ym => `<option value="${ym}" ${ym === actual ? 'selected' : ''}>${mesLargo(ym)}</option>`).join('');

function popFiltro(f) {
  const ops = opcionesDe(f.k);
  const reales = ops.filter(o => !SIN_DATO.test(o.v));
  const lista = items => `<div class="fpop-list">${items.map(o => `<label class="fopt" data-t="${esc((o.t + ' ' + (o.s || '')).toLowerCase())}">
      <input type="checkbox" ${BORRADOR.has(o.v) ? 'checked' : ''} onchange="marcar(${esc(JSON.stringify(o.v))}, this.checked)">
      <span>${esc(o.t)}</span>${o.s && o.s !== o.t ? `<small>${esc(o.s)}</small>` : ''}</label>`).join('')}</div>`;
  let cuerpo = lista(ops);
  if (!ops.length || (!reales.length && f.falta)) {
    cuerpo = `<div class="fpop-empty">${icon('database-zap')}<b>Aún no hay datos de ${f.l.toLowerCase()}</b><br>${f.falta || ''}</div>` + (ops.length ? lista(ops) : '');
  }
  return `<div class="fpop" onclick="event.stopPropagation()">
    ${ops.length > 6 ? `<div class="fpop-search">${icon('search')}<input placeholder="Buscar ${f.l.toLowerCase()}…" oninput="buscarOpcion(this.value)"></div>` : ''}
    ${cuerpo}
    <div class="fpop-foot"><button class="btn btn-ghost btn-sm" onclick="BORRADOR.clear();aplicarFiltro()">Limpiar</button>
      <button class="btn btn-ac btn-sm" onclick="aplicarFiltro()">${icon('check')}Aplicar</button></div></div>`;
}

function abrirFiltro(k) {
  if (ABIERTO === k) { aplicarFiltro(); return; }
  if (ABIERTO) aplicarFiltro(false);
  ABIERTO = k; BORRADOR = new Set(SEL[k] || []);
  renderFiltros();
}
function marcar(v, on) { on ? BORRADOR.add(v) : BORRADOR.delete(v); }
function buscarOpcion(txt) {
  const t = txt.trim().toLowerCase();
  document.querySelectorAll('.fpop .fopt').forEach(o => { o.style.display = o.dataset.t.includes(t) ? '' : 'none'; });
}
function aplicarFiltro(rerender = true) {
  if (!ABIERTO) return;
  const antes = JSON.stringify(SEL[ABIERTO] || []);
  const nuevo = [...BORRADOR].sort();
  if (nuevo.length) SEL[ABIERTO] = nuevo; else delete SEL[ABIERTO];
  ABIERTO = null;
  if (!rerender) return;
  if (JSON.stringify(nuevo) !== antes) render(); else renderFiltros();
}
function quitarFiltro(k, v) {
  SEL[k] = (SEL[k] || []).filter(x => x !== v);
  if (!SEL[k].length) delete SEL[k];
  render();
}
function limpiarFiltros() { SEL = {}; render(); }
document.addEventListener('click', e => { if (ABIERTO && !e.target.closest('.fdrop')) aplicarFiltro(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ABIERTO) { ABIERTO = null; renderFiltros(); } });

// ---------------------------------------------------------------------
//  Arranque y navegación
// ---------------------------------------------------------------------
// FechaProceso viene del ERP en hora de Lima (UTC-5) y sin zona horaria.
const fechaLima = iso => new Date(iso.replace(' ', 'T').slice(0, 19) + '-05:00');

function tiempoDesde(iso) {
  if (!iso) return 'sin datos aún';
  const mins = Math.max(0, Math.round((Date.now() - fechaLima(iso)) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 60 * 24) return `hace ${Math.round(mins / 60)} h`;
  return `hace ${Math.round(mins / 60 / 24)} días`;
}
function estadoFrescura(iso) {
  if (!iso) return 'gris';
  const horas = (Date.now() - fechaLima(iso)) / 3600000;
  return horas < 26 ? 'ok' : horas < 72 ? 'warn' : 'bad';
}

function toggleNav(abrir) { document.getElementById('app').classList.toggle('nav-open', abrir); }

async function boot() {
  const bootEl = document.getElementById('boot');
  try {
    // Las opciones de los filtros no bloquean el arranque: llegan por detrás.
    api('/api/filtros').then(opc => { OPC = opc; if (RANGO.min) renderFiltros(); }).catch(() => {});
    const r = await api('/api/rango');
    RANGO = { min: r.desde, max: r.hasta };
    document.getElementById('syncPill').innerHTML = `<span class="dot ${estadoFrescura(r.ultima_sincronizacion)}"></span>Actualizado ${tiempoDesde(r.ultima_sincronizacion)}`;
    document.getElementById('rangePill').innerHTML = RANGO.min ? `${icon('database')}Datos del ${fechaCorta(RANGO.min)} al ${fechaCorta(RANGO.max)} ${RANGO.max.slice(0, 4)}` : `${icon('database')}Sin datos`;
    document.getElementById('navLinks').innerHTML = TABS.map(t =>
      `<a class="navlink" data-id="${t.id}" onclick="goTo('${t.id}')">${icon(t.ic)}${t.label}${t.nuevo ? '<span class="new">NUEVO</span>' : ''}</a>`).join('');

    if (!RANGO.min) {
      document.getElementById('view').innerHTML = card('Aún no hay ventas cargadas', vacio('Sin datos', 'database', 'Verifica que la sincronización haya cargado los datos en Supabase.'));
      icons(); return;
    }
    aplicarPreset('mes');
  } catch (e) {
    console.error(e);
    document.getElementById('view').innerHTML = card('No se pudo iniciar el portal', `${vacio('Error de conexión', 'wifi-off', 'Verifica tu conexión y vuelve a intentarlo.')}<p style="text-align:center"><button class="btn btn-ac" onclick="location.reload()">${icon('rotate-ccw')}Reintentar</button></p>`);
    icons();
  } finally {
    bootEl.classList.add('out');
    setTimeout(() => bootEl.remove(), 400);
  }
}

function goTo(id) { TAB = id; toggleNav(false); window.scrollTo({ top: 0 }); render(); }

// Cada render tiene un número: si el usuario cambia de filtro antes de que
// lleguen los datos, la respuesta vieja se descarta en vez de pintarse.
let RENDER_ID = 0;
async function render() {
  const id = ++RENDER_ID;
  const tab = TABS.find(t => t.id === TAB);
  document.querySelectorAll('.navlink[data-id]').forEach(e => e.classList.toggle('on', e.dataset.id === TAB));
  document.getElementById('pageTitle').textContent = tab.label;
  document.getElementById('crumb').textContent = tab.sub;
  renderFiltros();
  const vistas = { resumen: vistaResumen, ventas: vistaVentas, inventario: vistaInventario, segmentos: vistaSegmentos, paquete: vistaPaquete };
  try {
    await vistas[TAB](() => id === RENDER_ID);
  } catch (e) {
    console.error('Error al cargar', TAB, e);
    if (id !== RENDER_ID) return;
    document.getElementById('view').innerHTML = card('No se pudo cargar la información', `${vacio('Ocurrió un problema al consultar los datos', 'cloud-off')}<p style="text-align:center"><button class="btn btn-ac" onclick="render()">${icon('rotate-ccw')}Reintentar</button></p>`);
  }
  icons();
}
const pintar = (vigente, html) => { if (!vigente()) return false; document.getElementById('view').innerHTML = html; icons(); return true; };

// Período de comparación (mismo criterio que hallazgos.periodo_anterior): las
// mismas fechas del año anterior. Nov 2026 vs nov 2025; con el mes en curso,
// los mismos días (1–17 nov 2026 vs 1–17 nov 2025).
function menosUnAnio(iso) {
  const y = +iso.slice(0, 4) - 1, md = iso.slice(5);
  return md === '02-29' ? `${y}-02-28` : `${y}-${md}`;
}
const rangoAnterior = (ini, fin) => ({ ini: menosUnAnio(ini), fin: menosUnAnio(fin) });
// Une las filas del año anterior a las del período por la misma clave.
function conAnterior(filas, filasAnt) {
  const ant = new Map((filasAnt || []).map(f => [f.clave, f]));
  return filas.map(f => ({ ...f, venta_ant: ant.get(f.clave)?.venta || 0, cobertura_ant: ant.get(f.clave)?.cobertura || 0 }));
}
const delta = (a, b) => (b ? ((a - b) / b) * 100 : null);
const variacionCelda = d => d == null ? '—' : deltaHtml(d);

function avisoDatosNuevos() {
  if (!Object.keys(OPC).length) return '';
  const faltan = [];
  if (!(OPC.sede || []).some(v => !SIN_DATO.test(v))) faltan.push('<b>sede</b>');
  if (!(OPC.distrito || []).some(v => !SIN_DATO.test(v))) faltan.push('<b>distrito</b>');
  if (!(OPC.categoria || []).some(v => !SIN_DATO.test(v))) faltan.push('<b>categoría</b>');
  if (!(OPC.codigo_proveedor || []).some(v => !SIN_DATO.test(v))) faltan.push('<b>código proveedor</b>');
  if (!faltan.length) return '';
  return nota(`Los análisis por ${faltan.join(', ')} ya están listos y se llenarán automáticamente con la próxima carga de datos. Mientras tanto aparecen como “SIN …”.`, 'sparkles');
}

// =======================================================================
//  HALLAZGOS — resumen inteligente (reglas en hallazgos.py, sin IA)
// =======================================================================
const HZ_TIPO = {
  quiebre: { tono: 't-red', tag: 'Quiebre' },
  alerta: { tono: 't-red', tag: 'Alerta' },
  revisar: { tono: 't-amber', tag: 'Revisar' },
  positivo: { tono: 't-green', tag: 'Positivo' },
  info: { tono: 't-blue', tag: 'Dato' },
};
let HZ_ACCIONES = [];

function irA(i) {
  const a = HZ_ACCIONES[i];
  if (!a) return;
  if (a.tab === 'ventas') { EXP.dim = a.dim || 'canal'; EXP.orden = a.orden || 'venta'; }
  // Días de inventario ahora vive dentro de Inventario.
  if (a.tab === 'dias' || a.tab === 'inventario') { INV_NIVEL = a.nivel || 'producto'; goTo('inventario'); return; }
  goTo(a.tab);
}

async function cargarHallazgos(vigente, promesa) {
  const d = await promesa;
  const caja = document.getElementById('hz');
  if (!vigente() || !caja) return;
  if (!d) { caja.innerHTML = ''; return; }
  HZ_ACCIONES = [];
  const parrafo = segs => (segs || []).map(s => s.e === 'b' ? `<b>${esc(s.t)}</b>` : s.e ? `<span class="${s.e}">${esc(s.t)}</span>` : esc(s.t)).join('');
  const item = h => {
    const tipo = HZ_TIPO[h.tipo] || HZ_TIPO.info;
    let boton = '';
    if (h.accion) {
      HZ_ACCIONES.push(h.accion);
      boton = `<div><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();irA(${HZ_ACCIONES.length - 1})">${esc(h.accion.label)}${icon('arrow-right')}</button></div>`;
    }
    return `<div class="hz-item" onclick="this.classList.toggle('on')">
      <div class="hz-row"><span class="hz-ic ${tipo.tono}">${icon(h.icono)}</span><span class="hz-t">${esc(h.titulo)}</span>
        <span class="tag ${tipo.tono}">${tipo.tag}</span>${icon('chevron-down', 'class="chev"')}</div>
      <div class="hz-det">${esc(h.detalle)}${boton}</div></div>`;
  };
  const ventas = d.hallazgos.filter(h => h.bloque !== 'inventario').map(item).join('');
  const inventario = d.hallazgos.filter(h => h.bloque === 'inventario').map(item).join('');
  caja.innerHTML = `<div class="card hz">
    <div class="hz-head"><span class="ic">${icon('sparkles')}</span>
      <div style="flex:1"><h3>Hallazgos</h3><small>Generados con reglas sobre tus datos reales${hayFiltros() ? ' · con tus filtros' : ''}</small></div>
      ${d.alertas ? `<span class="tag t-red">${d.alertas} alerta${d.alertas > 1 ? 's' : ''}</span>` : '<span class="tag t-green">Sin alertas</span>'}</div>
    <div class="hz-bloque">
      <div class="hz-bt">${icon('chart-column-big')}<b>Ventas de ${etiquetaPeriodo(d.periodo.desde, d.periodo.hasta)}</b><span>vs ${etiquetaPeriodo(d.periodo.ant_desde, d.periodo.ant_hasta)} · cambia con el período elegido</span></div>
      <p class="hz-txt">${parrafo(d.resumen)}</p>
      <div class="hz-list">${ventas || '<div class="sub">No hay cambios relevantes en este período.</div>'}</div>
    </div>
    <div class="hz-bloque inv">
      <div class="hz-bt">${icon('warehouse')}<b>Inventario hoy</b><span>foto actual del stock · no cambia con el período</span></div>
      ${(d.resumen_inventario || []).length ? `<p class="hz-txt">${parrafo(d.resumen_inventario)}</p>` : ''}
      <div class="hz-list">${inventario || '<div class="sub">Sin alertas de inventario.</div>'}</div>
    </div>
    <div class="hz-foot">${icon('info')}Toca cada hallazgo para ver el detalle.</div></div>`;
  icons();
}

// Selector "Soles | Clientes" para las tarjetas que piden ver también coberturas.
// `estado` es el nombre de la variable global que guarda la métrica elegida.
const METRICAS = { venta: 'Soles', cobertura: 'Clientes' };
let MIX_CANAL = 'venta';
function segMetrica(estado, actual, alCambiar) {
  return `<div class="seg">${Object.entries(METRICAS).map(([k, l]) =>
    `<button class="${actual === k ? 'on' : ''}" onclick="${estado}='${k}';${alCambiar}">${l}</button>`).join('')}</div>`;
}

let DATOS_CANAL = null;
function dibujarCanal() {
  if (!DATOS_CANAL) return;
  const { canal, r } = DATOS_CANAL;
  const porClientes = MIX_CANAL === 'cobertura';
  const t = topMasOtros(canal.map(c => ({ clave: c.clave, venta: porClientes ? c.cobertura : c.venta })));
  dona('c_canal', t.map(c => c.clave), t.map(c => Math.round(c.venta)),
    porClientes ? fmt(r.cobertura) : moneyC(r.venta_neta), porClientes ? 'clientes únicos' : 'venta total',
    porClientes ? v => fmt(v) + ' clientes' : money);
  // Re-pintar el selector sin re-consultar datos.
  const seg = document.getElementById('c_canal')?.closest('.card')?.querySelector('.card-h .seg');
  if (seg) seg.outerHTML = segMetrica('MIX_CANAL', MIX_CANAL, 'dibujarCanal()');
}

// Barras por mes: cada mes del año del período junto al mismo mes del año
// anterior, en soles o en clientes. Lo usan el Resumen y Análisis de ventas.
let ANUAL_MET = 'venta';
const DATOS_ANUAL = {};
const anioActual = () => +(FECHAS.fin || RANGO.max).slice(0, 4);
function dibujarAnual(id) {
  const filas = DATOS_ANUAL[id];
  if (!filas) return;
  const y = anioActual(), enClientes = ANUAL_MET === 'cobertura';
  const valor = (anio, m) => {
    const f = filas.find(x => x.clave === `${anio}-${String(m).padStart(2, '0')}`);
    return f ? Math.round(enClientes ? f.cobertura : f.venta) : null;
  };
  const meses = [...Array(12).keys()].map(i => i + 1);
  const ant = meses.map(m => valor(y - 1, m)), act = meses.map(m => valor(y, m));
  const fmtV = enClientes ? v => fmt(v) + ' clientes' : money;
  chart(id, {
    type: 'bar',
    data: {
      labels: meses.map(m => MESES[m - 1]), datasets: [
        { label: String(y - 1), data: ant, backgroundColor: '#cbd5e1', borderRadius: 5, maxBarThickness: 26 },
        { label: String(y), data: act, backgroundColor: enClientes ? PAL[1] : PAL[0], borderRadius: 5, maxBarThickness: 26 }]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw == null ? '—' : fmtV(c.raw)}`, afterBody: it => { const d = delta(act[it[0].dataIndex], ant[it[0].dataIndex]); return d == null || act[it[0].dataIndex] == null ? '' : ` Variación: ${d >= 0 ? '+' : '−'}${fmt1(Math.abs(d))}%`; } } } },
      scales: { y: { ticks: { callback: v => compact(v) } }, x: { grid: { display: false } } }
    }
  });
  const seg = document.getElementById(id)?.closest('.card')?.querySelector('.card-h .seg');
  if (seg) seg.outerHTML = segMetrica('ANUAL_MET', ANUAL_MET, `dibujarAnual('${id}')`);
}

// "Venta por sede": período elegido frente al mismo período del año anterior,
// en soles o en clientes (cobertura).
let SEDE_MET = 'venta';
let DATOS_SEDE = null;
function dibujarSede() {
  if (!DATOS_SEDE) return;
  const { filas, actual, anterior } = DATOS_SEDE;
  const enClientes = SEDE_MET === 'cobertura';
  const fmtV = enClientes ? v => fmt(v) + ' clientes' : money;
  chart('c_sede', {
    type: 'bar',
    data: {
      labels: filas.map(f => f.clave), datasets: [
        { label: actual, data: filas.map(f => Math.round(enClientes ? f.cobertura : f.venta)), backgroundColor: PAL[4], borderRadius: 5, maxBarThickness: 16 },
        { label: anterior, data: filas.map(f => Math.round(enClientes ? f.cobertura_ant : f.venta_ant)), backgroundColor: '#c9bdfd', borderRadius: 5, maxBarThickness: 16 }]
    },
    options: {
      indexAxis: 'y',
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmtV(c.raw)}`, afterBody: it => { const f = filas[it[0].dataIndex]; const d = delta(enClientes ? f.cobertura : f.venta, enClientes ? f.cobertura_ant : f.venta_ant); return d == null ? '' : ` Variación: ${d >= 0 ? '+' : '−'}${fmt1(Math.abs(d))}%`; } } } },
      scales: { x: { ticks: { callback: v => compact(v) }, grid: { color: '#f1f3f8' } }, y: { grid: { display: false }, ticks: { autoSkip: false } } }
    }
  });
  const seg = document.getElementById('c_sede')?.closest('.card')?.querySelector('.card-h .seg');
  if (seg) seg.outerHTML = segMetrica('SEDE_MET', SEDE_MET, 'dibujarSede()');
}

// =======================================================================
//  RESUMEN
// =======================================================================
async function vistaResumen(vigente) {
  document.getElementById('view').innerHTML = skKpis(8) + skCharts() + skCharts('g-2');
  const hzPromesa = api('/api/hallazgos' + qs()).catch(() => null);
  const ant = rangoAnterior(FECHAS.ini, FECHAS.fin);
  const historia = qs({ desde: RANGO.min, hasta: RANGO.max }, { fechas: false });
  const uniPromesa = api('/api/universo' + qs({ dim: 'sede' })).catch(() => null);
  const [r, rAnt, mes, semana, canal, dia, prod, prodAnt, sede, sedeAnt, cat, diasInv] = await Promise.all([
    api('/api/resumen' + qs()),
    api('/api/resumen' + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => null),
    api('/api/agrupado/mes' + historia),
    api('/api/agrupado/semana' + qs()),
    api('/api/agrupado/canal' + qs()),
    api('/api/agrupado/dia_semana' + qs()),
    api('/api/agrupado/codigo_producto' + qs({ top: 10 })),
    api('/api/agrupado/codigo_producto' + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => []),
    api('/api/agrupado/sede' + qs()),
    api('/api/agrupado/sede' + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => []),
    api('/api/agrupado/categoria' + qs()),
    api('/api/dias_inventario' + qs({ dias: DIAS_CFG.periodo }, { fechas: false, soloStock: true })).catch(() => []),
  ]);
  const a = rAnt || {};
  if (diasInv.length) FUENTE_DIAS = diasInv[0].fuente;
  const totalDias = agruparDias(diasInv, 'total')[0];
  const diasStock = totalDias && r.cajas_stock > 0 ? totalDias.dias : null;
  const vsTxt = `vs ${etiquetaPeriodo(ant.ini, ant.fin)}`;
  const pen = penetracionTotal(await uniPromesa, mes);

  const ok = pintar(vigente, `
    <div id="hz"><div class="sk" style="height:230px;border-radius:16px;margin-bottom:1rem"></div></div>
    ${avisoDatosNuevos()}
    <div class="grid g-kpi">
      ${kpi('Venta neta s/IGV', moneyC(r.venta_neta), vsTxt, { ic: 'banknote', hero: true, delta: delta(r.venta_neta, a.venta_neta) })}
      ${kpi('Cobertura', fmt(r.cobertura), `clientes · ${vsTxt}`, { ic: 'users-round', tono: 't-blue', delta: delta(r.cobertura, a.cobertura) })}
      ${pen ? kpi('Penetración', fmt1(pen.pct) + '%', `${fmt(Math.round(pen.clientes))} clientes/mes de ${fmt(pen.universo)} del universo Vega`, { ic: 'target', tono: 't-violet' })
            : kpi('Penetración', '—', 'no aplica con filtros de canal, tipo de negocio, jefe o supervisor', { ic: 'target', tono: 't-violet' })}
      ${kpi('Cajas vendidas', fmt(r.cajas), `${fmt1(r.cajas_diarias)} cajas por día`, { ic: 'boxes', tono: 't-green', delta: delta(r.cajas, a.cajas) })}
      ${kpi('Documentos', fmt(r.documentos), 'boletas y facturas', { ic: 'receipt-text', tono: 't-violet', delta: delta(r.documentos, a.documentos) })}
      ${kpi('Ticket promedio', money(r.ticket_documento), 'venta ÷ documentos', { ic: 'ticket', tono: 't-amber', delta: delta(r.ticket_documento, a.ticket_documento) })}
      ${kpi('Venta por cliente', money(r.venta_por_cliente), 'venta ÷ cobertura', { ic: 'user-round-check', tono: 't-cyan', delta: delta(r.venta_por_cliente, a.venta_por_cliente) })}
      ${kpi('Inventario', moneyC(r.valor_stock), `${fmt(r.cajas_stock)} cajas · ${r.skus_con_stock} SKUs`, { ic: 'warehouse', tono: 't-slate' })}
      ${kpi('Días de inventario', diasStock == null ? '—' : fmt(diasStock), FUENTE_DIAS === 'rotacion' ? 'stock ÷ rotación diaria por almacén' : 'stock ÷ venta diaria', { ic: 'hourglass', tono: diasStock != null && diasStock < 10 ? 't-red' : 't-green' })}
    </div>
    <div class="grid g-21">
      ${card('Crecimiento anual por mes', chWrap('c_mes', 'lg'), { ic: 'chart-column-big', sub: `Cada mes de ${anioActual()} junto al mismo mes de ${anioActual() - 1}`, tono: 't-red', extra: segMetrica('ANUAL_MET', ANUAL_MET, "dibujarAnual('c_mes')") })}
      ${card('Mix por canal', chWrap('c_canal', 'lg'), { ic: 'chart-pie', sub: 'Participación por canal', tono: 't-blue', extra: segMetrica('MIX_CANAL', MIX_CANAL, 'dibujarCanal()') })}
    </div>
    <div class="grid g-21">
      ${card('Venta semanal', chWrap('c_sem'), { ic: 'calendar-range', sub: 'Semanas dentro del período filtrado', tono: 't-green' })}
      ${card('Venta por día de la semana', chWrap('c_dia'), { ic: 'calendar-days', sub: 'Qué días se vende más', tono: 't-amber' })}
    </div>
    <div class="grid g-21">
      ${card('Top 10 productos', table(
        [{ h: '#', f: v => `<span class="rank">${v}</span>` }, { h: 'Producto', f: v => v }, { h: 'Venta', n: 1, f: money }, { h: `Venta ${+ant.fin.slice(0, 4)}`, n: 1, f: money }, { h: 'Var.', n: 1, f: variacionCelda }, { h: 'Part.', f: v => barra(v) }, { h: 'Clientes', n: 1, f: fmt }],
        conAnterior(prod, prodAnt).map((p, i) => [i + 1, `<b>${esc(p.descripcion)}</b><span class="muted">${esc(p.clave)}</span>`, p.venta, p.venta_ant, delta(p.venta, p.venta_ant), pct(p.venta, r.venta_neta), p.cobertura])
      ), { ic: 'trophy', sub: `Por venta neta · comparado con ${etiquetaPeriodo(ant.ini, ant.fin)}`, tono: 't-amber' })}
      <div style="display:grid;gap:1rem">
        ${card('Venta por sede', chWrap('c_sede', 'sm'), { ic: 'building-2', tono: 't-violet', sub: 'vs año anterior', extra: segMetrica('SEDE_MET', SEDE_MET, 'dibujarSede()') })}
        ${card('Venta por categoría', chWrap('c_cat', 'sm'), { ic: 'tags', tono: 't-cyan' })}
      </div>
    </div>`);
  if (!ok) return;
  cargarHallazgos(vigente, hzPromesa);

  DATOS_ANUAL.c_mes = mes;
  dibujarAnual('c_mes');
  DATOS_CANAL = { canal, r };
  dibujarCanal();
  const semOrd = [...semana].sort((x, y) => x.clave.localeCompare(y.clave));
  chart('c_sem', {
    type: 'line',
    data: { labels: semOrd.map(s => fechaCorta(s.clave)), datasets: [{ label: 'Venta S/', data: semOrd.map(s => Math.round(s.venta)), borderColor: PAL[2], backgroundColor: gradiente(PAL[2]), fill: true, tension: .35, pointRadius: 2 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: tickMoney }, x: { grid: { display: false } } } }
  });
  const diaOrd = [...dia].sort((x, y) => +x.clave - +y.clave);
  chart('c_dia', {
    type: 'bar',
    data: { labels: diaOrd.map(d => DIAS_SEM[+d.clave].slice(0, 3)), datasets: [{ label: 'Venta S/', data: diaOrd.map(d => Math.round(d.venta)), backgroundColor: PAL[3], borderRadius: 8 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: tickMoney }, x: { grid: { display: false } } } }
  });
  DATOS_SEDE = { filas: conAnterior(sede.slice(0, 8), sedeAnt), actual: etiquetaPeriodo(FECHAS.ini, FECHAS.fin), anterior: etiquetaPeriodo(ant.ini, ant.fin) };
  dibujarSede();
  barrasH('c_cat', cat.slice(0, 8).map(s => s.clave), cat.slice(0, 8).map(s => Math.round(s.venta)), { color: PAL[5] });
}

// =======================================================================
//  ANÁLISIS DE VENTAS — explorador por dimensión
// =======================================================================
const DIMENSIONES = [
  { k: 'sede', l: 'Sede', ic: 'building-2' },
  { k: 'distrito', l: 'Distrito', ic: 'map-pin' },
  { k: 'canal', l: 'Canal', ic: 'store' },
  { k: 'tipo_negocio', l: 'Tipo de negocio', ic: 'shopping-basket' },
  { k: 'jefe_ventas', l: 'Jefe de ventas', ic: 'user-cog' },
  { k: 'supervisor', l: 'Supervisor', ic: 'users' },
  { k: 'codigo_vendedor', l: 'Vendedor', ic: 'user' },
  { k: 'marca', l: 'Marca', ic: 'award' },
  { k: 'categoria', l: 'Categoría', ic: 'tags' },
  { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash' },
  { k: 'codigo_producto', l: 'Producto', ic: 'package' },
];
let EXP = { dim: 'canal', orden: 'venta', top: 25 };

async function vistaVentas(vigente) {
  const d = DIMENSIONES.find(x => x.k === EXP.dim);
  const ant = rangoAnterior(FECHAS.ini, FECHAS.fin);
  const cabecera = `<div class="pagehead"><div><h2>Venta por ${d.l.toLowerCase()}</h2><div class="sub">${etiquetaPeriodo(FECHAS.ini, FECHAS.fin)} · comparado con ${etiquetaPeriodo(ant.ini, ant.fin)}${hayFiltros() ? ' · con filtros aplicados' : ''}</div></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <select class="sel" onchange="EXP.orden=this.value;render()">${[['venta', 'Ordenar por venta'], ['cobertura', 'Ordenar por clientes'], ['cajas', 'Ordenar por cajas']].map(([k, l]) => `<option value="${k}" ${EXP.orden === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="sel" onchange="EXP.top=+this.value;render()">${[10, 25, 50, 0].map(n => `<option value="${n}" ${EXP.top === n ? 'selected' : ''}>${n ? 'Top ' + n : 'Todos'}</option>`).join('')}</select>
      </div></div>
    <div style="margin-bottom:1rem"><div class="seg">${DIMENSIONES.map(x => `<button class="${x.k === EXP.dim ? 'on' : ''}" onclick="EXP.dim='${x.k}';render()">${icon(x.ic)}${x.l}</button>`).join('')}</div></div>`;
  document.getElementById('view').innerHTML = cabecera + skKpis(4) + skCharts();
  icons();

  const conUniverso = ['sede', 'distrito'].includes(EXP.dim);
  const [r, filasAct, filasAnt, mes, mesAct, mesAnt, uni] = await Promise.all([
    api('/api/resumen' + qs()),
    api(`/api/agrupado/${EXP.dim}` + qs({ orden: EXP.orden, top: EXP.top || null })),
    api(`/api/agrupado/${EXP.dim}` + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => []),
    api('/api/agrupado/mes' + qs({ desde: RANGO.min, hasta: RANGO.max }, { fechas: false })),
    api(`/api/agrupado_mes/${EXP.dim}` + qs()).catch(() => []),
    api(`/api/agrupado_mes/${EXP.dim}` + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => []),
    conUniverso ? api('/api/universo' + qs({ dim: EXP.dim })).catch(() => null) : null,
  ]);
  const filas = conAnterior(filasAct, filasAnt);
  // Penetración = clientes promedio por mes ÷ universo (con varios meses no se
  // usan los clientes acumulados, que podrían pasar del universo).
  const meses = mesesDelPeriodo();
  if (uni) filas.forEach(f => {
    const suma = mesAct.filter(m => m.clave === f.clave).reduce((s, m) => s + m.cobertura, 0);
    f.universo = uni.filas[f.clave] || 0;
    f.penetracion = f.universo ? suma / meses.length / f.universo * 100 : null;
  });
  const pen = uni ? penetracionTotal(uni, mes) : null;
  MES_A_MES = { filas, mesAct, mesAnt, meses, nombre: f => (EXP.dim === 'codigo_producto' ? f.descripcion : f.clave), titulo: d.l };
  const anioAnt = etiquetaPeriodo(ant.ini, ant.fin);
  const enClientes = EXP.orden === 'cobertura';
  const metrica = enClientes ? 'cobertura' : 'venta';
  const es = EXP.dim === 'codigo_producto';
  const nombre = f => es ? f.descripcion : f.clave;
  const lider = filas[0];
  const top5 = [...filas].sort((x, y) => y.venta - x.venta).slice(0, 5).reduce((s, f) => s + f.venta, 0);

  const ok = pintar(vigente, cabecera + `
    ${['sede', 'distrito', 'categoria', 'codigo_proveedor'].includes(EXP.dim) ? avisoDatosNuevos() : ''}
    <div class="grid g-kpi">
      ${kpi('Venta total', moneyC(r.venta_neta), `${fmt(r.cobertura)} clientes`, { ic: 'banknote', hero: true })}
      ${kpi(`${d.l} líder`, lider ? esc(String(nombre(lider)).slice(0, 22)) : '—', lider ? `${fmt1(pct(lider.venta, r.venta_neta))}% de la venta` : '', { ic: 'crown', tono: 't-amber' })}
      ${kpi('Concentración top 5', fmt1(pct(top5, r.venta_neta)) + '%', 'de la venta total', { ic: 'target', tono: 't-violet' })}
      ${pen ? kpi('Penetración total', fmt1(pen.pct) + '%', `${fmt(Math.round(pen.clientes))} clientes/mes de ${fmt(pen.universo)} del universo Vega`, { ic: 'target', tono: 't-violet' })
            : kpi('Con venta en el período', fmt(filas.length) + (EXP.top && filas.length === EXP.top ? '+' : ''), EXP.top ? `mostrando top ${EXP.top}` : d.l.toLowerCase(), { ic: d.ic, tono: 't-blue' })}
    </div>
    ${conUniverso ? '' : nota('Para ver el <b>universo de clientes de Vega y la penetración</b>, elige la dimensión <b>Sede</b> o <b>Distrito</b>.', 'target')}
    ${uni ? card(`Penetración por ${d.l.toLowerCase()}`, chWrap('c_pen', 'lg'), { ic: 'target', sub: `Clientes con compra por mes ÷ universo de clientes de Vega (foto de ${mesLargo(uni.periodo)})`, tono: 't-violet' }) : ''}
    ${card('Venta histórica mensual', chWrap('c_hist'), { ic: 'chart-column-big', sub: `Cada mes de ${anioActual()} junto al mismo mes de ${anioActual() - 1}${hayFiltros() ? ', con tus filtros' : ''}`, tono: 't-green', extra: segMetrica('ANUAL_MET', ANUAL_MET, "dibujarAnual('c_hist')") })}
    <div class="grid g-21">
      ${card(`Ranking por ${d.l.toLowerCase()}`, chWrap('c_rank', 'lg'), { ic: 'chart-bar-big', sub: `Primeros 15, en ${enClientes ? 'clientes (cobertura)' : EXP.orden === 'cajas' ? 'cajas' : 'soles'}`, tono: 't-red', extra: segMetrica('EXP.orden', EXP.orden, 'render()') })}
      ${card('Participación', chWrap('c_part', 'lg'), { ic: 'chart-pie', sub: enClientes ? 'En los clientes' : 'En la venta neta', tono: 't-blue' })}
    </div>
    ${card('Detalle', table(
      [{ h: '#', f: v => `<span class="rank">${v}</span>` }, { h: d.l, f: v => v }, { h: 'Venta', n: 1, f: money }, { h: 'Venta año ant.', n: 1, f: money }, { h: 'Var. venta', n: 1, f: variacionCelda }, { h: 'Clientes', n: 1, f: fmt },
        ...(uni ? [{ h: 'Universo Vega', n: 1, f: v => v ? fmt(v) : '—' }, { h: 'Penetración', n: 1, f: v => v == null ? '—' : `<b style="color:#7c5cff">${fmt1(v)}%</b>` }] : []),
        { h: 'Clientes año ant.', n: 1, f: fmt }, { h: 'Var. clientes', n: 1, f: variacionCelda }, { h: 'Participación', f: v => `<div style="display:flex;gap:.5rem;align-items:center">${barra(v)}<small>${fmt1(v)}%</small></div>` }, { h: 'Cajas', n: 1, f: fmt }, { h: 'Venta / cliente', n: 1, f: money }],
      filas.map((f, i) => [i + 1, es ? `<b>${esc(f.descripcion)}</b><span class="muted">${esc(f.clave)}</span>` : `<b>${esc(f.clave)}</b>`, f.venta, f.venta_ant, delta(f.venta, f.venta_ant), f.cobertura,
        ...(uni ? [f.universo, f.penetracion] : []), f.cobertura_ant, delta(f.cobertura, f.cobertura_ant), pct(f.venta, r.venta_neta), f.cajas, f.cobertura ? f.venta / f.cobertura : 0])
    ), { ic: 'table-2', sub: `${filas.length} filas · año anterior = ${anioAnt}`, tono: 't-slate' })}
    ${uni ? nota(`<b>Penetración</b> = clientes con compra por mes ÷ universo de clientes de Vega en ${EXP.dim === 'sede' ? 'la sede' : 'el distrito'} (activos con dirección principal activa, foto de ${mesLargo(uni.periodo)}).${meses.length > 1 ? ` Con ${meses.length} meses se usa el promedio mensual de clientes.` : ''}`, 'users-round') : conUniverso ? nota('La penetración no se muestra con filtros de canal, tipo de negocio, jefe o supervisor: el universo de Vega no se divide por esos campos.', 'info') : ''}
    <div id="mesAMes"></div>`);
  if (!ok) return;
  tablaMesAMes();

  const top15 = filas.slice(0, 15);
  const valor = f => EXP.orden === 'cobertura' ? f.cobertura : EXP.orden === 'cajas' ? Math.round(f.cajas) : Math.round(f.venta);
  barrasH('c_rank', top15.map(f => String(nombre(f)).slice(0, 30)), top15.map(valor),
    { fmtV: EXP.orden === 'venta' ? money : enClientes ? v => fmt(v) + ' clientes' : v => fmt(v) + ' cajas', color: enClientes ? PAL[1] : PAL[0] });
  const part = topMasOtros(filas.map(f => ({ clave: String(nombre(f)).slice(0, 26), venta: f[metrica] })));
  dona('c_part', part.map(p => p.clave), part.map(p => Math.round(p.venta)),
    enClientes ? fmt(r.cobertura) : moneyC(r.venta_neta), enClientes ? 'clientes únicos' : 'venta total',
    enClientes ? v => fmt(v) + ' clientes' : money);

  if (uni) {
    const conPen = filas.filter(f => f.penetracion != null).slice(0, 15);
    barrasH('c_pen', conPen.map(f => String(nombre(f)).slice(0, 30)), conPen.map(f => Math.round(f.penetracion * 10) / 10),
      { color: '#7c5cff', fmtV: v => `${fmt1(v)}% de penetración` });
  }
  DATOS_ANUAL.c_hist = mes;
  dibujarAnual('c_hist');
}

// Penetración total = clientes con compra por mes (promedio de los meses del
// período, del historial mensual con filtros) ÷ universo de Vega de esas sedes.
function penetracionTotal(uni, mesesHistoria) {
  if (!uni) return null;
  const universo = Object.values(uni.filas).reduce((s, v) => s + v, 0);
  const meses = mesesDelPeriodo();
  const clientes = meses.reduce((s, ym) => s + (mesesHistoria.find(m => m.clave === ym)?.cobertura || 0), 0) / meses.length;
  return universo ? { universo, clientes, pct: clientes / universo * 100, periodo: uni.periodo } : null;
}

// Meses (AAAA-MM) del período elegido.
function mesesDelPeriodo() {
  const lista = [];
  for (let ym = FECHAS.ini.slice(0, 7); ym <= FECHAS.fin.slice(0, 7); ym = sumarMeses(ym, 1)) lista.push(ym);
  return lista;
}

// Comparativo mes a mes: por cada mes del período, el año actual, el anterior
// y la variación, en soles o en clientes. Se redibuja sin volver a consultar.
let MES_A_MES = null;
let MES_MET = 'venta';
function tablaMesAMes() {
  const caja = document.getElementById('mesAMes');
  if (!caja || !MES_A_MES) return;
  const { filas, mesAct, mesAnt, meses, nombre, titulo } = MES_A_MES;
  const enClientes = MES_MET === 'cobertura';
  const idx = lista => new Map(lista.map(m => [`${m.clave}|${m.mes}`, enClientes ? m.cobertura : m.venta]));
  const act = idx(mesAct), antM = idx(mesAnt);
  const fmtV = v => v == null ? '—' : enClientes ? fmt(v) : moneyC(v);
  const cabeza1 = meses.map(ym => `<th colspan="3" class="grp">${mesLargo(ym)} vs ${MESES[+ym.slice(5) - 1]} ${+ym.slice(0, 4) - 1}</th>`).join('');
  const cabeza2 = meses.map(ym => `<th class="n">${ym.slice(0, 4)}</th><th class="n">${+ym.slice(0, 4) - 1}</th><th class="n sep">Var.</th>`).join('');
  const cuerpo = filas.map(f => `<tr><td><b>${esc(String(nombre(f)).slice(0, 40))}</b></td>${meses.map(ym => {
    const a = act.get(`${f.clave}|${ym}`), b = antM.get(`${f.clave}|${menosUnAnio(ym + '-01').slice(0, 7)}`);
    return `<td class="n">${fmtV(a)}</td><td class="n muted-c">${fmtV(b)}</td><td class="n sep">${a == null ? '—' : variacionCelda(delta(a, b))}</td>`;
  }).join('')}</tr>`).join('');
  caja.innerHTML = card('Comparativo mes a mes', filas.length ? `<div class="ov"><table class="mam"><thead><tr><th rowspan="2">${esc(titulo)}</th>${cabeza1}</tr><tr>${cabeza2}</tr></thead><tbody>${cuerpo}</tbody></table></div>` : vacio('Sin datos para los filtros elegidos', 'search-x'),
    { ic: 'calendar-range', sub: `Cada mes del período frente al mismo mes del año anterior, en ${enClientes ? 'clientes (cobertura del mes)' : 'soles'}`, tono: 't-violet', extra: segMetrica('MES_MET', MES_MET, 'tablaMesAMes()') });
  icons();
}

// =======================================================================
//  INVENTARIO
// =======================================================================
let INV_NIVEL = 'sede';
let INV_DIAS = [];
function tablaDiasInventario() {
  const caja = document.getElementById('invDias');
  if (!caja) return;
  const niveles = DIAS_NIVELES.filter(n => ['sede', 'categoria', 'codigo_proveedor', 'producto'].includes(n.k));
  const esProd = INV_NIVEL === 'producto';
  const nivel = niveles.find(n => n.k === INV_NIVEL);
  const cols = [{ h: nivel.l, f: v => v }];
  if (esProd) cols.push({ h: 'Categoría' });
  cols.push({ h: 'Stock', n: 1, f: stockCaja }, { h: 'Venta diaria (cajas)', n: 1, f: fmt1 }, { h: 'Días de inventario', n: 1, f: semaforo }, { h: 'Estado', f: v => `<span style="color:${COLOR_ESTADO[v]};font-weight:600">${TXT_ESTADO[v]}</span>` });
  const rows = agruparDias(INV_DIAS, INV_NIVEL).map(g => {
    const r = [esProd ? `<b>${esc(g.descripcion || g.clave)}</b><span class="muted">${esc(g.clave)}</span>` : `<b>${esc(g.clave)}</b>`];
    if (esProd) r.push(g.categoria);
    r.push({ c: g.stock, u: g.unid, f: g.factor }, g.venta, g.dias, estadoDias(g.dias));
    return r;
  });
  const seg = `<div class="seg">${niveles.map(n => `<button class="${n.k === INV_NIVEL ? 'on' : ''}" onclick="INV_NIVEL='${n.k}';tablaDiasInventario()">${icon(n.ic)}${n.l}</button>`).join('')}</div>`;
  const grupos = agruparDias(INV_DIAS, INV_NIVEL);
  caja.innerHTML = card(`Días de inventario por ${nivel.l.toLowerCase()}`, `
    ${chWrap('c_dias', 'lg')}
    <p class="legend" style="margin:.8rem 0"><span><span class="dot bad"></span>menos de ${UMBRAL.bajo} días: riesgo de quiebre</span><span><span class="dot ok"></span>${UMBRAL.bajo} a ${UMBRAL.alto} días: saludable</span><span><span class="dot warn"></span>más de ${UMBRAL.alto} días: sobrestock</span><span><span class="dot gris"></span>sin venta</span></p>
    ${table(cols, rows)}`,
    { ic: 'hourglass', sub: textoFuenteDias(), tono: 't-amber', extra: seg });
  icons();
  const top = grupos.filter(g => g.dias != null).slice(0, 25);
  barrasH('c_dias', top.map(g => String(esProd ? (g.descripcion || g.clave) : g.clave).slice(0, 30)), top.map(g => Math.round(g.dias)),
    { colores: top.map(g => COLOR_ESTADO[estadoDias(g.dias)]), fmtV: v => fmt(v) + ' días' });
}

// Resumen por categoría: stock, valor, rotación, días y cuántos SKUs están en
// riesgo de quiebre o en sobrestock (contados por producto, todas las sedes).
function tablaCategorias(dias) {
  const productos = agruparDias(dias, 'producto');
  const filas = agruparDias(dias, 'categoria').map(g => {
    const suyos = productos.filter(p => p.categoria === g.clave);
    return [`<b>${esc(g.clave)}</b>`, g.stock, g.valor, g.venta, g.dias,
      suyos.filter(p => estadoDias(p.dias) === 'bad').length, suyos.filter(p => estadoDias(p.dias) === 'warn').length, suyos.length];
  });
  return card('Días de inventario por categoría', table(
    [{ h: 'Categoría', f: v => v }, { h: 'Stock (cajas)', n: 1, f: fmt }, { h: 'Valor', n: 1, f: money }, { h: 'Venta diaria (cajas)', n: 1, f: fmt1 }, { h: 'Días', n: 1, f: semaforo },
     { h: `SKUs &lt; ${UMBRAL.bajo} días`, n: 1, f: v => v ? `<b style="color:${COLOR_ESTADO.bad}">${v}</b>` : '0' }, { h: `SKUs &gt; ${UMBRAL.alto} días`, n: 1, f: v => v ? `<b style="color:${COLOR_ESTADO.warn}">${v}</b>` : '0' }, { h: 'SKUs', n: 1, f: fmt }],
    filas), { ic: 'tags', sub: 'Foto actual del stock · días = stock ÷ rotación diaria', tono: 't-cyan' });
}

async function vistaInventario(vigente) {
  document.getElementById('view').innerHTML = skKpis(8) + skCharts('g-2');
  const [s, dias] = await Promise.all([
    api('/api/stock' + qs({}, { fechas: false, soloStock: true })),
    api('/api/dias_inventario' + qs({ dias: DIAS_CFG.periodo }, { fechas: false, soloStock: true })),
  ]);
  INV_DIAS = dias;
  if (dias.length) FUENTE_DIAS = dias[0].fuente;
  const total = agruparDias(dias, 'total')[0] || { dias: null, venta: 0 };
  const productos = agruparDias(dias, 'producto');
  const cuenta = e => productos.filter(p => estadoDias(p.dias) === e).length;
  const ignorados = Object.keys(SEL).filter(k => !FILTRO_DEF[k].stock).map(k => FILTRO_DEF[k].l);
  const sinStockSede = (SEL.sede || []).length && !s.cajas_stock;
  const ok = pintar(vigente, `
    ${ignorados.length ? nota(`El inventario no se divide por ${ignorados.join(', ').toLowerCase()}: esos filtros solo aplican a las ventas.`, 'info') : ''}
    ${sinStockSede ? nota('Todavía no hay stock asociado a esta sede: falta asignar la sede de cada almacén.', 'triangle-alert', 'warn') : ''}
    <div class="grid g-kpi">
      ${kpi('Valor de inventario', moneyC(s.valor_stock), 'a costo', { ic: 'banknote', hero: true })}
      ${kpi('Cajas en stock', fmt(s.cajas_stock), 'unidad máxima', { ic: 'boxes', tono: 't-green' })}
      ${kpi('Días de inventario', total.dias == null || !s.cajas_stock ? '—' : fmt(total.dias), `stock ÷ ${fmt1(total.venta)} cajas/día`, { ic: 'hourglass', tono: total.dias != null && total.dias < UMBRAL.bajo ? 't-red' : 't-amber' })}
      ${kpi('SKUs con stock', fmt(s.skus_con_stock), `de ${s.por_producto.length} productos · ${fmt(s.almacenes)} almacenes`, { ic: 'package-check', tono: 't-blue' })}
      ${kpi('Riesgo de quiebre', fmt(cuenta('bad')), `productos con menos de ${UMBRAL.bajo} días (sumando sedes)`, { ic: 'triangle-alert', tono: 't-red' })}
      ${kpi('Saludables', fmt(cuenta('ok')), `entre ${UMBRAL.bajo} y ${UMBRAL.alto} días (sumando sedes)`, { ic: 'circle-check-big', tono: 't-green' })}
      ${kpi('Sobrestock', fmt(cuenta('warn')), `más de ${UMBRAL.alto} días · ${fmt(cuenta('gris'))} sin venta`, { ic: 'archive', tono: 't-amber' })}
      ${kpi('Venta diaria', fmt1(total.venta), 'cajas por día (rotación)', { ic: 'activity', tono: 't-violet' })}
    </div>
    ${tablaCategorias(dias)}
    <div id="invDias" style="margin-bottom:1rem"></div>
    <div class="grid g-2">
      ${card('Valor por almacén', chWrap('c_alm'), { ic: 'warehouse', tono: 't-red' })}
      ${card('Valor por categoría', chWrap('c_icat'), { ic: 'tags', tono: 't-cyan' })}
    </div>
    ${card('Detalle por producto', table(
      [{ h: 'Producto', f: v => v }, { h: 'Categoría' }, { h: 'Cód. proveedor' }, { h: 'Stock', n: 1, f: stockCaja }, { h: 'Valor', n: 1, f: money }, { h: 'Part.', f: v => barra(v) }],
      s.por_producto.map(p => [`<b>${esc(p.descripcion)}</b><span class="muted">${esc(p.clave)}</span>`, p.categoria, p.codigo_proveedor, { c: p.cajas, u: p.unidades, f: p.factor }, p.valor, pct(p.valor, s.valor_stock)])
    ), { ic: 'table-2', sub: `${s.por_producto.length} productos`, tono: 't-slate' })}`);
  if (!ok) return;
  tablaDiasInventario();
  barrasH('c_alm', s.por_almacen.map(a => a.clave), s.por_almacen.map(a => Math.round(a.valor)), { color: PAL[0] });
  const c = topMasOtros(s.por_categoria.map(x => ({ clave: x.clave, venta: x.valor })));
  dona('c_icat', c.map(x => x.clave), c.map(x => Math.round(x.venta)), moneyC(s.valor_stock), 'valor total');
}

// =======================================================================
//  SEGMENTOS DE CLIENTES A–E (requerimiento 8 de PEUSAC). El segmento lo
//  calcula db.segmentos: venta neta del período ÷ meses, por cliente.
// =======================================================================
const SEG_COLOR = { A: '#12a37a', B: '#2563eb', C: '#7c5cff', D: '#f59e0b', E: '#94a3b8' };
const SEG_DESC = { A: 'Clientes clave', B: 'Clientes fuertes', C: 'Clientes medios', D: 'Clientes promedio', E: 'Clientes pequeños' };
const SEG_DIMS = [
  { k: 'sede', l: 'Sede', ic: 'building-2' }, { k: 'distrito', l: 'Distrito', ic: 'map-pin' },
  { k: 'canal', l: 'Canal', ic: 'store' }, { k: 'tipo_negocio', l: 'Tipo de negocio', ic: 'shopping-basket' },
  { k: 'supervisor', l: 'Supervisor', ic: 'users' }, { k: 'jefe_ventas', l: 'Jefe de ventas', ic: 'user-cog' },
];
let SEG_CFG = { dim: 'sede', segmento: '' };
// Celda de la tabla por dimensión: clientes del segmento, su % dentro de la fila y la venta de esos clientes.
const celdaSegmento = c => `<b>${fmt(c.n)}</b><span class="cel-sub">${fmt1(c.p)}% · ${moneyC(c.v)}</span>`;

function rangoSegmento(rangos, s) {
  const i = rangos.findIndex(r => r.segmento === s);
  const desde = rangos[i].desde, hasta = i > 0 ? rangos[i - 1].desde : null;
  if (!hasta) return `desde S/ ${desde}`;
  return desde ? `S/ ${desde} a menos de S/ ${hasta}` : `menos de S/ ${hasta}`;
}

async function vistaSegmentos(vigente) {
  const dim = SEG_DIMS.find(x => x.k === SEG_CFG.dim);
  document.getElementById('view').innerHTML = skKpis(5) + skCharts('g-2', 1);
  const [d, lista] = await Promise.all([
    api('/api/segmentos' + qs({ dim: SEG_CFG.dim })),
    api('/api/segmentos/clientes' + qs({ segmento: SEG_CFG.segmento })),
  ]);
  const letras = d.rangos.map(r => r.segmento);
  const total = { clientes: 0, venta: 0 };
  const porSeg = Object.fromEntries(letras.map(s => [s, { clientes: 0, venta: 0 }]));
  const porClave = new Map();
  d.filas.forEach(f => {
    porSeg[f.segmento].clientes += f.clientes; porSeg[f.segmento].venta += f.venta;
    total.clientes += f.clientes; total.venta += f.venta;
    const g = porClave.get(f.clave) || { clave: f.clave, total: 0 };
    g[f.segmento] = (g[f.segmento] || 0) + f.clientes; g.total += f.clientes;
    g['v' + f.segmento] = (g['v' + f.segmento] || 0) + f.venta; g.venta = (g.venta || 0) + f.venta;
    porClave.set(f.clave, g);
  });
  const grupos = [...porClave.values()].sort((a, b) => b.total - a.total);
  const totalLista = SEG_CFG.segmento ? porSeg[SEG_CFG.segmento].clientes : total.clientes;
  const periodo = etiquetaPeriodo(FECHAS.ini, FECHAS.fin);
  const base = d.meses > 1 ? `promedio mensual de ${periodo} (venta ÷ ${d.meses} meses)` : `compra de ${periodo}`;

  const ok = pintar(vigente, `
    ${nota(`Cada cliente se clasifica por su <b>venta neta sin IGV</b> (${base}): ${letras.map(s => `<b>${s}</b> ${rangoSegmento(d.rangos, s)}`).join(' · ')}. Solo cuentan los clientes con venta neta mayor a 0, igual que la cobertura.`, 'info')}
    ${FECHAS.fin < finDeMes(FECHAS.hasta) ? nota(`${mesLargo(FECHAS.hasta)} aún no cierra (datos al ${fechaCorta(FECHAS.fin)}): los clientes todavía pueden subir de segmento. Para una foto completa, elige un mes cerrado.`, 'calendar-clock', 'warn') : ''}
    <div class="grid g-kpi">
      ${letras.map(s => kpi(`Segmento ${s} · ${SEG_DESC[s]}`, fmt(porSeg[s].clientes),
        `${fmt1(pct(porSeg[s].clientes, total.clientes))}% de clientes · ${moneyC(porSeg[s].venta)} (${fmt1(pct(porSeg[s].venta, total.venta))}% venta)`,
        { ic: 'medal', tono: { A: 't-green', B: 't-blue', C: 't-violet', D: 't-amber', E: 't-slate' }[s] })).join('')}
    </div>
    <div style="margin-bottom:1rem"><div class="seg">${SEG_DIMS.map(x => `<button class="${x.k === SEG_CFG.dim ? 'on' : ''}" onclick="SEG_CFG.dim='${x.k}';render()">${icon(x.ic)}${x.l}</button>`).join('')}</div></div>
    ${card(`Clientes por segmento y ${dim.l.toLowerCase()}`, chWrap('c_seg', 'lg'), { ic: 'chart-bar-big', sub: `Primeros 15 por número de clientes · ${periodo}`, tono: 't-green' })}
    ${card('Detalle', table(
      [{ h: dim.l, f: v => `<b>${esc(v)}</b>` }, ...letras.map(s => ({ h: `Segmento ${s}`, n: 1, f: celdaSegmento })), { h: 'Total', n: 1, f: c => `<b>${fmt(c.n)}</b><span class="cel-sub">${moneyC(c.v)}</span>` }],
      grupos.map(g => [g.clave, ...letras.map(s => ({ n: g[s] || 0, p: pct(g[s] || 0, g.total), v: g['v' + s] || 0 })), { n: g.total, v: g.venta }])
    ), { ic: 'table-2', sub: `${grupos.length} filas · clientes, % de la fila y venta en soles de cada segmento`, tono: 't-slate' })}
    ${card('Listado de clientes', `
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.8rem">
        <div class="seg">${['', ...letras].map(s => `<button class="${SEG_CFG.segmento === s ? 'on' : ''}" onclick="SEG_CFG.segmento='${s}';render()">${s ? 'Segmento ' + s : 'Todos'}</button>`).join('')}</div>
        <div class="grow"></div>
        <button class="btn btn-ac btn-sm" onclick="location.href='/api/segmentos/clientes.csv'+qs({segmento: SEG_CFG.segmento})">${icon('download')}Descargar listado (${fmt(totalLista)})</button>
      </div>
      ${table(
        [{ h: 'Cliente', f: v => `<b>${esc(v)}</b>` }, { h: 'Seg.', f: s => `<span class="tag" style="background:${SEG_COLOR[s]}1f;color:${SEG_COLOR[s]}">${s}</span>` }, { h: 'Compra mensual', n: 1, f: money2 }, { h: 'Venta período', n: 1, f: money2 }, { h: 'SKUs', n: 1, f: fmt }, { h: 'Documentos', n: 1, f: fmt }, { h: 'Sede' }, { h: 'Distrito' }, { h: 'Canal' }, { h: 'Tipo de negocio' }, { h: 'Supervisor' }],
        lista.map(c => [c.codigo_cliente, c.segmento, c.mensual, c.venta, c.skus, c.documentos, c.sede, c.distrito, c.canal, c.tipo_negocio, c.supervisor])
      )}
      ${totalLista > lista.length ? `<p class="sub" style="margin:.6rem 0 0">Se muestran los ${fmt(lista.length)} clientes de mayor compra; el listado completo está en la descarga.</p>` : ''}`,
      { ic: 'list', sub: `${fmt(totalLista)} clientes${SEG_CFG.segmento ? ' del segmento ' + SEG_CFG.segmento : ''}${hayFiltros() ? ' · con tus filtros' : ''}`, tono: 't-blue' })}`);
  if (!ok) return;

  const top = grupos.slice(0, 15);
  chart('c_seg', {
    type: 'bar',
    data: { labels: top.map(g => String(g.clave).slice(0, 28)), datasets: letras.map(s => ({ label: s, data: top.map(g => g[s] || 0), backgroundColor: SEG_COLOR[s], maxBarThickness: 22 })) },
    options: {
      indexAxis: 'y',
      plugins: { tooltip: { callbacks: { label: c => ` Segmento ${c.dataset.label}: ${fmt(c.raw)} clientes` } } },
      scales: { x: { stacked: true, grid: { color: '#f1f3f8' } }, y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false } } }
    }
  });
}

// =======================================================================
//  DÍAS DE INVENTARIO = stock en cajas ÷ venta promedio diaria en cajas.
//  El servidor manda sede × producto; aquí se agrupa sumando stock y venta
//  por separado y recién se divide (nunca se promedian los días).
// =======================================================================
let DIAS_CFG = { nivel: 'producto', periodo: 30 };
// 'rotacion' = CantidadDS ÷ NDias del ERP (igual que el Excel Stock-DI); 'ventas' = venta de los últimos N días.
let FUENTE_DIAS = 'ventas';
const textoFuenteDias = () => FUENTE_DIAS === 'rotacion'
  ? 'Stock actual ÷ rotación diaria por almacén del ERP (CantidadDS ÷ NDias), igual que el reporte Stock-DI'
  : `Stock actual ÷ venta promedio diaria de los últimos ${DIAS_CFG.periodo} días con datos`;
const DIAS_NIVELES = [
  { k: 'total', l: 'Total', ic: 'badge-check' }, { k: 'sede', l: 'Sede', ic: 'building-2' },
  { k: 'categoria', l: 'Categoría', ic: 'tags' }, { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash' },
  { k: 'producto', l: 'Producto', ic: 'package' },
];
const UMBRAL = { bajo: 10, alto: 45 };
const estadoDias = d => d == null ? 'gris' : d < UMBRAL.bajo ? 'bad' : d > UMBRAL.alto ? 'warn' : 'ok';
const TXT_ESTADO = { bad: 'Riesgo de quiebre', ok: 'Saludable', warn: 'Sobrestock', gris: 'Sin venta' };
const COLOR_ESTADO = { bad: '#e5484d', ok: '#12a37a', warn: '#e08a0b', gris: '#94a3b8' };
function semaforo(d) {
  const e = estadoDias(d);
  return `<span class="tag" style="background:${COLOR_ESTADO[e]}18;color:${COLOR_ESTADO[e]}"><span class="dot ${e}"></span>${d == null ? '—' : fmt(d) + ' días'}</span>`;
}
function agruparDias(filas, nivel) {
  const grupos = new Map();
  filas.forEach(f => {
    const clave = nivel === 'total' ? 'Total marca' : nivel === 'producto' ? f.codigo_producto : f[nivel];
    const g = grupos.get(clave) || { clave, descripcion: nivel === 'producto' ? (f.descripcion || '') : '', categoria: f.categoria, stock: 0, valor: 0, venta: 0 };
    g.stock += f.stock_cajas; g.valor += f.valor_stock; g.venta += f.venta_diaria;
    g.unid = (g.unid || 0) + (f.stock_unidades || 0);
    g.factor = g.factor === undefined ? f.factor : (g.factor === f.factor ? g.factor : null);
    grupos.set(clave, g);
  });
  // "SIN SEDE" sin stock son ventas sin sucursal: no es un quiebre real.
  return [...grupos.values()].filter(g => !(SIN_DATO.test(g.clave) && g.stock <= 0))
    // Redondeo a 6 decimales: quita el ruido de la división (26.4999999999 -> 26.5)
    // para que al mostrar en enteros salga igual que el REDONDEAR del Excel.
    .map(g => ({ ...g, dias: g.venta > 0 ? Math.round(g.stock / g.venta * 1e6) / 1e6 : null }))
    .sort((a, b) => (a.dias ?? Infinity) - (b.dias ?? Infinity));
}

// =======================================================================
//  DESCARGAS
// =======================================================================
let PAQ_SEL = { ventas: true, stock: true };
const COLS_VENTAS = ['nro_documento', 'fecha_documento', 'codigo_cliente', 'canal', 'tipo_negocio', 'sede', 'distrito', 'jefe_ventas', 'supervisor', 'nombre_vendedor', 'codigo_vendedor', 'ruta', 'linea', 'marca', 'categoria', 'codigo_proveedor', 'codigo_producto', 'descripcion_producto', 'cantidad_unidad_minima', 'tipo_unidad_minima', 'cantidad_unidad_maxima', 'tipo_unidad_maxima', 'importe_neto_sin_impuesto', 'importe_neto_con_impuesto'];
const COLS_STOCK = ['codigo_almacen', 'nombre_almacen', 'codigo_proveedor', 'codigo_producto', 'linea', 'marca', 'categoria', 'producto_descripcion', 'lote', 'stock_unidad_minima', 'unidad_medida_minima', 'stock_unidades_maximas', 'unidad_medida_maxima', 'factor', 'stock_cajas_unidades', 'valor_stock', 'periodo'];

async function vistaPaquete() {
  const nada = !PAQ_SEL.ventas && !PAQ_SEL.stock;
  const pkg = (k, ic, tono, titulo, desc, cols) => `<div class="pkgcard ${PAQ_SEL[k] ? 'on' : ''}" onclick="PAQ_SEL.${k}=!PAQ_SEL.${k};render()">
      <div class="kpi-ic ${tono}">${icon(ic)}</div>
      <div><b>${titulo}</b><span>${desc}</span><div class="cols">${cols.map(c => `<code>${c}</code>`).join('')}</div></div>
      <div class="chk">${PAQ_SEL[k] ? icon('check') : ''}</div></div>`;
  document.getElementById('view').innerHTML = `
    ${nota(`Ventas se descarga de <b>${etiquetaPeriodo(FECHAS.ini, FECHAS.fin)}</b> (cámbialo arriba). Los meses del año anterior traen solo las columnas que se guardan de ese año. ${hayFiltros() ? 'Los <b>filtros activos</b> también se aplican a la descarga.' : 'Sin filtros: se descarga todo.'} Stock siempre es la foto más reciente.`, 'calendar-check')}
    <div class="pkg">
      ${pkg('ventas', 'receipt-text', 't-red', 'Ventas', 'Detalle por documento y producto, con sede, distrito, categoría y código proveedor.', COLS_VENTAS)}
      ${pkg('stock', 'warehouse', 't-blue', 'Stock', 'Foto del inventario por almacén y lote, con categoría, código proveedor y factor.', COLS_STOCK)}
    </div>
    <div style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap">
      <button class="btn btn-ac" id="btnDesc" ${nada ? 'disabled' : ''} onclick="descargarPaquete()">${icon('download')}Descargar ${PAQ_SEL.ventas && PAQ_SEL.stock ? 'ZIP (2 archivos CSV)' : 'CSV'}</button>
      <span style="color:var(--mut);font-size:.8rem">Archivos CSV en UTF-8, se abren directo en Excel. Los rangos largos pueden tardar unos minutos.</span>
    </div>`;
}
function descargarPaquete() {
  const b = document.getElementById('btnDesc');
  b.disabled = true; b.innerHTML = '<span class="spinner"></span>Preparando archivo…';
  setTimeout(() => { b.disabled = false; b.innerHTML = `${icon('download')}Descargar de nuevo`; icons(); }, 6000);
  location.href = '/api/exportar.csv' + qs({ ventas: PAQ_SEL.ventas ? 1 : 0, stock: PAQ_SEL.stock ? 1 : 0 });
}

boot();
