import { connect, on, sendChat, kickUser, disconnect } from "./realtime.js";
import { createWebRTCManager } from "./webrtc.js?v=2";

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
  shareScreenBtn: document.getElementById("share-screen-btn"),
  shareScreenLabel: document.getElementById("share-screen-label"),
  toggleVideosBtn: document.getElementById("toggle-videos-btn"),
  toggleVideosLabel: document.getElementById("toggle-videos-label"),
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
// Compartido por todos los recuadros remotos, para el control de volumen
// (ver createVideoTile): iOS/Safari ignora el volume nativo del <video>
// a proposito (solo dejan controlarlo con los botones fisicos del
// telefono), asi que hace falta pasar el audio por Web Audio API, donde el
// volumen si se puede ajustar por codigo en cualquier navegador.
let sharedAudioContext = null;
function getSharedAudioContext() {
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (sharedAudioContext.state === "suspended") sharedAudioContext.resume();
  return sharedAudioContext;
}
let localStream = null; // MediaStream mutable: arranca vacio, se le suman tracks al activarlos
let webrtcManager = null;
let micOn = false;
let camOn = false;
let facingMode = "user";
let screenShareActive = false;
let camWasOnBeforeShare = false; // para saber si hay que volver a prender la camara al dejar de compartir
let audioReplacedForShare = false; // si se toco el audio al compartir (por eso hay que restaurarlo al terminar)
let micWasOnBeforeShare = false; // para saber si hay que volver a prender el microfono al dejar de compartir
let micTrackSetAsideForShare = null; // el track real del microfono, guardado mientras se comparte pantalla
let audioMixContext = null; // AudioContext usado para mezclar microfono + audio de la pantalla
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
  // El efecto espejo (como mirarte a un espejo) solo tiene sentido con la
  // camara frontal, y solo en tu propia vista previa; con la camara trasera
  // (por ejemplo apuntando a un monitor con texto) no hay que espejar nada,
  // ni para vos ni para los demas, o el texto se lee al reves.
  if (isLocal) {
    tile.classList.add("local-tile");
    tile.classList.toggle("mirrored", facingMode === "user");
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const label = document.createElement("span");
  label.className = "video-tile-label";
  label.textContent = isSelf ? `${name} (tú${isModerator ? " · invisible" : ""})` : name;

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-tile-fullscreen-btn";
  fullscreenBtn.type = "button";
  fullscreenBtn.title = "Ver en pantalla completa";
  fullscreenBtn.textContent = "⛶";
  fullscreenBtn.addEventListener("click", () => enterFullscreen(video));

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(fullscreenBtn);

  // El volumen de cada persona se controla solo del lado de quien escucha,
  // sin tocar nada de la conexion: no tiene sentido para tu propio recuadro
  // (no te escuchas a vos mismo).
  if (!isLocal) {
    const volumeControl = document.createElement("input");
    volumeControl.type = "range";
    volumeControl.className = "video-tile-volume";
    volumeControl.min = "0";
    volumeControl.max = "1";
    volumeControl.step = "0.05";
    volumeControl.value = "1";
    volumeControl.title = "Volumen de esta persona";
    // gainNode se crea recien cuando el video tenga stream de verdad (ver
    // onRemoteStream en la funcion que llama a createVideoTile): antes de
    // eso no hay audio que enrutar.
    let gainNode = null;
    volumeControl.addEventListener("input", () => {
      if (gainNode) gainNode.gain.value = Number(volumeControl.value);
    });
    tile.appendChild(volumeControl);
    // Se expone en el propio elemento para que quien asigna el stream (mas
    // abajo) pueda conectar el audio real la primera vez que llega.
    video._connectVolumeControl = () => {
      if (gainNode) return; // ya conectado, no se puede conectar dos veces
      const stream = video.srcObject;
      if (!stream) return;
      const ctx = getSharedAudioContext();
      // Se toma el audio directo de la transmision (createMediaStreamSource),
      // no "por dentro" del <video> (createMediaElementSource): en iOS/Safari
      // viejo esa segunda forma es conocida por fallar con transmisiones en
      // vivo. Se silencia el <video> nativo para que el unico audio audible
      // sea el que pasa por este control de volumen.
      const source = ctx.createMediaStreamSource(stream);
      gainNode = ctx.createGain();
      gainNode.gain.value = Number(volumeControl.value);
      source.connect(gainNode).connect(ctx.destination);
      video.muted = true;
    };
  }

  els.videoGrid.appendChild(tile);
  return video;
}

