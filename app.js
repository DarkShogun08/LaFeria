// ════════════════════════════════════════════════════════════════
//  LA FERIA — app.js
//  Salas privadas multijugador · CERO APIs externas
//
//  Tecnologías nativas del navegador usadas:
//  · BroadcastChannel API   → comunicación en tiempo real entre pestañas
//  · RTCPeerConnection      → video/audio P2P (WebRTC estándar)
//  · getUserMedia           → acceso a cámara y micrófono con selector
//  · crypto.subtle          → hash SHA-256 de contraseñas
//  · sessionStorage         → registro de salas activas (local)
//  · localStorage           → persistencia del nombre de perfil
// ════════════════════════════════════════════════════════════════

// ════════════════
//  ESTADO GLOBAL
// ════════════════
function makeLocalId() {
  const browserCrypto = globalThis.crypto;
  if (browserCrypto?.randomUUID) return browserCrypto.randomUUID();

  const randomPart = browserCrypto?.getRandomValues
    ? Array.from(browserCrypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('')
    : Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);

  return `local-${Date.now().toString(16)}-${randomPart}`;
}

function localHashFallback(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x811c9dc5);
  }

  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

const state = {
  profile:      localStorage.getItem('nexus_name') || '',
  currentRoom:  null,        // { name, hash, code }
  channel:      null,        // BroadcastChannel activo
  myId:         makeLocalId(),
  peers:        new Map(),   // peerId → { pc, stream }
  localStream:  null,        // MediaStream de cámara/mic
  videoInputId: '',
  audioInputId: '',
  audioOutputId: '',
  videoInputs: [],
  audioInputs: [],
  audioOutputs: [],
  audioOutputIndex: 0,
  remoteAudioMuted: false,
  localVolume: 1,
  remoteVolume: 1,
  micMonitorEnabled: false,
  micMonitorAudio: null,
  audioContext: null,
  micSource: null,
  micGain: null,
  micDestination: null,
  rawAudioTrack: null,
  processedAudioTrack: null,
  micEnabled:   false,
  camEnabled:   false,
  members:      new Map(),   // peerId → { name, mic, cam, self? }
};

// ════════════════════════════════════════
//  NAVEGACIÓN ENTRE PANTALLAS
// ════════════════════════════════════════
function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(screenId).classList.remove('hidden');

  if (screenId === 'profileScreen') {
    document.getElementById('profileInput').value = state.profile;
  }
}

// ════════════════════════════════════════
//  UTILIDADES
// ════════════════════════════════════════

async function hashPass(pass) {
  if (!globalThis.crypto?.subtle?.digest) {
    return localHashFallback(pass);
  }

  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pass)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function showMsg(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `msg ${type} show`;
  el.textContent = text;
  if (type === 'success') {
    setTimeout(() => el.classList.remove('show'), 3000);
  }
}

function getMediaAccessProblem() {
  if (!window.isSecureContext) {
    return 'El navegador bloquea cámara y micrófono porque esta página se abrió por HTTP en una IP de red. Usa localhost en este equipo o sirve la página por HTTPS para otros dispositivos.';
  }

  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    return 'Este navegador no permite acceder a cámara y micrófono desde esta página.';
  }

  return '';
}

