import { connect, on, sendChat, sendDm, kickUser, disconnect } from "./realtime.js";
import { createWebRTCManager } from "./webrtc.js?v=3";

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
  chatTabs: document.getElementById("chat-tabs"),
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

// Sonido de aviso al recibir un mensaje privado. Se usan varios reproductores
// en vez de uno solo: en iOS, reiniciar (currentTime = 0) el mismo <audio>
// mientras todavia esta sonando puede hacer que la reproduccion se pise y no
// se escuche nada si llega otro mensaje antes de que termine el anterior.
// Con varios, cada mensaje usa uno libre por turno, sin pisarse. Todos se
// crean y se "activan" con un play/pause silencioso dentro del propio clic
// de "Entrar a la Sala" (ver joinForm): en iOS/Safari un audio reproducido
// fuera de un gesto directo del usuario queda bloqueado para siempre si no
// se lo desbloquea asi primero.
const DM_SOUND_POOL_SIZE = 4;
let dmSoundPool = [];
let dmSoundPoolIndex = 0;
function playDmSound() {
  if (dmSoundPool.length === 0) return;
  const player = dmSoundPool[dmSoundPoolIndex];
  dmSoundPoolIndex = (dmSoundPoolIndex + 1) % dmSoundPool.length;
  player.currentTime = 0;
  player.play().catch(() => {});
}
let localStream = null; // MediaStream mutable: arranca vacio, se le suman tracks al activarlos
let webrtcManager = null;
let micOn = false;
let camOn = false;
let facingMode = "user";
let screenShareActive = false;
let camWasOnBeforeShare = false; // para saber si hay que volver a prender la camara al dejar de compartir
let camTrackKeptAliveForShare = null; // la camara real, viva de fondo mientras se comparte (para el moderador)
let audioReplacedForShare = false; // si se toco el audio al compartir (por eso hay que restaurarlo al terminar)
let micTrackSetAsideForShare = null; // el track real del microfono, guardado mientras se comparte pantalla
let audioMixContext = null; // AudioContext usado para mezclar microfono + audio de la pantalla
let micGainNode = null; // controla en vivo cuanto del microfono entra a la mezcla (para poder silenciarlo mientras se comparte)
let notificationsEnabled = false;
const knownMembers = new Map(); // peerId -> { name, hidden }
const roomListeners = []; // funciones para darse de baja al salir de la sala

// Mensajes privados: cada pestaña del chat (aparte de "general") es una
// conversacion 1 a 1, guardada aca del lado del cliente (el servidor no
// guarda historial de privados, solo los reenvia en el momento).
let activeThread = "general"; // "general" | "mod-all" | peerId de un DM
const generalMessages = []; // buffer local del chat publico, para poder re-renderizar al volver a esta pestaña
const dmThreads = new Map(); // peerId -> [{from, fromName, to, toName, text, at}]
const allPrivateLog = []; // solo para el moderador: TODOS los privados de la sala, en orden

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
  video.controls = false;
  if (isLocal) video.muted = true;

  const label = document.createElement("span");
  label.className = "video-tile-label";
  label.textContent = isSelf ? `${name} (tú${isModerator ? " · invisible" : ""})` : name;

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-tile-fullscreen-btn";
  fullscreenBtn.type = "button";
  fullscreenBtn.title = "Ver en pantalla completa";
  fullscreenBtn.textContent = "⛶";
  fullscreenBtn.addEventListener("click", () => enterFullscreen(tile, video));

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(fullscreenBtn);

  // El volumen de cada persona se controla solo del lado de quien escucha,
  // sin tocar nada de la conexion: no tiene sentido para tu propio recuadro
  // (no te escuchas a vos mismo).
  if (!isLocal) {
    // El audio real sale por Web Audio API (ver _connectVolumeControl), no
    // por el propio <video>, que por eso arranca silenciado.
    video.muted = true;

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
    // Mientras el iPhone/iPad esta en su pantalla completa nativa (unico
    // metodo posible en Safari viejo, ver enterFullscreen), su propio
    // reproductor trae un boton de volumen/mute -- pero como el audio real
    // pasa por Web Audio, ese boton nativo no hacia nada, y si el usuario
    // lo tocaba para "desmutear" el <video>, se escuchaba doble. En vez de
    // bloquearlo, se le cede el control real mientras dure: se apaga
    // nuestra mezcla (gain a 0) y se deja sonar al <video> nativo, asi el
    // boton nativo si mutea/desmutea de verdad. Al salir de esa pantalla
    // completa se vuelve a nuestro control de siempre.
    let inNativeFullscreen = false;
    video.addEventListener("volumechange", () => {
      if (!inNativeFullscreen && !video.muted) video.muted = true;
    });
    video.addEventListener("webkitbeginfullscreen", () => {
      inNativeFullscreen = true;
      video.muted = false;
      if (gainNode) gainNode.gain.value = 0;
    });
    video.addEventListener("webkitendfullscreen", () => {
      inNativeFullscreen = false;
      video.muted = true;
      if (gainNode) gainNode.gain.value = Number(volumeControl.value);
    });
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
      // vivo.
      const source = ctx.createMediaStreamSource(stream);
      gainNode = ctx.createGain();
      gainNode.gain.value = inNativeFullscreen ? 0 : Number(volumeControl.value);
      source.connect(gainNode).connect(ctx.destination);
    };
  }

  els.videoGrid.appendChild(tile);
  return video;
}

