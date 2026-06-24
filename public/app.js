let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

const statusEl = document.getElementById('status');
const orb = document.getElementById('orb');
const remoteAudio = document.getElementById('remoteAudio');
const consentPanel = document.getElementById('consentPanel');
const consentCheckbox = document.getElementById('consentCheckbox');
const startBtn = document.getElementById('startBtn');
const inCallControls = document.getElementById('inCallControls');
const skipBtn = document.getElementById('skipBtn');
const muteBtn = document.getElementById('muteBtn');
const reportBtn = document.getElementById('reportBtn');
const stopBtn = document.getElementById('stopBtn');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatPanel = document.getElementById('chatPanel');
const chatLog = document.getElementById('chatLog');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = chatForm.querySelector('button');
const toast = document.getElementById('toast');
const onlineCountEl = document.getElementById('onlineCount');

let socket = null;
let pc = null;
let localStream = null;
let state = 'idle'; // idle | searching | connected | stopped
let isMuted = false;

function setMuted(muted) {
  isMuted = muted;
  muteBtn.classList.toggle('is-muted', muted);
  muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }
}

function setStatus(text, cssClass) {
  statusEl.textContent = text;
  orb.className = 'orb ' + (cssClass || 'idle');
}

function closeChat() {
  chatPanel.classList.add('hidden');
  chatToggleBtn.classList.remove('active');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

function addChatLine(text, kind) {
  const line = document.createElement('div');
  line.className = 'chat-line ' + kind;
  line.textContent = text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearChat() {
  chatLog.innerHTML = '';
}

function refreshStartButton() {
  const idleOrStopped = state === 'idle' || state === 'stopped';
  startBtn.disabled = !(idleOrStopped && consentCheckbox.checked);
}

function setControlsForState(next) {
  state = next;
  if (next === 'idle' || next === 'stopped') {
    startBtn.classList.remove('hidden');
    inCallControls.classList.add('hidden');
    consentPanel.classList.remove('hidden');
    skipBtn.disabled = true;
    muteBtn.disabled = true;
    reportBtn.disabled = true;
    stopBtn.disabled = true;
    chatInput.disabled = true;
    chatSendBtn.disabled = true;
    chatToggleBtn.disabled = true;
    closeChat();
  } else if (next === 'searching') {
    startBtn.classList.add('hidden');
    inCallControls.classList.remove('hidden');
    consentPanel.classList.add('hidden');
    skipBtn.disabled = true;
    muteBtn.disabled = true;
    reportBtn.disabled = true;
    stopBtn.disabled = false;
    chatInput.disabled = true;
    chatSendBtn.disabled = true;
    chatToggleBtn.disabled = true;
    closeChat();
  } else if (next === 'connected') {
    startBtn.classList.add('hidden');
    inCallControls.classList.remove('hidden');
    consentPanel.classList.add('hidden');
    skipBtn.disabled = false;
    muteBtn.disabled = false;
    reportBtn.disabled = false;
    stopBtn.disabled = false;
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    chatToggleBtn.disabled = false;
  }
  refreshStartButton();
}

function teardownPeerConnection() {
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
    pc = null;
  }
  remoteAudio.srcObject = null;
}

function createPeerConnection(isOfferer) {
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
  };

  if (isOfferer) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { type: 'offer', sdp: pc.localDescription });
    };
  }
}

async function handleSignal(payload) {
  if (!pc) return;
  if (payload.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { type: 'answer', sdp: pc.localDescription });
  } else if (payload.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } else if (payload.type === 'ice-candidate') {
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch (err) {
      console.error('Failed to add ICE candidate', err);
    }
  }
}

function ensureSocket() {
  if (socket) return socket;
  socket = io();

  socket.on('matched', ({ isOfferer }) => {
    setStatus('Connected. Say hi!', 'connected');
    setControlsForState('connected');
    clearChat();
    createPeerConnection(isOfferer);
  });

  socket.on('signal', (payload) => {
    handleSignal(payload).catch((err) => console.error('Signal handling error', err));
  });

  socket.on('partner-left', () => {
    teardownPeerConnection();
    showToast('Stranger disconnected');
    if (state !== 'idle' && state !== 'stopped') {
      setStatus('Searching for someone new...', 'searching');
      setControlsForState('searching');
      socket.emit('find-partner');
    }
  });

  socket.on('blocked', () => {
    showToast('You have been blocked due to multiple reports.');
    stopSession();
  });

  socket.on('rate-limited', () => {
    showToast('Slow down — try again in a moment.');
  });

  socket.on('chat-message', ({ text }) => {
    addChatLine(text, 'them');
    if (chatPanel.classList.contains('hidden')) {
      showToast('New message');
    }
  });

  socket.on('online-count', (count) => {
    onlineCountEl.textContent = `${count} online`;
  });

  socket.on('disconnect', () => {
    onlineCountEl.textContent = 'reconnecting…';
  });

  return socket;
}

async function startSession() {
  if (!consentCheckbox.checked) return;

  try {
    const res = await fetch('/ice-config');
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      iceServers = data.iceServers;
    }
  } catch (err) {
    console.error('Failed to load ICE config, falling back to STUN-only', err);
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access is required to start.');
    return;
  }
  setMuted(false);

  ensureSocket();
  setStatus('Searching for a stranger...', 'searching');
  setControlsForState('searching');
  socket.emit('find-partner');
}

function skipSession() {
  teardownPeerConnection();
  clearChat();
  setStatus('Searching for someone new...', 'searching');
  setControlsForState('searching');
  socket.emit('skip');
}

function reportPartner() {
  socket.emit('report');
  teardownPeerConnection();
  clearChat();
  showToast('Reported. Finding someone new...');
  setStatus('Searching for someone new...', 'searching');
  setControlsForState('searching');
}

function stopSession() {
  teardownPeerConnection();
  clearChat();
  if (socket) {
    socket.emit('stop');
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  setMuted(false);
  setStatus('Tap Start to find someone to talk to', null);
  setControlsForState('stopped');
}

startBtn.addEventListener('click', startSession);
skipBtn.addEventListener('click', skipSession);
muteBtn.addEventListener('click', () => {
  if (muteBtn.disabled) return;
  setMuted(!isMuted);
});
reportBtn.addEventListener('click', reportPartner);
stopBtn.addEventListener('click', stopSession);
chatToggleBtn.addEventListener('click', () => {
  if (chatToggleBtn.disabled) return;
  const isHidden = chatPanel.classList.toggle('hidden');
  chatToggleBtn.classList.toggle('active', !isHidden);
  if (!isHidden) chatInput.focus();
});
consentCheckbox.addEventListener('change', () => {
  localStorage.setItem('vm_consent_accepted', consentCheckbox.checked ? 'true' : 'false');
  refreshStartButton();
});

if (localStorage.getItem('vm_consent_accepted') === 'true') {
  consentCheckbox.checked = true;
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || state !== 'connected') return;
  socket.emit('chat-message', { text });
  addChatLine(text, 'me');
  chatInput.value = '';
});

ensureSocket();
setControlsForState('idle');
