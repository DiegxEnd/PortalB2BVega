-- =============================================================================
--  ESQUEMA DE SUPABASE — Portal B2B de Proveedores
--  Corre esto UNA SOLA VEZ en Supabase: Project > SQL Editor > New query > pega
--  todo esto > Run.
--
--  Por qué UNA sola tabla "ventas" en vez de "actual" + "historico":
--  Confirmé contra tus archivos reales que VentasActual.csv y
--  VentaHistorica.csv se SOLAPAN (septiembre aparece idéntico en los dos).
--  En vez de reimplementar esa lógica de "cuál gana" en el código, dejamos
--  que Postgres lo resuelva solo: una llave única (NroDocumento +
--  CodigoProducto + NumeroItem) hace que cargar la misma fila dos veces
--  simplemente la actualice, nunca la duplique. El filtro por fecha en el
--  portal nunca necesita saber de qué archivo vino cada fila — ya está
--  todo en el mismo lugar.
-- =============================================================================

create table if not exists ventas (
    id                      bigserial primary key,
    proveedor_codigo        text not null,
    tipo_documento          text,
    nro_documento           text not null,
    fecha_documento         date not null,
    origen                  text,
    codigo_cliente          text,
    canal                   text,
    tipo_negocio            text,
    jefe_ventas             text,
    supervisor              text,
    codigo_vendedor         text,
    ruta                    text,
    numero_item             text not null,
    codigo_producto         text not null,
    descripcion_producto    text,
    cantidad_unidad_minima  numeric,
    tipo_unidad_minima      text,
    cantidad_unidad_maxima  numeric,
    tipo_unidad_maxima      text,
    moneda                  text,
    importe_neto_sin_impuesto  numeric,
    importe_neto_con_impuesto  numeric,
    tipo_venta              text,
    fecha_proceso           timestamp,
    -- la llave que hace posible el upsert sin duplicar ni perder filas:
    constraint ventas_unica unique (proveedor_codigo, nro_documento, codigo_producto, numero_item)
);

-- el índice que hace rápido cualquier filtro por rango de fechas,
-- sin importar si son 50 mil filas o 5 millones
create index if not exists ix_ventas_proveedor_fecha on ventas (proveedor_codigo, fecha_documento);

create table if not exists stock (
    id                        bigserial primary key,
    proveedor_codigo          text not null,
    codigo_almacen            text not null,
    nombre_almacen            text,
    codigo_producto           text not null,
    producto_descripcion      text,
    lote                      text not null default '',
    fecha_vencimiento         date,
    stock_unidad_minima       numeric,
    unidad_medida_minima      text,
    stock_unidades_maximas    numeric,
    unidad_medida_maxima      text,
    valor_stock               numeric,
    fecha_proceso             timestamp,
    periodo                   text,
    constraint stock_unico unique (proveedor_codigo, codigo_almacen, codigo_producto, lote)
);

create index if not exists ix_stock_proveedor on stock (proveedor_codigo);

-- Row Level Security: lo dejamos cerrado por defecto. El portal Flask se
-- conecta con la connection string "directa" de Postgres (no con la API
-- REST pública), así que estas tablas quedan inalcanzables desde el
-- navegador del proveedor bajo cualquier circunstancia — ni con RLS
-- bien o mal configurado de por medio.
alter table ventas enable row level security;
alter table stock enable row level security;
