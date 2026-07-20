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
let localStream = null;
let webrtcManager = null;
let heartbeatTimer = null;
let sweepTimer = null;
let unsubscribePresence = null;
let unsubscribeMessages = null;
const knownMembers = new Map(); // peerId -> { name, lastSeen (ms) }

function toMillis(timestamp) {
  if (timestamp && typeof timestamp.toMillis === "function") return timestamp.toMillis();
  return Date.now();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
  label.textContent = isSelf ? `${name} (tú)` : name;

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
  els.memberCount.textContent = knownMembers.size;
  for (const [id, info] of knownMembers) {
    const li = document.createElement("li");
    li.className = "member-item";
    li.innerHTML = `<span class="status-dot"></span>${escapeHtml(info.name)}${
      id === userId ? " <em>(tú)</em>" : ""
    }`;
    els.memberList.appendChild(li);
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

async function getLocalMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.warn("No se pudo acceder a cámara/micrófono:", err);
    return null;
  }
}

async function joinRoom() {
  const presenceRef = doc(db, "rooms", ROOM_ID, "presence", userId);
  await setDoc(presenceRef, {
    name: username,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
  });

  heartbeatTimer = setInterval(() => {
    updateDoc(presenceRef, { lastSeen: serverTimestamp() }).catch(() => {});
  }, HEARTBEAT_MS);

  localStream = await getLocalMedia();
  if (localStream) {
    const video = createVideoTile(userId, username, { isLocal: true, isSelf: true });
    video.srcObject = localStream;
  } else {
    createVideoTile(userId, username, { isLocal: true, isSelf: true });
    els.toggleMicBtn.disabled = true;
    els.toggleCamBtn.disabled = true;
  }

  webrtcManager = createWebRTCManager({
    roomId: ROOM_ID,
    userId,
    localStream,
    onRemoteStream: (peerId, stream) => {
      const name = knownMembers.get(peerId)?.name || "Usuario";
      const video = createVideoTile(peerId, name);
      video.srcObject = stream;
    },
    onRemoveStream: (peerId) => removeVideoTile(peerId),
  });

  const presenceCol = collection(db, "rooms", ROOM_ID, "presence");
  unsubscribePresence = onSnapshot(presenceCol, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const peerId = change.doc.id;
      const data = change.doc.data();
      if (change.type === "added" || change.type === "modified") {
        const lastSeen = toMillis(data.lastSeen);
        const isFresh = Date.now() - lastSeen < STALE_MS;
        knownMembers.set(peerId, { name: data.name, lastSeen });
        if (change.type === "added" && isFresh) {
          webrtcManager.handlePeerJoined(peerId);
        }
      } else if (change.type === "removed") {
        knownMembers.delete(peerId);
        webrtcManager.handlePeerLeft(peerId);
        removeVideoTile(peerId);
      }
    }
    renderMemberList();
  });

  sweepTimer = setInterval(sweepStaleMembers, SWEEP_INTERVAL_MS);

  const messagesCol = collection(db, "rooms", ROOM_ID, "messages");
  const messagesQuery = query(messagesCol, orderBy("createdAt", "asc"), limit(200));
  unsubscribeMessages = onSnapshot(messagesQuery, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") renderMessage(change.doc.data());
    }
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
  if (webrtcManager) webrtcManager.destroy();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  els.videoGrid.innerHTML = "";
  els.chatMessages.innerHTML = "";
  knownMembers.clear();
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

els.toggleMicBtn.addEventListener("click", () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  els.toggleMicBtn.classList.toggle("muted", !audioTrack.enabled);
  els.toggleMicBtn.textContent = audioTrack.enabled ? "🎤" : "🔇";
});

els.toggleCamBtn.addEventListener("click", () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  els.toggleCamBtn.classList.toggle("muted", !videoTrack.enabled);
  els.toggleCamBtn.textContent = videoTrack.enabled ? "📷" : "🚫";
});
