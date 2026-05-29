// La Feria - frontend GitHub Pages + backend WebSocket propio.
// En local usa ws://localhost:3000/ws.
// En produccion con GitHub Pages HTTPS debes usar wss://TU-SERVIDOR-PUBLICO/ws.
const SIGNALING_SERVER_URL = "ws://localhost:3000/ws";

const PUBLIC_STUN_SERVER = "stun:stun.l.google.com:19302";

const state = {
  profile: localStorage.getItem("la_feria_profile") || "",
  role: "",
  clientId: "",
  roomId: "",
  roomName: "",
  ws: null,
  peer: null,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  camEnabled: true,
  cameraId: "",
  microphoneId: "",
  speakerId: "",
  videoDevices: [],
  audioDevices: [],
  speakerDevices: [],
  mediaReady: Promise.resolve(),
  pendingIceCandidates: [],
};

function $(id) {
  return document.getElementById(id);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.add("hidden"));
  $(id)?.classList.remove("hidden");

  if (id === "profileScreen") $("profileInput").value = state.profile;
}

function showMsg(id, type, text) {
  const el = $(id);
  if (!el) return;
  el.className = `msg ${type} show`;
  el.textContent = text;
}

function clearMsg(id) {
  const el = $(id);
  if (!el) return;
  el.className = "msg";
  el.textContent = "";
}

function setStatus(text, type = "info") {
  const el = $("callStatus");
  if (!el) return;
  el.className = `call-status ${type}`;
  el.textContent = text;
}

function updateProfileBadge() {
  const name = state.profile || "Sin nombre";
  $("profileNameDisplay").textContent = name;
  $("avatarDisplay").textContent = name[0]?.toUpperCase() || "?";
}

function saveProfile() {
  const value = $("profileInput").value.trim();
  if (!value) return showMsg("profileMsg", "error", "El nombre no puede estar vacio.");

  state.profile = value;
  localStorage.setItem("la_feria_profile", value);
  updateProfileBadge();
  showMsg("profileMsg", "success", "Perfil guardado.");
  setTimeout(() => showScreen("menuScreen"), 700);
}

function getDisplayName() {
  return state.profile || (state.role === "creator" ? "Creador" : "Invitado");
}

function usePublicStun() {
  const box = state.role === "guest" ? $("joinUsePublicStun") : $("usePublicStun");
  return Boolean(box?.checked);
}

function getRtcConfig() {
  // STUN ayuda a conectar usuarios en redes distintas.
  // STUN no crea salas, no sustituye WebSocket y no retransmite video/audio.
  // Sin TURN algunas redes restrictivas pueden fallar. Esta app no usa TURN de pago.
  return usePublicStun()
    ? { iceServers: [{ urls: PUBLIC_STUN_SERVER }] }
    : { iceServers: [] };
}

function connectSignaling() {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve(state.ws);
  if (state.ws?.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve, reject) => {
      state.ws.addEventListener("open", () => resolve(state.ws), { once: true });
      state.ws.addEventListener("error", reject, { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SIGNALING_SERVER_URL);
    state.ws = ws;

    const fail = () => {
      reject(new Error("No se pudo conectar con el servidor de salas. Revisa que el servidor WebSocket este encendido y que SIGNALING_SERVER_URL sea correcto."));
    };

    ws.addEventListener("open", () => {
      showMsg(currentMessageBox(), "success", "Servidor conectado.");
      resolve(ws);
    }, { once: true });

    ws.addEventListener("message", event => {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (err) {
        console.warn("Mensaje invalido del servidor.");
      }
    });

    ws.addEventListener("close", () => {
      if (state.roomId) setStatus("Servidor de salas desconectado.", "error");
    });

    ws.addEventListener("error", fail, { once: true });
  });
}

function currentMessageBox() {
  if (!$("createScreen").classList.contains("hidden")) return "createMsg";
  if (!$("searchScreen").classList.contains("hidden")) return "searchMsg";
  if (!$("roomScreen").classList.contains("hidden")) return "roomMsg";
  return "createMsg";
}

function send(type, data = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showMsg(currentMessageBox(), "error", "No se pudo conectar con el servidor de salas.");
    return false;
  }

  state.ws.send(JSON.stringify({ type, ...data }));
  return true;
}