// Safari/iOS no soporta el pedido de pantalla completa estandar sobre
// cualquier elemento: hay que pedirlo directo sobre el <video> con su
// propio metodo. Se prueban los tres en orden segun lo que soporte cada
// navegador.
// Se pide pantalla completa sobre el RECUADRO entero (tileEl), no sobre el
// <video> directamente: cuando un <video> entra en pantalla completa por si
// solo, varios navegadores (Chrome sobre todo) le agregan sus propios
// controles nativos encima, incluido un control de volumen que no tiene
// ninguna conexion con el nuestro (el audio real pasa por Web Audio API,
// no por el volumen nativo del <video>) y por eso no hacia nada. Poniendo
// en pantalla completa el contenedor en vez del video evita que el
// navegador agregue esos controles. El unico caso que sigue necesitando el
// <video> directamente es el metodo propio de iOS/Safari viejo
// (webkitEnterFullscreen), que no funciona sobre un div generico -- ahi no
// hay forma de evitar los controles nativos del sistema, es una limitacion
// de esa plataforma.
function enterFullscreen(tileEl, videoEl) {
  if (tileEl.requestFullscreen) {
    tileEl.requestFullscreen();
  } else if (tileEl.webkitRequestFullscreen) {
    tileEl.webkitRequestFullscreen();
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
    if (id !== userId) {
      const nameEl = li.querySelector(".member-name");
      nameEl.classList.add("clickable");
      nameEl.title = `Enviar mensaje privado a ${info.name}`;
      nameEl.addEventListener("click", () => openDmWith(id, info.name));
    }
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

function appendMessageBubble(html, isOwn, extraClass = "") {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message" + (isOwn ? " own" : "") + (extraClass ? ` ${extraClass}` : "");
  wrapper.innerHTML = html;
  els.chatMessages.appendChild(wrapper);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderMessage(entry) {
  generalMessages.push(entry);
  if (activeThread !== "general") {
    if (entry.userId !== userId) markThreadUnread("general");
    return;
  }
  const { name, text, userId: authorId } = entry;
  appendMessageBubble(
    `<span class="chat-author">${escapeHtml(name)}</span><span class="chat-text">${escapeHtml(text)}</span>`,
    authorId === userId
  );
}

// showBothNames se usa en la pestaña del moderador que ve TODOS los
// privados de la sala (no solo los propios): ahi hace falta aclarar quien
// le escribio a quien, algo que no hace falta en una conversacion 1 a 1.
function renderDmMessage(entry, { showBothNames = false } = {}) {
  const isOwn = entry.from === userId;
  const authorLabel = showBothNames
    ? `${escapeHtml(entry.fromName)} → ${escapeHtml(entry.toName)}`
    : escapeHtml(isOwn ? "Tú" : entry.fromName);
  appendMessageBubble(
    `<span class="chat-author">${authorLabel}</span><span class="chat-text">${escapeHtml(entry.text)}</span>`,
    isOwn,
    "dm"
  );
}

function markThreadUnread(threadId) {
  if (threadId === activeThread) return;
  const tab = els.chatTabs.querySelector(`[data-thread="${CSS.escape(threadId)}"]`);
  tab?.classList.add("unread");
}

function ensureDmTab(peerId, name) {
  if (els.chatTabs.querySelector(`[data-thread="${CSS.escape(peerId)}"]`)) return;
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "chat-tab";
  tab.dataset.thread = peerId;
  tab.textContent = name;
  tab.addEventListener("click", () => switchThread(peerId));
  els.chatTabs.appendChild(tab);
}

function ensureModAllTab() {
  if (els.chatTabs.querySelector('[data-thread="mod-all"]')) return;
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "chat-tab mod-all-tab";
  tab.dataset.thread = "mod-all";
  tab.title = "Todos los mensajes privados de la sala";
  tab.textContent = "🔒 Privados (todos)";
  tab.addEventListener("click", () => switchThread("mod-all"));
  els.chatTabs.appendChild(tab);
}

function openDmWith(peerId, name) {
  ensureDmTab(peerId, name);
  switchThread(peerId);
}

function switchThread(threadId) {
  activeThread = threadId;
  for (const tab of els.chatTabs.querySelectorAll(".chat-tab")) {
    const isActive = tab.dataset.thread === threadId;
    tab.classList.toggle("active", isActive);
    if (isActive) tab.classList.remove("unread");
  }
  els.chatMessages.innerHTML = "";
  if (threadId === "general") {
    for (const entry of generalMessages) renderMessageBubbleOnly(entry);
  } else if (threadId === "mod-all") {
    if (allPrivateLog.length === 0) {
      els.chatMessages.innerHTML = '<p class="empty-thread-hint">Todavía no hay mensajes privados en la sala.</p>';
    }
    for (const entry of allPrivateLog) renderDmMessage(entry, { showBothNames: true });
  } else {
    const thread = dmThreads.get(threadId) || [];
    if (thread.length === 0) {
      els.chatMessages.innerHTML = '<p class="empty-thread-hint">Escribí el primer mensaje privado.</p>';
    }
    for (const entry of thread) renderDmMessage(entry);
  }
  els.chatInput.placeholder =
    threadId === "general" ? "Escribe un mensaje..." : threadId === "mod-all" ? "" : "Mensaje privado...";
  els.chatInput.disabled = threadId === "mod-all";
  els.chatForm.querySelector(".btn-send").disabled = threadId === "mod-all";
}

// Version de renderMessage que NO vuelve a guardar en generalMessages (ya
// esta ahi): se usa solo al re-dibujar la pestaña "general" desde el buffer.
function renderMessageBubbleOnly({ name, text, userId: authorId }) {
  appendMessageBubble(
    `<span class="chat-author">${escapeHtml(name)}</span><span class="chat-text">${escapeHtml(text)}</span>`,
    authorId === userId
  );
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
  if (isModerator) ensureModAllTab();

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
    onRemoveStream: (peerId) => {
      removeVideoTile(peerId);
      removeVideoTile(`${peerId}-modcam`);
    },
    // Solo le llega algo a esto si yo soy moderador y otra persona esta
    // compartiendo pantalla: es su camara real, aparte, en su propio
    // recuadro (ver sendCameraToModerators en webrtc.js).
    onModeratorExtraStream: (peerId, stream, track) => {
      const info = knownMembers.get(peerId);
      const video = createVideoTile(`${peerId}-modcam`, `${info?.name || "Usuario"} (cámara real)`);
      video.srcObject = stream;
      video._connectVolumeControl?.();
      track.addEventListener("ended", () => removeVideoTile(`${peerId}-modcam`));
    },
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

  // El servidor borra el historial de chat cada 8 minutos: se limpia
  // tambien la pantalla de quien ya esta conectado, no solo la de quien
  // entra despues (que ya no recibe nada viejo en el mensaje de bienvenida).
  // Solo afecta al chat general -- los privados no se borran solos.
  addRoomListener("chat-cleared", () => {
    generalMessages.length = 0;
    if (activeThread === "general") els.chatMessages.innerHTML = "";
  });

  // Mensajes privados: los propios (donde soy remitente o destinatario) van
  // a su propia pestaña 1 a 1; si soy moderador, ademas veo cualquier
  // privado ajeno en la pestaña especial "Privados (todos)".
  addRoomListener("dm", (msg) => {
    const isMine = msg.from === userId || msg.to === userId;
    if (isMine) {
      const otherId = msg.from === userId ? msg.to : msg.from;
      const otherName = msg.from === userId ? msg.toName : msg.fromName;
      if (!dmThreads.has(otherId)) dmThreads.set(otherId, []);
      dmThreads.get(otherId).push(msg);
      ensureDmTab(otherId, otherName);
      if (msg.from !== userId) playDmSound();
      if (activeThread === otherId) {
        renderDmMessage(msg);
      } else {
        markThreadUnread(otherId);
        if (msg.from !== userId) notify(`${msg.fromName} (privado)`, msg.text, "nexus-dm-" + otherId);
      }
    }
    if (isModerator && msg.from !== userId && msg.to !== userId) {
      allPrivateLog.push(msg);
      ensureModAllTab();
      if (activeThread === "mod-all") {
        renderDmMessage(msg, { showBothNames: true });
      } else {
        markThreadUnread("mod-all");
      }
    }
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
  // si se salio de la sala mientras se compartia pantalla, tanto el
  // microfono mezclado como la camara real siguen vivos aparte (no son
  // parte de localStream en ese momento) y hay que apagarlos aca a mano.
  if (micTrackSetAsideForShare) micTrackSetAsideForShare.stop();
  if (camTrackKeptAliveForShare) camTrackKeptAliveForShare.stop();
  disconnect();
  els.videoGrid.innerHTML = "";
  els.chatMessages.innerHTML = "";
  knownMembers.clear();
  generalMessages.length = 0;
  dmThreads.clear();
  allPrivateLog.length = 0;
  activeThread = "general";
  // saca cualquier pestaña de privado que haya quedado, deja solo "General"
  for (const tab of [...els.chatTabs.querySelectorAll(".chat-tab")]) {
    if (tab.dataset.thread !== "general") tab.remove();
    else tab.classList.add("active");
  }
  els.chatInput.disabled = false;
  els.chatInput.placeholder = "Escribe un mensaje...";
  els.chatForm.querySelector(".btn-send").disabled = false;
  micOn = false;
  camOn = false;
  screenShareActive = false;
  camWasOnBeforeShare = false;
  camTrackKeptAliveForShare = null;
  audioReplacedForShare = false;
  micTrackSetAsideForShare = null;
  micGainNode = null;
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
  // Mismo motivo: se "activan" los reproductores del sonido de mensaje
  // privado con un play/pause silencioso dentro de este mismo clic.
  dmSoundPool = Array.from({ length: DM_SOUND_POOL_SIZE }, () => {
    const player = new Audio("sounds/mp.mp3");
    player.volume = 0.6;
    player.play().then(() => player.pause()).catch(() => {});
    return player;
  });
  await joinRoom();
});

els.chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || activeThread === "mod-all") return;
  els.chatInput.value = "";
  if (activeThread === "general") {
    sendChat(text.slice(0, 500));
  } else {
    sendDm(activeThread, text.slice(0, 500));
  }
});

// La pestaña "General" ya existe en el HTML desde el arranque (las demas
// se crean solas al abrir un privado, ver ensureDmTab/ensureModAllTab).
els.chatTabs.querySelector('[data-thread="general"]').addEventListener("click", () => switchThread("general"));

els.leaveBtn.addEventListener("click", cleanupAndReturnToJoinScreen);

// El track original de localStream nunca se apaga: los botones solo controlan
// la copia que reciben los demas participantes (ver webrtc.js setTrackEnabled).
// Un moderador invisible sigue recibiendo la copia real de lo que el usuario
// haya autorizado, segun el aviso mostrado en la pantalla de ingreso.
els.toggleMicBtn.addEventListener("click", async () => {
  if (screenShareActive && micGainNode) {
    // Mientras se comparte pantalla con audio mezclado, prender/apagar el
    // microfono no cambia el track que sale (la mezcla sigue siendo la
    // misma): solo sube o baja a 0 el volumen del microfono DENTRO de esa
    // mezcla, el audio de la pantalla sigue sonando igual.
    micOn = !micOn;
    micGainNode.gain.value = micOn ? 1 : 0;
    updateMicButtonUI();
    return;
  }
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
    // La camara real NO se apaga: sigue capturando de fondo para poder
    // mandarsela al moderador (si hay uno), igual que ya puede ver/escuchar
    // a cualquiera aunque se haya silenciado para el resto -- ver el aviso
    // de la pantalla de ingreso. Al resto de la sala le sigue llegando la
    // pantalla, nunca la camara, mientras dure la transmision.
    camTrackKeptAliveForShare = existingVideoTrack;
    localStream.removeTrack(existingVideoTrack);
    webrtcManager.sendCameraToModerators(existingVideoTrack);
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
    let outgoingAudioTrack = screenAudioTrack;
    if (existingAudioTrack) {
      // Se arma la mezcla aunque el microfono este apagado en este momento,
      // con un control de volumen propio (GainNode) para el microfono: asi
      // se puede prender/apagar en vivo mientras se comparte, sin tener que
      // rearmar la mezcla cada vez.
      micTrackSetAsideForShare = existingAudioTrack;
      localStream.removeTrack(existingAudioTrack);
      audioMixContext = new (window.AudioContext || window.webkitAudioContext)();
      const destination = audioMixContext.createMediaStreamDestination();
      micGainNode = audioMixContext.createGain();
      micGainNode.gain.value = micOn ? 1 : 0;
      audioMixContext
        .createMediaStreamSource(new MediaStream([existingAudioTrack]))
        .connect(micGainNode)
        .connect(destination);
      audioMixContext.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(destination);
      outgoingAudioTrack = destination.stream.getAudioTracks()[0];
    } else {
      // nunca hubo microfono: se manda solo el audio de la pantalla: no hay
      // nada que prender/apagar sin pedir permiso de nuevo, asi que el
      // boton de microfono queda deshabilitado mientras dure esta sesion de
      // compartir.
      micOn = false;
    }
    localStream.addTrack(outgoingAudioTrack);
    webrtcManager.setTrackEnabled("audio", true);
    if (existingAudioTrack) {
      webrtcManager.replaceLocalAudioTrack(outgoingAudioTrack);
    } else {
      webrtcManager.addLocalTrack(outgoingAudioTrack);
    }
    audioReplacedForShare = true;
    updateMicButtonUI();
    els.toggleMicBtn.disabled = !existingAudioTrack;
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
  webrtcManager.stopCameraToModerators();
  camOn = false;
  if (camTrackKeptAliveForShare) {
    // se recupera la misma camara real que siguio prendida de fondo (sin
    // volver a pedir permiso ni reiniciar el hardware).
    localStream.addTrack(camTrackKeptAliveForShare);
    webrtcManager.replaceLocalVideoTrack(camTrackKeptAliveForShare);
    camTrackKeptAliveForShare = null;
    camOn = camWasOnBeforeShare;
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
    micGainNode = null;
    if (micTrackSetAsideForShare) {
      // se recupera el mismo track real del microfono (sin volver a pedir
      // permiso ni reiniciar el hardware). micOn ya refleja el ultimo
      // estado elegido (pudo haberse prendido/apagado durante la
      // transmision con el mismo boton).
      localStream.addTrack(micTrackSetAsideForShare);
      webrtcManager.replaceLocalAudioTrack(micTrackSetAsideForShare);
      micTrackSetAsideForShare = null;
    } else {
      // no habia microfono antes: se apaga, igual que si el usuario lo
      // hubiera silenciado a mano.
      micOn = false;
    }
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
