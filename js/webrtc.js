import { sendSignal, on as onRealtime } from "./realtime.js?v=9";

// Desde la migracion a SFU (ver js/sfu.js), este archivo maneja SOLO la
// llamada privada 1 a 1 -- el video/audio normal de la sala general ya no
// pasa por aca, pasa por el SFU (server/sfu.js + js/sfu.js). Con solo 2
// personas en una llamada privada, un SFU no da ningun beneficio sobre una
// conexion directa, asi que esta parte se queda igual que siempre.
const FALLBACK_ICE_SERVERS = { iceServers: [{ urls: "stun:nexus-sala.duckdns.org:33478" }] };

export function createWebRTCManager({ userId, iceServers = FALLBACK_ICE_SERVERS, onCallTrack, onCallEnded, onAudioSilentRequest, onDebugLog }) {
  // Ademas de la consola de siempre, manda las lineas clave al panel visible
  // en pantalla de app.js (ver debugLog ahi) -- se agrego para poder
  // investigar el bug de audio del iPhone 7 sin depender de un Mac/cable.
  const log = (msg) => {
    console.log(msg);
    onDebugLog?.(msg);
  };
  // --- Llamada privada 1 a 1 ---
  const callPeerConnections = new Map(); // peerId -> RTCPeerConnection
  const callVideoSenders = new Map(); // peerId -> RTCRtpSender (transceiver de video, ver getOrCreateCallPeerConnection)
  const callAudioSenders = new Map(); // peerId -> RTCRtpSender (mic, ver getOrCreateCallPeerConnection y setCallAudioTrack)
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

  // Diagnostico: lee del lado que MANDA (no del que recibe) que cree el
  // propio navegador que esta enviando -- bytesSent/packetsSent (si crecen,
  // esta mandando paquetes de verdad) y, si el navegador lo expone,
  // audioLevel/totalAudioEnergy de la fuente real (si esto da 0 de forma
  // sostenida mientras bytesSent SI crece, el navegador esta mandando
  // paquetes de audio vacios/silenciosos a proposito, no un problema de
  // red). Nunca se habia mirado este lado, solo el que recibe.
  function pollOutboundAudioStats(peerId, pc) {
    let secs = 0;
    const iv = setInterval(async () => {
      if (!callPeerConnections.has(peerId) || pc.connectionState === "closed") {
        clearInterval(iv);
        return;
      }
      secs++;
      if (secs > 20) {
        clearInterval(iv);
        return;
      }
      try {
        const stats = await pc.getStats(null);
        stats.forEach((r) => {
          if ((r.type === "outbound-rtp" && r.kind === "audio") || (r.type === "media-source" && r.kind === "audio")) {
            const campos = ["type", "bytesSent", "packetsSent", "audioLevel", "totalAudioEnergy", "totalSamplesDuration"]
              .filter((k) => r[k] !== undefined)
              .map((k) => `${k}=${typeof r[k] === "number" ? r[k].toFixed(4) : r[k]}`)
              .join(" ");
            log(`[CALL-TX-STATS] con ${peerId}: ${campos}`);
          }
        });
      } catch {}
    }, 1000);
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
    if (audioTrack) callAudioSenders.set(peerId, pc.addTrack(audioTrack, stream));
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

    let sendStatsStarted = false;

    pc.oniceconnectionstatechange = () => {
      log(`[CALL-ICE] estado con ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        // Que TIPO de candidato se uso de verdad (host = directo en la LAN,
        // srflx = STUN, relay = TURN).
        pc.getStats(null).then((stats) => {
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              const local = stats.get(report.localCandidateId);
              const remote = stats.get(report.remoteCandidateId);
              log(
                `[CALL-ICE] par de candidatos con ${peerId}: local=${local?.candidateType} (${local?.address || local?.ip}:${local?.port}) remote=${remote?.candidateType} (${remote?.address || remote?.ip}:${remote?.port})`
              );
            }
          });
        });
        if (!sendStatsStarted) {
          sendStatsStarted = true;
          pollOutboundAudioStats(peerId, pc);
        }
      }
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

  // Reemplaza el microfono que se manda a esta llamada por uno nuevo. Se usa
  // cuando el OTRO lado avisa que no le esta llegando audio de verdad (ver
  // "call-audio-silent" mas abajo): un problema conocido de Safari/iOS viejo
  // donde el track queda "vivo" a nivel de WebRTC (dispara "unmute", ICE
  // conectado) pero lo que manda es silencio. Mismo caso que setCallVideoTrack
  // aca arriba (mismo dispositivo, mismo motivo): replaceTrack() solo no
  // alcanza para que Safari viejo arranque a mandar audio de verdad -- hace
  // falta ademas una renegociacion real.
  function setCallAudioTrack(peerId, track) {
    const sender = callAudioSenders.get(peerId);
    if (!sender) return;
    sender
      .replaceTrack(track)
      .then(() => scheduleCallNegotiation(peerId))
      .catch((err) => console.warn("[NEXUS-CALL] no se pudo refrescar el microfono de la llamada:", err));
  }

  // Le avisa al otro lado de la llamada que no le esta llegando audio real
  // (ver monitorCallAudioLevel en app.js), para que intente refrescar su
  // propio microfono con setCallAudioTrack.
  function notifyAudioSilent(peerId) {
    sendSignal(peerId, "call-audio-silent", {});
  }

  // Mas agresivo que setCallAudioTrack: cierra la conexion de la llamada
  // entera y crea una nueva de cero (con los mismos tracks), en vez de
  // solo reemplazar el track y renegociar. Se prueba porque eso ultimo
  // (confirmado con logs reales) no alcanzo -- si el problema no es el
  // track sino el propio RTCPeerConnection/sender que quedo mandando
  // silencio sin importar que se le ponga adentro, solo una conexion
  // nueva de cero lo puede destrabar. El video (si estaba prendido) hay
  // que re-aplicarlo aparte con setCallVideoTrack (ver handleAudioSilentRequest
  // en app.js): el transceiver de video nuevo arranca vacio, igual que al
  // armar la llamada por primera vez.
  function restartCallConnection(peerId, stream) {
    const oldPc = callPeerConnections.get(peerId);
    if (oldPc) {
      // Se saca el listener de cierre ANTES de cerrar: onconnectionstatechange
      // llama a endCall/onCallEnded cuando el estado pasa a "closed", y eso
      // colgaria la llamada entera en vez de solo reiniciar la conexion.
      oldPc.onconnectionstatechange = null;
      oldPc.close();
    }
    callPeerConnections.delete(peerId);
    callVideoSenders.delete(peerId);
    callAudioSenders.delete(peerId);
    getOrCreateCallPeerConnection(peerId, stream);
    scheduleCallNegotiation(peerId);
  }

  function endCall(peerId) {
    const pc = callPeerConnections.get(peerId);
    if (pc) {
      pc.close();
      callPeerConnections.delete(peerId);
    }
    callVideoSenders.delete(peerId);
    callAudioSenders.delete(peerId);
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
    } else if (signalType === "call-audio-silent") {
      onAudioSilentRequest?.(from);
    }
  }

  const unsubscribeCallSignal = onRealtime("signal", (msg) => {
    if (["call-description", "call-candidate", "call-audio-silent"].includes(msg.signalType)) {
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
    setCallAudioTrack,
    notifyAudioSilent,
    restartCallConnection,
    endCall,
    destroy,
  };
}
