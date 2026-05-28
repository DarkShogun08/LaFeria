// La Feria - version estatica para GitHub Pages.
// No usa backend, WebSocket, Firebase, Supabase, claves API ni servicios de pago.
// La senalizacion WebRTC se hace con enlace de invitacion + respuesta de aceptacion.

const SIGNAL_PREFIX = "LF1";
const SIGNAL_COMPRESSED_PREFIX = "LF1C";
const PUBLIC_STUN_SERVER = "stun:stun.l.google.com:19302";

const state = {
  profile: localStorage.getItem("la_feria_profile") || "",
  role: "",
  peer: null,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  camEnabled: true,
  pendingInviteCode: "",
  cameraId: "",
  microphoneId: "",
  speakerId: "",
  videoDevices: [],
  audioDevices: [],
  speakerDevices: [],
};

function $(id) {
  return document.getElementById(id);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.add("hidden"));
  $(id)?.classList.remove("hidden");

  if (id === "profileScreen") {
    $("profileInput").value = state.profile;
  }
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
  if (!value) {
    showMsg("profileMsg", "error", "El nombre no puede estar vacio.");
    return;
  }

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
  // STUN ayuda a descubrir rutas entre redes distintas.
  // STUN no crea salas, no sustituye la senalizacion y no retransmite audio/video.
  // Sin TURN, WebRTC puede fallar en redes restrictivas. Esta app no usa TURN de pago.
  return usePublicStun()
    ? { iceServers: [{ urls: PUBLIC_STUN_SERVER }] }
    : { iceServers: [] };
}

function mediaErrorMessage(err) {
  const name = err?.name || "";

  if (!window.isSecureContext) {
    return "Camara y microfono requieren HTTPS. GitHub Pages usa HTTPS; en local usa localhost.";
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Has denegado permisos de camara o microfono. Activalos desde el navegador.";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se encontro camara o microfono disponible.";
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return "La camara o el microfono parecen estar siendo usados por otra aplicacion.";
  }

  return "No se pudo acceder a camara/microfono. Revisa permisos y vuelve a intentarlo.";
}

function friendlyErrorMessage(err) {
  if (err?.name) return mediaErrorMessage(err);
  return err?.message || "Ha ocurrido un error inesperado.";
}

async function ensureLocalMedia() {
  return tryStartLocalMedia();
}

async function tryStartLocalMedia() {
  if (state.localStream?.getTracks().length) return state.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    setLocalStream(null);
    showSoftDeviceWarning("Este navegador no permite usar camara/microfono, pero puedes continuar sin dispositivos.");
    return null;
  }

  const attempts = [
    {
      constraints: {
        video: state.cameraId ? { deviceId: { exact: state.cameraId } } : true,
        audio: state.microphoneId ? { deviceId: { exact: state.microphoneId } } : true,
      },
      message: "",
    },
    {
      constraints: { video: state.cameraId ? { deviceId: { exact: state.cameraId } } : true, audio: false },
      message: "Microfono no disponible. Puedes continuar sin microfono.",
    },
    {
      constraints: { video: false, audio: state.microphoneId ? { deviceId: { exact: state.microphoneId } } : true },
      message: "Camara no disponible. Puedes continuar sin camara.",
    },
  ];

  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      setLocalStream(stream);
      await loadDeviceList();
      if (attempt.message) showSoftDeviceWarning(attempt.message);
      return stream;
    } catch (err) {
      // Seguimos probando combinaciones mas pequenas. La sala no depende de esto.
    }
  }

  setLocalStream(null);
  await loadDeviceList();
  showSoftDeviceWarning("No se pudo acceder a camara ni microfono. La sala se creara igualmente; podras escuchar/ver si la otra persona comparte.");
  return null;
}

