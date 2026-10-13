#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crear_usuario.py — genera la línea lista para pegar en auth.py.

No guarda nada por su cuenta: solo calcula el hash de la contraseña que
escribas y te lo muestra. Tú decides si lo pegas en auth.py y lo subes.

Uso:
    python crear_usuario.py
"""
import getpass
from werkzeug.security import generate_password_hash

print('=== Crear acceso de proveedor ===\n')
usuario = input('Usuario (ej. peusac): ').strip().lower()
password = getpass.getpass('Contraseña (no se muestra en pantalla): ')
proveedor_codigo = input('Código de proveedor / carpeta en data/ (ej. peusac): ').strip().lower()
proveedor_nombre = input('Nombre del proveedor (ej. Productos Ext. y Universal SAC): ').strip()

h = generate_password_hash(password)

print('\nListo. Pega esto dentro de USUARIOS en auth.py:\n')
print(f"    '{usuario}': {{")
print(f"        'password_hash': '{h}',")
print(f"        'proveedor_codigo': '{proveedor_codigo}',")
print(f"        'proveedor_nombre': '{proveedor_nombre}',")
print("    },")
print('\nLa contraseña en texto plano no quedó guardada en ningún lado.')
