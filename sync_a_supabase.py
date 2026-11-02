#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
sync_a_supabase.py — sube los CSV que el job nocturno/horario deja en una
carpeta de tu servidor, hacia las tablas de Supabase. Esto es lo que
conecta tu servidor (Windows, en Grupo Vega) con el portal (hospedado en
Render, en la nube) — sin esto, Render no tiene forma de leer un archivo
que vive en tu máquina.

CÓMO SE PROGRAMA (dos tareas en el Task Scheduler)
----------------------------------------------------------------------
1) Tarea de madrugada (igual que ya tienes): refresca el Excel, exporta
   VentasActual.csv + VentaHistorica.csv + Stock.csv a una carpeta, y
   justo después corre:

       python sync_a_supabase.py "C:\ruta\carpeta" peusac --todo

2) Tarea cada hora (nueva, solo para que el stock no quede desactualizado
   durante el día): tu proceso exporta solo Stock.csv a esa misma carpeta,
   y corre:

       python sync_a_supabase.py "C:\ruta\carpeta" peusac --solo-stock

Nunca hace falta correr esto a mano: una vez programadas las dos tareas,
el portal se actualiza solo. Puedes ver cuándo fue la última sincronización
en la pestaña "Paquete de Datos" del portal (usa FechaProceso del CSV).

Variable de entorno que necesita (ver README.md):
    SUPABASE_DB_URL   la "Connection string" de tu proyecto de Supabase
                       (Project Settings > Database > Connection string >
                       modo "Transaction" o "Session", con tu contraseña
                       ya puesta en la URL)
