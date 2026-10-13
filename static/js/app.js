/* =====================================================================
   app.js — capa de presentación únicamente.
   Todas las fórmulas (cobertura, sumas, etc.) ya vienen calculadas desde
   el servidor (ver medidas.py). Este archivo solo pide datos por fetch(),
   arma HTML y dibuja gráficos.
   ===================================================================== */
const fmt = n => Math.round(n || 0).toLocaleString('es-PE');
const money = n => 'S/ ' + fmt(n);
const card = (t, b) => `<div class="card"><h3>${t}</h3>${b}</div>`;
const chWrap = id => `<div class="ch"><canvas id="${id}"></canvas></div>`;
function kpi(l, v, s, opts = {}) {
  const delta = opts.delta != null ? `<span class="delta ${opts.delta >= 0 ? 'up' : 'down'}">${opts.delta >= 0 ? '▲' : '▼'} ${Math.abs(opts.delta).toFixed(1)}%</span>` : '';
  return `<div class="card kpi ${opts.hero ? 'hero' : ''}"><div class="lbl">${l}</div><div class="val">${v} ${delta}</div><div class="sub">${s}</div></div>`;
}
const PAL = ['#4f6ef7', '#17a673', '#e0960c', '#e5484d', '#0ea5e9', '#a855f7', '#64748b', '#0b1a3a'];
const CHARTS = {};
function chart(id, cfg) {
  if (CHARTS[id]) CHARTS[id].destroy();
  const el = document.getElementById(id); if (!el) return;
  const centerText = cfg._centerText, centerSub = cfg._centerSub;
  delete cfg._centerText; delete cfg._centerSub;
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }, cfg.options || {});
  const c = new Chart(el, cfg);
  c._centerText = centerText; c._centerSub = centerSub; // leídos por centerTextPlugin, no por cfg.config
  CHARTS[id] = c;
}
function table(cols, rows) {
  const head = cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.h}</th>`).join('');
  const body = rows.map(r => '<tr>' + r.map((v, i) => `<td class="${cols[i].n ? 'n' : ''}">${cols[i].f ? cols[i].f(v) : v}</td>`).join('') + '</tr>').join('');
  return `<div class="ov"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}


async function api(path) {
  const r = await fetch(path);

  if (r.status === 401) {
    location.href = '/login';
    throw new Error('Sesión no autenticada');
  }

  if (!r.ok) {
    const detalle = await r.text();

    throw new Error(
      `Error HTTP ${r.status} en ${path}: ${detalle.slice(0, 300)}`
    );
  }

  return r.json();
}


// Plugin de Chart.js para mostrar un total en el centro de una dona.
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(c) {
    if (!c._centerText) return;
    const { ctx, chartArea: { width, height, top, left } } = c;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 15px Inter'; ctx.fillStyle = '#1b2435';
    ctx.fillText(c._centerText, left + width / 2, top + height / 2 - 8);
    ctx.font = '500 10px Inter'; ctx.fillStyle = '#687187';
    ctx.fillText(c._centerSub || '', left + width / 2, top + height / 2 + 10);
    ctx.restore();
  }
};
Chart.register(centerTextPlugin);

const TABS = [
  { id: 'resumen', label: 'Resumen', ic: '📊' },
  { id: 'ventas', label: 'Ventas', ic: '🧾' },
  { id: 'inventario', label: 'Inventario', ic: '🏬' },
  { id: 'paquete', label: 'Paquete de Datos', ic: '⬇️' },
];
let TAB = 'resumen';
let RANGO = { min: null, max: null };
let FILTRO = { ini: null, fin: null };

function tiempoDesde(iso) {
  if (!iso) return 'sin datos aún';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso.replace(' ', 'T') + 'Z')) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 60 * 24) return `hace ${Math.round(mins / 60)} h`;
  return `hace ${Math.round(mins / 60 / 24)} d`;
}
function estadoFrescura(iso) {
  if (!iso) return 'gris';
  const horas = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z')) / 3600000;
  if (horas < 2) return 'ok';
  if (horas < 24) return 'warn';
  return 'bad';
}


