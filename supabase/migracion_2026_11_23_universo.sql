-- =============================================================================
--  Universo de clientes de Grupo Vega por sede y distrito (pedido PEUSAC,
--  nov 2026: penetración = clientes PEUSAC ÷ universo). Una foto por mes, de
--  la consulta a vHelpYam (Activo=1, DireccionActivo=1, DireccionPrincipal=1);
--  se carga con: python sync_a_supabase.py <carpeta> peusac --universo
--  No depende del proveedor: es la cartera de Vega.
-- =============================================================================

create table if not exists universo (
    periodo    text not null,      -- 'YYYY-MM' del mes de la foto
    sede       text not null,
    distrito   text not null,
    clientes   integer not null,
    constraint universo_pk primary key (periodo, sede, distrito)
);

alter table universo enable row level security;
revoke all on universo from anon, authenticated;
