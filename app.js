// La Feria - GitHub Pages + servidor de senalizacion WebSocket.
// Cambia esta constante por tu servidor real cuando publiques la web.
// Local:   "ws://localhost:3000/ws"
// Publico: "wss://mi-dominio/ws"
const SIGNALING_SERVER_URL = "ws://localhost:3000/ws";

// STUN ayuda a conectar navegadores en redes distintas.
// STUN no crea salas.
// STUN no retransmite video/audio.
// STUN no sustituye el WebSocket de senalizacion.
// Si una red es muy restrictiva puede hacer falta TURN.
// Esta version no usa TURN de pago por defecto.
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
  ],
};

const state = {
  profile: localStorage.getItem("la_feria_profile") || "",
  role: "",
  roomId: "",
  inviteLink: "",
  ws: null,
  peer: null,
  localStream: null,
  remoteStream: null,
  pendingCandidates: [],
  micEnabled: true,
  camEnabled: true,
  isLeaving: false,
  hasRemoteDescription: false,
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

function showJoinScreen(roomId = "") {
  const normalized = normalizeRoomId(roomId);
  $("roomCodeInput").value = normalized;
  $("joinTitle").textContent = normalized ? "INVITACION A LLAMADA" : "UNIRSE A LLAMADA";
  $("joinHint").textContent = normalized
    ? `Has recibido una invitacion para la sala ${normalized}. Pulsa aceptar para activar camara y microfono.`
    : "Introduce el codigo corto de sala o abre el enlace de invitacion que te enviaron.";
  showScreen("joinScreen");
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
  if (state.profile) return state.profile;
  return state.role === "creator" ? "Creador" : "Invitado";
}

function getRtcConfig() {
  const checkbox = state.role === "guest" ? $("joinUsePublicStun") : $("usePublicStun");
  return checkbox?.checked ? RTC_CONFIG : { iceServers: [] };
}

function normalizeRoomId(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function mediaErrorMessage(err) {
  const name = err?.name || "";

  if (!window.isSecureContext) {
    return "La camara y el microfono requieren HTTPS. GitHub Pages usa HTTPS; en local usa localhost.";
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permisos de camara/microfono denegados.";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se encontro camara o microfono disponible.";
  }

  if (name === "NotReadableError") {
    return "La camara o el microfono estan siendo usados por otra aplicacion.";
  }

  return "No se pudo acceder a camara/microfono. Revisa permisos y vuelve a intentarlo.";
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no soporta getUserMedia.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  state.localStream = stream;
  state.micEnabled = stream.getAudioTracks().some(track => track.enabled);
  state.camEnabled = stream.getVideoTracks().some(track => track.enabled);
  $("localVideo").srcObject = stream;
  updateControls();
  return stream;
}

function createPeerConnection() {
  closePeer();

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peer = pc;
  state.remoteStream = new MediaStream();
  state.pendingCandidates = [];
  state.hasRemoteDescription = false;
  $("remoteVideo").srcObject = state.remoteStream;

  pc.onicecandidate = event => {
    if (event.candidate) {
      sendSignal("ice-candidate", { candidate: event.candidate.toJSON() });
    }
  };

  pc.ontrack = event => {
    event.streams[0]?.getTracks().forEach(track => {
      if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    });
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

    if (pc.connectionState === "failed") {
      setStatus("No se pudo establecer WebRTC. Prueba otra red o activa STUN.", "error");
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      setStatus("No se pudo establecer WebRTC. Prueba otra red o activa STUN.", "error");
    }
  };

  state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
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
  state.pendingCandidates = [];
  state.hasRemoteDescription = false;
}

function prepareCallScreen(role) {
  state.role = role;
  state.isLeaving = false;
  $("localNameLabel").textContent = getDisplayName();
  $("remoteNameLabel").textContent = "Otra persona";
  $("remoteVideo").srcObject = null;
  $("waitingPanel").classList.remove("hidden");
  $("invitePanel").classList.toggle("hidden", role !== "creator");
  $("roomCodeDisplay").textContent = "----";
  $("inviteLink").value = "";
  showScreen("roomScreen");
}

function resolveSignalingUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawUrl = params.get("server") || SIGNALING_SERVER_URL;
  const url = new URL(rawUrl, window.location.href);

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("La URL del servidor de salas debe empezar por ws:// o wss://.");
  }

  return url.href;
}

