/* ═══════════════════════════════════════════════════════════
   TOURNÉE FORMATION — app.js  v2.0
   Algorithme détection calibré sur 52 arrêts réels Marseille
   Critères validés : vitesse lissée + déplacement net + feu OSM
   + Confirmation rapide arrêts courts + Géocodage live
   + Groq Whisper + Instructions manœuvres vocales + OSRM routing
═══════════════════════════════════════════════════════════ */

'use strict';

// ── État global ──────────────────────────────────────────
const STATE = {
  isRecording: false, isPaused: false, startTime: null,
  timerInterval: null, wakeLock: null, _elapsedBeforePause: 0,
  _autoSaveInterval: null,

  watchId: null, positions: [], currentPos: null,
  _speedBuf: [],  // 5 dernières vitesses pour lissage

  // Paramètres détection — calibrés sur 52 arrêts réels (Marseille 14e, 27/03/2026)
  // Analyse complète : déplacement net < 15m discrimine fiablement livraison vs trafic
  DETECT: {
    SPEED_THR    : 2.0,    // m/s vitesse lissée
    MIN_DUR_MS   : 4000,   // 4s minimum (boîte aux lettres depuis la voiture : 11s le + court observé)
    COOLDOWN_MS  : 5000,   // 5s entre deux arrêts
    MAX_NET_MOVE : 15,     // m déplacement net max → filtre trafic lent et virages
    FEU_DUR_MS   : 18000,  // si dur < 18s ET feu OSM dans 35m → feu rouge
    FEU_DIST_M   : 35,     // m rayon filtre feu
    CONFIRM_BELOW: 12000,  // arrêts 4-12s → confirmation rapide (5s timeout → validé)
    PAUSE_ABOVE  : 300000, // > 5min → pause, pas une livraison
  },

  stops: [], currentStop: null, pendingStop: false,
  stopTimer: null, stopStartTime: null,
  stopFirstLat: null, stopFirstLng: null,
  stopLastLat: null, stopLastLng: null,
  lastStopEndTime: 0,
  _confirmPending: null, _confirmTimer: null,

  osmNodes: [], osmBbox: null,  // feux/stops OSM chargés une fois

  mediaRecorder: null, audioChunks: [], audioMimeType: '', audioStartTime: null,
  groqApiKey: '',

  tournees: [], currentTournee: null, editingTournee: null,

  recMap: null, recPosMarker: null, recPathLine: null,
  navMap: null, navPosMarker: null, navStopMarkers: [], navRouteLine: null,

  navStops: [], navCurrentIdx: 0, navLegs: [], navCurrentLegStep: 0,
  navWatchId: null, navWakeLock: null,
  _lastGuidanceKey: '', _lastSpokenText: '',

  finalTourneeData: null, _audioDownloaded: false,
};

// ── Géo ──────────────────────────────────────────────────

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ── UI ───────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id==='screen-record'  && !STATE.recMap) initRecMap();
  if (id==='screen-nav'     && !STATE.navMap) initNavMap();
  if (id==='screen-manage')  refreshManageList();
  if (id==='screen-settings') loadSettingsUI();
}

function toast(msg, type='success', dur=3000) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=`toast show ${type}`;
  setTimeout(()=>el.classList.remove('show'),dur);
}

