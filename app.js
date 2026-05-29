// La Feria - version estatica para GitHub Pages.
// No usa backend ni rutas de senalizacion. La senalizacion se copia y pega.
const SIGNAL_PREFIX = "LF1";
const SIGNAL_COMPRESSED_PREFIX = "LF1C";
const PUBLIC_STUN_SERVER = "stun:stun.l.google.com:19302";

const state = {
  profile: localStorage.getItem("la_feria_profile") || "",
  role: "",
  roomName: "",
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
  pendingInviteCode: "",
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

function currentMessageBox() {
  if (!$("createScreen")?.classList.contains("hidden")) return "createMsg";
  if (!$("joinScreen")?.classList.contains("hidden")) return "joinMsg";
  if (!$("roomScreen")?.classList.contains("hidden")) return "roomMsg";
  return "createMsg";
}

function usePublicStun() {
  const box = state.role === "guest" ? $("joinUsePublicStun") : $("usePublicStun");
  return Boolean(box?.checked);
}

function getRtcConfig() {
  // STUN es opcional: ayuda a descubrir rutas entre redes distintas.
  // No crea salas, no transporta audio/video y no sustituye un servidor de senalizacion.
  // Esta app no usa TURN de pago; en redes restrictivas puede fallar.
  return usePublicStun()
    ? { iceServers: [{ urls: PUBLIC_STUN_SERVER }] }
    : { iceServers: [] };
}

function showJoinScreen() {
  showScreen("joinScreen");
  if (state.pendingInviteCode) $("inviteInput").value = state.pendingInviteCode;
}

async function createRoom() {
  clearMsg("createMsg");
  const button = $("createRoomButton");
  const roomName = $("createRoomName").value.trim() || "La Feria";

  try {
    button.disabled = true;
    button.textContent = "Creando sala...";
    showMsg("createMsg", "success", "Preparando invitacion...");

    state.role = "creator";
    state.roomName = roomName;
    prepareCallScreen("creator");
    setStatus("Preparando camara/microfono...", "info");
    showScreen("roomScreen");

    await tryStartLocalMedia();
    await loadDeviceList();

    setStatus("Generando conexion, espera unos segundos...", "info");
    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const inviteCode = await encodeSignal({
      type: "invite",
      roomName: state.roomName,
      displayName: getDisplayName(),
      description: pc.localDescription,
      stun: usePublicStun(),
      createdAt: Date.now(),
    });

    const inviteLink = buildInviteLink(inviteCode);
    $("inviteLink").value = inviteLink;
    $("invitePanel").classList.remove("hidden");
    $("creatorAnswerPanel").classList.remove("hidden");
    $("answerPanel").classList.add("hidden");
    setStatus("Invitacion generada. Copiala y espera la respuesta de aceptacion.", "success");
    showMsg("roomMsg", "success", "Invitacion generada. Esta version no usa servidor, asi que la otra persona debe devolverte una respuesta.");
  } catch (err) {
    setStatus("No se pudo crear la invitacion WebRTC.", "error");
    showMsg(currentMessageBox(), "error", err.message || "No se pudo crear la llamada.");
    debugRtc("create-room-error", { message: err.message });
  } finally {
    button.disabled = false;
    button.textContent = "Crear sala";
  }
}

async function acceptCall() {
  clearMsg("joinMsg");
  const button = $("acceptCallButton");

  try {
    button.disabled = true;
    button.textContent = "Aceptando...";
    showMsg("joinMsg", "success", "Leyendo invitacion...");

    const inviteCode = extractSignalCode($("inviteInput").value);
    const invite = await decodeSignal(inviteCode);
    if (invite.type !== "invite" || !invite.description) {
      throw new Error("Codigo de invitacion no valido o incompleto.");
    }

    state.role = "guest";
    state.roomName = invite.roomName || "La Feria";
    prepareCallScreen("guest");
    showScreen("roomScreen");
    setStatus("Preparando camara/microfono...", "info");

    if ($("joinUsePublicStun")) $("joinUsePublicStun").checked = Boolean(invite.stun);
    await tryStartLocalMedia();
    await loadDeviceList();

    setStatus("Conectando WebRTC...", "info");
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(invite.description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const answerCode = await encodeSignal({
      type: "answer",
      roomName: state.roomName,
      displayName: getDisplayName(),
      description: pc.localDescription,
      createdAt: Date.now(),
    });

    $("answerCode").value = answerCode;
    $("answerPanel").classList.remove("hidden");
    $("invitePanel").classList.add("hidden");
    $("creatorAnswerPanel").classList.add("hidden");
    setStatus("Respuesta generada. Devuelvesela al creador para completar la conexion.", "success");
    showMsg("roomMsg", "success", "Respuesta generada. Copiala y mandasela a quien creo la llamada.");
  } catch (err) {
    setStatus("No se pudo aceptar la llamada.", "error");
    showMsg(currentMessageBox(), "error", err.message || "Codigo de invitacion no valido o incompleto.");
    debugRtc("accept-call-error", { message: err.message });
  } finally {
    button.disabled = false;
    button.textContent = "Aceptar sala";
  }
}

async function completeConnection() {
  clearMsg("roomMsg");

  try {
    if (!state.peer) throw new Error("Primero crea una invitacion.");
    const answerCode = extractSignalCode($("creatorAnswerCode").value);
    const answer = await decodeSignal(answerCode);
    if (answer.type !== "answer" || !answer.description) {
      throw new Error("Respuesta de aceptacion no valida o incompleta.");
    }

    setStatus("Aplicando respuesta de aceptacion...", "info");
    await state.peer.setRemoteDescription(new RTCSessionDescription(answer.description));
    setStatus("Conectando WebRTC...", "info");
    showMsg("roomMsg", "success", "Respuesta aplicada. Si la red lo permite, la llamada conectara en unos segundos.");
  } catch (err) {
    setStatus("No se pudo aplicar la respuesta.", "error");
    showMsg("roomMsg", "error", err.message || "No se pudo conectar.");
    debugRtc("complete-connection-error", { message: err.message });
  }
}

function prepareCallScreen(role) {
  closeSettingsPanel();
  closePeer();
  resetSignalPanels();
  state.role = role;
  $("localNameLabel").textContent = getDisplayName();
  $("remoteNameLabel").textContent = "Otra persona";
  $("roomNameTitle").textContent = state.roomName || "La Feria";
  $("remoteVideo").srcObject = null;
  $("enableRemoteAudioButton")?.classList.add("hidden");
  $("waitingPanel").classList.remove("hidden");
  clearMsg("roomMsg");
}

function resetSignalPanels() {
  $("invitePanel")?.classList.add("hidden");
  $("creatorAnswerPanel")?.classList.add("hidden");
  $("answerPanel")?.classList.add("hidden");
  if ($("inviteLink")) $("inviteLink").value = "";
  if ($("creatorAnswerCode")) $("creatorAnswerCode").value = "";
  if ($("answerCode")) $("answerCode").value = "";
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
    { constraints: { video: true, audio: false }, message: "Microfono no disponible o silenciado. Puedes continuar sin microfono." },
    { constraints: { video: false, audio: true }, message: "Camara no disponible o apagada. Puedes continuar sin camara." },
  ];

  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      setLocalStream(stream);
      if (attempt.message) setStatus(attempt.message, "info");
      return stream;
    } catch (err) {
      debugRtc("media-attempt-failed", { constraints: attempt.constraints, name: err.name });
    }
  }

  setLocalStream(null);
  setStatus("Sala creada sin camara/microfono. Puedes activarlos despues desde ajustes.", "info");
  return null;
}