function connectSignaling() {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve(state.ws);

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = resolveSignalingUrl();
    } catch (err) {
      reject(err);
      return;
    }

    const ws = new WebSocket(url);
    state.ws = ws;

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("No se pudo conectar con el servidor de salas."));
    }, 8000);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(ws);
    };

    ws.onmessage = event => {
      handleSignalingMessage(event.data).catch(() => {
        setStatus("Mensaje de senalizacion invalido.", "error");
      });
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error("No se pudo conectar con el servidor de salas."));
      }
    };

    ws.onclose = () => {
      clearTimeout(timeoutId);
      if (state.ws === ws) state.ws = null;
      if (!state.isLeaving && state.roomId) {
        setStatus("Modo automatico no disponible. El servidor de salas no esta conectado.", "error");
      }
    };
  });
}

function sendSignal(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setStatus("Modo automatico no disponible. El servidor de salas no esta conectado.", "error");
    return false;
  }

  state.ws.send(JSON.stringify({
    type,
    roomId: state.roomId,
    name: getDisplayName(),
    ...payload,
  }));
  return true;
}

async function createRoom() {
  clearMsg("createMsg");
  prepareCallScreen("creator");
  setStatus("Conectando con el servidor de salas...", "info");

  try {
    await connectSignaling();
    sendSignal("create-room");
  } catch (err) {
    setStatus(err.message || "No se pudo conectar con el servidor de salas.", "error");
    showMsg("createMsg", "error", "Modo automatico no disponible. El servidor de salas no esta conectado.");
  }
}

async function acceptCall() {
  clearMsg("joinMsg");
  const roomId = normalizeRoomId($("roomCodeInput").value);

  if (!roomId) {
    showMsg("joinMsg", "error", "Introduce un codigo de sala.");
    return;
  }

  prepareCallScreen("guest");
  state.roomId = roomId;
  $("roomCodeDisplay").textContent = roomId;
  setStatus("Solicitando permisos de camara y microfono...", "info");

  try {
    await ensureLocalMedia();
  } catch (err) {
    setStatus(mediaErrorMessage(err), "error");
    return;
  }

  try {
    setStatus("Conectando con el servidor de salas...", "info");
    await connectSignaling();
    sendSignal("join", { roomId });
  } catch (err) {
    setStatus(err.message || "No se pudo conectar con el servidor de salas.", "error");
  }
}

async function handleSignalingMessage(raw) {
  const msg = JSON.parse(raw);

  if (msg.type === "created") {
    await handleRoomCreated(msg);
    return;
  }

  if (msg.type === "joined") {
    state.role = msg.role || state.role;
    state.roomId = msg.roomId || state.roomId;
    $("roomCodeDisplay").textContent = state.roomId;
    setStatus("Esperando a la otra persona...", "info");
    return;
  }

  if (msg.type === "ready") {
    setRemoteName(msg.peerName);
    setStatus("Hay dos personas en la sala. Conectando...", "info");
    if (state.role === "creator") await startCreatorOffer();
    return;
  }

  if (msg.type === "offer") {
    await handleOffer(msg);
    return;
  }

  if (msg.type === "answer") {
    await handleAnswer(msg);
    return;
  }

  if (msg.type === "ice-candidate") {
    await handleRemoteCandidate(msg.candidate);
    return;
  }

  if (msg.type === "leave") {
    setStatus("La otra persona salio de la llamada.", "error");
    $("waitingPanel").classList.remove("hidden");
    closePeer();
    return;
  }

  if (msg.type === "error") {
    handleServerError(msg);
  }
}

async function handleRoomCreated(msg) {
  state.roomId = normalizeRoomId(msg.roomId);
  $("roomCodeDisplay").textContent = state.roomId;
  state.inviteLink = buildInvitationLink(state.roomId);
  $("inviteLink").value = state.inviteLink;
  $("invitePanel").classList.remove("hidden");
  setStatus("Sala creada. Copia la invitacion y espera en la sala.", "success");

  try {
    await ensureLocalMedia();
    setStatus("Sala lista. Esperando a la otra persona...", "info");
  } catch (err) {
    setStatus(mediaErrorMessage(err), "error");
    sendSignal("leave");
    state.isLeaving = true;
    state.ws?.close(1000, "media denied");
    state.roomId = "";
    state.inviteLink = "";
    $("invitePanel").classList.add("hidden");
  }
}

function buildInvitationLink(roomId) {
  const current = new URL(window.location.href);
  current.searchParams.set("room", roomId);

  const serverOverride = new URLSearchParams(window.location.search).get("server");
  if (serverOverride) current.searchParams.set("server", serverOverride);

  return current.href;
}

