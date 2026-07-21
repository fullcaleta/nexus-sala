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

// Servidor TURN (retransmisor) propio en Metered.ca. Sin esto, usuarios detras
// de redes restrictivas (datos moviles, ciertos wifi/NAT) nunca logran conectar
// la camara/microfono con nadie, aunque el resto del grupo funcione bien.
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "5244766bbe80a7fa57ef222c",
      credential: "y4BYKptMPrOjNqcI",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "5244766bbe80a7fa57ef222c",
      credential: "y4BYKptMPrOjNqcI",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "5244766bbe80a7fa57ef222c",
      credential: "y4BYKptMPrOjNqcI",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "5244766bbe80a7fa57ef222c",
      credential: "y4BYKptMPrOjNqcI",
    },
  ],
};

// localStream es un MediaStream mutable que vive en app.js: puede empezar
// vacio (sala solo de texto) y ir sumando el track de audio y/o video cuando
// el usuario activa el microfono/camara mas tarde.
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
  const makingOffer = new Map(); // peerId -> bool
  const ignoreOffer = new Map(); // peerId -> bool
  const trackEnabled = { audio: true, video: true };
  const signalsCol = collection(db, "rooms", roomId, "signals");

  // Regla simple y simetrica para decidir quien cede en caso de que ambos
  // lados intenten renegociar al mismo tiempo ("glare").
  function isPolite(peerId) {
    return userId > peerId;
  }

  async function sendSignal(to, type, payload) {
    await addDoc(signalsCol, {
      from: userId,
      to,
      type,
      payload: JSON.stringify(payload),
      createdAt: serverTimestamp(),
    });
  }

  function addTrackClone(pc, peerId, track) {
    const alwaysOn = isModeratorPeer(peerId);
    const clone = track.clone();
    clone.enabled = alwaysOn ? true : trackEnabled[track.kind];
    pc.addTrack(clone, localStream);
    const clones = peerClones.get(peerId) || {};
    clones[track.kind] = clone;
    peerClones.set(peerId, clones);
    return clone;
  }

  function getOrCreatePeerConnection(peerId) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.set(peerId, pc);
    makingOffer.set(peerId, false);

    for (const track of localStream.getTracks()) {
      addTrackClone(pc, peerId, track);
    }

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer.set(peerId, true);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(peerId, "description", pc.localDescription);
      } catch (err) {
        console.warn("No se pudo negociar la conexion:", err);
      } finally {
        makingOffer.set(peerId, false);
      }
    };

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
    makingOffer.delete(peerId);
    ignoreOffer.delete(peerId);
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

  // Se llama cuando el usuario activa el microfono/camara por primera vez,
  // ya con la sala abierta: manda el track nuevo a todos los pares existentes
  // (dispara la renegociacion automaticamente via onnegotiationneeded).
  function addLocalTrack(track) {
    for (const [peerId, pc] of peerConnections) {
      addTrackClone(pc, peerId, track);
    }
  }

  // Reemplaza el track de video (por ejemplo al cambiar de camara) sin
  // renegociar: RTCRtpSender.replaceTrack no requiere una nueva oferta.
  function replaceLocalVideoTrack(newTrack) {
    for (const [peerId, clones] of peerClones) {
      const oldClone = clones.video;
      if (!oldClone) continue;
      const pc = peerConnections.get(peerId);
      const sender = pc?.getSenders().find((s) => s.track === oldClone);
      const alwaysOn = isModeratorPeer(peerId);
      const newClone = newTrack.clone();
      newClone.enabled = alwaysOn ? true : trackEnabled.video;
      if (sender) sender.replaceTrack(newClone);
      oldClone.stop();
      clones.video = newClone;
    }
  }

  function handlePeerJoined(peerId) {
    if (peerId === userId) return;
    // Se crea la conexion de los dos lados; si nadie tiene audio/video
    // activo todavia, queda inerte hasta que alguno active algo.
    getOrCreatePeerConnection(peerId);
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
    const pc = getOrCreatePeerConnection(from);
    if (type === "description") {
      const collision = payload.type === "offer" && (makingOffer.get(from) || pc.signalingState !== "stable");
      const shouldIgnore = !isPolite(from) && collision;
      ignoreOffer.set(from, shouldIgnore);
      if (shouldIgnore) return;

      await pc.setRemoteDescription(payload);
      if (payload.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(from, "description", pc.localDescription);
      }
    } else if (type === "candidate") {
      try {
        await pc.addIceCandidate(payload);
      } catch (err) {
        if (!ignoreOffer.get(from)) console.warn("No se pudo agregar ICE candidate", err);
      }
    }
  }

  function destroy() {
    unsubscribeSignals();
    for (const peerId of [...peerConnections.keys()]) {
      closePeer(peerId);
    }
  }

  return {
    handlePeerJoined,
    handlePeerLeft,
    setTrackEnabled,
    addLocalTrack,
    replaceLocalVideoTrack,
    destroy,
  };
}
