// La Feria - version estatica para GitHub Pages.
// Usa WebRTC con PeerJS para que el codigo compartido sea corto.

const ROOM_CODE_LENGTH = 12;
const CREATOR_QUESTION_COUNT = 15;
const CREATOR_QUESTION_OPTIONS = ['A', 'B', 'C', 'D'];
const CREATOR_QUESTIONS_FALLBACK_KEY = 'laFeria_creator_questions';
const ROULETTE_SEGMENTS = [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 1, 1, 2, 3, 1];
const ROULETTE_SEGMENT_DEGREES = 360 / ROULETTE_SEGMENTS.length;
const ROULETTE_SPIN_MS = 5200;
const SOUNDS = {
  applauseSound: 'sounds/applause-new.mp3',
  failSound: 'sounds/fail-new.mp3',
};
const QUIZ_SOUND_VOLUME = 0.35;

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
  quizAudioContext: null,
  quizAudioBuffers: {},
  quizAudioUnlocked: false,
  quizActiveSounds: [],
  micTestStream: null,
  micTestAudioContext: null,
  micTestSource: null,
  micTestGain: null,
  micEnabled: true,
  camEnabled: true,
  currentRoomCode: '',
  creatorQuestions: [],
  currentQuestionIndex: -1,
  quizRevealStep: -1,
  quizSelectedAnswers: Array(CREATOR_QUESTION_COUNT).fill(null),
  quizResults: Array(CREATOR_QUESTION_COUNT).fill(null),
  quizEliminatedAnswers: Array.from({ length: CREATOR_QUESTION_COUNT }, () => []),
  phoneTimerRemaining: 50,
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

function resetQuizRound() {
  state.currentQuestionIndex = -1;
  state.quizRevealStep = -1;
  state.quizSelectedAnswers = Array(CREATOR_QUESTION_COUNT).fill(null);
  state.quizResults = Array(CREATOR_QUESTION_COUNT).fill(null);
  state.quizEliminatedAnswers = Array.from({ length: CREATOR_QUESTION_COUNT }, () => []);
}

function resetQuizDisplay() {
  resetQuizRound();
  const questionLine = $('quizQuestionLine');
  if (questionLine) questionLine.textContent = '';
  if (questionLine) questionLine.classList.remove('is-visible');
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

function displayQuizQuestion(index, question, revealStep = state.quizRevealStep) {
  const safeQuestion = normalizeCreatorQuestion(question);
  const questionLine = $('quizQuestionLine');
  if (questionLine) {
    questionLine.textContent = safeQuestion.prompt || `Pregunta ${index + 1}`;
    questionLine.classList.toggle('is-visible', revealStep >= 0);
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
    line.disabled = state.role !== 'creator' || !visible || eliminated || Boolean(state.quizSelectedAnswers[index]);
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
    console.warn('No se pudo enviar la pregunta.', err);
    return false;
  }
}

function handleDataMessage(data) {
  if (!data) return;

  if (data.type === 'quiz-selection') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;

    state.quizSelectedAnswers[index] = data.option;
    state.quizResults[index] = data.result;
    if (Array.isArray(data.quizResults)) {
      state.quizResults = data.quizResults.slice(0, CREATOR_QUESTION_COUNT);
    }
    if (state.currentQuestionIndex === index) {
      displayQuizQuestion(state.currentQuestionIndex, state.creatorQuestions[state.currentQuestionIndex], state.quizRevealStep);
    } else {
      renderQuizProgress();
    }
    playQuizResultEffects(data.result);
    return;
  }

  if (data.type === 'quiz-eliminations') {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= CREATOR_QUESTION_COUNT) return;

    state.quizEliminatedAnswers[index] = Array.isArray(data.eliminated)
      ? data.eliminated.filter(option => CREATOR_QUESTION_OPTIONS.includes(option))
      : [];

    if (state.currentQuestionIndex === index) {
      displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
    }
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
  if (Array.isArray(data.quizSelectedAnswers)) {
    state.quizSelectedAnswers = data.quizSelectedAnswers.slice(0, CREATOR_QUESTION_COUNT);
  }
  if (Array.isArray(data.quizResults)) {
    state.quizResults = data.quizResults.slice(0, CREATOR_QUESTION_COUNT);
  }
  if (Array.isArray(data.quizEliminatedAnswers)) {
    state.quizEliminatedAnswers = normalizeEliminatedAnswers(data.quizEliminatedAnswers);
  }
  displayQuizQuestion(index, state.creatorQuestions[index], state.quizRevealStep);
}