async function boot() {
  try {
    const r = await api('/api/rango');

    RANGO = {
      min: r.desde || null,
      max: r.hasta || null
    };

    FILTRO = {
      ini: RANGO.min,
      fin: RANGO.max
    };

    const estado = estadoFrescura(r.ultima_sincronizacion);

    document.getElementById('topMeta').innerHTML =
      `<span class="dot ${estado}"></span> Datos sincronizados ` +
      `${tiempoDesde(r.ultima_sincronizacion)} ` +
      (RANGO.min && RANGO.max
        ? `· período disponible ${RANGO.min} al ${RANGO.max}`
        : '· sin datos cargados aún');

    document.getElementById('navLinks').innerHTML = TABS.map(t =>
      `<div class="navlink" data-id="${t.id}" ` +
      `onclick="goTo('${t.id}')">` +
      `<span class="ic">${t.ic}</span> ${t.label}</div>`
    ).join('');

    if (!RANGO.min || !RANGO.max) {
      document.getElementById('view').innerHTML = `
        <div class="card">
          <h3>No hay ventas disponibles</h3>
          <p>
            No se encontró un rango de fechas para este proveedor.
            Verifica que la sincronización haya cargado los datos en Supabase.
          </p>
        </div>
      `;

      return;
    }

    goTo('resumen');

  } catch (error) {
    console.error('Error al iniciar el portal:', error);

    document.getElementById('topMeta').textContent =
      'No se pudo consultar la información del proveedor.';

    document.getElementById('view').innerHTML = `
      <div class="card">
        <h3>No se pudo iniciar el portal</h3>
        <p>Verifica la conexión y vuelve a intentarlo.</p>
        <button class="btn btn-ac" onclick="boot()">
          Reintentar
        </button>
      </div>
    `;
  }
}


function goTo(id) { TAB = id; render(); }


async function render() {
  document.querySelectorAll('.navlink[data-id]').forEach(e =>
    e.classList.toggle('on', e.dataset.id === TAB)
  );

  const fns = {
    resumen: vistaResumen,
    ventas: vistaVentas,
    inventario: vistaInventario,
    paquete: vistaPaquete
  };

  const view = document.getElementById('view');

  view.innerHTML = '<div class="loading">Cargando…</div>';

  try {
    await fns[TAB]();
  } catch (error) {
    console.error('Error al cargar la sección:', TAB, error);

    view.innerHTML = `
      <div class="card">
        <h3>No se pudo cargar la información</h3>
        <p>Ocurrió un problema al consultar los datos.</p>
        <button class="btn btn-ac" onclick="render()">
          Reintentar
        </button>
      </div>
    `;
  }
}



function qs(extra = {}) {
  const p = new URLSearchParams();

  if (FILTRO.ini) {
    p.set('desde', FILTRO.ini);
  }

  if (FILTRO.fin) {
    p.set('hasta', FILTRO.fin);
  }

  Object.entries(extra).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      p.set(key, value);
    }
  });

  const query = p.toString();
  return query ? '?' + query : '';
}

function filtroFechasHtml(titulo) {
  return `<div class="pagehead"><div><h2>${titulo}</h2><div class="sub">Rango de fechas del período</div></div>
    <div style="display:flex;gap:.6rem;align-items:center">
      <input type="date" class="fld" style="margin:0;width:auto" value="${FILTRO.ini}" min="${RANGO.min}" max="${RANGO.max}" onchange="FILTRO.ini=this.value;render()">
      <span class="sub">a</span>
      <input type="date" class="fld" style="margin:0;width:auto" value="${FILTRO.fin}" min="${RANGO.min}" max="${RANGO.max}" onchange="FILTRO.fin=this.value;render()">
    </div></div>`;
}

// ---- Rango anterior, mismo número de días, para los deltas de KPI ----

function rangoAnterior(ini, fin) {
  // No calcular si no tenemos fechas válidas.
  if (!ini || !fin) {
    return { ini: null, fin: null };
  }

  const inicio = new Date(ini + 'T00:00:00Z');
  const final = new Date(fin + 'T00:00:00Z');

  if (
    Number.isNaN(inicio.getTime()) ||
    Number.isNaN(final.getTime()) ||
    inicio > final
  ) {
    return { ini: null, fin: null };
  }

  const dia = 86400000;
  const cantidadDias = Math.round((final - inicio) / dia) + 1;

  const finAnterior = new Date(inicio.getTime() - dia);
  const inicioAnterior = new Date(
    finAnterior.getTime() - (cantidadDias - 1) * dia
  );

  const formato = fecha => fecha.toISOString().slice(0, 10);

  return {
    ini: formato(inicioAnterior),
    fin: formato(finAnterior)
  };
}


function pctDelta(actual, previo) {
  if (!previo) return null;
  return ((actual - previo) / previo) * 100;
}

