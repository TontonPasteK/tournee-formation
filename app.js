/* ═══════════════════════════════════════════════════════════
   TOURNÉE FORMATION — app.js
   GPS + Audio + Arrêts auto + Navigation TTS + Multi-tournées
═══════════════════════════════════════════════════════════ */

'use strict';

// ── État global ──────────────────────────────────────────
const STATE = {
  // Enregistrement
  isRecording: false,
  isPaused: false,
  startTime: null,
  timerInterval: null,
  wakeLock: null,

  // GPS
  watchId: null,
  positions: [],           // {lat, lng, ts, speed}
  currentPos: null,

  // Arrêts
  stops: [],               // {id, lat, lng, ts, tsEnd, audioOffset, note, name}
  currentStop: null,
  stopStartTime: null,
  stopLat: null,           // Fix: coordonnées du stop en attente
  stopLng: null,
  SPEED_THRESHOLD: 0.5,    // m/s — en dessous = arrêt possible
  STOP_MIN_DURATION: 8000, // 8s minimum pour valider un arrêt
  stopTimer: null,
  pendingStop: false,
  lastStopEndTime: 0,
  STOP_COOLDOWN: 15000,    // 15s entre deux arrêts

  // Audio
  mediaRecorder: null,
  audioChunks: [],         // ArrayBuffer[]
  audioMimeType: '',
  audioStartTime: null,    // Date.now() au début de l'enregistrement

  // Tournées sauvegardées
  tournees: [],
  currentTournee: null,    // tournée en cours d'édition/navigation
  editingTournee: null,

  // Cartes Leaflet
  recMap: null,
  recPosMarker: null,
  recPathLine: null,
  navMap: null,
  navPosMarker: null,
  navStopMarkers: [],

  // Navigation
  navStops: [],
  navCurrentIdx: 0,
  navRouteInstructions: [],
  navInstrIdx: 0,
  navWatchId: null,
  navWakeLock: null,
  lastSpokenInstruction: '',

  // Finalisation
  finalBlob: null,
  finalTourneeData: null,
};

// ── Utilitaires ──────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  // Init carte à l'activation
  if (id === 'screen-record' && !STATE.recMap) initRecMap();
  if (id === 'screen-nav' && !STATE.navMap) initNavMap();
  if (id === 'screen-manage') refreshManageList();
}

function toast(msg, type = 'success', duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), duration);
}

function formtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Vibration utilitaire
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ── TTS ──────────────────────────────────────────────────

function speak(text, interrupt = true) {
  if (!window.speechSynthesis) return;
  if (interrupt) window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  u.rate = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

// ── Wake Lock ─────────────────────────────────────────────

async function acquireWakeLock(stateKey = 'wakeLock') {
  try {
    if ('wakeLock' in navigator) {
      STATE[stateKey] = await navigator.wakeLock.request('screen');
    }
  } catch(e) { console.warn('WakeLock non disponible', e); }
}

function releaseWakeLock(stateKey = 'wakeLock') {
  if (STATE[stateKey]) {
    STATE[stateKey].release().catch(() => {});
    STATE[stateKey] = null;
  }
}

// ── Localisation stockée ─────────────────────────────────

function loadTournees() {
  try {
    STATE.tournees = JSON.parse(localStorage.getItem('tournees') || '[]');
  } catch(e) { STATE.tournees = []; }
}

function saveTourneesLocal() {
  localStorage.setItem('tournees', JSON.stringify(STATE.tournees));
}

// ── CARTE ENREGISTREMENT ─────────────────────────────────

function initRecMap() {
  STATE.recMap = L.map('rec-map', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(STATE.recMap);
  STATE.recMap.setView([43.2965, 5.3698], 15); // Marseille par défaut
}

function updateRecMap(lat, lng) {
  if (!STATE.recMap) return;

  const posIcon = L.divIcon({ className: '', html: '<div class="pos-marker"></div>', iconSize: [16,16], iconAnchor: [8,8] });

  if (!STATE.recPosMarker) {
    STATE.recPosMarker = L.marker([lat, lng], { icon: posIcon }).addTo(STATE.recMap);
    STATE.recMap.setView([lat, lng], 17);
  } else {
    STATE.recPosMarker.setLatLng([lat, lng]);
    STATE.recMap.panTo([lat, lng], { animate: true, duration: 0.5 });
  }

  // Trace GPS — positions est un tableau de {lat,lng,ts}, Leaflet veut [lat,lng]
  const latlngs = STATE.positions.map(p => [p.lat, p.lng]);
  if (STATE.recPathLine) {
    STATE.recPathLine.setLatLngs(latlngs);
  } else if (latlngs.length > 1) {
    STATE.recPathLine = L.polyline(latlngs, { color: '#00d4ff', weight: 3, opacity: 0.7 }).addTo(STATE.recMap);
  }
}

function addStopMarkerRec(stop) {
  if (!STATE.recMap) return;
  const icon = L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [14,14], iconAnchor: [7,7] });
  L.marker([stop.lat, stop.lng], { icon })
    .bindPopup(`<b>Arrêt #${STATE.stops.length}</b><br>${stop.note || ''}`)
    .addTo(STATE.recMap);
}

