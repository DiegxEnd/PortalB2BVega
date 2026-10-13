"""
auth.py — usuarios del portal.

Las contraseñas NUNCA se guardan en texto plano, ni siquiera aquí: cada
USUARIOS[x]['password_hash'] es el resultado de generate_password_hash(),
una huella que no se puede revertir. Flask compara hashes, no contraseñas.

CÓMO AGREGAR UN PROVEEDOR NUEVO
--------------------------------
1) Corre:  python crear_usuario.py
   Te va a pedir un usuario, una contraseña y el código de proveedor
   (debe coincidir con el proveedor_codigo que uses al sincronizar en
   sync_a_supabase.py, ej. "peusac") e imprime la línea lista para copiar.
2) Pega esa línea dentro del diccionario USUARIOS de abajo.
3) Sube el cambio a GitHub — Render redespliega solo.

Nunca se expone esta lista en ninguna página ni endpoint: solo vive en
este archivo, en el servidor, y el servidor es el único que la lee.
"""

USUARIOS = {
    # Usuario de PRUEBA para que puedas correr el portal local ya mismo:
    #   usuario: peusac   /   contraseña: demo1234
    # Bórralo o reemplázalo con crear_usuario.py antes de desplegarlo
    # públicamente — es una contraseña de ejemplo, no una real.
    'peusac': {
        'password_hash': 'scrypt:32768:8:1$bYqUdpNroP1dvVvr$9d129e52c84c3757b7d77bde3252f5574daf6a3c76632eeaf88b7ceee53f5926396631322360747f8ef5769962eb761d7b1c96dcdf8c41601caa93c107393db8',
        'proveedor_codigo': 'peusac',
        'proveedor_nombre': 'Productos Ext. y Universal SAC',
    },
}


def verificar_credenciales(usuario, password):
    """Devuelve el dict del usuario si usuario+password son válidos, o None."""
    from werkzeug.security import check_password_hash
    u = USUARIOS.get(usuario.strip().lower())
    if not u:
        return None
    if not check_password_hash(u['password_hash'], password):
        return None
    return u
