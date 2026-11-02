"""
db.py — todas las consultas del portal a Supabase (PostgreSQL).

Los KPI se calculan en la base de datos: nunca se descargan cientos de miles
de filas para sumarlas en Python. Cada consulta recibe los mismos filtros
(sede, distrito, canal, categoría, código proveedor, etc.), así que KPI,
gráficos, días de inventario y descargas siempre muestran lo mismo.
"""
import copy
import csv
import io
import os
import threading
import time
from functools import wraps

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
# Se importan el dialecto y el driver al arrancar: si los carga create_engine()
# la primera vez, varios hilos a la vez (gunicorn --threads + precalentado)
# chocan con "cannot access submodule 'postgresql' ... circular import".
import psycopg2  # noqa: F401
import psycopg2.extensions  # noqa: F401
import psycopg2.extras  # noqa: F401
import sqlalchemy.dialects.postgresql.psycopg2  # noqa: F401
from dotenv import load_dotenv

load_dotenv()

_ENGINE = None
_ENGINE_LOCK = threading.Lock()

# Caché en memoria: las ventas se cargan una vez al día y el stock cada hora,
# así que no tiene sentido repetir la misma consulta en cada recarga.
CACHE_SEGUNDOS = 1800
CACHE_MAX_CLAVES = 500
_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _cacheado(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        clave = (fn.__name__, args, tuple(sorted(kwargs.items())))
        ahora = time.monotonic()
        with _CACHE_LOCK:
            guardado = _CACHE.get(clave)
            if guardado and ahora - guardado[0] < CACHE_SEGUNDOS:
                return copy.deepcopy(guardado[1])
        valor = fn(*args, **kwargs)
        with _CACHE_LOCK:
            if len(_CACHE) >= CACHE_MAX_CLAVES:
                _CACHE.clear()
            _CACHE[clave] = (ahora, valor)
        return copy.deepcopy(valor)
    return wrapper


def _engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    # Un solo hilo crea el engine; los demás esperan y reutilizan el mismo.
    with _ENGINE_LOCK:
        if _ENGINE is not None:
            return _ENGINE
        url = os.environ.get("SUPABASE_DB_URL")
        if not url:
            raise RuntimeError(
                "Falta SUPABASE_DB_URL. Configúrala como variable de entorno."
            )

        url = url.replace("postgres://", "postgresql://", 1)
        if "+psycopg2" not in url:
            url = url.replace("postgresql://", "postgresql+psycopg2://", 1)

        _ENGINE = create_engine(
            url,
            pool_pre_ping=True,
            pool_recycle=300,
            pool_size=4,
            max_overflow=4,
            pool_timeout=30,
            connect_args={"connect_timeout": 15},
        )
    return _ENGINE


# El engine se crea al importar este módulo (en el hilo principal, antes de que
# exista cualquier hilo de gunicorn o del precalentado). create_engine() no abre
# conexiones; solo deja listo el pool. Si falta la variable, el error aparece
# recién en la primera consulta, con un mensaje claro.
if os.environ.get("SUPABASE_DB_URL"):
    _engine()


def _filas(sql, params):
    # Un reintento si la conexión se corta a mitad de la consulta (corte de red
    # o reinicio del pooler de Supabase): pool_pre_ping solo revisa la conexión
    # al tomarla, no si se cae mientras la consulta corre.
    for intento in (1, 2):
        try:
            with _engine().connect() as conexion:
                return [dict(f) for f in conexion.execute(text(sql), params).mappings().all()]
        except OperationalError:
            if intento == 2:
                raise
            _engine().dispose()
            time.sleep(1)


def _leer_uno(sql, params):
    filas = _filas(sql, params)
    return filas[0] if filas else {}


# ---------------------------------------------------------------------------
#  Dimensiones y filtros (lista blanca: nada que venga por URL llega al SQL)
# ---------------------------------------------------------------------------
SIN = {
    "sede": "SIN SEDE", "distrito": "SIN DISTRITO",
    "categoria": "SIN CATEGORÍA", "codigo_proveedor": "SIN CÓDIGO",
    "linea": "SIN LÍNEA", "marca": "SIN MARCA",
}

VENTAS_FROM = """
    FROM public.ventas v
    LEFT JOIN public.productos p
      ON p.proveedor_codigo = v.proveedor_codigo AND p.codigo_producto = v.codigo_producto
"""

DIM_VENTAS = {
    "sede": f"COALESCE(v.sede, '{SIN['sede']}')",
    "distrito": f"COALESCE(v.distrito, '{SIN['distrito']}')",
    "canal": "v.canal",
    "tipo_negocio": "v.tipo_negocio",
    "jefe_ventas": "v.jefe_ventas",
    "supervisor": "v.supervisor",
    "codigo_vendedor": "v.codigo_vendedor",
    "codigo_producto": "v.codigo_producto",
    "categoria": f"COALESCE(p.categoria, '{SIN['categoria']}')",
    "codigo_proveedor": f"COALESCE(p.codigo_proveedor, '{SIN['codigo_proveedor']}')",
    # Línea y marca de la propia venta; el maestro solo cubre ventas que no las traen.
    "linea": f"COALESCE(v.linea, p.linea, '{SIN['linea']}')",
    "marca": f"COALESCE(v.marca, p.marca, '{SIN['marca']}')",
    "mes": "to_char(v.fecha_documento, 'YYYY-MM')",
    "semana": "to_char(date_trunc('week', v.fecha_documento), 'YYYY-MM-DD')",
    "dia_semana": "extract(isodow from v.fecha_documento)::int",
}

# Filtros de la barra superior (se aplican a ventas).
FILTROS_VENTAS = ("sede", "distrito", "canal", "tipo_negocio", "jefe_ventas",
                  "supervisor", "linea", "marca", "codigo_producto", "categoria", "codigo_proveedor")

STOCK_FROM = """
    FROM public.stock s
    LEFT JOIN public.productos p
      ON p.proveedor_codigo = s.proveedor_codigo AND p.codigo_producto = s.codigo_producto
    LEFT JOIN public.almacenes a ON a.codigo_almacen = s.codigo_almacen
"""

DIM_STOCK = {
    "sede": f"COALESCE(a.sede, '{SIN['sede']}')",
    "almacen": "s.nombre_almacen",
    "codigo_producto": "s.codigo_producto",
    "categoria": f"COALESCE(p.categoria, '{SIN['categoria']}')",
    "codigo_proveedor": f"COALESCE(p.codigo_proveedor, '{SIN['codigo_proveedor']}')",
    "linea": f"COALESCE(p.linea, '{SIN['linea']}')",
    "marca": f"COALESCE(p.marca, '{SIN['marca']}')",
}

# Unidades por caja de una fila de stock: "Factor Maximo" del CSV o, si viene
# vacío, deducido de unidades ÷ cajas.
FACTOR_STOCK = "COALESCE(s.factor, ROUND(s.stock_unidad_minima / NULLIF(s.stock_unidades_maximas, 0)))"

# Del filtro global, estos también aplican al stock (los demás son de ventas).
FILTROS_STOCK = ("sede", "codigo_producto", "categoria", "codigo_proveedor", "linea", "marca")


def _normalizar_fecha(fecha):
    if fecha is None:
        return None
    fecha = str(fecha).strip()
    if fecha.lower() in ("", "null", "none", "undefined"):
        return None
    return fecha


def _condiciones(filtros, dimensiones, permitidos, params):
    """filtros = ((campo, (valor, ...)), ...) -> lista de condiciones SQL."""
    condiciones = []
    for campo, valores in filtros:
        if campo in permitidos and valores:
            nombre = f"f_{campo}"
            condiciones.append(f"{dimensiones[campo]} = ANY(:{nombre})")
            params[nombre] = list(valores)
    return condiciones


def _where_ventas(proveedor, desde=None, hasta=None, filtros=()):
    params = {"proveedor": proveedor}
    condiciones = ["v.proveedor_codigo = :proveedor"]
    desde, hasta = _normalizar_fecha(desde), _normalizar_fecha(hasta)
    if desde:
        condiciones.append("v.fecha_documento >= :desde")
        params["desde"] = desde
    if hasta:
        condiciones.append("v.fecha_documento <= :hasta")
        params["hasta"] = hasta
    condiciones += _condiciones(filtros, DIM_VENTAS, FILTROS_VENTAS, params)
    return " AND ".join(condiciones), params


def _where_stock(proveedor, filtros=()):
    params = {"proveedor": proveedor}
    condiciones = ["s.proveedor_codigo = :proveedor"]
    condiciones += _condiciones(filtros, DIM_STOCK, FILTROS_STOCK, params)
    return " AND ".join(condiciones), params


# ---------------------------------------------------------------------------
#  Datos generales
# ---------------------------------------------------------------------------
@_cacheado
def rango_disponible(proveedor):
    fila = _leer_uno("""
        SELECT MIN(fecha_documento) AS desde, MAX(fecha_documento) AS hasta
        FROM public.ventas WHERE proveedor_codigo = :proveedor
    """, {"proveedor": proveedor})
    if not fila or fila["desde"] is None:
        return None, None
    return str(fila["desde"]), str(fila["hasta"])


@_cacheado
def ultima_sincronizacion(proveedor):
    # Solo se miran las ventas de la última semana con datos: buscar el
    # MAX(fecha_proceso) en toda la tabla obligaba a leer las 400 mil filas
    # (no hay índice por fecha_proceso) y tardaba ~19 s.
    fila = _leer_uno("""
        SELECT GREATEST(
            (SELECT MAX(fecha_proceso) FROM public.ventas
              WHERE proveedor_codigo = :p
                AND fecha_documento >= (SELECT MAX(fecha_documento) FROM public.ventas
                                         WHERE proveedor_codigo = :p) - 7),
            (SELECT MAX(fecha_proceso) FROM public.stock WHERE proveedor_codigo = :p)
        ) AS ultima
    """, {"p": proveedor})
    valor = fila.get("ultima")
    return str(valor) if valor is not None else None


@_cacheado
def opciones_filtros(proveedor):
    """Valores disponibles para cada filtro, sacados de la propia data (una sola pasada)."""
    columnas = [c for c in FILTROS_VENTAS if c != "codigo_producto"]
    seleccion = ",\n".join(
        f"array_remove(array_agg(DISTINCT {DIM_VENTAS[c]}), NULL) AS {c}" for c in columnas
    )
    fila = _leer_uno(f"SELECT {seleccion} {VENTAS_FROM} WHERE v.proveedor_codigo = :proveedor",
                     {"proveedor": proveedor})
    opciones = {c: sorted(fila.get(c) or []) for c in columnas}
    opciones["codigo_producto"] = _filas("""
        SELECT codigo_producto AS valor, MAX(descripcion) AS etiqueta FROM (
            SELECT codigo_producto, descripcion_producto AS descripcion
            FROM public.ventas WHERE proveedor_codigo = :proveedor
            GROUP BY 1, 2
            UNION ALL
            SELECT codigo_producto, producto_descripcion
            FROM public.stock WHERE proveedor_codigo = :proveedor
        ) t GROUP BY codigo_producto ORDER BY 2
    """, {"proveedor": proveedor})
    return opciones


# ---------------------------------------------------------------------------
#  Ventas
# ---------------------------------------------------------------------------
@_cacheado
def resumen_ventas(proveedor, desde=None, hasta=None, filtros=()):
    where, params = _where_ventas(proveedor, desde, hasta, filtros)
    fila = _leer_uno(f"""
        WITH vf AS (
            SELECT v.codigo_cliente, v.nro_documento, v.tipo_documento,
                   v.codigo_producto, v.fecha_documento, v.codigo_vendedor,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   COALESCE(v.cantidad_unidad_maxima, 0) AS cantidad
            {VENTAS_FROM}
            WHERE {where}
        ), cobertura AS (
            SELECT COUNT(*) AS clientes
            FROM (
                SELECT codigo_cliente FROM vf
                WHERE codigo_cliente IS NOT NULL
                GROUP BY codigo_cliente
                HAVING SUM(importe) > 0
            ) c
        )
        SELECT
            (SELECT clientes FROM cobertura)::bigint AS cobertura,
            COALESCE(SUM(importe), 0)::double precision AS venta_neta,
            COALESCE(SUM(cantidad), 0)::double precision AS cajas,
            COUNT(DISTINCT nro_documento)
                FILTER (WHERE tipo_documento IS DISTINCT FROM 'NC')::bigint AS documentos,
            COALESCE(-SUM(importe) FILTER (WHERE tipo_documento = 'NC'), 0)::double precision AS notas_credito,
            COUNT(DISTINCT codigo_producto)::bigint AS skus,
            COUNT(DISTINCT codigo_vendedor)::bigint AS vendedores,
            COUNT(DISTINCT fecha_documento)::bigint AS dias_venta
        FROM vf
    """, params)
    venta = float(fila.get("venta_neta") or 0)
    documentos = int(fila.get("documentos") or 0)
    cobertura = int(fila.get("cobertura") or 0)
    dias = int(fila.get("dias_venta") or 0)
    cajas = float(fila.get("cajas") or 0)
    return {
        "cobertura": cobertura,
        "venta_neta": round(venta, 2),
        "cajas": round(cajas, 2),
        "documentos": documentos,
        "ticket_documento": round(venta / documentos, 2) if documentos else 0,
        "venta_por_cliente": round(venta / cobertura, 2) if cobertura else 0,
        "notas_credito": round(float(fila.get("notas_credito") or 0), 2),
        "skus": int(fila.get("skus") or 0),
        "vendedores": int(fila.get("vendedores") or 0),
        "dias_venta": dias,
        "venta_diaria": round(venta / dias, 2) if dias else 0,
        "cajas_diarias": round(cajas / dias, 2) if dias else 0,
    }


DIMENSIONES_ORDEN_CLAVE = {"mes", "semana", "dia_semana"}


@_cacheado
def agrupar_ventas(proveedor, campo, desde=None, hasta=None, top=None, filtros=(), orden="venta"):
    """Venta, cajas y cobertura (clientes únicos con venta neta > 0) por una dimensión."""
    clave_sql = DIM_VENTAS.get(campo)
    if not clave_sql:
        raise ValueError("Campo de agrupación no permitido")
    where, params = _where_ventas(proveedor, desde, hasta, filtros)

    if campo in DIMENSIONES_ORDEN_CLAVE:
        orden_sql = "t.clave"
    else:
        orden_sql = {"venta": "t.venta DESC", "cobertura": "cobertura DESC", "cajas": "t.cajas DESC"}.get(orden, "t.venta DESC")
    limite_sql = ""
    if top:
        limite_sql = " LIMIT :limite"
        params["limite"] = int(top)
    es_producto = campo == "codigo_producto"

    filas = _filas(f"""
        WITH vf AS (
            SELECT {clave_sql} AS clave, v.codigo_cliente, v.descripcion_producto,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   COALESCE(v.cantidad_unidad_maxima, 0) AS cantidad
            {VENTAS_FROM}
            WHERE {where}
        ), totales AS (
            SELECT clave,
                   SUM(importe)::double precision AS venta,
                   SUM(cantidad)::double precision AS cajas
                   {', MAX(descripcion_producto) AS descripcion' if es_producto else ''}
            FROM vf WHERE clave IS NOT NULL
            GROUP BY clave
        ), por_cliente AS (
            SELECT clave, codigo_cliente, SUM(importe) AS venta_cliente
            FROM vf WHERE clave IS NOT NULL AND codigo_cliente IS NOT NULL
            GROUP BY clave, codigo_cliente
        ), cobertura AS (
            SELECT clave, COUNT(*) FILTER (WHERE venta_cliente > 0)::bigint AS cobertura
            FROM por_cliente GROUP BY clave
        )
        SELECT t.clave::text AS clave, t.venta, t.cajas,
               COALESCE(c.cobertura, 0)::bigint AS cobertura
               {', t.descripcion' if es_producto else ''}
        FROM totales t LEFT JOIN cobertura c ON c.clave = t.clave
        ORDER BY {orden_sql}{limite_sql}
    """, params)
    salida = []
    for f in filas:
        item = {"clave": f["clave"], "venta": float(f["venta"] or 0),
                "cajas": float(f["cajas"] or 0), "cobertura": int(f["cobertura"] or 0)}
        if es_producto:
            item["descripcion"] = f.get("descripcion") or f["clave"]
        salida.append(item)
    return salida


DIM_VARIACION = ("canal", "tipo_negocio", "jefe_ventas", "supervisor", "sede",
                 "distrito", "linea", "categoria", "codigo_producto")


@_cacheado
def variacion_por_dimension(proveedor, ant_desde, corte, hasta, filtros=()):
    """
    Venta y clientes de cada valor de cada dimensión en dos períodos seguidos
    (anterior: ant_desde..corte-1, actual: corte..hasta), en una sola lectura.
    Sirve para explicar qué canal, supervisor, producto, etc. movió el total.
    """
    where, params = _where_ventas(proveedor, ant_desde, hasta, filtros)
    params["corte"] = corte
    pares = ", ".join(f"('{d}', vf.{d}::text)" for d in DIM_VARIACION)
    return _filas(f"""
        WITH vf AS (
            SELECT v.fecha_documento >= :corte AS actual, v.codigo_cliente,
                   v.descripcion_producto,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   {', '.join(f'{DIM_VENTAS[d]} AS {d}' for d in DIM_VARIACION)}
            {VENTAS_FROM}
            WHERE {where}
        )
        SELECT d.dimension, d.clave,
               MAX(vf.descripcion_producto) FILTER (WHERE d.dimension = 'codigo_producto') AS descripcion,
               COALESCE(SUM(vf.importe) FILTER (WHERE vf.actual), 0)::double precision AS venta_act,
               COALESCE(SUM(vf.importe) FILTER (WHERE NOT vf.actual), 0)::double precision AS venta_ant,
               COUNT(DISTINCT vf.codigo_cliente) FILTER (WHERE vf.actual)::bigint AS clientes_act,
               COUNT(DISTINCT vf.codigo_cliente) FILTER (WHERE NOT vf.actual)::bigint AS clientes_ant
        FROM vf, LATERAL (VALUES {pares}) AS d(dimension, clave)
        WHERE d.clave IS NOT NULL
        GROUP BY 1, 2
    """, params)


# ---------------------------------------------------------------------------
#  Stock
# ---------------------------------------------------------------------------
@_cacheado
def resumen_stock(proveedor, filtros=()):
    where, params = _where_stock(proveedor, filtros)
    fila = _leer_uno(f"""
        SELECT COALESCE(SUM(s.valor_stock), 0)::double precision AS valor_stock,
               COALESCE(SUM(s.stock_unidades_maximas), 0)::double precision AS cajas_stock,
               COUNT(DISTINCT s.codigo_producto) FILTER (WHERE s.stock_unidades_maximas > 0)::bigint AS skus_con_stock,
               COUNT(DISTINCT s.codigo_almacen)::bigint AS almacenes
        {STOCK_FROM}
        WHERE {where}
    """, params)
    return {
        "valor_stock": round(float(fila.get("valor_stock") or 0), 2),
        "cajas_stock": round(float(fila.get("cajas_stock") or 0), 2),
        "skus_con_stock": int(fila.get("skus_con_stock") or 0),
        "almacenes": int(fila.get("almacenes") or 0),
    }


@_cacheado
def stock_resumen(proveedor, filtros=()):
    where, params = _where_stock(proveedor, filtros)

    def por(dimension):
        return _filas(f"""
            SELECT {DIM_STOCK[dimension]} AS clave,
                   COALESCE(SUM(s.valor_stock), 0)::double precision AS valor,
                   COALESCE(SUM(s.stock_unidades_maximas), 0)::double precision AS cajas
            {STOCK_FROM}
            WHERE {where}
            GROUP BY 1
            ORDER BY valor DESC
        """, params)

    return {
        "por_almacen": por("almacen"),
        "por_sede": por("sede"),
        "por_categoria": por("categoria"),
        "por_producto": _filas(f"""
            SELECT s.codigo_producto AS clave, MAX(s.producto_descripcion) AS descripcion,
                   {DIM_STOCK['categoria']} AS categoria,
                   {DIM_STOCK['codigo_proveedor']} AS codigo_proveedor,
                   COALESCE(SUM(s.valor_stock), 0)::double precision AS valor,
                   COALESCE(SUM(s.stock_unidades_maximas), 0)::double precision AS cajas,
                   COALESCE(SUM(s.stock_unidad_minima), 0)::double precision AS unidades,
                   MAX({FACTOR_STOCK})::double precision AS factor
            {STOCK_FROM}
            WHERE {where}
            GROUP BY 1, 3, 4
            ORDER BY valor DESC
        """, params),
    }


DIM_ROTACION = {
    "sede": "r.sede",
    "codigo_producto": "r.codigo_producto",
    "categoria": DIM_STOCK["categoria"],
    "codigo_proveedor": DIM_STOCK["codigo_proveedor"],
    "linea": DIM_STOCK["linea"],
    "marca": DIM_STOCK["marca"],
}


@_cacheado
def hay_rotacion(proveedor):
    fila = _leer_uno("SELECT EXISTS (SELECT 1 FROM public.rotacion WHERE proveedor_codigo = :p) AS hay",
                     {"p": proveedor})
    return bool(fila.get("hay"))


@_cacheado
def dias_inventario(proveedor, dias=30, filtros=()):
    """
    Días de inventario = stock actual en cajas ÷ venta diaria en cajas.
    Devuelve una fila por sede+producto; el navegador suma por sede, categoría,
    producto o marca (sumando stock y venta por separado y recién dividiendo,
    nunca promediando los días).

    La venta diaria sale de:
      - Rotacion.csv si está cargada: igual que el Excel "Stock-DI GVD",
        REDONDEAR(CantidadDS / NDias) en unidades, pasado a cajas con el factor.
        CantidadDS es lo que salió de cada almacén, no la venta de la sede.
      - Si no, de las ventas de los últimos `dias` días con datos.
    """
    where_s, params = _where_stock(proveedor, filtros)
    if hay_rotacion(proveedor):
        fuente = "rotacion"
        where_r = " AND ".join(["r.proveedor_codigo = :proveedor"]
                               + _condiciones(filtros, DIM_ROTACION, FILTROS_STOCK, params))
        venta_sql = f"""
        factor AS (
            SELECT s.codigo_producto,
                   MAX(COALESCE(s.factor, ROUND(s.stock_unidad_minima / NULLIF(s.stock_unidades_maximas, 0)))) AS factor
            FROM public.stock s WHERE s.proveedor_codigo = :proveedor
            GROUP BY 1
        ), venta AS (
            SELECT r.sede, r.codigo_producto,
                   ROUND(r.cantidad_ds / NULLIF(r.ndias, 0)) / NULLIF(f.factor, 0) AS venta_diaria
            FROM public.rotacion r
            LEFT JOIN public.productos p
              ON p.proveedor_codigo = r.proveedor_codigo AND p.codigo_producto = r.codigo_producto
            LEFT JOIN factor f ON f.codigo_producto = r.codigo_producto
            WHERE {where_r}
        )"""
    else:
        fuente = "ventas"
        where_v, params_v = _where_ventas(proveedor, None, None, filtros)
        # Los nombres de parámetros coinciden (proveedor, f_sede, f_categoria...)
        params.update(params_v)
        params["dias"] = int(dias)
        venta_sql = f"""
        ult AS (
            SELECT MAX(fecha_documento) AS fin
            FROM public.ventas WHERE proveedor_codigo = :proveedor
        ), venta AS (
            SELECT {DIM_VENTAS['sede']} AS sede, v.codigo_producto,
                   SUM(COALESCE(v.cantidad_unidad_maxima, 0)) / :dias AS venta_diaria
            {VENTAS_FROM}, ult
            WHERE {where_v}
              AND v.fecha_documento > ult.fin - CAST(:dias AS integer)
            GROUP BY 1, 2
        )"""
    params["fuente"] = fuente
    return _filas(f"""
        WITH {venta_sql}, stk AS (
            SELECT {DIM_STOCK['sede']} AS sede, s.codigo_producto,
                   -- Cajas = unidades ÷ factor (exacto). stock_unidades_maximas viene del
                   -- CSV con 4 decimales y eso movía casos x.5 (15.5 -> 15.49995).
                   SUM(COALESCE(s.stock_unidad_minima / NULLIF({FACTOR_STOCK}, 0),
                                s.stock_unidades_maximas, 0)) AS stock_cajas,
                   SUM(COALESCE(s.stock_unidad_minima, 0)) AS stock_unidades,
                   MAX({FACTOR_STOCK}) AS factor,
                   SUM(COALESCE(s.valor_stock, 0)) AS valor_stock
            {STOCK_FROM}
            WHERE {where_s}
            GROUP BY 1, 2
        )
        SELECT COALESCE(stk.sede, venta.sede) AS sede,
               COALESCE(stk.codigo_producto, venta.codigo_producto) AS codigo_producto,
               pr.descripcion,
               COALESCE(pr.categoria, '{SIN['categoria']}') AS categoria,
               COALESCE(pr.codigo_proveedor, '{SIN['codigo_proveedor']}') AS codigo_proveedor,
               COALESCE(pr.linea, '{SIN['linea']}') AS linea,
               COALESCE(pr.marca, '{SIN['marca']}') AS marca,
               COALESCE(stk.stock_cajas, 0)::double precision AS stock_cajas,
               COALESCE(stk.valor_stock, 0)::double precision AS valor_stock,
               COALESCE(stk.stock_unidades, 0)::double precision AS stock_unidades,
               stk.factor::double precision AS factor,
               COALESCE(venta.venta_diaria, 0)::double precision AS venta_diaria,
               CAST(:fuente AS text) AS fuente
        FROM stk
        FULL JOIN venta ON venta.sede = stk.sede AND venta.codigo_producto = stk.codigo_producto
        LEFT JOIN public.productos pr
          ON pr.proveedor_codigo = :proveedor
         AND pr.codigo_producto = COALESCE(stk.codigo_producto, venta.codigo_producto)
        ORDER BY 1, 2
    """, params)


# ---------------------------------------------------------------------------
#  Descargas
# ---------------------------------------------------------------------------
# Columnas de las descargas, en el orden acordado con PEUSAC (Excel "Rev 27.10").
# Se quitaron: tipo_documento, origen, numero_item, moneda, tipo_venta y
# fecha_proceso (ventas); fecha_vencimiento y fecha_proceso (stock). Siguen
# guardadas en Supabase: el portal las usa para sus cálculos.
EXPORT_VENTAS = [
    ("nro_documento", "v.nro_documento"),
    ("fecha_documento", "v.fecha_documento"),
    ("codigo_cliente", "v.codigo_cliente"),
    ("canal", "v.canal"),
    ("tipo_negocio", "v.tipo_negocio"),
    ("sede", "v.sede"),
    ("distrito", "v.distrito"),
    ("jefe_ventas", "v.jefe_ventas"),
    ("supervisor", "v.supervisor"),
    ("nombre_vendedor", "NULL"),  # pendiente: hoy no viene en la extracción
    ("codigo_vendedor", "v.codigo_vendedor"),
    ("ruta", "v.ruta"),
    ("linea", "COALESCE(v.linea, p.linea)"),
    ("marca", "COALESCE(v.marca, p.marca)"),
    ("categoria", "p.categoria"),
    ("codigo_proveedor", "p.codigo_proveedor"),
    ("codigo_producto", "v.codigo_producto"),
    ("descripcion_producto", "v.descripcion_producto"),
    ("cantidad_unidad_minima", "v.cantidad_unidad_minima"),
    ("tipo_unidad_minima", "v.tipo_unidad_minima"),
    ("cantidad_unidad_maxima", "v.cantidad_unidad_maxima"),
    ("tipo_unidad_maxima", "v.tipo_unidad_maxima"),
    ("importe_neto_sin_impuesto", "v.importe_neto_sin_impuesto"),
    ("importe_neto_con_impuesto", "v.importe_neto_con_impuesto"),
]
EXPORT_STOCK = [
    ("codigo_almacen", "s.codigo_almacen"),
    ("nombre_almacen", "s.nombre_almacen"),
    ("codigo_proveedor", "p.codigo_proveedor"),
    ("codigo_producto", "s.codigo_producto"),
    ("linea", "p.linea"),
    ("marca", "p.marca"),
    ("categoria", "p.categoria"),
    ("producto_descripcion", "s.producto_descripcion"),
    ("lote", "s.lote"),
    ("stock_unidad_minima", "s.stock_unidad_minima"),
    ("unidad_medida_minima", "s.unidad_medida_minima"),
    ("stock_unidades_maximas", "s.stock_unidades_maximas"),
    ("unidad_medida_maxima", "s.unidad_medida_maxima"),
    # "Factor Maximo" del CSV; si viene vacío, se deduce del propio stock.
    ("factor", FACTOR_STOCK),
    # Formato del Excel Stock-DI: ENTERO(cajas) + unidades sueltas / 1000 (124.006 = 124 cajas y 6 unidades).
    ("stock_cajas_unidades", f"ROUND(FLOOR(s.stock_unidad_minima / NULLIF({FACTOR_STOCK}, 0)) + "
                             f"(s.stock_unidad_minima - FLOOR(s.stock_unidad_minima / NULLIF({FACTOR_STOCK}, 0)) * {FACTOR_STOCK}) / 1000, 3)"),
    ("valor_stock", "s.valor_stock"),
    ("periodo", "s.periodo"),
]


def iterar_csv(tabla, proveedor, desde=None, hasta=None, filtros=()):
    """Genera CSV por bloques para no guardar toda la exportación en RAM."""
    if tabla == "ventas":
        where, params = _where_ventas(proveedor, desde, hasta, filtros)
        columnas = EXPORT_VENTAS
        sql = text(f"""
            SELECT {', '.join(expr for _, expr in columnas)}
            {VENTAS_FROM}
            WHERE {where}
            ORDER BY v.fecha_documento, v.nro_documento
        """)
    elif tabla == "stock":
        where, params = _where_stock(proveedor, filtros)
        columnas = EXPORT_STOCK
        sql = text(f"""
            SELECT {', '.join(expr for _, expr in columnas)}
            {STOCK_FROM}
            WHERE {where}
            ORDER BY s.codigo_almacen, s.codigo_producto
        """)
    else:
        raise ValueError("Tabla de exportación no permitida")

    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer)
    escritor.writerow([nombre for nombre, _ in columnas])
    yield buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)

    with _engine().connect() as conexion:
        resultado = conexion.execution_options(
            stream_results=True, yield_per=5000
        ).execute(sql, params)
        while True:
            filas = resultado.fetchmany(5000)
            if not filas:
                break
            escritor.writerows(filas)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)
        resultado.close()
