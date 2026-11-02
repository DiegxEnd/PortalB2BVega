-- =============================================================================
--  MIGRACIÓN 30/10/2026 — maestro de productos completo
--  linea y marca: del ERP (Rotacion.csv).
--  sku_proveedor: nombre del producto según PEUSAC (CategoriaProveedor.xlsx).
--  Solo agrega columnas.
-- =============================================================================
alter table productos add column if not exists linea          text;
alter table productos add column if not exists marca          text;
alter table productos add column if not exists sku_proveedor  text;
