import {
  connect,
  on,
  sendChat,
  sendDm,
  sendGif,
  sendGifDm,
  sendDmMedia,
  uploadMedia,
  mediaUrl,
  sendCallInvite,
  sendCallAccept,
  sendCallReject,
  sendCallCancel,
  sendCallHangup,
  kickUser,
  disconnect,
} from "./realtime.js?v=4";
import { createWebRTCManager } from "./webrtc.js?v=9";

const modKeyFromUrl = new URLSearchParams(window.location.search).get("mod") || "";

const els = {
  joinScreen: document.getElementById("join-screen"),
  roomScreen: document.getElementById("room-screen"),
  chatPanel: document.getElementById("chat-panel"),
  expandChatBtn: document.getElementById("expand-chat-btn"),
  joinForm: document.getElementById("join-form"),
  usernameInput: document.getElementById("username-input"),
  joinError: document.getElementById("join-error"),
  memberList: document.getElementById("member-list"),
  memberCount: document.getElementById("member-count"),
  videoGrid: document.getElementById("video-grid"),
  chatMessages: document.getElementById("chat-messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  emojiBtn: document.getElementById("emoji-btn"),
  emojiPicker: document.getElementById("emoji-picker"),
  emojiTabs: document.getElementById("emoji-tabs"),
  emojiGrid: document.getElementById("emoji-grid"),
  gifBtn: document.getElementById("gif-btn"),
  gifPicker: document.getElementById("gif-picker"),
  attachBtn: document.getElementById("attach-btn"),
  attachFileInput: document.getElementById("attach-file-input"),
  cameraCaptureBtn: document.getElementById("camera-capture-btn"),
  callOutgoingOverlay: document.getElementById("call-outgoing-overlay"),
  callOutgoingName: document.getElementById("call-outgoing-name"),
  callCancelBtn: document.getElementById("call-cancel-btn"),
  callIncomingOverlay: document.getElementById("call-incoming-overlay"),
  callIncomingName: document.getElementById("call-incoming-name"),
  callRejectBtn: document.getElementById("call-reject-btn"),
  callAcceptBtn: document.getElementById("call-accept-btn"),
  callPanel: document.getElementById("call-panel"),
  callPanelHeader: document.getElementById("call-panel-header"),
  callPanelName: document.getElementById("call-panel-name"),
  callPanelMedia: document.getElementById("call-panel-media"),
  callRemoteVideo: document.getElementById("call-remote-video"),
  callLocalVideo: document.getElementById("call-local-video"),
  callVolume: document.getElementById("call-volume"),
  callMuteBtn: document.getElementById("call-mute-btn"),
  callCameraBtn: document.getElementById("call-camera-btn"),
  callFullscreenBtn: document.getElementById("call-fullscreen-btn"),
  callHangupBtn: document.getElementById("call-hangup-btn"),
  leaveBtn: document.getElementById("leave-btn"),
  toggleMicBtn: document.getElementById("toggle-mic-btn"),
  toggleCamBtn: document.getElementById("toggle-cam-btn"),
  switchCamBtn: document.getElementById("switch-cam-btn"),
  chooseCamBtn: document.getElementById("choose-cam-btn"),
  cameraPicker: document.getElementById("camera-picker"),
  shareScreenBtn: document.getElementById("share-screen-btn"),
  shareScreenLabel: document.getElementById("share-screen-label"),
  toggleVideosBtn: document.getElementById("toggle-videos-btn"),
  toggleVideosLabel: document.getElementById("toggle-videos-label"),
  notifyBtn: document.getElementById("notify-btn"),
  chatTabs: document.getElementById("chat-tabs"),
};

// Mismos limites que aplica el servidor (ver MEDIA_LIMITS en server.js):
// se repiten aca solo para avisar antes de subir, no como fuente de verdad
// (esa siempre es el servidor).
const MEDIA_LIMITS_CLIENT = {
  image: 8 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
  document: 15 * 1024 * 1024,
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

// Llamada privada 1 a 1: ver startOutgoingCall mas abajo. Solo una llamada
// a la vez tiene sentido en esta interfaz.
let callState = "idle"; // "idle" | "calling" | "ringing" | "active"
let callPeerId = null;
let callPeerName = "";
let callLocalStream = null; // microfono (+ camara si se prende) de la llamada activa
let callVideoOn = false;
let callRingTimeout = null;
const callRemoteTracks = new Set(); // ver handleCallTrack: se reconstruye la stream entera cada vez

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
  let switchCamTileBtn = null;
  if (isLocal) {
    tile.classList.add("local-tile");
    tile.classList.toggle("mirrored", facingMode === "user");

    // Mismo cambio de camara que el boton de la barra de controles, pero
    // puesto directo encima de tu propia vista previa: asi ves el resultado
    // del cambio en el momento, sin tener que buscar el boton de abajo. Usa
    // un icono distinto (no el mismo que el de la barra) porque, al quedar
    // flotando sobre el video, un boton identico ahi se veia feo/confuso.
    switchCamTileBtn = document.createElement("button");
    switchCamTileBtn.className = "video-tile-switch-cam-btn";
    switchCamTileBtn.type = "button";
    switchCamTileBtn.title = "Cambiar de cámara";
    switchCamTileBtn.textContent = "⇄";
    switchCamTileBtn.disabled = els.switchCamBtn.disabled;
    switchCamTileBtn.addEventListener("click", switchCamera);
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
  fullscreenBtn.addEventListener("click", () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === tile || fsEl === video) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    // iOS/Safari viejo con webkitEnterFullscreen (ver enterFullscreen mas
    // abajo) no pasa por document.fullscreenElement: esta propiedad aparte
    // (webkitDisplayingFullscreen) es la que avisa si ESE video puntual
    // esta en su pantalla completa nativa, y su salida es un metodo propio
    // del <video>, no de document.
    if (video.webkitDisplayingFullscreen) {
      video.webkitExitFullscreen?.();
      return;
    }
    // Adelantado al propio clic (ver donde se define mas abajo): en iOS,
    // desmutear por codigo solo funciona bien dentro del toque directo.
    video._handoffToNativeFullscreenAudio?.();
    enterFullscreen(tile, video);
  });

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(fullscreenBtn);
  if (switchCamTileBtn) tile.appendChild(switchCamTileBtn);

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
    // Se expone para poder llamarla synchronicamente desde el propio clic
    // del boton de pantalla completa (ver mas abajo): en iOS, desmutear un
    // <video> por codigo solo funciona bien si pasa dentro del toque
    // directo del usuario, no un instante despues cuando recien avisa el
    // evento "ya entre a pantalla completa" -- por eso esta misma funcion
    // se llama en los dos momentos (el clic, como adelanto, y el evento,
    // como respaldo si por algo no se pudo antes).
    video._handoffToNativeFullscreenAudio = () => {
      if (inNativeFullscreen) return;
      inNativeFullscreen = true;
      video.muted = false;
      if (gainNode) gainNode.gain.value = 0;
    };
    video.addEventListener("volumechange", () => {
      if (!inNativeFullscreen && !video.muted) video.muted = true;
    });
    video.addEventListener("webkitbeginfullscreen", video._handoffToNativeFullscreenAudio);
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
      // El video y el audio de la misma persona no siempre llegan en el
      // mismo momento: si todavia no hay ninguna pista de audio en la
      // transmision, createMediaStreamSource tira error. Se espera a que
      // llegue (evento "addtrack" de la propia MediaStream) en vez de
      // fallar -- el video ya se ve igual, esto solo es para el audio.
      if (stream.getAudioTracks().length === 0) {
        stream.addEventListener("addtrack", () => video._connectVolumeControl(), { once: true });
        return;
      }
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
  return wrapper;
}

