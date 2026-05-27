// La Feria - Llamadas Manuales
// Version GitHub Pages: WebRTC manual, sin backend y sin APIs de pago.
//
// Importante:
// - GitHub Pages solo sirve archivos estaticos.
// - No existe un servidor aqui que pueda recibir POST /signal.
// - Por eso la senalizacion WebRTC se hace copiando y pegando codigos.
// - El STUN publico es opcional y esta desactivado por defecto.

const MANUAL_PEER_ID = 'manual-peer';

const state = {
  profile: localStorage.getItem('nexus_name') || '',
  currentRoom: null,
  myId: makeLocalId(),
  localStream: null,
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
  micEnabled: false,
  camEnabled: false,
  peers: new Map(),
  manualRole: '',
  manualRemoteName: 'La otra persona',
};

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

async function hashPass(pass) {
  if (!globalThis.crypto?.subtle?.digest) return localHashFallback(pass);

  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pass)
  );

  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(screenId)?.classList.remove('hidden');

  if (screenId === 'profileScreen') {
    document.getElementById('profileInput').value = state.profile;
  }
}

function showMsg(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `msg ${type} show`;
  el.textContent = text;
  if (type === 'success') {
    setTimeout(() => el.classList.remove('show'), 3200);
  }
}

function showManualMsg(type, text) {
  showMsg('manualMsg', type, text);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateProfileBadge() {
  const name = state.profile || 'Sin nombre';
  document.getElementById('profileNameDisplay').textContent = name;
  document.getElementById('avatarDisplay').textContent = name[0]?.toUpperCase() || '?';
}

function saveProfile() {
  const val = document.getElementById('profileInput').value.trim();
  if (!val) return showMsg('profileMsg', 'error', 'El nombre no puede estar vacío.');

  state.profile = val;
  localStorage.setItem('nexus_name', val);
  updateProfileBadge();
  showMsg('profileMsg', 'success', 'Perfil guardado.');
  setTimeout(() => goTo('menuScreen'), 900);
}

async function createRoom() {
  if (!state.profile) {
    return showMsg('createMsg', 'error', 'Debes configurar tu perfil primero.');
  }

  const name = document.getElementById('createRoomName').value.trim();
  const pass = document.getElementById('createRoomPass').value || name || state.myId;

  if (!name) return showMsg('createMsg', 'error', 'Escribe un nombre para la llamada.');
  if (pass.length < 4) return showMsg('createMsg', 'error', 'La clave local debe tener al menos 4 caracteres.');

  const hash = await hashPass(pass);
  showMsg('createMsg', 'success', 'Llamada preparada. Ahora crea y comparte la invitación manual.');
  setTimeout(() => enterRoom(name, hash, pass), 700);
}

async function joinRoom() {
  if (!state.profile) {
    return showMsg('joinMsg', 'error', 'Debes configurar tu perfil primero.');
  }

  const pass = document.getElementById('joinPass').value || `manual-${Date.now()}`;
  const hash = await hashPass(pass);
  showMsg('joinMsg', 'success', 'Entra y pega el código de invitación recibido.');
  setTimeout(() => enterRoom('Llamada manual recibida', hash, pass), 500);
}

function enterRoom(name, hash, code) {
  state.currentRoom = { name, hash, code };
  loadDevices().then(() => {
    document.getElementById('permOverlay').classList.remove('hidden');
  });
}

function getMediaAccessProblem() {
  if (!window.isSecureContext) {
    return 'El navegador ha bloqueado cámara o micrófono porque la página no está en un contexto seguro. En GitHub Pages se usa HTTPS automáticamente; en local usa localhost o HTTPS.';
  }

  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    return 'Este navegador no expone cámara o micrófono para esta página. Revisa permisos o prueba otro navegador compatible.';
  }

  return '';
}

function showMediaAccessProblem(targetId = 'permMsg') {
  const problem = getMediaAccessProblem();
  if (problem) showMsg(targetId, 'error', problem);
  return problem;
}

