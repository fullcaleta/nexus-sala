import { sendSignal, on as onRealtime } from "./realtime.js";

// Servidor TURN propio (coturn) corriendo en tu PC.
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:nexus-sala.duckdns.org:3478" },
    {
      urls: "turn:nexus-sala.duckdns.org:3478",
      username: "nexususer",
      credential: "AKgSTdMrTRG13VGy3fAr",
    },
    {
      urls: "turn:nexus-sala.duckdns.org:3478?transport=tcp",
      username: "nexususer",
      credential: "AKgSTdMrTRG13VGy3fAr",
    },
  ],
};

// localStream es un MediaStream mutable que vive en app.js: puede empezar
// vacio (sala solo de texto) y ir sumando el track de audio y/o video cuando
// el usuario activa el microfono/camara mas tarde.
export function createWebRTCManager({ userId, localStream, onRemoteStream, onRemoveStream, isModeratorPeer = () => false }) {
  const peerConnections = new Map();
  const peerClones = new Map(); // peerId -> { audio: MediaStreamTrack, video: MediaStreamTrack }
  const makingOffer = new Map(); // peerId -> bool
  const ignoreOffer = new Map(); // peerId -> bool
  const negotiationChain = new Map(); // peerId -> Promise (serializa renegociaciones)
  const trackEnabled = { audio: true, video: true };

  // Regla simple y simetrica para decidir quien cede en caso de que ambos
  // lados intenten renegociar al mismo tiempo ("glare").
  function isPolite(peerId) {
    return userId > peerId;
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

  // Dispara una oferta nueva de forma explicita (no dependemos de que el
  // navegador dispare "negotiationneeded" de forma confiable, sobre todo
  // cuando se agregan varios tracks seguidos en navegadores de celular).
  // Se encadena en una promesa por par para nunca superponer dos
  // renegociaciones sobre la misma conexion.
  function scheduleNegotiation(peerId) {
    const previous = negotiationChain.get(peerId) || Promise.resolve();
    const next = previous.then(() => negotiateWith(peerId)).catch(() => {});
    negotiationChain.set(peerId, next);
    return next;
  }

  async function negotiateWith(peerId) {
    const pc = peerConnections.get(peerId);
    if (!pc) return;
    try {
      makingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[NEXUS] mandando oferta a ${peerId}`);
      sendSignal(peerId, "description", pc.localDescription);
    } catch (err) {
      console.warn("No se pudo negociar la conexion:", err);
    } finally {
      makingOffer.set(peerId, false);
    }
  }

  function getOrCreatePeerConnection(peerId) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.set(peerId, pc);
    makingOffer.set(peerId, false);

    const localTracks = localStream.getTracks();
    for (const track of localTracks) {
      addTrackClone(pc, peerId, track);
    }
    // Aunque todavia no tengamos nada propio para mandar, declaramos que
    // podemos RECIBIR audio/video desde el arranque de la conexion. Sin
    // esto, algunos navegadores viejos (Safari/WebKit en celulares que ya
    // no reciben actualizaciones) no reproducen el video/audio entrante
    // hasta que el propio dispositivo tambien manda algo.
    const kindsPresent = new Set(localTracks.map((track) => track.kind));
    if (!kindsPresent.has("audio")) pc.addTransceiver("audio", { direction: "recvonly" });
    if (!kindsPresent.has("video")) pc.addTransceiver("video", { direction: "recvonly" });

    if (localTracks.length > 0) scheduleNegotiation(peerId);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, "candidate", event.candidate);
    };

    pc.ontrack = (event) => {
      console.log(`[NEXUS] track recibido de ${peerId}:`, event.track.kind);
      onRemoteStream(peerId, event.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[NEXUS] ICE con ${peerId}: ${pc.iceConnectionState}`);
    };

    pc.onicegatheringstatechange = () => {
      console.log(`[NEXUS] gathering con ${peerId}: ${pc.iceGatheringState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[NEXUS] conexion con ${peerId}: ${pc.connectionState}`);
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
    negotiationChain.delete(peerId);
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

  // Se llama cuando el usuario activa el microfono/camara, ya con la sala
  // abierta: manda el track nuevo a todos los pares existentes y dispara la
  // renegociacion de cada uno explicitamente.
  function addLocalTrack(track) {
    for (const [peerId, pc] of peerConnections) {
      addTrackClone(pc, peerId, track);
      scheduleNegotiation(peerId);
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

  // Igual que replaceLocalVideoTrack, pero para audio (por ejemplo al
  // mezclar el microfono con el audio de una pantalla compartida).
  function replaceLocalAudioTrack(newTrack) {
    for (const [peerId, clones] of peerClones) {
      const oldClone = clones.audio;
      if (!oldClone) continue;
      const pc = peerConnections.get(peerId);
      const sender = pc?.getSenders().find((s) => s.track === oldClone);
      const alwaysOn = isModeratorPeer(peerId);
      const newClone = newTrack.clone();
      newClone.enabled = alwaysOn ? true : trackEnabled.audio;
      if (sender) sender.replaceTrack(newClone);
      oldClone.stop();
      clones.audio = newClone;
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

  async function handleSignal({ from, signalType, payload }) {
    console.log(`[NEXUS] señal recibida de ${from}: ${signalType}${payload?.type ? " (" + payload.type + ")" : ""}`);
    const pc = getOrCreatePeerConnection(from);
    if (signalType === "description") {
      const collision = payload.type === "offer" && (makingOffer.get(from) || pc.signalingState !== "stable");
      const shouldIgnore = !isPolite(from) && collision;
      ignoreOffer.set(from, shouldIgnore);
      if (shouldIgnore) return;

      await pc.setRemoteDescription(payload);
      if (payload.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, "description", pc.localDescription);
      }
    } else if (signalType === "candidate") {
      try {
        await pc.addIceCandidate(payload);
      } catch (err) {
        if (!ignoreOffer.get(from)) console.warn("No se pudo agregar ICE candidate", err);
      }
    }
  }

  const unsubscribeSignal = onRealtime("signal", handleSignal);

  function destroy() {
    unsubscribeSignal();
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
    replaceLocalAudioTrack,
    destroy,
  };
}