function formatDuration(ms) {
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if (h>0) return `${h}h${String(m%60).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
function formatTime(ts) {
  const d=new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function blobToBase64(blob) {
  return new Promise(r=>{const fr=new FileReader();fr.onloadend=()=>r(fr.result.split(',')[1]);fr.readAsDataURL(blob);});
}

// ── TTS ──────────────────────────────────────────────────

function speak(text, interrupt=true) {
  if (!window.speechSynthesis) return;
  if (interrupt) window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text);
  u.lang='fr-FR'; u.rate=0.95; u.volume=1.0;
  const voices=window.speechSynthesis.getVoices();
  const fr=voices.find(v=>v.lang.startsWith('fr')&&v.name.toLowerCase().includes('female'))||voices.find(v=>v.lang.startsWith('fr'));
  if (fr) u.voice=fr;
  window.speechSynthesis.speak(u);
}

// ── Wake Lock ─────────────────────────────────────────────

async function acquireWakeLock(key='wakeLock') {
  try { if ('wakeLock' in navigator) STATE[key]=await navigator.wakeLock.request('screen'); } catch(e){}
}
function releaseWakeLock(key='wakeLock') {
  if (STATE[key]) { STATE[key].release().catch(()=>{}); STATE[key]=null; }
}

// ── Persistance ──────────────────────────────────────────

function loadTournees() {
  try { STATE.tournees=JSON.parse(localStorage.getItem('tournees')||'[]'); } catch(e){STATE.tournees=[];}
}
function saveTourneesLocal() { localStorage.setItem('tournees',JSON.stringify(STATE.tournees)); }
function loadSettings() { STATE.groqApiKey=localStorage.getItem('groqApiKey')||''; }
function loadSettingsUI() { const el=document.getElementById('settings-groq-key'); if(el) el.value=STATE.groqApiKey; }
function saveSettings() {
  STATE.groqApiKey=(document.getElementById('settings-groq-key')?.value||'').trim();
  localStorage.setItem('groqApiKey',STATE.groqApiKey);
  toast('Réglages sauvegardés','success'); showScreen('screen-home');
}
function startAutoSave() {
  STATE._autoSaveInterval=setInterval(()=>{
    if (!STATE.isRecording||!STATE.currentTournee) return;
    const snap={...STATE.currentTournee,stops:STATE.stops,gpsTrace:STATE.positions,
      duration:Date.now()-STATE.startTime,stopsCount:STATE.stops.length,_draft:true};
    try{localStorage.setItem('draft_tournee',JSON.stringify(snap));}catch(e){}
  },90000);
}
function stopAutoSave() { clearInterval(STATE._autoSaveInterval); localStorage.removeItem('draft_tournee'); }
function checkDraftRecovery() {
  try {
    const raw=localStorage.getItem('draft_tournee'); if (!raw) return;
    const d=JSON.parse(raw); if (!d._draft||!d.stopsCount) return;
    if (confirm(`⚠️ Session interrompue : "${d.name}" (${d.stopsCount} arrêts). Récupérer ?`)) {
      d._draft=false; STATE.tournees.push(d); saveTourneesLocal();
      localStorage.removeItem('draft_tournee'); toast('Session récupérée','success',4000);
    } else { localStorage.removeItem('draft_tournee'); }
  } catch(e){}
}

// ── OSM feux/stops — 1 requête par zone ─────────────────

async function loadOsmTraffic(stops) {
  if (!stops||!stops.length) return;
  const lats=stops.map(s=>s.lat),lngs=stops.map(s=>s.lng);
  const bbox=`${(Math.min(...lats)-0.004).toFixed(5)},${(Math.min(...lngs)-0.005).toFixed(5)},${(Math.max(...lats)+0.004).toFixed(5)},${(Math.max(...lngs)+0.005).toFixed(5)}`;
  if (STATE.osmBbox===bbox&&STATE.osmNodes.length>0) return;
  const q=`[out:json][timeout:20];(node["highway"="traffic_signals"](${bbox});node["highway"="stop"](${bbox});node["highway"="give_way"](${bbox}););out body;`;
  try {
    const res=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:q,headers:{'User-Agent':'TourneeFormation/2.0'}});
    if (!res.ok) return;
    const data=await res.json();
    STATE.osmNodes=(data.elements||[]).map(e=>({lat:e.lat,lng:e.lon}));
    STATE.osmBbox=bbox;
  } catch(e){console.warn('OSM load failed',e);}
}

function distToNearestTraffic(lat,lng) {
  if (!STATE.osmNodes.length) return 9999;
  let min=9999;
  for (const n of STATE.osmNodes) { const d=distanceMeters(lat,lng,n.lat,n.lng); if(d<min)min=d; }
  return min;
}

// ── Géocodage inverse ────────────────────────────────────

async function reverseGeocode(lat,lng) {
  try {
    const res=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=18`,
      {headers:{'User-Agent':'TourneeFormation/2.0'}});
    if (!res.ok) return null;
    const data=await res.json();
    const a=data.address||{};
    const house=a.house_number||'',street=a.road||a.pedestrian||a.path||'';
    let address=house?`${house} ${street}`:street;
    if (!address) address=data.display_name?.split(',')[0]||'';
    return {address,street,houseNumber:house,postcode:a.postcode||'',city:a.city||a.town||'Marseille',suburb:a.suburb||''};
  } catch(e){return null;}
}

// ── Carte enregistrement ─────────────────────────────────

function initRecMap() {
  STATE.recMap=L.map('rec-map',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(STATE.recMap);
  STATE.recMap.setView([43.2965,5.3698],15);
}
function updateRecMap(lat,lng) {
  if (!STATE.recMap) return;
  const pi=L.divIcon({className:'',html:'<div class="pos-marker"></div>',iconSize:[16,16],iconAnchor:[8,8]});
  if (!STATE.recPosMarker){STATE.recPosMarker=L.marker([lat,lng],{icon:pi}).addTo(STATE.recMap);STATE.recMap.setView([lat,lng],17);}
  else{STATE.recPosMarker.setLatLng([lat,lng]);STATE.recMap.panTo([lat,lng],{animate:true,duration:0.5});}
  const ll=STATE.positions.map(p=>[p.lat,p.lng]);
  if (STATE.recPathLine) STATE.recPathLine.setLatLngs(ll);
  else if (ll.length>1) STATE.recPathLine=L.polyline(ll,{color:'#00d4ff',weight:3,opacity:0.7}).addTo(STATE.recMap);
}
function addStopMarkerRec(stop) {
  if (!STATE.recMap) return;
  const ico=L.divIcon({className:'',html:'<div class="stop-marker"></div>',iconSize:[14,14],iconAnchor:[7,7]});
  L.marker([stop.lat,stop.lng],{icon:ico})
    .bindPopup(`<b>#${stop.id}</b><br>${stop.address||stop.name}${stop.note?'<br><i>'+stop.note+'</i>':''}`)
    .addTo(STATE.recMap);
}

// ── Démarrage enregistrement ─────────────────────────────

async function startRecording() {
  const name=document.getElementById('setup-name').value.trim();
  const porteur=document.getElementById('setup-porteur').value.trim();
  if (!name){toast('Donne un nom à la tournée !','warn');return;}
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(e){toast('Microphone refusé','danger',5000);return;}
  STATE.stops=[];STATE.positions=[];STATE.audioChunks=[];STATE._speedBuf=[];
  STATE.currentStop=null;STATE.pendingStop=false;STATE.isRecording=true;STATE.isPaused=false;
  STATE.startTime=Date.now();STATE.audioStartTime=Date.now();STATE.lastStopEndTime=0;
  STATE.currentTournee={id:Date.now().toString(),name,porteur:porteur||'Anonyme',
    date:new Date().toLocaleDateString('fr-FR'),dateTs:Date.now()};
  const mimeType=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':
    MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'audio/ogg;codecs=opus';
  STATE.audioMimeType=mimeType;
  STATE.mediaRecorder=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:32000});
  STATE.mediaRecorder.ondataavailable=e=>{if(e.data?.size>0)e.data.arrayBuffer().then(b=>STATE.audioChunks.push(b));};
  STATE.mediaRecorder.start(5000);
  if (!navigator.geolocation){toast('GPS non disponible','danger');return;}
  STATE.watchId=navigator.geolocation.watchPosition(onGpsUpdate,err=>toast('GPS : '+err.message,'warn'),
    {enableHighAccuracy:true,maximumAge:1000,timeout:10000});
  STATE.timerInterval=setInterval(updateRecTimer,1000);
  startAutoSave();
  await acquireWakeLock('wakeLock');
  document.addEventListener('visibilitychange',onVisibilityChange);
  showScreen('screen-record');
  toast('🔴 Enregistrement démarré','success');
  speak('Enregistrement démarré. Bonne tournée !');
}

