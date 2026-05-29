// La Feria - version estatica para GitHub Pages.
// Usa WebRTC con PeerJS para que el codigo compartido sea corto.

const ROOM_CODE_LENGTH = 12;

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

const state = {
  profile: localStorage.getItem('la_feria_profile') || '',
  role: '',
  peer: null,
  currentCall: null,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  camEnabled: true,
};

function $(id) {
  return document.getElementById(id);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.add('hidden'));
  $(id)?.classList.remove('hidden');

  if (id === 'profileScreen') {
    $('profileInput').value = state.profile;
  }
}

function showMsg(id, type, text) {
  const el = $(id);
  if (!el) return;
  el.className = `msg ${type} show`;
  el.textContent = text;
}

function setStatus(text, type = 'info') {
  const el = $('callStatus');
  if (!el) return;
  el.className = `call-status ${type}`;
  el.textContent = text;
}

function updateProfileBadge() {
  const name = state.profile || 'Sin nombre';
  $('profileNameDisplay').textContent = name;
  $('avatarDisplay').textContent = name[0]?.toUpperCase() || '?';
}

function saveProfile() {
  const value = $('profileInput').value.trim();
  if (!value) {
    showMsg('profileMsg', 'error', 'El nombre no puede estar vacio.');
    return;
  }

  state.profile = value;
  localStorage.setItem('la_feria_profile', value);
  updateProfileBadge();
  showMsg('profileMsg', 'success', 'Perfil guardado.');
  setTimeout(() => showScreen('menuScreen'), 700);
}

function requireProfile(targetMsgId) {
  if (state.profile) return true;
  showMsg(targetMsgId, 'error', 'Primero anade un nombre de perfil.');
  return false;
}

function getRtcConfig() {
  return $('usePublicStun')?.checked ? RTC_CONFIG : { iceServers: [] };
}

function mediaErrorMessage(err) {
  const name = err?.name || '';

  if (!window.isSecureContext) {
    return 'La camara y el microfono requieren HTTPS. GitHub Pages usa HTTPS; revisa que abras la URL https://.';
  }

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Permisos denegados. Activa camara y microfono en el navegador.';
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No se encontro camara o microfono disponible.';
  }

  if (name === 'NotReadableError') {
    return 'La camara o el microfono estan siendo usados por otra aplicacion.';
  }

  return err?.message || 'No se pudo acceder a camara/microfono. Revisa permisos y vuelve a intentarlo.';
}

function peerErrorMessage(err) {
  const type = err?.type || '';

  if (type === 'unavailable-id') {
    return 'Ese codigo ya esta en uso. Prueba a crear otra llamada.';
  }

  if (type === 'peer-unavailable') {
    return 'No se encontro ninguna llamada con ese codigo. Revisa los digitos y vuelve a intentarlo.';
  }

  if (type === 'network' || type === 'server-error' || type === 'socket-error') {
    return 'No se pudo contactar con el servidor de conexion. Revisa internet y prueba otra vez.';
  }

  if (type === 'browser-incompatible' || type === 'webrtc') {
    return 'Este navegador no soporta la llamada WebRTC correctamente.';
  }

  return err?.message || 'No se pudo preparar la conexion.';
}

function setupErrorMessage(err) {
  return err?.type ? peerErrorMessage(err) : mediaErrorMessage(err);
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador no soporta getUserMedia.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  state.localStream = stream;
  state.micEnabled = stream.getAudioTracks().some(track => track.enabled);
  state.camEnabled = stream.getVideoTracks().some(track => track.enabled);
  $('localVideo').srcObject = stream;
  updateControls();
  return stream;
}

function generateRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => String(byte % 10)).join('');
}

function normalizeRoomCode(value) {
  return String(value || '').replace(/\s+/g, '');
}

function validateRoomCode(value) {
  const code = normalizeRoomCode(value);
  if (!/^\d{10,20}$/.test(code)) {
    throw new Error('El codigo debe tener entre 10 y 20 digitos.');
  }
  return code;
}

function createSignalingPeer(peerId) {
  if (!window.Peer) {
    throw new Error('No se pudo cargar PeerJS. Revisa la conexion a internet y vuelve a abrir la pagina.');
  }

  closePeer();

  const peer = new Peer(peerId || undefined, {
    config: getRtcConfig(),
    debug: 1,
  });

  state.peer = peer;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = callback => value => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    peer.on('open', settle(resolve));
    peer.on('error', err => {
      if (!settled) {
        settled = true;
        peer.destroy();
        state.peer = null;
        reject(err);
        return;
      }

      setStatus(peerErrorMessage(err), 'error');
    });
    peer.on('disconnected', () => {
      setStatus('Se perdio la conexion con el servidor. La llamada puede cortarse si aun no habia empezado.', 'error');
    });
  });
}

