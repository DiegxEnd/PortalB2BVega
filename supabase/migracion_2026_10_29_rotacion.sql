-- =============================================================================
--  MIGRACIÓN 29/10/2026 — rotación por sucursal (Rotacion.csv)
--  Es el mismo dato que usa el Excel "Stock-DI GVD": unidades que salieron de
--  cada almacén (CantidadDS) en NDias días. Con esto los días de inventario
--  por sede se calculan igual que en el Excel. Solo agrega una tabla.
-- =============================================================================
create table if not exists rotacion (
    proveedor_codigo  text not null,
    sede              text not null,
    codigo_producto   text not null,
    cantidad_ds       numeric,
    ndias             integer,
    fecha_proceso     timestamp default now(),
    primary key (proveedor_codigo, sede, codigo_producto)
);
alter table rotacion enable row level security;