function showSoftDeviceWarning(text) {
  if (state.role === "creator") {
    showMsg("createMsg", "success", text);
  } else if (state.role === "guest") {
    showMsg("joinMsg", "success", text);
  }
  setStatus(text, "info");
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
      const item = {
        id: device.deviceId,
        label: device.label || fallbackDeviceLabel(device.kind, counts[device.kind]),
      };

      if (device.kind === "videoinput") state.videoDevices.push(item);
      if (device.kind === "audioinput") state.audioDevices.push(item);
      if (device.kind === "audiooutput") state.speakerDevices.push(item);
    });

    fillDeviceSelect(cameraSelect, state.videoDevices, "Camara predeterminada", state.cameraId);
    fillDeviceSelect(microphoneSelect, state.audioDevices, "Microfono predeterminado", state.microphoneId);

    const canChooseSpeaker = typeof $("remoteVideo")?.setSinkId === "function";
    speakerGroup?.classList.toggle("hidden", !canChooseSpeaker);
    if (canChooseSpeaker) {
      fillDeviceSelect(speakerSelect, state.speakerDevices, "Salida del sistema", state.speakerId);
    }
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
  if (selectedId && devices.some(device => device.id === selectedId)) {
    select.value = selectedId;
  }
}

function prepareCallScreen(role) {
  state.role = role;
  $("localNameLabel").textContent = getDisplayName();
  $("remoteNameLabel").textContent = "Otra persona";
  $("remoteVideo").srcObject = null;
  $("waitingPanel").classList.remove("hidden");
  $("camOffMsg").textContent = state.camEnabled ? "Camara activa" : "Camara apagada o no disponible.";
  $("camOffMsg").classList.toggle("hidden", state.camEnabled);
  $("invitePanel").classList.toggle("hidden", role !== "creator");
  $("creatorAnswerPanel").classList.toggle("hidden", role !== "creator");
  $("answerPanel").classList.toggle("hidden", role !== "guest");
  $("inviteLink").value = "";
  $("answerCode").value = "";
  $("creatorAnswerCode").value = "";
  clearMsg("roomMsg");
  showScreen("roomScreen");
  loadDeviceList();
}

function createPeerConnection() {
  closePeer();

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peer = pc;
  state.remoteStream = new MediaStream();
  $("remoteVideo").srcObject = state.remoteStream;

  pc.onicecandidate = () => {
    // Trickle ICE esta desactivado en la practica: esperamos a que ICE termine
    // y metemos los candidatos dentro de la invitacion/respuesta.
  };

  pc.ontrack = event => {
    event.streams[0]?.getTracks().forEach(track => {
      if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    });
    applySpeakerOutput(false);
    $("waitingPanel").classList.add("hidden");
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connecting") {
      setStatus("Conectando WebRTC...", "info");
    }

    if (pc.connectionState === "connected") {
      setStatus("Llamada conectada.", "success");
      $("waitingPanel").classList.add("hidden");
    }

    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      setStatus("No se pudo mantener WebRTC. Prueba STUN o una red menos restrictiva.", "error");
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      setStatus("No se pudo establecer WebRTC. Sin TURN algunas redes no conectan.", "error");
    }
  };

  const audioTrack = state.localStream?.getAudioTracks()[0];
  const videoTrack = state.localStream?.getVideoTracks()[0];

  if (audioTrack) {
    pc.addTrack(audioTrack, state.localStream);
  } else {
    pc.addTransceiver("audio", { direction: "sendrecv" });
  }

  if (videoTrack) {
    pc.addTrack(videoTrack, state.localStream);
  } else {
    pc.addTransceiver("video", { direction: "sendrecv" });
  }

  return pc;
}

function closePeer() {
  if (state.peer) {
    state.peer.onicecandidate = null;
    state.peer.ontrack = null;
    state.peer.onconnectionstatechange = null;
    state.peer.oniceconnectionstatechange = null;
    state.peer.close();
  }
  state.peer = null;
  state.remoteStream = null;
}

async function createRoom() {
  clearMsg("createMsg");
  state.role = "creator";
  const createButton = $("createRoomButton");

  try {
    if (createButton) {
      createButton.disabled = true;
      createButton.textContent = "Creando sala...";
    }
    showMsg("createMsg", "success", "Preparando invitacion...");
    prepareCallScreen("creator");
    setStatus("Intentando activar camara y microfono...", "info");
    await tryStartLocalMedia();
    prepareCallScreen("creator");
    setStatus("Generando conexion, espera unos segundos...", "info");

    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const inviteCode = await encodeSignal({
      kind: "invite",
      name: getDisplayName(),
      createdAt: Date.now(),
      usesPublicStun: usePublicStun(),
      description: pc.localDescription,
    });

    const link = buildInviteLink(inviteCode);
    $("inviteLink").value = link;
    $("invitePanel").classList.remove("hidden");
    setStatus("Invitacion generada. Copia este enlace y mandaselo a la otra persona.", "success");
  } catch (err) {
    const message = friendlyErrorMessage(err);
    showMsg("createMsg", "error", message);
    setStatus(message, "error");
  } finally {
    if (createButton) {
      createButton.disabled = false;
      createButton.textContent = "Crear sala";
    }
  }
}