// Safari/iOS no soporta el pedido de pantalla completa estandar sobre
// cualquier elemento: hay que pedirlo directo sobre el <video> con su
// propio metodo. Se prueban los tres en orden segun lo que soporte cada
// navegador.
function enterFullscreen(videoEl) {
  if (videoEl.requestFullscreen) {
    videoEl.requestFullscreen();
  } else if (videoEl.webkitRequestFullscreen) {
    videoEl.webkitRequestFullscreen();
  } else if (videoEl.webkitEnterFullscreen) {
    videoEl.webkitEnterFullscreen();
  }
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
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
  els.toggleCamBtn.textContent = "📷";
  els.toggleCamBtn.title = camOn ? "Apagar cámara" : "Activar cámara";
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
    els.joinError.textContent = "No se pudo conectar al servidor de la sala. Intenta de nuevo.";
    return;
  }
  els.joinError.textContent = "";
  els.joinScreen.classList.add("hidden");
  els.roomScreen.classList.remove("hidden");

  isModerator = !!welcome.isModerator;
  for (const member of welcome.members) {
    knownMembers.set(member.userId, { name: member.name, hidden: !!member.hidden });
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
      video._connectVolumeControl?.();
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
    knownMembers.set(msg.userId, { name: msg.name, hidden: !!msg.hidden });
    webrtcManager.handlePeerJoined(msg.userId);
    renderMemberList();
    if (!msg.hidden) notify("Nexus", `${msg.name} entró a la sala`, "nexus-presence");
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
  // si se salio de la sala mientras se compartia pantalla con el microfono
  // mezclado, el track real del microfono queda aparte (no es parte de
  // localStream en ese momento) y hay que apagarlo aca a mano.
  if (micTrackSetAsideForShare) micTrackSetAsideForShare.stop();
  disconnect();
  els.videoGrid.innerHTML = "";
  els.chatMessages.innerHTML = "";
  knownMembers.clear();
  micOn = false;
  camOn = false;
  screenShareActive = false;
  camWasOnBeforeShare = false;
  audioReplacedForShare = false;
  micWasOnBeforeShare = false;
  micTrackSetAsideForShare = null;
  if (audioMixContext) {
    audioMixContext.close();
    audioMixContext = null;
  }
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
  // Crear/desbloquear el AudioContext compartido aca, dentro del propio
  // toque del boton: en iOS/Safari un AudioContext creado fuera de un
  // gesto directo del usuario queda "suspendido" para siempre y ningun
  // audio suena, aunque el resto de la app funcione bien.
  getSharedAudioContext();
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
      updateMicButtonUI();
    } catch (err) {
      alert("No se pudo acceder al micrófono. Revisá los permisos del navegador.");
    }
    return;
  }
  micOn = !micOn;
  webrtcManager.setTrackEnabled("audio", micOn);
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
      updateCamButtonUI();
    } catch (err) {
      alert("No se pudo acceder a la cámara. Revisá los permisos del navegador.");
    }
    return;
  }
  camOn = !camOn;
  webrtcManager.setTrackEnabled("video", camOn);
  updateCamButtonUI();
});

els.switchCamBtn.addEventListener("click", async () => {
  const oldTrack = localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const newFacing = facingMode === "user" ? "environment" : "user";
  let newStream;
  try {
    // Pedir la camara "por identificador" (probar con cualquier otra que no
    // sea la actual) es mucho mas confiable entre celulares distintos que
    // pedir por facingMode: no todos los navegadores interpretan igual
    // "dame la trasera/frontal", pero casi todos listan bien las camaras
    // disponibles por su id.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    const currentId = oldTrack.getSettings().deviceId;
    const otherCamera = cameras.find((d) => d.deviceId && d.deviceId !== currentId);
    if (otherCamera) {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: otherCamera.deviceId } } });
    }
  } catch (err) {
    // seguir al siguiente intento
  }
  if (!newStream) {
    try {
      // Plan B: pedirla como preferencia (no exigencia) por facingMode.
      newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: newFacing } } });
    } catch (err2) {
      console.error("[NEXUS-DEBUG] error al cambiar de camara:", err2.name, err2.message);
      alert("No se pudo cambiar de cámara en este dispositivo.");
      return;
    }
  }
  const newTrack = newStream.getVideoTracks()[0];
  localStream.removeTrack(oldTrack);
  oldTrack.stop();
  localStream.addTrack(newTrack);
  const localVideoEl = document.querySelector(`#tile-${userId} video`);
  if (localVideoEl) localVideoEl.srcObject = localStream;
  webrtcManager.replaceLocalVideoTrack(newTrack);
  // El navegador suele informar la orientacion real de la camara elegida;
  // si no la informa, se asume que se alterno a la otra (mejor esfuerzo).
  const reportedFacing = newTrack.getSettings().facingMode;
  facingMode = reportedFacing || newFacing;
  document.getElementById(`tile-${userId}`)?.classList.toggle("mirrored", facingMode === "user");
});