function showMediaAccessProblem(targetId = 'permMsg') {
  const problem = getMediaAccessProblem();
  if (problem) showMsg(targetId, 'error', problem);
  return problem;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════
//  1. PERFIL
// ════════════════════════════════════════
function saveProfile() {
  const val = document.getElementById('profileInput').value.trim();
  if (!val) return showMsg('profileMsg', 'error', 'El nombre no puede estar vacío.');

  state.profile = val;
  localStorage.setItem('nexus_name', val);
  updateProfileBadge();
  showMsg('profileMsg', 'success', '¡Perfil guardado!');
  setTimeout(() => goTo('menuScreen'), 900);
}

function updateProfileBadge() {
  const name = state.profile || 'Sin nombre';
  document.getElementById('profileNameDisplay').textContent = name;
  document.getElementById('avatarDisplay').textContent = name[0]?.toUpperCase() || '?';
}

updateProfileBadge();

// ════════════════════════════════════════
//  2. CREAR SALA
// ════════════════════════════════════════
async function createRoom() {
  if (!state.profile) {
    return showMsg('createMsg', 'error', 'Debes configurar tu perfil primero (opción 1).');
  }

  const name = document.getElementById('createRoomName').value.trim();
  const pass = document.getElementById('createRoomPass').value;

  if (!name) return showMsg('createMsg', 'error', 'Escribe un nombre para la sala.');
  if (pass.length < 4) return showMsg('createMsg', 'error', 'La contraseña debe tener al menos 4 caracteres.');

  const hash = await hashPass(pass);

  const rooms = JSON.parse(sessionStorage.getItem('nexus_rooms') || '{}');
  if (rooms[hash]) {
    return showMsg('createMsg', 'error', 'Ya existe una sala con esa contraseña. Usa una diferente.');
  }

  rooms[hash] = { name, createdAt: Date.now(), creator: state.myId };
  sessionStorage.setItem('nexus_rooms', JSON.stringify(rooms));

  showMsg('createMsg', 'success', `Sala "${name}" creada. Comparte la contraseña.`);
  setTimeout(() => enterRoom(name, hash, pass), 900);
}

// ════════════════════════════════════════
//  3. UNIRSE A UNA SALA
// ════════════════════════════════════════
async function joinRoom() {
  if (!state.profile) {
    return showMsg('joinMsg', 'error', 'Debes configurar tu perfil primero (opción 1).');
  }

  const pass = document.getElementById('joinPass').value;
  if (!pass) return showMsg('joinMsg', 'error', 'Introduce la contraseña.');

  const hash  = await hashPass(pass);
  const rooms = JSON.parse(sessionStorage.getItem('nexus_rooms') || '{}');

  if (!rooms[hash]) {
    return showMsg('joinMsg', 'error', '❌ Sala no encontrada o contraseña incorrecta.');
  }

  enterRoom(rooms[hash].name, hash, pass);
}

// ════════════════════════════════════════
//  FLUJO DE ENTRADA A SALA
// ════════════════════════════════════════
function enterRoom(name, hash, code) {
  state.currentRoom = { name, hash, code };
  // Cargar lista de dispositivos y mostrar overlay
  loadDevices().then(() => {
    document.getElementById('permOverlay').classList.remove('hidden');
  });
}

// ════════════════════════════════════════
//  CARGA DE DISPOSITIVOS DISPONIBLES
//  Solicita permiso genérico primero para que el navegador
//  muestre los nombres reales de los dispositivos.
// ════════════════════════════════════════
async function loadDevices() {
  const accessProblem = getMediaAccessProblem();
  if (accessProblem) {
    showDeviceListFallback();
    showMediaAccessProblem('permMsg');
    showMediaAccessProblem('settingsMsg');
    return;
  }

  const previous = {
    cam: document.getElementById('callSelectCam')?.value || document.getElementById('selectCam')?.value || state.videoInputId,
    mic: document.getElementById('callSelectMic')?.value || document.getElementById('selectMic')?.value || state.audioInputId,
    audio: document.getElementById('callSelectHeadphones')?.value || document.getElementById('selectHeadphones')?.value || state.audioOutputId,
  };

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const counts = { videoinput: 0, audioinput: 0, audiooutput: 0 };

    state.videoInputs = [];
    state.audioInputs = [];
    state.audioOutputs = [];

    devices.forEach((device) => {
      if (!['videoinput', 'audioinput', 'audiooutput'].includes(device.kind)) return;
      counts[device.kind] += 1;

      const item = {
        id: device.deviceId,
        label: device.label || fallbackDeviceName(device.kind, counts[device.kind]),
      };

      if (device.kind === 'videoinput') state.videoInputs.push(item);
      if (device.kind === 'audioinput') state.audioInputs.push(item);
      if (device.kind === 'audiooutput') state.audioOutputs.push(item);
    });

    fillDeviceSelect('selectCam', state.videoInputs, 'Cámara predeterminada', previous.cam);
    fillDeviceSelect('selectMic', state.audioInputs, 'Micrófono predeterminado', previous.mic);
    fillDeviceSelect('selectHeadphones', state.audioOutputs, 'Salida predeterminada', previous.audio, !canChooseAudioOutput());
    fillDeviceSelect('callSelectCam', state.videoInputs, 'Cámara predeterminada', previous.cam);
    fillDeviceSelect('callSelectMic', state.audioInputs, 'Micrófono predeterminado', previous.mic);
    fillDeviceSelect('callSelectHeadphones', state.audioOutputs, 'Salida predeterminada', previous.audio, !canChooseAudioOutput());

    updateAudioOutputSupport();
  } catch (err) {
    showDeviceListFallback();
  }
}

function fallbackDeviceName(kind, index) {
  if (kind === 'videoinput') return `Cámara ${index}`;
  if (kind === 'audioinput') return `Micrófono ${index}`;
  return `Salida de audio ${index}`;
}

function fillDeviceSelect(selectId, devices, defaultLabel, selectedId, disabled = false) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = '';
  select.disabled = disabled;
  select.appendChild(new Option(defaultLabel, ''));

  devices.forEach((device) => {
    select.appendChild(new Option(device.label, device.id));
  });

  if (selectedId && devices.some(device => device.id === selectedId)) {
    select.value = selectedId;
  }
}

