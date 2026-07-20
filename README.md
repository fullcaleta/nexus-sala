# NEXUS — Sala privada con chat y video

Red social privada estilo Discord: una sala general donde todos los que entran pueden chatear
y prender su cámara para verse entre sí. Sitio 100% estático (HTML/CSS/JS sin build), pensado
para hostear en **GitHub Pages**. El chat, la lista de "quién está online" y la señalización de
video van por **Firebase Firestore** (plan gratuito), así que no hace falta mantener un servidor propio.

## 1. Crear el proyecto de Firebase (gratis, ~2 minutos)

1. Entrá a https://console.firebase.google.com/ y creá un proyecto nuevo (no hace falta tarjeta).
2. Dentro del proyecto, click en el ícono **</>** ("Agregar app web") y registrá una app
   (no hace falta Firebase Hosting, solo el SDK).
3. Firebase te va a mostrar un objeto `firebaseConfig`. Copialo entero.
4. Pegalo en [js/firebase-config.js](js/firebase-config.js), reemplazando los valores de ejemplo.
5. En el menú lateral: **Build > Firestore Database > Crear base de datos**. Elegí modo
   producción y la región que quieras.
6. En la pestaña **Reglas** de Firestore, pegá esto y publicá (permite lectura/escritura solo
   dentro de `rooms/*`, sin necesidad de login — suficiente para un grupo privado que comparte el link):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{roomId}/{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```

   > Nota: como es de solo-link (sin login), cualquiera con la URL del sitio puede escribir en la
   > sala. Para un grupo cerrado de amigos está bien; si más adelante querés más seguridad, se
   > puede agregar Firebase Auth y reglas que validen el usuario.

## 2. Probar en local

No hace falta instalar nada, pero los navegadores no dejan usar cámara/módulos ES si abrís el
`index.html` con `file://`. Levantá un servidor estático simple:

```bash
cd red-social-privada
python -m http.server 8080
# o: npx serve .
```

Y abrí http://localhost:8080

## 3. Publicar en GitHub Pages

```bash
cd red-social-privada
git init
git add .
git commit -m "Primera version de NEXUS"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

Después, en el repo de GitHub: **Settings > Pages > Source: rama `main`, carpeta `/root`** y guardar.
En un minuto el sitio queda en `https://TU_USUARIO.github.io/TU_REPO/`.

## Cómo funciona

- **Ingreso**: cada usuario elige un nombre (sin contraseña) y entra a la sala `general`.
- **Presencia**: al entrar se crea un documento en `rooms/general/presence`; todos los que están
  en la sala lo ven en tiempo real (lista de miembros) vía `onSnapshot`.
- **Chat**: los mensajes se guardan en `rooms/general/messages` y se muestran a todos en vivo.
- **Video**: es WebRTC "mesh" — cada usuario se conecta directo con cada otro usuario de la sala
  (sin servidor de video intermedio). La negociación (ofertas/respuestas/candidatos ICE) se manda
  a través de `rooms/general/signals` en Firestore, y se borra apenas se procesa. Funciona bien
  para grupos chicos (un puñado de amigos); con muchas personas simultáneas conviene un SFU
  (Selective Forwarding Unit), que quedaría para una siguiente iteración.
- Si el usuario no da permiso de cámara/micrófono, igual puede quedarse en la sala solo chateando.

## Estructura

```
red-social-privada/
├── index.html          # pantalla de ingreso + pantalla de la sala
├── css/style.css        # estilo oscuro/transparente "gamer"
├── js/
│   ├── firebase-config.js  # tus llaves de Firebase (completar)
│   ├── db.js                # inicialización de Firestore
│   ├── webrtc.js             # conexiones de video punto a punto
│   └── app.js                 # lógica principal (join, chat, presencia)
└── README.md
```

## Próximos pasos posibles

- Múltiples salas/canales (hoy solo existe "general").
- Compartir pantalla (agregar `getDisplayMedia` como otro track).
- Reacciones/emojis, indicador de "escribiendo...".
- Login real con Firebase Auth si se quiere restringir el acceso más allá del link.