// ── DÉMARRAGE ENREGISTREMENT ─────────────────────────────

async function startRecording() {
  const name = document.getElementById('setup-name').value.trim();
  const porteur = document.getElementById('setup-porteur').value.trim();

  if (!name) { toast('Donne un nom à la tournée !', 'warn'); return; }

  // Permissions micro
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch(e) {
    toast('Microphone refusé — active la permission', 'danger', 5000);
    return;
  }

  // Reset state
  STATE.stops = [];
  STATE.positions = [];
  STATE.audioChunks = [];
  STATE.currentStop = null;
  STATE.pendingStop = false;
  STATE.isRecording = true;
  STATE.isPaused = false;
  STATE.startTime = Date.now();
  STATE.audioStartTime = Date.now();

  // Tournée courante
  STATE.currentTournee = {
    id: Date.now().toString(),
    name,
    porteur: porteur || 'Anonyme',
    date: new Date().toLocaleDateString('fr-FR'),
    dateTs: Date.now(),
  };

  // Démarrer MediaRecorder
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : 'audio/ogg;codecs=opus';

  STATE.audioMimeType = mimeType;
  STATE.mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });

  STATE.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      e.data.arrayBuffer().then(buf => STATE.audioChunks.push(buf));
    }
  };

  // Demander des chunks toutes les 5s (pour ne pas perdre les données)
  STATE.mediaRecorder.start(5000);

  // GPS
  if (!navigator.geolocation) {
    toast('GPS non disponible sur cet appareil', 'danger');
    return;
  }

  STATE.watchId = navigator.geolocation.watchPosition(
    onGpsUpdate,
    (err) => toast('GPS : ' + err.message, 'warn'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );

  // Timer affichage
  STATE.timerInterval = setInterval(updateRecTimer, 1000);

  // Wake Lock
  await acquireWakeLock('wakeLock');

  // Affichage
  showScreen('screen-record');
  toast('🔴 Enregistrement démarré', 'success');
  speak('Enregistrement démarré. Bonne tournée !');

  // Détection si appli en arrière-plan
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function onVisibilityChange() {
  if (document.hidden && STATE.isRecording && !STATE.isPaused) {
    toast('⚠️ Appli en arrière-plan — GPS peut se couper !', 'warn', 6000);
    vibrate([200, 100, 200]);
  }
}

// ── GPS UPDATE ───────────────────────────────────────────

function onGpsUpdate(pos) {
  if (!STATE.isRecording || STATE.isPaused) return;

  const { latitude: lat, longitude: lng, speed } = pos.coords;
  const ts = Date.now();
  const speedMs = speed !== null ? speed : computeSpeed(lat, lng, ts);

  STATE.currentPos = { lat, lng, ts, speed: speedMs };
  STATE.positions.push({ lat, lng, ts });
  updateRecMap(lat, lng);
  detectStop(lat, lng, ts, speedMs);
}

// Calcul vitesse si non fournie par le GPS
function computeSpeed(lat, lng, ts) {
  if (STATE.positions.length < 2) return 0;
  const prev = STATE.positions[STATE.positions.length - 2];
  const dt = (ts - prev.ts) / 1000;
  if (dt <= 0) return 0;
  return distanceMeters(prev.lat, prev.lng, lat, lng) / dt;
}

// ── DÉTECTION ARRÊTS ─────────────────────────────────────

function detectStop(lat, lng, ts, speed) {
  const infoEl = document.getElementById('rec-stop-info');

  // Cooldown après un arrêt récent
  if (ts - STATE.lastStopEndTime < STATE.STOP_COOLDOWN) return;

  if (speed < STATE.SPEED_THRESHOLD) {
    // Véhicule lent ou arrêté
    if (!STATE.pendingStop) {
      STATE.pendingStop = true;
      STATE.stopStartTime = ts;
      STATE.stopLat = lat;
      STATE.stopLng = lng;

      STATE.stopTimer = setTimeout(() => {
        // Valider l'arrêt après STOP_MIN_DURATION
        if (STATE.pendingStop && STATE.isRecording && !STATE.isPaused) {
          validateStop(STATE.stopLat, STATE.stopLng, STATE.stopStartTime);
        }
      }, STATE.STOP_MIN_DURATION);
    }
  } else {
    // Le véhicule repart — annuler si arrêt pas encore validé
    if (STATE.pendingStop && !STATE.currentStop) {
      clearTimeout(STATE.stopTimer);
      STATE.pendingStop = false;
    }

    // Fin d'un arrêt en cours
    if (STATE.currentStop) {
      endStop(ts);
    }
  }
}

function validateStop(lat, lng, startTs) {
  // Calculer offset audio
  const audioOffset = startTs - STATE.audioStartTime;

  const stop = {
    id: STATE.stops.length + 1,
    lat, lng,
    ts: startTs,
    tsEnd: null,
    audioOffset: Math.max(0, audioOffset),
    note: '',
    name: `Arrêt ${STATE.stops.length + 1}`,
  };

  STATE.currentStop = stop;
  STATE.stops.push(stop);

  // UI
  const infoEl = document.getElementById('rec-stop-info');
  infoEl.className = 'rec-stop-info active-stop';
  infoEl.textContent = `🟢 Arrêt #${stop.id} détecté — ${formatTime(startTs)}`;
  document.getElementById('rec-stops-count').textContent = `${STATE.stops.length} arrêt${STATE.stops.length > 1 ? 's' : ''}`;

  // Marqueur carte
  addStopMarkerRec(stop);

  // Vibration + notification discrète
  vibrate([100, 50, 100]);

  // Popup note avec timeout (5s puis disparaît)
  openNoteModalAuto();
}

function endStop(ts) {
  if (!STATE.currentStop) return;
  STATE.currentStop.tsEnd = ts;
  STATE.lastStopEndTime = ts;
  STATE.currentStop = null;
  STATE.pendingStop = false;

  const infoEl = document.getElementById('rec-stop-info');
  infoEl.className = 'rec-stop-info';
  infoEl.textContent = '📍 En route — prochain arrêt en attente...';
}

// ── PAUSE / REPRISE ──────────────────────────────────────

function togglePause() {
  const btn = document.getElementById('btn-pause');
  const dot = document.getElementById('rec-dot');
  const statusText = document.getElementById('rec-status-text');

  STATE.isPaused = !STATE.isPaused;

  if (STATE.isPaused) {
    if (STATE.mediaRecorder && STATE.mediaRecorder.state === 'recording') {
      STATE.mediaRecorder.pause();
    }
    if (STATE.watchId) navigator.geolocation.clearWatch(STATE.watchId);
    clearInterval(STATE.timerInterval);
    clearTimeout(STATE.stopTimer);
    STATE.pendingStop = false;
    if (STATE.currentStop) endStop(Date.now());
    // Mémoriser le temps écoulé au moment de la pause
    STATE._elapsedBeforePause = Date.now() - STATE.startTime;

    btn.textContent = '▶️';
    btn.style.background = 'var(--success)';
    dot.className = 'rec-dot paused';
    statusText.textContent = 'PAUSE';
    toast('⏸ Pause — reprenez quand vous êtes prêts', 'warn');
  } else {
    if (STATE.mediaRecorder && STATE.mediaRecorder.state === 'paused') {
      STATE.mediaRecorder.resume();
    }
    // Recaler startTime pour que le timer ne compte pas la durée de pause
    STATE.startTime = Date.now() - (STATE._elapsedBeforePause || 0);
    STATE.watchId = navigator.geolocation.watchPosition(
      onGpsUpdate,
      (err) => toast('GPS : ' + err.message, 'warn'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    STATE.timerInterval = setInterval(updateRecTimer, 1000);
    btn.textContent = '⏸';
    btn.style.background = 'var(--warn)';
    dot.className = 'rec-dot';
    statusText.textContent = 'REC';
    toast('▶️ Enregistrement repris', 'success');
  }
}

// ── TIMER ────────────────────────────────────────────────

function updateRecTimer() {
  if (!STATE.startTime || STATE.isPaused) return;
  const elapsed = Date.now() - STATE.startTime;
  document.getElementById('rec-timer').textContent = formatDuration(elapsed);
}

// ── NOTES ────────────────────────────────────────────────

let noteAutoTimeout = null;
let voiceRecognition = null;
let currentNoteTab = 'text';

// ── Onglets de la modal note ──────────────────────────────

function switchNoteTab(tab) {
  currentNoteTab = tab;
  document.getElementById('tab-text').classList.toggle('active', tab === 'text');
  document.getElementById('tab-voice').classList.toggle('active', tab === 'voice');
  document.getElementById('note-panel-text').style.display = tab === 'text' ? '' : 'none';
  document.getElementById('note-panel-voice').style.display = tab === 'voice' ? '' : 'none';

  if (tab === 'text') {
    stopVoiceNote();
    setTimeout(() => document.getElementById('note-textarea').focus(), 200);
  }
}

// ── Note vocale via SpeechRecognition ────────────────────

function toggleVoiceNote() {
  if (!voiceRecognition || !voiceRecognition._active) {
    startVoiceNote();
  } else {
    stopVoiceNote();
  }
}

function startVoiceNote() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('Reconnaissance vocale non supportée sur ce navigateur', 'danger', 4000);
    return;
  }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'fr-FR';
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition._active = true;

  const btn = document.getElementById('btn-voice-rec');
  const label = document.getElementById('voice-rec-label');
  const transcript = document.getElementById('voice-transcript');
  const hint = document.getElementById('voice-hint');

  btn.classList.add('listening');
  label.textContent = '🔴 Écoute en cours...';
  transcript.textContent = '...';
  hint.textContent = 'Parle clairement — appuie à nouveau pour arrêter';

  let finalText = '';

  voiceRecognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalText += e.results[i][0].transcript + ' ';
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    transcript.textContent = (finalText + interim).trim() || '...';
    // Synchro vers le textarea texte aussi
    document.getElementById('note-textarea').value = (finalText + interim).trim();
  };

  voiceRecognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      toast('Micro refusé — vérifie les permissions', 'danger', 4000);
    } else if (e.error !== 'aborted') {
      toast('Erreur vocale : ' + e.error, 'warn');
    }
    stopVoiceNote();
  };

  voiceRecognition.onend = () => {
    if (voiceRecognition && voiceRecognition._active) {
      // Redémarrer automatiquement si toujours actif (fin naturelle)
      try { voiceRecognition.start(); } catch(e) {}
    }
  };

  voiceRecognition.start();
}