function showDeviceListFallback() {
  fillDeviceSelect('selectCam', [], 'Cámara predeterminada', '');
  fillDeviceSelect('selectMic', [], 'Micrófono predeterminado', '');
  fillDeviceSelect('selectHeadphones', [], 'Salida del sistema', '', !canChooseAudioOutput());
  fillDeviceSelect('callSelectCam', [], 'Cámara predeterminada', '');
  fillDeviceSelect('callSelectMic', [], 'Micrófono predeterminado', '');
  fillDeviceSelect('callSelectHeadphones', [], 'Salida del sistema', '', !canChooseAudioOutput());
  updateAudioOutputSupport();
}

function canChooseAudioOutput() {
  return typeof document.createElement('video').setSinkId === 'function';
}

function updateAudioOutputSupport() {
  const msg = document.getElementById('audioOutputSupportMsg');
  if (!msg) return;

  const accessProblem = getMediaAccessProblem();
  if (accessProblem) {
    msg.textContent = accessProblem;
  } else if (!canChooseAudioOutput()) {
    msg.textContent = 'Este navegador no permite elegir cascos desde la web; usará la salida del sistema.';
  } else if (!state.audioOutputs.length) {
    msg.textContent = 'El navegador no ha mostrado salidas de audio concretas.';
  } else {
    msg.textContent = '';
  }
}

// ════════════════════════════════════════
//  PERMISOS DE CÁMARA Y MICRÓFONO
//  Con soporte de selección de dispositivo específico
// ════════════════════════════════════════
async function requestPermissions() {
  if (showMediaAccessProblem('permMsg')) return;

  const camId = document.getElementById('selectCam').value;
  const micId = document.getElementById('selectMic').value;
  state.audioOutputId = document.getElementById('selectHeadphones').value;
  state.audioOutputIndex = Math.max(0, state.audioOutputs.findIndex(d => d.id === state.audioOutputId));
  state.videoInputId = camId;
  state.audioInputId = micId;

  const constraints = {};

  if (camId) {
    constraints.video = { deviceId: { exact: camId } };
  } else {
    constraints.video = true;
  }

  if (micId) {
    constraints.audio = { deviceId: { exact: micId } };
  } else {
    constraints.audio = true;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    await prepareLocalAudio(stream);

    state.localStream = stream;
    state.micEnabled  = stream.getAudioTracks().length > 0;
    state.camEnabled  = stream.getVideoTracks().length > 0;
    await loadDevices();

    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = stream;
    document.getElementById('camOffMsg').style.display = state.camEnabled ? 'none' : 'flex';

    updateControls();
    applyAudioOutput();
    launchRoom();
  } catch (err) {
    let text = 'No se pudieron obtener los permisos.';
    if (err.name === 'NotAllowedError')    text = 'Permiso denegado. Revisa la configuración del navegador.';
    if (err.name === 'NotFoundError')      text = 'Dispositivo no encontrado. Prueba otra opción.';
    if (err.name === 'NotReadableError')   text = 'El dispositivo está en uso por otra aplicación.';
    if (err.name === 'OverconstrainedError') text = 'Dispositivo seleccionado no disponible. Prueba otro.';
    showMsg('permMsg', 'error', text);
  }
}

function skipPermissions() {
  state.localStream = null;
  state.micEnabled  = false;
  state.camEnabled  = false;
  state.videoInputId = document.getElementById('selectCam').value;
  state.audioInputId = document.getElementById('selectMic').value;
  state.audioOutputId = document.getElementById('selectHeadphones').value;
  state.audioOutputIndex = Math.max(0, state.audioOutputs.findIndex(d => d.id === state.audioOutputId));
  document.getElementById('camOffMsg').style.display = 'flex';
  launchRoom();
}

// ════════════════════════════════════════
//  INICIALIZAR SALA EN LA UI
// ════════════════════════════════════════
function launchRoom() {
  document.getElementById('permOverlay').classList.add('hidden');
  closeSettingsPanel();

  document.getElementById('localNameLabel').textContent = state.profile || 'Tú';
  document.getElementById('roomCodePill').textContent = `Código: ${state.currentRoom.code}`;
  document.getElementById('remoteSlot').innerHTML = `
    <div class="waiting-panel" id="waitingPanel">
      <span>Esperando a la otra persona</span>
    </div>`;
  state.peers.clear();
  state.members.clear();

  if (state.channel) state.channel.close();
  state.channel = new BroadcastChannel(`nexus_${state.currentRoom.hash}`);
  state.channel.onmessage = onChannelMessage;

  broadcast({
    type: 'join',
    from: state.myId,
    name: state.profile,
    mic:  state.micEnabled,
    cam:  state.camEnabled,
  });

  state.members.set(state.myId, {
    name: state.profile,
    mic:  state.micEnabled,
    cam:  state.camEnabled,
    self: true,
  });
  renderMembers();

  goTo('roomScreen');
  updateControls();
  applyAudioOutput();
}

