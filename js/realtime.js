// Cliente del backend propio (reemplaza a Firebase). Se conecta por WebSocket
// a un servidor que corre en tu PC. En local (probando en tu compu) usa
// ws://localhost:8080 automaticamente. El sitio se sirve por HTTPS, asi que
// en produccion tiene que ser wss:// (seguro) — los navegadores no permiten
// mezclar HTTPS con un WebSocket inseguro.
const PUBLIC_SERVER_URL = "wss://nexus-sala.duckdns.org";
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
export const SERVER_URL = isLocal ? "ws://localhost:8080" : PUBLIC_SERVER_URL;

// Algunas redes (en particular, dispositivos conectados a la misma red que
// el servidor) a veces fallan al conectar por un problema del router al
// "reflejar" la conexion hacia su propia IP publica. No es cosa nuestra,
// pero como suele ser intermitente (a veces conecta, a veces no), reintentar
// unas pocas veces antes de rendirse soluciona la mayoria de los casos.
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1200;
const CONNECT_TIMEOUT_MS = 5000;

let ws = null;
const listeners = new Map();

function emit(type, data) {
  for (const fn of listeners.get(type) || []) fn(data);
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const arr = listeners.get(type);
  if (!arr) return;
  const idx = arr.indexOf(fn);
  if (idx !== -1) arr.splice(idx, 1);
}

export function offAll(type) {
  listeners.delete(type);
}

function attemptConnect(userId, name, modKey) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(SERVER_URL);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("timeout"));
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "join", userId, name, mod: modKey || "" }));
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "welcome" && !settled) {
        settled = true;
        clearTimeout(timeout);
        ws = socket;
        resolve(msg);
      } else if (msg.type === "name-taken" && !settled) {
        // No tiene sentido reintentar con el mismo nombre: es un rechazo
        // definitivo, no una falla de conexion pasajera.
        settled = true;
        clearTimeout(timeout);
        const err = new Error("name-taken");
        err.code = "name-taken";
        reject(err);
      }
      emit(msg.type, msg);
    };

    socket.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("connect-failed"));
    };

    socket.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("connect-failed"));
        return;
      }
      emit("disconnected", {});
    };
  });
}

// onRetry(intentoActual, totalIntentos) se llama antes de cada reintento,
// para que la interfaz pueda mostrar "conectando... (intento 2 de 5)".
export async function connect(userId, name, modKey, onRetry) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptConnect(userId, name, modKey);
    } catch (err) {
      // Reintentar con el mismo nombre no sirve de nada: el servidor lo va
      // a rechazar de nuevo, siempre por el mismo motivo.
      if (err.code === "name-taken") throw err;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error("No se pudo conectar al servidor de la sala.");
      }
      onRetry?.(attempt + 1, MAX_ATTEMPTS);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

function sendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn(`[NEXUS-DEBUG] sendMessage NO enviado (type=${data.type}): ws=${!!ws} readyState=${ws?.readyState}`);
  }
}

export function sendChat(text) {
  sendMessage({ type: "chat", text });
}

export function sendDm(to, text) {
  sendMessage({ type: "dm", to, text });
}

export function sendGif(filename) {
  sendMessage({ type: "gif", filename });
}

export function sendGifDm(to, filename) {
  sendMessage({ type: "gif-dm", to, filename });
}

export function sendSignal(to, signalType, payload) {
  sendMessage({ type: "signal", to, signalType, payload });
}

export function kickUser(targetId) {
  sendMessage({ type: "kick", targetId });
}

export function disconnect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}
