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
  { id: 'inventario', label: 'Inventario', ic: 'warehouse', sub: 'Foto del stock, sincronizada cada hora' },
  { id: 'dias', label: 'Días de inventario', ic: 'hourglass', sub: 'Cuántos días alcanza el stock con la venta actual', nuevo: true },
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
  { k: 'linea', l: 'Línea', ic: 'layers', stock: true },
  { k: 'marca', l: 'Marca', ic: 'award', stock: true },
  { k: 'categoria', l: 'Categoría', ic: 'tags', stock: true, falta: 'Completa la categoría en la tabla productos de Supabase.' },
  { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash', stock: true, falta: 'Completa el código proveedor en la tabla productos de Supabase.' },
  { k: 'codigo_producto', l: 'Producto', ic: 'package', stock: true },
];
const FILTRO_DEF = Object.fromEntries(FILTROS.map(f => [f.k, f]));
const SIN_DATO = /^SIN /;

let TAB = 'resumen';
let RANGO = { min: null, max: null };
let FECHAS = { ini: null, fin: null, preset: 'todo' };
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
  { k: 'mes', l: 'Este mes' }, { k: 'mesant', l: 'Mes anterior' }, { k: '30d', l: '30 días' },
  { k: '90d', l: '90 días' }, { k: 'anio', l: 'Año' }, { k: 'todo', l: 'Todo' },
];
function aplicarPreset(k) {
  const fin = RANGO.max, y = fin.slice(0, 4), m = fin.slice(5, 7);
  const recorta = d => (d < RANGO.min ? RANGO.min : d);
  let ini = RANGO.min, hasta = fin;
  if (k === 'mes') ini = `${y}-${m}-01`;
  if (k === 'mesant') { ini = ISO(new Date(Date.UTC(+y, +m - 2, 1))); hasta = addDays(`${y}-${m}-01`, -1); }
  if (k === '30d') ini = addDays(fin, -29);
  if (k === '90d') ini = addDays(fin, -89);
  if (k === 'anio') ini = `${y}-01-01`;
  FECHAS = { ini: recorta(ini), fin: hasta, preset: k };
  render();
}
function cambiarFecha(campo, valor) {
  if (!valor) return;
  FECHAS[campo] = valor; FECHAS.preset = null;
  if (FECHAS.ini > FECHAS.fin) [FECHAS.ini, FECHAS.fin] = [FECHAS.fin, FECHAS.ini];
  render();
}

function opcionesDe(k) {
  if (k === 'codigo_producto') return (OPC.codigo_producto || []).map(o => ({ v: o.valor, t: o.etiqueta || o.valor, s: o.valor }));
  return (OPC[k] || []).map(v => ({ v, t: v }));
}

function renderFiltros() {
  const tabStock = TAB === 'inventario' || TAB === 'dias';
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
        <input type="date" value="${FECHAS.ini}" min="${RANGO.min}" max="${RANGO.max}" onchange="cambiarFecha('ini', this.value)">
        <span>→</span>
        <input type="date" value="${FECHAS.fin}" min="${RANGO.min}" max="${RANGO.max}" onchange="cambiarFecha('fin', this.value)">
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
  const vistas = { resumen: vistaResumen, ventas: vistaVentas, inventario: vistaInventario, dias: vistaDias, paquete: vistaPaquete };
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

// Período de comparación (mismo criterio que hallazgos.periodo_anterior):
// - Mes en curso (desde el día 1, dentro de un mismo mes): mismos días del mes
//   anterior. 1–2 nov se compara con 1–2 oct, no con 30–31 oct.
// - Cualquier otro rango: los mismos días inmediatamente anteriores.
function rangoAnterior(ini, fin) {
  const dias = Math.round((new Date(fin) - new Date(ini)) / 864e5) + 1;
  if (ini.slice(8) === '01' && ini.slice(0, 7) === fin.slice(0, 7)) {
    const [y, m] = ini.split('-').map(Number);
    const inicioAnt = ISO(new Date(Date.UTC(y, m - 2, 1)));
    const ultimoAnt = addDays(ini, -1);                       // último día del mes anterior
    const finAnt = inicioAnt.slice(0, 8) + fin.slice(8);
    return { ini: inicioAnt, fin: finAnt > ultimoAnt ? ultimoAnt : finAnt, dias, mismoTramo: true };
  }
  const finAnt = addDays(ini, -1);
  return { ini: addDays(finAnt, -(dias - 1)), fin: finAnt, dias };
}
const delta = (a, b) => (b ? ((a - b) / b) * 100 : null);

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
  if (a.tab === 'dias') DIAS_CFG.nivel = a.nivel || 'producto';
  goTo(a.tab);
}

