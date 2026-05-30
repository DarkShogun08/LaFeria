// La Feria - version estatica para GitHub Pages.
// Usa WebRTC con PeerJS para llamadas con codigo corto.

const ROOM_CODE_LENGTH = 12;
const CREATOR_QUESTION_COUNT = 15;
const CREATOR_QUESTION_OPTIONS = ['A', 'B', 'C', 'D'];
const CREATOR_QUESTIONS_FALLBACK_KEY = 'laFeria_creator_questions';
const FAIR_QUESTION_IMAGE_SRC = 'images/WhatsApp%20Image%202026-05-27%20at%2010.57.43%20(1).jpeg';
const ROULETTE_SEGMENTS = [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 1, 1, 2, 3, 1];
const ROULETTE_SEGMENT_DEGREES = 360 / ROULETTE_SEGMENTS.length;
const ROULETTE_SPIN_MS = 5000;
const QUIZ_REVEAL_DELAY_MS = 5000;
const SOUNDS = {
  applauseSound: 'sounds/applause-new.mp3',
  failSound: 'sounds/fail-new.mp3',
  timerSound: 'sounds/Temporizador.mp3',
  waitSound: 'sounds/Espera.mp3',
  rouletteSound: 'sounds/Ruleta.m4a',
};
const QUIZ_SOUND_VOLUME = 0.35;
const TIMER_SOUND_VOLUME = 0.12;
const WAIT_SOUND_VOLUME = 0.2;
const ROULETTE_SOUND_VOLUME = 0.45;

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
  quizActiveSounds: [],
  phoneTimerAudio: null,
  micTestStream: null,
  micTestAudioContext: null,
  micTestSource: null,
  micTestGain: null,
  micEnabled: true,
  camEnabled: true,
  currentRoomCode: '',
  remoteName: '',
  creatorQuestions: [],
  currentQuestionIndex: -1,
  quizRevealStep: -1,
  quizSelectedAnswers: Array(CREATOR_QUESTION_COUNT).fill(null),
  quizResults: Array(CREATOR_QUESTION_COUNT).fill(null),
  quizEliminatedAnswers: Array.from({ length: CREATOR_QUESTION_COUNT }, () => []),
  quizPendingSelection: null,
  quizRevealTimeout: null,
  quizFinalShown: false,
  quizFinalType: '',
  answerDelayEnabled: true,
  phoneTimerRemaining: 30,
  phoneTimerInterval: null,
  phoneTimerVisible: false,
  phoneLifelineUsed: false,
  rouletteVisible: false,
  rouletteSpinning: false,
  rouletteLifelineUsed: false,
  rouletteTimeout: null,
  rouletteTargetDegrees: 0,
  rouletteResultValue: null,
  rouletteMessage: '',
};

