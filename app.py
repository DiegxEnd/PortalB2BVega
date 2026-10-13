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
import os
from functools import wraps

from flask import Flask, render_template, request, redirect, url_for, session, jsonify, Response, stream_with_context, abort

import auth
import db
import medidas as kpi

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'cambia-esto-en-produccion-no-uses-el-default')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = os.environ.get('RENDER', '') != ''

CAMPOS_AGRUPABLES = {'canal', 'tipo_negocio', 'codigo_producto', 'supervisor', 'jefe_ventas'}


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
    return render_template('dashboard.html', proveedor_nombre=session['proveedor_nombre'])


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



# ---------------------------------------------------------------------------
#  API — todo detrás de login, todo acotado al proveedor de la sesión
# ---------------------------------------------------------------------------
@app.route('/api/rango')
@login_required
def api_rango():
    desde, hasta = db.rango_disponible(_proveedor())
    ultima = db.ultima_sincronizacion(_proveedor())
    return jsonify({'desde': desde, 'hasta': hasta, 'ultima_sincronizacion': ultima})


@app.route('/api/resumen')
@login_required
def api_resumen():
    # Los KPI se calculan en PostgreSQL: no descargamos cientos de miles
    # de filas para después sumar los mismos datos en pandas.
    desde, hasta = _rango_query()
    resultado = db.resumen_ventas(_proveedor(), desde, hasta)
    resultado.update(db.resumen_stock(_proveedor()))
    return jsonify(resultado)


@app.route('/api/semanal')
@login_required
def api_semanal():
    desde, hasta = _rango_query()
    return jsonify(db.ventas_por_semana(_proveedor(), desde, hasta))


@app.route('/api/agrupado/<campo>')
@login_required
def api_agrupado(campo):
    if campo not in CAMPOS_AGRUPABLES:
        abort(400)
    desde, hasta = _rango_query()
    top = request.args.get('top', type=int)
    if campo == 'codigo_producto' and not top:
        top = 20
    return jsonify(db.agrupar_ventas(_proveedor(), campo, desde, hasta, top))


@app.route('/api/stock')
@login_required
def api_stock():
    return jsonify(db.stock_resumen(_proveedor()))


@app.route('/api/exportar.csv')
@login_required
def api_exportar():
    """Exporta CSV por bloques para evitar construir todo el archivo en RAM."""
    desde, hasta = _rango_query()
    quiere_ventas = request.args.get('ventas') == '1'
    quiere_stock = request.args.get('stock') == '1'
    proveedor = _proveedor()

    if not quiere_ventas and not quiere_stock:
        abort(400, description='Selecciona Ventas, Stock o ambos para exportar.')

    def generar_csv():
        # BOM para que Excel detecte UTF-8 correctamente.
        yield '\ufeff'
        if quiere_ventas:
            yield '=== VENTAS ===\r\n'
            yield from db.iterar_csv('ventas', proveedor, desde, hasta)
            yield '\r\n'
        if quiere_stock:
            yield '=== STOCK ===\r\n'
            yield from db.iterar_csv('stock', proveedor)

    nombre = f'{proveedor}_{desde or "inicio"}_{hasta or "hoy"}.csv'
    return Response(
        stream_with_context(generar_csv()),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': f'attachment; filename="{nombre}"'}
    )


if __name__ == '__main__':
    # Solo para desarrollo local. En Render corre con gunicorn (ver Procfile).
    app.run(debug=True, port=5000)