// =======================================================================
//  RESUMEN
// =======================================================================
async function vistaResumen() {
  const ant = rangoAnterior(FILTRO.ini, FILTRO.fin);

const consultaAnterior = ant.ini && ant.fin
  ? api(`/api/resumen?desde=${ant.ini}&hasta=${ant.fin}`).catch(error => {
      console.warn('No se pudo consultar el período anterior:', error);
      return null;
    })
  : Promise.resolve(null);

const [r, rAnt, semanal, canal] = await Promise.all([
  api('/api/resumen' + qs()),
  consultaAnterior,
  api('/api/semanal' + qs()),
  api('/api/agrupado/canal' + qs())
]);

  document.getElementById('view').innerHTML = filtroFechasHtml('Resumen') + `
    <div class="grid g-kpi">
      ${kpi('Cobertura (clientes únicos)', fmt(r.cobertura), 'distinct count de CodigoCliente', { hero: true, delta: pctDelta(r.cobertura, rAnt?.cobertura) })}
      ${kpi('Venta neta s/IGV', money(r.venta_neta), 'PEN', { delta: pctDelta(r.venta_neta, rAnt?.venta_neta) })}
      ${kpi('Cajas vendidas', fmt(r.cajas), 'unidad máxima')}
      ${kpi('Documentos', fmt(r.documentos), 'BO + FA, sin NC')}
      ${kpi('Ticket por documento', money(r.ticket_documento), 'venta ÷ documentos')}
      ${kpi('Valor de inventario', money(r.valor_stock), fmt(r.cajas_stock) + ' cajas en stock')}
    </div>
    <div class="grid g-2">
      ${card('Venta y cobertura por semana', chWrap('c_semana'))}
      ${card('Venta por canal', chWrap('c_canal'))}
    </div>
    <p class="sub" style="margin-top:-.6rem">Variación vs. los ${Math.round((new Date(FILTRO.fin) - new Date(FILTRO.ini)) / 864e5) + 1} días inmediatamente anteriores (${ant.ini} a ${ant.fin}).</p>`;
  chart('c_semana', { data: { labels: semanal.map(s => s.clave.slice(5)), datasets: [
    { type: 'line', label: 'Clientes únicos', data: semanal.map(s => s.cobertura), borderColor: PAL[0], backgroundColor: ctx => {
        const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 260); g.addColorStop(0, PAL[0] + '33'); g.addColorStop(1, PAL[0] + '00'); return g;
      }, fill: true, yAxisID: 'y', tension: .35, pointRadius: 3 },
    { type: 'bar', label: 'Venta S/', data: semanal.map(s => Math.round(s.venta)), backgroundColor: PAL[1] + '55', borderRadius: 6, yAxisID: 'y1' }
  ] }, options: { scales: { y1: { position: 'right', grid: { display: false } } } } });
  const totalCanal = canal.reduce((a, b) => a + b.venta, 0);
  chart('c_canal', { type: 'doughnut', data: { labels: canal.map(c => c.clave), datasets: [{ data: canal.map(c => Math.round(c.venta)), backgroundColor: PAL, borderWidth: 0, borderRadius: 4, spacing: 2 }] }, options: { cutout: '68%' }, _centerText: money(totalCanal), _centerSub: 'venta total' });
}