async function cargarHallazgos(vigente, promesa) {
  const d = await promesa;
  const caja = document.getElementById('hz');
  if (!vigente() || !caja) return;
  if (!d) { caja.innerHTML = ''; return; }
  HZ_ACCIONES = [];
  const texto = d.resumen.map(s => s.e === 'b' ? `<b>${esc(s.t)}</b>` : s.e ? `<span class="${s.e}">${esc(s.t)}</span>` : esc(s.t)).join('');
  const items = d.hallazgos.map(h => {
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
  }).join('');
  caja.innerHTML = `<div class="card hz">
    <div class="hz-head"><span class="ic">${icon('sparkles')}</span>
      <div style="flex:1"><h3>Hallazgos del período</h3><small>${fechaCorta(d.periodo.desde)} al ${fechaCorta(d.periodo.hasta)} · comparado con ${fechaCorta(d.periodo.ant_desde)} al ${fechaCorta(d.periodo.ant_hasta)}${hayFiltros() ? ' · con tus filtros' : ''}</small></div>
      ${d.alertas ? `<span class="tag t-red">${d.alertas} alerta${d.alertas > 1 ? 's' : ''}</span>` : '<span class="tag t-green">Sin alertas</span>'}</div>
    <p class="hz-txt">${texto}</p>
    <div class="hz-list">${items || '<div class="sub">No hay cambios relevantes en este período.</div>'}</div>
    <div class="hz-foot">${icon('info')}Generado automáticamente con reglas sobre tus datos reales. Toca cada hallazgo para ver el detalle.</div></div>`;
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

// =======================================================================
//  RESUMEN
// =======================================================================
async function vistaResumen(vigente) {
  document.getElementById('view').innerHTML = skKpis(8) + skCharts() + skCharts('g-2');
  const hzPromesa = api('/api/hallazgos' + qs()).catch(() => null);
  const ant = rangoAnterior(FECHAS.ini, FECHAS.fin);
  const historia = qs({ desde: RANGO.min, hasta: RANGO.max }, { fechas: false });
  const [r, rAnt, mes, semana, canal, dia, prod, sede, cat, diasInv] = await Promise.all([
    api('/api/resumen' + qs()),
    api('/api/resumen' + qs({ desde: ant.ini, hasta: ant.fin }, { fechas: false })).catch(() => null),
    api('/api/agrupado/mes' + historia),
    api('/api/agrupado/semana' + qs()),
    api('/api/agrupado/canal' + qs()),
    api('/api/agrupado/dia_semana' + qs()),
    api('/api/agrupado/codigo_producto' + qs({ top: 10 })),
    api('/api/agrupado/sede' + qs()),
    api('/api/agrupado/categoria' + qs()),
    api('/api/dias_inventario' + qs({ dias: DIAS_CFG.periodo }, { fechas: false, soloStock: true })).catch(() => []),
  ]);
  const a = rAnt || {};
  if (diasInv.length) FUENTE_DIAS = diasInv[0].fuente;
  const totalDias = agruparDias(diasInv, 'total')[0];
  const diasStock = totalDias && r.cajas_stock > 0 ? totalDias.dias : null;
  const vsTxt = `vs ${fechaCorta(ant.ini)} – ${fechaCorta(ant.fin)}`;

  const ok = pintar(vigente, `
    <div id="hz"><div class="sk" style="height:230px;border-radius:16px;margin-bottom:1rem"></div></div>
    ${avisoDatosNuevos()}
    <div class="grid g-kpi">
      ${kpi('Venta neta s/IGV', moneyC(r.venta_neta), vsTxt, { ic: 'banknote', hero: true, delta: delta(r.venta_neta, a.venta_neta) })}
      ${kpi('Cobertura', fmt(r.cobertura), 'clientes con compra', { ic: 'users-round', tono: 't-blue', delta: delta(r.cobertura, a.cobertura) })}
      ${kpi('Cajas vendidas', fmt(r.cajas), `${fmt1(r.cajas_diarias)} cajas por día`, { ic: 'boxes', tono: 't-green', delta: delta(r.cajas, a.cajas) })}
      ${kpi('Documentos', fmt(r.documentos), 'boletas y facturas', { ic: 'receipt-text', tono: 't-violet', delta: delta(r.documentos, a.documentos) })}
      ${kpi('Ticket promedio', money(r.ticket_documento), 'venta ÷ documentos', { ic: 'ticket', tono: 't-amber', delta: delta(r.ticket_documento, a.ticket_documento) })}
      ${kpi('Venta por cliente', money(r.venta_por_cliente), 'venta ÷ cobertura', { ic: 'user-round-check', tono: 't-cyan', delta: delta(r.venta_por_cliente, a.venta_por_cliente) })}
      ${kpi('Inventario', moneyC(r.valor_stock), `${fmt(r.cajas_stock)} cajas · ${r.skus_con_stock} SKUs`, { ic: 'warehouse', tono: 't-slate' })}
      ${kpi('Días de inventario', diasStock == null ? '—' : fmt(diasStock), FUENTE_DIAS === 'rotacion' ? 'stock ÷ rotación diaria por almacén' : 'stock ÷ venta diaria', { ic: 'hourglass', tono: diasStock != null && diasStock < 10 ? 't-red' : 't-green' })}
    </div>
    <div class="grid g-21">
      ${card('Tendencia mensual', chWrap('c_mes', 'lg'), { ic: 'chart-line', sub: 'Venta y cobertura de todo el historial disponible', tono: 't-red' })}
      ${card('Mix por canal', chWrap('c_canal', 'lg'), { ic: 'chart-pie', sub: 'Participación por canal', tono: 't-blue', extra: segMetrica('MIX_CANAL', MIX_CANAL, 'dibujarCanal()') })}
    </div>
    <div class="grid g-21">
      ${card('Venta semanal', chWrap('c_sem'), { ic: 'calendar-range', sub: 'Semanas dentro del período filtrado', tono: 't-green' })}
      ${card('Venta por día de la semana', chWrap('c_dia'), { ic: 'calendar-days', sub: 'Qué días se vende más', tono: 't-amber' })}
    </div>
    <div class="grid g-21">
      ${card('Top 10 productos', table(
        [{ h: '#', f: v => `<span class="rank">${v}</span>` }, { h: 'Producto', f: v => v }, { h: 'Venta', n: 1, f: money }, { h: 'Part.', f: v => barra(v) }, { h: 'Cajas', n: 1, f: fmt }, { h: 'Clientes', n: 1, f: fmt }],
        prod.map((p, i) => [i + 1, `<b>${esc(p.descripcion)}</b><span class="muted">${esc(p.clave)}</span>`, p.venta, pct(p.venta, r.venta_neta), p.cajas, p.cobertura])
      ), { ic: 'trophy', sub: 'Por venta neta en el período', tono: 't-amber' })}
      <div style="display:grid;gap:1rem">
        ${card('Venta por sede', chWrap('c_sede', 'sm'), { ic: 'building-2', tono: 't-violet' })}
        ${card('Venta por categoría', chWrap('c_cat', 'sm'), { ic: 'tags', tono: 't-cyan' })}
      </div>
    </div>`);
  if (!ok) return;
  cargarHallazgos(vigente, hzPromesa);

  chart('c_mes', {
    data: {
      labels: mes.map(m => mesLabel(m.clave)), datasets: [
        { type: 'bar', label: 'Venta S/', data: mes.map(m => Math.round(m.venta)), backgroundColor: mes.map(m => (m.clave >= FECHAS.ini.slice(0, 7) && m.clave <= FECHAS.fin.slice(0, 7)) ? PAL[0] : '#f6b3b7'), borderRadius: 8, yAxisID: 'y', order: 2 },
        { type: 'line', label: 'Clientes', data: mes.map(m => m.cobertura), borderColor: PAL[1], backgroundColor: PAL[1], tension: .35, pointRadius: 3, yAxisID: 'y1', order: 1 }]
    },
    options: { interaction: { mode: 'index', intersect: false }, scales: { y: { ticks: tickMoney }, y1: { position: 'right', grid: { display: false }, ticks: { callback: v => compact(v) } }, x: { grid: { display: false } } } }
  });
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
  barrasH('c_sede', sede.slice(0, 8).map(s => s.clave), sede.slice(0, 8).map(s => Math.round(s.venta)), { color: PAL[4] });
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
  { k: 'linea', l: 'Línea', ic: 'layers' },
  { k: 'marca', l: 'Marca', ic: 'award' },
  { k: 'categoria', l: 'Categoría', ic: 'tags' },
  { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash' },
  { k: 'codigo_producto', l: 'Producto', ic: 'package' },
];
let EXP = { dim: 'canal', orden: 'venta', top: 25 };

async function vistaVentas(vigente) {
  const d = DIMENSIONES.find(x => x.k === EXP.dim);
  const cabecera = `<div class="pagehead"><div><h2>Venta por ${d.l.toLowerCase()}</h2><div class="sub">${fechaCorta(FECHAS.ini)} al ${fechaCorta(FECHAS.fin)} ${FECHAS.fin.slice(0, 4)}${hayFiltros() ? ' · con filtros aplicados' : ''}</div></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <select class="sel" onchange="EXP.orden=this.value;render()">${[['venta', 'Ordenar por venta'], ['cobertura', 'Ordenar por clientes'], ['cajas', 'Ordenar por cajas']].map(([k, l]) => `<option value="${k}" ${EXP.orden === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="sel" onchange="EXP.top=+this.value;render()">${[10, 25, 50, 0].map(n => `<option value="${n}" ${EXP.top === n ? 'selected' : ''}>${n ? 'Top ' + n : 'Todos'}</option>`).join('')}</select>
      </div></div>
    <div style="margin-bottom:1rem"><div class="seg">${DIMENSIONES.map(x => `<button class="${x.k === EXP.dim ? 'on' : ''}" onclick="EXP.dim='${x.k}';render()">${icon(x.ic)}${x.l}</button>`).join('')}</div></div>`;
  document.getElementById('view').innerHTML = cabecera + skKpis(4) + skCharts();
  icons();

  const [r, filas, mes] = await Promise.all([
    api('/api/resumen' + qs()),
    api(`/api/agrupado/${EXP.dim}` + qs({ orden: EXP.orden, top: EXP.top || null })),
    api('/api/agrupado/mes' + qs({ desde: RANGO.min, hasta: RANGO.max }, { fechas: false })),
  ]);
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
      ${kpi('Con venta en el período', fmt(filas.length) + (EXP.top && filas.length === EXP.top ? '+' : ''), EXP.top ? `mostrando top ${EXP.top}` : d.l.toLowerCase(), { ic: d.ic, tono: 't-blue' })}
    </div>
    ${card('Venta histórica mensual', chWrap('c_hist'), { ic: 'chart-column-big', sub: `Soles y coberturas de todo el historial${hayFiltros() ? ', con tus filtros' : ''}`, tono: 't-green' })}
    <div class="grid g-21">
      ${card(`Ranking por ${d.l.toLowerCase()}`, chWrap('c_rank', 'lg'), { ic: 'chart-bar-big', sub: `Primeros 15, en ${enClientes ? 'clientes (cobertura)' : EXP.orden === 'cajas' ? 'cajas' : 'soles'}`, tono: 't-red', extra: segMetrica('EXP.orden', EXP.orden, 'render()') })}
      ${card('Participación', chWrap('c_part', 'lg'), { ic: 'chart-pie', sub: enClientes ? 'En los clientes' : 'En la venta neta', tono: 't-blue' })}
    </div>
    ${card('Detalle', table(
      [{ h: '#', f: v => `<span class="rank">${v}</span>` }, { h: d.l, f: v => v }, { h: 'Venta', n: 1, f: money }, { h: 'Participación', f: v => `<div style="display:flex;gap:.5rem;align-items:center">${barra(v)}<small>${fmt1(v)}%</small></div>` }, { h: 'Cajas', n: 1, f: fmt }, { h: 'Clientes', n: 1, f: fmt }, { h: 'Venta / cliente', n: 1, f: money }],
      filas.map((f, i) => [i + 1, es ? `<b>${esc(f.descripcion)}</b><span class="muted">${esc(f.clave)}</span>` : `<b>${esc(f.clave)}</b>`, f.venta, pct(f.venta, r.venta_neta), f.cajas, f.cobertura, f.cobertura ? f.venta / f.cobertura : 0])
    ), { ic: 'table-2', sub: `${filas.length} filas`, tono: 't-slate' })}`);
  if (!ok) return;

  const top15 = filas.slice(0, 15);
  const valor = f => EXP.orden === 'cobertura' ? f.cobertura : EXP.orden === 'cajas' ? Math.round(f.cajas) : Math.round(f.venta);
  barrasH('c_rank', top15.map(f => String(nombre(f)).slice(0, 30)), top15.map(valor),
    { fmtV: EXP.orden === 'venta' ? money : enClientes ? v => fmt(v) + ' clientes' : v => fmt(v) + ' cajas', color: enClientes ? PAL[1] : PAL[0] });
  const part = topMasOtros(filas.map(f => ({ clave: String(nombre(f)).slice(0, 26), venta: f[metrica] })));
  dona('c_part', part.map(p => p.clave), part.map(p => Math.round(p.venta)),
    enClientes ? fmt(r.cobertura) : moneyC(r.venta_neta), enClientes ? 'clientes únicos' : 'venta total',
    enClientes ? v => fmt(v) + ' clientes' : money);

  // Barras agrupadas: soles (eje izquierdo) y clientes (eje derecho) por mes.
  const enRango = m => m.clave >= FECHAS.ini.slice(0, 7) && m.clave <= FECHAS.fin.slice(0, 7);
  chart('c_hist', {
    type: 'bar',
    data: {
      labels: mes.map(m => mesLabel(m.clave)), datasets: [
        { label: 'Venta S/', data: mes.map(m => Math.round(m.venta)), backgroundColor: mes.map(m => enRango(m) ? PAL[0] : '#f6b3b7'), borderRadius: 6, yAxisID: 'y' },
        { label: 'Clientes (cobertura)', data: mes.map(m => m.cobertura), backgroundColor: mes.map(m => enRango(m) ? PAL[1] : '#b9cdf7'), borderRadius: 6, yAxisID: 'y1' }]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: c => c.datasetIndex === 0 ? ` Venta: ${money(c.raw)}` : ` Clientes: ${fmt(c.raw)}` } } },
      scales: { y: { ticks: tickMoney, title: { display: true, text: 'Soles' } }, y1: { position: 'right', grid: { display: false }, ticks: { callback: v => compact(v) }, title: { display: true, text: 'Clientes' } }, x: { grid: { display: false } } }
    }
  });
}