// El nombre de quien mando un mensaje en el chat general es clickeable (si
// no es el propio) para abrir un privado con esa persona, igual que ya se
// podia hacer desde la lista de miembros. authorId viaja en un data-* en
// vez de en un listener por elemento porque estos mensajes se arman como
// string de HTML (ver appendMessageBubble); un solo listener delegado en
// els.chatMessages (mas abajo) se encarga de todos.
function authorSpanHtml(name, authorId, isOwn) {
  const safeName = escapeHtml(name);
  if (isOwn) return `<span class="chat-author">${safeName}</span>`;
  return `<span class="chat-author clickable-author" data-user-id="${escapeHtml(authorId)}" title="Enviar mensaje privado a ${safeName}">${safeName}</span>`;
}

// El nombre del archivo viene de otro usuario: se arma el <img> con
// createElement/.src (nunca interpolado en un string de HTML) para que no
// haya forma de que un nombre de archivo raro termine inyectando HTML.
function appendGifBubble(name, authorId, filename, isOwn) {
  const wrapper = appendMessageBubble(authorSpanHtml(name, authorId, isOwn), isOwn, "gif");
  const img = document.createElement("img");
  img.src = `gifs/${encodeURIComponent(filename)}`;
  img.alt = filename;
  img.loading = "lazy";
  wrapper.appendChild(img);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderMessage(entry) {
  generalMessages.push(entry);
  if (activeThread !== "general") {
    if (entry.userId !== userId) markThreadUnread("general");
    return;
  }
  renderMessageBubbleOnly(entry);
}

// showBothNames se usa en la pestaña del moderador que ve TODOS los
// privados de la sala (no solo los propios): ahi hace falta aclarar quien
// le escribio a quien, algo que no hace falta en una conversacion 1 a 1.
function renderDmMessage(entry, { showBothNames = false } = {}) {
  const isOwn = entry.from === userId;
  const authorLabel = showBothNames
    ? `${escapeHtml(entry.fromName)} → ${escapeHtml(entry.toName)}`
    : escapeHtml(isOwn ? "Tú" : entry.fromName);
  if (entry.mediaKind) {
    const wrapper = appendMessageBubble(
      `<span class="chat-author">${authorLabel}</span>`,
      isOwn,
      `dm media-${entry.mediaKind}`
    );
    appendMediaElement(wrapper, entry.mediaKind, entry.fileId);
    return;
  }
  if (entry.filename) {
    const wrapper = appendMessageBubble(`<span class="chat-author">${authorLabel}</span>`, isOwn, "dm gif");
    const img = document.createElement("img");
    img.src = `gifs/${encodeURIComponent(entry.filename)}`;
    img.alt = entry.filename;
    img.loading = "lazy";
    wrapper.appendChild(img);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    return;
  }
  appendMessageBubble(
    `<span class="chat-author">${authorLabel}</span><span class="chat-text">${escapeHtml(entry.text)}</span>`,
    isOwn,
    "dm"
  );
}

// El fileId lo genera el servidor (ver uploadMedia/handleUpload), nunca lo
// escribe el propio usuario: se arma con createElement/.src igual que los
// gifs, nunca interpolado en un string de HTML.
function appendMediaElement(wrapper, mediaKind, fileId) {
  const url = mediaUrl(fileId);
  if (mediaKind === "image") {
    const img = document.createElement("img");
    img.src = url;
    img.loading = "lazy";
    img.title = "Ver en tamaño completo";
    img.addEventListener("click", () => window.open(url, "_blank", "noopener"));
    wrapper.appendChild(img);
  } else if (mediaKind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    wrapper.appendChild(video);
  } else if (mediaKind === "audio") {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    wrapper.appendChild(audio);
  } else if (mediaKind === "document") {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "chat-doc-link";
    link.textContent = "📄 Ver PDF";
    wrapper.appendChild(link);
  }
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
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
  tab.addEventListener("click", () => switchThread(peerId));

  const label = document.createElement("span");
  label.className = "chat-tab-label";
  label.textContent = name;
  tab.appendChild(label);

  // Cerrar solo saca la pestaña de la vista: el historial de esta
  // conversacion (dmThreads) no se borra, asi que si llega un mensaje
  // nuevo o la volves a abrir desde la lista de miembros, sigue completa.
  const closeBtn = document.createElement("span");
  closeBtn.className = "chat-tab-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Cerrar esta conversación";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeDmTab(peerId);
  });
  tab.appendChild(closeBtn);

  els.chatTabs.appendChild(tab);
}

