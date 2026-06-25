let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

// Keep this to constraints with broad, well-established hardware support.
// channelCount/sampleRate/sampleSize/latency/voiceIsolation were tried here
// and caused getUserMedia to hand back a track with no actual signal on at
// least one real laptop's audio driver — a silent, non-throwing failure
// mode, so the try/catch fallback below never even caught it.
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const statusEl = document.getElementById('status');
const orb = document.getElementById('orb');
const remoteAudio = document.getElementById('remoteAudio');
const consentPanel = document.getElementById('consentPanel');
const consentCheckbox = document.getElementById('consentCheckbox');
const startBtn = document.getElementById('startBtn');
const inCallControls = document.getElementById('inCallControls');
const skipBtn = document.getElementById('skipBtn');
const muteBtn = document.getElementById('muteBtn');
const speakerBtn = document.getElementById('speakerBtn');
const reportBtn = document.getElementById('reportBtn');
const stopBtn = document.getElementById('stopBtn');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const unreadDot = document.getElementById('unreadDot');
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
let isBoosted = false;
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
const BOOST_GAIN = 2.5;

// There is no web API to switch a phone's call audio between earpiece and
// loudspeaker the way native call apps do — browser tabs already play
// through the main speaker, so a device-switching "speaker" button has
// nothing real to switch to/from on a phone with no headset connected.
// What actually has an audible effect everywhere is amplifying the signal
// past the <audio> element's 100% ceiling via a Web Audio gain node.
function supportsAudioBoost() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

function ensureAudioContext() {
  if (audioCtx || !supportsAudioBoost()) return;
  const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioCtxCtor();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = isBoosted ? BOOST_GAIN : 1;
  gainNode.connect(audioCtx.destination);
}

function resumeAudioContext() {
  // Must be kicked off from inside a user gesture (the Start tap) or mobile
  // browsers leave it suspended and the call stays silent.
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

function routeRemoteStreamThroughGain(stream) {
  if (!audioCtx || !gainNode) return false;
  // Mobile browsers aggressively auto-suspend an AudioContext that isn't
  // actively producing sound — which is exactly the state it's in while
  // "Searching..." for a match. The resume() at Start time isn't enough if
  // that takes more than a few seconds, so resume again right before we
  // actually need output, or the call connects but stays silent.
  resumeAudioContext();
  try {
    if (sourceNode) sourceNode.disconnect();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
    remoteAudio.muted = true; // avoid double playback — the gain graph is the real output path
    return true;
  } catch (err) {
    console.error('Failed to route remote audio through gain node', err);
    return false;
  }
}

function toggleBoost() {
  if (!gainNode) return;
  isBoosted = !isBoosted;
  gainNode.gain.value = isBoosted ? BOOST_GAIN : 1;
  speakerBtn.classList.toggle('is-active', isBoosted);
  speakerBtn.setAttribute('aria-label', isBoosted ? 'Disable volume boost' : 'Boost call volume');
}

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
  unreadDot.classList.add('hidden');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

function notifyNewMessage(text) {
  if (chatPanel.classList.contains('hidden')) {
    showToast('New message');
    // The toast disappears after 2.5s and is easy to miss — leave a badge on
    // the chat icon too, so an unread message can't go unnoticed.
    unreadDot.classList.remove('hidden');
  }
  // The in-page toast only helps while this tab is in front. If the tab is
  // backgrounded or the phone is locked, fall back to a real OS notification.
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('New message', { body: text.slice(0, 120), icon: '/favicon.svg' });
  }
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
    speakerBtn.disabled = true;
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
    speakerBtn.disabled = true;
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
    speakerBtn.disabled = !supportsAudioBoost();
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
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  remoteAudio.srcObject = null;
}

function playRemoteAudio() {
  // Assigning srcObject happens asynchronously in ontrack, outside the
  // click that started the call, so mobile autoplay policies can silently
  // block playback. Retry once on the next tap/click if that happens.
  const playPromise = remoteAudio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      document.addEventListener('pointerdown', () => remoteAudio.play().catch(() => {}), { once: true });
    });
  }
}

function preferOpusCodec(peerConnection) {
  // Opus is already what every modern browser offers first for a plain audio
  // track, so this mostly guards the rare/older-browser case rather than
  // changing today's typical negotiation outcome.
  if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return;
  const capabilities = RTCRtpReceiver.getCapabilities('audio');
  if (!capabilities) return;
  const opus = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
  const others = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/opus');
  if (!opus.length) return;
  const ordered = [...opus, ...others];

  peerConnection.getTransceivers().forEach((transceiver) => {
    const kind = transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind;
    if (kind === 'audio' && typeof transceiver.setCodecPreferences === 'function') {
      try {
        transceiver.setCodecPreferences(ordered);
      } catch (err) {
        console.error('Failed to set codec preferences', err);
      }
    }
  });
}

function createPeerConnection(isOfferer) {
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  preferOpusCodec(pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { type: 'ice-candidate', candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    remoteAudio.srcObject = stream;
    if (!routeRemoteStreamThroughGain(stream)) {
      // No Web Audio support (very rare) — fall back to direct playback.
      remoteAudio.muted = false;
      playRemoteAudio();
    }
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
    // Defensive: a stale pc from a previous match should never still be open
    // here, but if it ever is (server race, reconnect), tear it down first
    // rather than leaking it while a second one is created alongside it.
    if (pc) teardownPeerConnection();
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
    notifyNewMessage(text);
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

  ensureAudioContext();
  resumeAudioContext();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

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
    localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
  } catch (err) {
    console.error('getUserMedia failed with full constraints, retrying with plain audio', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (fallbackErr) {
      showToast('Microphone access is required to start.');
      return;
    }
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
  isBoosted = false;
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
    gainNode = null;
  }
  speakerBtn.classList.remove('is-active');
  speakerBtn.setAttribute('aria-label', 'Boost call volume');
  setStatus('Tap Start to find someone to talk to', null);
  setControlsForState('stopped');
}

startBtn.addEventListener('click', startSession);
skipBtn.addEventListener('click', skipSession);
muteBtn.addEventListener('click', () => {
  if (muteBtn.disabled) return;
  setMuted(!isMuted);
});
speakerBtn.addEventListener('click', () => {
  if (speakerBtn.disabled) return;
  toggleBoost();
});
reportBtn.addEventListener('click', reportPartner);
stopBtn.addEventListener('click', stopSession);
chatToggleBtn.addEventListener('click', () => {
  if (chatToggleBtn.disabled) return;
  const isHidden = chatPanel.classList.toggle('hidden');
  chatToggleBtn.classList.toggle('active', !isHidden);
  if (!isHidden) {
    chatInput.focus();
    unreadDot.classList.add('hidden');
  }
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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeAudioContext();
});

ensureSocket();
setControlsForState('idle');
