# Portal B2B de Proveedores — Flask + Supabase

## El flujo completo, de punta a punta

```
Tu servidor (Windows)                    Supabase (nube, gratis)         Render (nube, gratis)
──────────────────────                   ──────────────────────         ─────────────────────
Task Scheduler, madrugada:
  1. Refresca el cubo Excel
  2. Exporta VentasActual.csv,
     VentaHistorica.csv, Stock.csv
  3. sync_a_supabase.py --todo    ─────▶  Postgres: tablas               Flask lee de Supabase
                                          "ventas" y "stock"              por fetch() del navegador
Task Scheduler, cada hora:                                               (nunca del disco local
  1. Exporta solo Stock.csv                                               ni del servidor on-prem)
  2. sync_a_supabase.py --solo-stock ──▶
```

Supabase es el punto de encuentro entre tu servidor (que solo es
alcanzable dentro de tu red) y el portal (que vive en internet, en
Render). Sin algo así en el medio, Render no tiene ninguna forma de leer
un archivo en tu máquina.

## Por qué una sola tabla "ventas" (no "actual" + "histórico")

Comprobé contra tus archivos reales que `VentasActual.csv` y
`VentaHistorica.csv` **se solapan** (todo septiembre aparece igual en los
dos). En vez de reimplementar en código la lógica de "cuál gana", dejamos
que Postgres lo resuelva con una restricción `UNIQUE` sobre
`(proveedor, nro_documento, codigo_producto, numero_item)`: cargar la
misma fila dos veces simplemente la actualiza, nunca la duplica. El
filtro de fechas del portal nunca necesita saber de qué archivo vino cada
fila — ya está todo junto. Lo probé con tus 409,134 filas de origen
(52,272 + 356,862) y terminaron en 365,114 filas únicas en la base, el
número exacto esperado descontando el solape.

## 1) Crear el proyecto en Supabase (gratis)

1. Entra a [supabase.com](https://supabase.com) → crea cuenta gratis → "New
   Project" (elige una contraseña para la base — apúntala).
2. Project Settings → Database → Connection string → copia la de modo
   **Session** (o Transaction) y reemplaza `[YOUR-PASSWORD]` por la que
   pusiste. Se ve así:
   ```
   postgresql://postgres.xxxx:tu-password@aws-0-xxx.pooler.supabase.com:5432/postgres
   ```
3. Project → SQL Editor → New query → pega todo el contenido de
   `supabase/schema.sql` → Run. Esto crea las tablas `ventas` y `stock`.

## 2) Sincronizar tus datos (desde tu servidor)

```bash
pip install -r requirements.txt
set SUPABASE_DB_URL="postgresql://postgres.wguosfptraaymaaxxsza:3bI7bBV0OFsE5svN@aws-1-ca-central-1.pooler.supabase.com:5432/postgres"         (Windows, en la misma sesión)
python sync_a_supabase.py "C:\Users\nunovero.d\Desktop\Diego\Proyectos\Proyecto Web\BD Peusac" peusac --todo
```

Luego programa esto en el Task Scheduler, **dos tareas**:
- **Madrugada** (como ya tienes): después de refrescar el Excel y exportar
  los 3 CSV, corre `sync_a_supabase.py <carpeta> peusac --todo`.
- **Cada hora**: tu proceso exporta solo `Stock.csv` a la misma carpeta, y
  corre `sync_a_supabase.py <carpeta> peusac --solo-stock`.

No hace falta correr nada a mano una vez programadas las dos tareas — el
portal se actualiza solo, y la pestaña del portal te muestra "Datos
sincronizados hace X min/h" (con un punto verde/ámbar/rojo según qué tan
reciente sea) para que tú y el proveedor sepan si algo dejó de correr.

## 3) Crear el usuario del proveedor

```bash
python crear_usuario.py
```

Pide usuario, contraseña y el código de proveedor (el mismo que usaste en
`sync_a_supabase.py`, ej. `peusac`), e imprime la línea lista para pegar
en `USUARIOS` dentro de `auth.py`. La contraseña en texto plano nunca
queda guardada en ningún archivo — solo su hash.

## 4) Probar en tu máquina

```bash
set SUPABASE_DB_URL=postgresql://...
python app.py
```

Abre `http://127.0.0.1:5000`.

## 5) Subir a Render (gratis)

1. Sube esta carpeta a un repositorio de GitHub (el `.gitignore` ya
   excluye lo que no debe ir). Como ya no hay CSV con datos reales en el
   repo (viven en Supabase, no en archivos), el repo puede ser público
   sin problema de exponer datos.
2. [render.com](https://render.com) → cuenta gratis (no pide tarjeta) →
   "New" → "Web Service" → conecta el repositorio. Detecta `render.yaml`
   solo.
3. Antes de darle "Create", agrega la variable de entorno
   `SUPABASE_DB_URL` con el valor del paso 1 (`render.yaml` la deja
   preparada pero vacía a propósito, porque es secreta — nunca se sube al
   repo).
4. "Create Web Service". Primer deploy tarda unos minutos y te da una URL
   tipo `https://portal-b2b-proveedores.onrender.com` — esa se la
   compartes al proveedor.

**Nota del plan gratis de Render:** si nadie entra por 15 minutos, el
servicio se duerme y la siguiente visita tarda ~30-50 segundos en
despertar. Supabase (plan free) también pausa el proyecto tras 1 semana
sin actividad — como tus jobs lo tocan todos los días, nunca llegará a
pausarse.

## 6) Agregar más proveedores

Repite el paso 2 (sync) y el paso 3 (usuario) con el código de proveedor
nuevo — todos comparten las mismas tablas `ventas`/`stock`, separados por
la columna `proveedor_codigo`. Cada consulta del portal siempre filtra
por el proveedor de la SESIÓN (nunca por algo que mande el navegador), así
que un proveedor nunca puede ver los datos de otro aunque compartan tabla.

## Paquete de Datos — qué exporta exactamente

El botón "Descargar CSV" trae **todas las columnas originales** de cada
tabla (no solo las que usa el dashboard) — es un `SELECT *`. Ventas sale
ya unificada: si el rango que pides cruza "lo que antes era histórico y
lo que antes era actual", el proveedor nunca lo nota, descarga un único
bloque de filas sin huecos ni duplicados.

## Seguridad — qué sí y qué no resuelve esto

- Las contraseñas se comparan por hash (`werkzeug.security`), nunca en
  texto plano.
- Cada respuesta de `/api/...` está filtrada por el proveedor de la
  sesión — nunca por un parámetro que mande el navegador.
- La cookie de sesión es `HttpOnly` y, en Render (HTTPS), además `Secure`.
- Las tablas de Supabase tienen Row Level Security activado y el portal
  se conecta con la connection string directa de Postgres (no con la API
  REST pública) — inalcanzables desde el navegador del proveedor bajo
  cualquier circunstancia.
- Lo que **falta** si quieres ir más allá: límite de intentos de login,
  rotar `SECRET_KEY` periódicamente. No es necesario para una primera
  versión, pero es la siguiente capa si esto escala.