function closeDmTab(peerId) {
  els.chatTabs.querySelector(`[data-thread="${CSS.escape(peerId)}"]`)?.remove();
  if (activeThread === peerId) switchThread("general");
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
  els.emojiBtn.disabled = threadId === "mod-all";
  els.gifBtn.disabled = threadId === "mod-all";
  // Imagen/video/audio solo tienen sentido en un privado 1 a 1: en general
  // los verian (y podrian denunciarlos) todos, y en "Privados (todos)" el
  // moderador solo mira, no participa.
  const isDmThread = threadId !== "general" && threadId !== "mod-all";
  els.attachBtn.classList.toggle("hidden", !isDmThread);
  els.cameraCaptureBtn.classList.toggle("hidden", !isDmThread);
}

// Version de renderMessage que NO vuelve a guardar en generalMessages (ya
// esta ahi): se usa solo al re-dibujar la pestaña "general" desde el buffer.
function renderMessageBubbleOnly(entry) {
  const { name, text, filename, userId: authorId } = entry;
  const isOwn = authorId === userId;
  if (filename) {
    appendGifBubble(name, authorId, filename, isOwn);
    return;
  }
  appendMessageBubble(
    `${authorSpanHtml(name, authorId, isOwn)}<span class="chat-text">${escapeHtml(text)}</span>`,
    isOwn
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
  els.chooseCamBtn.disabled = !localStream.getVideoTracks()[0];
  const localTile = document.getElementById(`tile-${userId}`);
  if (localTile) {
    localTile.classList.toggle("cam-off-preview", !camOn);
    const tileBtn = localTile.querySelector(".video-tile-switch-cam-btn");
    if (tileBtn) tileBtn.disabled = els.switchCamBtn.disabled;
  }
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
      err.code === "name-taken"
        ? "Ese nombre ya lo está usando alguien en la sala. Elige otro."
        : "No se pudo conectar al servidor de la sala. Intenta de nuevo.";
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
    // Solo le llega algo a esto si yo soy moderador: o bien la camara real
    // de alguien que esta compartiendo pantalla (ver sendCameraToModerators
    // en webrtc.js), o bien el audio/video de una llamada privada ajena que
    // estoy supervisando (ver sendCallTrackToModerators).
    onModeratorExtraStream: (peerId, stream, track) => {
      const info = knownMembers.get(peerId);
      if (track.kind === "audio") {
        // Solo hace falta reproducirlo, no un recuadro de video, para poder
        // supervisar el audio de una llamada privada ajena.
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.hidden = true;
        audio.srcObject = stream;
        document.body.appendChild(audio);
        track.addEventListener("ended", () => audio.remove());
        return;
      }
      const video = createVideoTile(`${peerId}-modcam`, `${info?.name || "Usuario"} (cámara real)`);
      video.srcObject = stream;
      video._connectVolumeControl?.();
      track.addEventListener("ended", () => removeVideoTile(`${peerId}-modcam`));
    },
    onCallTrack: handleCallTrack,
    onCallEnded: handleCallEnded,
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

  addRoomListener("gif", (msg) => {
    renderMessage(msg);
    if (msg.userId !== userId) notify(msg.name, "Envió un GIF", "nexus-chat");
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
  function handleIncomingDm(msg) {
    const notifyText = msg.filename
      ? "Te mandó un GIF"
      : msg.mediaKind
      ? {
          image: "Te mandó una imagen",
          video: "Te mandó un video",
          audio: "Te mandó un audio",
          document: "Te mandó un PDF",
        }[msg.mediaKind]
      : msg.text;
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
        if (msg.from !== userId) notify(`${msg.fromName} (privado)`, notifyText, "nexus-dm-" + otherId);
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
  }

  addRoomListener("dm", handleIncomingDm);
  addRoomListener("gif-dm", handleIncomingDm);
  addRoomListener("dm-media", handleIncomingDm);

  // Llamada privada 1 a 1: ver startOutgoingCall/resetCallState mas abajo.
  addRoomListener("call-invite", (msg) => {
    if (callState !== "idle") {
      // ya ocupado (llamando, sonando o en otra llamada): se rechaza sola,
      // sin interrumpir con un cartel.
      sendCallReject(msg.from);
      return;
    }
    callPeerId = msg.from;
    callPeerName = msg.fromName;
    callState = "ringing";
    els.callIncomingName.textContent = callPeerName;
    els.callIncomingOverlay.classList.remove("hidden");
    playDmSound();
  });

  addRoomListener("call-cancel", (msg) => {
    if (callState === "ringing" && msg.from === callPeerId) resetCallState();
  });

  addRoomListener("call-reject", (msg) => {
    if (callState === "calling" && msg.from === callPeerId) resetCallState();
  });

  addRoomListener("call-accept", async (msg) => {
    if (callState !== "calling" || msg.from !== callPeerId) return;
    if (callRingTimeout) {
      clearTimeout(callRingTimeout);
      callRingTimeout = null;
    }
    els.callOutgoingOverlay.classList.add("hidden");
    try {
      callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      sendCallHangup(callPeerId);
      resetCallState();
      alert("No se pudo acceder al micrófono para iniciar la llamada.");
      return;
    }
    callState = "active";
    webrtcManager.startCallOffer(callPeerId, callLocalStream);
    webrtcManager.sendCallTrackToModerators("audio", callLocalStream.getAudioTracks()[0]);
    showCallPanel();
  });

  addRoomListener("call-hangup", (msg) => {
    if (callState !== "idle" && msg.from === callPeerId) resetCallState();
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
  resetCallState();
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
  els.emojiBtn.disabled = false;
  els.emojiPicker.classList.add("hidden");
  els.emojiBtn.classList.remove("active");
  els.gifBtn.disabled = false;
  els.gifPicker.classList.add("hidden");
  els.gifBtn.classList.remove("active");
  els.chatPanel.classList.remove("chat-expanded");
  els.expandChatBtn.classList.remove("active");
  els.expandChatBtn.title = "Agrandar el chat";
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
  // audio suena, aunque el resto de la app funcione bien. Todo esto es una
  // mejora de audio, nunca debe poder impedir entrar a la sala si algo
  // sale mal (por eso va en su propio try/catch, separado de joinRoom).
  try {
    getSharedAudioContext();
    // Mismo motivo: se "activan" los reproductores del sonido de mensaje
    // privado con un play/pause silencioso dentro de este mismo clic.
    dmSoundPool = Array.from({ length: DM_SOUND_POOL_SIZE }, () => {
      const player = new Audio("sounds/mp.mp3");
      player.volume = 0.6;
      player.play().then(() => player.pause()).catch(() => {});
      return player;
    });
  } catch (err) {
    console.warn("No se pudo preparar el audio de avisos:", err);
  }
  try {
    await joinRoom();
  } catch (err) {
    console.error("No se pudo entrar a la sala:", err);
    els.joinError.textContent = "Algo falló al entrar a la sala. Probá recargar la página e intentar de nuevo.";
  }
});

// Un solo listener delegado para todos los nombres clickeables del chat
// general (ver authorSpanHtml): mas simple que agregar un listener por cada
// burbuja de mensaje, y sigue funcionando con los mensajes que se agregan
// despues.
els.chatMessages.addEventListener("click", (e) => {
  const authorEl = e.target.closest(".clickable-author");
  if (!authorEl) return;
  const peerId = authorEl.dataset.userId;
  if (!peerId || peerId === userId) return;
  openDmWith(peerId, knownMembers.get(peerId)?.name || authorEl.textContent);
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

// Sube el archivo y manda el mensaje que lo referencia al hilo privado que
// este abierto en ese momento. Compartida por las tres formas de mandar
// multimedia (adjuntar, camara en vivo, nota de voz).
async function sendMediaToActiveThread(kind, blob) {
  if (activeThread === "general" || activeThread === "mod-all") return;
  const targetId = activeThread;
  try {
    const { fileId } = await uploadMedia(kind, blob);
    sendDmMedia(targetId, kind, fileId);
  } catch (err) {
    console.error("[NEXUS-DEBUG] error al mandar adjunto:", err);
    alert(err.message || "No se pudo mandar el archivo.");
  }
}

// --- Adjuntar imagen/video/PDF/mp3 desde el dispositivo ---

function detectAttachmentKind(file) {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf") return "document";
  if (file.type.startsWith("audio/")) return "audio";
  return null;
}

els.attachBtn.addEventListener("click", () => {
  if (activeThread === "general" || activeThread === "mod-all") return;
  els.attachFileInput.click();
});

els.attachFileInput.addEventListener("change", async () => {
  const file = els.attachFileInput.files[0];
  els.attachFileInput.value = ""; // permite elegir el mismo archivo dos veces seguidas
  if (!file) return;
  const kind = detectAttachmentKind(file);
  if (!kind) {
    alert("Solo se pueden mandar imágenes, videos, PDF o mp3.");
    return;
  }
  if (file.size > MEDIA_LIMITS_CLIENT[kind]) {
    const maxMb = Math.round(MEDIA_LIMITS_CLIENT[kind] / (1024 * 1024));
    alert(`Ese archivo pesa demasiado (máximo ${maxMb} MB).`);
    return;
  }
  await sendMediaToActiveThread(kind, file);
});

// --- Llamada privada 1 a 1 ---
// Arranca solo con microfono (nunca con la camara prendida sola); quien
// esta en la llamada puede prender su camara despues si quiere, desde el
// panel de la llamada activa. El moderador recibe una copia del audio (y
// del video, si se prende) para poder supervisar, igual que ya pasa con el
// microfono/camara de la sala general.

function stopCallLocalStream() {
  if (callLocalStream) {
    callLocalStream.getTracks().forEach((t) => t.stop());
    callLocalStream = null;
  }
}

function resetCallState() {
  // Primero se oculta TODA la interfaz de la llamada, sin condiciones: los
  // avisos de "llamando"/"te esta llamando" tapan la pantalla entera
  // (inset:0), asi que si algo de la limpieza de mas abajo llegara a
  // tirar un error, nunca deben quedar visibles bloqueando todos los
  // toques (eso era lo que dejaba la pagina "pegada" despues de colgar).
  els.callOutgoingOverlay.classList.add("hidden");
  els.callIncomingOverlay.classList.add("hidden");
  els.callPanel.classList.add("hidden");
  els.callPanel.classList.remove("has-remote-video");
  els.callRemoteVideo.srcObject = null;
  els.callLocalVideo.srcObject = null;
  els.callLocalVideo.classList.add("hidden");
  resetCallVideoRoles();
  resetCallPanelPosition();

  if (callRingTimeout) {
    clearTimeout(callRingTimeout);
    callRingTimeout = null;
  }
  try {
    if (callPeerId) {
      webrtcManager?.endCall(callPeerId);
      webrtcManager?.stopCallTrackToModerators("audio");
      webrtcManager?.stopCallTrackToModerators("video");
    }
  } catch (err) {
    console.warn("[NEXUS-CALL] error limpiando la conexion de la llamada:", err);
  }
  try {
    stopCallLocalStream();
  } catch (err) {
    console.warn("[NEXUS-CALL] error deteniendo el microfono de la llamada:", err);
  }
  callState = "idle";
  callPeerId = null;
  callPeerName = "";
  callVideoOn = false;
  callRemoteTracks.clear();
  if (callGainNode) {
    try {
      callGainNode.disconnect();
    } catch (err) {
      // no pasa nada, ya se esta descartando de todas formas
    }
    callGainNode = null;
  }
}

// El video remoto arranca siempre como el grande y el propio como el chico
// (recuadro), tal como al empezar cualquier llamada nueva.
function resetCallVideoRoles() {
  els.callRemoteVideo.classList.add("call-video-main");
  els.callRemoteVideo.classList.remove("call-video-pip");
  els.callLocalVideo.classList.add("call-video-pip");
  els.callLocalVideo.classList.remove("call-video-main");
}

function showCallPanel() {
  els.callPanelName.textContent = callPeerName;
  els.callPanel.classList.remove("hidden");
  els.callPanel.classList.remove("has-remote-video");
  resetCallVideoRoles();
  els.callMuteBtn.textContent = "🎤";
  els.callMuteBtn.classList.remove("muted");
  els.callCameraBtn.textContent = "📷";
  els.callCameraBtn.classList.remove("active");
}

function startOutgoingCall() {
  if (activeThread === "general" || activeThread === "mod-all") return;
  if (callState !== "idle") return; // ya en otra llamada o esperando respuesta
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Este navegador no permite hacer llamadas acá.");
    return;
  }
  callPeerId = activeThread;
  callPeerName = knownMembers.get(callPeerId)?.name || "Usuario";
  callState = "calling";
  els.callOutgoingName.textContent = callPeerName;
  els.callOutgoingOverlay.classList.remove("hidden");
  sendCallInvite(callPeerId);
  // Se cancela sola si del otro lado no contestan (no dejar "colgado" para
  // siempre esperando).
  callRingTimeout = setTimeout(() => {
    if (callState === "calling") cancelOutgoingCall();
  }, 30000);
}

function cancelOutgoingCall() {
  if (callState !== "calling") return;
  sendCallCancel(callPeerId);
  resetCallState();
}

function rejectIncomingCall() {
  if (callState !== "ringing") return;
  sendCallReject(callPeerId);
  resetCallState();
}

async function acceptIncomingCall() {
  if (callState !== "ringing") return;
  const peerId = callPeerId;
  els.callIncomingOverlay.classList.add("hidden");
  try {
    callLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    sendCallReject(peerId);
    resetCallState();
    alert("No se pudo acceder al micrófono para atender la llamada.");
    return;
  }
  // Se prepara la conexion (con el microfono ya en mano) ANTES de avisar
  // que se acepta: asi, cuando la oferta de quien llama llegue, este lado
  // ya esta listo para responderla en el momento, sin carreras de tiempo.
  webrtcManager.prepareCallReceiver(peerId, callLocalStream);
  sendCallAccept(peerId);
  callState = "active";
  webrtcManager.sendCallTrackToModerators("audio", callLocalStream.getAudioTracks()[0]);
  openDmWith(peerId, callPeerName);
  showCallPanel();
}

function hangupActiveCall() {
  if (callState !== "active") return;
  sendCallHangup(callPeerId);
  resetCallState();
}

function handleCallTrack(peerId, stream, track) {
  if (peerId !== callPeerId || callState !== "active") {
    console.warn(
      `[NEXUS-CALL-DEBUG] track de ${peerId} ignorado: callPeerId=${callPeerId}, callState=${callState}`
    );
    return;
  }
  console.log(`[NEXUS-CALL] track recibido de ${peerId}: ${track.kind}`);
  if (track.kind === "audio") {
    connectCallAudio(track);
    return;
  }
  // Video: se muestra en el <video>, que arranca mudo -- el audio real sale
  // por Web Audio (ver connectCallAudio), asi que el autoplay silenciado
  // del navegador no tiene restricciones. El intento explicito de play()
  // es solo un empujon extra por si algun navegador no arranca solo con el
  // atributo autoplay; se ignora en silencio si falla, sin mostrar nada
  // (la renegociacion agregada en setCallVideoTrack ya evita que haga
  // falta un boton manual).
  callRemoteTracks.add(track);
  els.callRemoteVideo.srcObject = new MediaStream([...callRemoteTracks]);
  els.callRemoteVideo.play().catch(() => {});
  track.addEventListener("unmute", () => els.callPanel.classList.add("has-remote-video"));
  track.addEventListener("mute", () => els.callPanel.classList.remove("has-remote-video"));
}

// Mismo truco que ya usa el resto de la app para el audio de la sala (ver
// _connectVolumeControl en createVideoTile): el audio real de la llamada
// sale por Web Audio API, con el mismo AudioContext ya "desbloqueado" al
// entrar a la sala (ver getSharedAudioContext), en vez de depender de que
// el navegador deje reproducir audio con sonido en un <video> -- eso era
// justo lo que fallaba de un lado si o si: los navegadores son mucho mas
// estrictos bloqueando autoplay CON sonido que autoplay silenciado.
let callGainNode = null;
function connectCallAudio(track) {
  if (callGainNode) return; // ya conectado
  const ctx = getSharedAudioContext();
  console.log(`[NEXUS-CALL] AudioContext estado=${ctx.state}`);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  callGainNode = ctx.createGain();
  callGainNode.gain.value = Number(els.callVolume.value);
  source.connect(callGainNode).connect(ctx.destination);
  console.log("[NEXUS-CALL] audio de la llamada conectado por Web Audio");
  track.addEventListener("unmute", () => console.log("[NEXUS-CALL] track de audio de la llamada YA trae datos reales (unmute)"));
  track.addEventListener("mute", () => console.log("[NEXUS-CALL] track de audio de la llamada DEJO de traer datos (mute)"));
  monitorCallAudioLevel(ctx, source);
}

// Mide el volumen real del audio recibido (no solo si llegan paquetes: si
// esos paquetes tienen sonido de verdad o son silencio). Se loguea cada
// segundo durante 10 segundos y se corta sola.
function monitorCallAudioLevel(ctx, source) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let ticks = 0;
  const interval = setInterval(() => {
    if (callState !== "active") {
      clearInterval(interval);
      return;
    }
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const max = Math.max(...data);
    console.log(`[NEXUS-CALL-NIVEL] volumen recibido: promedio=${avg.toFixed(1)} pico=${max}`);
    ticks++;
    if (ticks >= 10) clearInterval(interval);
  }, 1000);
}

function handleCallEnded(peerId) {
  if (peerId !== callPeerId) return;
  resetCallState();
}

els.cameraCaptureBtn.addEventListener("click", startOutgoingCall);
els.callCancelBtn.addEventListener("click", cancelOutgoingCall);
els.callRejectBtn.addEventListener("click", rejectIncomingCall);
els.callAcceptBtn.addEventListener("click", acceptIncomingCall);
els.callHangupBtn.addEventListener("click", hangupActiveCall);

// Silenciar en la llamada apaga el track de verdad (no un clon), asi que
// tambien deja de sonar para el otro lado. La copia que recibe el
// moderador (ver sendCallTrackToModerators) es un CLON tomado al empezar
// la llamada, que no se apaga junto con este: es intencional, para
// sostener la misma transparencia que ya existe con el microfono de la
// sala general (el mod sigue escuchando aunque el usuario se silencie).
els.callMuteBtn.addEventListener("click", () => {
  if (callState !== "active" || !callLocalStream) return;
  const track = callLocalStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.callMuteBtn.classList.toggle("muted", !track.enabled);
  els.callMuteBtn.textContent = track.enabled ? "🎤" : "🔇";
});

// Volumen de lo que se escucha de la llamada (no del propio microfono):
// controla directo el GainNode de Web Audio (ver connectCallAudio). Si
// todavia no hay audio conectado, el valor queda guardado en el propio
// control y se aplica apenas se conecte.
els.callVolume.addEventListener("input", () => {
  if (callGainNode) callGainNode.gain.value = Number(els.callVolume.value);
});

els.callCameraBtn.addEventListener("click", async () => {
  if (callState !== "active") return;
  if (callVideoOn) {
    webrtcManager.setCallVideoTrack(callPeerId, null);
    webrtcManager.stopCallTrackToModerators("video");
    callLocalStream.getVideoTracks().forEach((t) => {
      callLocalStream.removeTrack(t);
      t.stop();
    });
    els.callLocalVideo.classList.add("hidden");
    els.callLocalVideo.srcObject = null;
    callVideoOn = false;
    els.callCameraBtn.classList.remove("active");
    return;
  }
  try {
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const camTrack = camStream.getVideoTracks()[0];
    callLocalStream.addTrack(camTrack);
    webrtcManager.setCallVideoTrack(callPeerId, camTrack);
    webrtcManager.sendCallTrackToModerators("video", camTrack);
    els.callLocalVideo.srcObject = new MediaStream([camTrack]);
    els.callLocalVideo.classList.remove("hidden");
    callVideoOn = true;
    els.callCameraBtn.classList.add("active");
  } catch (err) {
    alert("No se pudo activar la cámara.");
  }
});

// "Agrandar" el panel de la llamada NO pide pantalla completa de verdad al
// sistema operativo (Element.requestFullscreen): en iOS viejo (iPhone 7
// entre otros) eso solo funciona sobre un <video> con contenido real, asi
// que si nadie prendio la camara no hay nada para agrandar y el boton no
// hacia nada. En cambio, se agranda el panel DENTRO de la misma pagina con
// una clase (mismo truco que ya usa "agrandar el chat"), que funciona
// igual en cualquier dispositivo sin depender de esa API.
function isCallPanelMaximized() {
  return els.callPanel.classList.contains("call-panel-maximized");
}

els.callFullscreenBtn.addEventListener("click", () => {
  els.callPanel.classList.toggle("call-panel-maximized");
});

// El panel se puede arrastrar agarrando el encabezado, para despejar
// cualquier parte de la pantalla que tape (por ejemplo el chat). No tiene
// sentido arrastrarlo mientras esta en pantalla completa.
(function makeCallPanelDraggable() {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  els.callPanelHeader.addEventListener("pointerdown", (e) => {
    if (isCallPanelMaximized()) return;
    dragging = true;
    const rect = els.callPanel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    els.callPanelHeader.setPointerCapture(e.pointerId);
  });

  els.callPanelHeader.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const maxX = window.innerWidth - els.callPanel.offsetWidth;
    const maxY = window.innerHeight - els.callPanel.offsetHeight;
    const x = Math.min(Math.max(0, e.clientX - offsetX), Math.max(0, maxX));
    const y = Math.min(Math.max(0, e.clientY - offsetY), Math.max(0, maxY));
    els.callPanel.style.left = `${x}px`;
    els.callPanel.style.top = `${y}px`;
    els.callPanel.style.right = "auto";
  });

  els.callPanelHeader.addEventListener("pointerup", (e) => {
    dragging = false;
    els.callPanelHeader.releasePointerCapture(e.pointerId);
  });
})();

// Vuelve el panel a su posicion de siempre (arriba a la derecha) al
// terminar cada llamada, para que la proxima arranque en un lugar
// predecible en vez de quedar donde lo hayan arrastrado la vez anterior.
function resetCallPanelPosition() {
  els.callPanel.style.left = "";
  els.callPanel.style.top = "";
  els.callPanel.style.right = "";
  els.callPanel.classList.remove("call-panel-maximized");
}

// Tocar el recuadro chico (la propia camara, en la esquina) lo intercambia
// con el grande: no se tocan las stream de cada <video>, solo se les da
// vuelta la clase que define cual es el principal y cual el recuadro chico.
els.callPanelMedia.addEventListener("click", (e) => {
  if (e.target.closest("#call-fullscreen-btn")) return;
  if (!e.target.closest(".call-video-pip")) return;
  for (const video of [els.callRemoteVideo, els.callLocalVideo]) {
    video.classList.toggle("call-video-main");
    video.classList.toggle("call-video-pip");
  }
});
// La pestaña "General" ya existe en el HTML desde el arranque (las demas
// se crean solas al abrir un privado, ver ensureDmTab/ensureModAllTab).
els.chatTabs.querySelector('[data-thread="general"]').addEventListener("click", () => switchThread("general"));

// Selector de emojis: no es la base completa de Unicode (son miles, con
// variantes de tono de piel y genero, y no hay forma practica de traerla
// entera sin una libreria externa), pero cubre una lista amplia organizada
// por categoria, pensada para alcanzar todo lo que se usa en la practica.
const EMOJI_CATEGORIES = [
  {
    icon: "😀",
    title: "Caras y emociones",
    emojis: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡".split(" "),
  },
  {
    icon: "👋",
    title: "Gestos y personas",
    emojis: "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦿 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦 💋 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷".split(" "),
  },
  {
    icon: "🐶",
    title: "Animales y naturaleza",
    emojis: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🪳 🦟 🦗 🕷️ 🕸️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🦣 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐓 🦃 🦤 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿️ 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🌺 🌸 🌼 🌻 🌞 🌙 🌎 🌍 🌏 💫 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌊".split(" "),
  },
  {
    icon: "🍕",
    title: "Comida y bebida",
    emojis: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾".split(" "),
  },
  {
    icon: "⚽",
    title: "Actividades",
    emojis: "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🪘 🎷 🎺 🎸 🪕 🎻 🎮 🕹️ 🎰 🎲 🧩 ♟️ 🎯 🎳 🎮 🧸".split(" "),
  },
  {
    icon: "✈️",
    title: "Viajes y lugares",
    emojis: "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🛺 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🚏 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋".split(" "),
  },
  {
    icon: "💡",
    title: "Objetos",
    emojis: "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ 🧭 ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🪫 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 🧾 💎 ⚖️ 🪜 🧰 🪛 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪚 🔩 ⚙️ 🪤 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚿 🛁 🪒 🧴 🧷 🧵 🧶 🪡 👓 🕶️ 🥽 🥼 🦺 👔 👕 👖 🧣 🧤 🧥 🧦 👗 👘 🥻 🩱 🩲 🩳 👙 👚 👛 👜 👝 🎒 👞 👟 🥾 👠 👡 🩰 👢 👑 👒 🎩 🎓 🧢 ⛑️ 💄 💍 💼".split(" "),
  },
  {
    icon: "❤️",
    title: "Símbolos y corazones",
    emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ⏏️ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 👁️‍🗨️ 🔚 🔙 🔛 🔝 🔜 〰️ ➰ ➿ ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ ⬛ ⬜ 🟥 🟧 🟨 🟩 🟦 🟪 🟫".split(" "),
  },
];

function renderEmojiCategory(index) {
  const category = EMOJI_CATEGORIES[index];
  els.emojiGrid.innerHTML = "";
  for (const emoji of category.emojis) {
    if (!emoji) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      const start = els.chatInput.selectionStart ?? els.chatInput.value.length;
      const end = els.chatInput.selectionEnd ?? els.chatInput.value.length;
      const value = els.chatInput.value;
      els.chatInput.value = value.slice(0, start) + emoji + value.slice(end);
      const cursor = start + emoji.length;
      els.chatInput.focus();
      els.chatInput.setSelectionRange(cursor, cursor);
    });
    els.emojiGrid.appendChild(btn);
  }
  for (const tab of els.emojiTabs.children) {
    tab.classList.toggle("active", Number(tab.dataset.index) === index);
  }
}

