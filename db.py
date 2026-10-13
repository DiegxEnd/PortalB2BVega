import csv
import io
import os
import pandas as pd

from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

_ENGINE = None
TAMANO_BLOQUE = 10000

# Lista blanca: evita que un nombre de campo enviado por URL llegue al SQL.
CAMPOS_AGRUPABLES_SQL = {
    "canal": "canal",
    "tipo_negocio": "tipo_negocio",
    "codigo_producto": "codigo_producto",
    "supervisor": "supervisor",
    "jefe_ventas": "jefe_ventas",
}

COLS_VENTAS = [
    "fecha_documento", "canal", "tipo_documento", "nro_documento",
    "codigo_cliente", "tipo_negocio", "supervisor", "jefe_ventas",
    "codigo_vendedor", "codigo_producto", "descripcion_producto",
    "cantidad_unidad_maxima", "importe_neto_sin_impuesto"
]


def _engine():
    global _ENGINE
    if _ENGINE is None:
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
            pool_size=3,
            max_overflow=2,
            pool_timeout=30,
            connect_args={"connect_timeout": 15},
        )
    return _ENGINE


def _normalizar_fecha(fecha):
    if fecha is None:
        return None
    fecha = str(fecha).strip()
    if fecha.lower() in ("", "null", "none", "undefined"):
        return None
    return fecha


def _filtro_ventas(proveedor, desde=None, hasta=None, alias="v"):
    condiciones = [f"{alias}.proveedor_codigo = :proveedor"]
    params = {"proveedor": proveedor}
    desde = _normalizar_fecha(desde)
    hasta = _normalizar_fecha(hasta)
    if desde:
        condiciones.append(f"{alias}.fecha_documento >= :desde")
        params["desde"] = desde
    if hasta:
        condiciones.append(f"{alias}.fecha_documento <= :hasta")
        params["hasta"] = hasta
    return " AND ".join(condiciones), params


def _leer_uno(sql, params):
    with _engine().connect() as conexion:
        fila = conexion.execute(text(sql), params).mappings().first()
        return dict(fila) if fila else {}


def rango_disponible(proveedor):
    return _rango_disponible(proveedor)


def _rango_disponible(proveedor):
    fila = _leer_uno("""
        SELECT MIN(fecha_documento) AS desde, MAX(fecha_documento) AS hasta
        FROM public.ventas WHERE proveedor_codigo = :proveedor
    """, {"proveedor": proveedor})
    if not fila or fila["desde"] is None:
        return None, None
    return str(fila["desde"]), str(fila["hasta"])


def ultima_sincronizacion(proveedor):
    fila = _leer_uno("""
        SELECT GREATEST(
            (SELECT MAX(fecha_proceso) FROM public.ventas WHERE proveedor_codigo = :pv),
            (SELECT MAX(fecha_proceso) FROM public.stock WHERE proveedor_codigo = :ps)
        ) AS ultima
    """, {"pv": proveedor, "ps": proveedor})
    valor = fila.get("ultima")
    return str(valor) if valor is not None else None


def resumen_ventas(proveedor, desde=None, hasta=None):
    where, params = _filtro_ventas(proveedor, desde, hasta, "v")
    fila = _leer_uno(f"""
        WITH vf AS (
            SELECT v.codigo_cliente, v.nro_documento, v.tipo_documento,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   COALESCE(v.cantidad_unidad_maxima, 0) AS cantidad
            FROM public.ventas v
            WHERE {where}
        ), cobertura AS (
            SELECT COUNT(*) AS clientes
            FROM (
                SELECT codigo_cliente
                FROM vf
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
                FILTER (WHERE tipo_documento IS DISTINCT FROM 'NC')::bigint AS documentos
        FROM vf
    """, params)
    venta = float(fila.get("venta_neta") or 0)
    documentos = int(fila.get("documentos") or 0)
    return {
        "cobertura": int(fila.get("cobertura") or 0),
        "venta_neta": round(venta, 2),
        "cajas": round(float(fila.get("cajas") or 0), 2),
        "documentos": documentos,
        "ticket_documento": round(venta / documentos, 2) if documentos else 0,
    }