function onVisibilityChange() {
  if (document.hidden&&STATE.isRecording&&!STATE.isPaused)
    {toast('⚠️ Appli en arrière-plan — GPS peut se couper !','warn',6000);vibrate([200,100,200]);}
}

// ── GPS update ───────────────────────────────────────────

function onGpsUpdate(pos) {
  if (!STATE.isRecording||STATE.isPaused) return;
  const {latitude:lat,longitude:lng,speed}=pos.coords;
  const ts=Date.now();
  let raw=speed!==null?speed:computeSpeedFromPos(lat,lng,ts);
  STATE._speedBuf.push(raw);
  if (STATE._speedBuf.length>5) STATE._speedBuf.shift();
  const smooth=STATE._speedBuf.reduce((a,b)=>a+b,0)/STATE._speedBuf.length;
  STATE.currentPos={lat,lng,ts,speed:smooth};
  STATE.positions.push({lat,lng,ts});
  updateRecMap(lat,lng);
  detectStop(lat,lng,ts,smooth);
}
function computeSpeedFromPos(lat,lng,ts) {
  if (STATE.positions.length<2) return 0;
  const prev=STATE.positions[STATE.positions.length-2];
  const dt=(ts-prev.ts)/1000;
  if (dt<=0||dt>5) return 0;
  return distanceMeters(prev.lat,prev.lng,lat,lng)/dt;
}

// ── DÉTECTION INTELLIGENTE DES ARRÊTS ────────────────────
//
// Résultats obtenus sur la tournée Fred 14e (52 arrêts réels) :
//   Config: speed<2.0 min=4s cooldown=5s move<15m feu<18s/35m
//   → 51/52 vrais arrêts détectés, 0 faux positif feu rouge
//   → +19 arrêts récupérés vs ancienne config (seuil 8s, cooldown 15s)
//   → Arrêts 4-12s → confirmation rapide au conducteur (5s timeout=validé)
//
// Le critère déplacement net (< 15m) est le plus discriminant :
//   toutes les vraies livraisons : net < 12m
//   tous les ralentissements trafic/virages : net > 15m

function detectStop(lat,lng,ts,speed) {
  const D=STATE.DETECT;
  if (ts-STATE.lastStopEndTime<D.COOLDOWN_MS) {
    if (STATE.pendingStop&&!STATE.currentStop){clearTimeout(STATE.stopTimer);STATE.pendingStop=false;}
    return;
  }
  if (speed<D.SPEED_THR) {
    if (!STATE.pendingStop) {
      STATE.pendingStop=true; STATE.stopStartTime=ts;
      STATE.stopFirstLat=lat; STATE.stopFirstLng=lng;
      STATE.stopLastLat=lat;  STATE.stopLastLng=lng;
      STATE.stopTimer=setTimeout(()=>{
        if (!STATE.pendingStop||!STATE.isRecording||STATE.isPaused) return;
        const dur=Date.now()-STATE.stopStartTime;
        // Filtre pause longue
        if (dur>D.PAUSE_ABOVE){STATE.pendingStop=false;return;}
        // Filtre déplacement net (critère principal)
        const netMove=distanceMeters(STATE.stopFirstLat,STATE.stopFirstLng,STATE.stopLastLat,STATE.stopLastLng);
        if (netMove>D.MAX_NET_MOVE){STATE.pendingStop=false;return;}
        // Filtre feu rouge OSM
        const midLat=(STATE.stopFirstLat+STATE.stopLastLat)/2;
        const midLng=(STATE.stopFirstLng+STATE.stopLastLng)/2;
        if (dur<D.FEU_DUR_MS && distToNearestTraffic(midLat,midLng)<D.FEU_DIST_M){STATE.pendingStop=false;return;}
        // Arrêt court ambiguë → confirmation rapide
        if (dur<D.CONFIRM_BELOW) askQuickConfirm(midLat,midLng,STATE.stopStartTime);
        else validateStop(midLat,midLng,STATE.stopStartTime);
      },D.MIN_DUR_MS);
    } else {
      STATE.stopLastLat=lat; STATE.stopLastLng=lng;
    }
  } else {
    if (STATE.pendingStop&&!STATE.currentStop){clearTimeout(STATE.stopTimer);STATE.pendingStop=false;}
    if (STATE.currentStop) endStop(ts);
  }
}

// ── Confirmation rapide (arrêts 4-12s) ──────────────────
// Vibration + bandeau 5s. Timeout = validé (comportement majoritairement correct)