// Compartir pantalla ocupa el mismo "lugar" que la camara (no se ven las
// dos a la vez): mientras se comparte, la pantalla reemplaza el video que
// mandas a los demas, igual que si cambiaras de camara. Al dejar de
// compartir (con el boton o con el "Dejar de compartir" propio del
// navegador) se intenta volver a la camara, solo si estaba prendida antes.
els.shareScreenBtn.addEventListener("click", async () => {
  if (screenShareActive) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices.getDisplayMedia) {
    alert("Este dispositivo o navegador no permite compartir pantalla.");
    return;
  }
  let screenStream;
  try {
    // El audio queda a criterio del navegador: solo lo entrega si el
    // usuario tilda "Compartir audio" en el propio selector (y no todos los
    // navegadores lo ofrecen para cualquier tipo de pantalla/pestaña).
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    return; // el usuario cerro el selector o nego el permiso, no hace falta avisar nada
  }
  const screenTrack = screenStream.getVideoTracks()[0];
  const existingVideoTrack = localStream.getVideoTracks()[0];
  camWasOnBeforeShare = camOn && !!existingVideoTrack;
  if (existingVideoTrack) {
    localStream.removeTrack(existingVideoTrack);
    existingVideoTrack.stop();
  }
  localStream.addTrack(screenTrack);
  const localVideoEl = document.querySelector(`#tile-${userId} video`);
  if (localVideoEl) localVideoEl.srcObject = localStream;
  document.getElementById(`tile-${userId}`)?.classList.remove("mirrored");
  camOn = true;
  webrtcManager.setTrackEnabled("video", true);
  if (existingVideoTrack) {
    // ya existia un video (prendido o apagado) para al menos un peer: se
    // reemplaza el track del sender que ya existe, sin renegociar.
    webrtcManager.replaceLocalVideoTrack(screenTrack);
  } else {
    // nunca se mando video antes: hay que agregarlo de cero y renegociar
    // con cada par, igual que la primera vez que se prende la camara.
    webrtcManager.addLocalTrack(screenTrack);
  }

  const screenAudioTrack = screenStream.getAudioTracks()[0];
  if (screenAudioTrack) {
    const existingAudioTrack = localStream.getAudioTracks()[0];
    // Si el microfono ya estaba apagado, se manda solo el audio de la
    // pantalla (sin mezclar), respetando que el usuario se habia
    // silenciado. Si estaba prendido, se mezclan los dos en un solo track,
    // para que la voz no desaparezca mientras se comparte.
    micWasOnBeforeShare = micOn && !!existingAudioTrack;
    let outgoingAudioTrack = screenAudioTrack;
    if (existingAudioTrack) {
      micTrackSetAsideForShare = existingAudioTrack;
      localStream.removeTrack(existingAudioTrack);
      if (micWasOnBeforeShare) {
        audioMixContext = new (window.AudioContext || window.webkitAudioContext)();
        const destination = audioMixContext.createMediaStreamDestination();
        audioMixContext.createMediaStreamSource(new MediaStream([existingAudioTrack])).connect(destination);
        audioMixContext.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(destination);
        outgoingAudioTrack = destination.stream.getAudioTracks()[0];
      }
    }
    localStream.addTrack(outgoingAudioTrack);
    micOn = true;
    webrtcManager.setTrackEnabled("audio", true);
    if (existingAudioTrack) {
      webrtcManager.replaceLocalAudioTrack(outgoingAudioTrack);
    } else {
      webrtcManager.addLocalTrack(outgoingAudioTrack);
    }
    audioReplacedForShare = true;
    updateMicButtonUI();
    els.toggleMicBtn.disabled = true;
  }

  screenShareActive = true;
  // si el usuario cierra "Dejar de compartir" desde el propio navegador
  // (en vez de nuestro boton), el track avisa solo con "ended".
  screenTrack.addEventListener("ended", () => stopScreenShare());
  updateCamButtonUI();
  els.toggleCamBtn.disabled = true;
  els.switchCamBtn.disabled = true;
  els.shareScreenBtn.classList.add("muted");
  els.shareScreenBtn.textContent = "🟥";
  els.shareScreenBtn.title = "Dejar de compartir pantalla";
  els.shareScreenLabel.textContent = "Detener";
});

