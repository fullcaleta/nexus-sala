# NEXUS — Sala privada con chat y video

Red social privada estilo Discord: una sala general donde todos los que entran pueden chatear
y prender su cámara para verse entre sí. El frontend (HTML/CSS/JS) se sirve desde **GitHub
Pages**; el chat, la presencia, la señalización de video y el servidor TURN corren en un
**backend propio** (carpeta `server/`, no incluida en este repositorio público — ver
`server/README.md` en tu copia local).

## Cómo funciona

- **Ingreso**: cada usuario elige un nombre (sin contraseña) y entra a la sala `general` por una
  conexión WebSocket segura (`wss://`) al backend.
- **Presencia**: el servidor mantiene la lista de quién está conectado en memoria y avisa al
  instante cuando alguien entra o se desconecta (no hace falta heartbeat manual: la conexión en sí
  ya avisa cuando se corta).
- **Chat**: los mensajes se retransmiten a todos los conectados; el servidor guarda un historial
  reciente en memoria para mostrarlo a quien recién entra.
- **Video**: es WebRTC "mesh" — cada usuario se conecta directo con cada otro usuario de la sala.
  La negociación (ofertas/respuestas/candidatos ICE) se manda por el mismo WebSocket. El servidor
  TURN propio (coturn) ayuda a conectar a quienes están en redes restrictivas (datos móviles,
  NAT de operador, etc.).
- **Moderador**: entrando con `?mod=CLAVE` en la URL, el servidor (no el navegador) verifica la
  clave y devuelve si sos moderador — la clave nunca queda escrita en el código público del sitio.
  El moderador queda invisible en la lista/video de los demás y puede expulsar usuarios (el
  servidor cierra la conexión de la persona expulsada de verdad, no es solo un aviso visual).
- Si el usuario no otorga permiso de cámara/micrófono, igual puede quedarse en la sala solo
  chateando; puede activarlos en cualquier momento con los botones de la sala.

## Estructura

```
red-social-privada/
├── index.html              # pantalla de ingreso + pantalla de la sala
├── css/style.css            # estilo oscuro/transparente "gamer"
├── js/
│   ├── realtime.js           # cliente WebSocket (reemplaza a Firebase)
│   ├── webrtc.js               # conexiones de video punto a punto
│   └── app.js                    # lógica principal (ingreso, chat, presencia)
├── server/                          # backend propio (NO se sube a GitHub, ver .gitignore)
│   ├── server.js                      # servidor WebSocket (chat/presencia/señalización)
│   ├── turnserver.conf                 # configuración de coturn (TURN)
│   └── ...                              # scripts de arranque, ver server/README.md
└── README.md
```

## Publicar cambios del frontend en GitHub Pages

```bash
cd red-social-privada
git add index.html css js README.md
git commit -m "Describir el cambio"
git push origin main
```

GitHub Pages se actualiza solo en uno o dos minutos después del push.

## Próximos pasos posibles

- Múltiples salas/canales (hoy solo existe "general").
- Compartir pantalla (agregar `getDisplayMedia` como otro track).
- Reacciones/emojis, indicador de "escribiendo...".
- Persistir el historial de chat en disco (hoy vive en memoria del servidor; se pierde si se
  reinicia).
