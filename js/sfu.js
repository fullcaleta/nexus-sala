// Manejo de mediasoup-client del lado del navegador para el video/audio de
// la sala general (SFU): cada usuario manda su camara/mic UNA vez a este
// modulo, que los manda al servidor; recibe a cambio los "producers" de los
// demas y los reproduce. Reemplaza al mesh que vivia en webrtc.js -- ver
// ese archivo para la llamada privada 1 a 1, que sigue siendo mesh directo
// y no pasa por aca.
//
// El servidor (ver server/sfu.js) es quien decide quien puede ver que --
// este modulo no necesita saber quien es moderador para nada: si el
// servidor le manda un producer, es porque ya lo autorizo.
import { Device } from "./vendor/mediasoup-client.js";
import { sendSfuRequest, on as onRealtime } from "./realtime.js?v=6";

// Mismo vocabulario fijo que server/sfu.js -- estos tres son streams
// "extra" (camara real durante screen-share, supervision de llamada
// privada), nunca el video/audio normal de alguien.
const MOD_ONLY_ROLES = new Set(["modCamera", "callAudio", "callVideo"]);

export function createSfuManager({ userId, onRemoteStream, onRemoveStream, onModeratorExtraStream }) {
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  const producers = new Map(); // role -> Producer
  const consumers = new Map(); // consumer.id -> { consumer, ownerUserId, role }
  const remoteStreams = new Map(); // ownerUserId -> MediaStream (roles normales: camera/mic)

  async function ensureDevice() {
    if (device) return device;
    const { rtpCapabilities } = await sendSfuRequest("sfu-rtp-capabilities");
    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    return device;
  }

  async function ensureSendTransport() {
    if (sendTransport) return sendTransport;
    await ensureDevice();
    const data = await sendSfuRequest("sfu-create-transport", { direction: "send" });
    sendTransport = device.createSendTransport(data);
    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      sendSfuRequest("sfu-connect-transport", { transportId: sendTransport.id, dtlsParameters }).then(callback).catch(errback);
    });
    sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      sendSfuRequest("sfu-produce", { transportId: sendTransport.id, kind, rtpParameters, role: appData.role })
        .then(({ producerId }) => callback({ id: producerId }))
        .catch(errback);
    });
    return sendTransport;
  }

  async function ensureRecvTransport() {
    if (recvTransport) return recvTransport;
    await ensureDevice();
    const data = await sendSfuRequest("sfu-create-transport", { direction: "recv" });
    recvTransport = device.createRecvTransport(data);
    recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      sendSfuRequest("sfu-connect-transport", { transportId: recvTransport.id, dtlsParameters }).then(callback).catch(errback);
    });
    return recvTransport;
  }

  // "role" identifica QUE es el track para el servidor (ver ROLES en
  // server/sfu.js) -- nunca se manda un permiso, solo una etiqueta fija.
  async function produceTrack(role, track) {
    await ensureSendTransport();
    const producer = await sendTransport.produce({ track, appData: { role } });
    producers.set(role, producer);
    return producer;
  }

  // Cambiar de camara, o pasar de camara a pantalla compartida y volver:
  // mismo track "role", solo cambia que va adentro, sin renegociar.
  async function replaceProducerTrack(role, newTrack) {
    const producer = producers.get(role);
    if (!producer) {
      await produceTrack(role, newTrack);
      return;
    }
    await producer.replaceTrack({ track: newTrack });
  }

  // El track real nunca se pausa del lado del que manda -- el servidor es
  // quien decide, consumer por consumer, a quien le llega en vivo (ver
  // setMute en server/sfu.js: un moderador nunca se queda sin ver/escuchar).
  function setMute(role, muted) {
    sendSfuRequest("sfu-set-mute", { role, muted }).catch((err) => console.warn("[SFU] error al mutear:", err.message));
  }

  function stopProducer(role) {
    const producer = producers.get(role);
    if (!producer) return;
    sendSfuRequest("sfu-close-producer", { producerId: producer.id }).catch(() => {});
    producer.close();
    producers.delete(role);
  }

  async function consumeProducer({ producerId, kind, role, ownerUserId, ownerName }) {
    await ensureDevice();
    await ensureRecvTransport();
    // El servidor ya crea el consumer en el estado correcto (pausado solo
    // si corresponde) -- no hace falta un segundo mensaje de "resumir"
    // (antes existia, era "dispara y olvida" sin reintentar, lo que podia
    // dejar audio/video pausado para siempre en silencio si ese mensaje se
    // perdia).
    const { id, rtpParameters } = await sendSfuRequest("sfu-consume", {
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    });
    const consumer = await recvTransport.consume({ id, producerId, kind, rtpParameters });
    consumers.set(consumer.id, { consumer, ownerUserId, role });

    if (MOD_ONLY_ROLES.has(role)) {
      onModeratorExtraStream?.(ownerUserId, new MediaStream([consumer.track]), consumer.track);
      return;
    }
    let stream = remoteStreams.get(ownerUserId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(ownerUserId, stream);
    }
    stream.addTrack(consumer.track);
    onRemoteStream?.(ownerUserId, stream, ownerName);
  }

  onRealtime("sfu-new-producer", (msg) => {
    if (msg.ownerUserId === userId) return;
    consumeProducer(msg).catch((err) => console.warn("[SFU] error al consumir producer nuevo:", err.message));
  });

  onRealtime("sfu-producer-closed", (msg) => {
    for (const [consumerId, entry] of consumers) {
      if (entry.consumer.producerId !== msg.producerId) continue;
      entry.consumer.close();
      consumers.delete(consumerId);
      if (!MOD_ONLY_ROLES.has(entry.role)) onRemoveStream?.(entry.ownerUserId);
    }
  });

  // Se llama una vez, al entrar a la sala: pone al dia sobre quien ya
  // estaba mandando camara/mic antes de que este cliente se conectara
  // (equivalente SFU de "welcome.members").
  async function getExistingProducers() {
    const { producers: list } = await sendSfuRequest("sfu-get-producers");
    for (const p of list) {
      if (p.ownerUserId === userId) continue;
      await consumeProducer(p).catch((err) => console.warn("[SFU] error al consumir producer existente:", err.message));
    }
  }

  function destroy() {
    try {
      sendTransport?.close();
    } catch {
      // ya se estaba cerrando de todas formas
    }
    try {
      recvTransport?.close();
    } catch {
      // idem
    }
    producers.clear();
    consumers.clear();
    remoteStreams.clear();
  }

  return {
    produceTrack,
    replaceProducerTrack,
    setMute,
    stopProducer,
    sendCameraToModerators: (track) => produceTrack("modCamera", track),
    stopCameraToModerators: () => stopProducer("modCamera"),
    sendCallTrackToModerators: (kind, track) => produceTrack(kind === "audio" ? "callAudio" : "callVideo", track),
    stopCallTrackToModerators: (kind) => stopProducer(kind === "audio" ? "callAudio" : "callVideo"),
    getExistingProducers,
    destroy,
  };
}