async function createRoomPeer() {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRoomCode();

    try {
      await createSignalingPeer(code);
      return code;
    } catch (err) {
      lastError = err;
      if (err?.type !== 'unavailable-id') throw err;
    }
  }

  throw lastError || new Error('No se pudo crear un codigo libre.');
}

function attachRemoteStream(stream) {
  state.remoteStream = stream;
  $('remoteVideo').srcObject = stream;
  $('waitingPanel').classList.add('hidden');
  setStatus('Conexion establecida.', 'success');
}

function bindCallEvents(call) {
  state.currentCall = call;

  call.on('stream', stream => {
    attachRemoteStream(stream);
  });

  call.on('close', () => {
    setStatus('La llamada se ha cerrado.', 'info');
  });

  call.on('error', err => {
    setStatus(peerErrorMessage(err), 'error');
  });
}

function answerIncomingCall(call) {
  if (!state.localStream) {
    call.close();
    return;
  }

  if (state.currentCall) {
    call.close();
    return;
  }

  setStatus('Otra persona entro. Activando llamada...', 'info');
  bindCallEvents(call);
  call.answer(state.localStream, { metadata: { name: state.profile } });
}

function closePeer() {
  if (state.currentCall) {
    state.currentCall.close();
  }

  if (state.peer) {
    state.peer.destroy();
  }

  state.currentCall = null;
  state.peer = null;
}

function prepareCallScreen(role) {
  state.role = role;
  $('localNameLabel').textContent = state.profile || 'Tu';
  $('remoteVideo').srcObject = null;
  $('waitingPanel').classList.remove('hidden');
  $('creatorPanel').classList.toggle('hidden', role !== 'creator');
  $('guestPanel').classList.toggle('hidden', role !== 'guest');
  $('manualPanel').classList.remove('hidden');
  showScreen('roomScreen');
}

async function createManualOffer() {
  if (!requireProfile('createMsg')) return;

  prepareCallScreen('creator');
  setStatus('Preparando camara, microfono y codigo corto...', 'info');
  $('manualOfferCode').value = '';

  try {
    await ensureLocalMedia();
    const code = await createRoomPeer();
    state.peer.on('call', answerIncomingCall);
    $('manualOfferCode').value = code;
    setStatus('Codigo listo: copia estos 12 digitos y mandaselos a la otra persona.', 'success');
  } catch (err) {
    setStatus(setupErrorMessage(err), 'error');
  }
}

async function generateManualAnswer() {
  if (!requireProfile('joinMsg')) return;

  let code;
  try {
    code = validateRoomCode($('manualReceivedCode').value);
  } catch (err) {
    showMsg('joinMsg', 'error', err.message);
    return;
  }

  prepareCallScreen('guest');
  setStatus('Entrando con el codigo corto...', 'info');

  try {
    await ensureLocalMedia();
    await createSignalingPeer();

    const call = state.peer.call(code, state.localStream, {
      metadata: { name: state.profile },
    });

    if (!call) {
      throw new Error('No se pudo iniciar la llamada.');
    }

    bindCallEvents(call);
    setStatus('Llamando al creador. Espera unos segundos...', 'info');
  } catch (err) {
    setStatus(setupErrorMessage(err), 'error');
  }
}

async function copyCode(id) {
  const el = $(id);
  const value = el?.value.trim();
  if (!value) {
    setStatus('Todavia no hay codigo para copiar.', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus('Codigo copiado.', 'success');
  } catch (err) {
    el.focus();
    el.select();
    document.execCommand('copy');
    setStatus('Codigo seleccionado. Si no se copio, pulsa Ctrl+C.', 'info');
  }
}

async function pasteCode(id) {
  const el = $(id);
  if (!el) return;

  try {
    el.value = await navigator.clipboard.readText();
  } catch (err) {
    el.focus();
    setStatus('Tu navegador no permite pegar automaticamente. Pega el codigo manualmente.', 'info');
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
  $('camOffMsg').classList.toggle('hidden', state.camEnabled);
  updateControls();
}

function updateControls() {
  $('micLabel').textContent = state.micEnabled ? 'Micro activo' : 'Micro silenciado';
  $('camLabel').textContent = state.camEnabled ? 'Camara activa' : 'Camara apagada';
  $('btnMic').classList.toggle('muted-state', !state.micEnabled);
  $('btnCam').classList.toggle('muted-state', !state.camEnabled);
}

function toggleSettingsPanel() {
  $('settingsPanel').classList.toggle('hidden');
}

function closeSettingsPanel() {
  $('settingsPanel').classList.add('hidden');
}

function clearField(id) {
  const el = $(id);
  if (el) el.value = '';
}

function leaveRoom() {
  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.remoteStream = null;
  state.role = '';

  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  clearField('manualOfferCode');
  clearField('manualReceivedCode');
  $('camOffMsg').classList.add('hidden');
  closeSettingsPanel();
  showScreen('menuScreen');
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSettingsPanel();
});

updateProfileBadge();