function mediaErrorMessage(err, target = 'media') {
  const name = err?.name || '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Has denegado permisos de cámara o micrófono. Actívalos desde la configuración del navegador.';
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    if (target === 'camera') return 'No se ha encontrado ninguna cámara.';
    if (target === 'microphone') return 'No se ha encontrado ningún micrófono.';
    return 'No se ha encontrado ninguna cámara o micrófono.';
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'La cámara o el micrófono parecen estar siendo usados por otra aplicación.';
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'El dispositivo seleccionado no está disponible. Prueba otra cámara o micrófono.';
  }

  if (!window.isSecureContext) {
    return 'El navegador ha bloqueado cámara o micrófono porque la página no está en un contexto seguro.';
  }

  return 'No se pudieron obtener los permisos de cámara o micrófono. Revisa el navegador y vuelve a intentarlo.';
}

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

async function requestPermissions() {
  if (showMediaAccessProblem('permMsg')) return;

  const camId = document.getElementById('selectCam').value;
  const micId = document.getElementById('selectMic').value;
  state.audioOutputId = document.getElementById('selectHeadphones').value;
  state.audioOutputIndex = Math.max(0, state.audioOutputs.findIndex(d => d.id === state.audioOutputId));
  state.videoInputId = camId;
  state.audioInputId = micId;

  const constraints = {
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: micId ? { deviceId: { exact: micId } } : true,
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    await prepareLocalAudio(stream);

    state.localStream = stream;
    state.micEnabled = stream.getAudioTracks().length > 0;
    state.camEnabled = stream.getVideoTracks().length > 0;
    await loadDevices();

    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = stream;
    document.getElementById('camOffMsg').style.display = state.camEnabled ? 'none' : 'flex';

    updateControls();
    applyAudioOutput();
    launchRoom();
  } catch (err) {
    showMsg('permMsg', 'error', mediaErrorMessage(err));
  }
}

function skipPermissions() {
  state.localStream = null;
  state.micEnabled = false;
  state.camEnabled = false;
  state.videoInputId = document.getElementById('selectCam').value;
  state.audioInputId = document.getElementById('selectMic').value;
  state.audioOutputId = document.getElementById('selectHeadphones').value;
  state.audioOutputIndex = Math.max(0, state.audioOutputs.findIndex(d => d.id === state.audioOutputId));
  document.getElementById('camOffMsg').style.display = 'flex';
  launchRoom();
}

function launchRoom() {
  document.getElementById('permOverlay').classList.add('hidden');
  document.getElementById('localNameLabel').textContent = state.profile || 'Tú';
  document.getElementById('roomCodePill').textContent = 'Modo manual: copia y pega códigos';
  resetRemoteSlot();
  clearManualFields();
  goTo('roomScreen');
  openSettingsPanel();
  updateControls();
  applyAudioOutput();
}

function clearManualFields() {
  ['manualOfferCode', 'manualReceivedCode', 'manualAnswerCode', 'manualFinalAnswerCode'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function getRtcConfig() {
  const usePublicStun = document.getElementById('usePublicStun')?.checked;
  if (!usePublicStun) return { iceServers: [] };

  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };
}

function createManualPeerConnection(remoteName = 'La otra persona') {
  closePeer(MANUAL_PEER_ID);
  state.manualRemoteName = remoteName || 'La otra persona';

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peers.set(MANUAL_PEER_ID, { pc, stream: null });
  attachLocalMediaToPeer(pc);

  pc.ontrack = ({ track, streams }) => {
    const peer = state.peers.get(MANUAL_PEER_ID);
    let stream = streams[0] || peer?.stream;
    if (!stream) stream = new MediaStream();
    if (!stream.getTracks().some(t => t.id === track.id)) stream.addTrack(track);
    if (peer) peer.stream = stream;
    renderRemoteVideo(MANUAL_PEER_ID, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      showManualMsg('success', 'Conexión establecida. Ya deberíais veros y escucharos si la red lo permite.');
    } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
      showManualMsg('error', 'La conexión WebRTC ha fallado o se ha cortado. Prueba activando STUN o usando la misma red.');
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      showManualMsg('error', 'ICE no pudo conectar. Sin TURN algunas redes no permiten la llamada.');
    }
  };

  return pc;
}

