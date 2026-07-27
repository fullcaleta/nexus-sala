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

export function createSfuManager({ userId, onRemoteStream, onRemoveStream, onModeratorExtraStream, onModeratorExtraStreamEnded }) {
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  // Promesas "en vuelo" para evitar crear el Device/transport DOS VECES si
  // dos llamadas concurrentes (ej: alguien entra con mic Y camara ya
  // autorizados, dispara dos "sfu-new-producer" casi juntos) ven la
  // variable todavia en null antes de que la primera termine de crearla --
  // sin esto, la segunda podia terminar con su propio transport huerfano
  // que nunca se conecta, y ese stream puntual quedaba sin aparecer nunca
  // (el motivo del "a veces no aparece" en la ventana del moderador).
  let devicePromise = null;
  let sendTransportPromise = null;
  let recvTransportPromise = null;
  const producers = new Map(); // role -> Producer
  const consumers = new Map(); // consumer.id -> { consumer, ownerUserId, role }
  const remoteStreams = new Map(); // ownerUserId -> MediaStream (roles normales: camera/mic)

  function ensureDevice() {
    if (device) return Promise.resolve(device);
    if (!devicePromise) {
      devicePromise = (async () => {
        const { rtpCapabilities } = await sendSfuRequest("sfu-rtp-capabilities");
        const d = new Device();
        await d.load({ routerRtpCapabilities: rtpCapabilities });
        device = d;
        return d;
      })().catch((err) => {
        devicePromise = null; // si fallo, la proxima llamada puede reintentar
        throw err;
      });
    }
    return devicePromise;
  }

  function ensureSendTransport() {
    if (sendTransport) return Promise.resolve(sendTransport);
    if (!sendTransportPromise) {
      sendTransportPromise = (async () => {
        await ensureDevice();
        const data = await sendSfuRequest("sfu-create-transport", { direction: "send" });
        const t = device.createSendTransport(data);
        t.on("connect", ({ dtlsParameters }, callback, errback) => {
          sendSfuRequest("sfu-connect-transport", { transportId: t.id, dtlsParameters }).then(callback).catch(errback);
        });
        t.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
          sendSfuRequest("sfu-produce", { transportId: t.id, kind, rtpParameters, role: appData.role })
            .then(({ producerId }) => callback({ id: producerId }))
            .catch(errback);
        });
        sendTransport = t;
        return t;
      })().catch((err) => {
        sendTransportPromise = null;
        throw err;
      });
    }
    return sendTransportPromise;
  }

  function ensureRecvTransport() {
    if (recvTransport) return Promise.resolve(recvTransport);
    if (!recvTransportPromise) {
      recvTransportPromise = (async () => {
        await ensureDevice();
        const data = await sendSfuRequest("sfu-create-transport", { direction: "recv" });
        const t = device.createRecvTransport(data);
        t.on("connect", ({ dtlsParameters }, callback, errback) => {
          sendSfuRequest("sfu-connect-transport", { transportId: t.id, dtlsParameters }).then(callback).catch(errback);
        });
        recvTransport = t;
        return t;
      })().catch((err) => {
        recvTransportPromise = null;
        throw err;
      });
    }
    return recvTransportPromise;
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
      // El track del consumer no dispara "ended" al cerrarse asi (.close()
      // llama a track.stop() por dentro, y stop() manual nunca dispara ese
      // evento, solo lo hace un corte externo de verdad) -- por eso la
      // limpieza de estos streams extra no puede depender de escuchar
      // "ended" en el propio track, hace falta avisar directo aca.
      if (MOD_ONLY_ROLES.has(entry.role)) {
        onModeratorExtraStreamEnded?.(entry.ownerUserId, entry.role);
      } else {
        // Sacar el track muerto del MediaStream compartido de esta persona
        // -- si no, cuando vuelva a conectarse (ej: recargo la pagina) su
        // track nuevo se agregaba a este MISMO stream, que todavia tenia el
        // viejo adentro. Un <video>/Web Audio con dos tracks del mismo tipo
        // en un MediaStream puede terminar mostrando/escuchando el viejo
        // (muerto) en vez del nuevo, de forma inconsistente segun el
        // navegador -- eso explicaba camara que no vuelve a aparecer, o
        // mic que a veces no se escucha, despues de recargar.
        const stream = remoteStreams.get(entry.ownerUserId);
        if (stream) {
          stream.removeTrack(entry.consumer.track);
          if (stream.getTracks().length === 0) remoteStreams.delete(entry.ownerUserId);
        }
        onRemoveStream?.(entry.ownerUserId);
      }
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