function bindDataConnection(connection) {
  if (!connection) return;

  if (state.dataConnection && state.dataConnection !== connection) {
    state.dataConnection.close?.();
  }

  state.dataConnection = connection;
  connection.on('open', () => {
    if (state.role === 'creator' && state.currentQuestionIndex >= 0) {
      sendQuizState();
    }
    if (state.role === 'creator') {
      sendPhoneLifelineState();
      sendRouletteLifelineState();
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
  state.quizRevealStep = 0;
  const question = state.creatorQuestions[index];
  displayQuizQuestion(index, question, state.quizRevealStep);
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
  });
}

function normalizeEliminatedAnswers(value) {
  return Array.from({ length: CREATOR_QUESTION_COUNT }, (_, index) => {
    const answers = Array.isArray(value?.[index]) ? value[index] : [];
    return answers.filter(option => CREATOR_QUESTION_OPTIONS.includes(option));
  });
}

function getQuizAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!state.quizAudioContext || state.quizAudioContext.state === 'closed') {
    state.quizAudioContext = new AudioContextClass({ latencyHint: 'interactive' });
  }

  return state.quizAudioContext;
}

async function unlockQuizAudio() {
  const context = getQuizAudioContext();
  if (!context) return false;

  try {
    await context.resume?.();
    if (!state.quizAudioUnlocked) {
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = 0;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(context.destination);
      source.start(0);
      state.quizAudioUnlocked = true;
    }
    preloadQuizSounds();
    return context.state === 'running';
  } catch (err) {
    console.warn('No se pudo desbloquear el audio.', err);
    return false;
  }
}

async function preloadQuizSounds() {
  const context = getQuizAudioContext();
  if (!context) return;

  await Promise.all(Object.entries(SOUNDS).map(async ([id, source]) => {
    if (state.quizAudioBuffers[id]) return;

    try {
      const response = await fetch(source, { cache: 'reload' });
      const arrayBuffer = await response.arrayBuffer();
      state.quizAudioBuffers[id] = await context.decodeAudioData(arrayBuffer);
    } catch (err) {
      console.warn(`No se pudo precargar ${id}.`, err);
    }
  }));
}

