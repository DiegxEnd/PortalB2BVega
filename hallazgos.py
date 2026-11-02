"""
hallazgos.py — "resumen inteligente" del portal, sin IA y sin costo.

Compara el período elegido con el inmediatamente anterior (misma cantidad de
días) y aplica reglas fijas sobre los números que ya calcula db.py: qué cambió,
qué lo explica y qué productos están en riesgo. Cada frase sale de un cálculo
real, así que nunca inventa cifras y los datos no salen del servidor.
"""
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

import db

LIMA = ZoneInfo("America/Lima")
UMBRAL_VARIACION = 3.0     # % mínimo para comentar un cambio
UMBRAL_QUIEBRE = 10        # días de inventario
UMBRAL_CRITICO = 3
UMBRAL_SOBRESTOCK = 45
DIAS_VENTA_INVENTARIO = 30

NOMBRE_DIM = {
    "canal": "el canal", "tipo_negocio": "el tipo de negocio", "jefe_ventas": "el jefe de ventas",
    "supervisor": "el supervisor", "sede": "la sede", "distrito": "el distrito",
    "categoria": "la categoría", "codigo_producto": "el producto", "linea": "la línea", "marca": "la marca",
}
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


# ---------------------------------------------------------------------------
#  Formatos
# ---------------------------------------------------------------------------
def _num(n, dec=0):
    texto = f"{n:,.{dec}f}"
    return texto


def _soles(n):
    a = abs(n)
    if a >= 1e6:
        return f"S/ {n / 1e6:,.1f} M"
    if a >= 1e4:
        return f"S/ {n / 1e3:,.1f} K"
    return f"S/ {n:,.0f}"


