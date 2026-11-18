-- =============================================================================
--  Ventas del año anterior (pedido PEUSAC, nov 2026: comparativos contra el
--  mismo mes del año anterior).
--
--  ventas_historico guarda los años cerrados con solo las columnas que usan
--  los cálculos (sin descripciones, origen, unidades, moneda ni fecha de
--  proceso, y sin la llave única): ocupa ~1/4 de lo que ocuparía en ventas y
--  así entra en el plan de Supabase.
--
--  ventas_todo une las dos tablas; el portal lee siempre de la vista. Una
--  fecha vive en una sola de las dos tablas (sync_a_supabase.py se encarga),
--  así que nunca se duplica.
-- =============================================================================

create table if not exists ventas_historico (
    proveedor_codigo           text not null,
    tipo_documento             text,
    nro_documento              text,
    fecha_documento            date not null,
    codigo_cliente             text,
    canal                      text,
    tipo_negocio               text,
    jefe_ventas                text,
    supervisor                 text,
    codigo_vendedor            text,
    ruta                       text,
    codigo_producto            text not null,
    cantidad_unidad_maxima     numeric,
    importe_neto_sin_impuesto  numeric,
    sede                       text,
    distrito                   text,
    linea                      text,
    marca                      text
);

create index if not exists ix_ventas_historico_proveedor_fecha
    on ventas_historico (proveedor_codigo, fecha_documento);

alter table ventas_historico enable row level security;
revoke all on ventas_historico from anon, authenticated;

-- security_invoker: la vista respeta el RLS de las tablas (si no, quedaría
-- leíble desde la API pública de Supabase).
create or replace view ventas_todo with (security_invoker = on) as
select proveedor_codigo, tipo_documento, nro_documento, fecha_documento, origen,
       codigo_cliente, canal, tipo_negocio, jefe_ventas, supervisor, codigo_vendedor,
       ruta, numero_item, codigo_producto, descripcion_producto,
       cantidad_unidad_minima, tipo_unidad_minima, cantidad_unidad_maxima, tipo_unidad_maxima,
       importe_neto_sin_impuesto, importe_neto_con_impuesto, sede, distrito, linea, marca
from ventas
union all
select proveedor_codigo, tipo_documento, nro_documento, fecha_documento, null,
       codigo_cliente, canal, tipo_negocio, jefe_ventas, supervisor, codigo_vendedor,
       ruta, null, codigo_producto, null,
       null, null, cantidad_unidad_maxima, null,
       importe_neto_sin_impuesto, null, sede, distrito, linea, marca
from ventas_historico;

revoke all on ventas_todo from anon, authenticated;

-- Fécula de yuca y camotina pasan a Repostería (pedido PEUSAC, nov 2026).
update productos set categoria = 'REPOSTERÍA'
where codigo_producto in ('762107', '762108');
