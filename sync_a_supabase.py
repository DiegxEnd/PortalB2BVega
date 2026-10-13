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
}
COLUMNAS_STOCK = {
    'CodigoAlmacen': 'codigo_almacen', 'NombreAlmacen': 'nombre_almacen',
    'CodigoProducto': 'codigo_producto', 'ProductoDescripcion': 'producto_descripcion',
    'Lote': 'lote', 'FechaVencimiento': 'fecha_vencimiento',
    'StockEnUnidadMinima': 'stock_unidad_minima', 'UnidadDeMedidaMinima': 'unidad_medida_minima',
    'StockEnUnidadesMaximas': 'stock_unidades_maximas', 'UnidadDeMedidaMaxima': 'unidad_medida_maxima',
    'ValorStock': 'valor_stock', 'FechaProceso': 'fecha_proceso', 'Periodo': 'periodo',
}


def _conectar():
    url = os.environ.get('SUPABASE_DB_URL')
    if not url:
        print('[ERROR] Falta la variable de entorno SUPABASE_DB_URL. Ver README.md.')
        raise SystemExit(1)
    return psycopg2.connect(url)


def _leer(path, columnas):
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, encoding='latin1', dtype=str)
    df = df[[c for c in columnas if c in df.columns]].rename(columns=columnas)
    df = df.where(pd.notnull(df), None)
    if 'lote' in df.columns:
        # Lote es parte de la llave única de stock: no puede quedar NULL
        # (NULL nunca es "igual" a otro NULL en una restricción unique).
        df['lote'] = df['lote'].fillna('')
    return df


def subir_ventas(conn, proveedor, carpeta):
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
        psycopg2.extras.execute_values(cur, sql, valores, page_size=2000)
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('carpeta', help='Carpeta donde el job dejó los CSV')
    ap.add_argument('proveedor', help='Código del proveedor, ej. peusac')
    ap.add_argument('--todo', action='store_true', help='Sincroniza ventas + stock (uso: tarea de madrugada)')
    ap.add_argument('--solo-stock', action='store_true', help='Sincroniza solo stock (uso: tarea cada hora)')
    args = ap.parse_args()

    if not args.todo and not args.solo_stock:
        args.todo = True  # por defecto, sincroniza todo

    conn = _conectar()
    try:
        if args.todo:
            print('Sincronizando ventas...')
            subir_ventas(conn, args.proveedor, args.carpeta)
        print('Sincronizando stock...')
        subir_stock(conn, args.proveedor, args.carpeta)
    finally:
        conn.close()
    print('Listo.')


if __name__ == '__main__':
    main()