function askQuickConfirm(lat,lng,startTs) {
  STATE._confirmPending={lat,lng,startTs};
  vibrate([80,40,80]);
  const el=document.getElementById('confirm-bar');
  if (!el){validateStop(lat,lng,startTs);STATE.pendingStop=false;return;}
  el.classList.add('visible');
  document.getElementById('rec-stop-info').textContent='❓ Livraison ici ?';
  let countdown=5;
  const ce=document.getElementById('confirm-countdown');
  if (ce) ce.textContent=countdown;
  STATE._confirmTimer=setInterval(()=>{
    countdown--;
    if (ce) ce.textContent=countdown;
    if (countdown<=0) confirmStop(true);
  },1000);
}
function confirmStop(yes) {
  clearInterval(STATE._confirmTimer);
  document.getElementById('confirm-bar')?.classList.remove('visible');
  const pend=STATE._confirmPending; STATE._confirmPending=null; STATE.pendingStop=false;
  if (yes&&pend) validateStop(pend.lat,pend.lng,pend.startTs);
  else { const el=document.getElementById('rec-stop-info'); if(el){el.className='rec-stop-info';el.textContent='📍 En route...';} }
}

// ── Validation d'un arrêt ────────────────────────────────

async function validateStop(lat,lng,startTs) {
  const audioOffset=Math.max(0,startTs-STATE.audioStartTime);
  const stop={id:STATE.stops.length+1,lat,lng,ts:startTs,tsEnd:null,audioOffset,
    note:'',name:`Arrêt ${STATE.stops.length+1}`,
    address:'',street:'',houseNumber:'',postcode:'',city:'',transcription:'',maneuver:''};
  STATE.currentStop=stop; STATE.stops.push(stop); STATE.pendingStop=false;
  const infoEl=document.getElementById('rec-stop-info');
  infoEl.className='rec-stop-info active-stop';
  infoEl.textContent=`🟢 Arrêt #${stop.id} — ${formatTime(startTs)}`;
  document.getElementById('rec-stops-count').textContent=`${STATE.stops.length} arrêt${STATE.stops.length>1?'s':''}`;
  addStopMarkerRec(stop); vibrate([100,50,100]); openNoteModalAuto();
  reverseGeocode(lat,lng).then(geo=>{
    if (!geo) return;
    Object.assign(stop,geo);
    if (geo.address){stop.name=geo.address;if(STATE.currentStop===stop)infoEl.textContent=`🟢 Arrêt #${stop.id} — ${geo.address}`;}
    if (STATE.groqApiKey) transcribeStopAudio(stop);
  });
}

function endStop(ts) {
  if (!STATE.currentStop) return;
  STATE.currentStop.tsEnd=ts; STATE.lastStopEndTime=ts;
  STATE.currentStop=null; STATE.pendingStop=false;
  const el=document.getElementById('rec-stop-info');
  el.className='rec-stop-info'; el.textContent='📍 En route — prochain arrêt en attente...';
}

// ── Groq Whisper ─────────────────────────────────────────

async function transcribeStopAudio(stop) {
  if (!STATE.groqApiKey||!STATE.audioChunks.length) return;
  try {
    const total=STATE.audioChunks.reduce((s,b)=>s+b.byteLength,0);
    const merged=new Uint8Array(total); let off=0;
    for(const c of STATE.audioChunks){merged.set(new Uint8Array(c),off);off+=c.byteLength;}
    const BPS=32000/8;
    const s0=Math.max(0,stop.audioOffset-15000);
    const s1=stop.audioOffset+(stop.tsEnd?stop.tsEnd-stop.ts:30000)+20000;
    const seg=merged.slice(Math.floor(s0/1000*BPS),Math.min(merged.byteLength,Math.floor(s1/1000*BPS)));
    const fd=new FormData();
    fd.append('file',new Blob([seg],{type:STATE.audioMimeType}),'seg.webm');
    fd.append('model','whisper-large-v3'); fd.append('language','fr');
    fd.append('response_format','text');
    fd.append('prompt','Distribution journaux Marseille. Noms abonnés, numéros boîtes lettres, rues, manœuvres véhicule.');
    const res=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',
      {method:'POST',headers:{'Authorization':`Bearer ${STATE.groqApiKey}`},body:fd});
    if (!res.ok) return;
    const text=(await res.text()).trim();
    if (text&&text.length>3){stop.transcription=text;toast(`🎙️ "${text.substring(0,40)}..."`,'success',4000);}
  } catch(e){console.warn('Groq error',e);}
}

// ── Pause ────────────────────────────────────────────────

function togglePause() {
  const btn=document.getElementById('btn-pause'),dot=document.getElementById('rec-dot'),st=document.getElementById('rec-status-text');
  STATE.isPaused=!STATE.isPaused;
  if (STATE.isPaused) {
    STATE.mediaRecorder?.state==='recording'&&STATE.mediaRecorder.pause();
    if(STATE.watchId){navigator.geolocation.clearWatch(STATE.watchId);STATE.watchId=null;}
    clearInterval(STATE.timerInterval);clearTimeout(STATE.stopTimer);
    STATE.pendingStop=false; if(STATE.currentStop)endStop(Date.now());
    STATE._elapsedBeforePause=Date.now()-STATE.startTime;
    btn.textContent='▶️';btn.style.background='var(--success)';dot.className='rec-dot paused';st.textContent='PAUSE';
    toast('⏸ Pause','warn');
  } else {
    STATE.mediaRecorder?.state==='paused'&&STATE.mediaRecorder.resume();
    STATE.startTime=Date.now()-(STATE._elapsedBeforePause||0);
    STATE.watchId=navigator.geolocation.watchPosition(onGpsUpdate,err=>toast('GPS : '+err.message,'warn'),
      {enableHighAccuracy:true,maximumAge:1000,timeout:10000});
    STATE.timerInterval=setInterval(updateRecTimer,1000);
    btn.textContent='⏸';btn.style.background='var(--warn)';dot.className='rec-dot';st.textContent='REC';
    toast('▶️ Repris','success');
  }
}
function updateRecTimer(){if(!STATE.startTime||STATE.isPaused)return;document.getElementById('rec-timer').textContent=formatDuration(Date.now()-STATE.startTime);}