function handleServerMessage(message) {
  switch (message.type) {
    case "connected":
      state.clientId = message.clientId;
      break;

    case "rooms-list":
      renderRooms(message.rooms || []);
      break;

    case "room-created":
      state.roomId = message.room.id;
      state.roomName = message.room.name;
      enterCallScreen("creator", "Sala creada. Esperando a otra persona.");
      break;

    case "room-joined":
      state.roomId = message.room.id;
      state.roomName = message.room.name;
      enterCallScreen("guest", "Conectando con la sala.");
      break;

    case "room-ready":
      setStatus("Conectando WebRTC...", "info");
      if (message.creatorId === state.clientId) startOffer();
      break;

    case "offer":
      handleOffer(message.description);
      break;

    case "answer":
      handleAnswer(message.description);
      break;

    case "ice-candidate":
      handleIceCandidate(message.candidate);
      break;

    case "peer-left":
      resetRemoteMedia();
      setStatus("La otra persona salio. Esperando a otra persona.", "info");
      break;

    case "room-closed":
      resetRemoteMedia();
      setStatus("La sala no existe o ha caducado.", "error");
      break;

    case "room-list-updated":
      if (!$("searchScreen").classList.contains("hidden")) listRooms();
      break;

    case "error":
      showMsg(currentMessageBox(), "error", message.message || "Ha ocurrido un error.");
      setStatus(message.message || "Ha ocurrido un error.", "error");
      break;
  }
}