def _entero(n):
    """Redondeo como el REDONDEAR de Excel (0.5 hacia arriba), sin ruido de decimales."""
    return int(Decimal(str(round(n, 6))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _pct(n):
    return f"{abs(n):.1f}%"


def _fecha(iso):
    d = date.fromisoformat(iso)
    return f"{d.day} {MESES[d.month - 1]}"


def _var(actual, anterior):
    if not anterior:
        return None
    return (actual - anterior) / anterior * 100


def _hallazgo(tipo, icono, titulo, detalle, accion=None, prioridad=50):
    return {"tipo": tipo, "icono": icono, "titulo": titulo, "detalle": detalle,
            "accion": accion, "prioridad": prioridad}


# ---------------------------------------------------------------------------
#  Cálculo
# ---------------------------------------------------------------------------
def _dimensiones_con_datos(filas):
    """Descarta dimensiones que todavía no tienen datos (todo 'SIN ...')."""
    reales = {}
    for f in filas:
        if not str(f["clave"]).startswith("SIN "):
            reales.setdefault(f["dimension"], True)
    return {d for d in reales}


def _mayor_contribuyente(filas, dims, campo_act, campo_ant, signo):
    """Valor de dimensión que más empuja en la dirección del cambio total."""
    mejor = None
    for f in filas:
        if f["dimension"] not in dims:
            continue
        cambio = f[campo_act] - f[campo_ant]
        if signo * cambio <= 0:
            continue
        if mejor is None or abs(cambio) > abs(mejor["cambio"]):
            mejor = {**f, "cambio": cambio}
    return mejor


def _etiqueta(f):
    if f["dimension"] == "codigo_producto":
        return f.get("descripcion") or f["clave"]
    return f["clave"]


def calcular(proveedor, desde, hasta, filtros=()):
    hoy_desde, hoy_hasta = date.fromisoformat(desde), date.fromisoformat(hasta)
    dias = (hoy_hasta - hoy_desde).days + 1
    ant_hasta = hoy_desde - timedelta(days=1)
    ant_desde = ant_hasta - timedelta(days=dias - 1)
    ant_desde_s, ant_hasta_s = ant_desde.isoformat(), ant_hasta.isoformat()

    act = db.resumen_ventas(proveedor, desde, hasta, filtros)
    ant = db.resumen_ventas(proveedor, ant_desde_s, ant_hasta_s, filtros)
    filtros_stock = tuple(f for f in filtros if f[0] in db.FILTROS_STOCK)
    inventario = db.dias_inventario(proveedor, DIAS_VENTA_INVENTARIO, filtros_stock)
    variacion = db.variacion_por_dimension(proveedor, ant_desde_s, desde, hasta, filtros)
    ultima = db.ultima_sincronizacion(proveedor)

    hay_anterior = ant["venta_neta"] > 0
    # No se explica un cambio con la misma dimensión que el usuario filtró
    # ("la sede VEGA NORTE explica el 100%" no aporta nada).
    dims = _dimensiones_con_datos(variacion) - {campo for campo, _ in filtros}
    hallazgos = []
    texto = []          # segmentos del párrafo: {"t": texto, "e": "b"|"up"|"down"}

    def t(s, e=None):
        texto.append({"t": s, "e": e} if e else {"t": s})

    # --- Inventario por producto (suma stock y venta por separado, luego divide)
    productos = {}
    for f in inventario:
        p = productos.setdefault(f["codigo_producto"], {"desc": f["descripcion"] or f["codigo_producto"], "stock": 0.0, "venta": 0.0})
        p["stock"] += f["stock_cajas"]
        p["venta"] += f["venta_diaria"]
    usa_rotacion = bool(inventario) and inventario[0].get("fuente") == "rotacion"
    fuente_venta = "rotación del ERP por almacén" if usa_rotacion else f"promedio de los últimos {DIAS_VENTA_INVENTARIO} días"
    stock_total = sum(p["stock"] for p in productos.values())
    venta_diaria_total = sum(p["venta"] for p in productos.values())
    # Sin ninguna fila de stock para los filtros (p. ej. una sede cuyos
    # almacenes aún no tienen sede asignada) no se puede hablar de quiebres:
    # todo saldría "0 días" y sería falso.
    if stock_total <= 0:
        productos = {}
    dias_marca = stock_total / venta_diaria_total if venta_diaria_total and stock_total > 0 else None
    for p in productos.values():
        p["dias"] = p["stock"] / p["venta"] if p["venta"] > 0 else None
    en_riesgo = sorted((p for p in productos.values() if p["dias"] is not None and p["dias"] < UMBRAL_QUIEBRE), key=lambda p: p["dias"])
    sobrestock = [p for p in productos.values() if p["dias"] is not None and p["dias"] > UMBRAL_SOBRESTOCK]
    sin_venta = [p for p in productos.values() if p["dias"] is None and p["stock"] > 0]

    # --- Párrafo de resumen
    v_venta = _var(act["venta_neta"], ant["venta_neta"])
    v_clientes = _var(act["cobertura"], ant["cobertura"])
    v_vpc = _var(act["venta_por_cliente"], ant["venta_por_cliente"])
    t("La venta del período es ")
    t(_soles(act["venta_neta"]), "b")
    if hay_anterior and v_venta is not None:
        t(", ")
        t(f"{_pct(v_venta)} {'más' if v_venta >= 0 else 'menos'}", "up" if v_venta >= 0 else "down")
        t(f" que del {_fecha(ant_desde_s)} al {_fecha(ant_hasta_s)}. ")
        if abs(v_venta) >= UMBRAL_VARIACION and v_clientes is not None and v_vpc is not None:
            sube = v_venta > 0
            if (v_clientes > 0) == sube and (v_vpc > 0) != sube:
                t(f"El cambio viene de {'más' if sube else 'menos'} clientes ({_num(act['cobertura'])}, {'+' if v_clientes >= 0 else '−'}{_pct(v_clientes)}), no del tamaño de las compras: la venta por cliente ")
                t(f"{'bajó' if v_vpc < 0 else 'subió'} {_pct(v_vpc)}", "up" if v_vpc >= 0 else "down")
                t(". ")
            elif (v_vpc > 0) == sube and (v_clientes > 0) != sube:
                t(f"Hay {'menos' if v_clientes < 0 else 'más'} clientes ({'+' if v_clientes >= 0 else '−'}{_pct(v_clientes)}), pero cada uno ")
                t(f"{'compra más' if v_vpc > 0 else 'compra menos'} ({'+' if v_vpc >= 0 else '−'}{_pct(v_vpc)})", "up" if v_vpc >= 0 else "down")
                t(". ")
            else:
                verbo = "suben" if sube else "bajan"
                t(f"{verbo.capitalize()} tanto los clientes ({'+' if v_clientes >= 0 else '−'}{_pct(v_clientes)}) como la venta por cliente ({'+' if v_vpc >= 0 else '−'}{_pct(v_vpc)}). ")
    else:
        t(". ")
    if dias_marca is not None:
        t("El inventario alcanza para ")
        t(f"{_entero(dias_marca)} días", "b")
        if en_riesgo:
            t(", pero hay ")
            t(f"{len(en_riesgo)} producto{'s' if len(en_riesgo) > 1 else ''} en riesgo de quiebre", "down")
        t(".")
    elif stock_total <= 0 and filtros_stock:
        t("Todavía no hay stock asociado a esta selección (falta asignar la sede de los almacenes), así que no se calculan días de inventario.")

    # --- Datos desactualizados
    if ultima:
        try:
            ultima_dt = datetime.fromisoformat(str(ultima)[:19])
            # FechaProceso está en hora de Lima; el servidor (Render) corre en UTC.
            horas = (datetime.now(LIMA).replace(tzinfo=None) - ultima_dt).total_seconds() / 3600
            if horas > 48:
                hallazgos.append(_hallazgo(
                    "alerta", "clock-alert",
                    f"Los datos no se actualizan desde hace {horas / 24:.0f} días",
                    f"La última actualización fue el {_fecha(ultima_dt.date().isoformat())}. Las cifras de este panel llegan hasta esa fecha.",
                    prioridad=95))
        except ValueError:
            pass

    # --- Quiebres de stock
    for p in en_riesgo[:2]:
        if p["dias"] >= UMBRAL_CRITICO and len(en_riesgo) > 2:
            break
        if p["stock"] < 0.5:
            titulo = f"{p['desc']} está sin stock"
            detalle = f"No quedan cajas en los almacenes y se venden {p['venta']:.1f} cajas por día ({fuente_venta}). Conviene coordinar la reposición."
        else:
            cuanto = "menos de 1 día" if p["dias"] < 1 else f"{_entero(p['dias'])} días"
            titulo = f"{p['desc']} tiene {cuanto} de stock"
            detalle = f"Quedan {_num(p['stock'])} cajas y se venden {p['venta']:.1f} cajas por día ({fuente_venta}). Conviene coordinar la reposición."
        hallazgos.append(_hallazgo(
            "quiebre", "triangle-alert", titulo, detalle,
            {"tab": "dias", "nivel": "producto", "label": "Ver días de inventario"}, prioridad=90))
    if len(en_riesgo) > 2:
        nombres = ", ".join(p["desc"] for p in en_riesgo[:4])
        hallazgos.append(_hallazgo(
            "quiebre", "triangle-alert",
            f"{len(en_riesgo)} productos tienen menos de {UMBRAL_QUIEBRE} días de stock",
            f"Los más urgentes: {nombres}.",
            {"tab": "dias", "nivel": "producto", "label": "Ver días de inventario"}, prioridad=85))

    # --- Variación de la venta y qué la explica
    if hay_anterior and v_venta is not None and abs(v_venta) >= UMBRAL_VARIACION:
        signo = 1 if v_venta > 0 else -1
        diferencia = act["venta_neta"] - ant["venta_neta"]
        causa = _mayor_contribuyente(variacion, dims - {"codigo_producto"}, "venta_act", "venta_ant", signo)
        detalle = f"Pasó de {_soles(ant['venta_neta'])} a {_soles(act['venta_neta'])}."
        accion = {"tab": "ventas", "dim": "canal", "label": "Ver análisis de ventas"}
        if causa:
            parte = abs(causa["cambio"]) / abs(diferencia) * 100 if diferencia else 0
            detalle += (f" Lo que más pesa es {NOMBRE_DIM[causa['dimension']]} {_etiqueta(causa)}: "
                        f"{'+' if causa['cambio'] > 0 else '−'}{_soles(abs(causa['cambio']))}"
                        f"{f' ({parte:.0f}% del cambio total)' if 0 < parte <= 100 else ''}.")
            accion = {"tab": "ventas", "dim": causa["dimension"], "label": f"Ver venta por {NOMBRE_DIM[causa['dimension']].split(' ', 1)[1]}"}
        hallazgos.append(_hallazgo(
            "positivo" if signo > 0 else "alerta", "trending-up" if signo > 0 else "trending-down",
            f"La venta {'subió' if signo > 0 else 'bajó'} {_pct(v_venta)} ({'+' if signo > 0 else '−'}{_soles(abs(diferencia))}) frente al período anterior",
            detalle, accion, prioridad=80 if signo < 0 else 40))

    # --- Cobertura (clientes) y dónde se ganaron o perdieron
    if hay_anterior and v_clientes is not None and abs(v_clientes) >= UMBRAL_VARIACION:
        signo = 1 if v_clientes > 0 else -1
        dif = act["cobertura"] - ant["cobertura"]
        causa = _mayor_contribuyente(variacion, dims & {"sede", "distrito", "canal", "supervisor", "tipo_negocio"},
                                     "clientes_act", "clientes_ant", signo)
        detalle = f"Compraron {_num(act['cobertura'])} clientes, frente a {_num(ant['cobertura'])} en el período anterior."
        accion = {"tab": "ventas", "dim": "canal", "orden": "cobertura", "label": "Ver clientes por canal"}
        if causa:
            detalle += (f" El mayor cambio está en {NOMBRE_DIM[causa['dimension']]} {_etiqueta(causa)} "
                        f"({'+' if causa['cambio'] > 0 else '−'}{_num(abs(causa['cambio']))} clientes).")
            accion = {"tab": "ventas", "dim": causa["dimension"], "orden": "cobertura",
                      "label": f"Ver clientes por {NOMBRE_DIM[causa['dimension']].split(' ', 1)[1]}"}
        hallazgos.append(_hallazgo(
            "positivo" if signo > 0 else "alerta", "users-round",
            f"La cobertura {'subió' if signo > 0 else 'cayó'} {_pct(v_clientes)}: {_num(abs(dif))} clientes {'más' if signo > 0 else 'menos'}",
            detalle, accion, prioridad=75 if signo < 0 else 38))

    # --- Productos que más suben y más bajan
    if hay_anterior:
        prods = [f for f in variacion if f["dimension"] == "codigo_producto"]
        if prods:
            baja = min(prods, key=lambda f: f["venta_act"] - f["venta_ant"])
            sube = max(prods, key=lambda f: f["venta_act"] - f["venta_ant"])
            for f, s in ((baja, -1), (sube, 1)):
                cambio = f["venta_act"] - f["venta_ant"]
                if s * cambio <= 0 or abs(cambio) < max(1000, act["venta_neta"] * 0.01):
                    continue
                v = _var(f["venta_act"], f["venta_ant"])
                variacion_txt = f" ({'+' if v >= 0 else '−'}{_pct(v)})" if v is not None else ""
                dif_clientes = f["clientes_act"] - f["clientes_ant"]
                hallazgos.append(_hallazgo(
                    "revisar" if s < 0 else "positivo", "package-minus" if s < 0 else "package-plus",
                    f"{_etiqueta(f)} es el producto que más {'cayó' if s < 0 else 'creció'}"
                    f" ({'+' if cambio > 0 else '−'}{_soles(abs(cambio))})",
                    f"Vendió {_soles(f['venta_act'])} frente a {_soles(f['venta_ant'])}{variacion_txt}, "
                    f"con {_num(f['clientes_act'])} clientes ({'+' if dif_clientes >= 0 else '−'}{_num(abs(dif_clientes))}).",
                    {"tab": "ventas", "dim": "codigo_producto", "label": "Ver venta por producto"},
                    prioridad=60 if s < 0 else 35))

    # --- Ticket promedio
    v_ticket = _var(act["ticket_documento"], ant["ticket_documento"])
    if hay_anterior and v_ticket is not None and abs(v_ticket) >= UMBRAL_VARIACION:
        hallazgos.append(_hallazgo(
            "positivo" if v_ticket > 0 else "revisar", "ticket",
            f"El ticket promedio {'subió' if v_ticket > 0 else 'bajó'} {_pct(v_ticket)} (S/ {act['ticket_documento']:,.2f} por documento)",
            f"En el período anterior era S/ {ant['ticket_documento']:,.2f}. "
            + ("Los clientes que compran están llevando más por pedido." if v_ticket > 0 else "Los pedidos son más chicos que antes."),
            prioridad=30 if v_ticket > 0 else 55))

    # --- Sobrestock y productos sin venta
    if sobrestock or sin_venta:
        partes = []
        if sobrestock:
            partes.append(f"{len(sobrestock)} con más de {UMBRAL_SOBRESTOCK} días de inventario")
        if sin_venta:
            partes.append(f"{len(sin_venta)} con stock pero sin ventas en {DIAS_VENTA_INVENTARIO} días")
        ejemplos = ", ".join(p["desc"] for p in sorted(sobrestock, key=lambda p: -p["dias"])[:3])
        hallazgos.append(_hallazgo(
            "revisar", "archive",
            f"Productos con stock alto: {' y '.join(partes)}",
            (f"Los de mayor cobertura: {ejemplos}. " if ejemplos else "")
            + "Puede ser una oportunidad para una activación o promoción.",
            {"tab": "dias", "nivel": "producto", "label": "Ver productos"}, prioridad=50))

    # --- Concentración en un producto
    lideres = sorted((f for f in variacion if f["dimension"] == "codigo_producto"), key=lambda f: -f["venta_act"])
    if lideres and act["venta_neta"] > 0:
        cuota = lideres[0]["venta_act"] / act["venta_neta"] * 100
        if cuota >= 25:
            hallazgos.append(_hallazgo(
                "info", "crown",
                f"{_etiqueta(lideres[0])} concentra el {cuota:.0f}% de la venta",
                f"Vendió {_soles(lideres[0]['venta_act'])} a {_num(lideres[0]['clientes_act'])} clientes. "
                "Es el producto líder: cualquier quiebre suyo pesa mucho en el total.",
                {"tab": "ventas", "dim": "codigo_producto", "label": "Ver top productos"}, prioridad=20))

    hallazgos.sort(key=lambda h: -h["prioridad"])
    return {
        "periodo": {"desde": desde, "hasta": hasta, "ant_desde": ant_desde_s, "ant_hasta": ant_hasta_s},
        "resumen": texto,
        "hallazgos": hallazgos,
        "alertas": sum(1 for h in hallazgos if h["tipo"] in ("alerta", "quiebre")),
    }