async function startCreatorOffer() {
  try {
    await ensureLocalMedia();
    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal("offer", { description: pc.localDescription });
    setStatus("Oferta enviada. Esperando respuesta...", "info");
  } catch (err) {
    setStatus(mediaErrorMessage(err), "error");
  }
}

async function handleOffer(msg) {
  try {
    setRemoteName(msg.name);
    await ensureLocalMedia();
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(msg.description));
    state.hasRemoteDescription = true;
    await flushPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal("answer", { description: pc.localDescription });
    setStatus("Respuesta enviada. Conectando WebRTC...", "info");
  } catch (err) {
    setStatus(mediaErrorMessage(err), "error");
  }
}

async function handleAnswer(msg) {
  if (!state.peer) return;

  try {
    setRemoteName(msg.name);
    await state.peer.setRemoteDescription(new RTCSessionDescription(msg.description));
    state.hasRemoteDescription = true;
    await flushPendingCandidates();
    setStatus("Respuesta recibida. Conectando WebRTC...", "info");
  } catch (err) {
    setStatus("No se pudo establecer WebRTC. Prueba otra red o activa STUN.", "error");
  }
}

async function handleRemoteCandidate(candidate) {
  if (!candidate || !state.peer) return;

  if (!state.hasRemoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }

  try {
    await state.peer.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    setStatus("No se pudo establecer WebRTC. Prueba otra red o activa STUN.", "error");
  }
}

async function flushPendingCandidates() {
  if (!state.peer || !state.hasRemoteDescription) return;

  const candidates = state.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await state.peer.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function handleServerError(msg) {
  const messages = {
    "room-not-found": "La sala no existe o ha caducado.",
    "room-full": "La sala ya esta llena.",
    "invalid-message": "Mensaje de sala invalido.",
    "server-unavailable": "No se pudo conectar con el servidor de salas.",
  };
  setStatus(messages[msg.code] || msg.message || "Error del servidor de salas.", "error");
}

function setRemoteName(name) {
  if (name) $("remoteNameLabel").textContent = name;
}

async function copyInvitation() {
  const value = $("inviteLink")?.value.trim();
  if (!value) {
    setStatus("Todavia no hay invitacion para copiar.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus("Invitacion copiada.", "success");
  } catch (err) {
    $("inviteLink").focus();
    $("inviteLink").select();
    document.execCommand("copy");
    setStatus("Invitacion seleccionada. Si no se copio, pulsa Ctrl+C.", "info");
  }
}

function toggleMic() {
  state.micEnabled = !state.micEnabled;
  state.localStream?.getAudioTracks().forEach(track => { track.enabled = state.micEnabled; });
  updateControls();
}

function toggleCam() {
  state.camEnabled = !state.camEnabled;
  state.localStream?.getVideoTracks().forEach(track => { track.enabled = state.camEnabled; });
  $("camOffMsg").classList.toggle("hidden", state.camEnabled);
  updateControls();
}

function updateControls() {
  $("micLabel").textContent = state.micEnabled ? "Micro activo" : "Micro silenciado";
  $("camLabel").textContent = state.camEnabled ? "Camara activa" : "Camara apagada";
  $("btnMic").classList.toggle("muted-state", !state.micEnabled);
  $("btnCam").classList.toggle("muted-state", !state.camEnabled);
}

function toggleSettingsPanel() {
  $("settingsPanel").classList.toggle("hidden");
}

function closeSettingsPanel() {
  $("settingsPanel").classList.add("hidden");
}

function leaveRoom() {
  state.isLeaving = true;
  if (state.ws?.readyState === WebSocket.OPEN) {
    sendSignal("leave");
    state.ws.close(1000, "leave");
  }

  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.role = "";
  state.roomId = "";
  state.inviteLink = "";

  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  $("inviteLink").value = "";
  $("roomCodeDisplay").textContent = "----";
  $("camOffMsg").classList.add("hidden");
  closeSettingsPanel();
  removeRoomFromUrl();
  showScreen("menuScreen");
}

function removeRoomFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("room")) return;
  url.searchParams.delete("room");
  window.history.replaceState({}, "", url.href);
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeSettingsPanel();
});

$("roomCodeInput")?.addEventListener("input", event => {
  event.target.value = normalizeRoomId(event.target.value);
});

window.addEventListener("beforeunload", () => {
  if (state.ws?.readyState === WebSocket.OPEN) {
    sendSignal("leave");
  }
});

updateProfileBadge();

const initialRoomId = new URLSearchParams(window.location.search).get("room");
if (initialRoomId) {
  showJoinScreen(initialRoomId);
}
