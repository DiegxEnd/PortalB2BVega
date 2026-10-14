"""
medidas.py — TODAS las fórmulas del portal, en un solo lugar.

El navegador nunca calcula nada: pide "/api/resumen" y recibe el número ya
calculado. Si mañana cambias una definición, la cambias en una sola
función de este archivo.

  - Cobertura  = DISTINCT COUNT de codigo_cliente con venta neta > 0
                 (sumando BO + FA + NC) dentro del grupo que se esté mirando.
  - Lo demás   = sumas simples (venta, cajas) sobre las columnas de la tabla.
"""
import pandas as pd


def _cobertura(df):
    """Distinct count de codigo_cliente cuya venta neta (BO+FA+NC) es > 0."""
    if not len(df):
        return 0
    por_cliente = df.groupby('codigo_cliente')['importe_neto_sin_impuesto'].sum()
    return int((por_cliente != 0).sum())


def resumen(df_ventas, df_stock):
    """KPIs principales del período filtrado (pestaña Resumen)."""
    venta_neta = float(df_ventas['importe_neto_sin_impuesto'].sum())
    cajas = float(df_ventas['cantidad_unidad_maxima'].sum())
    documentos = int(df_ventas.loc[df_ventas['tipo_documento'] != 'NC', 'nro_documento'].nunique())
    cobertura = _cobertura(df_ventas)
    return {
        'cobertura': cobertura,
        'venta_neta': round(venta_neta, 2),
        'cajas': round(cajas, 2),
        'documentos': documentos,
        'ticket_documento': round(venta_neta / documentos, 2) if documentos else 0,
        'valor_stock': round(float(df_stock['valor_stock'].sum()), 2) if len(df_stock) else 0,
        'cajas_stock': round(float(df_stock['stock_unidades_maximas'].sum()), 2) if len(df_stock) else 0,
    }


def agrupar(df, campo, top=None):
    """
    Cobertura + venta + cajas agrupados por una columna (canal, tipo de
    negocio, vendedor, producto...). Es el mismo cálculo que alimenta
    todos los gráficos de barras/dona del portal.
    """
    if not len(df):
        return []
    venta = df.groupby(campo)['importe_neto_sin_impuesto'].sum()
    cajas = df.groupby(campo)['cantidad_unidad_maxima'].sum()
    cov = df.groupby([campo, 'codigo_cliente'])['importe_neto_sin_impuesto'].sum().reset_index()
    cov = cov[cov['importe_neto_sin_impuesto'] > 0].groupby(campo)['codigo_cliente'].nunique()
    out = pd.DataFrame({'venta': venta, 'cajas': cajas, 'cobertura': cov}).fillna(0).reset_index()
    out = out.sort_values('cobertura', ascending=False)
    if top:
        out = out.head(top)
    return out.rename(columns={campo: 'clave'}).to_dict('records')


def por_semana(df):
    """Venta y cobertura agrupadas por semana (lunes ISO de fecha_documento)."""
    if not len(df):
        return []
    f = pd.to_datetime(df['fecha_documento'])
    semana = (f - pd.to_timedelta(f.dt.weekday, unit='D')).dt.strftime('%Y-%m-%d')
    tmp = df.assign(_semana=semana)
    return agrupar(tmp, '_semana')


def top_productos(df, n=20):
    """Top SKUs por clientes únicos — ya trae descripcion_producto en la fila, no necesita un cruce aparte."""
    if not len(df):
        return []
    filas = agrupar(df, 'codigo_producto', top=n)
    nombres = df.drop_duplicates('codigo_producto').set_index('codigo_producto')['descripcion_producto']
    for f in filas:
        f['descripcion'] = nombres.get(f['clave'], f['clave'])
    return filas


def stock_resumen(df_stock):
    """Valor de stock por almacén y por producto (pestaña Inventario)."""
    if not len(df_stock):
        return {'por_almacen': [], 'por_producto': []}
    por_almacen = (df_stock.groupby('nombre_almacen')
                   .agg(valor=('valor_stock', 'sum'), cajas=('stock_unidades_maximas', 'sum'))
                   .reset_index().sort_values('valor', ascending=False))
    por_producto = (df_stock.groupby(['codigo_producto', 'producto_descripcion'])
                    .agg(valor=('valor_stock', 'sum'), cajas=('stock_unidades_maximas', 'sum'))
                    .reset_index().sort_values('valor', ascending=False))
    return {
        'por_almacen': por_almacen.to_dict('records'),
        'por_producto': por_producto.to_dict('records'),
    }