function setLocalStream(stream) {
  if (state.localStream && state.localStream !== stream) {
    state.localStream.getTracks().forEach(track => track.stop());
  }

  state.localStream = stream;
  state.micEnabled = Boolean(stream?.getAudioTracks().length);
  state.camEnabled = Boolean(stream?.getVideoTracks().length);
  state.cameraId = stream?.getVideoTracks()[0]?.getSettings?.().deviceId || state.cameraId || "";
  state.microphoneId = stream?.getAudioTracks()[0]?.getSettings?.().deviceId || state.microphoneId || "";
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

  pc.ontrack = event => {
    const tracks = event.streams[0]?.getTracks().length ? event.streams[0].getTracks() : [event.track];
    tracks.filter(Boolean).forEach(track => {
      if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
        debugRtc("remote-track-received", { kind: track.kind, id: track.id });
      }
    });
    remoteVideo.srcObject = state.remoteStream;
    applySpeakerOutput(false);
    $("waitingPanel").classList.add("hidden");
    playRemoteMedia();
  };

  pc.onicecandidate = event => {
    if (!event.candidate) debugRtc("ice-gathering-complete");
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
    state.peer.onsignalingstatechange = null;
    state.peer.close();
  }
  state.peer = null;
  state.remoteStream = null;
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise(resolve => {
    const timeout = setTimeout(done, 6000);
    function done() {
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
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
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Este navegador no permite activar camara.", "error");
    return;
  }

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
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Este navegador no permite activar microfono.", "error");
    return;
  }

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
  $("settingsPanel")?.classList.add("hidden");
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
  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.remoteStream = null;
  state.roomName = "";
  state.role = "";
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  $("enableRemoteAudioButton")?.classList.add("hidden");
  $("waitingPanel").classList.remove("hidden");
  resetSignalPanels();
  showScreen("menuScreen");
}