// ════════════════════════════════════════
//  BROADCAST CHANNEL
// ════════════════════════════════════════
function broadcast(data) {
  if (state.channel) state.channel.postMessage(data);
}

function onChannelMessage(event) {
  const d = event.data;
  if (d.from === state.myId) return;

  switch (d.type) {

    case 'join':
      if (state.members.size >= 2) {
        broadcast({ type: 'room_full', from: state.myId, to: d.from });
        break;
      }
      state.members.set(d.from, { name: d.name, mic: d.mic, cam: d.cam });
      renderMembers();
      broadcast({
        type: 'presence',
        from: state.myId,
        name: state.profile,
        mic:  state.micEnabled,
        cam:  state.camEnabled,
      });
      initPeerConnection(d.from, true);
      break;

    case 'presence':
      if (!state.members.has(d.from)) {
        state.members.set(d.from, { name: d.name, mic: d.mic, cam: d.cam });
        renderMembers();
        initPeerConnection(d.from, false);
      } else {
        const m = state.members.get(d.from);
        m.mic = d.mic;
        m.cam = d.cam;
        renderMembers();
      }
      break;

    case 'chat':
      addMessage(d.from, d.name, d.text, d.time, false);
      break;

    case 'leave': {
      state.members.delete(d.from);
      renderMembers();
      closePeer(d.from);
      break;
    }

    case 'room_full':
      if (d.to === state.myId) {
        alert('La sala ya tiene dos personas.');
        leaveRoom();
      }
      break;

    case 'rtc_offer':
      if (d.to === state.myId) handleOffer(d.from, d.offer);
      break;

    case 'rtc_answer':
      if (d.to === state.myId) handleAnswer(d.from, d.answer);
      break;

    case 'rtc_ice':
      if (d.to === state.myId) handleIce(d.from, d.candidate);
      break;
  }
}

// ════════════════════════════════════════
//  WebRTC — Vídeo/audio P2P nativo
// ════════════════════════════════════════
const RTC_CONFIG = { iceServers: [] };

async function initPeerConnection(peerId, isInitiator) {
  if (state.peers.has(peerId)) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peers.set(peerId, { pc, stream: null });

  if (state.localStream?.getTracks().length) {
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      broadcast({ type: 'rtc_ice', from: state.myId, to: peerId, candidate });
    }
  };

  pc.ontrack = ({ streams }) => {
    const peer = state.peers.get(peerId);
    if (peer) peer.stream = streams[0];
    renderRemoteVideo(peerId, streams[0]);
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    broadcast({ type: 'rtc_offer', from: state.myId, to: peerId, offer });
  }
}

async function handleOffer(from, offer) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peers.set(from, { pc, stream: null });

  if (state.localStream?.getTracks().length) {
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      broadcast({ type: 'rtc_ice', from: state.myId, to: from, candidate });
    }
  };

  pc.ontrack = ({ streams }) => {
    const peer = state.peers.get(from);
    if (peer) peer.stream = streams[0];
    renderRemoteVideo(from, streams[0]);
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  broadcast({ type: 'rtc_answer', from: state.myId, to: from, answer });
}

async function handleAnswer(from, answer) {
  const peer = state.peers.get(from);
  if (peer) await peer.pc.setRemoteDescription(answer);
}

async function handleIce(from, candidate) {
  const peer = state.peers.get(from);
  if (peer) {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    peer.pc.close();
    state.peers.delete(peerId);
  }
  document.getElementById(`rv_${peerId}`)?.remove();
  const slot = document.getElementById('remoteSlot');
  if (slot && !slot.querySelector('video')) {
    slot.innerHTML = `
      <div class="waiting-panel" id="waitingPanel">
        <span>Esperando a la otra persona</span>
      </div>`;
  }
}

// ════════════════════════════════════════
//  RENDER DE VÍDEO REMOTO
// ════════════════════════════════════════
function renderRemoteVideo(peerId, stream) {
  const slot = document.getElementById('remoteSlot');
  let card = document.getElementById(`rv_${peerId}`);

  if (!card) {
    card = document.createElement('div');
    card.className = 'remote-video-card call-tile-video';
    card.id = `rv_${peerId}`;

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsinline = true;

    const lbl = document.createElement('div');
    lbl.className = 'person-label';
    lbl.id = `rvl_${peerId}`;
    lbl.textContent = state.members.get(peerId)?.name || 'Participante';

    card.appendChild(vid);
    card.appendChild(lbl);
    slot.innerHTML = '';
    slot.appendChild(card);
  }

  const video = card.querySelector('video');
  video.srcObject = stream;
  applyRemoteAudioMute(video);
  applyAudioOutput(video);
}

