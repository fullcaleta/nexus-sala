import {
  db,
  collection,
  addDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "./db.js";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function createWebRTCManager({ roomId, userId, localStream, onRemoteStream, onRemoveStream }) {
  const peerConnections = new Map();
  const signalsCol = collection(db, "rooms", roomId, "signals");

  async function sendSignal(to, type, payload) {
    await addDoc(signalsCol, {
      from: userId,
      to,
      type,
      payload: JSON.stringify(payload),
      createdAt: serverTimestamp(),
    });
  }

  function getOrCreatePeerConnection(peerId) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.set(peerId, pc);

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, "candidate", event.candidate);
      }
    };

    pc.ontrack = (event) => {
      onRemoteStream(peerId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (["closed", "failed", "disconnected"].includes(pc.connectionState)) {
        closePeer(peerId);
      }
    };

    return pc;
  }

  function closePeer(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.delete(peerId);
    }
    onRemoveStream(peerId);
  }

  async function handlePeerJoined(peerId) {
    if (peerId === userId || peerConnections.has(peerId)) return;
    // Regla simple para evitar ofertas duplicadas: solo inicia el id "menor".
    if (userId < peerId) {
      const pc = getOrCreatePeerConnection(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(peerId, "offer", offer);
    }
  }

  function handlePeerLeft(peerId) {
    closePeer(peerId);
  }

  const signalsQuery = query(signalsCol, where("to", "==", userId));
  const unsubscribeSignals = onSnapshot(signalsQuery, (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== "added") continue;
      const data = change.doc.data();
      const payload = JSON.parse(data.payload);
      handleSignal(data.from, data.type, payload);
      deleteDoc(doc(db, "rooms", roomId, "signals", change.doc.id));
    }
  });

  async function handleSignal(from, type, payload) {
    if (type === "offer") {
      const pc = getOrCreatePeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(from, "answer", answer);
    } else if (type === "answer") {
      const pc = peerConnections.get(from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (type === "candidate") {
      const pc = peerConnections.get(from);
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(payload));
        } catch (err) {
          console.warn("No se pudo agregar ICE candidate", err);
        }
      }
    }
  }

  function destroy() {
    unsubscribeSignals();
    for (const peerId of [...peerConnections.keys()]) {
      closePeer(peerId);
    }
  }

  return { handlePeerJoined, handlePeerLeft, destroy };
}