function attachLocalMediaToPeer(pc) {
  const stream = ensureLocalStream();
  const audioTrack = stream.getAudioTracks()[0];
  const videoTrack = stream.getVideoTracks()[0];

  if (audioTrack) {
    pc.addTrack(audioTrack, stream);
  } else {
    pc.addTransceiver('audio', { direction: 'sendrecv' });
  }

  if (videoTrack) {
    pc.addTrack(videoTrack, stream);
  } else {
    pc.addTransceiver('video', { direction: 'sendrecv' });
  }
}

async function createManualOffer() {
  try {
    state.manualRole = 'offerer';
    const pc = createManualPeerConnection('La otra persona');
    showManualMsg('success', 'Creando invitación. Espera unos segundos mientras se recopilan datos de red.');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const code = encodeSignalPayload({
      app: 'la-feria',
      version: 1,
      type: 'offer',
      name: state.profile || 'Invitado',
      room: state.currentRoom?.name || 'Llamada manual',
      description: pc.localDescription,
      usesPublicStun: Boolean(document.getElementById('usePublicStun')?.checked),
    });

    document.getElementById('manualOfferCode').value = code;
    showManualMsg('success', 'Paso 1 listo: copia este código y mándaselo a la otra persona.');
  } catch (err) {
    showManualMsg('error', `No se pudo crear la invitación: ${err.message || err}`);
  }
}

async function generateManualAnswer() {
  try {
    const payload = decodeSignalPayload(document.getElementById('manualReceivedCode').value);
    if (payload.type !== 'offer') throw new Error('El código recibido no es una invitación válida.');

    state.manualRole = 'answerer';
    const pc = createManualPeerConnection(payload.name || 'La otra persona');
    showManualMsg('success', 'Generando respuesta. Espera unos segundos mientras se recopilan datos de red.');

    await pc.setRemoteDescription(new RTCSessionDescription(payload.description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const code = encodeSignalPayload({
      app: 'la-feria',
      version: 1,
      type: 'answer',
      name: state.profile || 'Invitado',
      room: payload.room || state.currentRoom?.name || 'Llamada manual',
      description: pc.localDescription,
      usesPublicStun: Boolean(document.getElementById('usePublicStun')?.checked),
    });

    document.getElementById('manualAnswerCode').value = code;
    showManualMsg('success', 'Paso 2 listo: copia esta respuesta y mándasela a quien creó la llamada.');
  } catch (err) {
    showManualMsg('error', `No se pudo generar la respuesta: ${err.message || err}`);
  }
}

async function applyManualAnswer() {
  try {
    const peer = state.peers.get(MANUAL_PEER_ID);
    if (!peer?.pc || state.manualRole !== 'offerer') {
      throw new Error('Primero debes crear una llamada en el Paso 1.');
    }

    const payload = decodeSignalPayload(document.getElementById('manualFinalAnswerCode').value);
    if (payload.type !== 'answer') throw new Error('El código recibido no es una respuesta válida.');

    state.manualRemoteName = payload.name || 'La otra persona';
    await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.description));
    showManualMsg('success', 'Respuesta aplicada. Conectando la llamada...');
  } catch (err) {
    showManualMsg('error', `No se pudo conectar: ${err.message || err}`);
  }
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(finish, 8000);
  });
}

function encodeSignalPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeSignalPayload(text) {
  const clean = text.trim();
  if (!clean) throw new Error('Pega primero un código.');

  try {
    const json = clean.startsWith('{')
      ? clean
      : new TextDecoder().decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0)));
    const payload = JSON.parse(json);
    if (payload.app !== 'la-feria' || !payload.description?.type || !payload.description?.sdp) {
      throw new Error('Formato no reconocido.');
    }
    return payload;
  } catch (err) {
    throw new Error('El código pegado no parece válido. Copia el texto completo y vuelve a intentarlo.');
  }
}