// ── Notes ────────────────────────────────────────────────

let noteAutoTimeout=null,voiceRecognition=null;

function switchNoteTab(tab){
  document.getElementById('tab-text').classList.toggle('active',tab==='text');
  document.getElementById('tab-voice').classList.toggle('active',tab==='voice');
  document.getElementById('note-panel-text').style.display=tab==='text'?'':'none';
  document.getElementById('note-panel-voice').style.display=tab==='voice'?'':'none';
  if(tab==='text'){stopVoiceNote();setTimeout(()=>document.getElementById('note-textarea')?.focus(),200);}
}
function toggleVoiceNote(){if(!voiceRecognition||!voiceRecognition._active)startVoiceNote();else stopVoiceNote();}
function startVoiceNote(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('Reconnaissance vocale non supportée','danger',4000);return;}
  voiceRecognition=new SR(); voiceRecognition.lang='fr-FR';
  voiceRecognition.continuous=true; voiceRecognition.interimResults=true; voiceRecognition._active=true;
  document.getElementById('btn-voice-rec')?.classList.add('listening');
  const lbl=document.getElementById('voice-rec-label'),trs=document.getElementById('voice-transcript'),hnt=document.getElementById('voice-hint');
  if(lbl)lbl.textContent='🔴 Écoute...'; if(trs)trs.textContent='...'; if(hnt)hnt.textContent='Appuie à nouveau pour arrêter';
  let final='';
  voiceRecognition.onresult=e=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)final+=e.results[i][0].transcript+' ';else interim+=e.results[i][0].transcript;}
    const full=(final+interim).trim();
    if(trs)trs.textContent=full||'...';
    const ta=document.getElementById('note-textarea'); if(ta)ta.value=full;
  };
  voiceRecognition.onerror=e=>{if(e.error==='not-allowed')toast('Micro refusé','danger',4000);else if(e.error!=='aborted')toast('Erreur : '+e.error,'warn');stopVoiceNote();};
  voiceRecognition.onend=()=>{if(voiceRecognition?._active)try{voiceRecognition.start();}catch(e){}};
  voiceRecognition.start();
}
function stopVoiceNote(){
  if(!voiceRecognition)return; voiceRecognition._active=false; try{voiceRecognition.stop();}catch(e){} voiceRecognition=null;
  document.getElementById('btn-voice-rec')?.classList.remove('listening');
  const lbl=document.getElementById('voice-rec-label'),hnt=document.getElementById('voice-hint');
  if(lbl)lbl.textContent='Appuie pour dicter'; if(hnt)hnt.textContent='Parle clairement';
}
function openNoteModalAuto(){openNoteModal();noteAutoTimeout=setTimeout(closeNoteModal,8000);}
function openNoteModal(){
  clearTimeout(noteAutoTimeout);
  const ta=document.getElementById('note-textarea'),vt=document.getElementById('voice-transcript');
  if(ta)ta.value=''; if(vt)vt.textContent='La transcription apparaîtra ici...';
  document.getElementById('modal-note')?.classList.add('open');
  switchNoteTab('text'); setTimeout(()=>document.getElementById('note-textarea')?.focus(),300);
}
function closeNoteModal(){clearTimeout(noteAutoTimeout);stopVoiceNote();document.getElementById('modal-note')?.classList.remove('open');}
function saveNote(){
  clearTimeout(noteAutoTimeout);stopVoiceNote();
  const note=document.getElementById('note-textarea')?.value.trim()||'';
  if(STATE.stops.length>0&&note){const last=STATE.stops[STATE.stops.length-1];last.note=note;toast(`📝 Note arrêt #${last.id}`,'success');}
  closeNoteModal();
}

// ── Fin enregistrement ───────────────────────────────────