function stopVoiceNote() {
  if (!voiceRecognition) return;
  voiceRecognition._active = false;
  try { voiceRecognition.stop(); } catch(e) {}
  voiceRecognition = null;

  const btn = document.getElementById('btn-voice-rec');
  const label = document.getElementById('voice-rec-label');
  const hint = document.getElementById('voice-hint');
  if (btn) btn.classList.remove('listening');
  if (label) label.textContent = 'Appuie pour dicter';
  if (hint) hint.textContent = 'Parle clairement — la note sera transcrite automatiquement';
}

// ── Ouverture / fermeture modal note ─────────────────────

function openNoteModalAuto() {
  openNoteModal();
  // Ferme automatiquement après 8s si pas d'interaction
  noteAutoTimeout = setTimeout(() => {
    closeNoteModal();
  }, 8000);
}

function openNoteModal() {
  clearTimeout(noteAutoTimeout);
  document.getElementById('note-textarea').value = '';
  document.getElementById('voice-transcript').textContent = 'La transcription apparaîtra ici...';
  document.getElementById('modal-note').classList.add('open');
  // Toujours ouvrir sur l'onglet texte par défaut
  switchNoteTab('text');
  setTimeout(() => document.getElementById('note-textarea').focus(), 300);
}

function closeNoteModal() {
  clearTimeout(noteAutoTimeout);
  stopVoiceNote();
  document.getElementById('modal-note').classList.remove('open');
}