// ════════════════════════════════════════
//  CONTROLES DE AUDIO Y VÍDEO
// ════════════════════════════════════════

async function prepareLocalAudio(stream) {
  const [rawTrack] = stream.getAudioTracks();
  if (!rawTrack) return;

  cleanupAudioProcessing(true);
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    state.rawAudioTrack = rawTrack;
    return;
  }

  const audioContext = new AudioContextCtor();
  await audioContext.resume?.().catch(() => {});
  const sourceStream = new MediaStream([rawTrack]);
  const source = audioContext.createMediaStreamSource(sourceStream);
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  gain.gain.value = state.localVolume;
  source.connect(gain);
  gain.connect(destination);

  const [processedTrack] = destination.stream.getAudioTracks();
  stream.removeTrack(rawTrack);
  stream.addTrack(processedTrack);

  state.audioContext = audioContext;
  state.micSource = source;
  state.micGain = gain;
  state.micDestination = destination;
  state.rawAudioTrack = rawTrack;
  state.processedAudioTrack = processedTrack;
}

function cleanupAudioProcessing(stopRawTrack = true) {
  stopMicMonitor();
  if (stopRawTrack) state.rawAudioTrack?.stop();
  state.processedAudioTrack?.stop();
  state.micSource?.disconnect();
  state.micGain?.disconnect();
  state.audioContext?.close?.().catch(() => {});

  state.audioContext = null;
  state.micSource = null;
  state.micGain = null;
  state.micDestination = null;
  state.rawAudioTrack = null;
  state.processedAudioTrack = null;
}

function ensureLocalStream() {
  if (!state.localStream) {
    state.localStream = new MediaStream();
    document.getElementById('localVideo').srcObject = state.localStream;
  }
  return state.localStream;
}

async function publishTrackToPeers(kind, track) {
  await ensurePeerConnections();
  const updates = [];

  state.peers.forEach(({ pc }, peerId) => {
    const sender = pc.getSenders().find(s => s.track?.kind === kind);
    if (sender) {
      updates.push(sender.replaceTrack(track));
      return;
    }

    pc.addTrack(track, state.localStream);
    updates.push(renegotiatePeer(peerId, pc));
  });

  await Promise.all(updates);
}

async function ensurePeerConnections() {
  const starters = [];
  state.members.forEach((member, peerId) => {
    if (member.self || peerId === state.myId || state.peers.has(peerId)) return;
    starters.push(initPeerConnection(peerId, true));
  });
  await Promise.all(starters);
}

async function renegotiatePeer(peerId, pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  broadcast({ type: 'rtc_offer', from: state.myId, to: peerId, offer });
}

function toggleMic() {
  if (!state.localStream?.getAudioTracks().length) {
    changeMicrophone(document.getElementById('callSelectMic')?.value || '');
    return;
  }
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(t => { t.enabled = state.micEnabled; });
  updateControls();
  broadcast({
    type: 'presence', from: state.myId,
    name: state.profile, mic: state.micEnabled, cam: state.camEnabled,
  });
}

function toggleCam() {
  if (!state.localStream?.getVideoTracks().length) {
    changeCamera(document.getElementById('callSelectCam')?.value || '');
    return;
  }
  state.camEnabled = !state.camEnabled;
  state.localStream.getVideoTracks().forEach(t => { t.enabled = state.camEnabled; });
  document.getElementById('camOffMsg').style.display = state.camEnabled ? 'none' : 'flex';
  updateControls();
  broadcast({
    type: 'presence', from: state.myId,
    name: state.profile, mic: state.micEnabled, cam: state.camEnabled,
  });
}