async function createRoom() {
  clearMsg("createMsg");
  const name = $("createRoomName").value.trim();
  const password = $("createRoomPassword").value;
  const repeat = $("createRoomPasswordRepeat").value;
  const button = $("createRoomButton");

  if (!name) return showMsg("createMsg", "error", "Escribe un nombre de sala.");
  if (password.length < 4) return showMsg("createMsg", "error", "La contrasena debe tener al menos 4 caracteres.");
  if (repeat && repeat !== password) return showMsg("createMsg", "error", "Las contrasenas no coinciden.");

  try {
    button.disabled = true;
    button.textContent = "Creando...";
    showMsg("createMsg", "success", "Conectando con servidor de salas...");
    await connectSignaling();
    state.role = "creator";
    send("create-room", { name, password, displayName: getDisplayName() });
  } catch (err) {
    showMsg("createMsg", "error", err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Crear";
  }
}

async function showSearchScreen() {
  showScreen("searchScreen");
  await listRooms();
}

async function listRooms() {
  clearMsg("searchMsg");
  $("roomsList").innerHTML = "";

  try {
    showMsg("searchMsg", "success", "Buscando salas...");
    await connectSignaling();
    send("list-rooms");
  } catch (err) {
    showMsg("searchMsg", "error", err.message);
  }
}

function renderRooms(rooms) {
  const list = $("roomsList");
  list.innerHTML = "";

  if (!rooms.length) {
    showMsg("searchMsg", "success", "No hay salas activas.");
    return;
  }

  clearMsg("searchMsg");
  rooms.forEach(room => {
    const item = document.createElement("article");
    item.className = "room-card";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(room.name)}</strong>
        <span>${room.users}/2 usuarios - ${room.available ? "Disponible" : "Llena"}</span>
      </div>
      <div class="room-card-actions">
        <input type="password" id="roomPass_${room.id}" placeholder="Contrasena" ${room.available ? "" : "disabled"}>
        <button class="btn btn-primary" type="button" ${room.available ? "" : "disabled"} onclick="joinRoom('${room.id}')">Entrar</button>
      </div>`;
    list.appendChild(item);
  });
}

async function joinRoom(roomId) {
  clearMsg("searchMsg");
  const password = $(`roomPass_${roomId}`)?.value || "";
  if (!password) return showMsg("searchMsg", "error", "Introduce la contrasena.");

  try {
    await connectSignaling();
    state.role = "guest";
    send("join-room", { roomId, password, displayName: getDisplayName() });
  } catch (err) {
    showMsg("searchMsg", "error", err.message);
  }
}

async function enterCallScreen(role, statusText) {
  state.role = role;
  state.pendingIceCandidates = [];
  $("localNameLabel").textContent = getDisplayName();
  $("roomNameTitle").textContent = state.roomName || "Sala";
  $("remoteNameLabel").textContent = "Otra persona";
  $("remoteVideo").srcObject = null;
  $("enableRemoteAudioButton")?.classList.add("hidden");
  $("waitingPanel").classList.remove("hidden");
  showScreen("roomScreen");
  setStatus(statusText, "info");
  state.mediaReady = (async () => {
    await tryStartLocalMedia();
    await loadDeviceList();
  })();
  await state.mediaReady;
}

function mediaErrorMessage(err) {
  const name = err?.name || "";

  if (!window.isSecureContext) return "Camara y microfono requieren HTTPS. GitHub Pages usa HTTPS; en local usa localhost.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Has entrado sin camara/microfono. Puedes activarlos desde ajustes.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "Camara o microfono no disponibles. Puedes continuar sin dispositivos.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Camara o microfono usados por otra aplicacion. Puedes continuar sin dispositivos.";
  return "No se pudo acceder a camara/microfono. Puedes continuar sin dispositivos.";
}

async function tryStartLocalMedia() {
  if (state.localStream?.getTracks().length) return state.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    setLocalStream(null);
    setStatus("Este navegador no permite usar camara/microfono, pero puedes continuar sin dispositivos.", "info");
    return null;
  }

  const attempts = [
    { constraints: { video: true, audio: true }, message: "" },
    { constraints: { video: true, audio: false }, message: "Microfono no disponible o silenciado." },
    { constraints: { video: false, audio: true }, message: "Camara no disponible o apagada." },
  ];

  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      setLocalStream(stream);
      if (attempt.message) setStatus(attempt.message, "info");
      return stream;
    } catch (err) {
      // Seguimos probando opciones parciales. Entrar a sala no depende de dispositivos.
    }
  }

  setLocalStream(null);
  setStatus("Has entrado sin camara/microfono. Puedes activarlos desde ajustes.", "info");
  return null;
}

function setLocalStream(stream) {
  if (state.localStream && state.localStream !== stream) {
    state.localStream.getTracks().forEach(track => track.stop());
  }

  state.localStream = stream;
  state.micEnabled = Boolean(stream?.getAudioTracks().length);
  state.camEnabled = Boolean(stream?.getVideoTracks().length);
  state.cameraId = state.cameraId || stream?.getVideoTracks()[0]?.getSettings?.().deviceId || "";
  state.microphoneId = state.microphoneId || stream?.getAudioTracks()[0]?.getSettings?.().deviceId || "";
  $("localVideo").srcObject = stream;
  $("camOffMsg").classList.toggle("hidden", state.camEnabled);
  updateControls();
}

function createPeerConnection() {
  closePeer();

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peer = pc;
  state.remoteStream = new MediaStream();
  const remoteVideo = $("remoteVideo");
  remoteVideo.srcObject = state.remoteStream;
  remoteVideo.muted = false;
  remoteVideo.volume = 1;

  debugRtc("peer-created", {
    role: state.role,
    localAudioTracks: state.localStream?.getAudioTracks().length || 0,
    localVideoTracks: state.localStream?.getVideoTracks().length || 0,
  });

  pc.onicecandidate = event => {
    if (event.candidate) {
      debugRtc("ice-candidate-sent", {
        type: event.candidate.type,
        protocol: event.candidate.protocol,
        candidateType: event.candidate.candidate?.split(" typ ")[1]?.split(" ")[0] || "unknown",
      });
      send("ice-candidate", { candidate: event.candidate.toJSON() });
    }
  };

  pc.ontrack = event => {
    const tracks = event.streams[0]?.getTracks().length ? event.streams[0].getTracks() : [event.track];
    tracks.filter(Boolean).forEach(track => {
      if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
        debugRtc("remote-track-received", {
          kind: track.kind,
          id: track.id,
          remoteTracks: state.remoteStream.getTracks().map(item => item.kind),
        });
      }
    });
    remoteVideo.srcObject = state.remoteStream;
    applySpeakerOutput(false);
    $("waitingPanel").classList.add("hidden");
    playRemoteMedia();
  };

  pc.onconnectionstatechange = () => {
    debugRtc("connection-state", { connectionState: pc.connectionState, signalingState: pc.signalingState });
    if (pc.connectionState === "connecting") setStatus("Conectando WebRTC...", "info");
    if (pc.connectionState === "connected") {
      $("waitingPanel").classList.add("hidden");
      setStatus("Llamada conectada.", "success");
      playRemoteMedia();
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus("No se pudo establecer WebRTC. Prueba activar STUN, usar otra red o revisar permisos.", "error");
    }
  };

  pc.oniceconnectionstatechange = () => {
    debugRtc("ice-connection-state", { iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState });
    if (pc.iceConnectionState === "failed") {
      setStatus("No se pudo establecer WebRTC. Prueba activar STUN, usar otra red o revisar permisos.", "error");
    }
  };

  pc.onsignalingstatechange = () => {
    debugRtc("signaling-state", { signalingState: pc.signalingState });
  };

  const audioTrack = state.localStream?.getAudioTracks()[0];
  const videoTrack = state.localStream?.getVideoTracks()[0];

  if (audioTrack) pc.addTrack(audioTrack, state.localStream);
  else pc.addTransceiver("audio", { direction: "sendrecv" });

  if (videoTrack) pc.addTrack(videoTrack, state.localStream);
  else pc.addTransceiver("video", { direction: "sendrecv" });

  debugRtc("local-media-attached", {
    audio: audioTrack ? "track" : "sendrecv-transceiver",
    video: videoTrack ? "track" : "sendrecv-transceiver",
  });

  return pc;
}

function closePeer() {
  if (state.peer) {
    debugRtc("peer-closing", {
      connectionState: state.peer.connectionState,
      iceConnectionState: state.peer.iceConnectionState,
      signalingState: state.peer.signalingState,
    });
    state.peer.onicecandidate = null;
    state.peer.ontrack = null;
    state.peer.onconnectionstatechange = null;
    state.peer.oniceconnectionstatechange = null;
    state.peer.close();
  }
  state.peer = null;
  state.remoteStream = null;
}

async function startOffer() {
  try {
    await state.mediaReady;
    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    debugRtc("offer-sent", {
      audioSenders: pc.getSenders().filter(sender => sender.track?.kind === "audio").length,
      videoSenders: pc.getSenders().filter(sender => sender.track?.kind === "video").length,
      transceivers: pc.getTransceivers().map(item => `${item.receiver.track.kind}:${item.direction}`),
    });
    send("offer", { description: pc.localDescription });
  } catch (err) {
    setStatus("No se pudo crear la oferta WebRTC.", "error");
    debugRtc("offer-error", { message: err.message });
  }
}

async function handleOffer(description) {
  try {
    await state.mediaReady;
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    await applyPendingIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    debugRtc("answer-sent", {
      audioSenders: pc.getSenders().filter(sender => sender.track?.kind === "audio").length,
      videoSenders: pc.getSenders().filter(sender => sender.track?.kind === "video").length,
      transceivers: pc.getTransceivers().map(item => `${item.receiver.track.kind}:${item.direction}`),
    });
    send("answer", { description: pc.localDescription });
  } catch (err) {
    setStatus("No se pudo responder la llamada WebRTC.", "error");
    debugRtc("answer-error", { message: err.message });
  }
}

async function handleAnswer(description) {
  try {
    if (!state.peer) return;
    await state.peer.setRemoteDescription(new RTCSessionDescription(description));
    await applyPendingIceCandidates();
    debugRtc("answer-applied", { signalingState: state.peer.signalingState });
  } catch (err) {
    setStatus("No se pudo aplicar la respuesta WebRTC.", "error");
    debugRtc("answer-apply-error", { message: err.message });
  }
}

async function handleIceCandidate(candidate) {
  try {
    if (!candidate) return;
    if (!state.peer || !state.peer.remoteDescription) {
      state.pendingIceCandidates.push(candidate);
      debugRtc("ice-candidate-queued", { queued: state.pendingIceCandidates.length });
      return;
    }
    debugRtc("ice-candidate-received", {
      candidateType: candidate.candidate?.split(" typ ")[1]?.split(" ")[0] || "unknown",
    });
    await state.peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    debugRtc("ice-candidate-error", { message: err.message });
  }
}

async function applyPendingIceCandidates() {
  if (!state.peer?.remoteDescription || !state.pendingIceCandidates.length) return;

  const queued = state.pendingIceCandidates.splice(0);
  debugRtc("ice-candidates-applying", { count: queued.length });
  for (const candidate of queued) {
    try {
      await state.peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      debugRtc("queued-ice-candidate-error", { message: err.message });
    }
  }
}

async function loadDeviceList() {
  const cameraSelect = $("cameraSelect");
  const microphoneSelect = $("microphoneSelect");
  const speakerSelect = $("speakerSelect");
  const speakerGroup = $("speakerGroup");

  if (!navigator.mediaDevices?.enumerateDevices) {
    fillDeviceSelect(cameraSelect, [], "Camara no disponible", "");
    fillDeviceSelect(microphoneSelect, [], "Microfono no disponible", "");
    speakerGroup?.classList.add("hidden");
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const counts = { videoinput: 0, audioinput: 0, audiooutput: 0 };
    state.videoDevices = [];
    state.audioDevices = [];
    state.speakerDevices = [];

    devices.forEach(device => {
      if (!["videoinput", "audioinput", "audiooutput"].includes(device.kind)) return;
      counts[device.kind] += 1;
      const item = { id: device.deviceId, label: device.label || fallbackDeviceLabel(device.kind, counts[device.kind]) };
      if (device.kind === "videoinput") state.videoDevices.push(item);
      if (device.kind === "audioinput") state.audioDevices.push(item);
      if (device.kind === "audiooutput") state.speakerDevices.push(item);
    });

    fillDeviceSelect(cameraSelect, state.videoDevices, "Camara predeterminada", state.cameraId);
    fillDeviceSelect(microphoneSelect, state.audioDevices, "Microfono predeterminado", state.microphoneId);

    const canChooseSpeaker = typeof $("remoteVideo")?.setSinkId === "function";
    speakerGroup?.classList.toggle("hidden", !canChooseSpeaker);
    if (canChooseSpeaker) fillDeviceSelect(speakerSelect, state.speakerDevices, "Salida del sistema", state.speakerId);
  } catch (err) {
    fillDeviceSelect(cameraSelect, [], "Camara 1", "");
    fillDeviceSelect(microphoneSelect, [], "Microfono 1", "");
    speakerGroup?.classList.add("hidden");
  }
}

function fallbackDeviceLabel(kind, index) {
  if (kind === "videoinput") return `Camara ${index}`;
  if (kind === "audioinput") return `Microfono ${index}`;
  return index === 1 ? "Salida del sistema" : `Salida de audio ${index}`;
}

function fillDeviceSelect(select, devices, defaultLabel, selectedId) {
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option(defaultLabel, ""));
  devices.forEach(device => select.appendChild(new Option(device.label, device.id)));
  if (selectedId && devices.some(device => device.id === selectedId)) select.value = selectedId;
}

async function activateCamera() {
  await changeCamera($("cameraSelect")?.value || "");
}

async function activateMicrophone() {
  await changeMicrophone($("microphoneSelect")?.value || "");
}

async function changeCamera(deviceId) {
  state.cameraId = deviceId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
    const [newTrack] = stream.getVideoTracks();
    if (!newTrack) throw new Error("Camara no disponible.");
    ensureEditableLocalStream();
    replaceLocalTrack("video", newTrack);
    await replacePeerTrack("video", newTrack);
    state.camEnabled = true;
    $("localVideo").srcObject = state.localStream;
    $("camOffMsg").classList.add("hidden");
    await loadDeviceList();
    updateControls();
    setStatus("Camara activada.", "success");
  } catch (err) {
    setStatus("Camara no disponible o apagada.", "error");
    updateControls();
  }
}

async function changeMicrophone(deviceId) {
  state.microphoneId = deviceId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    const [newTrack] = stream.getAudioTracks();
    if (!newTrack) throw new Error("Microfono no disponible.");
    ensureEditableLocalStream();
    replaceLocalTrack("audio", newTrack);
    await replacePeerTrack("audio", newTrack);
    state.micEnabled = true;
    await loadDeviceList();
    updateControls();
    setStatus("Microfono activado.", "success");
  } catch (err) {
    setStatus("Microfono no disponible o silenciado.", "error");
    updateControls();
  }
}

function ensureEditableLocalStream() {
  if (!state.localStream) {
    state.localStream = new MediaStream();
    $("localVideo").srcObject = state.localStream;
  }
  return state.localStream;
}

function replaceLocalTrack(kind, newTrack) {
  state.localStream.getTracks()
    .filter(track => track.kind === kind)
    .forEach(track => {
      state.localStream.removeTrack(track);
      track.stop();
    });
  state.localStream.addTrack(newTrack);
}

async function replacePeerTrack(kind, newTrack) {
  if (!state.peer) return;

  let sender = state.peer.getSenders().find(item => item.track?.kind === kind);
  if (!sender) {
    const transceiver = state.peer.getTransceivers().find(item => {
      return item.sender && (item.sender.track?.kind === kind || item.receiver?.track?.kind === kind);
    });
    sender = transceiver?.sender;
  }

  if (sender) await sender.replaceTrack(newTrack);
  else state.peer.addTrack(newTrack, state.localStream);
}

async function changeSpeaker(deviceId) {
  state.speakerId = deviceId;
  await applySpeakerOutput(true);
}

async function applySpeakerOutput(showFeedback = false) {
  const remoteVideo = $("remoteVideo");
  if (!remoteVideo || typeof remoteVideo.setSinkId !== "function") return;

  try {
    await remoteVideo.setSinkId(state.speakerId);
    if (showFeedback) setStatus("Salida de audio actualizada.", "success");
  } catch (err) {
    if (showFeedback) setStatus("No se pudo cambiar la salida de audio.", "error");
  }
}

function playRemoteMedia() {
  const remoteVideo = $("remoteVideo");
  if (!remoteVideo) return;

  remoteVideo.muted = false;
  remoteVideo.volume = 1;
  remoteVideo.play()
    .then(() => {
      $("enableRemoteAudioButton")?.classList.add("hidden");
    })
    .catch(err => {
      debugRtc("remote-play-blocked", { message: err.message });
      $("enableRemoteAudioButton")?.classList.remove("hidden");
      setStatus("Pulsa Activar audio remoto si no escuchas a la otra persona.", "info");
    });
}

function enableRemoteAudio() {
  const remoteVideo = $("remoteVideo");
  if (!remoteVideo) return;

  remoteVideo.muted = false;
  remoteVideo.volume = 1;
  remoteVideo.play()
    .then(() => {
      $("enableRemoteAudioButton")?.classList.add("hidden");
      setStatus("Audio remoto activado.", "success");
    })
    .catch(() => {
      setStatus("El navegador no permitio reproducir el audio remoto todavia.", "error");
    });
}

function toggleSettingsPanel() {
  $("settingsPanel").classList.toggle("hidden");
}

function closeSettingsPanel() {
  $("settingsPanel").classList.add("hidden");
}

function toggleMic() {
  if (!state.localStream?.getAudioTracks().length) return activateMicrophone();
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(track => { track.enabled = state.micEnabled; });
  updateControls();
}

function toggleCam() {
  if (!state.localStream?.getVideoTracks().length) return activateCamera();
  state.camEnabled = !state.camEnabled;
  state.localStream.getVideoTracks().forEach(track => { track.enabled = state.camEnabled; });
  $("camOffMsg").classList.toggle("hidden", state.camEnabled);
  updateControls();
}

function updateControls() {
  const hasMic = Boolean(state.localStream?.getAudioTracks().length);
  const hasCam = Boolean(state.localStream?.getVideoTracks().length);
  const micActive = hasMic && state.micEnabled;
  const camActive = hasCam && state.camEnabled;

  $("btnMic")?.classList.toggle("muted-state", !micActive);
  $("btnMic")?.classList.toggle("active", micActive);
  $("btnCam")?.classList.toggle("muted-state", !camActive);
  $("btnCam")?.classList.toggle("active", camActive);
  if ($("micLabel")) $("micLabel").textContent = hasMic ? (state.micEnabled ? "Micro activo" : "Micro silenciado") : "Microfono no disponible o silenciado";
  if ($("camLabel")) $("camLabel").textContent = hasCam ? (state.camEnabled ? "Camara activa" : "Camara apagada") : "Camara no disponible o apagada";
}

function leaveRoom() {
  closeSettingsPanel();
  send("leave-room");
  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.remoteStream = null;
  state.pendingIceCandidates = [];
  state.roomId = "";
  state.roomName = "";
  state.role = "";
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  $("enableRemoteAudioButton")?.classList.add("hidden");
  $("waitingPanel").classList.remove("hidden");
  showScreen("menuScreen");
}

function resetRemoteMedia() {
  closePeer();
  state.pendingIceCandidates = [];
  $("remoteVideo").srcObject = null;
  $("enableRemoteAudioButton")?.classList.add("hidden");
  $("waitingPanel").classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function debugRtc(event, data = {}) {
  console.log(`[LaFeria WebRTC] ${event}`, data);
}

window.addEventListener("beforeunload", () => {
  send("leave-room");
  state.localStream?.getTracks().forEach(track => track.stop());
  closePeer();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", loadDeviceList);
}

updateProfileBadge();