EMOJI_CATEGORIES.forEach((category, index) => {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.textContent = category.icon;
  tab.title = category.title;
  tab.dataset.index = String(index);
  tab.addEventListener("click", () => renderEmojiCategory(index));
  els.emojiTabs.appendChild(tab);
});
renderEmojiCategory(0);

els.emojiBtn.addEventListener("click", () => {
  els.emojiPicker.classList.toggle("hidden");
  els.emojiBtn.classList.toggle("active");
});

// Cierra el selector al tocar afuera, sin interferir con el propio boton
// (que ya se encarga de abrir/cerrar) ni con los clics dentro del panel.
document.addEventListener("click", (e) => {
  if (els.emojiPicker.classList.contains("hidden")) return;
  if (els.emojiPicker.contains(e.target) || e.target === els.emojiBtn) return;
  els.emojiPicker.classList.add("hidden");
  els.emojiBtn.classList.remove("active");
});

// Selector de GIFs. Los archivos viven en la carpeta gifs/ del proyecto
// (se suben al repositorio igual que el resto del frontend); como es un
// sitio estatico sin servidor propio, no hay forma de listar esa carpeta
// sola -- cada vez que se agregue un gif nuevo hay que sumar su nombre
// aca a mano.
const GIF_FILES = [
  "Cruz Azul Cheer GIF by Club America.gif",
  "Dragon Ball Super Broly GIF.gif",
  "Marijuana Pounds GIF by Exclusive Michigan.gif",
  "weed GIF.gif",
];

