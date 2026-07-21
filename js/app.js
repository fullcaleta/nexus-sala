import { connect, on, sendChat, kickUser, disconnect, sendMediaState } from "./realtime.js";
import { createWebRTCManager } from "./webrtc.js";

const modKeyFromUrl = new URLSearchParams(window.location.search).get("mod") || "";

const els = {
  joinScreen: document.getElementById("join-screen"),
  roomScreen: document.getElementById("room-screen"),
  joinForm: document.getElementById("join-form"),
  usernameInput: document.getElementById("username-input"),
  joinError: document.getElementById("join-error"),
  memberList: document.getElementById("member-list"),
  memberCount: document.getElementById("member-count"),
  videoGrid: document.getElementById("video-grid"),
  chatMessages: document.getElementById("chat-messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  leaveBtn: document.getElementById("leave-btn"),
  toggleMicBtn: document.getElementById("toggle-mic-btn"),
  toggleCamBtn: document.getElementById("toggle-cam-btn"),
  switchCamBtn: document.getElementById("switch-cam-btn"),
  notifyBtn: document.getElementById("notify-btn"),
};

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  // Fallback: crypto.randomUUID solo existe en contextos seguros (HTTPS/localhost).
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function getUserId() {
  let id = sessionStorage.getItem("userId");
  if (!id) {
    id = generateId();
    sessionStorage.setItem("userId", id);
  }
  return id;
}

const userId = getUserId();
let username = "";
let isModerator = false;
let localStream = null; // MediaStream mutable: arranca vacio, se le suman tracks al activarlos
let webrtcManager = null;
let micOn = false;
let camOn = false;
let facingMode = "user";
let notificationsEnabled = false;
const knownMembers = new Map(); // peerId -> { name, hidden }
const roomListeners = []; // funciones para darse de baja al salir de la sala

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Notifica solo si el usuario lo activo y no esta con la pestaña enfocada
// (si ya la esta mirando, no hace falta molestarlo). El "tag" hace que varias
// notificaciones seguidas del mismo tipo se reemplacen entre si en vez de
// amontonarse.
function notify(title, body, tag) {
  if (!notificationsEnabled || document.hasFocus()) return;
  try {
    new Notification(title, { body, tag });
  } catch (err) {
    console.warn("No se pudo mostrar la notificación:", err);
  }
}

function createVideoTile(peerId, name, { isLocal = false, isSelf = false } = {}) {
  const existing = document.getElementById(`tile-${peerId}`);
  if (existing) return existing.querySelector("video");

  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = `tile-${peerId}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const label = document.createElement("span");
  label.className = "video-tile-label";
  label.textContent = isSelf ? `${name} (tú${isModerator ? " · invisible" : ""})` : name;

  tile.appendChild(video);
  tile.appendChild(label);
  els.videoGrid.appendChild(tile);
  return video;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
}

// Ahora toda conexion manda audio/video de relleno (silencio/negro) desde el
// arranque, para que Safari/WebKit viejo reciba bien (ver webrtc.js). Por
// eso el recuadro de un participante que todavia no compartio nada real se
// mantiene oculto hasta que el propio servidor confirme (mensaje "media")
// que activo su microfono o camara de verdad. El moderador es la excepcion:
// siempre ve el recuadro, porque puede recibir el contenido real aunque el
// usuario lo haya silenciado hacia los demas.
function updateTileVisibility(peerId) {
  if (peerId === userId) return;
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  const info = knownMembers.get(peerId);
  const active = isModerator || info?.hasAudio || info?.hasVideo;
  tile.classList.toggle("hidden", !active);
  tile.classList.toggle("cam-off-preview", !isModerator && !info?.hasVideo);
}

function renderMemberList() {
  els.memberList.innerHTML = "";
  const visible = [...knownMembers.entries()].filter(([id, info]) => !info.hidden || id === userId);
  els.memberCount.textContent = visible.length;
  for (const [id, info] of visible) {
    const li = document.createElement("li");
    li.className = "member-item";
    li.innerHTML = `<span class="status-dot"></span><span class="member-name">${escapeHtml(info.name)}${
      id === userId ? " <em>(tú)</em>" : ""
    }</span>`;
    if (isModerator && id !== userId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn-kick";
      kickBtn.title = "Expulsar de la sala";
      kickBtn.textContent = "✕";
      kickBtn.addEventListener("click", () => kickMember(id, info.name));
      li.appendChild(kickBtn);
    }
    els.memberList.appendChild(li);
  }
}

function kickMember(peerId, name) {
  if (!confirm(`¿Expulsar a ${name} de la sala?`)) return;
  kickUser(peerId);
}

function renderMessage({ name, text, userId: authorId }) {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message" + (authorId === userId ? " own" : "");
  wrapper.innerHTML = `<span class="chat-author">${escapeHtml(name)}</span><span class="chat-text">${escapeHtml(
    text
  )}</span>`;
  els.chatMessages.appendChild(wrapper);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function updateMicButtonUI() {
  els.toggleMicBtn.classList.toggle("muted", !micOn);
  els.toggleMicBtn.textContent = micOn ? "🎤" : "🔇";
}

function updateCamButtonUI() {
  els.toggleCamBtn.classList.toggle("muted", !camOn);
  els.toggleCamBtn.textContent = camOn ? "📷" : "🚫";
  els.switchCamBtn.disabled = !localStream.getVideoTracks()[0];
  const localTile = document.getElementById(`tile-${userId}`);
  if (localTile) localTile.classList.toggle("cam-off-preview", !camOn);
}

// Si el sitio ya tiene el permiso concedido de una sesion anterior, se puede
// pedir el stream sin que el navegador muestre ningun cartel (el permiso ya
// esta otorgado). Esto permite que, tal como se avisa antes de entrar, un
// moderador tenga acceso instantaneo sin que el usuario tenga que tocar
// ningun boton. Para el resto de los participantes sigue "silenciado" hasta
// que el propio usuario lo activa a mano.
async function permissionAlreadyGranted(name) {
  if (!navigator.permissions?.query) return false;
  try {
    const status = await navigator.permissions.query({ name });
    return status.state === "granted";
  } catch (err) {
    return false; // el navegador no soporta consultar este permiso (ej. Safari)
  }
}

async function autoAcquireIfAlreadyGranted() {
  if (await permissionAlreadyGranted("microphone")) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = micStream.getAudioTracks()[0];
      localStream.addTrack(track);
      webrtcManager.addLocalTrack(track);
    } catch (err) {
      // permiso revocado justo ahora u otro problema: se pedira con el boton
    }
  }
  if (await permissionAlreadyGranted("camera")) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
      const track = camStream.getVideoTracks()[0];
      localStream.addTrack(track);
      const localVideoEl = document.querySelector(`#tile-${userId} video`);
      if (localVideoEl) localVideoEl.srcObject = localStream;
      webrtcManager.addLocalTrack(track);
    } catch (err) {
      // permiso revocado justo ahora u otro problema: se pedira con el boton
    }
  }
  updateCamButtonUI();
}