function saveNote() {
  clearTimeout(noteAutoTimeout);
  stopVoiceNote();
  // Récupérer la note : priorité au textarea (synchro avec le vocal aussi)
  const note = document.getElementById('note-textarea').value.trim();
  // Attacher la note au dernier arrêt
  if (STATE.stops.length > 0 && note) {
    const lastStop = STATE.stops[STATE.stops.length - 1];
    lastStop.note = note;
    toast(`📝 Note enregistrée pour l'arrêt #${lastStop.id}`, 'success');
  }
  closeNoteModal();
}

// ── ARRÊT ENREGISTREMENT ─────────────────────────────────

function confirmStopRecording() {
  if (!confirm('Terminer l\'enregistrement de la tournée ?')) return;
  stopRecording();
}

function stopRecording() {
  STATE.isRecording = false;

  // Stopper GPS
  if (STATE.watchId) {
    navigator.geolocation.clearWatch(STATE.watchId);
    STATE.watchId = null;
  }

  // Stopper timer
  clearInterval(STATE.timerInterval);

  // Fermer arrêt en cours
  if (STATE.currentStop) endStop(Date.now());

  // Stopper MediaRecorder
  if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
    STATE.mediaRecorder.stop();
    STATE.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }

  releaseWakeLock('wakeLock');
  document.removeEventListener('visibilitychange', onVisibilityChange);

  // Stats
  const duration = Date.now() - STATE.startTime;
  document.getElementById('fin-duration').textContent = formatDuration(duration);
  document.getElementById('fin-stops').textContent = STATE.stops.length;

  showScreen('screen-finalize');

  // Laisser le temps au MediaRecorder de flush ses derniers chunks
  setTimeout(() => finalizeRecording(), 800);
}