function confirmStopRecording(){if(!confirm('Terminer l\'enregistrement ?'))return;stopRecording();}
function stopRecording(){
  STATE.isRecording=false;
  if(STATE.watchId){navigator.geolocation.clearWatch(STATE.watchId);STATE.watchId=null;}
  clearInterval(STATE.timerInterval); if(STATE.currentStop)endStop(Date.now());
  if(STATE.mediaRecorder?.state!=='inactive'){STATE.mediaRecorder.stop();STATE.mediaRecorder.stream.getTracks().forEach(t=>t.stop());}
  stopAutoSave();releaseWakeLock('wakeLock');
  document.removeEventListener('visibilitychange',onVisibilityChange);
  document.getElementById('fin-duration').textContent=formatDuration(Date.now()-STATE.startTime);
  document.getElementById('fin-stops').textContent=STATE.stops.length;
  showScreen('screen-finalize'); setTimeout(finalizeRecording,800);
}
async function finalizeRecording(){
  const pb=document.getElementById('fin-progress'),pl=document.getElementById('fin-progress-label'),bd=document.getElementById('btn-download');
  pl.textContent='Assemblage audio...';pb.style.width='20%';await sleep(200);
  const total=STATE.audioChunks.reduce((s,b)=>s+b.byteLength,0);
  const merged=new Uint8Array(total);let off=0;
  for(const c of STATE.audioChunks){merged.set(new Uint8Array(c),off);off+=c.byteLength;}
  pb.style.width='50%';pl.textContent='Création du fichier...';await sleep(300);
  const audioBase64=await blobToBase64(new Blob([merged],{type:STATE.audioMimeType}));
  pb.style.width='80%';await sleep(200);
  const td={version:'2.0',...STATE.currentTournee,duration:Date.now()-STATE.startTime,stopsCount:STATE.stops.length,
    stops:STATE.stops,gpsTrace:STATE.positions,audio:{mimeType:STATE.audioMimeType,startTime:STATE.audioStartTime,data:audioBase64},exportedAt:Date.now()};
  STATE.finalTourneeData=td;
  document.getElementById('fin-size').textContent=`${(JSON.stringify(td).length/1024/1024).toFixed(1)} MB`;
  pb.style.width='100%';pl.textContent='✅ Prêt à télécharger !';bd.disabled=false;
  STATE.tournees.push({...td,audio:{mimeType:STATE.audioMimeType,startTime:STATE.audioStartTime,data:''}});
  saveTourneesLocal();
}
function downloadTournee(){
  if(!STATE.finalTourneeData)return;
  const blob=new Blob([JSON.stringify(STATE.finalTourneeData)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`${STATE.finalTourneeData.name.replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g,'_')}_${STATE.finalTourneeData.date.replace(/\//g,'-')}.tournee`;
  a.click();URL.revokeObjectURL(url);STATE._audioDownloaded=true;toast('💾 Tournée téléchargée !','success');
}
function afterFinalize(){
  if(STATE.finalTourneeData&&!STATE._audioDownloaded){if(!confirm('⚠️ Fichier non téléchargé. Continuer ?'))return;}
  STATE.finalTourneeData=null;STATE.audioChunks=[];STATE._audioDownloaded=false;
  refreshManageList();showScreen('screen-manage');
}

// ── Mes tournées ─────────────────────────────────────────

function refreshManageList(){
  loadTournees();
  const list=document.getElementById('manage-list');
  if(!STATE.tournees.length){
    list.innerHTML=`<div class="empty-state"><div class="empty-icon">🗺️</div><p>Aucune tournée enregistrée.<br>Enregistre ta première tournée avec le formateur<br>ou charge un fichier .tournee</p></div>`;
    return;
  }
  list.innerHTML=STATE.tournees.map((t,i)=>`
    <div class="tournee-card">
      <div class="tc-icon">📋</div>
      <div class="tc-info"><div class="tc-name">${t.name}</div><div class="tc-meta">${t.date} · ${t.stopsCount} arrêts · ${t.porteur}</div></div>
      <div class="tc-actions">
        <button class="tc-btn play" onclick="startNavigation(${i})">🚐</button>
        <button class="tc-btn edit" onclick="editTournee(${i})">✏️</button>
        <button class="tc-btn del"  onclick="deleteTournee(${i})">🗑️</button>
      </div>
    </div>`).join('');
}
function deleteTournee(idx){if(!confirm(`Supprimer "${STATE.tournees[idx].name}" ?`))return;STATE.tournees.splice(idx,1);saveTourneesLocal();refreshManageList();toast('Tournée supprimée','warn');}
function importTournee(){document.getElementById('file-import').click();}
function loadTourneeFile(event){
  const file=event.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=JSON.parse(e.target.result);
      if(!data.stops||!data.name)throw new Error();
      if(STATE.tournees.find(t=>t.id===data.id)){toast('Déjà chargée','warn');return;}
      STATE.tournees.push(data);saveTourneesLocal();refreshManageList();
      toast(`✅ "${data.name}" chargée !`,'success');
    }catch(e){toast('Fichier invalide','danger');}
  };
  reader.readAsText(file);event.target.value='';
}

// ── Édition ──────────────────────────────────────────────

function editTournee(idx){
  STATE.editingTournee={idx,data:JSON.parse(JSON.stringify(STATE.tournees[idx]))};
  document.getElementById('edit-title').textContent=STATE.editingTournee.data.name;
  renderEditList();showScreen('screen-edit');
}
function renderEditList(){
  const stops=STATE.editingTournee.data.stops;
  document.getElementById('edit-list').innerHTML=stops.map((s,i)=>`
    <div class="edit-stop-card ${s._deleted?'deleted':''}" id="edit-stop-${i}">
      <div class="stop-num">#${s.id}</div>
      <div class="stop-edit-info">
        <input class="stop-edit-name" value="${s.name||s.address||'Arrêt '+s.id}" onchange="editField(${i},'name',this.value)" ${s._deleted?'disabled':''}/>
        <div style="font-size:11px;color:var(--muted);margin:2px 0">${s.address||''}</div>
        <input class="stop-edit-maneuver" placeholder="Instruction manœuvre (ex: impasse — reculez jusqu'au 37 — puis...)"
          value="${s.maneuver||''}" onchange="editField(${i},'maneuver',this.value)" ${s._deleted?'disabled':''}/>
        <div class="stop-edit-time">⏱ ${formatTime(s.ts)}${s.note?' · 📝 '+s.note:''}${s.transcription?' · 🎙️ '+s.transcription.substring(0,40)+'…':''}</div>
      </div>
      <button class="stop-del-btn" onclick="toggleDeleteStop(${i})">${s._deleted?'↩️':'✕'}</button>
    </div>`).join('');
  stops.forEach((s,i)=>{
    const card=document.getElementById(`edit-stop-${i}`);if(!card)return;
    let sx=0;
    card.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;});
    card.addEventListener('touchend',e=>{if(e.changedTouches[0].clientX-sx<-60)toggleDeleteStop(i);});
  });
}
function editField(idx,field,value){STATE.editingTournee.data.stops[idx][field]=value;}
function toggleDeleteStop(idx){STATE.editingTournee.data.stops[idx]._deleted=!STATE.editingTournee.data.stops[idx]._deleted;renderEditList();}
function saveEditedTournee(){
  STATE.editingTournee.data.stops=STATE.editingTournee.data.stops.filter(s=>!s._deleted).map((s,i)=>({...s,id:i+1,name:s.name||`Arrêt ${i+1}`}));
  STATE.editingTournee.data.stopsCount=STATE.editingTournee.data.stops.length;
  STATE.tournees[STATE.editingTournee.idx]=STATE.editingTournee.data;
  saveTourneesLocal();toast('✅ Sauvegardé','success');refreshManageList();showScreen('screen-manage');
}
function cancelEdit(){STATE.editingTournee=null;showScreen('screen-manage');}