function updateControls() {
  const btnMic = document.getElementById('btnMic');
  const btnCam = document.getElementById('btnCam');
  const btnDeafen = document.getElementById('btnDeafen');
  const btnMicMonitor = document.getElementById('btnMicMonitor');
  const hasMic = Boolean(state.localStream?.getAudioTracks().length);
  const hasCam = Boolean(state.localStream?.getVideoTracks().length);

  if (btnMic) {
    btnMic.className = `settings-action ${state.micEnabled && hasMic ? 'active' : 'muted-state'}`;
    btnMic.setAttribute('aria-pressed', String(state.micEnabled && hasMic));
    document.getElementById('micIcon').textContent = state.micEnabled && hasMic ? '🎙' : '🔇';
    document.getElementById('micLabel').textContent = state.micEnabled && hasMic ? 'Micro activo' : 'Micro muteado';
    document.getElementById('micStateText').textContent = hasMic
      ? (state.micEnabled ? 'Tu voz se está enviando' : 'Tu track de audio está desactivado')
      : 'No hay micrófono concedido';
  }

  if (btnCam) {
    btnCam.className = `settings-action ${state.camEnabled && hasCam ? 'active' : 'muted-state'}`;
    btnCam.setAttribute('aria-pressed', String(state.camEnabled && hasCam));
    document.getElementById('camIcon').textContent = state.camEnabled && hasCam ? '📷' : '🚫';
    document.getElementById('camLabel').textContent = state.camEnabled && hasCam ? 'Cámara activa' : 'Cámara apagada';
    document.getElementById('camStateText').textContent = hasCam
      ? (state.camEnabled ? 'Tu vídeo se está enviando' : 'Tu track de vídeo está desactivado')
      : 'No hay cámara concedida';
  }

  if (btnDeafen) {
    btnDeafen.className = `settings-action ${state.remoteAudioMuted ? 'muted-state' : 'active'}`;
    btnDeafen.setAttribute('aria-pressed', String(!state.remoteAudioMuted));
    document.getElementById('deafenIcon').textContent = state.remoteAudioMuted ? '🔇' : '🎧';
    document.getElementById('deafenLabel').textContent = state.remoteAudioMuted ? 'Audio recibido silenciado' : 'Audio recibido activo';
    document.getElementById('deafenStateText').textContent = state.remoteAudioMuted
      ? 'No escucharás a la otra persona'
      : 'Estás escuchando la llamada';
  }

  if (btnMicMonitor) {
    btnMicMonitor.className = `settings-action ${state.micMonitorEnabled ? 'active' : 'muted-state'}`;
    btnMicMonitor.setAttribute('aria-pressed', String(state.micMonitorEnabled));
    document.getElementById('micMonitorIcon').textContent = state.micMonitorEnabled ? '◉' : '○';
    document.getElementById('micMonitorLabel').textContent = state.micMonitorEnabled ? 'Prueba de micro activa' : 'Probar micrófono';
    document.getElementById('micMonitorStateText').textContent = hasMic
      ? (state.micMonitorEnabled ? 'Te estás escuchando localmente' : 'Escúchate solo en tus cascos')
      : 'Activa un micrófono para probarlo';
  }

  syncVolumeControls();

  syncCallSelectValues();
  updateAudioOutputSupport();

  if (state.members.has(state.myId)) {
    const me = state.members.get(state.myId);
    me.mic = state.micEnabled;
    me.cam = state.camEnabled;
    renderMembers();
  }
}

function cycleAudioOutput() {
  if (!state.audioOutputs.length) {
    showMsg('permMsg', 'error', 'Tu navegador no muestra salidas de audio disponibles.');
    return;
  }

  state.audioOutputIndex = (state.audioOutputIndex + 1) % state.audioOutputs.length;
  state.audioOutputId = state.audioOutputs[state.audioOutputIndex].id;
  changeAudioOutput(state.audioOutputId);
}

function toggleRemoteAudio() {
  state.remoteAudioMuted = !state.remoteAudioMuted;
  applyRemoteAudioMute();
  updateControls();
}

function applyRemoteAudioMute(targetVideo) {
  const videos = targetVideo ? [targetVideo] : Array.from(document.querySelectorAll('#remoteSlot video'));
  videos.forEach((video) => {
    video.muted = state.remoteAudioMuted;
    video.volume = state.remoteAudioMuted ? 0 : state.remoteVolume;
  });
}

function setLocalVolume(value) {
  state.localVolume = Math.max(0, Math.min(1, Number(value) / 100));
  if (state.micGain) state.micGain.gain.value = state.localVolume;
  if (state.micMonitorAudio) state.micMonitorAudio.volume = state.localVolume;
  syncVolumeControls();
}

function setRemoteVolume(value) {
  state.remoteVolume = Math.max(0, Math.min(1, Number(value) / 100));
  applyRemoteAudioMute();
  syncVolumeControls();
}

function syncVolumeControls() {
  const localRange = document.getElementById('localVolumeRange');
  const remoteRange = document.getElementById('remoteVolumeRange');
  const localValue = document.getElementById('localVolumeValue');
  const remoteValue = document.getElementById('remoteVolumeValue');
  const localPercent = Math.round(state.localVolume * 100);
  const remotePercent = Math.round(state.remoteVolume * 100);

  if (localRange) localRange.value = String(localPercent);
  if (remoteRange) remoteRange.value = String(remotePercent);
  if (localValue) localValue.textContent = `${localPercent}%`;
  if (remoteValue) remoteValue.textContent = `${remotePercent}%`;
}