function $(id) {
  return document.getElementById(id);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
  if (id === 'profileScreen') $('profileInput').value = state.profile;
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

function generateRoomCode() {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

function validateRoomCode(value) {
  const code = String(value || '').replace(/\D/g, '');
  if (code.length !== ROOM_CODE_LENGTH) {
    throw new Error(`El codigo debe tener ${ROOM_CODE_LENGTH} digitos.`);
  }
  return code;
}

function getRtcConfig() {
  return $('usePublicStun')?.checked ? RTC_CONFIG : { iceServers: [] };
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
  setTimeout(() => showScreen('menuScreen'), 650);
}

function requireProfile(targetMsgId) {
  if (state.profile) return true;
  showMsg(targetMsgId, 'error', 'Primero anade un nombre de perfil.');
  return false;
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
    fairQuestion: false,
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
  question.fairQuestion = Boolean(raw.fairQuestion);
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
  const ok = setLocalStorageItem(creatorQuestionsStorageKey(), JSON.stringify(state.creatorQuestions));
  const label = $('creatorQuestionsSaved');
  if (label) label.textContent = ok
    ? (silent ? 'Guardado automaticamente.' : 'Preguntas guardadas.')
    : 'No se pudieron guardar las preguntas.';
}

function renderCreatorQuestions() {
  const list = $('creatorQuestionsList');
  if (!list) return;
  list.innerHTML = '';
  state.creatorQuestions = normalizeCreatorQuestions(state.creatorQuestions);

  state.creatorQuestions.forEach((question, index) => {
    const item = document.createElement('article');
    item.className = 'creator-question-card';
    item.innerHTML = `
      <h3>Pregunta ${index + 1}</h3>
      <label class="creator-check-row">
        <input data-index="${index}" data-field="fairQuestion" type="checkbox" ${question.fairQuestion ? 'checked' : ''}>
        <span>Pregunta Feria</span>
      </label>
      <label>Texto de la pregunta
        <textarea data-index="${index}" data-field="prompt" rows="2">${escapeHtml(question.prompt)}</textarea>
      </label>
      <div class="creator-answer-grid">
        ${CREATOR_QUESTION_OPTIONS.map(option => `
          <label>${option}
            <input data-index="${index}" data-field="answer" data-option="${option}" value="${escapeAttr(question.answers[option])}">
          </label>
        `).join('')}
      </div>
      <label class="creator-correct-row">Correcta
        <select data-index="${index}" data-field="correct">
          ${CREATOR_QUESTION_OPTIONS.map(option => `<option value="${option}" ${question.correct === option ? 'selected' : ''}>${option}</option>`).join('')}
        </select>
      </label>
    `;
    list.appendChild(item);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function updateCreatorQuestionFromInput(target) {
  if (!target?.dataset) return;
  const index = Number(target.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
  const field = target.dataset.field;
  const question = normalizeCreatorQuestion(state.creatorQuestions[index]);

  if (field === 'prompt') {
    question.prompt = target.value;
  } else if (field === 'answer') {
    const option = target.dataset.option;
    if (CREATOR_QUESTION_OPTIONS.includes(option)) question.answers[option] = target.value;
  } else if (field === 'correct') {
    question.correct = CREATOR_QUESTION_OPTIONS.includes(target.value) ? target.value : 'A';
  } else if (field === 'fairQuestion') {
    question.fairQuestion = Boolean(target.checked);
  }

  state.creatorQuestions[index] = question;
  saveCreatorQuestions(true);
}

function openCreatorQuestionsPanel() {
  if (state.role !== 'creator') return;
  loadCreatorQuestions();
  syncAnswerDelayCheckbox();
  $('creatorQuestionsModal')?.classList.remove('hidden');
}

function closeCreatorQuestionsPanel() {
  $('creatorQuestionsModal')?.classList.add('hidden');
}

function syncAnswerDelayCheckbox() {
  const checkbox = $('answerDelayEnabled');
  if (checkbox) checkbox.checked = state.answerDelayEnabled;
}

function toggleAnswerDelay() {
  state.answerDelayEnabled = Boolean($('answerDelayEnabled')?.checked);
}

function resetQuizRound() {
  clearQuizSuspense();
  document.querySelectorAll('.quiz-final-overlay, .fireworks-layer, .crying-emoji-layer').forEach(item => item.remove());
  state.currentQuestionIndex = -1;
  state.quizRevealStep = -1;
  state.quizSelectedAnswers = Array(CREATOR_QUESTION_COUNT).fill(null);
  state.quizResults = Array(CREATOR_QUESTION_COUNT).fill(null);
  state.quizEliminatedAnswers = Array.from({ length: CREATOR_QUESTION_COUNT }, () => []);
  state.quizPendingSelection = null;
  state.quizFinalShown = false;
  state.quizFinalType = '';
}

function resetQuizDisplay() {
  resetQuizRound();
  const questionLine = $('quizQuestionLine');
  if (questionLine) {
    questionLine.textContent = '';
    questionLine.classList.remove('is-visible');
  }
  document.querySelectorAll('.quiz-answer-line').forEach(line => {
    line.textContent = '';
    line.disabled = true;
    line.classList.remove('is-visible', 'selected', 'correct-answer', 'wrong-answer', 'eliminated-answer');
  });
  document.querySelectorAll('.quiz-progress span').forEach(item => {
    item.classList.remove('pending', 'current', 'correct', 'wrong');
    item.classList.add('locked');
  });
}

function renderQuizProgress() {
  document.querySelectorAll('.quiz-progress span').forEach((item, itemIndex) => {
    const result = state.quizResults[itemIndex];
    item.classList.toggle('current', itemIndex === state.currentQuestionIndex);
    item.classList.toggle('correct', itemIndex !== state.currentQuestionIndex && result === 'correct');
    item.classList.toggle('wrong', itemIndex !== state.currentQuestionIndex && result === 'wrong');
    item.classList.toggle('locked', itemIndex !== state.currentQuestionIndex && !result);
    item.classList.remove('pending');
  });
}

function isSelectionPending(index = state.currentQuestionIndex) {
  return state.quizPendingSelection?.index === index;
}

function displayQuizQuestion(index, question, revealStep = state.quizRevealStep) {
  const safeQuestion = normalizeCreatorQuestion(question);
  const questionLine = $('quizQuestionLine');
  if (questionLine) {
    questionLine.innerHTML = '';
    if (safeQuestion.fairQuestion && revealStep >= 0) {
      const image = document.createElement('img');
      image.className = 'quiz-fair-question-image';
      image.src = FAIR_QUESTION_IMAGE_SRC;
      image.alt = '';
      questionLine.appendChild(image);
    }
    const text = document.createElement('span');
    text.className = 'quiz-question-text';
    text.textContent = safeQuestion.prompt || `Pregunta ${index + 1}`;
    questionLine.appendChild(text);
    questionLine.classList.toggle('is-visible', revealStep >= 0);
    questionLine.classList.toggle('has-fair-image', safeQuestion.fairQuestion && revealStep >= 0);
  }

  CREATOR_QUESTION_OPTIONS.forEach(option => {
    const optionStep = CREATOR_QUESTION_OPTIONS.indexOf(option) + 1;
    const line = document.querySelector(`.quiz-answer-line[data-option="${option}"]`);
    if (!line) return;
    const selected = state.quizSelectedAnswers[index] === option;
    const result = state.quizResults[index];
    const visible = revealStep >= optionStep;
    const eliminated = !state.quizResults[index] && state.quizEliminatedAnswers[index]?.includes(option);
    line.textContent = `${option}: ${safeQuestion.answers[option] || ''}`;
    line.disabled = state.role !== 'creator' || !visible || eliminated || Boolean(state.quizSelectedAnswers[index]) || isSelectionPending(index);
    line.classList.toggle('is-visible', visible);
    line.classList.toggle('eliminated-answer', eliminated);
    line.classList.toggle('selected', selected);
    line.classList.toggle('correct-answer', selected && result === 'correct');
    line.classList.toggle('wrong-answer', selected && result === 'wrong');
  });

  renderQuizProgress();
}

function sendDataMessage(message) {
  if (!state.dataConnection?.open) return false;
  try {
    state.dataConnection.send(message);
    return true;
  } catch (err) {
    console.warn('No se pudo enviar por el canal de datos.', err);
    return false;
  }
}

function setRemoteName(name) {
  const cleanName = String(name || '').trim();
  state.remoteName = cleanName;
  const label = $('remoteNameLabel');
  if (label) label.textContent = cleanName || 'Otra persona';
}

function sendProfileName() {
  sendDataMessage({ type: 'profile-name', name: state.profile || '' });
}

function handleDataMessage(data) {
  if (!data) return;

  if (data.type === 'profile-name') {
    setRemoteName(data.name);
    return;
  }

  if (data.type === 'quiz-pending-selection') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
    state.quizSelectedAnswers[index] = data.option;
    state.quizResults[index] = null;
    state.quizPendingSelection = { index, option: data.option };
    if (state.currentQuestionIndex === index) {
      displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
      playQuizSound('waitSound', WAIT_SOUND_VOLUME);
      showQuizSuspense();
    }
    return;
  }

  if (data.type === 'quiz-selection') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
    clearQuizSuspense();
    state.quizPendingSelection = null;
    state.quizSelectedAnswers[index] = data.option;
    state.quizResults[index] = data.result;
    if (Array.isArray(data.quizResults)) {
      state.quizResults = data.quizResults.slice(0, CREATOR_QUESTION_COUNT);
    }
    if (state.currentQuestionIndex === index) {
      displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
    } else {
      renderQuizProgress();
    }
    playQuizResultEffects(data.result);
    checkQuizFinal();
    return;
  }

  if (data.type === 'quiz-final') {
    showQuizFinal(data.text || (data.finalType === 'victory' ? '\u00A1Enhorabuena!' : '\u00A1Has perdido!'), data.finalType || 'defeat');
    return;
  }

  if (data.type === 'quiz-final-clear') {
    dismissQuizFinal(false);
    return;
  }

  if (data.type === 'quiz-eliminations') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
    state.quizEliminatedAnswers[index] = Array.isArray(data.eliminated)
      ? data.eliminated.filter(option => CREATOR_QUESTION_OPTIONS.includes(option))
      : [];
    if (state.currentQuestionIndex === index) displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
    return;
  }

  if (data.type === 'phone-lifeline-state') {
    applyPhoneLifelineState(data);
    return;
  }

  if (data.type === 'roulette-lifeline-state') {
    applyRouletteLifelineState(data);
    return;
  }

  if (data.type !== 'quiz-question' && data.type !== 'quiz-state') return;
  const index = Number(data.index);
  if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;
  state.currentQuestionIndex = index;
  state.quizRevealStep = Number.isInteger(data.revealStep) ? data.revealStep : 4;
  state.creatorQuestions = normalizeCreatorQuestions(state.creatorQuestions);
  state.creatorQuestions[index] = normalizeCreatorQuestion(data.question);
  if (Array.isArray(data.quizSelectedAnswers)) state.quizSelectedAnswers = data.quizSelectedAnswers.slice(0, CREATOR_QUESTION_COUNT);
  if (Array.isArray(data.quizResults)) state.quizResults = data.quizResults.slice(0, CREATOR_QUESTION_COUNT);
  if (Array.isArray(data.quizEliminatedAnswers)) state.quizEliminatedAnswers = normalizeEliminatedAnswers(data.quizEliminatedAnswers);
  if (data.quizPendingSelection?.index === index && !state.quizResults[index]) {
    state.quizPendingSelection = { index, option: data.quizPendingSelection.option };
    showQuizSuspense();
  } else {
    state.quizPendingSelection = null;
    clearQuizSuspense();
  }
  displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
}

function bindDataConnection(connection) {
  if (!connection) return;
  if (state.dataConnection && state.dataConnection !== connection) state.dataConnection.close?.();
  state.dataConnection = connection;
  setRemoteName(connection.metadata?.name || state.remoteName);
  connection.on('open', () => {
    sendProfileName();
    if (state.role === 'creator' && state.currentQuestionIndex >= 0) sendQuizState();
    if (state.role === 'creator') {
      sendPhoneLifelineState();
      sendRouletteLifelineState();
    }
  });
  connection.on('data', handleDataMessage);
  connection.on('close', () => {
    if (state.dataConnection === connection) state.dataConnection = null;
  });
  connection.on('error', err => console.warn('Error en canal de datos.', err));
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
  state.quizRevealStep = 0;
  displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
  sendQuizState();
  setStatus(`Pregunta ${index + 1} mostrada.`, 'success');
}

function sendQuizState() {
  if (state.currentQuestionIndex < 0) return;
  sendDataMessage({
    type: 'quiz-state',
    index: state.currentQuestionIndex,
    revealStep: state.quizRevealStep,
    question: state.creatorQuestions[state.currentQuestionIndex],
    quizSelectedAnswers: state.quizSelectedAnswers,
    quizResults: state.quizResults,
    quizEliminatedAnswers: state.quizEliminatedAnswers,
    quizPendingSelection: state.quizPendingSelection,
  });
}

function normalizeEliminatedAnswers(value) {
  return Array.from({ length: CREATOR_QUESTION_COUNT }, (_, index) => {
    const answers = Array.isArray(value?.[index]) ? value[index] : [];
    return answers.filter(option => CREATOR_QUESTION_OPTIONS.includes(option));
  });
}

function showPreviousCreatorQuestion() {
  if (state.role !== 'creator') return;
  closeSettingsPanel();
  if (isSelectionPending()) {
    setStatus('Espera a que se revele la respuesta.', 'info');
    return;
  }
  if (state.currentQuestionIndex < 0) {
    setStatus('Todavia no hay ninguna pregunta en pantalla.', 'info');
    return;
  }
  loadCreatorQuestions();
  if (state.quizRevealStep > 0) {
    state.quizRevealStep -= 1;
    displayQuizQuestion(state.currentQuestionIndex, state.creatorQuestions[state.currentQuestionIndex], state.quizRevealStep);
    sendQuizState();
    return;
  }
  if (state.currentQuestionIndex === 0) {
    setStatus('Ya estas en la primera pregunta.', 'info');
    return;
  }
  state.currentQuestionIndex -= 1;
  state.quizRevealStep = 4;
  displayQuizQuestion(state.currentQuestionIndex, state.creatorQuestions[state.currentQuestionIndex], state.quizRevealStep);
  sendQuizState();
}

function showNextCreatorQuestion() {
  if (state.role !== 'creator') return;
  closeSettingsPanel();
  if (isSelectionPending()) {
    setStatus('Espera a que se revele la respuesta.', 'info');
    return;
  }
  if (state.currentQuestionIndex < 0) {
    showCreatorQuestion(0);
    return;
  }
  loadCreatorQuestions();
  if (state.quizSelectedAnswers[state.currentQuestionIndex]) {
    showCreatorQuestion(state.currentQuestionIndex + 1);
    return;
  }
  if (state.quizRevealStep < 4) {
    state.quizRevealStep += 1;
    displayQuizQuestion(state.currentQuestionIndex, state.creatorQuestions[state.currentQuestionIndex], state.quizRevealStep);
    sendQuizState();
    return;
  }
  showCreatorQuestion(state.currentQuestionIndex + 1);
}

function playQuizSound(id, volume = QUIZ_SOUND_VOLUME) {
  const source = SOUNDS[id] || $(id)?.getAttribute('src');
  if (!source) return;
  try {
    const audio = new Audio(source);
    audio.preload = 'auto';
    audio.volume = volume;
    state.quizActiveSounds.push(audio);
    audio.addEventListener('ended', () => {
      state.quizActiveSounds = state.quizActiveSounds.filter(item => item !== audio);
    }, { once: true });
    audio.play()?.catch(err => {
      console.warn('No se pudo reproducir el sonido.', err);
      state.quizActiveSounds = state.quizActiveSounds.filter(item => item !== audio);
    });
  } catch (err) {
    console.warn('No se pudo preparar el sonido.', err);
  }
}

function playPhoneTimerSound(offsetSeconds = 0) {
  stopPhoneTimerSound();
  try {
    const audio = new Audio(SOUNDS.timerSound);
    audio.preload = 'auto';
    audio.volume = TIMER_SOUND_VOLUME;
    audio.currentTime = Math.max(0, Math.min(29.5, offsetSeconds));
    state.phoneTimerAudio = audio;
    audio.addEventListener('ended', () => {
      if (state.phoneTimerAudio === audio) state.phoneTimerAudio = null;
    }, { once: true });
    audio.play()?.catch(err => console.warn('No se pudo reproducir el temporizador.', err));
  } catch (err) {
    console.warn('No se pudo preparar el temporizador.', err);
  }
}

function stopPhoneTimerSound() {
  if (!state.phoneTimerAudio) return;
  try {
    state.phoneTimerAudio.pause();
    state.phoneTimerAudio.currentTime = 0;
  } catch (err) {
    console.warn('No se pudo parar el temporizador.', err);
  }
  state.phoneTimerAudio = null;
}

function playQuizResultEffects(result) {
  if (result === 'correct') {
    playQuizSound('applauseSound');
    launchConfetti();
  } else if (result === 'wrong') {
    playQuizSound('failSound');
  }
}

function updatePhoneTimerDisplay() {
  const timer = $('phoneTimer');
  if (timer) timer.textContent = String(state.phoneTimerRemaining).padStart(2, '0');
  const viewerOnly = state.role !== 'creator';
  $('phoneLifelinePanel')?.classList.toggle('hidden', !state.phoneTimerVisible);
  $('phoneLifelinePanel')?.classList.toggle('viewer-only', viewerOnly);
  $('phoneTimerLabel')?.classList.toggle('hidden', viewerOnly);
  $('phoneControls')?.classList.toggle('hidden', viewerOnly);
  const startButton = $('phoneStartBtn');
  if (startButton) startButton.disabled = Boolean(state.phoneTimerInterval);
  const pauseButton = $('phonePauseBtn');
  if (pauseButton) pauseButton.disabled = !state.phoneTimerInterval;
  const finishButton = $('phoneFinishBtn');
  if (finishButton) finishButton.disabled = state.phoneTimerRemaining <= 0;
  updateLifelineButtonState();
}

function confirmLifelineReuse(type) {
  const used = type === 'phone' ? state.phoneLifelineUsed : state.rouletteLifelineUsed;
  if (!used) return true;
  return window.confirm('Ya has usado este comodin, ¿Seguro que quieres volver a usarlo?');
}

function updateLifelineButtonState() {
  const viewerOnly = state.role !== 'creator';
  const bar = $('creatorLifelines');
  const phoneButton = $('phoneLifelineBtn');
  const rouletteButton = $('rouletteLifelineBtn');
  bar?.classList.toggle('viewer-lifelines', viewerOnly);
  phoneButton?.classList.toggle('is-used', state.phoneLifelineUsed);
  rouletteButton?.classList.toggle('is-used', state.rouletteLifelineUsed);
  [phoneButton, rouletteButton].forEach(button => {
    if (!button) return;
    button.setAttribute('aria-disabled', viewerOnly ? 'true' : 'false');
    button.tabIndex = viewerOnly ? -1 : 0;
  });
}

function sendPhoneLifelineState() {
  if (state.role !== 'creator') return;
  sendDataMessage({
    type: 'phone-lifeline-state',
    visible: state.phoneTimerVisible,
    remaining: state.phoneTimerRemaining,
    running: Boolean(state.phoneTimerInterval),
    used: state.phoneLifelineUsed,
  });
}

function stopPhoneTimerInterval() {
  if (state.phoneTimerInterval && state.phoneTimerInterval !== true) clearInterval(state.phoneTimerInterval);
  state.phoneTimerInterval = null;
}

function applyPhoneLifelineState(data) {
  if (state.role === 'creator') return;
  const wasRunning = Boolean(state.phoneTimerInterval);
  state.phoneTimerVisible = Boolean(data.visible);
  state.phoneTimerRemaining = Number.isFinite(Number(data.remaining))
    ? Math.max(0, Math.min(30, Math.round(Number(data.remaining))))
    : 30;
  if ('used' in data) state.phoneLifelineUsed = Boolean(data.used);
  stopPhoneTimerInterval();
  if (data.running && state.phoneTimerVisible && state.phoneTimerRemaining > 0) {
    state.phoneTimerInterval = true;
    if (!wasRunning && !state.phoneTimerAudio) playPhoneTimerSound(30 - state.phoneTimerRemaining);
  } else {
    stopPhoneTimerSound();
  }
  updatePhoneTimerDisplay();
}

function openPhoneLifeline() {
  if (state.role !== 'creator') return;
  if (state.phoneTimerVisible) {
    closePhoneLifeline();
    return;
  }
  if (state.rouletteVisible) {
    setStatus('Quita la ruleta antes de poner el contador.', 'info');
    return;
  }
  state.phoneTimerVisible = true;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function closePhoneLifeline() {
  if (state.role !== 'creator') return;
  stopPhoneTimerInterval();
  stopPhoneTimerSound();
  state.phoneTimerVisible = false;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function startPhoneLifeline() {
  if (state.role !== 'creator' || state.phoneTimerInterval) return;
  if (state.rouletteVisible) {
    setStatus('Quita la ruleta antes de iniciar el contador.', 'info');
    return;
  }
  if (state.phoneLifelineUsed && state.phoneTimerRemaining <= 0 && !confirmLifelineReuse('phone')) return;
  if (state.phoneTimerRemaining <= 0) state.phoneTimerRemaining = 30;
  state.phoneTimerVisible = true;
  state.phoneLifelineUsed = true;
  playPhoneTimerSound(30 - state.phoneTimerRemaining);
  state.phoneTimerInterval = setInterval(() => {
    state.phoneTimerRemaining = Math.max(0, state.phoneTimerRemaining - 1);
    updatePhoneTimerDisplay();
    sendPhoneLifelineState();
    if (state.phoneTimerRemaining <= 0) {
      stopPhoneTimerInterval();
      stopPhoneTimerSound();
      updatePhoneTimerDisplay();
      sendPhoneLifelineState();
    }
  }, 1000);
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function pausePhoneLifeline() {
  if (state.role !== 'creator') return;
  stopPhoneTimerInterval();
  stopPhoneTimerSound();
  state.phoneTimerVisible = true;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function finishPhoneLifeline() {
  if (state.role !== 'creator') return;
  stopPhoneTimerInterval();
  stopPhoneTimerSound();
  state.phoneTimerVisible = true;
  state.phoneTimerRemaining = 0;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function resetPhoneLifeline() {
  stopPhoneTimerInterval();
  stopPhoneTimerSound();
  state.phoneTimerRemaining = 30;
  state.phoneTimerVisible = false;
  updatePhoneTimerDisplay();
}

function stopRouletteTimeout() {
  if (state.rouletteTimeout) clearTimeout(state.rouletteTimeout);
  state.rouletteTimeout = null;
}

function updateRouletteDisplay() {
  const viewerOnly = state.role !== 'creator';
  $('rouletteLifelineModal')?.classList.toggle('hidden', !state.rouletteVisible);
  $('rouletteLifelineModal')?.classList.toggle('viewer-only', viewerOnly);
  $('rouletteSpinBtn')?.classList.toggle('hidden', viewerOnly);
  updateLifelineButtonState();
}

function sendRouletteLifelineState(extra = {}) {
  if (state.role !== 'creator') return;
  sendDataMessage({
    type: 'roulette-lifeline-state',
    visible: state.rouletteVisible,
    spinning: state.rouletteSpinning,
    targetDegrees: state.rouletteTargetDegrees,
    result: state.rouletteResultValue,
    message: state.rouletteMessage,
    used: state.rouletteLifelineUsed,
    ...extra,
  });
}

function finishRouletteSpinVisual(targetDegrees, result) {
  const wheel = $('rouletteWheel');
  state.rouletteSpinning = false;
  state.rouletteTimeout = null;
  wheel?.classList.remove('is-spinning');
  wheel?.style.setProperty('transform', `rotate(${targetDegrees}deg)`);
  const label = $('rouletteResult');
  if (label) label.textContent = String(result);
}

function applyRouletteSpin(targetDegrees, result, message, scheduleCompletion = true) {
  const wheel = $('rouletteWheel');
  stopRouletteTimeout();
  playQuizSound('rouletteSound', ROULETTE_SOUND_VOLUME);
  state.rouletteSpinning = true;
  state.rouletteVisible = true;
  state.rouletteTargetDegrees = targetDegrees;
  state.rouletteResultValue = result;
  state.rouletteMessage = message || 'La ruleta esta girando...';
  updateRouletteDisplay();
  wheel?.classList.remove('is-spinning');
  if (wheel) wheel.style.transform = 'rotate(0deg)';
  void wheel?.offsetWidth;
  wheel?.style.setProperty('--roulette-spin', `${targetDegrees}deg`);
  wheel?.classList.add('is-spinning');
  const label = $('rouletteResult');
  if (label) label.textContent = '?';
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = state.rouletteMessage;
  if (scheduleCompletion) {
    state.rouletteTimeout = setTimeout(() => finishRouletteSpinVisual(targetDegrees, result), ROULETTE_SPIN_MS);
  }
}

function applyRouletteLifelineState(data) {
  if (state.role === 'creator') return;
  state.rouletteVisible = Boolean(data.visible);
  if ('used' in data) state.rouletteLifelineUsed = Boolean(data.used);
  updateRouletteDisplay();
  if (!state.rouletteVisible) {
    stopRouletteTimeout();
    state.rouletteSpinning = false;
    $('rouletteWheel')?.classList.remove('is-spinning');
    return;
  }
  const hasResult = data.result !== null && data.result !== undefined && data.result !== '';
  const label = $('rouletteResult');
  if (hasResult && Number.isFinite(Number(data.result)) && !data.spinning && label) {
    label.textContent = String(data.result);
    if (Number.isFinite(Number(data.targetDegrees))) {
      $('rouletteWheel')?.style.setProperty('transform', `rotate(${Number(data.targetDegrees)}deg)`);
    }
  } else if (label && !data.spinning) {
    label.textContent = '?';
  }
  const copy = $('rouletteCopy');
  if (copy && data.message) copy.textContent = data.message;
  if (data.spinning && hasResult && Number.isFinite(Number(data.targetDegrees))) {
    applyRouletteSpin(Number(data.targetDegrees), Number(data.result), data.message);
  }
}

function openRouletteLifeline() {
  if (state.role !== 'creator') return;
  if (state.phoneTimerVisible) {
    setStatus('Quita el contador antes de poner la ruleta.', 'info');
    return;
  }
  const modal = $('rouletteLifelineModal');
  if (modal && !modal.classList.contains('hidden')) {
    closeRouletteLifeline();
    return;
  }
  state.rouletteVisible = true;
  state.rouletteResultValue = null;
  state.rouletteTargetDegrees = 0;
  state.rouletteMessage = 'Gira para eliminar respuestas incorrectas visibles.';
  updateRouletteDisplay();
  const label = $('rouletteResult');
  if (label) label.textContent = '?';
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = state.rouletteMessage;
  sendRouletteLifelineState({ result: null });
}

function closeRouletteLifeline(force = false) {
  if (state.role !== 'creator' && !force) return;
  if (state.rouletteSpinning && !force) return;
  stopRouletteTimeout();
  state.rouletteVisible = false;
  state.rouletteSpinning = false;
  state.rouletteMessage = '';
  $('rouletteWheel')?.classList.remove('is-spinning');
  updateRouletteDisplay();
  sendRouletteLifelineState();
}

function resetRouletteLifeline() {
  stopRouletteTimeout();
  state.rouletteVisible = false;
  state.rouletteSpinning = false;
  state.rouletteTargetDegrees = 0;
  state.rouletteResultValue = null;
  state.rouletteMessage = '';
  $('rouletteWheel')?.classList.remove('is-spinning');
  $('rouletteWheel')?.style.setProperty('transform', 'rotate(0deg)');
  const label = $('rouletteResult');
  if (label) label.textContent = '?';
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = 'Gira para eliminar respuestas incorrectas visibles.';
  const spinButton = $('rouletteSpinBtn');
  if (spinButton) spinButton.disabled = false;
  updateRouletteDisplay();
}

function weightedRouletteResult() {
  const roll = Math.random();
  if (roll < 0.1) return 0;
  if (roll < 0.6) return 1;
  if (roll < 0.9) return 2;
  return 3;
}

function pickRouletteSegment(result) {
  const matchingSegments = ROULETTE_SEGMENTS
    .map((value, index) => value === result ? index : -1)
    .filter(index => index >= 0);
  return matchingSegments[Math.floor(Math.random() * matchingSegments.length)] ?? 0;
}

function spinRouletteLifeline() {
  if (state.role !== 'creator' || state.rouletteSpinning) return;
  if (state.phoneTimerVisible) {
    setStatus('Quita el contador antes de girar la ruleta.', 'info');
    return;
  }
  if (state.rouletteLifelineUsed && !confirmLifelineReuse('roulette')) return;
  if (state.currentQuestionIndex < 0) {
    const copy = $('rouletteCopy');
    if (copy) copy.textContent = 'Primero muestra una pregunta.';
    return;
  }
  const targetQuestionIndex = state.currentQuestionIndex;
  const result = weightedRouletteResult();
  const segmentIndex = pickRouletteSegment(result);
  const segmentAngle = segmentIndex * ROULETTE_SEGMENT_DEGREES;
  const targetDegrees = (10 * 360) + ((360 - segmentAngle) % 360);
  state.rouletteLifelineUsed = true;
  state.rouletteVisible = true;
  const spinButton = $('rouletteSpinBtn');
  if (spinButton) spinButton.disabled = true;
  applyRouletteSpin(targetDegrees, result, 'La ruleta esta girando...', false);
  sendRouletteLifelineState({ spinning: true, targetDegrees, result, message: 'La ruleta esta girando...' });
  state.rouletteTimeout = setTimeout(() => {
    finishRouletteSpinVisual(targetDegrees, result);
    if (spinButton) spinButton.disabled = false;
    const message = applyRouletteElimination(result, targetQuestionIndex);
    state.rouletteMessage = message;
    state.rouletteResultValue = result;
    sendRouletteLifelineState({ spinning: false, targetDegrees, result, message });
  }, ROULETTE_SPIN_MS);
}

function applyRouletteElimination(count, index = state.currentQuestionIndex) {
  const question = normalizeCreatorQuestion(state.creatorQuestions[index]);
  const alreadyEliminated = state.quizEliminatedAnswers[index] || [];
  const candidates = CREATOR_QUESTION_OPTIONS
    .filter(option => option !== question.correct)
    .filter(option => state.quizRevealStep >= CREATOR_QUESTION_OPTIONS.indexOf(option) + 1)
    .filter(option => !alreadyEliminated.includes(option));
  const shuffled = candidates
    .map(option => ({ option, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(item => item.option);
  const eliminatedNow = shuffled.slice(0, Math.max(0, count));
  state.quizEliminatedAnswers[index] = [...alreadyEliminated, ...eliminatedNow];
  if (state.currentQuestionIndex === index) displayQuizQuestion(index, question, state.quizRevealStep);
  sendDataMessage({ type: 'quiz-eliminations', index, eliminated: state.quizEliminatedAnswers[index] });
  const message = count === 0
    ? 'Resultado 0: no se elimina ninguna respuesta.'
    : `Resultado ${count}: eliminadas ${eliminatedNow.length} respuesta(s) incorrecta(s).`;
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = message;
  return message;
}

function selectQuizAnswer(option) {
  if (state.role !== 'creator') return;
  if (state.currentQuestionIndex < 0) return;
  if (!CREATOR_QUESTION_OPTIONS.includes(option)) return;
  if (state.quizRevealStep < CREATOR_QUESTION_OPTIONS.indexOf(option) + 1) return;
  if (state.quizEliminatedAnswers[state.currentQuestionIndex]?.includes(option)) return;
  if (state.quizSelectedAnswers[state.currentQuestionIndex]) return;
  if (isSelectionPending()) return;
  const index = state.currentQuestionIndex;
  const question = normalizeCreatorQuestion(state.creatorQuestions[index]);
  const result = question.correct === option ? 'correct' : 'wrong';
  state.quizSelectedAnswers[index] = option;
  state.quizResults[index] = null;
  displayQuizQuestion(index, question, state.quizRevealStep);
  if (!state.answerDelayEnabled) {
    revealQuizAnswer(index, option, result);
    return;
  }
  state.quizPendingSelection = { index, option };
  playQuizSound('waitSound', WAIT_SOUND_VOLUME);
  showQuizSuspense();
  sendDataMessage({ type: 'quiz-pending-selection', index, option });
  state.quizRevealTimeout = setTimeout(() => revealQuizAnswer(index, option, result), QUIZ_REVEAL_DELAY_MS);
}

function revealQuizAnswer(index, option, result) {
  clearQuizSuspense();
  state.quizPendingSelection = null;
  state.quizSelectedAnswers[index] = option;
  state.quizResults[index] = result;
  if (state.currentQuestionIndex === index) displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
  else renderQuizProgress();
  playQuizResultEffects(result);
  sendDataMessage({ type: 'quiz-selection', index, option, result, quizResults: state.quizResults });
  checkQuizFinal();
}

function clearQuizSuspense() {
  if (state.quizRevealTimeout) clearTimeout(state.quizRevealTimeout);
  state.quizRevealTimeout = null;
  document.querySelectorAll('.quiz-suspense-overlay').forEach(item => item.remove());
}

function showQuizSuspense() {
  clearQuizSuspense();
}

function checkQuizFinal() {
  if (state.quizFinalShown) return;
  if (state.quizResults.includes('wrong')) {
    showQuizFinal('\u00A1Has perdido!', 'defeat');
    return;
  }
  if (!state.quizResults.every(Boolean)) return;
  showQuizFinal('\u00A1Enhorabuena!', 'victory');
}

function showQuizFinal(text, type) {
  if (state.quizFinalShown && state.quizFinalType === type) return;
  document.querySelectorAll('.quiz-final-overlay, .crying-emoji-layer').forEach(item => item.remove());
  state.quizFinalShown = true;
  state.quizFinalType = type;
  const overlay = document.createElement('div');
  overlay.className = `quiz-final-overlay ${type}`;
  const title = document.createElement('span');
  title.className = 'quiz-final-title';
  title.textContent = text;
  overlay.appendChild(title);
  if (state.role === 'creator') {
    const button = document.createElement('button');
    button.className = 'quiz-final-dismiss';
    button.type = 'button';
    button.textContent = 'Quitar';
    button.addEventListener('click', () => dismissQuizFinal(true));
    overlay.appendChild(button);
  }
  document.body.appendChild(overlay);
  setTimeout(() => overlay.classList.add('is-visible'), 30);
  if (type === 'victory') {
    launchConfetti({ count: 520, duration: 6200 });
    launchFireworks();
  } else {
    launchCryingEmojis();
  }
  if (state.role === 'creator') {
    sendDataMessage({ type: 'quiz-final', finalType: type, text });
  }
}

function dismissQuizFinal(send = true) {
  document.querySelectorAll('.quiz-final-overlay, .crying-emoji-layer, .fireworks-layer').forEach(item => item.remove());
  state.quizFinalShown = false;
  state.quizFinalType = '';
  if (send && state.role === 'creator') sendDataMessage({ type: 'quiz-final-clear' });
}

function launchCryingEmojis() {
  const layer = document.createElement('div');
  layer.className = 'crying-emoji-layer';
  document.body.appendChild(layer);
  for (let index = 0; index < 18; index += 1) {
    const emoji = document.createElement('span');
    emoji.textContent = index % 3 === 0 ? '\u{1F62D}' : '\u{1F622}';
    emoji.style.left = `${5 + Math.random() * 90}%`;
    emoji.style.animationDelay = `${Math.random() * 1.8}s`;
    emoji.style.animationDuration = `${3.8 + Math.random() * 2.2}s`;
    emoji.style.setProperty('--emoji-drift', `${(Math.random() - 0.5) * 180}px`);
    layer.appendChild(emoji);
  }
}

function launchConfetti(options = {}) {
  const count = options.count || 180;
  const duration = options.duration || 3800;
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  document.body.appendChild(layer);
  const colors = ['#42e37f', '#ffd43d', '#ff2557', '#26b7ff', '#fff3cf'];
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.width = `${7 + Math.random() * 9}px`;
    piece.style.height = `${12 + Math.random() * 16}px`;
    piece.style.background = colors[index % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.58}s`;
    piece.style.animationDuration = `${2.1 + Math.random() * 1.1}s`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 360}px`);
    layer.appendChild(piece);
  }
  setTimeout(() => layer.remove(), duration);
}

function launchFireworks() {
  const layer = document.createElement('div');
  layer.className = 'fireworks-layer';
  document.body.appendChild(layer);
  for (let burst = 0; burst < 12; burst += 1) {
    const firework = document.createElement('span');
    firework.className = 'firework-burst';
    firework.style.left = `${12 + Math.random() * 76}%`;
    firework.style.top = `${10 + Math.random() * 58}%`;
    firework.style.animationDelay = `${Math.random() * 1.8}s`;
    firework.style.setProperty('--firework-color', ['#ffd43d', '#ff2557', '#42e37f', '#26b7ff'][burst % 4]);
    layer.appendChild(firework);
  }
  setTimeout(() => layer.remove(), 7200);
}

async function createFallbackAudioTrack() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    state.audioFallbackContext = context;
    state.audioFallbackOscillator = oscillator;
    const [track] = destination.stream.getAudioTracks();
    if (track) track._laFeriaFallback = true;
    return track || null;
  } catch (err) {
    return null;
  }
}

function createFallbackVideoTrack() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff3cf';
    ctx.font = 'bold 34px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Camara apagada', canvas.width / 2, canvas.height / 2);
    const stream = canvas.captureStream(8);
    state.videoFallbackCanvas = canvas;
    const [track] = stream.getVideoTracks();
    if (track) track._laFeriaFallback = true;
    return track || null;
  } catch (err) {
    return null;
  }
}

function isFallbackTrack(track) {
  return Boolean(track?._laFeriaFallback);
}

async function getOutgoingTrack(kind, deviceId = '') {
  if (deviceId === '__none__') return kind === 'audio'
    ? await createFallbackAudioTrack()
    : createFallbackVideoTrack();

  try {
    const constraints = kind === 'audio'
      ? { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false }
      : { audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return stream.getTracks().find(track => track.kind === kind) || null;
  } catch (err) {
    return kind === 'audio' ? await createFallbackAudioTrack() : createFallbackVideoTrack();
  }
}

async function ensureLocalMedia() {
  if (state.localStream?.getTracks().length) return state.localStream;
  const stream = new MediaStream();
  const audioTrack = await getOutgoingTrack('audio', state.selectedAudioDeviceId);
  const videoTrack = await getOutgoingTrack('video', state.selectedVideoDeviceId);
  if (audioTrack) stream.addTrack(audioTrack);
  if (videoTrack) stream.addTrack(videoTrack);
  state.localStream = stream;
  $('localVideo').srcObject = stream;
  $('camOffMsg').classList.toggle('hidden', Boolean(videoTrack && !isFallbackTrack(videoTrack)));
  await refreshDeviceLists();
  updateControls();
  return stream;
}

async function refreshDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillDeviceSelect($('audioDeviceSelect'), devices.filter(device => device.kind === 'audioinput'), 'Sin microfono', state.selectedAudioDeviceId);
    fillDeviceSelect($('videoDeviceSelect'), devices.filter(device => device.kind === 'videoinput'), 'Sin camara', state.selectedVideoDeviceId);
  } catch (err) {
    console.warn('No se pudieron listar dispositivos.', err);
  }
}

function fillDeviceSelect(select, devices, noneLabel, selectedId) {
  if (!select) return;
  const current = selectedId || select.value;
  select.innerHTML = '';
  select.appendChild(new Option(noneLabel, '__none__'));
  devices.forEach((device, index) => {
    const label = device.label || `${noneLabel.replace('Sin ', '')} ${index + 1}`;
    select.appendChild(new Option(label, device.deviceId));
  });
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

async function replaceLocalTrack(kind, nextTrack) {
  if (!state.localStream) state.localStream = new MediaStream();
  state.localStream.getTracks()
    .filter(track => track.kind === kind)
    .forEach(track => {
      state.localStream.removeTrack(track);
      track.stop();
    });
  if (nextTrack) state.localStream.addTrack(nextTrack);
  $('localVideo').srcObject = state.localStream;
  const sender = state.currentCall?.peerConnection?.getSenders?.().find(item => item.track?.kind === kind);
  if (sender) await sender.replaceTrack(nextTrack && !isFallbackTrack(nextTrack) ? nextTrack : null);
}

async function changeAudioDevice() {
  const select = $('audioDeviceSelect');
  if (!select) return;
  stopMicTest();
  state.selectedAudioDeviceId = select.value;
  state.micEnabled = select.value !== '__none__';
  const track = await getOutgoingTrack('audio', select.value);
  await replaceLocalTrack('audio', track);
  await refreshDeviceLists();
  updateControls();
}

async function changeVideoDevice() {
  const select = $('videoDeviceSelect');
  if (!select) return;
  state.selectedVideoDeviceId = select.value;
  state.camEnabled = select.value !== '__none__';
  const track = await getOutgoingTrack('video', select.value);
  await replaceLocalTrack('video', track);
  $('camOffMsg').classList.toggle('hidden', Boolean(track && !isFallbackTrack(track)));
  await refreshDeviceLists();
  updateControls();
}

function getLocalTrack(kind) {
  return state.localStream?.getTracks().find(track => track.kind === kind) || null;
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
    $('camOffMsg').classList.remove('hidden');
    updateControls();
    setStatus('No hay camara activa. Elige una en ajustes.', 'info');
    return;
  }
  state.camEnabled = !state.camEnabled;
  track.enabled = state.camEnabled;
  $('camOffMsg').classList.toggle('hidden', state.camEnabled);
  updateControls();
}

function updateControls() {
  const audioTrack = getLocalTrack('audio');
  const videoTrack = getLocalTrack('video');
  const micActive = Boolean(audioTrack && !isFallbackTrack(audioTrack) && state.micEnabled);
  const camActive = Boolean(videoTrack && !isFallbackTrack(videoTrack) && state.camEnabled);
  $('btnMic')?.classList.toggle('active', micActive);
  $('btnMic')?.classList.toggle('muted-state', !micActive);
  $('btnCam')?.classList.toggle('active', camActive);
  $('btnCam')?.classList.toggle('muted-state', !camActive);
  if ($('micLabel')) $('micLabel').textContent = micActive ? 'Micro activo' : 'Micro silenciado';
  if ($('camLabel')) $('camLabel').textContent = camActive ? 'Camara activa' : 'Camara apagada';
}

async function toggleMicTest() {
  if (state.micTestAudioContext) {
    stopMicTest();
    return;
  }
  const track = getLocalTrack('audio');
  if (!track || isFallbackTrack(track)) {
    setStatus('No hay microfono real para probar.', 'info');
    return;
  }
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const stream = new MediaStream([track.clone()]);
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = 0.85;
    source.connect(gain);
    gain.connect(context.destination);
    state.micTestStream = stream;
    state.micTestAudioContext = context;
    state.micTestSource = source;
    state.micTestGain = gain;
    $('btnMicTest').textContent = 'Parar prueba';
  } catch (err) {
    setStatus('No se pudo iniciar la prueba de microfono.', 'error');
  }
}

function stopMicTest() {
  state.micTestStream?.getTracks().forEach(track => track.stop());
  state.micTestAudioContext?.close?.();
  state.micTestStream = null;
  state.micTestAudioContext = null;
  state.micTestSource = null;
  state.micTestGain = null;
  const button = $('btnMicTest');
  if (button) button.textContent = 'Prueba de microfono';
}

function createSignalingPeer(id) {
  closePeer();
  return new Promise((resolve, reject) => {
    const peer = new Peer(id || undefined, { debug: 0 });
    state.peer = peer;
    let settled = false;
    peer.on('open', openId => {
      if (settled) return;
      settled = true;
      resolve(openId);
    });
    peer.on('error', err => {
      if (!settled) {
        settled = true;
        state.peer = null;
        peer.destroy();
        reject(err);
      } else {
        setStatus(peerErrorMessage(err), 'error');
      }
    });
  });
}

async function createRoomPeer() {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
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

function isActiveMediaCall(call) {
  const pc = call?.peerConnection;
  if (!pc) return false;
  const connectionState = pc.connectionState || pc.iceConnectionState;
  return ['new', 'checking', 'connecting', 'connected', 'completed'].includes(connectionState);
}

function clearRemoteCall(call, message) {
  if (call && state.currentCall && call !== state.currentCall) return;
  state.currentCall = null;
  state.remoteStream = null;
  $('remoteVideo').srcObject = null;
  $('waitingPanel').classList.remove('hidden');
  if (message) setStatus(message, 'info');
}

function bindCallEvents(call) {
  state.currentCall = call;
  setRemoteName(call.metadata?.name || state.remoteName);
  call.on('stream', attachRemoteStream);
  call.on('close', () => {
    clearRemoteCall(call, state.role === 'creator'
      ? 'La otra persona salio. Puede volver a unirse con el mismo codigo.'
      : 'La llamada se ha cerrado.');
  });
  call.on('error', err => {
    clearRemoteCall(call);
    setStatus(peerErrorMessage(err), 'error');
  });
}

function answerIncomingCall(call) {
  if (!state.localStream) {
    call.close();
    return;
  }
  if (state.currentCall) {
    if (isActiveMediaCall(state.currentCall)) {
      call.close();
      return;
    }
    clearRemoteCall(state.currentCall, 'Reconectando a la otra persona...');
  }
  setRemoteName(call.metadata?.name || '');
  setStatus('Otra persona entro. Activando llamada...', 'info');
  bindCallEvents(call);
  call.answer(state.localStream, { metadata: { name: state.profile } });
}

function closePeer() {
  state.currentCall?.close?.();
  state.dataConnection?.close?.();
  state.peer?.destroy?.();
  state.currentCall = null;
  state.dataConnection = null;
  state.peer = null;
}

function stopFallbackHelpers() {
  try {
    state.audioFallbackOscillator?.stop?.();
    state.audioFallbackContext?.close?.();
  } catch (err) {
    // Ignore cleanup errors from already-stopped tracks.
  }
  state.audioFallbackOscillator = null;
  state.audioFallbackContext = null;
  state.videoFallbackCanvas = null;
}

function prepareCallScreen(role) {
  state.role = role;
  state.remoteName = '';
  if (role !== 'creator') {
    state.creatorQuestions = [];
    closeCreatorQuestionsPanel();
  }
  $('localNameLabel').textContent = state.profile || 'Tu';
  setRemoteName('');
  $('remoteVideo').srcObject = null;
  $('waitingPanel').classList.remove('hidden');
  $('creatorPanel').classList.toggle('hidden', role !== 'creator');
  $('guestPanel').classList.toggle('hidden', role !== 'guest');
  $('creatorQuestionNav')?.classList.toggle('hidden', role !== 'creator');
  $('creatorLifelines')?.classList.remove('hidden');
  $('creatorLifelines')?.classList.toggle('viewer-lifelines', role !== 'creator');
  state.phoneLifelineUsed = false;
  state.rouletteLifelineUsed = false;
  state.answerDelayEnabled = true;
  syncAnswerDelayCheckbox();
  resetPhoneLifeline();
  resetRouletteLifeline();
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
    const call = state.peer.call(code, state.localStream, { metadata: { name: state.profile } });
    if (!call) throw new Error('No se pudo iniciar la llamada.');
    bindCallEvents(call);
    bindDataConnection(state.peer.connect(code, { reliable: true, metadata: { name: state.profile } }));
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

function toggleSettingsPanel() {
  $('settingsPanel')?.classList.toggle('hidden');
}

function closeSettingsPanel() {
  $('settingsPanel')?.classList.add('hidden');
}

function clearField(id) {
  const el = $(id);
  if (el) el.value = '';
}

function leaveRoom() {
  closePeer();
  stopMicTest();
  stopPhoneTimerSound();
  state.localStream?.getTracks().forEach(track => track.stop());
  stopFallbackHelpers();
  state.localStream = null;
  state.remoteStream = null;
  state.role = '';
  state.currentRoomCode = '';
  state.creatorQuestions = [];
  state.currentQuestionIndex = -1;
  state.quizEliminatedAnswers = Array.from({ length: CREATOR_QUESTION_COUNT }, () => []);
  state.micEnabled = true;
  state.camEnabled = true;
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  clearField('manualOfferCode');
  clearField('manualReceivedCode');
  $('camOffMsg').classList.add('hidden');
  $('creatorQuestionNav')?.classList.add('hidden');
  $('creatorLifelines')?.classList.add('hidden');
  state.phoneLifelineUsed = false;
  state.rouletteLifelineUsed = false;
  resetPhoneLifeline();
  resetRouletteLifeline();
  resetQuizDisplay();
  closeSettingsPanel();
  closeCreatorQuestionsPanel();
  showScreen('menuScreen');
}

function setupErrorMessage(err) {
  return err?.message || 'No se pudo preparar la llamada.';
}

function peerErrorMessage(err) {
  if (err?.type === 'peer-unavailable') return 'No se encontro una sala con ese codigo.';
  if (err?.type === 'unavailable-id') return 'Ese codigo ya esta ocupado. Prueba otra vez.';
  return err?.message || 'Error de conexion.';
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

$('creatorQuestionsList')?.addEventListener('input', event => updateCreatorQuestionFromInput(event.target));
$('creatorQuestionsList')?.addEventListener('change', event => updateCreatorQuestionFromInput(event.target));

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', refreshDeviceLists);
}

window.addEventListener('beforeunload', () => {
  state.localStream?.getTracks().forEach(track => track.stop());
  closePeer();
});

updateProfileBadge();