def resumen_stock(proveedor):
    fila = _leer_uno("""
        SELECT
            COALESCE(SUM(valor_stock), 0)::double precision AS valor_stock,
            COALESCE(SUM(stock_unidades_maximas), 0)::double precision AS cajas_stock
        FROM public.stock
        WHERE proveedor_codigo = :proveedor
    """, {"proveedor": proveedor})
    return {
        "valor_stock": round(float(fila.get("valor_stock") or 0), 2),
        "cajas_stock": round(float(fila.get("cajas_stock") or 0), 2),
    }


def agrupar_ventas(proveedor, campo, desde=None, hasta=None, top=None):
    columna = CAMPOS_AGRUPABLES_SQL.get(campo)
    if not columna:
        raise ValueError("Campo de agrupación no permitido")

    where, params = _filtro_ventas(proveedor, desde, hasta, "v")
    limite_sql = ""
    if top is not None and int(top) > 0:
        limite_sql = " LIMIT :limite"
        params["limite"] = int(top)

    fila_sql = f"""
        WITH vf AS (
            SELECT v.{columna} AS clave, v.codigo_cliente,
                   v.descripcion_producto,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   COALESCE(v.cantidad_unidad_maxima, 0) AS cantidad
            FROM public.ventas v
            WHERE {where}
        ), totales AS (
            SELECT clave,
                   SUM(importe)::double precision AS venta,
                   SUM(cantidad)::double precision AS cajas
                   {', MAX(descripcion_producto) AS descripcion' if campo == 'codigo_producto' else ''}
            FROM vf
            WHERE clave IS NOT NULL
            GROUP BY clave
        ), por_cliente AS (
            SELECT clave, codigo_cliente, SUM(importe) AS venta_cliente
            FROM vf
            WHERE clave IS NOT NULL AND codigo_cliente IS NOT NULL
            GROUP BY clave, codigo_cliente
        ), cobertura AS (
            SELECT clave, COUNT(*) FILTER (WHERE venta_cliente > 0)::bigint AS cobertura
            FROM por_cliente
            GROUP BY clave
        )
        SELECT t.clave, t.venta, t.cajas,
               COALESCE(c.cobertura, 0)::bigint AS cobertura
               {', t.descripcion' if campo == 'codigo_producto' else ''}
        FROM totales t
        LEFT JOIN cobertura c ON c.clave = t.clave
        ORDER BY cobertura DESC{limite_sql}
    """
    with _engine().connect() as conexion:
        filas = conexion.execute(text(fila_sql), params).mappings().all()
    return [
        {
            "clave": f["clave"],
            "venta": float(f["venta"] or 0),
            "cajas": float(f["cajas"] or 0),
            "cobertura": int(f["cobertura"] or 0),
            **({"descripcion": f.get("descripcion") or f["clave"]} if campo == "codigo_producto" else {}),
        }
        for f in filas
    ]


def ventas_por_semana(proveedor, desde=None, hasta=None):
    where, params = _filtro_ventas(proveedor, desde, hasta, "v")
    sql = f"""
        WITH vf AS (
            SELECT date_trunc('week', v.fecha_documento)::date AS semana,
                   v.codigo_cliente,
                   COALESCE(v.importe_neto_sin_impuesto, 0) AS importe,
                   COALESCE(v.cantidad_unidad_maxima, 0) AS cantidad
            FROM public.ventas v
            WHERE {where}
        ), totales AS (
            SELECT semana, SUM(importe)::double precision AS venta,
                   SUM(cantidad)::double precision AS cajas
            FROM vf GROUP BY semana
        ), por_cliente AS (
            SELECT semana, codigo_cliente, SUM(importe) AS venta_cliente
            FROM vf WHERE codigo_cliente IS NOT NULL
            GROUP BY semana, codigo_cliente
        ), cobertura AS (
            SELECT semana, COUNT(*) FILTER (WHERE venta_cliente > 0)::bigint AS cobertura
            FROM por_cliente GROUP BY semana
        )
        SELECT to_char(t.semana, 'YYYY-MM-DD') AS clave,
               t.venta, t.cajas, COALESCE(c.cobertura, 0)::bigint AS cobertura
        FROM totales t LEFT JOIN cobertura c ON c.semana = t.semana
        ORDER BY cobertura DESC
    """
    with _engine().connect() as conexion:
        filas = conexion.execute(text(sql), params).mappings().all()
    return [
        {"clave": f["clave"], "venta": float(f["venta"] or 0),
         "cajas": float(f["cajas"] or 0), "cobertura": int(f["cobertura"] or 0)}
        for f in filas
    ]