async function toggleMicMonitor() {
  if (state.micMonitorEnabled) {
    stopMicMonitor();
    updateControls();
    return;
  }

  if (!state.rawAudioTrack && !state.localStream?.getAudioTracks().length) {
    showSettingsMsg('Activa un micrófono antes de probar el sonido.');
    return;
  }

  try {
    const monitorTrack = state.rawAudioTrack || state.localStream.getAudioTracks()[0];
    const audio = new Audio();
    audio.srcObject = new MediaStream([monitorTrack]);
    audio.volume = state.localVolume;
    audio.muted = false;
    audio.autoplay = true;

    if (typeof audio.setSinkId === 'function' && state.audioOutputId) {
      await audio.setSinkId(state.audioOutputId).catch(() => {});
    }

    state.micMonitorAudio = audio;
    state.micMonitorEnabled = true;
    await audio.play();
    updateControls();
  } catch (err) {
    stopMicMonitor();
    showSettingsMsg('No se pudo iniciar la prueba de micrófono.');
  }
}

function stopMicMonitor() {
  if (state.micMonitorAudio) {
    state.micMonitorAudio.pause();
    state.micMonitorAudio.srcObject = null;
  }
  state.micMonitorAudio = null;
  state.micMonitorEnabled = false;
}

async function changeMicrophone(deviceId) {
  if (showMediaAccessProblem('settingsMsg')) return;

  try {
    ensureLocalStream();
    const oldTracks = state.localStream.getAudioTracks();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    await prepareLocalAudio(stream);
    const [newTrack] = stream.getAudioTracks();
    if (!newTrack) throw new Error('No audio track');

    const shouldEnable = oldTracks.length ? state.micEnabled : true;
    newTrack.enabled = shouldEnable;

    oldTracks.forEach(track => {
      state.localStream.removeTrack(track);
      track.stop();
    });
    state.localStream.addTrack(newTrack);
    await publishTrackToPeers('audio', newTrack);

    state.audioInputId = deviceId;
    state.micEnabled = shouldEnable;
    await loadDevices();
    updateControls();
    broadcastPresence();
  } catch (err) {
    showSettingsMsg('No se pudo cambiar el micrófono. Revisa permisos o prueba otra opción.');
    syncCallSelectValues();
  }
}

async function changeCamera(deviceId) {
  if (showMediaAccessProblem('settingsMsg')) return;

  try {
    ensureLocalStream();
    const oldTracks = state.localStream.getVideoTracks();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    });
    const [newTrack] = stream.getVideoTracks();
    if (!newTrack) throw new Error('No video track');

    const shouldEnable = oldTracks.length ? state.camEnabled : true;
    newTrack.enabled = shouldEnable;

    oldTracks.forEach(track => {
      state.localStream.removeTrack(track);
      track.stop();
    });
    state.localStream.addTrack(newTrack);
    await publishTrackToPeers('video', newTrack);

    state.videoInputId = deviceId;
    state.camEnabled = shouldEnable;
    document.getElementById('localVideo').srcObject = state.localStream;
    document.getElementById('camOffMsg').style.display = state.camEnabled ? 'none' : 'flex';

    await loadDevices();
    updateControls();
    broadcastPresence();
  } catch (err) {
    showSettingsMsg('No se pudo cambiar la cámara. Revisa permisos o prueba otra opción.');
    syncCallSelectValues();
  }
}

async function replaceLocalTrack(kind, track) {
  const replacements = [];
  state.peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === kind);
    if (sender) replacements.push(sender.replaceTrack(track));
  });
  await Promise.all(replacements);
}

async function changeAudioOutput(deviceId) {
  state.audioOutputId = deviceId;
  state.audioOutputIndex = Math.max(0, state.audioOutputs.findIndex(d => d.id === deviceId));

  if (!canChooseAudioOutput()) {
    showSettingsMsg('Tu navegador usará la salida de audio del sistema.');
    updateControls();
    return;
  }

  await applyAudioOutput();
  if (state.micMonitorAudio && typeof state.micMonitorAudio.setSinkId === 'function' && state.audioOutputId) {
    await state.micMonitorAudio.setSinkId(state.audioOutputId).catch(() => {});
  }
  updateControls();
}

function syncCallSelectValues() {
  setSelectValue('callSelectMic', state.audioInputId);
  setSelectValue('callSelectCam', state.videoInputId);
  setSelectValue('callSelectHeadphones', state.audioOutputId);
  setSelectValue('selectMic', state.audioInputId);
  setSelectValue('selectCam', state.videoInputId);
  setSelectValue('selectHeadphones', state.audioOutputId);
}

function setSelectValue(id, value) {
  const select = document.getElementById(id);
  if (select && Array.from(select.options).some(option => option.value === value)) {
    select.value = value;
  }
}

function broadcastPresence() {
  broadcast({
    type: 'presence', from: state.myId,
    name: state.profile, mic: state.micEnabled, cam: state.camEnabled,
  });
}

