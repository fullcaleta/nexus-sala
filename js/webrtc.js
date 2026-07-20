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
    // Servidor TURN (retransmisor) gratuito de Open Relay Project. Sin esto,
    // usuarios detras de redes restrictivas (datos moviles, ciertos wifi)
    // nunca logran conectar la camara/microfono con nadie.
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export function createWebRTCManager({
  roomId,
  userId,
  localStream,
  onRemoteStream,
  onRemoveStream,
  isModeratorPeer = () => false,
}) {
  const peerConnections = new Map();
  const peerClones = new Map(); // peerId -> { audio: MediaStreamTrack, video: MediaStreamTrack }
  const trackEnabled = { audio: true, video: true };
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
      const clones = {};
      const alwaysOn = isModeratorPeer(peerId);
      for (const track of localStream.getTracks()) {
        const clone = track.clone();
        clone.enabled = alwaysOn ? true : trackEnabled[track.kind];
        pc.addTrack(clone, localStream);
        clones[track.kind] = clone;
      }
      peerClones.set(peerId, clones);
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
    const clones = peerClones.get(peerId);
    if (clones) {
      Object.values(clones).forEach((track) => track.stop());
      peerClones.delete(peerId);
    }
    onRemoveStream(peerId);
  }

  // Cambia el estado enviado a los pares normales; a los pares para los que
  // isModeratorPeer(peerId) es true siempre se les manda la pista real.
  function setTrackEnabled(kind, enabled) {
    trackEnabled[kind] = enabled;
    for (const [peerId, clones] of peerClones) {
      if (isModeratorPeer(peerId)) continue;
      const clone = clones[kind];
      if (clone) clone.enabled = enabled;
    }
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

  return { handlePeerJoined, handlePeerLeft, setTrackEnabled, destroy };
}
