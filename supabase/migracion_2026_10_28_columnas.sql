-- =============================================================================
--  MIGRACIÓN 28/10/2026 — pedidos de PEUSAC (correo 27/10)
--  Solo AGREGA columnas/tablas (todas aceptan NULL), no borra nada: lo que
--  viene del CSV se guarda completo y la descarga elige qué columnas mostrar.
-- =============================================================================

-- Ventas: vienen en el CSV como "Sucursal" y "Distrito".
alter table ventas add column if not exists sede     text;
alter table ventas add column if not exists distrito text;

-- Stock: viene en el CSV como "Factor Maximo" (unidades por caja).
alter table stock add column if not exists factor numeric;

-- Maestro de productos por proveedor (clasificación de PEUSAC).
-- Hace match con codigo_producto de ventas y stock.
create table if not exists productos (
    proveedor_codigo  text not null,
    codigo_producto   text not null,
    descripcion       text,
    codigo_proveedor  text,
    categoria         text,
    primary key (proveedor_codigo, codigo_producto)
);
alter table productos enable row level security;

-- Precarga los productos que ya existen, con código y categoría en blanco
-- para completarlos desde el Table Editor de Supabase o con Productos.csv.
insert into productos (proveedor_codigo, codigo_producto, descripcion)
select proveedor_codigo, codigo_producto, max(descripcion_producto)
from ventas
group by proveedor_codigo, codigo_producto
on conflict do nothing;

insert into productos (proveedor_codigo, codigo_producto, descripcion)
select proveedor_codigo, codigo_producto, max(producto_descripcion)
from stock
group by proveedor_codigo, codigo_producto
on conflict do nothing;

-- Almacén -> sede, para cruzar el stock con la sucursal de las ventas
-- (días de inventario por sede). La sede debe escribirse igual que en
-- la columna Sucursal del CSV de ventas.
create table if not exists almacenes (
    codigo_almacen  text primary key,
    nombre_almacen  text,
    sede            text
);
alter table almacenes enable row level security;

insert into almacenes (codigo_almacen, nombre_almacen)
select codigo_almacen, max(nombre_almacen)
from stock
group by codigo_almacen
on conflict do nothing;

-- Índice duplicado (ix_ventas_proveedor_fecha ya cubre lo mismo).
drop index if exists idx_ventas_proveedor_fecha;