// El limite real (3 cada 5 min) lo aplica el servidor; esto es solo un
// espejo del lado del cliente para avisar antes de mandar de mas, en vez
// de que el mensaje se pierda en silencio sin ninguna explicacion.
const GIF_RATE_LIMIT_MAX = 3;
const GIF_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
let myGifSendTimes = [];

if (GIF_FILES.length === 0) {
  els.gifPicker.innerHTML = '<p class="empty-hint">Todavía no hay GIFs cargados.</p>';
} else {
  for (const filename of GIF_FILES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = filename.replace(/\.gif$/i, "");
    const img = document.createElement("img");
    img.src = `gifs/${encodeURIComponent(filename)}`;
    img.alt = filename;
    img.loading = "lazy";
    btn.appendChild(img);
    btn.addEventListener("click", () => {
      const now = Date.now();
      myGifSendTimes = myGifSendTimes.filter((t) => now - t < GIF_RATE_LIMIT_WINDOW_MS);
      if (myGifSendTimes.length >= GIF_RATE_LIMIT_MAX) {
        const waitMs = GIF_RATE_LIMIT_WINDOW_MS - (now - myGifSendTimes[0]);
        const waitMin = Math.ceil(waitMs / 60000);
        alert(`Ya mandaste ${GIF_RATE_LIMIT_MAX} GIFs. Esperá ${waitMin} minuto${waitMin === 1 ? "" : "s"} para mandar otro.`);
        return;
      }
      myGifSendTimes.push(now);
      if (activeThread === "general") {
        sendGif(filename);
      } else if (activeThread !== "mod-all") {
        sendGifDm(activeThread, filename);
      }
      els.gifPicker.classList.add("hidden");
      els.gifBtn.classList.remove("active");
    });
    els.gifPicker.appendChild(btn);
  }
}