async function copyManualCode(textareaId) {
  const textarea = document.getElementById(textareaId);
  const value = textarea?.value.trim();
  if (!value) return showManualMsg('error', 'Todavía no hay ningún código para copiar.');

  try {
    await navigator.clipboard.writeText(value);
    showManualMsg('success', 'Código copiado. Ahora mándaselo a la otra persona.');
  } catch (err) {
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    showManualMsg('success', 'Código seleccionado para copiar.');
  }
}

async function pasteManualCode(textareaId) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  try {
    textarea.value = await navigator.clipboard.readText();
    showManualMsg('success', 'Código pegado.');
  } catch (err) {
    textarea.focus();
    showManualMsg('error', 'Tu navegador no permite pegar automáticamente. Pega el código manualmente en la caja.');
  }
}

function resetRemoteSlot() {
  const slot = document.getElementById('remoteSlot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="waiting-panel" id="waitingPanel">
      <span>Esperando conexión manual</span>
    </div>`;
}

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
    lbl.textContent = state.manualRemoteName || 'La otra persona';

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

function findSenderForKind(pc, kind) {
  return pc.getSenders().find(s => s.track?.kind === kind)
    || pc.getTransceivers().find(t => t.sender && (t.receiver?.track?.kind === kind || t.sender.track?.kind === kind))?.sender;
}

async function publishTrackToPeers(kind, track) {
  const stream = ensureLocalStream();
  const updates = [];

  state.peers.forEach(({ pc }) => {
    const sender = findSenderForKind(pc, kind);
    if (sender) {
      updates.push(sender.replaceTrack(track));
      const transceiver = pc.getTransceivers().find(t => t.sender === sender);
      if (transceiver) transceiver.direction = 'sendrecv';
      return;
    }

    pc.addTrack(track, stream);
  });

  await Promise.all(updates);
}

function toggleMic() {
  if (!state.localStream?.getAudioTracks().length) {
    changeMicrophone(document.getElementById('callSelectMic')?.value || '');
    return;
  }
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(t => { t.enabled = state.micEnabled; });
  updateControls();
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
  } catch (err) {
    showSettingsMsg(mediaErrorMessage(err, 'microphone'));
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
  } catch (err) {
    showSettingsMsg(mediaErrorMessage(err, 'camera'));
    syncCallSelectValues();
  }
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

function showSettingsMsg(text) {
  const el = document.getElementById('settingsMsg');
  if (!el) return;
  el.className = 'msg error show';
  el.textContent = text;
  setTimeout(() => el.classList.remove('show'), 4000);
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

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    peer.pc.close();
    state.peers.delete(peerId);
  }
  document.getElementById(`rv_${peerId}`)?.remove();
  if (!document.querySelector('#remoteSlot video')) resetRemoteSlot();
}

function leaveRoom() {
  closeSettingsPanel();
  cleanupAudioProcessing(true);

  state.localStream?.getTracks().forEach(t => t.stop());
  state.localStream = null;
  state.peers.forEach((_, id) => closePeer(id));
  state.peers.clear();

  state.currentRoom = null;
  state.micEnabled = false;
  state.camEnabled = false;
  state.remoteAudioMuted = false;
  state.manualRole = '';
  state.manualRemoteName = 'La otra persona';

  document.getElementById('localVideo').srcObject = null;
  document.getElementById('joinPass').value = '';
  document.getElementById('createRoomName').value = '';
  document.getElementById('createRoomPass').value = '';

  goTo('menuScreen');
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

window.addEventListener('beforeunload', () => {
  cleanupAudioProcessing(true);
  state.localStream?.getTracks().forEach(t => t.stop());
  state.peers.forEach(({ pc }) => pc.close());
});

updateProfileBadge();