function buildInviteLink(inviteCode) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";

  // Respeta rutas de repositorio como /LaFeria/. Si se abre /LaFeria/index.html,
  // deja el enlace limpio en /LaFeria/#invite=...
  url.pathname = url.pathname.replace(/index\.html$/i, "");
  url.hash = `invite=${encodeURIComponent(inviteCode)}`;
  return url.toString();
}

function showJoinScreen() {
  $("incomingInviteCode").value = state.pendingInviteCode || "";
  $("joinTitle").textContent = state.pendingInviteCode ? "INVITACION DETECTADA" : "UNIRSE A LLAMADA";
  $("joinHint").textContent = state.pendingInviteCode
    ? "Invitacion detectada. Pulsa aceptar llamada para generar tu respuesta de aceptacion."
    : "Pega aqui el enlace o codigo de invitacion que te mandaron.";
  clearMsg("joinMsg");
  if (state.pendingInviteCode) {
    showMsg("joinMsg", "success", "Invitacion detectada. Pulsa aceptar llamada.");
  }
  showScreen("joinScreen");
}

async function acceptCall() {
  clearMsg("joinMsg");
  state.role = "guest";

  try {
    const inviteCode = extractInviteCode($("incomingInviteCode").value || state.pendingInviteCode);
    if (!inviteCode) throw new Error("Codigo de invitacion no valido o incompleto.");

    const invite = await decodeSignal(inviteCode);
    if (invite.kind !== "invite" || !invite.description?.sdp) {
      throw new Error("Codigo de invitacion no valido o incompleto.");
    }

    showMsg("joinMsg", "success", "Preparando respuesta de aceptacion...");
    prepareCallScreen("guest");
    $("remoteNameLabel").textContent = invite.name || "Creador";
    setStatus("Intentando activar camara y microfono...", "info");
    await tryStartLocalMedia();
    $("remoteNameLabel").textContent = invite.name || "Creador";
    setStatus("Generando respuesta de aceptacion...", "info");

    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(invite.description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const answerCode = await encodeSignal({
      kind: "answer",
      name: getDisplayName(),
      createdAt: Date.now(),
      usesPublicStun: usePublicStun(),
      description: pc.localDescription,
    });

    $("answerCode").value = answerCode;
    $("answerPanel").classList.remove("hidden");
    setStatus("Respuesta generada. Devuelvesela al creador para completar la conexion.", "success");
  } catch (err) {
    const message = friendlyErrorMessage(err);
    showMsg("joinMsg", "error", message);
    setStatus(message, "error");
  }
}

async function completeConnection() {
  clearMsg("roomMsg");

  try {
    if (!state.peer) throw new Error("Primero crea una invitacion.");

    const answerCode = extractInviteCode($("creatorAnswerCode").value);
    if (!answerCode) throw new Error("Pega la respuesta de aceptacion completa.");

    const answer = await decodeSignal(answerCode);
    if (answer.kind !== "answer" || !answer.description?.sdp) {
      throw new Error("Respuesta de aceptacion no valida o incompleta.");
    }

    $("remoteNameLabel").textContent = answer.name || "Otra persona";
    await state.peer.setRemoteDescription(new RTCSessionDescription(answer.description));
    setStatus("Respuesta aplicada. Conectando WebRTC...", "info");
    showMsg("roomMsg", "success", "Respuesta aplicada. La llamada deberia conectar en unos segundos.");
  } catch (err) {
    showMsg("roomMsg", "error", err.message || "No se pudo aplicar la respuesta.");
  }
}

function extractInviteCode(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    const url = new URL(text);
    const hashInvite = new URLSearchParams(url.hash.replace(/^#/, "")).get("invite");
    const queryInvite = url.searchParams.get("invite");
    return hashInvite || queryInvite || "";
  } catch (err) {
    if (text.startsWith("#invite=")) {
      return new URLSearchParams(text.replace(/^#/, "")).get("invite") || "";
    }
    return text;
  }
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();

  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };

    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(finish, 9000);
  });
}

async function encodeSignal(data) {
  const json = JSON.stringify(data);

  if ("CompressionStream" in window) {
    try {
      const compressed = await compressText(json);
      return `${SIGNAL_COMPRESSED_PREFIX}.${bytesToBase64Url(compressed)}`;
    } catch (err) {
      // Si la compresion falla, caemos a texto normal codificado.
    }
  }

  return `${SIGNAL_PREFIX}.${bytesToBase64Url(new TextEncoder().encode(json))}`;
}

async function decodeSignal(code) {
  const clean = String(code || "").trim();
  const [prefix, payload] = clean.split(".", 2);
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
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressText(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("Tu navegador no puede leer este codigo comprimido. Pide a la otra persona que genere el enlace desde un navegador compatible.");
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function copyInvitation() {
  await copyTextFromInput("inviteLink", "Invitacion copiada. Mandasela a la otra persona.");
}

async function copyAnswer() {
  await copyTextFromInput("answerCode", "Respuesta copiada. Devuelvesela al creador.");
}

async function copyTextFromInput(id, successText) {
  const input = $(id);
  const value = input?.value.trim();
  if (!value) {
    showMsg("roomMsg", "error", "Todavia no hay nada para copiar.");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    showMsg("roomMsg", "success", successText);
  } catch (err) {
    input.focus();
    input.select();
    document.execCommand("copy");
    showMsg("roomMsg", "success", successText);
  }
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
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Este navegador no permite usar camara/microfono.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    });
    const [newTrack] = stream.getVideoTracks();
    if (!newTrack) throw new Error("Camara no disponible. Puedes continuar sin camara.");

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
    state.camEnabled = Boolean(state.localStream?.getVideoTracks().length);
    updateControls();
    setStatus("Camara no disponible. Puedes continuar sin camara.", "error");
  }
}

