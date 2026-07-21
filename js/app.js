import {
  db,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "./db.js";
import { createWebRTCManager } from "./webrtc.js";

const ROOM_ID = "general";
const HEARTBEAT_MS = 20000;
const STALE_MS = 45000; // si no hay heartbeat en este tiempo, se considera desconectado
const SWEEP_INTERVAL_MS = 15000;
const MODERATOR_KEY = "nexus2026";
const isModerator = new URLSearchParams(window.location.search).get("mod") === MODERATOR_KEY;

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
let localStream = null; // MediaStream mutable: arranca vacio, se le suman tracks al activarlos
let webrtcManager = null;
let heartbeatTimer = null;
let sweepTimer = null;
let unsubscribePresence = null;
let unsubscribeMessages = null;
let unsubscribeKicked = null;
let micOn = false;
let camOn = false;
let facingMode = "user";
let notificationsEnabled = false;
let hasSeenInitialPresence = false;
let hasSeenInitialMessages = false;
const knownMembers = new Map(); // peerId -> { name, lastSeen (ms), hidden }

function toMillis(timestamp) {
  if (timestamp && typeof timestamp.toMillis === "function") return timestamp.toMillis();
  return Date.now();
}

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

function renderMemberList() {
  els.memberList.innerHTML = "";
  const now = Date.now();
  const visible = [...knownMembers.entries()].filter(
    ([id, info]) => (!info.hidden || id === userId) && (id === userId || now - info.lastSeen <= STALE_MS)
  );
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

async function kickMember(peerId, name) {
  if (!confirm(`¿Expulsar a ${name} de la sala?`)) return;
  try {
    await setDoc(doc(db, "rooms", ROOM_ID, "kicked", peerId), { at: serverTimestamp() });
    await deleteDoc(doc(db, "rooms", ROOM_ID, "presence", peerId));
  } catch (err) {
    console.warn("No se pudo expulsar al usuario:", err);
  }
}

function sweepStaleMembers() {
  const now = Date.now();
  let changed = false;
  for (const [peerId, info] of knownMembers) {
    if (peerId === userId) continue;
    if (now - info.lastSeen > STALE_MS) {
      knownMembers.delete(peerId);
      webrtcManager.handlePeerLeft(peerId);
      removeVideoTile(peerId);
      changed = true;
    }
  }
  if (changed) renderMemberList();
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
  els.switchCamBtn.disabled = !camOn;
  const localTile = document.getElementById(`tile-${userId}`);
  if (localTile) localTile.classList.toggle("cam-off-preview", !camOn);
}

async function joinRoom() {
  const kickedRef = doc(db, "rooms", ROOM_ID, "kicked", userId);

  const presenceRef = doc(db, "rooms", ROOM_ID, "presence", userId);
  await setDoc(presenceRef, {
    name: username,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
    hidden: isModerator,
  });

  const roomEnteredAt = Date.now();
  unsubscribeKicked = onSnapshot(kickedRef, (snap) => {
    if (snap.exists() && toMillis(snap.data().at) > roomEnteredAt) {
      alert("Fuiste expulsado de la sala por un moderador.");
      cleanupAndReturnToJoinScreen();
    }
  });

  heartbeatTimer = setInterval(() => {
    updateDoc(presenceRef, { lastSeen: serverTimestamp() }).catch(() => {});
  }, HEARTBEAT_MS);

  // Se entra a la sala solo con chat: sin pedir camara ni microfono todavia.
  localStream = new MediaStream();
  createVideoTile(userId, username, { isLocal: true, isSelf: true });
  updateMicButtonUI();
  updateCamButtonUI();

  webrtcManager = createWebRTCManager({
    roomId: ROOM_ID,
    userId,
    localStream,
    onRemoteStream: (peerId, stream) => {
      const info = knownMembers.get(peerId);
      if (info?.hidden) return; // el video del moderador invisible no se muestra a nadie
      const video = createVideoTile(peerId, info?.name || "Usuario");
      video.srcObject = stream;
    },
    onRemoveStream: (peerId) => removeVideoTile(peerId),
    isModeratorPeer: (peerId) => knownMembers.get(peerId)?.hidden === true,
  });

  const presenceCol = collection(db, "rooms", ROOM_ID, "presence");
  unsubscribePresence = onSnapshot(presenceCol, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const peerId = change.doc.id;
      const data = change.doc.data();
      if (change.type === "added" || change.type === "modified") {
        const lastSeen = toMillis(data.lastSeen);
        const isFresh = Date.now() - lastSeen < STALE_MS;
        knownMembers.set(peerId, { name: data.name, lastSeen, hidden: !!data.hidden });
        if (change.type === "added" && isFresh) {
          webrtcManager.handlePeerJoined(peerId);
          if (hasSeenInitialPresence && peerId !== userId && !data.hidden) {
            notify("Nexus", `${data.name} entró a la sala`, "nexus-presence");
          }
        }
      } else if (change.type === "removed") {
        knownMembers.delete(peerId);
        webrtcManager.handlePeerLeft(peerId);
        removeVideoTile(peerId);
      }
    }
    hasSeenInitialPresence = true;
    renderMemberList();
  });

  sweepTimer = setInterval(sweepStaleMembers, SWEEP_INTERVAL_MS);

  const messagesCol = collection(db, "rooms", ROOM_ID, "messages");
  const messagesQuery = query(messagesCol, orderBy("createdAt", "asc"), limit(200));
  unsubscribeMessages = onSnapshot(messagesQuery, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        const data = change.doc.data();
        renderMessage(data);
        if (hasSeenInitialMessages && data.userId !== userId) {
          notify(data.name, data.text, "nexus-chat");
        }
      }
    }
    hasSeenInitialMessages = true;
  });

  window.addEventListener("beforeunload", leaveRoom);
  window.addEventListener("pagehide", leaveRoom);
}

async function leaveRoom() {
  try {
    await deleteDoc(doc(db, "rooms", ROOM_ID, "presence", userId));
  } catch (err) {
    // best effort
  }
}

function cleanupAndReturnToJoinScreen() {
  clearInterval(heartbeatTimer);
  clearInterval(sweepTimer);
  if (unsubscribePresence) unsubscribePresence();
  if (unsubscribeMessages) unsubscribeMessages();
  if (unsubscribeKicked) unsubscribeKicked();
  if (webrtcManager) webrtcManager.destroy();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  els.videoGrid.innerHTML = "";
  els.chatMessages.innerHTML = "";
  knownMembers.clear();
  hasSeenInitialPresence = false;
  hasSeenInitialMessages = false;
  micOn = false;
  camOn = false;
  leaveRoom();
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
  els.joinScreen.classList.add("hidden");
  els.roomScreen.classList.remove("hidden");
  await joinRoom();
});

els.chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  await addDoc(collection(db, "rooms", ROOM_ID, "messages"), {
    name: username,
    userId,
    text: text.slice(0, 500),
    createdAt: serverTimestamp(),
  });
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
