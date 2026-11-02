-- =============================================================================
--  MIGRACIÓN 30/10/2026 — línea y marca en cada venta
--  Vienen en VentasActual/VentaHistorica.csv (columnas Linea y Marca del ERP).
--  Solo agrega columnas.
-- =============================================================================
alter table ventas add column if not exists linea text;
alter table ventas add column if not exists marca text;