async function copyInvite() {
  await copyText($("inviteLink").value, "Invitacion copiada.");
}

async function copyAnswer() {
  await copyText($("answerCode").value, "Respuesta copiada.");
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showMsg("roomMsg", "success", successMessage);
  } catch (err) {
    showMsg("roomMsg", "error", "No se pudo copiar automaticamente. Selecciona el texto y copialo manualmente.");
  }
}

function buildInviteLink(inviteCode) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/index\.html$/i, "");
  url.hash = `invite=${encodeURIComponent(inviteCode)}`;
  return url.toString();
}

function extractSignalCode(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Pega una invitacion o respuesta primero.");

  try {
    const url = new URL(raw);
    const hash = url.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    return params.get("invite") || params.get("answer") || raw;
  } catch (err) {
    const hashIndex = raw.indexOf("#invite=");
    if (hashIndex >= 0) return decodeURIComponent(raw.slice(hashIndex + "#invite=".length));
    return raw;
  }
}

async function encodeSignal(data) {
  const json = JSON.stringify(data);
  if ("CompressionStream" in window) {
    try {
      const compressed = await compressText(json);
      return `${SIGNAL_COMPRESSED_PREFIX}.${bytesToBase64Url(compressed)}`;
    } catch (err) {
      debugRtc("compression-fallback", { message: err.message });
    }
  }
  return `${SIGNAL_PREFIX}.${bytesToBase64Url(new TextEncoder().encode(json))}`;
}

async function decodeSignal(code) {
  const clean = String(code || "").trim();
  const dot = clean.indexOf(".");
  const prefix = dot >= 0 ? clean.slice(0, dot) : "";
  const payload = dot >= 0 ? clean.slice(dot + 1) : "";

  if (!payload || ![SIGNAL_PREFIX, SIGNAL_COMPRESSED_PREFIX].includes(prefix)) {
    throw new Error("Codigo de invitacion no valido o incompleto.");
  }

  const bytes = base64UrlToBytes(payload);
  const json = prefix === SIGNAL_COMPRESSED_PREFIX
    ? await decompressText(bytes)
    : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

async function compressText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressText(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("Este navegador no puede leer invitaciones comprimidas. Pide a la otra persona que use un navegador actualizado.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function readInviteFromUrl() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const invite = params.get("invite");
  if (!invite) return;

  state.pendingInviteCode = invite;
  $("inviteInput").value = invite;
  showJoinScreen();
  showMsg("joinMsg", "success", "Invitacion detectada. Pulsa Aceptar sala.");
}

function debugRtc(event, data = {}) {
  console.log(`[LaFeria WebRTC] ${event}`, data);
}

window.addEventListener("beforeunload", () => {
  state.localStream?.getTracks().forEach(track => track.stop());
  closePeer();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", loadDeviceList);
}

updateProfileBadge();
readInviteFromUrl();