els.gifBtn.addEventListener("click", () => {
  els.gifPicker.classList.toggle("hidden");
  els.gifBtn.classList.toggle("active");
});

document.addEventListener("click", (e) => {
  if (els.gifPicker.classList.contains("hidden")) return;
  if (els.gifPicker.contains(e.target) || e.target === els.gifBtn) return;
  els.gifPicker.classList.add("hidden");
  els.gifBtn.classList.remove("active");
});

els.leaveBtn.addEventListener("click", cleanupAndReturnToJoinScreen);

// En PC agranda la columna del chat (a costa de la grilla de video, que se
// achica sola); en celular (donde todo esta apilado a lo ancho) agranda el
// alto del panel en su lugar. La misma clase sirve para los dos casos,
// cada breakpoint la interpreta distinto (ver style.css).
els.expandChatBtn.addEventListener("click", () => {
  const expanded = els.chatPanel.classList.toggle("chat-expanded");
  els.expandChatBtn.classList.toggle("active", expanded);
  els.expandChatBtn.title = expanded ? "Achicar el chat" : "Agrandar el chat";
});

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

// Parte comun a "girar camara" (cicla a cualquier otra) y "elegir camara"
// (un dispositivo puntual): reemplaza el track de video que se manda a
// todos los pares y actualiza la propia vista previa. fallbackFacing solo
// se usa si el navegador no informa el facingMode real del track nuevo.
function applyNewVideoTrack(newTrack, fallbackFacing) {
  const oldTrack = localStream.getVideoTracks()[0];
  if (oldTrack) {
    localStream.removeTrack(oldTrack);
    oldTrack.stop();
  }
  localStream.addTrack(newTrack);
  const localVideoEl = document.querySelector(`#tile-${userId} video`);
  if (localVideoEl) localVideoEl.srcObject = localStream;
  webrtcManager.replaceLocalVideoTrack(newTrack);
  const reportedFacing = newTrack.getSettings().facingMode;
  if (reportedFacing || fallbackFacing) facingMode = reportedFacing || fallbackFacing;
  document.getElementById(`tile-${userId}`)?.classList.toggle("mirrored", facingMode === "user");
}