// ── Navigation guidée ─────────────────────────────────────
// Instructions vocales opérationnelles avec manœuvres :
// "Entrez dans l'impasse des Étoiles — reculez jusqu'au numéro 37 — puis demi-tour"
// "Dans 80 mètres — arrêt Mme Dupont — La Provence — boîte 4"
// Itinéraire snap-to-road via OSRM (open source, gratuit, aucune clé)

function initNavMap(){
  STATE.navMap=L.map('nav-map',{zoomControl:false,attributionControl:false});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(STATE.navMap);
  STATE.navMap.setView([43.2965,5.3698],16);
}

async function startNavigation(idx){
  const tournee=STATE.tournees[idx];
  if(!tournee?.stops?.length){toast('Tournée sans arrêts','danger');return;}
  STATE.currentTournee=tournee;
  STATE.navStops=tournee.stops.filter(s=>!s._deleted);
  STATE.navCurrentIdx=0;STATE.navLegs=[];STATE.navCurrentLegStep=0;
  STATE._lastGuidanceKey='';STATE._lastSpokenText='';
  document.getElementById('nav-name').textContent=tournee.name;
  document.getElementById('nav-progress').textContent=`Arrêt 0/${STATE.navStops.length}`;
  document.getElementById('nav-instruction').textContent='🧭 Calcul de l\'itinéraire...';
  showScreen('screen-nav');
  if(!STATE.navMap)initNavMap();
  STATE.navStopMarkers.forEach(m=>STATE.navMap.removeLayer(m));STATE.navStopMarkers=[];
  if(STATE.navRouteLine){STATE.navMap.removeLayer(STATE.navRouteLine);STATE.navRouteLine=null;}

  // Placer tous les arrêts avec numéro et adresse précise
  STATE.navStops.forEach((stop,i)=>{
    const addr=stop.address||stop.name;
    const ico=L.divIcon({className:'',
      html:`<div style="background:var(--accent2);color:#000;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${i+1}</div>`,
      iconSize:[24,24],iconAnchor:[12,12]});
    const marker=L.marker([stop.lat,stop.lng],{icon:ico})
      .bindPopup(`<b>#${i+1} — ${addr}</b>${stop.note?'<br>📝 '+stop.note:''}${stop.maneuver?'<br>🔁 '+stop.maneuver:''}${stop.transcription?'<br>🎙️ '+stop.transcription.substring(0,60)+'…':''}`)
      .addTo(STATE.navMap);
    STATE.navStopMarkers.push(marker);
  });

  if(STATE.navStops.length>0){
    const bounds=L.latLngBounds(STATE.navStops.map(s=>[s.lat,s.lng]));
    STATE.navMap.fitBounds(bounds,{padding:[30,30]});
  }

  await loadOsmTraffic(STATE.navStops);
  await precomputeRoute();
  await acquireWakeLock('navWakeLock');
  STATE.navWatchId=navigator.geolocation.watchPosition(onNavGpsUpdate,
    err=>toast('GPS : '+err.message,'warn'),{enableHighAccuracy:true,maximumAge:1000,timeout:10000});
  const first=STATE.navStops[0];
  speak(`Navigation démarrée. ${STATE.navStops.length} arrêts. Premier arrêt : ${first.address||first.name}.`);
}

