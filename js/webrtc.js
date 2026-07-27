import { sendSignal, on as onRealtime } from "./realtime.js?v=6";

// Desde la migracion a SFU (ver js/sfu.js), este archivo maneja SOLO la
// llamada privada 1 a 1 -- el video/audio normal de la sala general ya no
// pasa por aca, pasa por el SFU (server/sfu.js + js/sfu.js). Con solo 2
// personas en una llamada privada, un SFU no da ningun beneficio sobre una
// conexion directa, asi que esta parte se queda igual que siempre.
const FALLBACK_ICE_SERVERS = { iceServers: [{ urls: "stun:nexus-sala.duckdns.org:33478" }] };

export function createWebRTCManager({ userId, iceServers = FALLBACK_ICE_SERVERS, onCallTrack, onCallEnded }) {
  // --- Llamada privada 1 a 1 ---
  const callPeerConnections = new Map(); // peerId -> RTCPeerConnection
  const callVideoSenders = new Map(); // peerId -> RTCRtpSender (transceiver de video, ver getOrCreateCallPeerConnection)
  const callMakingOffer = new Map();
  const callIgnoreOffer = new Map();
  const callNegotiationChain = new Map();

  // Regla simple y simetrica para decidir quien cede en caso de que ambos
  // lados intenten renegociar al mismo tiempo ("glare").
  function isPolite(peerId) {
    return userId > peerId;
  }

  function scheduleCallNegotiation(peerId) {
    const previous = callNegotiationChain.get(peerId) || Promise.resolve();
    const next = previous.then(() => negotiateCallWith(peerId)).catch(() => {});
    callNegotiationChain.set(peerId, next);
    return next;
  }

  // Resume el SDP a una linea por pista (que tipo, que direccion quedo
  // negociada: sendrecv/sendonly/recvonly/inactive) para poder ver de un
  // vistazo si algo quedo mal declarado, sin tener que leer el SDP entero.
  function summarizeSdp(sdp) {
    const lines = sdp.split(/\r\n|\n/);
    const parts = [];
    let current = null;
    for (const line of lines) {
      if (line.startsWith("m=")) {
        if (current) parts.push(current);
        current = { m: line, dir: "sendrecv (default)" };
      } else if (current && /^a=(sendrecv|sendonly|recvonly|inactive)/.test(line)) {
        current.dir = line.slice(2);
      }
    }
    if (current) parts.push(current);
    return parts.map((p) => `[${p.m} => ${p.dir}]`).join(" ");
  }

  async function negotiateCallWith(peerId) {
    const pc = callPeerConnections.get(peerId);
    if (!pc) return;
    try {
      callMakingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[NEXUS-CALL-SDP] oferta propia a ${peerId}: ${summarizeSdp(offer.sdp)}`);
      sendSignal(peerId, "call-description", pc.localDescription);
    } catch (err) {
      console.warn("No se pudo negociar la llamada:", err);
    } finally {
      callMakingOffer.set(peerId, false);
    }
  }

  // stream trae el microfono (siempre) de quien llama/atiende. La camara
  // arranca apagada a proposito (ver setCallVideoTrack): se declara un
  // transceiver de video desde el vamos, sin track todavia, para poder
  // prenderla despues en cualquier momento con un simple replaceTrack, sin
  // tener que renegociar la conexion de nuevo.
  function getOrCreateCallPeerConnection(peerId, stream) {
    let pc = callPeerConnections.get(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection(iceServers);
    callPeerConnections.set(peerId, pc);
    callMakingOffer.set(peerId, false);

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) pc.addTrack(audioTrack, stream);
    const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
    callVideoSenders.set(peerId, videoTransceiver.sender);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, "call-candidate", event.candidate);
    };

    pc.ontrack = (event) => {
      console.log(
        `[NEXUS-CALL] track recibido de ${peerId}: ${event.track.kind}, streamId=${event.streams[0]?.id}, muted=${event.track.muted}`
      );
      onCallTrack?.(peerId, event.streams[0], event.track);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[NEXUS-CALL] ICE con ${peerId}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[NEXUS-CALL] conexion con ${peerId}: ${pc.connectionState}`);
      if (["closed", "failed", "disconnected"].includes(pc.connectionState)) {
        endCall(peerId);
        onCallEnded?.(peerId);
      }
    };

    console.log(`[NEXUS-CALL] conexion de llamada creada para ${peerId} (audio=${!!audioTrack})`);
    return pc;
  }

  // Quien llama: prepara la conexion y manda la primera oferta.
  function startCallOffer(peerId, stream) {
    getOrCreateCallPeerConnection(peerId, stream);
    scheduleCallNegotiation(peerId);
  }

  // Quien atiende: prepara la conexion (con su propio microfono ya listo) y
  // espera la oferta de quien llama -- nunca ofrece primero. El orden
  // importa: recien se manda "call-accept" (ver app.js) despues de que esto
  // ya este listo, asi la oferta de quien llama siempre llega a un lado
  // preparado, sin necesidad de renegociar por una carrera de tiempos.
  function prepareCallReceiver(peerId, stream) {
    getOrCreateCallPeerConnection(peerId, stream);
  }

  // Prende/apaga la camara durante una llamada ya conectada. null apaga
  // (deja de mandar video). En teoria replaceTrack() alcanza solo, sin
  // renegociar (el transceiver ya esta declarado desde el arranque de la
  // llamada) -- pero algunos Safari viejos (iPhone 7 entre ellos) no
  // arrancan a mandar el video de verdad con eso solo, mientras el otro
  // lado nunca ve nada. Por eso se agrega ademas una renegociacion real:
  // mas lento, pero mucho mas compatible.
  function setCallVideoTrack(peerId, track) {
    const sender = callVideoSenders.get(peerId);
    if (!sender) return;
    sender.replaceTrack(track);
    scheduleCallNegotiation(peerId);
  }

  function endCall(peerId) {
    const pc = callPeerConnections.get(peerId);
    if (pc) {
      pc.close();
      callPeerConnections.delete(peerId);
    }
    callVideoSenders.delete(peerId);
    callMakingOffer.delete(peerId);
    callIgnoreOffer.delete(peerId);
    callNegotiationChain.delete(peerId);
  }

  // Misma logica de "perfect negotiation" que en la sala (antes de la
  // migracion a SFU), pero sobre callPeerConnections en vez de peerConnections.
  // Nunca crea la conexion sola: si todavia no existe, es una oferta que
  // llego antes de que este lado llamara a prepareCallReceiver/startCallOffer,
  // algo que no deberia pasar siguiendo el protocolo de invitar/aceptar (ver
  // app.js) -- se ignora por las dudas, en vez de crear una llamada "fantasma".
  async function handleCallSignal({ from, signalType, payload }) {
    console.log(`[NEXUS-CALL] señal recibida de ${from}: ${signalType}${payload?.type ? " (" + payload.type + ")" : ""}`);
    const pc = callPeerConnections.get(from);
    if (!pc) {
      console.warn(`[NEXUS-CALL] llego "${signalType}" de ${from} pero no hay conexion de llamada preparada, se ignora`);
      return;
    }
    if (signalType === "call-description") {
      const collision = payload.type === "offer" && (callMakingOffer.get(from) || pc.signalingState !== "stable");
      const shouldIgnore = !isPolite(from) && collision;
      callIgnoreOffer.set(from, shouldIgnore);
      if (shouldIgnore) {
        console.warn(`[NEXUS-CALL] oferta de ${from} ignorada por colision`);
        return;
      }

      console.log(`[NEXUS-CALL-SDP] ${payload.type} recibida de ${from}: ${summarizeSdp(payload.sdp)}`);
      await pc.setRemoteDescription(payload);
      if (payload.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`[NEXUS-CALL-SDP] respuesta propia a ${from}: ${summarizeSdp(answer.sdp)}`);
        sendSignal(from, "call-description", pc.localDescription);
      }
    } else if (signalType === "call-candidate") {
      try {
        await pc.addIceCandidate(payload);
      } catch (err) {
        if (!callIgnoreOffer.get(from)) console.warn("No se pudo agregar ICE candidate de la llamada", err);
      }
    }
  }

  const unsubscribeCallSignal = onRealtime("signal", (msg) => {
    if (msg.signalType === "call-description" || msg.signalType === "call-candidate") {
      handleCallSignal(msg);
    }
  });

  function destroy() {
    unsubscribeCallSignal();
    for (const peerId of [...callPeerConnections.keys()]) {
      endCall(peerId);
    }
  }

  return {
    startCallOffer,
    prepareCallReceiver,
    setCallVideoTrack,
    endCall,
    destroy,
  };
}
