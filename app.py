#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — Portal B2B de proveedores, backend Flask + Supabase.

Flujo completo (ver README.md para el detalle):
    Tu servidor (Task Scheduler, madrugada + cada hora)
        -> exporta CSV a una carpeta-
        -> sync_a_supabase.py sube esos CSV a Supabase (Postgres)
    Este Flask (hospedado en Render)
        -> se conecta a Supabase con SUPABASE_DB_URL
        -> nunca lee nada del disco local ni del servidor on-prem

Los datos y las credenciales nunca llegan al navegador hasta que el
servidor valida la sesión — "Ver código fuente" no muestra nada.
"""
import io
import os
import tempfile
import threading
import time
import zipfile
from functools import wraps

from flask import Flask, render_template, request, redirect, url_for, session, jsonify, Response, stream_with_context, abort, send_file

import auth
import db
import hallazgos

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'cambia-esto-en-produccion-no-uses-el-default')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = os.environ.get('RENDER', '') != ''


# ---------------------------------------------------------------------------
#  Precalentado de caché: al arrancar (y cada 25 min) se calcula lo que todo
#  el mundo ve primero —"Este mes" sin filtros—, así el primer usuario no
#  espera las consultas en frío. Las llamadas usan exactamente los mismos
#  argumentos que los endpoints para que caigan en la misma llave de caché.
# ---------------------------------------------------------------------------
PRECALENTAR_CADA = 25 * 60
# Espera antes del primer precalentado: el servidor termina de arrancar y queda
# atendiendo a los usuarios antes de que este hilo empiece a consultar.
PRECALENTAR_ESPERA = 20


def _precalentar_proveedor(proveedor):
    minimo, maximo = db.rango_disponible(proveedor)
    if not maximo:
        return
    db.ultima_sincronizacion(proveedor)
    db.opciones_filtros(proveedor)
    inicio = maximo[:8] + '01'
    db.resumen_ventas(proveedor, inicio, maximo, ())
    db.resumen_stock(proveedor, ())
    db.agrupar_ventas(proveedor, 'mes', minimo, maximo, None, (), 'venta')
    for campo in ('semana', 'canal', 'dia_semana', 'sede', 'categoria'):
        db.agrupar_ventas(proveedor, campo, inicio, maximo, None, (), 'venta')
    db.agrupar_ventas(proveedor, 'codigo_producto', inicio, maximo, 10, (), 'venta')
    hallazgos.calcular(proveedor, inicio, maximo, ())


def _precalentar():
    proveedores = sorted({u['proveedor_codigo'] for u in auth.USUARIOS.values()})
    time.sleep(PRECALENTAR_ESPERA)
    while True:
        for proveedor in proveedores:
            inicio = time.monotonic()
            try:
                _precalentar_proveedor(proveedor)
                app.logger.warning('Caché precalentada para %s en %.1f s', proveedor, time.monotonic() - inicio)
            except Exception:
                app.logger.exception('No se pudo precalentar la caché de %s', proveedor)
        time.sleep(PRECALENTAR_CADA)


if os.environ.get('PRECALENTAR', '1') == '1':
    threading.Thread(target=_precalentar, name='precalentar', daemon=True).start()


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if 'usuario' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'no autenticado'}), 401
            return redirect(url_for('login'))
        return fn(*a, **kw)
    return wrapper


@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        u = auth.verificar_credenciales(request.form.get('usuario', ''), request.form.get('password', ''))
        if u:
            session.clear()
            session['usuario'] = request.form['usuario'].strip().lower()
            session['proveedor_codigo'] = u['proveedor_codigo']
            session['proveedor_nombre'] = u['proveedor_nombre']
            return redirect(url_for('dashboard'))
        error = 'Usuario o contraseña inválidos.'
    return render_template('login.html', error=error)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/')
@login_required
def dashboard():
    return render_template('dashboard.html', proveedor_nombre=session['proveedor_nombre'], usuario=session['usuario'])


def _proveedor():
    """El proveedor de la sesión actual — nunca viene del cliente, siempre de la cookie firmada."""
    return session['proveedor_codigo']



def _rango_query():
    """Obtiene y valida las fechas recibidas desde el navegador."""
    from datetime import date

    desde = request.args.get('desde')
    hasta = request.args.get('hasta')

    def normalizar_fecha(valor):
        if not valor:
            return None

        valor = valor.strip()

        if valor.lower() in ('null', 'none', 'undefined', ''):
            return None

        try:
            return date.fromisoformat(valor).isoformat()
        except ValueError:
            return None

    desde = normalizar_fecha(desde)
    hasta = normalizar_fecha(hasta)

    # Evitar rangos invertidos.
    if desde and hasta and desde > hasta:
        desde, hasta = hasta, desde

    return desde, hasta


def _filtros():
    """
    Filtros de la barra superior: ?sede=A&sede=B&categoria=X ...
    Se devuelven como tupla ordenada para que sirvan de llave de caché.
    """
    filtros = []
    for campo in db.FILTROS_VENTAS:
        valores = sorted({v.strip() for v in request.args.getlist(campo) if v.strip()})
        if valores:
            filtros.append((campo, tuple(valores[:200])))
    return tuple(filtros)


# ---------------------------------------------------------------------------
#  API — todo detrás de login, todo acotado al proveedor de la sesión
# ---------------------------------------------------------------------------
@app.route('/api/rango')
@login_required
def api_rango():
    desde, hasta = db.rango_disponible(_proveedor())
    ultima = db.ultima_sincronizacion(_proveedor())
    return jsonify({'desde': desde, 'hasta': hasta, 'ultima_sincronizacion': ultima})


@app.route('/api/filtros')
@login_required
def api_filtros():
    return jsonify(db.opciones_filtros(_proveedor()))


@app.route('/api/resumen')
@login_required
def api_resumen():
    # Los KPI se calculan en PostgreSQL: no descargamos cientos de miles
    # de filas para después sumar los mismos datos en pandas.
    desde, hasta = _rango_query()
    resultado = db.resumen_ventas(_proveedor(), desde, hasta, _filtros())
    resultado.update(db.resumen_stock(_proveedor(), _filtros()))
    return jsonify(resultado)


@app.route('/api/hallazgos')
@login_required
def api_hallazgos():
    desde, hasta = _rango_query()
    if not desde or not hasta:
        desde, hasta = db.rango_disponible(_proveedor())
    if not desde:
        return jsonify({'resumen': [], 'hallazgos': [], 'alertas': 0})
    return jsonify(hallazgos.calcular(_proveedor(), desde, hasta, _filtros()))


@app.route('/api/agrupado/<campo>')
@login_required
def api_agrupado(campo):
    if campo not in db.DIM_VENTAS:
        abort(400)
    desde, hasta = _rango_query()
    top = request.args.get('top', type=int)
    orden = request.args.get('orden', 'venta')
    return jsonify(db.agrupar_ventas(_proveedor(), campo, desde, hasta, top, _filtros(), orden))


@app.route('/api/dias_inventario')
@login_required
def api_dias_inventario():
    dias = request.args.get('dias', default=30, type=int)
    if dias not in (7, 15, 30, 60, 90):
        abort(400)
    return jsonify(db.dias_inventario(_proveedor(), dias, _filtros()))


@app.route('/api/stock')
@login_required
def api_stock():
    resultado = db.stock_resumen(_proveedor(), _filtros())
    resultado.update(db.resumen_stock(_proveedor(), _filtros()))
    return jsonify(resultado)


@app.route('/api/exportar.csv')
@login_required
def api_exportar():
    """Ventas o Stock en CSV por bloques; si se piden ambos, un .zip con dos CSV."""
    desde, hasta = _rango_query()
    filtros = _filtros()
    quiere_ventas = request.args.get('ventas') == '1'
    quiere_stock = request.args.get('stock') == '1'
    proveedor = _proveedor()

    if not quiere_ventas and not quiere_stock:
        abort(400, description='Selecciona Ventas, Stock o ambos para exportar.')

    sufijo = f'{proveedor}_{desde or "inicio"}_{hasta or "hoy"}'
    reportes = []
    if quiere_ventas:
        reportes.append(('ventas', f'ventas_{sufijo}.csv', desde, hasta))
    if quiere_stock:
        reportes.append(('stock', f'stock_{proveedor}.csv', None, None))

    if len(reportes) == 1:
        tabla, nombre, d, h = reportes[0]

        def generar_csv():
            # BOM para que Excel detecte UTF-8 correctamente.
            yield '﻿'
            yield from db.iterar_csv(tabla, proveedor, d, h, filtros)

        return Response(
            stream_with_context(generar_csv()),
            mimetype='text/csv; charset=utf-8',
            headers={'Content-Disposition': f'attachment; filename="{nombre}"'}
        )

    # Ambos: se arma el zip en un archivo temporal (en disco, no en RAM).
    temporal = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with zipfile.ZipFile(temporal, 'w', zipfile.ZIP_DEFLATED) as zf:
        for tabla, nombre, d, h in reportes:
            with zf.open(nombre, 'w') as destino:
                texto = io.TextIOWrapper(destino, encoding='utf-8-sig', newline='')
                for bloque in db.iterar_csv(tabla, proveedor, d, h, filtros):
                    texto.write(bloque)
                texto.flush()
                texto.detach()
    temporal.seek(0)
    return send_file(temporal, mimetype='application/zip', as_attachment=True,
                     download_name=f'paquete_{sufijo}.zip')


if __name__ == '__main__':
    # Solo para desarrollo local. En Render corre con gunicorn (ver Procfile).
    app.run(debug=True, port=5000)