function showPreviousCreatorQuestion() {
  if (state.role !== 'creator') return;
  closeSettingsPanel();

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

function playQuizSound(id) {
  const source = SOUNDS[id] || $(id)?.getAttribute('src');
  if (!source) return;

  let mediaStarted = false;
  try {
    const audio = new Audio(source);
    audio.preload = 'auto';
    audio.volume = QUIZ_SOUND_VOLUME;
    state.quizActiveSounds.push(audio);
    audio.addEventListener('ended', () => {
      state.quizActiveSounds = state.quizActiveSounds.filter(item => item !== audio);
    }, { once: true });
    audio.addEventListener('error', () => {
      state.quizActiveSounds = state.quizActiveSounds.filter(item => item !== audio);
    }, { once: true });

    const playPromise = audio.play();
    mediaStarted = true;
    playPromise?.catch(err => {
      console.warn('No se pudo reproducir el archivo de sonido.', err);
      state.quizActiveSounds = state.quizActiveSounds.filter(item => item !== audio);
    });
  } catch (err) {
    console.warn('No se pudo iniciar el sonido.', err);
  }

  const context = getQuizAudioContext();
  if (!mediaStarted && context && state.quizAudioBuffers[id]) {
    playBufferedQuizSound(id);
  }

  unlockQuizAudio();
}

function playBufferedQuizSound(id) {
  const context = getQuizAudioContext();
  const buffer = state.quizAudioBuffers[id];
  if (!context || !buffer) return false;

  try {
    const player = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = QUIZ_SOUND_VOLUME;
    player.buffer = buffer;
    player.connect(gain);
    gain.connect(context.destination);
    player.start(0);
    return true;
  } catch (err) {
    console.warn('No se pudo reproducir el sonido precargado.', err);
    return false;
  }
}

function playQuizResultEffects(result) {
  if (result === 'correct') {
    playQuizSound('applauseSound');
    launchConfetti();
    return;
  }

  if (result === 'wrong') {
    playQuizSound('failSound');
    launchSadFace();
  }
}

function updatePhoneTimerDisplay() {
  const timer = $('phoneTimer');
  if (timer) timer.textContent = String(state.phoneTimerRemaining).padStart(2, '0');

  const panel = $('phoneLifelinePanel');
  const viewerOnly = state.role !== 'creator';
  panel?.classList.toggle('hidden', !state.phoneTimerVisible);
  panel?.classList.toggle('viewer-only', viewerOnly);
  $('phoneTimerLabel')?.classList.toggle('hidden', viewerOnly);
  $('phoneControls')?.classList.toggle('hidden', viewerOnly);

  const startButton = $('phoneStartBtn');
  if (startButton) startButton.disabled = Boolean(state.phoneTimerInterval) || state.phoneTimerRemaining <= 0;

  const pauseButton = $('phonePauseBtn');
  if (pauseButton) pauseButton.disabled = !state.phoneTimerInterval;

  const finishButton = $('phoneFinishBtn');
  if (finishButton) finishButton.disabled = state.phoneTimerRemaining <= 0;
}

function confirmLifelineReuse(type) {
  const used = type === 'phone' ? state.phoneLifelineUsed : state.rouletteLifelineUsed;
  if (!used) return true;

  return window.confirm('Ya has usado este comodin, ¿Seguro que quieres volver a usarlo?');
}

function sendPhoneLifelineState() {
  if (state.role !== 'creator') return;

  sendDataMessage({
    type: 'phone-lifeline-state',
    visible: state.phoneTimerVisible,
    remaining: state.phoneTimerRemaining,
    running: Boolean(state.phoneTimerInterval),
  });
}

function stopPhoneTimerInterval() {
  if (state.phoneTimerInterval) {
    clearInterval(state.phoneTimerInterval);
  }
  state.phoneTimerInterval = null;
}

function applyPhoneLifelineState(data) {
  if (state.role === 'creator') return;

  state.phoneTimerVisible = Boolean(data.visible);
  state.phoneTimerRemaining = Number.isFinite(Number(data.remaining))
    ? Math.max(0, Math.min(50, Math.round(Number(data.remaining))))
    : 50;
  stopPhoneTimerInterval();
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
  if (state.phoneTimerRemaining <= 0) state.phoneTimerRemaining = 50;
  state.phoneTimerVisible = true;
  state.phoneLifelineUsed = true;

  state.phoneTimerInterval = setInterval(() => {
    state.phoneTimerRemaining = Math.max(0, state.phoneTimerRemaining - 1);
    updatePhoneTimerDisplay();
    sendPhoneLifelineState();

    if (state.phoneTimerRemaining <= 0) {
      stopPhoneTimerInterval();
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
  state.phoneTimerVisible = true;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function finishPhoneLifeline() {
  if (state.role !== 'creator') return;

  stopPhoneTimerInterval();
  state.phoneTimerVisible = true;
  state.phoneTimerRemaining = 0;
  updatePhoneTimerDisplay();
  sendPhoneLifelineState();
}

function resetPhoneLifeline() {
  stopPhoneTimerInterval();
  state.phoneTimerRemaining = 50;
  state.phoneTimerVisible = false;
  updatePhoneTimerDisplay();
}

function stopRouletteTimeout() {
  if (state.rouletteTimeout) {
    clearTimeout(state.rouletteTimeout);
  }
  state.rouletteTimeout = null;
}

function updateRouletteDisplay() {
  const modal = $('rouletteLifelineModal');
  const viewerOnly = state.role !== 'creator';
  modal?.classList.toggle('hidden', !state.rouletteVisible);
  modal?.classList.toggle('viewer-only', viewerOnly);
  $('rouletteSpinBtn')?.classList.toggle('hidden', viewerOnly);
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
    ...extra,
  });
}

function finishRouletteSpinVisual(targetDegrees, result) {
  const wheel = $('rouletteWheel');
  const resultLabel = $('rouletteResult');
  state.rouletteSpinning = false;
  state.rouletteTimeout = null;
  wheel?.classList.remove('is-spinning');
  wheel?.style.setProperty('transform', `rotate(${targetDegrees}deg)`);
  if (resultLabel) resultLabel.textContent = String(result);
}

function applyRouletteSpin(targetDegrees, result, message, scheduleCompletion = true) {
  const wheel = $('rouletteWheel');
  const resultLabel = $('rouletteResult');

  stopRouletteTimeout();
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
  if (resultLabel) resultLabel.textContent = '?';

  const copy = $('rouletteCopy');
  if (copy) copy.textContent = state.rouletteMessage;

  if (scheduleCompletion) {
    state.rouletteTimeout = setTimeout(() => {
      finishRouletteSpinVisual(targetDegrees, result);
    }, ROULETTE_SPIN_MS);
  }
}

function applyRouletteLifelineState(data) {
  if (state.role === 'creator') return;

  state.rouletteVisible = Boolean(data.visible);
  updateRouletteDisplay();

  if (!state.rouletteVisible) {
    stopRouletteTimeout();
    state.rouletteSpinning = false;
    $('rouletteWheel')?.classList.remove('is-spinning');
    return;
  }

  const resultLabel = $('rouletteResult');
  if (Number.isFinite(Number(data.result)) && !data.spinning && resultLabel) {
    resultLabel.textContent = String(data.result);
    if (Number.isFinite(Number(data.targetDegrees))) {
      $('rouletteWheel')?.style.setProperty('transform', `rotate(${Number(data.targetDegrees)}deg)`);
    }
  } else if (resultLabel && !data.spinning) {
    resultLabel.textContent = '?';
  }

  const copy = $('rouletteCopy');
  if (copy && data.message) copy.textContent = data.message;

  if (data.spinning && Number.isFinite(Number(data.targetDegrees))) {
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
  updateRouletteDisplay();
  const result = $('rouletteResult');
  if (result) result.textContent = '?';
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = 'Gira para eliminar respuestas incorrectas visibles.';
  state.rouletteResultValue = null;
  state.rouletteTargetDegrees = 0;
  state.rouletteMessage = 'Gira para eliminar respuestas incorrectas visibles.';
  sendRouletteLifelineState({
    result: null,
  });
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
  const result = $('rouletteResult');
  if (result) result.textContent = '?';
  const copy = $('rouletteCopy');
  if (copy) copy.textContent = 'Gira para eliminar respuestas incorrectas visibles.';
  const spinButton = $('rouletteSpinBtn');
  if (spinButton) spinButton.disabled = false;
  updateRouletteDisplay();
}

function weightedRouletteResult() {
  const roll = Math.random();
  if (roll < 0.15) return 0;
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

  const spinButton = $('rouletteSpinBtn');
  const targetQuestionIndex = state.currentQuestionIndex;
  const result = weightedRouletteResult();
  const segmentIndex = pickRouletteSegment(result);
  const segmentAngle = segmentIndex * ROULETTE_SEGMENT_DEGREES;
  const targetDegrees = (10 * 360) + ((360 - segmentAngle) % 360);
  state.rouletteLifelineUsed = true;
  state.rouletteVisible = true;

  if (spinButton) spinButton.disabled = true;
  applyRouletteSpin(targetDegrees, result, 'La ruleta esta girando...', false);
  sendRouletteLifelineState({
    spinning: true,
    targetDegrees,
    result,
    message: 'La ruleta esta girando...',
  });

  state.rouletteTimeout = setTimeout(() => {
    finishRouletteSpinVisual(targetDegrees, result);
    if (spinButton) spinButton.disabled = false;
    const message = applyRouletteElimination(result, targetQuestionIndex);
    state.rouletteMessage = message;
    state.rouletteResultValue = result;
    sendRouletteLifelineState({
      spinning: false,
      targetDegrees,
      result,
      message,
    });
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

  if (state.currentQuestionIndex === index) {
    displayQuizQuestion(index, question, state.quizRevealStep);
  }
  sendDataMessage({
    type: 'quiz-eliminations',
    index,
    eliminated: state.quizEliminatedAnswers[index],
  });

  const copy = $('rouletteCopy');
  const message = count === 0
    ? 'Resultado 0: no se elimina ninguna respuesta.'
    : `Resultado ${count}: eliminadas ${eliminatedNow.length} respuesta(s) incorrecta(s).`;
  if (copy) {
    copy.textContent = message;
  }
  return message;
}

function selectQuizAnswer(option) {
  if (state.role !== 'creator') return;
  if (state.currentQuestionIndex < 0) return;
  if (!CREATOR_QUESTION_OPTIONS.includes(option)) return;
  if (state.quizRevealStep < CREATOR_QUESTION_OPTIONS.indexOf(option) + 1) return;
  if (state.quizEliminatedAnswers[state.currentQuestionIndex]?.includes(option)) return;
  if (state.quizSelectedAnswers[state.currentQuestionIndex]) return;

  const question = normalizeCreatorQuestion(state.creatorQuestions[state.currentQuestionIndex]);
  const result = question.correct === option ? 'correct' : 'wrong';
  state.quizSelectedAnswers[state.currentQuestionIndex] = option;
  state.quizResults[state.currentQuestionIndex] = result;
  displayQuizQuestion(state.currentQuestionIndex, question, state.quizRevealStep);
  playQuizResultEffects(result);
  sendDataMessage({
    type: 'quiz-selection',
    index: state.currentQuestionIndex,
    option,
    result,
    quizResults: state.quizResults,
  });
}

function launchConfetti() {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  document.body.appendChild(layer);

  const colors = ['#42e37f', '#ffd43d', '#ff2557', '#26b7ff', '#fff3cf'];
  for (let index = 0; index < 180; index += 1) {
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

  setTimeout(() => layer.remove(), 3800);
}

function launchSadFace() {
  const face = document.createElement('div');
  face.className = 'sad-face-feedback';
  face.textContent = '\u{1F622}';
  document.body.appendChild(face);
  setTimeout(() => face.remove(), 3200);
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

function micTestConstraint(deviceId) {
  const constraint = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (deviceId && deviceId !== '__default__' && deviceId !== '__none__') {
    constraint.deviceId = { exact: deviceId };
  }

  return constraint;
}

async function getMicTestTrack(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia || deviceId === '__none__') return null;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micTestConstraint(deviceId),
    video: false,
  });
  return stream.getAudioTracks()[0] || null;
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

function isActiveMediaCall(call) {
  const peerConnection = call?.peerConnection;
  if (!peerConnection) return false;

  const connectionState = peerConnection.connectionState || peerConnection.iceConnectionState;
  return ['new', 'checking', 'connecting', 'connected', 'completed'].includes(connectionState);
}

function clearRemoteCall(call, message) {
  if (call && state.currentCall && call !== state.currentCall) return;

  state.currentCall = null;
  state.remoteStream = null;
  $('remoteVideo').srcObject = null;
  $('waitingPanel').classList.remove('hidden');

  if (message) {
    setStatus(message, 'info');
  }
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
  $('creatorLifelines')?.classList.toggle('hidden', role !== 'creator');
  state.phoneLifelineUsed = false;
  state.rouletteLifelineUsed = false;
  resetPhoneLifeline();
  resetRouletteLifeline();
  if (role !== 'creator') {
    closeRouletteLifeline(true);
  }
  resetQuizDisplay();
  closeSettingsPanel();
  showScreen('roomScreen');
}

async function createManualOffer() {
  if (!requireProfile('createMsg')) return;

  unlockQuizAudio();
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

  unlockQuizAudio();
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

    const currentTrack = getLocalTrack('audio');
    const canCloneCurrentTrack = currentTrack
      && !isFallbackTrack(currentTrack)
      && currentTrack.readyState === 'live'
      && (deviceId === '__default__' || deviceId === state.selectedAudioDeviceId || !state.selectedAudioDeviceId);
    const track = canCloneCurrentTrack ? currentTrack.clone() : await getMicTestTrack(deviceId);
    if (!track) {
      setStatus('No se pudo abrir ningun microfono para la prueba.', 'error');
      return;
    }

    state.micTestStream = new MediaStream([track]);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      state.micTestAudioContext = new AudioContextClass({ latencyHint: 'interactive' });
      await state.micTestAudioContext.resume?.();
      state.micTestSource = state.micTestAudioContext.createMediaStreamSource(state.micTestStream);
      state.micTestGain = state.micTestAudioContext.createGain();
      state.micTestGain.gain.value = 0.9;
      state.micTestSource.connect(state.micTestGain);
      state.micTestGain.connect(state.micTestAudioContext.destination);
    }

    const audio = $('micTestAudio');
    audio.srcObject = state.micTestStream;
    audio.muted = false;
    audio.volume = 0;
    if (!state.micTestAudioContext) {
      audio.volume = 1;
      await audio.play();
    }

    $('btnMicTest').textContent = 'Detener prueba de microfono';
    setStatus('Prueba activa: te estas escuchando con el microfono seleccionado.', 'success');
  } catch (err) {
    stopMicTest();
    setStatus(mediaErrorMessage(err), 'error');
  }
}

function stopMicTest() {
  if (!state.micTestStream) return;

  state.micTestSource?.disconnect?.();
  state.micTestGain?.disconnect?.();
  state.micTestAudioContext?.close?.();
  state.micTestSource = null;
  state.micTestGain = null;
  state.micTestAudioContext = null;

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

['pointerdown', 'click', 'keydown', 'touchstart'].forEach(eventName => {
  document.addEventListener(eventName, unlockQuizAudio, { capture: true, passive: true });
});

preloadQuizSounds();

$('creatorQuestionsList')?.addEventListener('input', event => {
  updateCreatorQuestionFromInput(event.target);
});

$('creatorQuestionsList')?.addEventListener('change', event => {
  updateCreatorQuestionFromInput(event.target);
});

updateProfileBadge();