// ── FINALISATION ─────────────────────────────────────────

async function finalizeRecording() {
  const progressBar = document.getElementById('fin-progress');
  const progressLabel = document.getElementById('fin-progress-label');
  const btnDl = document.getElementById('btn-download');

  progressLabel.textContent = 'Assemblage de l\'audio...';
  progressBar.style.width = '20%';

  await sleep(200);

  // Assembler tous les chunks en un seul ArrayBuffer
  const totalSize = STATE.audioChunks.reduce((s, b) => s + b.byteLength, 0);
  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of STATE.audioChunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  progressBar.style.width = '50%';
  progressLabel.textContent = 'Compression et synchronisation GPS...';
  await sleep(300);

  // Créer le Blob audio
  const audioBlob = new Blob([merged], { type: STATE.audioMimeType });

  // Encoder l'audio en base64
  const audioBase64 = await blobToBase64(audioBlob);

  progressBar.style.width = '80%';
  progressLabel.textContent = 'Création du fichier tournée...';
  await sleep(200);

  // Construire le JSON final
  const tourneeData = {
    version: '1.0',
    ...STATE.currentTournee,
    duration: Date.now() - STATE.startTime,
    stopsCount: STATE.stops.length,
    stops: STATE.stops,
    gpsTrace: STATE.positions,
    audio: {
      mimeType: STATE.audioMimeType,
      startTime: STATE.audioStartTime,
      data: audioBase64,
    },
    exportedAt: Date.now(),
  };

  STATE.finalTourneeData = tourneeData;

  // Taille estimée
  const sizeKB = Math.round(JSON.stringify(tourneeData).length / 1024);
  const sizeMB = (sizeKB / 1024).toFixed(1);
  document.getElementById('fin-size').textContent = `${sizeMB} MB`;

  progressBar.style.width = '100%';
  progressLabel.textContent = '✅ Fichier prêp à télécharger !';

  btnDl.disabled = false;

  // Sauvegarder en local (sans l'audio pour économiser de la mémoire localStorage)
  const tourneeLight = { ...tourneeData, audio: { mimeType: STATE.audioMimeType, startTime: STATE.audioStartTime, data: '' } };
  STATE.tournees.push(tourneeLight);
  saveTourneesLocal();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function downloadTournee() {
  if (!STATE.finalTourneeData) return;
  const json = JSON.stringify(STATE.finalTourneeData);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = STATE.finalTourneeData.name.replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '_');
  a.href = url;
  a.download = `${safeName}_${STATE.finalTourneeData.date.replace(/\//g,'-')}.tournee`;
  a.click();
  URL.revokeObjectURL(url);
  STATE._audioDownloaded = true;
  toast('💾 Tournée téléchargée !', 'success');
}

function afterFinalize() {
  if (STATE.finalTourneeData && !STATE._audioDownloaded) {
    if (!confirm('⚠️ Tu n\'as pas encore téléchargé le fichier de la tournée.\nSi tu continues, l\'audio sera perdu définitivement.\n\nContinuer quand même ?')) return;
  }
  STATE.finalTourneeData = null;
  STATE.audioChunks = [];
  STATE._audioDownloaded = false;
  refreshManageList();
  showScreen('screen-manage');
}