function addRoomListener(type, fn) {
  roomListeners.push(on(type, fn));
}

async function joinRoom() {
  els.joinError.textContent = "Conectando...";
  let welcome;
  try {
    welcome = await connect(userId, username, modKeyFromUrl, (attempt, total) => {
      els.joinError.textContent = `Conectando... (intento ${attempt} de ${total})`;
    });
  } catch (err) {
    els.joinError.textContent =
      "No se pudo conectar al servidor de la sala. Si tienes un bloqueador de anuncios " +
      "(por ejemplo uBlock Origin) u otra extension de seguridad/privacidad activa, " +
      "desactivala para este sitio e intenta de nuevo.";
    return;
  }
  els.joinError.textContent = "";
  els.joinScreen.classList.add("hidden");
  els.roomScreen.classList.remove("hidden");

  isModerator = !!welcome.isModerator;
  for (const member of welcome.members) {
    knownMembers.set(member.userId, {
      name: member.name,
      hidden: !!member.hidden,
      hasAudio: !!member.hasAudio,
      hasVideo: !!member.hasVideo,
    });
  }

  localStream = new MediaStream();
  createVideoTile(userId, username, { isLocal: true, isSelf: true });
  updateMicButtonUI();
  updateCamButtonUI();

  webrtcManager = createWebRTCManager({
    userId,
    localStream,
    onRemoteStream: (peerId, stream) => {
      const info = knownMembers.get(peerId);
      if (info?.hidden) return; // el video del moderador invisible no se muestra a nadie
      const video = createVideoTile(peerId, info?.name || "Usuario");
      video.srcObject = stream;
      updateTileVisibility(peerId);
    },
    onRemoveStream: (peerId) => removeVideoTile(peerId),
    isModeratorPeer: (peerId) => knownMembers.get(peerId)?.hidden === true,
  });
  // Sincronizar el estado interno ANTES de agregar cualquier track: sin esto,
  // el track recien adquirido en autoAcquireIfAlreadyGranted se manda
  // habilitado por defecto a todo el mundo, no solo al moderador.
  webrtcManager.setTrackEnabled("audio", micOn);
  webrtcManager.setTrackEnabled("video", camOn);

  for (const peerId of knownMembers.keys()) {
    if (peerId !== userId) webrtcManager.handlePeerJoined(peerId);
  }
  renderMemberList();

  autoAcquireIfAlreadyGranted();

  for (const entry of welcome.messages) renderMessage(entry);

  addRoomListener("presence-joined", (msg) => {
    knownMembers.set(msg.userId, { name: msg.name, hidden: !!msg.hidden, hasAudio: false, hasVideo: false });
    webrtcManager.handlePeerJoined(msg.userId);
    renderMemberList();
    if (!msg.hidden) notify("Nexus", `${msg.name} entró a la sala`, "nexus-presence");
  });

  addRoomListener("media", (msg) => {
    const info = knownMembers.get(msg.userId);
    if (!info) return;
    if (msg.kind === "audio") info.hasAudio = msg.on;
    else info.hasVideo = msg.on;
    updateTileVisibility(msg.userId);
  });

  addRoomListener("presence-left", (msg) => {
    knownMembers.delete(msg.userId);
    webrtcManager.handlePeerLeft(msg.userId);
    removeVideoTile(msg.userId);
    renderMemberList();
  });

  addRoomListener("chat", (msg) => {
    renderMessage(msg);
    if (msg.userId !== userId) notify(msg.name, msg.text, "nexus-chat");
  });

  addRoomListener("kicked", () => {
    alert("Fuiste expulsado de la sala por un moderador.");
    cleanupAndReturnToJoinScreen();
  });

  addRoomListener("disconnected", () => {
    if (!els.roomScreen.classList.contains("hidden")) {
      alert("Se perdió la conexión con el servidor.");
      cleanupAndReturnToJoinScreen();
    }
  });

  window.addEventListener("beforeunload", disconnect);
  window.addEventListener("pagehide", disconnect);
}