// Usada tanto por el boton de la barra de controles como por el boton
// equivalente puesto directo sobre la propia vista previa (ver
// createVideoTile), asi los dos disparan exactamente el mismo cambio.
async function switchCamera() {
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
  applyNewVideoTrack(newStream.getVideoTracks()[0], newFacing);
}

els.switchCamBtn.addEventListener("click", switchCamera);

// Complementa a "girar camara": deja elegir un dispositivo puntual por
// nombre, en vez de que el ciclado adivine cual es la camara real. Hace
// falta sobre todo en PC con camaras virtuales instaladas (por ejemplo
// Iriun Webcam), donde ciclar puede caer en una que no esta transmitiendo.
async function switchToCameraDevice(deviceId) {
  const oldTrack = localStream.getVideoTracks()[0];
  if (!oldTrack || oldTrack.getSettings().deviceId === deviceId) return;
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
  } catch (err) {
    console.error("[NEXUS-DEBUG] error al elegir camara:", err.name, err.message);
    alert("No se pudo usar esa cámara.");
    return;
  }
  applyNewVideoTrack(newStream.getVideoTracks()[0]);
}

async function renderCameraPicker() {
  els.cameraPicker.innerHTML = '<p class="empty-hint">Buscando cámaras...</p>';
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    els.cameraPicker.innerHTML = '<p class="empty-hint">No se pudieron listar las cámaras.</p>';
    return;
  }
  const cameras = devices.filter((d) => d.kind === "videoinput");
  els.cameraPicker.innerHTML = "";
  if (cameras.length === 0) {
    els.cameraPicker.innerHTML = '<p class="empty-hint">No se encontraron cámaras.</p>';
    return;
  }
  const currentId = localStream.getVideoTracks()[0]?.getSettings().deviceId;
  cameras.forEach((cam, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "camera-picker-option" + (cam.deviceId === currentId ? " active" : "");
    btn.textContent = cam.label || `Cámara ${index + 1}`;
    btn.addEventListener("click", async () => {
      await switchToCameraDevice(cam.deviceId);
      els.cameraPicker.classList.add("hidden");
      els.chooseCamBtn.classList.remove("active");
    });
    els.cameraPicker.appendChild(btn);
  });
}

els.chooseCamBtn.addEventListener("click", () => {
  const opening = els.cameraPicker.classList.contains("hidden");
  els.cameraPicker.classList.toggle("hidden");
  els.chooseCamBtn.classList.toggle("active");
  if (opening) renderCameraPicker();
});

document.addEventListener("click", (e) => {
  if (els.cameraPicker.classList.contains("hidden")) return;
  if (els.cameraPicker.contains(e.target) || e.target === els.chooseCamBtn) return;
  els.cameraPicker.classList.add("hidden");
  els.chooseCamBtn.classList.remove("active");
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
