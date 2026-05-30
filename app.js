// La Feria - version estatica para GitHub Pages.
// Usa WebRTC con PeerJS para que el codigo compartido sea corto.

const ROOM_CODE_LENGTH = 12;
const CREATOR_QUESTION_COUNT = 15;
const CREATOR_QUESTION_OPTIONS = ['A', 'B', 'C', 'D'];
const CREATOR_QUESTIONS_FALLBACK_KEY = 'laFeria_creator_questions';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

const state = {
  profile: (() => {
    try {
      return window.localStorage?.getItem('la_feria_profile') || '';
    } catch (err) {
      return '';
    }
  })(),
  role: '',
  peer: null,
  currentCall: null,
  dataConnection: null,
  localStream: null,
  remoteStream: null,
  selectedAudioDeviceId: '',
  selectedVideoDeviceId: '',
  audioFallbackContext: null,
  audioFallbackOscillator: null,
  videoFallbackCanvas: null,
  micTestStream: null,
  micEnabled: true,
  camEnabled: true,
  currentRoomCode: '',
  creatorQuestions: [],
  currentQuestionIndex: -1,
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

function getLocalStorageItem(key) {
  try {
    return window.localStorage?.getItem(key) || null;
  } catch (err) {
    return null;
  }
}

function setLocalStorageItem(key, value) {
  try {
    window.localStorage?.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

function creatorQuestionsStorageKey() {
  return state.currentRoomCode
    ? `${CREATOR_QUESTIONS_FALLBACK_KEY}_${state.currentRoomCode}`
    : CREATOR_QUESTIONS_FALLBACK_KEY;
}

function emptyCreatorQuestion() {
  return {
    prompt: '',
    answers: { A: '', B: '', C: '', D: '' },
    correct: 'A',
  };
}

function normalizeCreatorQuestion(raw) {
  const question = emptyCreatorQuestion();
  if (!raw || typeof raw !== 'object') return question;

  question.prompt = String(raw.prompt || '');
  CREATOR_QUESTION_OPTIONS.forEach(option => {
    question.answers[option] = String(raw.answers?.[option] || '');
  });
  question.correct = CREATOR_QUESTION_OPTIONS.includes(raw.correct) ? raw.correct : 'A';
  return question;
}

function normalizeCreatorQuestions(raw) {
  const source = Array.isArray(raw) ? raw : [];
  return Array.from({ length: CREATOR_QUESTION_COUNT }, (_, index) => normalizeCreatorQuestion(source[index]));
}

function loadCreatorQuestions() {
  let saved = null;

  try {
    saved = JSON.parse(getLocalStorageItem(creatorQuestionsStorageKey()) || 'null');
  } catch (err) {
    console.warn('No se pudieron leer las preguntas guardadas.', err);
  }

  state.creatorQuestions = normalizeCreatorQuestions(saved);
  renderCreatorQuestions();
}

function saveCreatorQuestions(silent = false) {
  if (state.role !== 'creator') return;

  try {
    const saved = setLocalStorageItem(creatorQuestionsStorageKey(), JSON.stringify(state.creatorQuestions));
    const savedLabel = $('creatorQuestionsSaved');
    if (savedLabel) {
      savedLabel.textContent = saved
        ? (silent ? 'Guardado automaticamente.' : 'Preguntas guardadas.')
        : 'No se pudieron guardar las preguntas.';
    }
  } catch (err) {
    const savedLabel = $('creatorQuestionsSaved');
    if (savedLabel) savedLabel.textContent = 'No se pudieron guardar las preguntas.';
  }
}

function renderCreatorQuestions() {
  const list = $('creatorQuestionsList');
  if (!list) return;

  list.innerHTML = '';
  state.creatorQuestions.forEach((question, index) => {
    const card = document.createElement('article');
    card.className = 'creator-question-card';

    const title = document.createElement('h3');
    title.textContent = `Pregunta ${index + 1}`;
    card.appendChild(title);

    const promptLabel = document.createElement('label');
    promptLabel.textContent = 'Texto de la pregunta';
    promptLabel.setAttribute('for', `creatorQuestionPrompt${index}`);
    card.appendChild(promptLabel);

    const prompt = document.createElement('textarea');
    prompt.id = `creatorQuestionPrompt${index}`;
    prompt.rows = 3;
    prompt.placeholder = 'Escribe aqui la pregunta...';
    prompt.value = question.prompt;
    prompt.dataset.questionIndex = String(index);
    prompt.dataset.field = 'prompt';
    card.appendChild(prompt);

    const answers = document.createElement('div');
    answers.className = 'creator-answer-grid';

    CREATOR_QUESTION_OPTIONS.forEach(option => {
      const answerLabel = document.createElement('label');
      answerLabel.textContent = `Respuesta ${option}`;
      answerLabel.setAttribute('for', `creatorQuestion${index}${option}`);

      const answerInput = document.createElement('input');
      answerInput.id = `creatorQuestion${index}${option}`;
      answerInput.type = 'text';
      answerInput.placeholder = `${option}: respuesta`;
      answerInput.value = question.answers[option];
      answerInput.dataset.questionIndex = String(index);
      answerInput.dataset.field = 'answer';
      answerInput.dataset.option = option;

      const answerField = document.createElement('div');
      answerField.className = 'creator-answer-field';
      answerField.append(answerLabel, answerInput);
      answers.appendChild(answerField);
    });

    card.appendChild(answers);

    const correctRow = document.createElement('label');
    correctRow.className = 'creator-correct-row';
    correctRow.textContent = 'Respuesta correcta';

    const correctSelect = document.createElement('select');
    correctSelect.dataset.questionIndex = String(index);
    correctSelect.dataset.field = 'correct';
    CREATOR_QUESTION_OPTIONS.forEach(option => {
      const correctOption = document.createElement('option');
      correctOption.value = option;
      correctOption.textContent = option;
      correctSelect.appendChild(correctOption);
    });
    correctSelect.value = question.correct;
    correctRow.appendChild(correctSelect);
    card.appendChild(correctRow);

    list.appendChild(card);
  });
}

function updateCreatorQuestionFromInput(target) {
  const index = Number(target.dataset.questionIndex);
  const field = target.dataset.field;
  if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;

  const question = state.creatorQuestions[index] || emptyCreatorQuestion();
  if (field === 'prompt') {
    question.prompt = target.value;
  } else if (field === 'answer') {
    const option = target.dataset.option;
    if (CREATOR_QUESTION_OPTIONS.includes(option)) {
      question.answers[option] = target.value;
    }
  } else if (field === 'correct') {
    question.correct = CREATOR_QUESTION_OPTIONS.includes(target.value) ? target.value : 'A';
  }

  state.creatorQuestions[index] = question;
  saveCreatorQuestions(true);
}

function openCreatorQuestionsPanel() {
  if (state.role !== 'creator') return;

  loadCreatorQuestions();
  $('creatorQuestionsModal')?.classList.remove('hidden');
}

function closeCreatorQuestionsPanel() {
  $('creatorQuestionsModal')?.classList.add('hidden');
}

function resetQuizDisplay() {
  state.currentQuestionIndex = -1;
  const questionLine = $('quizQuestionLine');
  if (questionLine) questionLine.textContent = '';
  document.querySelectorAll('.quiz-answer-line').forEach(line => {
    line.textContent = '';
  });
  document.querySelectorAll('.quiz-progress span').forEach(item => {
    item.classList.remove('pending');
    item.classList.add('locked');
  });
}

function displayQuizQuestion(index, question) {
  const safeQuestion = normalizeCreatorQuestion(question);
  const questionLine = $('quizQuestionLine');
  if (questionLine) {
    questionLine.textContent = safeQuestion.prompt || `Pregunta ${index + 1}`;
  }

  CREATOR_QUESTION_OPTIONS.forEach(option => {
    const line = document.querySelector(`.quiz-answer-line[data-option="${option}"]`);
    if (line) line.textContent = `${option}: ${safeQuestion.answers[option] || ''}`;
  });

  document.querySelectorAll('.quiz-progress span').forEach((item, itemIndex) => {
    item.classList.toggle('pending', itemIndex === index);
    item.classList.toggle('locked', itemIndex !== index);
  });
}

function sendDataMessage(message) {
  if (!state.dataConnection?.open) return false;
  try {
    state.dataConnection.send(message);
    return true;
  } catch (err) {
    console.warn('No se pudo enviar la pregunta.', err);
    return false;
  }
}

function handleDataMessage(data) {
  if (!data || data.type !== 'quiz-question') return;

  const index = Number(data.index);
  if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
  state.currentQuestionIndex = index;
  displayQuizQuestion(index, data.question);
}

function bindDataConnection(connection) {
  if (!connection) return;

  if (state.dataConnection && state.dataConnection !== connection) {
    state.dataConnection.close?.();
  }

  state.dataConnection = connection;
  connection.on('open', () => {
    if (state.role === 'creator' && state.currentQuestionIndex >= 0) {
      sendDataMessage({
        type: 'quiz-question',
        index: state.currentQuestionIndex,
        question: state.creatorQuestions[state.currentQuestionIndex],
      });
    }
  });
  connection.on('data', handleDataMessage);
  connection.on('close', () => {
    if (state.dataConnection === connection) state.dataConnection = null;
  });
  connection.on('error', err => {
    console.warn('Error en el canal de preguntas.', err);
  });
}

function showCreatorQuestion(index) {
  if (state.role !== 'creator') return;

  loadCreatorQuestions();
  if (index < 0) {
    setStatus('Ya estas en la primera pregunta.', 'info');
    return;
  }
  if (index >= CREATOR_QUESTION_COUNT) {
    setStatus('Ya has mostrado las 15 preguntas.', 'info');
    return;
  }

  state.currentQuestionIndex = index;
  const question = state.creatorQuestions[index];
  displayQuizQuestion(index, question);
  sendDataMessage({ type: 'quiz-question', index, question });
  setStatus(`Pregunta ${index + 1} mostrada.`, 'success');
}

function showPreviousCreatorQuestion() {
  showCreatorQuestion(state.currentQuestionIndex - 1);
}

function showNextCreatorQuestion() {
  showCreatorQuestion(state.currentQuestionIndex + 1);
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
  setLocalStorageItem('la_feria_profile', value);
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

function markFallbackTrack(track, cleanup) {
  track.isLaFeriaFallback = true;
  if (cleanup) track.laFeriaCleanup = cleanup;
  return track;
}

function isFallbackTrack(track) {
  return Boolean(track?.isLaFeriaFallback);
}

function getLocalTrack(kind) {
  return state.localStream?.getTracks().find(track => track.kind === kind) || null;
}

function createSilentAudioTrack() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  const audioContext = new AudioContextClass();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();

  state.audioFallbackContext = audioContext;
  state.audioFallbackOscillator = oscillator;

  const track = destination.stream.getAudioTracks()[0];
  track.enabled = false;
  return markFallbackTrack(track, () => {
    try {
      oscillator.stop();
    } catch (err) {
      // Puede estar ya detenido.
    }
    audioContext.close?.();
  });
}

function createBlackVideoTrack() {
  const canvas = document.createElement('canvas');
  if (!canvas.captureStream) return null;

  canvas.width = 640;
  canvas.height = 360;

  const context = canvas.getContext('2d');
  context.fillStyle = '#060812';
  context.fillRect(0, 0, canvas.width, canvas.height);

  state.videoFallbackCanvas = canvas;

  const stream = canvas.captureStream(5);
  const track = stream.getVideoTracks()[0];
  track.enabled = false;
  return markFallbackTrack(track);
}

function stopTrack(track) {
  if (!track) return;
  track.laFeriaCleanup?.();
  track.stop();
}

function stopFallbackHelpers() {
  try {
    state.audioFallbackOscillator?.stop();
  } catch (err) {
    // Puede estar ya detenido.
  }

  state.audioFallbackContext?.close?.();
  state.audioFallbackContext = null;
  state.audioFallbackOscillator = null;
  state.videoFallbackCanvas = null;
}

function deviceConstraint(kind, deviceId) {
  if (deviceId && deviceId !== '__default__' && deviceId !== '__none__') {
    return { deviceId: { exact: deviceId } };
  }

  if (kind === 'video') {
    return { width: { ideal: 1280 }, height: { ideal: 720 } };
  }

  return true;
}

async function getDeviceTrack(kind, deviceId) {
  if (!navigator.mediaDevices?.getUserMedia || deviceId === '__none__') return null;

  const constraints = {
    audio: kind === 'audio' ? deviceConstraint(kind, deviceId) : false,
    video: kind === 'video' ? deviceConstraint(kind, deviceId) : false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return stream.getTracks()[0] || null;
}

async function getOutgoingTrack(kind, deviceId) {
  try {
    const track = await getDeviceTrack(kind, deviceId);
    if (track) return track;
  } catch (err) {
    console.warn(`No se pudo abrir ${kind}. Se usara pista vacia.`, err);
  }

  return kind === 'audio' ? createSilentAudioTrack() : createBlackVideoTrack();
}

async function replaceLocalTrack(kind, nextTrack) {
  if (!state.localStream) return;

  const oldTrack = getLocalTrack(kind);
  if (nextTrack) {
    const enabled = kind === 'audio' ? state.micEnabled : state.camEnabled;
    nextTrack.enabled = !isFallbackTrack(nextTrack) && enabled;
  }

  if (oldTrack) {
    state.localStream.removeTrack(oldTrack);
  }
  if (nextTrack) {
    state.localStream.addTrack(nextTrack);
  }

  const sender = state.currentCall?.peerConnection
    ?.getSenders()
    .find(item => item.track?.kind === kind || oldTrack?.kind === kind);
  if (sender) {
    await sender.replaceTrack(nextTrack);
  }

  if (oldTrack && oldTrack !== nextTrack) {
    stopTrack(oldTrack);
  }

  $('localVideo').srcObject = state.localStream;
}

async function refreshDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    updateDeviceSelect('audioDeviceSelect', devices.filter(device => device.kind === 'audioinput'), state.selectedAudioDeviceId, 'microfono');
    updateDeviceSelect('videoDeviceSelect', devices.filter(device => device.kind === 'videoinput'), state.selectedVideoDeviceId, 'camara');
  } catch (err) {
    console.warn('No se pudieron leer los dispositivos.', err);
  }
}

function updateDeviceSelect(id, devices, selectedValue, emptyLabel) {
  const select = $(id);
  if (!select) return;

  const current = selectedValue || select.value || '__default__';
  select.innerHTML = '';

  const noneOption = document.createElement('option');
  noneOption.value = '__none__';
  noneOption.textContent = `Sin ${emptyLabel}`;
  select.appendChild(noneOption);

  if (devices.length > 0) {
    const defaultOption = document.createElement('option');
    defaultOption.value = '__default__';
    defaultOption.textContent = `${emptyLabel[0].toUpperCase()}${emptyLabel.slice(1)} predeterminado`;
    select.appendChild(defaultOption);
  }

  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `${emptyLabel[0].toUpperCase()}${emptyLabel.slice(1)} ${index + 1}`;
    select.appendChild(option);
  });

  select.value = Array.from(select.options).some(option => option.value === current)
    ? current
    : (devices.length > 0 ? '__default__' : '__none__');
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;

  const audioTrack = await getOutgoingTrack('audio', state.selectedAudioDeviceId || '__default__');
  const videoTrack = await getOutgoingTrack('video', state.selectedVideoDeviceId || '__default__');

  state.localStream = new MediaStream([audioTrack, videoTrack].filter(Boolean));
  state.micEnabled = Boolean(audioTrack && !isFallbackTrack(audioTrack));
  state.camEnabled = Boolean(videoTrack && !isFallbackTrack(videoTrack));
  $('localVideo').srcObject = state.localStream;
  await refreshDeviceLists();
  updateControls();
  return state.localStream;
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

async function changeAudioDevice() {
  const select = $('audioDeviceSelect');
  if (!select || !state.localStream) return;

  stopMicTest();
  state.selectedAudioDeviceId = select.value;
  state.micEnabled = select.value !== '__none__';

  const nextTrack = await getOutgoingTrack('audio', select.value);
  await replaceLocalTrack('audio', nextTrack);
  await refreshDeviceLists();
  updateControls();
  setStatus(!nextTrack || isFallbackTrack(nextTrack) ? 'Microfono desactivado o no disponible.' : 'Microfono actualizado.', !nextTrack || isFallbackTrack(nextTrack) ? 'info' : 'success');
}

async function changeVideoDevice() {
  const select = $('videoDeviceSelect');
  if (!select || !state.localStream) return;

  state.selectedVideoDeviceId = select.value;
  state.camEnabled = select.value !== '__none__';

  const nextTrack = await getOutgoingTrack('video', select.value);
  await replaceLocalTrack('video', nextTrack);
  await refreshDeviceLists();
  updateControls();
  setStatus(!nextTrack || isFallbackTrack(nextTrack) ? 'Camara desactivada o no disponible.' : 'Camara actualizada.', !nextTrack || isFallbackTrack(nextTrack) ? 'info' : 'success');
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

  if (state.dataConnection) {
    state.dataConnection.close?.();
  }

  if (state.peer) {
    state.peer.destroy();
  }

  state.currentCall = null;
  state.dataConnection = null;
  state.peer = null;
}

function prepareCallScreen(role) {
  state.role = role;
  if (role !== 'creator') {
    state.creatorQuestions = [];
    closeCreatorQuestionsPanel();
  }
  $('localNameLabel').textContent = state.profile || 'Tu';
  $('remoteVideo').srcObject = null;
  $('waitingPanel').classList.remove('hidden');
  $('creatorPanel').classList.toggle('hidden', role !== 'creator');
  $('guestPanel').classList.toggle('hidden', role !== 'guest');
  $('creatorQuestionNav')?.classList.toggle('hidden', role !== 'creator');
  resetQuizDisplay();
  closeSettingsPanel();
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
    state.currentRoomCode = code;
    loadCreatorQuestions();
    state.peer.on('call', answerIncomingCall);
    state.peer.on('connection', bindDataConnection);
    $('manualOfferCode').value = code;
    $('settingsPanel').classList.remove('hidden');
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
  state.currentRoomCode = code;
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
    bindDataConnection(state.peer.connect(code, { reliable: true }));
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
  const track = getLocalTrack('audio');
  if (!track || isFallbackTrack(track)) {
    state.micEnabled = false;
    updateControls();
    setStatus('No hay microfono activo. Elige uno en ajustes.', 'info');
    return;
  }

  state.micEnabled = !state.micEnabled;
  track.enabled = state.micEnabled;
  updateControls();
}

function toggleCam() {
  const track = getLocalTrack('video');
  if (!track || isFallbackTrack(track)) {
    state.camEnabled = false;
    updateControls();
    setStatus('No hay camara activa. Elige una en ajustes.', 'info');
    return;
  }

  state.camEnabled = !state.camEnabled;
  track.enabled = state.camEnabled;
  updateControls();
}

function updateControls() {
  const audioTrack = getLocalTrack('audio');
  const videoTrack = getLocalTrack('video');
  const hasMic = Boolean(audioTrack && !isFallbackTrack(audioTrack));
  const hasCam = Boolean(videoTrack && !isFallbackTrack(videoTrack));

  $('micLabel').textContent = hasMic
    ? (state.micEnabled ? 'Micro activo' : 'Micro silenciado')
    : 'Sin microfono';
  $('camLabel').textContent = hasCam
    ? (state.camEnabled ? 'Camara activa' : 'Camara apagada')
    : 'Sin camara';
  $('btnMic').classList.toggle('active', hasMic && state.micEnabled);
  $('btnCam').classList.toggle('active', hasCam && state.camEnabled);
  $('btnMic').classList.toggle('muted-state', !hasMic || !state.micEnabled);
  $('btnCam').classList.toggle('muted-state', !hasCam || !state.camEnabled);
  $('camOffMsg').classList.toggle('hidden', hasCam && state.camEnabled);
}

async function toggleMicTest() {
  if (state.micTestStream) {
    stopMicTest();
    return;
  }

  try {
    const deviceId = $('audioDeviceSelect')?.value || state.selectedAudioDeviceId || '__default__';
    if (deviceId === '__none__') {
      setStatus('Elige un microfono para probarlo.', 'info');
      return;
    }

    const track = await getDeviceTrack('audio', deviceId);
    if (!track) {
      setStatus('No se pudo abrir ningun microfono para la prueba.', 'error');
      return;
    }

    state.micTestStream = new MediaStream([track]);
    const audio = $('micTestAudio');
    audio.srcObject = state.micTestStream;
    audio.muted = false;
    audio.volume = 1;
    await audio.play();

    $('btnMicTest').textContent = 'Detener prueba de microfono';
    setStatus('Prueba activa: te estas escuchando con el microfono seleccionado.', 'success');
  } catch (err) {
    stopMicTest();
    setStatus(mediaErrorMessage(err), 'error');
  }
}

function stopMicTest() {
  if (!state.micTestStream) return;

  state.micTestStream.getTracks().forEach(track => track.stop());
  state.micTestStream = null;

  const audio = $('micTestAudio');
  if (audio) {
    audio.pause();
    audio.srcObject = null;
  }

  const button = $('btnMicTest');
  if (button) button.textContent = 'Prueba de microfono';
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
  stopMicTest();
  state.localStream?.getTracks().forEach(track => track.stop());
  stopFallbackHelpers();
  state.localStream = null;
  state.remoteStream = null;
  state.role = '';
  state.currentRoomCode = '';
  state.creatorQuestions = [];
  state.currentQuestionIndex = -1;
  state.micEnabled = true;
  state.camEnabled = true;

  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  clearField('manualOfferCode');
  clearField('manualReceivedCode');
  $('camOffMsg').classList.add('hidden');
  $('creatorQuestionNav')?.classList.add('hidden');
  resetQuizDisplay();
  closeSettingsPanel();
  closeCreatorQuestionsPanel();
  showScreen('menuScreen');
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeSettingsPanel();
    closeCreatorQuestionsPanel();
  }

  const writingTarget = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName);
  if (state.role !== 'creator' || writingTarget) return;

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    showPreviousCreatorQuestion();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    showNextCreatorQuestion();
  }
});

$('creatorQuestionsList')?.addEventListener('input', event => {
  updateCreatorQuestionFromInput(event.target);
});

$('creatorQuestionsList')?.addEventListener('change', event => {
  updateCreatorQuestionFromInput(event.target);
});

updateProfileBadge();