// =======================================================================
//  INVENTARIO
// =======================================================================
let INV_NIVEL = 'sede';
let INV_DIAS = [];
function tablaDiasInventario() {
  const caja = document.getElementById('invDias');
  if (!caja) return;
  const niveles = DIAS_NIVELES.filter(n => ['sede', 'linea', 'categoria', 'producto'].includes(n.k));
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
  caja.innerHTML = card('Días de inventario', `
    ${table(cols, rows)}
    <p class="legend" style="margin:.8rem 0 0"><span><span class="dot bad"></span>menos de ${UMBRAL.bajo} días: riesgo de quiebre</span><span><span class="dot ok"></span>${UMBRAL.bajo} a ${UMBRAL.alto} días: saludable</span><span><span class="dot warn"></span>más de ${UMBRAL.alto} días: sobrestock</span><span><span class="dot gris"></span>sin venta</span></p>`,
    { ic: 'hourglass', sub: textoFuenteDias(), tono: 't-amber', extra: seg });
  icons();
}

async function vistaInventario(vigente) {
  document.getElementById('view').innerHTML = skKpis(5) + skCharts('g-2');
  const [s, dias] = await Promise.all([
    api('/api/stock' + qs({}, { fechas: false, soloStock: true })),
    api('/api/dias_inventario' + qs({ dias: DIAS_CFG.periodo }, { fechas: false, soloStock: true })),
  ]);
  INV_DIAS = dias;
  if (dias.length) FUENTE_DIAS = dias[0].fuente;
  const total = agruparDias(dias, 'total')[0] || { dias: null, venta: 0 };
  const ignorados = Object.keys(SEL).filter(k => !FILTRO_DEF[k].stock).map(k => FILTRO_DEF[k].l);
  const sinStockSede = (SEL.sede || []).length && !s.cajas_stock;
  const ok = pintar(vigente, `
    ${ignorados.length ? nota(`El inventario no se divide por ${ignorados.join(', ').toLowerCase()}: esos filtros solo aplican a las ventas.`, 'info') : ''}
    ${sinStockSede ? nota('Todavía no hay stock asociado a esta sede: falta asignar la sede de cada almacén.', 'triangle-alert', 'warn') : ''}
    <div class="grid g-kpi">
      ${kpi('Valor de inventario', moneyC(s.valor_stock), 'a costo', { ic: 'banknote', hero: true })}
      ${kpi('Cajas en stock', fmt(s.cajas_stock), 'unidad máxima', { ic: 'boxes', tono: 't-green' })}
      ${kpi('Días de inventario', total.dias == null || !s.cajas_stock ? '—' : fmt(total.dias), `stock ÷ ${fmt1(total.venta)} cajas/día`, { ic: 'hourglass', tono: total.dias != null && total.dias < UMBRAL.bajo ? 't-red' : 't-amber' })}
      ${kpi('SKUs con stock', fmt(s.skus_con_stock), `de ${s.por_producto.length} productos`, { ic: 'package-check', tono: 't-blue' })}
      ${kpi('Almacenes', fmt(s.almacenes), 'con stock reportado', { ic: 'warehouse', tono: 't-violet' })}
    </div>
    <div class="grid g-2">
      ${card('Valor por almacén', chWrap('c_alm'), { ic: 'warehouse', tono: 't-red' })}
      ${card('Valor por categoría', chWrap('c_icat'), { ic: 'tags', tono: 't-cyan' })}
    </div>
    <div id="invDias" style="margin-bottom:1rem"></div>
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
  { k: 'linea', l: 'Línea', ic: 'layers' }, { k: 'categoria', l: 'Categoría', ic: 'tags' }, { k: 'codigo_proveedor', l: 'Código proveedor', ic: 'hash' },
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

async function vistaDias(vigente) {
  const cabecera = () => `<div class="pagehead"><div><h2>Días de inventario</h2><div class="sub">${textoFuenteDias()}</div></div>
      ${FUENTE_DIAS === 'rotacion' ? '' : `<select class="sel" onchange="DIAS_CFG.periodo=+this.value;render()">${[7, 15, 30, 60, 90].map(d => `<option value="${d}" ${d === DIAS_CFG.periodo ? 'selected' : ''}>Venta de los últimos ${d} días</option>`).join('')}</select>`}</div>
    <div style="margin-bottom:1rem"><div class="seg">${DIAS_NIVELES.map(n => `<button class="${n.k === DIAS_CFG.nivel ? 'on' : ''}" onclick="DIAS_CFG.nivel='${n.k}';render()">${icon(n.ic)}Por ${n.l.toLowerCase()}</button>`).join('')}</div></div>`;
  document.getElementById('view').innerHTML = cabecera() + skKpis(4) + skCharts('g-2', 1);
  icons();

  const filas = await api('/api/dias_inventario' + qs({ dias: DIAS_CFG.periodo }, { fechas: false, soloStock: true }));
  if (filas.length) FUENTE_DIAS = filas[0].fuente;
  const total = agruparDias(filas, 'total')[0] || { stock: 0, venta: 0, valor: 0, dias: null };
  const productos = agruparDias(filas, 'producto');
  const grupos = agruparDias(filas, DIAS_CFG.nivel);
  const cuenta = e => productos.filter(p => estadoDias(p.dias) === e).length;
  const nivel = DIAS_NIVELES.find(n => n.k === DIAS_CFG.nivel);
  const esProd = DIAS_CFG.nivel === 'producto';

  const cols = [{ h: nivel.l, f: v => v }];
  if (esProd) cols.push({ h: 'Categoría' });
  cols.push({ h: 'Stock', n: 1, f: stockCaja }, { h: 'Valor stock', n: 1, f: money }, { h: 'Venta diaria (cajas)', n: 1, f: fmt1 }, { h: 'Días de inventario', n: 1, f: semaforo }, { h: 'Estado', f: v => `<span style="color:${COLOR_ESTADO[v]};font-weight:600">${TXT_ESTADO[v]}</span>` });
  const rows = grupos.map(g => {
    const r = [esProd ? `<b>${esc(g.descripcion || g.clave)}</b><span class="muted">${esc(g.clave)}</span>` : `<b>${esc(g.clave)}</b>`];
    if (esProd) r.push(g.categoria);
    r.push({ c: g.stock, u: g.unid, f: g.factor }, g.valor, g.venta, g.dias, estadoDias(g.dias));
    return r;
  });

  const ok = pintar(vigente, cabecera() + `
    ${['sede', 'categoria', 'codigo_proveedor'].includes(DIAS_CFG.nivel) ? avisoDatosNuevos() : ''}
    <div class="grid g-kpi">
      ${kpi('Días de inventario de la marca', total.dias == null ? '—' : fmt(total.dias), `${fmt(total.stock)} cajas ÷ ${fmt1(total.venta)} cajas/día`, { ic: 'hourglass', hero: true })}
      ${kpi('Riesgo de quiebre', fmt(cuenta('bad')), `productos con menos de ${UMBRAL.bajo} días`, { ic: 'triangle-alert', tono: 't-red' })}
      ${kpi('Saludables', fmt(cuenta('ok')), `entre ${UMBRAL.bajo} y ${UMBRAL.alto} días`, { ic: 'circle-check-big', tono: 't-green' })}
      ${kpi('Sobrestock', fmt(cuenta('warn')), `más de ${UMBRAL.alto} días · ${fmt(cuenta('gris'))} sin venta`, { ic: 'archive', tono: 't-amber' })}
    </div>
    ${DIAS_CFG.nivel === 'total' ? '' : card(`Días de inventario por ${nivel.l.toLowerCase()}`, chWrap('c_dias', 'lg'), { ic: 'chart-bar-big', sub: 'De menor a mayor cobertura', tono: 't-red', extra: `<div class="legend"><span><span class="dot bad"></span>&lt; ${UMBRAL.bajo} días</span><span><span class="dot ok"></span>${UMBRAL.bajo}–${UMBRAL.alto}</span><span><span class="dot warn"></span>&gt; ${UMBRAL.alto}</span></div>` })}
    ${card('Detalle', table(cols, rows), { ic: 'table-2', sub: `${grupos.length} filas`, tono: 't-slate' })}`);
  if (!ok || DIAS_CFG.nivel === 'total') return;
  const top = grupos.filter(g => g.dias != null).slice(0, 25);
  barrasH('c_dias', top.map(g => String(esProd ? (g.descripcion || g.clave) : g.clave).slice(0, 30)), top.map(g => Math.round(g.dias)),
    { colores: top.map(g => COLOR_ESTADO[estadoDias(g.dias)]), fmtV: v => fmt(v) + ' días' });
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
    ${nota(`Ventas se descarga del <b>${fechaCorta(FECHAS.ini)} al ${fechaCorta(FECHAS.fin)} ${FECHAS.fin.slice(0, 4)}</b> (cámbialo arriba). ${hayFiltros() ? 'Los <b>filtros activos</b> también se aplican a la descarga.' : 'Sin filtros: se descarga todo.'} Stock siempre es la foto más reciente.`, 'calendar-check')}
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