function showSettingsMsg(text) {
  const el = document.getElementById('settingsMsg');
  if (!el) return;
  el.className = 'msg error show';
  el.textContent = text;
  setTimeout(() => el.classList.remove('show'), 3600);
}

async function applyAudioOutput(targetVideo) {
  const videos = targetVideo ? [targetVideo] : Array.from(document.querySelectorAll('#remoteSlot video'));
  await Promise.all(videos.map(video => {
    if (!video || typeof video.setSinkId !== 'function' || !state.audioOutputId) return Promise.resolve();
    return video.setSinkId(state.audioOutputId).catch(() => {});
  }));
}

function toggleSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    openSettingsPanel();
  } else {
    closeSettingsPanel();
  }
}

function openSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  const toggle = document.getElementById('settingsToggle');
  if (!panel) return;

  panel.classList.remove('hidden');
  toggle?.setAttribute('aria-expanded', 'true');
  updateControls();
}

function closeSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  const toggle = document.getElementById('settingsToggle');
  panel?.classList.add('hidden');
  toggle?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (event) => {
  const panel = document.getElementById('settingsPanel');
  const toggle = document.getElementById('settingsToggle');
  if (!panel || panel.classList.contains('hidden')) return;
  if (panel.contains(event.target) || toggle?.contains(event.target)) return;
  closeSettingsPanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSettingsPanel();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    loadDevices();
  });
}

// ════════════════════════════════════════
//  CHAT
// ════════════════════════════════════════
function sendMessage() {
  return;
}

function addMessage() {
  return;
}

function addSystemMsg() {
  return;
}

function unusedOldChatCode() {
/*
function sendMessage() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;

  const time = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  broadcast({ type: 'chat', from: state.myId, name: state.profile, text, time });
  addMessage(state.myId, state.profile, text, time, true);
  input.value = '';
}

function addMessage(fromId, name, text, time, own) {
  const msgs    = document.getElementById('messages');
  const bubble  = document.createElement('div');
  bubble.className = `msg-bubble${own ? ' own' : ''}`;

  const initials = name[0]?.toUpperCase() || '?';
  bubble.innerHTML = `
    <div class="msg-av">${initials}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author">${own ? 'Tú' : escHtml(name)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${escHtml(text)}</div>
    </div>`;

  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;
}

function addSystemMsg(text) {
  const msgs = document.getElementById('messages');
  const el   = document.createElement('div');
  el.className   = 'system-msg';
  el.textContent = `— ${text} —`;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}
*/
}

// ════════════════════════════════════════
//  LISTA DE MIEMBROS
// ════════════════════════════════════════
function renderMembers() {
  const list = document.getElementById('membersList');
  if (!list) return;
  list.innerHTML = '';

  state.members.forEach((m) => {
    const item = document.createElement('div');
    item.className = 'member-item';
    item.innerHTML = `
      <div class="online-dot"></div>
      <div class="member-avatar">${m.name[0]?.toUpperCase() || '?'}</div>
      <div class="member-name">${escHtml(m.name)}${m.self ? ' <em>(tú)</em>' : ''}</div>
      <div class="member-icons">
        <span title="Micrófono">${m.mic ? '🎙' : '🔇'}</span>
        <span title="Cámara">${m.cam ? '📷' : '🚫'}</span>
      </div>`;
    list.appendChild(item);
  });
}

// ════════════════════════════════════════
//  SALIR DE LA SALA
// ════════════════════════════════════════
function leaveRoom() {
  closeSettingsPanel();
  cleanupAudioProcessing(true);
  releaseCurrentRoom();
  broadcast({ type: 'leave', from: state.myId });

  state.localStream?.getTracks().forEach(t => t.stop());
  state.localStream  = null;

  state.peers.forEach((_, id) => closePeer(id));

  if (state.channel) {
    state.channel.close();
    state.channel = null;
  }

  state.currentRoom = null;
  state.micEnabled  = false;
  state.camEnabled  = false;
  state.remoteAudioMuted = false;
  document.getElementById('localVideo').srcObject = null;

  document.getElementById('joinPass').value       = '';
  document.getElementById('createRoomName').value = '';
  document.getElementById('createRoomPass').value = '';

  goTo('menuScreen');
}

function releaseCurrentRoom() {
  if (!state.currentRoom?.hash) return;
  const rooms = JSON.parse(sessionStorage.getItem('nexus_rooms') || '{}');
  delete rooms[state.currentRoom.hash];
  sessionStorage.setItem('nexus_rooms', JSON.stringify(rooms));
}

// ════════════════════════════════════════
//  DETECTAR CIERRE DE PESTAÑA
// ════════════════════════════════════════
window.addEventListener('beforeunload', () => {
  releaseCurrentRoom();
  if (state.channel) broadcast({ type: 'leave', from: state.myId });
});
