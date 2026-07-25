import { sendSignal, on as onRealtime } from "./realtime.js?v=4";

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
export function createWebRTCManager({
  userId,
  localStream,
  onRemoteStream,
  onRemoveStream,
  onModeratorExtraStream,
  onCallTrack,
  onCallEnded,
  isModeratorPeer = () => false,
}) {
  const peerConnections = new Map();
  const peerClones = new Map(); // peerId -> { audio, video, extras: { [key]: MediaStreamTrack } }
  const makingOffer = new Map(); // peerId -> bool
  const ignoreOffer = new Map(); // peerId -> bool
  const negotiationChain = new Map(); // peerId -> Promise (serializa renegociaciones)
  const trackEnabled = { audio: true, video: true };
  // Stream separado (nunca se manda a nadie) solo para poder distinguir del
  // lado de quien recibe: cuando llega un track agrupado en esta stream, es
  // algo extra solo para moderadores (la camara real durante un screen-share,
  // o el audio/video de una llamada privada ajena que estan supervisando),
  // no el video/audio "normal" de esa persona.
  const modCameraStream = new MediaStream();
  const primaryStreamIdByPeer = new Map(); // peerId -> id de la stream "normal" (la primera que se vio)

  // --- Llamada privada 1 a 1: conexion totalmente aparte del mesh de la
  // sala de arriba (peerConnections), para no arriesgar esa logica ya
  // probada. Solo existe con el peer con el que se esta llamando, nunca con
  // el resto de la sala.
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
      const streamId = event.streams[0]?.id;
      const primaryId = primaryStreamIdByPeer.get(peerId);
      if (!primaryId) primaryStreamIdByPeer.set(peerId, streamId);
      if (!primaryId || streamId === primaryId) {
        onRemoteStream(peerId, event.streams[0]);
      } else {
        // stream distinta a la primera vista de este peer: es la camara
        // real que solo se manda a moderadores mientras alguien comparte
        // pantalla (ver sendCameraToModerators).
        onModeratorExtraStream?.(peerId, event.streams[0], event.track);
      }
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
      if (clones.audio) clones.audio.stop();
      if (clones.video) clones.video.stop();
      if (clones.extras) Object.values(clones.extras).forEach((track) => track.stop());
      peerClones.delete(peerId);
    }
    makingOffer.delete(peerId);
    ignoreOffer.delete(peerId);
    negotiationChain.delete(peerId);
    primaryStreamIdByPeer.delete(peerId);
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

  // Manda un track "extra" (que no reemplaza nada) solo a los peers
  // moderadores, agrupado bajo modCameraStream para que del otro lado se
  // distinga de la stream normal (ver onModeratorExtraStream). Se usa tanto
  // para la camara real durante un screen-share como para dejar que un
  // moderador supervise el audio/video de una llamada privada ajena -- en
  // los dos casos es "algo de esta persona que solo ve/escucha el mod".
  // "key" identifica cada track por separado (una persona podria, en teoria,
  // estar compartiendo pantalla Y en una llamada al mismo tiempo).
  function sendExtraTrackToModerators(key, track) {
    for (const [peerId, pc] of peerConnections) {
      if (!isModeratorPeer(peerId)) continue;
      const clone = track.clone();
      clone.enabled = true;
      pc.addTrack(clone, modCameraStream);
      const clones = peerClones.get(peerId) || {};
      clones.extras = clones.extras || {};
      clones.extras[key] = clone;
      peerClones.set(peerId, clones);
      scheduleNegotiation(peerId);
    }
  }

  function stopExtraTrackToModerators(key) {
    for (const [peerId, pc] of peerConnections) {
      const clones = peerClones.get(peerId);
      const clone = clones?.extras?.[key];
      if (!clone) continue;
      const sender = pc.getSenders().find((s) => s.track === clone);
      if (sender) pc.removeTrack(sender);
      clone.stop();
      delete clones.extras[key];
      scheduleNegotiation(peerId);
    }
  }

  // Mientras alguien comparte pantalla, el video "normal" (el que ve todo
  // el mundo) pasa a ser la pantalla. Esto manda ADEMAS la camara real,
  // solo a los peers moderadores (no reemplaza nada). Es la misma logica
  // que ya existe para audio/video normal (isModeratorPeer siempre ve el
  // real), extendida a este caso.
  function sendCameraToModerators(cameraTrack) {
    sendExtraTrackToModerators("modCamera", cameraTrack);
  }

  // Deja de mandar la camara extra a los moderadores (por ejemplo, al dejar
  // de compartir pantalla: ya no hace falta, la camara vuelve a ser el
  // video normal para todos).
  function stopCameraToModerators() {
    stopExtraTrackToModerators("modCamera");
  }

  // Igual que sendCameraToModerators/stopCameraToModerators, pero para el
  // audio (y opcionalmente video) de una llamada privada: el moderador
  // recibe una copia para poder supervisarla, tal como se avisa en la
  // pantalla de ingreso.
  function sendCallTrackToModerators(kind, track) {
    sendExtraTrackToModerators(`call-${kind}`, track);
  }

  function stopCallTrackToModerators(kind) {
    stopExtraTrackToModerators(`call-${kind}`);
  }

  function handlePeerJoined(peerId) {
    if (peerId === userId) return;
    // Se crea la conexion de los dos lados; si nadie tiene audio/video
    // activo todavia, queda inerte hasta que alguno active algo.
    getOrCreatePeerConnection(peerId);
  }

  function handlePeerLeft(peerId) {
    closePeer(peerId);
    endCall(peerId); // por si se estaba llamando con esta persona, se corta sola
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

  // --- Llamada privada 1 a 1 ---
  // Conexion totalmente aparte de peerConnections (ver arriba): asi el
  // audio/video de una llamada nunca se mezcla con la transmision normal de
  // la sala, y no hay riesgo de tocar esa logica ya delicada. Solo existe
  // mientras dura la llamada con esa persona puntual.

  function scheduleCallNegotiation(peerId) {
    const previous = callNegotiationChain.get(peerId) || Promise.resolve();
    const next = previous.then(() => negotiateCallWith(peerId)).catch(() => {});
    callNegotiationChain.set(peerId, next);
    return next;
  }

  async function negotiateCallWith(peerId) {
    const pc = callPeerConnections.get(peerId);
    if (!pc) return;
    try {
      callMakingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[NEXUS-CALL] mandando oferta de llamada a ${peerId}`);
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

    pc = new RTCPeerConnection(ICE_SERVERS);
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
  // (deja de mandar video, sin sacar el transceiver ni renegociar).
  function setCallVideoTrack(peerId, track) {
    const sender = callVideoSenders.get(peerId);
    if (sender) sender.replaceTrack(track);
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

  // Misma logica de "perfect negotiation" que handleSignal de arriba, pero
  // sobre callPeerConnections en vez de peerConnections. Nunca crea la
  // conexion sola (a diferencia de handleSignal con getOrCreatePeerConnection):
  // si todavia no existe, es una oferta que llego antes de que este lado
  // llamara a prepareCallReceiver/startCallOffer, algo que no deberia pasar
  // siguiendo el protocolo de invitar/aceptar (ver app.js) -- se ignora por
  // las dudas, en vez de crear una llamada "fantasma".
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

      await pc.setRemoteDescription(payload);
      if (payload.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`[NEXUS-CALL] mandando respuesta de llamada a ${from}`);
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
    unsubscribeSignal();
    unsubscribeCallSignal();
    for (const peerId of [...peerConnections.keys()]) {
      closePeer(peerId);
    }
    for (const peerId of [...callPeerConnections.keys()]) {
      endCall(peerId);
    }
  }

  return {
    handlePeerJoined,
    handlePeerLeft,
    setTrackEnabled,
    addLocalTrack,
    replaceLocalVideoTrack,
    replaceLocalAudioTrack,
    sendCameraToModerators,
    stopCameraToModerators,
    sendCallTrackToModerators,
    stopCallTrackToModerators,
    startCallOffer,
    prepareCallReceiver,
    setCallVideoTrack,
    endCall,
    destroy,
  };
}