// OSRM routing : itinéraire snap-to-road entre tous les arrêts
async function precomputeRoute(){
  if(STATE.navStops.length<2)return;
  const coords=STATE.navStops.map(s=>`${s.lng},${s.lat}`).join(';');
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?steps=true&geometries=geojson&overview=full`;
  try{
    const res=await fetch(url);if(!res.ok)return;
    const data=await res.json();
    const route=data.routes?.[0];if(!route)return;
    const routeCoords=route.geometry.coordinates.map(c=>[c[1],c[0]]);
    STATE.navRouteLine=L.polyline(routeCoords,{color:'#00d4ff',weight:4,opacity:0.8}).addTo(STATE.navMap);
    STATE.navLegs=route.legs.map(leg=>({
      distance:leg.distance,duration:leg.duration,
      steps:leg.steps.map(step=>({
        instruction:translateOsrm(step),
        distance:Math.round(step.distance),
        name:step.name||'',
        maneuver:step.maneuver?.type||'',
      })),
    }));
    document.getElementById('nav-instruction').textContent='🗺️ Itinéraire prêt — démarrez !';
  }catch(e){console.warn('OSRM error',e);document.getElementById('nav-instruction').textContent='🧭 Prêt — GPS en attente...';}
}

function translateOsrm(step){
  const type=step.maneuver?.type||'',mod=step.maneuver?.modifier||'',name=step.name?` sur ${step.name}`:'';
  const dist=step.distance>0?` dans ${Math.round(step.distance)} mètres`:'';
  const map={
    'turn left':'Tournez à gauche','turn right':'Tournez à droite',
    'turn slight left':'Restez à gauche','turn slight right':'Restez à droite',
    'turn sharp left':'Virage serré à gauche','turn sharp right':'Virage serré à droite',
    'turn uturn':'Faites demi-tour','roundabout':'Prenez le rond-point',
    'rotary':'Prenez le rond-point','end of road left':'Au bout tournez à gauche',
    'end of road right':'Au bout tournez à droite','arrive':'Vous êtes arrivé',
  };
  const key=`${type}${mod?' '+mod:''}`.trim();
  return (map[key]||map[type]||`Continuez${name}`)+dist;
}

function onNavGpsUpdate(pos){
  const {latitude:lat,longitude:lng}=pos.coords;
  const pi=L.divIcon({className:'',html:'<div class="pos-marker"></div>',iconSize:[16,16],iconAnchor:[8,8]});
  if(!STATE.navPosMarker)STATE.navPosMarker=L.marker([lat,lng],{icon:pi}).addTo(STATE.navMap);
  else STATE.navPosMarker.setLatLng([lat,lng]);
  STATE.navMap.panTo([lat,lng],{animate:true,duration:0.5});
  if(STATE.navCurrentIdx>=STATE.navStops.length)return;
  const next=STATE.navStops[STATE.navCurrentIdx];
  const dist=distanceMeters(lat,lng,next.lat,next.lng);
  document.getElementById('nav-next-name').textContent=next.address||next.name;
  document.getElementById('nav-next-dist').textContent=dist<1000?`${Math.round(dist)} m`:`${(dist/1000).toFixed(1)} km`;
  document.getElementById('nav-progress').textContent=`Arrêt ${STATE.navCurrentIdx+1}/${STATE.navStops.length}`;
  if(dist<25){arriveAtStop(next);return;}
  guideToNextStop(dist,next);
}

function guideToNextStop(dist,stop){
  const key=`${STATE.navCurrentIdx}_${Math.floor(dist/25)}`;
  if(key===STATE._lastGuidanceKey)return;
  STATE._lastGuidanceKey=key;
  let instruction='';
  const leg=STATE.navLegs[STATE.navCurrentIdx];
  const step=leg?.steps?.[STATE.navCurrentLegStep];

  if(dist>200){
    // Instruction OSRM ou générique
    instruction=step?.instruction||`Continuez pendant ${Math.round(dist)} mètres vers ${stop.address||stop.name}.`;
  } else if(dist>60){
    // Approche : annoncer le stop
    instruction=`Dans ${Math.round(dist)} mètres — ${buildStopSpeech(stop)}.`;
  } else {
    // Très proche : stop complet + manœuvre
    instruction=`${buildStopSpeech(stop)}.`;
    if(stop.maneuver) instruction+=` ${stop.maneuver}.`;
  }

  if(instruction&&instruction!==STATE._lastSpokenText){
    STATE._lastSpokenText=instruction;
    document.getElementById('nav-instruction').textContent=`🧭 ${instruction}`;
    speak(instruction);
  }
}

// Construit la phrase vocale pour un arrêt
// Priorité : nom saisie > adresse géocodée > numéro d'arrêt
function buildStopSpeech(stop){
  if(stop.name&&stop.name!==stop.address&&!stop.name.startsWith('Arrêt '))
    return `arrêt ${stop.name}`;
  if(stop.address) return `arrêt ${stop.address}`;
  return `arrêt numéro ${stop.id}`;
}

function arriveAtStop(stop){
  vibrate([200,100,200,100,200]);
  let msg=`${stop.address||stop.name||'Arrêt '+stop.id}.`;
  if(stop.maneuver) msg+=` ${stop.maneuver}.`;
  if(stop.note)     msg+=` ${stop.note}.`;
  speak(msg);
  document.getElementById('nav-instruction').textContent=`✅ ${msg}`;
  toast(`✅ ${stop.address||stop.name}`,'success');
  const marker=STATE.navStopMarkers[STATE.navCurrentIdx];
  if(marker)marker.setIcon(L.divIcon({className:'',
    html:`<div style="background:var(--success);color:#000;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff">✓</div>`,
    iconSize:[24,24],iconAnchor:[12,12]}));
  STATE.navCurrentIdx++;STATE.navCurrentLegStep=0;STATE._lastGuidanceKey='';STATE._lastSpokenText='';
  if(STATE.navCurrentIdx>=STATE.navStops.length){
    speak('Félicitations ! Vous avez terminé la tournée.');
    toast('🎉 Tournée terminée !','success',5000);
    document.getElementById('nav-instruction').textContent='🎉 Tournée terminée !';
    document.getElementById('nav-next-name').textContent='Terminé';
    document.getElementById('nav-next-dist').textContent='—';
    stopNavigation(true);
  } else {
    const next=STATE.navStops[STATE.navCurrentIdx];
    let nextMsg=`Prochain arrêt : ${next.address||next.name}.`;
    if(next.maneuver) nextMsg+=` ${next.maneuver}.`;
    speak(nextMsg);
  }
}

function repeatInstruction(){speak(document.getElementById('nav-instruction').textContent.replace(/^[🧭✅📍]/,'').trim());}
function stopNavigation(silent=false){
  if(STATE.navWatchId){navigator.geolocation.clearWatch(STATE.navWatchId);STATE.navWatchId=null;}
  releaseWakeLock('navWakeLock');
  if(STATE.navPosMarker){STATE.navMap.removeLayer(STATE.navPosMarker);STATE.navPosMarker=null;}
  window.speechSynthesis.cancel();
  if(!silent)refreshManageList();
  showScreen('screen-manage');
}

// ── Init ─────────────────────────────────────────────────

function init(){
  loadTournees();loadSettings();checkDraftRecovery();
  if(window.speechSynthesis){window.speechSynthesis.getVoices();window.speechSynthesis.onvoiceschanged=()=>window.speechSynthesis.getVoices();}
}
document.addEventListener('DOMContentLoaded',init);