async function changeMicrophone(deviceId) {
  state.microphoneId = deviceId;

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Este navegador no permite usar camara/microfono.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    const [newTrack] = stream.getAudioTracks();
    if (!newTrack) throw new Error("Microfono no disponible. Puedes continuar sin microfono.");

    ensureEditableLocalStream();
    replaceLocalTrack("audio", newTrack);
    await replacePeerTrack("audio", newTrack);
    state.micEnabled = true;
    await loadDeviceList();
    updateControls();
    setStatus("Microfono activado.", "success");
  } catch (err) {
    state.micEnabled = Boolean(state.localStream?.getAudioTracks().length);
    updateControls();
    setStatus("Microfono no disponible. Puedes continuar sin microfono.", "error");
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
  const oldTracks = state.localStream.getTracks().filter(track => track.kind === kind);
  oldTracks.forEach(track => {
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

  if (sender) {
    await sender.replaceTrack(newTrack);
  } else {
    state.peer.addTrack(newTrack, state.localStream);
  }
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
    if (showFeedback) setStatus("No se pudo cambiar la salida de audio en este navegador.", "error");
  }
}

function toggleSettingsPanel() {
  $("settingsPanel").classList.toggle("hidden");
}

function closeSettingsPanel() {
  $("settingsPanel").classList.add("hidden");
}

function toggleMic() {
  if (!state.localStream?.getAudioTracks().length) {
    activateMicrophone();
    return;
  }
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(track => { track.enabled = state.micEnabled; });
  updateControls();
}

function toggleCam() {
  if (!state.localStream?.getVideoTracks().length) {
    activateCamera();
    return;
  }
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
  if ($("micLabel")) $("micLabel").textContent = hasMic ? (state.micEnabled ? "Micro activo" : "Micro silenciado") : "Micro no disponible";
  if ($("camLabel")) $("camLabel").textContent = hasCam ? (state.camEnabled ? "Camara activa" : "Camara apagada") : "Camara no disponible";
}

function leaveRoom() {
  closeSettingsPanel();
  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.remoteStream = null;
  state.role = "";
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  $("waitingPanel").classList.remove("hidden");
  showScreen("menuScreen");
}

function readInviteFromUrl() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const invite = params.get("invite") || new URLSearchParams(window.location.search).get("invite") || "";
  if (!invite) return;

  state.pendingInviteCode = invite;
  showJoinScreen();
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
