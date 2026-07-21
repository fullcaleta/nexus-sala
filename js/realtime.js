// Cliente del backend propio (reemplaza a Firebase). Se conecta por WebSocket
// a un servidor que corre en tu PC. En local (probando en tu compu) usa
// ws://localhost:8080 automaticamente. Una vez que el servidor este expuesto
// a internet con dominio y HTTPS, completar PUBLIC_SERVER_URL (ver
// server/README.md) — ahi si tiene que ser wss:// (seguro), porque el sitio
// se sirve por HTTPS y los navegadores no permiten mezclar HTTPS con un
// WebSocket inseguro.
const PUBLIC_SERVER_URL = "wss://nexus-sala.duckdns.org";
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
export const SERVER_URL = isLocal ? "ws://localhost:8080" : PUBLIC_SERVER_URL;

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

export function connect(userId, name, modKey) {
  return new Promise((resolve, reject) => {
    let settled = false;
    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", userId, name, mod: modKey || "" }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "welcome" && !settled) {
        settled = true;
        resolve(msg);
      }
      emit(msg.type, msg);
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error("No se pudo conectar al servidor."));
      }
    };

    ws.onclose = () => {
      if (!settled) {
        settled = true;
        reject(new Error("El servidor cerro la conexion antes de tiempo."));
      }
      emit("disconnected", {});
    };
  });
}

function sendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

export function sendChat(text) {
  sendMessage({ type: "chat", text });
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
