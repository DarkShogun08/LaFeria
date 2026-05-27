// La Feria - version estatica para GitHub Pages.
// Esta app usa WebRTC en modo manual: no hay backend ni APIs de pago.

// STUN publico opcional:
// - Ayuda a encontrar rutas entre navegadores, sobre todo si estan en redes distintas.
// - No crea salas, no sustituye la senalizacion y no retransmite audio/video.
// - Si quieres cero dependencias externas, desmarca "Usar STUN publico".
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

const state = {
  profile: localStorage.getItem('la_feria_profile') || '',
  role: '',
  peer: null,
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

  return 'No se pudo acceder a camara/microfono. Revisa permisos y vuelve a intentarlo.';
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

function createPeerConnection() {
  closePeer();

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peer = pc;
  state.remoteStream = new MediaStream();
  $('remoteVideo').srcObject = state.remoteStream;

  // Los candidatos ICE se recopilan antes de copiar el codigo. Asi no hace falta
  // enviar mensajes extra por un servidor.
  pc.ontrack = event => {
    event.streams[0]?.getTracks().forEach(track => {
      if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    });
    $('waitingPanel').classList.add('hidden');
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('Conexion establecida.', 'success');
      $('waitingPanel').classList.add('hidden');
    }

    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      setStatus('No se pudo establecer la llamada. Revisa HTTPS, permisos y que ambos copien los codigos completos.', 'error');
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      setStatus('ICE fallo. Prueba con STUN activado o con ambos dispositivos en una red menos restrictiva.', 'error');
    }
  };

  state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  return pc;
}

function closePeer() {
  if (state.peer) {
    state.peer.ontrack = null;
    state.peer.onconnectionstatechange = null;
    state.peer.oniceconnectionstatechange = null;
    state.peer.close();
  }
  state.peer = null;
}

async function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return;

  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(finish, 9000);
  });
}

async function encodeSignalPayload(payload) {
  const compact = {
    a: 'lf',
    v: 1,
    t: payload.type === 'offer' ? 'o' : 'a',
    n: payload.name,
    d: [payload.description.type, payload.description.sdp],
    s: payload.stun ? 1 : 0,
    c: payload.createdAt,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  const compressed = await compressBytes(bytes);
  return `${compressed.wasCompressed ? 'Z' : 'J'}${base64UrlEncode(compressed.bytes)}`;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

async function compressBytes(bytes) {
  if (!window.CompressionStream) return { bytes, wasCompressed: false };

  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return { bytes: new Uint8Array(buffer), wasCompressed: true };
}

async function decompressBytes(bytes) {
  if (!window.DecompressionStream) {
    throw new Error('Este navegador no puede descomprimir codigos compactos. Prueba con Chrome, Edge o Firefox actualizado.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decodeSignalPayload(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Pega primero un codigo de conexion.');

  try {
    let json = '';
    if (clean[0] === 'Z') {
      json = new TextDecoder().decode(await decompressBytes(base64UrlDecode(clean.slice(1))));
    } else if (clean[0] === 'J') {
      json = new TextDecoder().decode(base64UrlDecode(clean.slice(1)));
    } else {
      json = new TextDecoder().decode(
        Uint8Array.from(atob(clean), char => char.charCodeAt(0))
      );
    }

    const payload = JSON.parse(json);
    const normalized = payload.a === 'lf'
      ? {
          app: 'la-feria',
          version: payload.v,
          type: payload.t === 'o' ? 'offer' : 'answer',
          name: payload.n,
          description: { type: payload.d?.[0], sdp: payload.d?.[1] },
          stun: Boolean(payload.s),
          createdAt: payload.c,
        }
      : payload;

    if (normalized.app !== 'la-feria' || normalized.version !== 1 || !normalized.description?.sdp) {
      throw new Error('Formato no reconocido.');
    }

    return normalized;
  } catch (err) {
    throw new Error('El codigo no parece valido. Copia y pega el texto completo.');
  }
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
  setStatus('Creando oferta WebRTC. Espera a que termine la recopilacion ICE...', 'info');
  $('manualOfferCode').value = '';
  $('manualFinalAnswerCode').value = '';

  try {
    await ensureLocalMedia();
    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    $('manualOfferCode').value = await encodeSignalPayload({
      app: 'la-feria',
      version: 1,
      type: 'offer',
      name: state.profile,
      description: pc.localDescription,
      stun: $('usePublicStun')?.checked || false,
      createdAt: Date.now(),
    });

    setStatus('Paso 1 listo: copia este codigo y mandaselo a la otra persona.', 'success');
  } catch (err) {
    setStatus(mediaErrorMessage(err), 'error');
  }
}

async function generateManualAnswer() {
  if (!requireProfile('joinMsg')) return;

  let payload;
  try {
    payload = await decodeSignalPayload($('manualReceivedCode').value);
    if (payload.type !== 'offer') throw new Error('El codigo recibido no es una oferta.');
  } catch (err) {
    showMsg('joinMsg', 'error', err.message);
    return;
  }

  prepareCallScreen('guest');
  setStatus('Generando respuesta WebRTC. Espera a que termine la recopilacion ICE...', 'info');
  $('manualAnswerCode').value = '';

  try {
    await ensureLocalMedia();
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(payload.description));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    $('manualAnswerCode').value = await encodeSignalPayload({
      app: 'la-feria',
      version: 1,
      type: 'answer',
      name: state.profile,
      description: pc.localDescription,
      stun: $('usePublicStun')?.checked || false,
      createdAt: Date.now(),
    });

    setStatus('Respuesta lista: copia este codigo y devuelveselo a quien creo la llamada.', 'success');
  } catch (err) {
    setStatus(mediaErrorMessage(err), 'error');
  }
}

async function applyManualAnswer() {
  if (!state.peer || state.role !== 'creator') {
    setStatus('Primero crea una llamada y copia la oferta.', 'error');
    return;
  }

  try {
    const payload = await decodeSignalPayload($('manualFinalAnswerCode').value);
    if (payload.type !== 'answer') throw new Error('El codigo pegado no es una respuesta.');

    await state.peer.setRemoteDescription(new RTCSessionDescription(payload.description));
    setStatus('Respuesta aplicada. Intentando conectar la llamada...', 'info');
  } catch (err) {
    setStatus(err.message, 'error');
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

function leaveRoom() {
  closePeer();
  state.localStream?.getTracks().forEach(track => track.stop());
  state.localStream = null;
  state.remoteStream = null;
  state.role = '';

  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('manualOfferCode').value = '';
  $('manualReceivedCode').value = '';
  $('manualAnswerCode').value = '';
  $('manualFinalAnswerCode').value = '';
  $('camOffMsg').classList.add('hidden');
  closeSettingsPanel();
  showScreen('menuScreen');
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSettingsPanel();
});

updateProfileBadge();