// =======================================================================
//  VENTAS
// =======================================================================
async function vistaVentas() {
  const [negocio, supervisor, productos] = await Promise.all([
    api('/api/agrupado/tipo_negocio' + qs({ top: 10 })),
    api('/api/agrupado/supervisor' + qs({ top: 15 })),
    api('/api/agrupado/codigo_producto' + qs({ top: 20 })),
  ]);
  document.getElementById('view').innerHTML = filtroFechasHtml('Ventas') + `
    <div class="grid g-2">
      ${card('Clientes únicos por tipo de negocio (top 10)', chWrap('c_negocio'))}
      ${card('Venta por supervisor (top 15)', chWrap('c_super'))}
    </div>
    ${card('Top 20 productos por clientes únicos', table(
      [{ h: 'Código' }, { h: 'Producto' }, { h: 'Clientes únicos', n: 1, f: fmt }, { h: 'Cajas', n: 1, f: fmt }, { h: 'Venta S/', n: 1, f: money }],
      productos.map(p => [p.clave, p.descripcion, p.cobertura, p.cajas, p.venta])
    ))}`;
  chart('c_negocio', { type: 'bar', data: { labels: negocio.map(n => n.clave), datasets: [{ label: 'Clientes únicos', data: negocio.map(n => n.cobertura), backgroundColor: PAL[0], borderRadius: 6 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
  chart('c_super', { type: 'bar', data: { labels: supervisor.map(s => s.clave), datasets: [{ label: 'Venta S/', data: supervisor.map(s => Math.round(s.venta)), backgroundColor: PAL[2], borderRadius: 6 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
}

// =======================================================================
//  INVENTARIO (no depende del rango de fechas: es una foto del stock)
// =======================================================================
async function vistaInventario() {
  const s = await api('/api/stock');
  const totalValor = s.por_almacen.reduce((a, b) => a + b.valor, 0);
  const totalCajas = s.por_almacen.reduce((a, b) => a + b.cajas, 0);
  document.getElementById('view').innerHTML = `
    <div class="pagehead"><div><h2>Inventario</h2><div class="sub">Foto del stock, sincronizada cada hora</div></div></div>
    <div class="grid g-kpi">
      ${kpi('Valor de inventario', money(totalValor), 'a costo', { hero: true })}
      ${kpi('Cajas en stock', fmt(totalCajas), s.por_producto.length + ' SKUs')}
      ${kpi('Almacenes', s.por_almacen.length, 'con stock reportado')}
    </div>
    <div class="grid g-2">
      ${card('Valor de stock por almacén', chWrap('c_almacen'))}
      ${card('Top 10 productos por valor de stock', chWrap('c_prod'))}
    </div>
    ${card('Detalle por producto', table(
      [{ h: 'Código' }, { h: 'Producto' }, { h: 'Cajas', n: 1, f: fmt }, { h: 'Valor S/', n: 1, f: money }],
      s.por_producto.map(p => [p.codigo_producto, p.producto_descripcion, p.cajas, p.valor])
    ))}`;
  chart('c_almacen', { type: 'bar', data: { labels: s.por_almacen.map(a => a.nombre_almacen), datasets: [{ label: 'Valor S/', data: s.por_almacen.map(a => Math.round(a.valor)), backgroundColor: PAL[0], borderRadius: 6 }] }, options: { plugins: { legend: { display: false } } } });
  const top = s.por_producto.slice(0, 10);
  chart('c_prod', { type: 'bar', data: { labels: top.map(p => (p.producto_descripcion || p.codigo_producto).slice(0, 24)), datasets: [{ label: 'Valor S/', data: top.map(p => Math.round(p.valor)), backgroundColor: PAL[2], borderRadius: 6 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
}

// =======================================================================
//  PAQUETE DE DATOS — tarjetas por reporte en vez de una lista de toggles.
//  El export trae TODAS las columnas de cada tabla, y Ventas ya sale
//  unificada (el servidor decide solo si necesita leer datos "viejos").
// =======================================================================
let PAQ_SEL = { ventas: true, stock: true };
function vistaPaquete() {
  document.getElementById('view').innerHTML = `
    <div class="pagehead"><div><h2>Paquete de Datos</h2><div class="sub">Descarga tus datos completos, en el rango que elijas</div></div></div>
    <div class="pd-range card">
      <div><label>Fecha Inicio</label><input type="date" class="fld" style="margin:0" id="pqIni" value="${FILTRO.ini}" min="${RANGO.min}" max="${RANGO.max}"></div>
      <div><label>Fecha Fin</label><input type="date" class="fld" style="margin:0" id="pqFin" value="${FILTRO.fin}" min="${RANGO.min}" max="${RANGO.max}"></div>
      <div class="sub" style="align-self:center">Aplica solo al reporte de Ventas — Stock siempre es la foto más reciente.</div>
    </div>
    <div class="grid g-2">
      <div class="pkgcard ${PAQ_SEL.ventas ? 'on' : ''}" onclick="pqToggle('ventas')">
        <div class="pkgcard-ic">🧾</div>
        <div class="pkgcard-body"><b>Ventas</b><span>Todas las columnas, histórico + actual ya unificados</span></div>
        <div class="pkgcard-check">${PAQ_SEL.ventas ? '✓' : ''}</div>
      </div>
      <div class="pkgcard ${PAQ_SEL.stock ? 'on' : ''}" onclick="pqToggle('stock')">
        <div class="pkgcard-ic">🏬</div>
        <div class="pkgcard-body"><b>Stock</b><span>Foto completa del inventario, todas las columnas</span></div>
        <div class="pkgcard-check">${PAQ_SEL.stock ? '✓' : ''}</div>
      </div>
    </div>
    <p><button class="btn btn-ac" ${(!PAQ_SEL.ventas && !PAQ_SEL.stock) ? 'disabled' : ''} onclick="descargarPaquete()">⬇ Descargar CSV</button></p>`;
}
function pqToggle(k) { PAQ_SEL[k] = !PAQ_SEL[k]; vistaPaquete(); }
function descargarPaquete() {
  const ini = document.getElementById('pqIni').value, fin = document.getElementById('pqFin').value;
  location.href = `/api/exportar.csv?desde=${ini}&hasta=${fin}&ventas=${PAQ_SEL.ventas ? 1 : 0}&stock=${PAQ_SEL.stock ? 1 : 0}`;
}

boot();