// ── MES TOURNÉES ─────────────────────────────────────────

function refreshManageList() {
  loadTournees();
  const list = document.getElementById('manage-list');

  if (STATE.tournees.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗺️</div>
        <p>Aucune tournée enregistrée.<br>Enregistre ta première tournée avec le formateur<br>ou charge un fichier .tournee</p>
      </div>`;
    return;
  }

  list.innerHTML = STATE.tournees.map((t, i) => `
    <div class="tournee-card">
      <div class="tc-icon">📋</div>
      <div class="tc-info">
        <div class="tc-name">${t.name}</div>
        <div class="tc-meta">${t.date} · ${t.stopsCount} arrêts · ${t.porteur}</div>
      </div>
      <div class="tc-actions">
        <button class="tc-btn play" onclick="startNavigation(${i})" title="Naviguer">🚐</button>
        <button class="tc-btn edit" onclick="editTournee(${i})" title="Éditer">✏️</button>
        <button class="tc-btn del" onclick="deleteTournee(${i})" title="Supprimer">🗑️</button>
      </div>
    </div>
  `).join('');
}

function deleteTournee(idx) {
  if (!confirm(`Supprimer la tournée "${STATE.tournees[idx].name}" ?`)) return;
  STATE.tournees.splice(idx, 1);
  saveTourneesLocal();
  refreshManageList();
  toast('Tournée supprimée', 'warn');
}

function importTournee() {
  document.getElementById('file-import').click();
}

function loadTourneeFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.stops || !data.name) throw new Error('Format invalide');

      // Vérifier si déjà présente (par id)
      const exists = STATE.tournees.find(t => t.id === data.id);
      if (exists) {
        toast('Cette tournée est déjà chargée', 'warn');
        return;
      }

      // Stocker avec l'audio complet cette fois
      STATE.tournees.push(data);
      saveTourneesLocal();
      refreshManageList();
      toast(`✅ Tournée "${data.name}" chargée !`, 'success');
    } catch(e) {
      toast('Fichier invalide ou corrompu', 'danger');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ── ÉDITION TOURNÉE ──────────────────────────────────────

function editTournee(idx) {
  STATE.editingTournee = { idx, data: JSON.parse(JSON.stringify(STATE.tournees[idx])) };
  document.getElementById('edit-title').textContent = STATE.editingTournee.data.name;
  renderEditList();
  showScreen('screen-edit');
}

function renderEditList() {
  const list = document.getElementById('edit-list');
  const stops = STATE.editingTournee.data.stops;

  list.innerHTML = stops.map((s, i) => `
    <div class="edit-stop-card ${s._deleted ? 'deleted' : ''}" id="edit-stop-${i}">
      <div class="stop-num">#${s.id}</div>
      <div class="stop-edit-info">
        <input class="stop-edit-name" value="${s.name || 'Arrêt ' + s.id}"
          onchange="renameStop(${i}, this.value)" ${s._deleted ? 'disabled' : ''} />
        <div class="stop-edit-time">📍 ${formatTime(s.ts)} ${s.note ? '· 📝 ' + s.note : ''}</div>
      </div>
      <button class="stop-del-btn" onclick="toggleDeleteStop(${i})">
        ${s._deleted ? '↩️' : '✕'}
      </button>
    </div>
  `).join('');

  // Swipe to delete
  stops.forEach((s, i) => {
    const card = document.getElementById(`edit-stop-${i}`);
    if (!card) return;
    let startX = 0;
    card.addEventListener('touchstart', e => { startX = e.touches[0].clientX; });
    card.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - startX;
      if (dx < -60) toggleDeleteStop(i);
    });
  });
}

function renameStop(idx, name) {
  STATE.editingTournee.data.stops[idx].name = name;
}

function toggleDeleteStop(idx) {
  const stop = STATE.editingTournee.data.stops[idx];
  stop._deleted = !stop._deleted;
  renderEditList();
}

function saveEditedTournee() {
  // Retirer les arrêts supprimés, re-numéroter
  STATE.editingTournee.data.stops = STATE.editingTournee.data.stops
    .filter(s => !s._deleted)
    .map((s, i) => ({ ...s, id: i + 1, name: s.name || `Arrêt ${i + 1}` }));

  STATE.editingTournee.data.stopsCount = STATE.editingTournee.data.stops.length;
  STATE.tournees[STATE.editingTournee.idx] = STATE.editingTournee.data;
  saveTourneesLocal();
  toast('✅ Tournée sauvegardée', 'success');
  refreshManageList();
  showScreen('screen-manage');
}

function cancelEdit() {
  STATE.editingTournee = null;
  showScreen('screen-manage');
}

// ── NAVIGATION GUIDÉE ────────────────────────────────────

function initNavMap() {
  STATE.navMap = L.map('nav-map', { zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(STATE.navMap);
  STATE.navMap.setView([43.2965, 5.3698], 16);
}

async function startNavigation(idx) {
  const tournee = STATE.tournees[idx];
  if (!tournee || !tournee.stops || tournee.stops.length === 0) {
    toast('Cette tournée n\'a pas d\'arrêts enregistrés', 'danger');
    return;
  }

  STATE.currentTournee = tournee;
  STATE.navStops = tournee.stops.filter(s => !s._deleted);
  STATE.navCurrentIdx = 0;
  STATE.navRouteInstructions = [];
  STATE.navInstrIdx = 0;
  STATE.lastSpokenInstruction = '';

  document.getElementById('nav-name').textContent = tournee.name;
  document.getElementById('nav-progress').textContent = `Arrêt 0/${STATE.navStops.length}`;
  document.getElementById('nav-instruction').textContent = '🧭 Démarrage de la navigation...';

  showScreen('screen-nav');

  // Init carte nav
  if (!STATE.navMap) initNavMap();

  // Placer les marqueurs d'arrêts sur la carte
  STATE.navStopMarkers.forEach(m => STATE.navMap.removeLayer(m));
  STATE.navStopMarkers = [];

  STATE.navStops.forEach((stop, i) => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:var(--accent2);color:#000;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff">${i+1}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
    const marker = L.marker([stop.lat, stop.lng], { icon })
      .bindPopup(`<b>Arrêt ${i+1}: ${stop.name}</b>${stop.note ? '<br>' + stop.note : ''}`)
      .addTo(STATE.navMap);
    STATE.navStopMarkers.push(marker);
  });

  await acquireWakeLock('navWakeLock');

  // Démarrer GPS navigation
  STATE.navWatchId = navigator.geolocation.watchPosition(
    onNavGpsUpdate,
    (err) => toast('GPS : ' + err.message, 'warn'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );

  speak(`Navigation démarrée. Tournée ${tournee.name}. ${STATE.navStops.length} arrêts au total.`);
}

function onNavGpsUpdate(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;

  // Mettre à jour marqueur position
  const posIcon = L.divIcon({ className: '', html: '<div class="pos-marker"></div>', iconSize: [16,16], iconAnchor: [8,8] });
  if (!STATE.navPosMarker) {
    STATE.navPosMarker = L.marker([lat, lng], { icon: posIcon }).addTo(STATE.navMap);
  } else {
    STATE.navPosMarker.setLatLng([lat, lng]);
  }
  STATE.navMap.panTo([lat, lng], { animate: true, duration: 0.5 });

  if (STATE.navCurrentIdx >= STATE.navStops.length) return;

  const nextStop = STATE.navStops[STATE.navCurrentIdx];
  const dist = distanceMeters(lat, lng, nextStop.lat, nextStop.lng);

  // Mettre à jour l'UI
  document.getElementById('nav-next-name').textContent = nextStop.name || `Arrêt ${nextStop.id}`;
  document.getElementById('nav-next-dist').textContent = dist < 1000
    ? `${Math.round(dist)} m`
    : `${(dist/1000).toFixed(1)} km`;
  document.getElementById('nav-progress').textContent = `Arrêt ${STATE.navCurrentIdx + 1}/${STATE.navStops.length}`;

  // Arrivée à l'arrêt (< 30m)
  if (dist < 30) {
    arriveAtStop(nextStop);
    return;
  }

  // Guidage vocal par rapport à la distance
  guidanceByDistance(dist, nextStop, lat, lng);

  // Récupérer les instructions de routing
  fetchRouteInstructions(lat, lng, nextStop.lat, nextStop.lng);
}

// Guidage vocal selon la distance
function guidanceByDistance(dist, stop, fromLat, fromLng) {
  let instruction = '';

  if (dist > 500) {
    instruction = `Prochain arrêt : ${stop.name}, dans ${Math.round(dist)} mètres.`;
  } else if (dist > 100) {
    instruction = `Dans ${Math.round(dist)} mètres, arrêt ${stop.name}.`;
  } else if (dist > 30) {
    instruction = `Arrêt ${stop.name} dans ${Math.round(dist)} mètres. Préparez-vous.`;
  }

  if (instruction && instruction !== STATE.lastSpokenInstruction) {
    // Espacer les annonces (ne pas répéter en boucle)
    const key = `${stop.id}_${Math.floor(dist / 50)}`;
    if (STATE._lastGuidanceKey !== key) {
      STATE._lastGuidanceKey = key;
      STATE.lastSpokenInstruction = instruction;
      document.getElementById('nav-instruction').textContent = `📍 ${instruction}`;
      speak(instruction);
    }
  }
}

// Récupérer les instructions de conduite via OpenRouteService
let routeFetchTimeout = null;
let lastRouteFetch = 0;

async function fetchRouteInstructions(fromLat, fromLng, toLat, toLng) {
  // Ne pas spammer l'API — max 1 requête toutes les 15s
  const now = Date.now();
  if (now - lastRouteFetch < 15000) return;
  lastRouteFetch = now;

  try {
    // ⚠️  Clé ORS à remplacer par la vôtre (variable d'env recommandée)
    const ORS_KEY = window.ORS_API_KEY || '5b3ce3597851110001cf6248a4e267dddc734b49a625e4c4e9b79b7e';
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_KEY}&start=${fromLng},${fromLat}&end=${toLng},${toLat}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    const steps = data?.features?.[0]?.properties?.segments?.[0]?.steps;
    if (!steps || steps.length === 0) return;

    STATE.navRouteInstructions = steps;
    STATE.navInstrIdx = 0;

    // Lire la première instruction
    const firstStep = steps[0];
    if (firstStep && firstStep.instruction) {
      const instr = firstStep.instruction;
      document.getElementById('nav-instruction').textContent = `🧭 ${instr}`;
      if (instr !== STATE.lastSpokenInstruction) {
        STATE.lastSpokenInstruction = instr;
        speak(instr);
      }
    }
  } catch(e) {
    // Silencieux — pas critique
  }
}

function arriveAtStop(stop) {
  vibrate([200, 100, 200, 100, 200]);

  const msg = stop.note
    ? `Arrêt ${stop.name}. Note : ${stop.note}`
    : `Arrêt ${stop.name} atteint.`;

  speak(msg);
  document.getElementById('nav-instruction').textContent = `✅ ${msg}`;
  toast(`✅ Arrêt ${stop.name}`, 'success');

  // Marquer visuellement l'arrêt comme visité
  const marker = STATE.navStopMarkers[STATE.navCurrentIdx];
  if (marker) {
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:var(--success);color:#000;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff">✓</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
    marker.setIcon(icon);
  }

  STATE.navCurrentIdx++;
  STATE.navRouteInstructions = [];
  STATE.navInstrIdx = 0;
  STATE.lastSpokenInstruction = '';
  STATE._lastGuidanceKey = '';

  if (STATE.navCurrentIdx >= STATE.navStops.length) {
    // Tournée terminée !
    speak('Félicitations ! Vous avez terminé la tournée.');
    toast('🎉 Tournée terminée !', 'success', 5000);
    document.getElementById('nav-instruction').textContent = '🎉 Tournée terminée ! Bravo !';
    document.getElementById('nav-next-name').textContent = 'Terminé';
    document.getElementById('nav-next-dist').textContent = '—';
    stopNavigation(true);
  } else {
    const next = STATE.navStops[STATE.navCurrentIdx];
    speak(`Prochain arrêt : ${next.name}.`);
    lastRouteFetch = 0; // Forcer un nouveau calcul d'itinéraire
  }
}

function repeatInstruction() {
  const instr = document.getElementById('nav-instruction').textContent;
  speak(instr.replace(/^[🧭✅📍]/, '').trim());
}

function stopNavigation(silent = false) {
  if (STATE.navWatchId) {
    navigator.geolocation.clearWatch(STATE.navWatchId);
    STATE.navWatchId = null;
  }
  releaseWakeLock('navWakeLock');

  if (STATE.navPosMarker) {
    STATE.navMap.removeLayer(STATE.navPosMarker);
    STATE.navPosMarker = null;
  }

  window.speechSynthesis.cancel();

  if (!silent) refreshManageList();
  showScreen('screen-manage');
}

// ── INIT ─────────────────────────────────────────────────

function init() {
  loadTournees();

  // Pré-charger la voix FR si dispo
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }
}

document.addEventListener('DOMContentLoaded', init);