def stock_resumen(proveedor):
    with _engine().connect() as conexion:
        almacenes = conexion.execute(text("""
            SELECT nombre_almacen,
                   COALESCE(SUM(valor_stock), 0)::double precision AS valor,
                   COALESCE(SUM(stock_unidades_maximas), 0)::double precision AS cajas
            FROM public.stock
            WHERE proveedor_codigo = :proveedor
            AND nombre_almacen IS NOT NULL
            GROUP BY nombre_almacen
            ORDER BY valor DESC
        """), {"proveedor": proveedor}).mappings().all()
        productos = conexion.execute(text("""
            SELECT codigo_producto, producto_descripcion,
                   COALESCE(SUM(valor_stock), 0)::double precision AS valor,
                   COALESCE(SUM(stock_unidades_maximas), 0)::double precision AS cajas
            FROM public.stock
            WHERE proveedor_codigo = :proveedor
            AND codigo_producto IS NOT NULL AND producto_descripcion IS NOT NULL
            GROUP BY codigo_producto, producto_descripcion
            ORDER BY valor DESC
        """), {"proveedor": proveedor}).mappings().all()
    return {
        "por_almacen": [dict(f) for f in almacenes],
        "por_producto": [dict(f) for f in productos],
    }


def cargar_ventas(proveedor, desde=None, hasta=None, todas_las_columnas=False):
    """Carga detallada para exportaciones; las vistas no deben usarla para agregar."""
    columnas = "*" if todas_las_columnas else ", ".join(COLS_VENTAS)
    where, params = _filtro_ventas(proveedor, desde, hasta, "v")
    sql = text(f"SELECT {', '.join('v.' + c for c in columnas.split(', ')) if columnas != '*' else '*'} FROM public.ventas v WHERE {where}")
    bloques = []
    with _engine().connect() as conexion:
        resultado = pd.read_sql(
            sql,
            conexion.execution_options(stream_results=True, yield_per=TAMANO_BLOQUE),
            params=params,
            chunksize=TAMANO_BLOQUE,
        )
        for bloque in resultado:
            bloques.append(bloque)
    df = pd.concat(bloques, ignore_index=True) if bloques else pd.DataFrame(columns=[] if todas_las_columnas else COLS_VENTAS)
    for columna in ("cantidad_unidad_maxima", "importe_neto_sin_impuesto"):
        if columna in df.columns:
            df[columna] = pd.to_numeric(df[columna], errors="coerce").fillna(0)
    return df


def cargar_stock(proveedor, todas_las_columnas=False):
    columnas = "*" if todas_las_columnas else (
        "codigo_almacen, nombre_almacen, codigo_producto, producto_descripcion, "
        "stock_unidades_maximas, valor_stock"
    )
    with _engine().connect() as conexion:
        df = pd.read_sql(
            text(f"SELECT {columnas} FROM public.stock WHERE proveedor_codigo = :proveedor"),
            conexion,
            params={"proveedor": proveedor},
        )
    for columna in ("stock_unidades_maximas", "valor_stock"):
        if columna in df.columns:
            df[columna] = pd.to_numeric(df[columna], errors="coerce").fillna(0)
    return df


def iterar_csv(tabla, proveedor, desde=None, hasta=None):
    """Genera CSV por bloques para no guardar toda la exportación en RAM."""
    if tabla == "ventas":
        where, params = _filtro_ventas(proveedor, desde, hasta, "v")
        sql = text(f"SELECT * FROM public.ventas v WHERE {where}")
    elif tabla == "stock":
        params = {"proveedor": proveedor}
        sql = text("SELECT * FROM public.stock WHERE proveedor_codigo = :proveedor")
    else:
        raise ValueError("Tabla de exportación no permitida")

    buffer = io.StringIO(newline="")
    with _engine().connect() as conexion:
        resultado = conexion.execution_options(
            stream_results=True, yield_per=5000
        ).execute(sql, params)
        nombres_columnas = list(resultado.keys())
        indices = [i for i, nombre in enumerate(nombres_columnas) if nombre not in ("id", "proveedor_codigo")]
        encabezados = [nombres_columnas[i] for i in indices]
        escritor = csv.writer(buffer)
        escritor.writerow(encabezados)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)

        while True:
            filas = resultado.fetchmany(5000)
            if not filas:
                break
            escritor.writerows([[fila[i] for i in indices] for fila in filas])
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)
        resultado.close()
