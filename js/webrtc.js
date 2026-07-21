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

// Pistas "mudas" (audio en silencio total + un cuadro de video negro),
// compartidas por todas las conexiones. Se usan como relleno mientras el
// usuario no activo su microfono/camara real: algunas versiones viejas de
// Safari/WebKit (el iPhone 7 no pasa de iOS 15) no decodifican el audio ni
// el video entrante en una conexion que del lado propio es puramente "solo
// recibir" sin nada local fluyendo. Mandar silencio/negro real desde el
// arranque de cada conexion evita ese problema, sin que se note en nada,
// hasta que el usuario active su propio microfono o camara.
let dummyAudioTrack = null;
let dummyVideoTrack = null;

function getDummyAudioTrack() {
  if (!dummyAudioTrack || dummyAudioTrack.readyState === "ended") {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass();
    const destination = ctx.createMediaStreamDestination();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    dummyAudioTrack = destination.stream.getAudioTracks()[0];
  }
  return dummyAudioTrack;
}

function getDummyVideoTrack() {
  if (!dummyVideoTrack || dummyVideoTrack.readyState === "ended") {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    dummyVideoTrack = canvas.captureStream(1).getVideoTracks()[0];
  }
  return dummyVideoTrack;
}

// localStream es un MediaStream mutable que vive en app.js: puede empezar
// vacio (sala solo de texto) y ir sumando el track de audio y/o video cuando
// el usuario activa el microfono/camara mas tarde.
export function createWebRTCManager({ userId, localStream, onRemoteStream, onRemoveStream, isModeratorPeer = () => false }) {
  const peerConnections = new Map();
  const peerClones = new Map(); // peerId -> { audio, video }: el clon actual mandado a ese par (real o mudo de relleno)
  const makingOffer = new Map(); // peerId -> bool
  const ignoreOffer = new Map(); // peerId -> bool
  const negotiationChain = new Map(); // peerId -> Promise (serializa renegociaciones)
  const trackEnabled = { audio: true, video: true };

  // Regla simple y simetrica para decidir quien cede en caso de que ambos
  // lados intenten renegociar al mismo tiempo ("glare").
  function isPolite(peerId) {
    return userId > peerId;
  }

  // Agrega o reemplaza el track de un tipo (audio/video) para un par. La
  // primera vez crea el sender (con el track mudo si el usuario todavia no
  // activo el real); mas adelante, cuando activa su microfono/camara real (o
  // cambia de camara), se reemplaza el track del mismo sender en vez de
  // agregar uno nuevo, para no terminar con dos lineas de medios del mismo
  // tipo.
  function setPeerTrack(pc, peerId, kind, track) {
    const alwaysOn = isModeratorPeer(peerId);
    const clone = track.clone();
    clone.enabled = alwaysOn ? true : trackEnabled[kind];
    const clones = peerClones.get(peerId) || {};
    const previous = clones[kind];
    const existingSender = previous && pc.getSenders().find((s) => s.track === previous);
    if (existingSender) {
      existingSender.replaceTrack(clone);
    } else {
      pc.addTrack(clone, localStream);
    }
    if (previous) previous.stop();
    clones[kind] = clone;
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

    const localAudio = localStream.getAudioTracks()[0];
    const localVideo = localStream.getVideoTracks()[0];
    setPeerTrack(pc, peerId, "audio", localAudio || getDummyAudioTrack());
    setPeerTrack(pc, peerId, "video", localVideo || getDummyVideoTrack());

    // Con el track mudo ya hay algo real para negociar desde el arranque:
    // no hace falta esperar a que el usuario active algo.
    scheduleNegotiation(peerId);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, "candidate", event.candidate);
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
  // abierta: reemplaza el track mudo por el real en cada par existente (o lo
  // agrega si por algun motivo todavia no habia sender de ese tipo) y
  // dispara la renegociacion.
  function addLocalTrack(track) {
    for (const [peerId, pc] of peerConnections) {
      setPeerTrack(pc, peerId, track.kind, track);
      scheduleNegotiation(peerId);
    }
  }

  // Reemplaza el track de video (por ejemplo al cambiar de camara) sin
  // renegociar: RTCRtpSender.replaceTrack no requiere una nueva oferta.
  function replaceLocalVideoTrack(newTrack) {
    for (const [peerId, pc] of peerConnections) {
      setPeerTrack(pc, peerId, "video", newTrack);
    }
  }

  function handlePeerJoined(peerId) {
    if (peerId === userId) return;
    // Se crea la conexion de los dos lados; si nadie activo audio/video
    // todavia, viaja solo el relleno mudo hasta que alguno active algo.
    getOrCreatePeerConnection(peerId);
  }

  function handlePeerLeft(peerId) {
    closePeer(peerId);
  }

  async function handleSignal({ from, signalType, payload }) {
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
    destroy,
  };
}