async function stopScreenShare() {
  if (!screenShareActive) return;
  screenShareActive = false;
  const screenTrack = localStream.getVideoTracks()[0];
  if (screenTrack) {
    localStream.removeTrack(screenTrack);
    screenTrack.stop();
  }
  camOn = false;
  if (camWasOnBeforeShare) {
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
      const newCamTrack = camStream.getVideoTracks()[0];
      localStream.addTrack(newCamTrack);
      webrtcManager.replaceLocalVideoTrack(newCamTrack);
      camOn = true;
    } catch (err) {
      // no se pudo recuperar la camara (permiso revocado, etc.): se queda
      // sin video, igual que si el usuario la hubiera apagado a mano.
    }
  }
  camWasOnBeforeShare = false;
  const localVideoEl = document.querySelector(`#tile-${userId} video`);
  if (localVideoEl) localVideoEl.srcObject = localStream;
  document.getElementById(`tile-${userId}`)?.classList.toggle("mirrored", camOn && facingMode === "user");
  webrtcManager.setTrackEnabled("video", camOn);
  updateCamButtonUI();
  els.toggleCamBtn.disabled = false;

  if (audioReplacedForShare) {
    const outgoingAudioTrack = localStream.getAudioTracks()[0];
    if (outgoingAudioTrack) {
      // esto para tanto el audio "puro" de la pantalla como, si se mezclo,
      // el track sintetico de la mezcla -- el track real del microfono esta
      // a salvo aparte, en micTrackSetAsideForShare, y no se toca aca.
      localStream.removeTrack(outgoingAudioTrack);
      outgoingAudioTrack.stop();
    }
    if (audioMixContext) {
      audioMixContext.close();
      audioMixContext = null;
    }
    if (micTrackSetAsideForShare) {
      // se recupera el mismo track real del microfono (sin volver a pedir
      // permiso ni reiniciar el hardware), respetando si estaba prendido o
      // apagado antes de compartir.
      localStream.addTrack(micTrackSetAsideForShare);
      webrtcManager.replaceLocalAudioTrack(micTrackSetAsideForShare);
      micOn = micWasOnBeforeShare;
      micTrackSetAsideForShare = null;
    } else {
      // no habia microfono antes: se apaga, igual que si el usuario lo
      // hubiera silenciado a mano.
      micOn = false;
    }
    micWasOnBeforeShare = false;
    webrtcManager.setTrackEnabled("audio", micOn);
    audioReplacedForShare = false;
    updateMicButtonUI();
    els.toggleMicBtn.disabled = false;
  }

  els.shareScreenBtn.classList.remove("muted");
  els.shareScreenBtn.textContent = "🖥️";
  els.shareScreenBtn.title = "Compartir pantalla";
  els.shareScreenLabel.textContent = "Pantalla";
}

// Solo oculta la grilla de video de la propia pantalla (no afecta a los
// demas participantes ni corta ninguna camara/microfono): pensado para
// cuando hay mucha gente y los recuadros de video empujan el chat lejos.
els.toggleVideosBtn.addEventListener("click", () => {
  const hidden = els.videoGrid.classList.toggle("collapsed");
  els.toggleVideosBtn.classList.toggle("active", hidden);
  els.toggleVideosBtn.textContent = hidden ? "🙈" : "🎥";
  els.toggleVideosBtn.title = hidden ? "Mostrar cámaras" : "Ocultar cámaras";
  els.toggleVideosLabel.textContent = hidden ? "Mostrar video" : "Ocultar video";
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