"""

import os
import sys
import argparse
import re
import unicodedata
import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
load_dotenv()

COLUMNAS_VENTAS = {
    'TipoDocumento': 'tipo_documento', 'NroDocumento': 'nro_documento',
    'FechaDocumento': 'fecha_documento', 'Origen': 'origen', 'CodigoCliente': 'codigo_cliente',
    'Canal': 'canal', 'TipoNegocio': 'tipo_negocio', 'JefeVentas': 'jefe_ventas',
    'Supervisor': 'supervisor', 'CodigoVendedor': 'codigo_vendedor', 'Ruta': 'ruta',
    'NumeroItem': 'numero_item', 'CodigoProducto': 'codigo_producto',
    'DescripcionProducto': 'descripcion_producto', 'CantidadUnidadMinima': 'cantidad_unidad_minima',
    'TipoUnidadMinima': 'tipo_unidad_minima', 'CantidadUnidadMaxima': 'cantidad_unidad_maxima',
    'TipoUnidadMaxima': 'tipo_unidad_maxima', 'Moneda': 'moneda',
    'ImporteNetoSinImpuesto': 'importe_neto_sin_impuesto', 'ImporteNetoConImpuesto': 'importe_neto_con_impuesto',
    'TipoVenta': 'tipo_venta', 'FechaProceso': 'fecha_proceso',
    # Pedidas por PEUSAC (27/10).
    'Sucursal': 'sede', 'Sede': 'sede', 'Distrito': 'distrito',
    'Linea': 'linea', 'Marca': 'marca',
}
COLUMNAS_STOCK = {
    'CodigoAlmacen': 'codigo_almacen', 'NombreAlmacen': 'nombre_almacen',
    'CodigoProducto': 'codigo_producto', 'ProductoDescripcion': 'producto_descripcion',
    'Lote': 'lote', 'FechaVencimiento': 'fecha_vencimiento',
    'StockEnUnidadMinima': 'stock_unidad_minima', 'UnidadDeMedidaMinima': 'unidad_medida_minima',
    'StockEnUnidadesMaximas': 'stock_unidades_maximas', 'UnidadDeMedidaMaxima': 'unidad_medida_maxima',
    'ValorStock': 'valor_stock', 'FechaProceso': 'fecha_proceso', 'Periodo': 'periodo',
    'FactorMaximo': 'factor', 'Factor': 'factor',
}
# Maestro de productos (categoría y código según la clasificación de PEUSAC).
# Productos.csv es opcional: si no está en la carpeta, se omite.
COLUMNAS_PRODUCTOS = {
    'CodigoProducto': 'codigo_producto', 'CodigosVega': 'codigo_producto', 'CodigoVega': 'codigo_producto',
    'Descripcion': 'descripcion', 'DescripcionVega': 'descripcion',
    'CodigoProveedor': 'codigo_proveedor', 'CodigoSAPProveedor': 'codigo_proveedor',
    'SkuProveedor': 'sku_proveedor',
    'Categoria': 'categoria', 'CategoriaProveedor': 'categoria',
}

# Rotación por sucursal (mismo dato que el Excel "Stock-DI GVD"): unidades que
# salieron de cada almacén en NDias días. Rotacion.csv es opcional.
COLUMNAS_ROTACION = {
    'Sucursal': 'sede', 'CodProducto': 'codigo_producto', 'CodigoProducto': 'codigo_producto',
    'CantidadDS': 'cantidad_ds', 'NDias': 'ndias',
}


def _conectar():
    url = os.environ.get('SUPABASE_DB_URL')
    if not url:
        print('[ERROR] Falta la variable de entorno SUPABASE_DB_URL. Ver README.md.')
        raise SystemExit(1)
    return psycopg2.connect(url)


def _normalizar(nombre):
    """'Factor Maximo', 'FACTOR_MÁXIMO' y 'FactorMaximo' cuentan como la misma columna."""
    nombre = unicodedata.normalize('NFKD', str(nombre)).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', nombre.lower())


def _leer(path, columnas):
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, encoding='latin1', dtype=str)
    destino = {_normalizar(origen): final for origen, final in columnas.items()}
    renombrar = {}
    for c in df.columns:
        final = destino.get(_normalizar(c))
        if final and final not in renombrar.values():
            renombrar[c] = final
    df = df[list(renombrar)].rename(columns=renombrar)
    df = df.where(pd.notnull(df), None)
    if 'lote' in df.columns:
        # Lote es parte de la llave única de stock: no puede quedar NULL
        # (NULL nunca es "igual" a otro NULL en una restricción unique).
        df['lote'] = df['lote'].fillna('')
    return df


def subir_ventas(conn, proveedor, carpeta, reemplazar=False):
    """
    Por defecto inserta o actualiza (upsert) y nunca borra. Con reemplazar=True,
    antes borra las ventas del proveedor en el rango de fechas que traen los CSV
    (todo en una sola transacción): así desaparecen las filas que ya no vienen
    del ERP (documentos anulados o líneas duplicadas por cargas anteriores).
    """
    partes = []
    for nombre in ['VentasActual.csv', 'VentaHistorica.csv']:
        df = _leer(os.path.join(carpeta, nombre), COLUMNAS_VENTAS)
        if df is not None:
            print(f'  {nombre}: {len(df):,} filas')
            partes.append(df)
    if not partes:
        print('  (no se encontró VentasActual.csv ni VentaHistorica.csv, se omite)')
        return
    df = pd.concat(partes, ignore_index=True)
    # Si la misma fila viene en los dos archivos (se solapan, es esperado),
    # nos quedamos con una sola copia antes de mandarla — upsert igual la
    # protege, pero así evitamos mandar filas de más por la red.
    df = df.drop_duplicates(subset=['nro_documento', 'codigo_producto', 'numero_item'])
    df.insert(0, 'proveedor_codigo', proveedor)

    cols = list(df.columns)
    valores = [tuple(r) for r in df.itertuples(index=False, name=None)]
    sql = f"""
        insert into ventas ({', '.join(cols)})
        values %s
        on conflict (proveedor_codigo, nro_documento, codigo_producto, numero_item)
        do update set {', '.join(f"{c} = excluded.{c}" for c in cols if c not in ('proveedor_codigo', 'nro_documento', 'codigo_producto', 'numero_item'))}
    """
    with conn.cursor() as cur:
        if reemplazar:
            desde, hasta = df['fecha_documento'].min(), df['fecha_documento'].max()
            cur.execute('delete from ventas where proveedor_codigo = %s and fecha_documento between %s and %s',
                        (proveedor, desde, hasta))
            print(f'  -> {cur.rowcount:,} filas anteriores borradas ({desde} a {hasta}).')
        psycopg2.extras.execute_values(cur, sql, valores, page_size=2000)
        if 'linea' in df.columns or 'marca' in df.columns:
            # Línea y marca de cada producto según su venta más reciente: así el
            # stock y la rotación (que no las traen) también se pueden filtrar.
            cur.execute('''
                insert into productos (proveedor_codigo, codigo_producto, linea, marca)
                select distinct on (codigo_producto) proveedor_codigo, codigo_producto, linea, marca
                from ventas
                where proveedor_codigo = %s and (linea is not null or marca is not null)
                order by codigo_producto, fecha_documento desc
                on conflict (proveedor_codigo, codigo_producto) do update
                set linea = COALESCE(excluded.linea, productos.linea),
                    marca = COALESCE(excluded.marca, productos.marca)
            ''', (proveedor,))
    conn.commit()
    print(f'  -> {len(df):,} filas de venta sincronizadas (insertadas o actualizadas).')


def subir_stock(conn, proveedor, carpeta):
    df = _leer(os.path.join(carpeta, 'Stock.csv'), COLUMNAS_STOCK)
    if df is None:
        print('  (no se encontró Stock.csv, se omite)')
        return
    df.insert(0, 'proveedor_codigo', proveedor)
    cols = list(df.columns)
    valores = [tuple(r) for r in df.itertuples(index=False, name=None)]
    with conn.cursor() as cur:
        # El stock es una FOTO completa cada vez (no incremental): se
        # reemplaza entero para este proveedor antes de insertar la nueva.
        cur.execute('delete from stock where proveedor_codigo = %s', (proveedor,))
        sql = f"insert into stock ({', '.join(cols)}) values %s"
        psycopg2.extras.execute_values(cur, sql, valores, page_size=2000)
    conn.commit()
    print(f'  -> {len(df):,} filas de stock sincronizadas (reemplazo completo).')


def _sede_rotacion(sucursal):
    """'VEGA SUR (LURIN)' -> 'VEGA SUR', para que coincida con la Sucursal de las ventas."""
    return re.sub(r'\s*\(.*\)\s*$', '', str(sucursal)).strip()


def subir_rotacion(conn, proveedor, carpeta):
    df = _leer(os.path.join(carpeta, 'Rotacion.csv'), COLUMNAS_ROTACION)
    if df is None:
        print('  (no se encontró Rotacion.csv, se omite)')
        return
    df = df.dropna(subset=['sede', 'codigo_producto'])
    df['sede'] = df['sede'].map(_sede_rotacion)
    df['codigo_producto'] = df['codigo_producto'].str.strip()
    df['cantidad_ds'] = pd.to_numeric(df['cantidad_ds'], errors='coerce').fillna(0)
    df['ndias'] = pd.to_numeric(df['ndias'], errors='coerce')

    # El archivo puede traer todos los proveedores: se queda solo con los
    # productos que este proveedor tiene en stock o en ventas.
    with conn.cursor() as cur:
        cur.execute("""
            select codigo_producto from stock where proveedor_codigo = %s
            union select codigo_producto from productos where proveedor_codigo = %s
        """, (proveedor, proveedor))
        propios = {fila[0] for fila in cur.fetchall()}
    df = df[df['codigo_producto'].isin(propios)]
    df = df.groupby(['sede', 'codigo_producto'], as_index=False).agg(cantidad_ds=('cantidad_ds', 'sum'), ndias=('ndias', 'max'))
    df.insert(0, 'proveedor_codigo', proveedor)
    valores = [(r.proveedor_codigo, r.sede, r.codigo_producto, float(r.cantidad_ds),
                None if pd.isna(r.ndias) else int(r.ndias)) for r in df.itertuples(index=False)]
    with conn.cursor() as cur:
        # Como el stock, la rotación es una foto completa: se reemplaza entera.
        cur.execute('delete from rotacion where proveedor_codigo = %s', (proveedor,))
        psycopg2.extras.execute_values(cur, """
            insert into rotacion (proveedor_codigo, sede, codigo_producto, cantidad_ds, ndias) values %s
        """, valores, page_size=2000)
    conn.commit()
    print(f'  -> {len(valores):,} filas de rotación sincronizadas ({df["sede"].nunique()} sucursales).')


def _leer_maestro(carpeta):
    """
    Maestro de productos de PEUSAC: CategoriaProveedor.xlsx (o Productos.csv).
    Cruza por el código Vega y trae código y categoría del proveedor.
    """
    xlsx = os.path.join(carpeta, 'CategoriaProveedor.xlsx')
    if os.path.exists(xlsx):
        crudo = pd.read_excel(xlsx, dtype=str)
        destino = {_normalizar(o): f for o, f in COLUMNAS_PRODUCTOS.items()}
        renombrar = {}
        for c in crudo.columns:
            final = destino.get(_normalizar(c))
            if final and final not in renombrar.values():
                renombrar[c] = final
        df = crudo[list(renombrar)].rename(columns=renombrar)
        return df.where(pd.notnull(df), None), 'CategoriaProveedor.xlsx'
    return _leer(os.path.join(carpeta, 'Productos.csv'), COLUMNAS_PRODUCTOS), 'Productos.csv'


def subir_productos(conn, proveedor, carpeta):
    """
    Maestro de PEUSAC (CategoriaProveedor.xlsx o Productos.csv): código y
    categoría del proveedor por código Vega. No es parte de la carga diaria:
    se corre con --maestro solo cuando el archivo cambia.
    """
    df, origen = _leer_maestro(carpeta)
    if df is None:
        print('  (no se encontró CategoriaProveedor.xlsx ni Productos.csv, se omite)')
        return
    df = df.dropna(subset=['codigo_producto']).copy()
    df['codigo_producto'] = df['codigo_producto'].astype(str).str.strip()
    for c in df.columns:
        if c != 'codigo_producto':
            df[c] = df[c].map(lambda x: str(x).strip() if x is not None and not pd.isna(x) and str(x).strip() else None)
    df = df[df['codigo_producto'] != ''].drop_duplicates(subset=['codigo_producto'])
    df.insert(0, 'proveedor_codigo', proveedor)

    cols = list(df.columns)
    valores = [tuple(None if pd.isna(v) else v for v in r) for r in df.itertuples(index=False, name=None)]
    # Un campo vacío en el archivo no borra lo que ya había (p. ej. la descripción de las ventas).
    sql = f"""
        insert into productos ({', '.join(cols)})
        values %s
        on conflict (proveedor_codigo, codigo_producto)
        do update set {', '.join(f"{c} = COALESCE(excluded.{c}, productos.{c})" for c in cols if c not in ('proveedor_codigo', 'codigo_producto'))}
    """
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, sql, valores, page_size=2000)
    conn.commit()
    con_cat = df['categoria'].notna().sum() if 'categoria' in df else 0
    print(f'  -> {len(df):,} productos del maestro sincronizados ({origen}: {con_cat} con categoría).')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('carpeta', help='Carpeta donde el job dejó los CSV')
    ap.add_argument('proveedor', help='Código del proveedor, ej. peusac')
    ap.add_argument('--todo', action='store_true', help='Sincroniza ventas + stock (uso: tarea de madrugada)')
    ap.add_argument('--solo-stock', action='store_true', help='Sincroniza solo stock (uso: tarea cada hora)')
    ap.add_argument('--maestro', action='store_true',
                    help='Carga solo el maestro de productos (CategoriaProveedor.xlsx); no es parte de la carga diaria')
    ap.add_argument('--reemplazar', action='store_true',
                    help='Borra las ventas del rango de fechas de los CSV antes de cargarlas (recarga limpia)')
    args = ap.parse_args()

    if args.maestro:
        conn = _conectar()
        try:
            print('Sincronizando maestro de productos...')
            subir_productos(conn, args.proveedor, args.carpeta)
        finally:
            conn.close()
        print('Listo.')
        return

    if not args.todo and not args.solo_stock:
        args.todo = True  # por defecto, sincroniza todo

    conn = _conectar()
    try:
        if args.todo:
            print('Sincronizando ventas...')
            subir_ventas(conn, args.proveedor, args.carpeta, reemplazar=args.reemplazar)
        print('Sincronizando stock...')
        subir_stock(conn, args.proveedor, args.carpeta)
        print('Sincronizando rotación...')
        subir_rotacion(conn, args.proveedor, args.carpeta)
    finally:
        conn.close()
    print('Listo.')


if __name__ == '__main__':
    main()