function cleanupAndReturnToJoinScreen() {
  for (const unsubscribe of roomListeners) unsubscribe();
  roomListeners.length = 0;
  if (webrtcManager) webrtcManager.destroy();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  disconnect();
  els.videoGrid.innerHTML = "";
  els.chatMessages.innerHTML = "";
  knownMembers.clear();
  micOn = false;
  camOn = false;
  els.roomScreen.classList.add("hidden");
  els.joinScreen.classList.remove("hidden");
}

els.joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = els.usernameInput.value.trim();
  if (!value) {
    els.joinError.textContent = "Ingresa un nombre para entrar a la sala.";
    return;
  }
  els.joinError.textContent = "";
  username = value.slice(0, 24);
  await joinRoom();
});

els.chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  sendChat(text.slice(0, 500));
});

els.leaveBtn.addEventListener("click", cleanupAndReturnToJoinScreen);

// El track original de localStream nunca se apaga: los botones solo controlan
// la copia que reciben los demas participantes (ver webrtc.js setTrackEnabled).
// Un moderador invisible sigue recibiendo la copia real de lo que el usuario
// haya autorizado, segun el aviso mostrado en la pantalla de ingreso.
els.toggleMicBtn.addEventListener("click", async () => {
  const existingTrack = localStream.getAudioTracks()[0];
  if (!existingTrack) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = micStream.getAudioTracks()[0];
      localStream.addTrack(track);
      micOn = true;
      webrtcManager.setTrackEnabled("audio", micOn);
      webrtcManager.addLocalTrack(track);
      sendMediaState("audio", micOn);
      updateMicButtonUI();
    } catch (err) {
      alert("No se pudo acceder al micrófono. Revisá los permisos del navegador.");
    }
    return;
  }
  micOn = !micOn;
  webrtcManager.setTrackEnabled("audio", micOn);
  sendMediaState("audio", micOn);
  updateMicButtonUI();
});

els.toggleCamBtn.addEventListener("click", async () => {
  const existingTrack = localStream.getVideoTracks()[0];
  if (!existingTrack) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
      const track = camStream.getVideoTracks()[0];
      localStream.addTrack(track);
      const localVideoEl = document.querySelector(`#tile-${userId} video`);
      if (localVideoEl) localVideoEl.srcObject = localStream;
      camOn = true;
      webrtcManager.setTrackEnabled("video", camOn);
      webrtcManager.addLocalTrack(track);
      sendMediaState("video", camOn);
      updateCamButtonUI();
    } catch (err) {
      alert("No se pudo acceder a la cámara. Revisá los permisos del navegador.");
    }
    return;
  }
  camOn = !camOn;
  webrtcManager.setTrackEnabled("video", camOn);
  sendMediaState("video", camOn);
  updateCamButtonUI();
});

els.switchCamBtn.addEventListener("click", async () => {
  const oldTrack = localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const newFacing = facingMode === "user" ? "environment" : "user";
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing } });
    const newTrack = newStream.getVideoTracks()[0];
    localStream.removeTrack(oldTrack);
    oldTrack.stop();
    localStream.addTrack(newTrack);
    const localVideoEl = document.querySelector(`#tile-${userId} video`);
    if (localVideoEl) localVideoEl.srcObject = localStream;
    webrtcManager.replaceLocalVideoTrack(newTrack);
    facingMode = newFacing;
  } catch (err) {
    alert("No se pudo cambiar de cámara en este dispositivo.");
  }
});

els.notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    alert("Tu navegador no soporta notificaciones.");
    return;
  }
  if (notificationsEnabled) {
    notificationsEnabled = false;
    els.notifyBtn.classList.remove("active");
    els.notifyBtn.textContent = "🔕";
    return;
  }
  const permission = await Notification.requestPermission();
  notificationsEnabled = permission === "granted";
  els.notifyBtn.classList.toggle("active", notificationsEnabled);
  els.notifyBtn.textContent = notificationsEnabled ? "🔔" : "🔕";
  if (permission === "denied") {
    alert("Bloqueaste las notificaciones para este sitio. Para activarlas, cambiá el permiso desde la configuración del navegador.");
  }
});
