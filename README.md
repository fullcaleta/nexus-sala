# NEXUS — Sala privada con chat y video

Red social privada estilo Discord: una sala general donde todos los que entran pueden chatear
y prender su cámara para verse entre sí. Sitio 100% estático (HTML/CSS/JS sin build), pensado
para hostear en **GitHub Pages**. El chat, la lista de "quién está en línea" y la señalización de
video van por **Firebase Firestore** (plan gratuito), así que no hace falta mantener un servidor propio.

## 1. Crear el proyecto de Firebase (gratis, ~2 minutos)

1. Entrar a https://console.firebase.google.com/ y crear un proyecto nuevo (no hace falta tarjeta).
2. Dentro del proyecto, hacer clic en el ícono **</>** ("Agregar app web") y registrar una app
   (no hace falta Firebase Hosting, solo el SDK).
3. Firebase mostrará un objeto `firebaseConfig`. Copiarlo entero.
4. Pegarlo en [js/firebase-config.js](js/firebase-config.js), reemplazando los valores de ejemplo.
5. En el menú lateral: **Build > Firestore Database > Crear base de datos**. Elegir modo
   producción y la región deseada.
6. En la pestaña **Reglas** de Firestore, pegar esto y publicar (permite lectura/escritura solo
   dentro de `rooms/*`, sin necesidad de login — suficiente para un grupo privado que comparte el enlace):

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

   > Nota: como es de solo-enlace (sin login), cualquiera con la URL del sitio puede escribir en la
   > sala. Para un grupo cerrado de amigos está bien; si más adelante se requiere más seguridad, se
   > puede agregar Firebase Auth y reglas que validen el usuario.

## 2. Probar en local

No hace falta instalar nada, pero los navegadores no permiten usar cámara/módulos ES si se abre
`index.html` con `file://`. Levantar un servidor estático simple:

```bash
cd red-social-privada
python -m http.server 8080
# o: npx serve .
```

Y abrir http://localhost:8080

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

Después, en el repositorio de GitHub: **Settings > Pages > Source: rama `main`, carpeta `/root`** y guardar.
En un minuto el sitio queda en `https://TU_USUARIO.github.io/TU_REPO/`.

## Cómo funciona

- **Ingreso**: cada usuario elige un nombre (sin contraseña) y entra a la sala `general`.
- **Presencia**: al entrar se crea un documento en `rooms/general/presence`; todos los que están
  en la sala lo ven en tiempo real (lista de miembros) vía `onSnapshot`.
- **Chat**: los mensajes se guardan en `rooms/general/messages` y se muestran a todos en vivo.
- **Video**: es WebRTC "mesh" — cada usuario se conecta directo con cada otro usuario de la sala
  (sin servidor de video intermedio). La negociación (ofertas/respuestas/candidatos ICE) se envía
  a través de `rooms/general/signals` en Firestore, y se borra apenas se procesa. Funciona bien
  para grupos pequeños (un puñado de amigos); con muchas personas simultáneas conviene un SFU
  (Selective Forwarding Unit), que quedaría para una siguiente iteración.
- Si el usuario no otorga permiso de cámara/micrófono, igual puede quedarse en la sala solo chateando.

## Estructura

```
red-social-privada/
├── index.html          # pantalla de ingreso + pantalla de la sala
├── css/style.css        # estilo oscuro/transparente "gamer"
├── js/
│   ├── firebase-config.js  # llaves de Firebase (completar)
│   ├── db.js                # inicialización de Firestore
│   ├── webrtc.js             # conexiones de video punto a punto
│   └── app.js                 # lógica principal (ingreso, chat, presencia)
└── README.md
```

## Próximos pasos posibles

- Múltiples salas/canales (hoy solo existe "general").
- Compartir pantalla (agregar `getDisplayMedia` como otro track).
- Reacciones/emojis, indicador de "escribiendo...".
- Login real con Firebase Auth si se quiere restringir el acceso más allá del enlace.
