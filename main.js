import {
  FilesetResolver,
  PoseLandmarker,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const MODEL_URLS = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
};

const GAME_DEFS = [
  { id: "wave", name: "손 흔들기", emoji: "👋", minStage: 1, baseDifficulty: 1, blurb: "화면에 나온 방향으로 손을 크게 흔들어요!" },
  { id: "punch", name: "펀치 마스터", emoji: "🥊", minStage: 1, baseDifficulty: 2, blurb: "박자에 맞춰 목표 방향으로 펀치!" },
  { id: "target", name: "타겟 터치", emoji: "🎯", minStage: 1, baseDifficulty: 2, blurb: "손으로 반짝이는 타겟을 정확히 터치하세요." },
  { id: "dodge", name: "좌우 피하기", emoji: "↔️", minStage: 2, baseDifficulty: 3, blurb: "몸을 좌우로 움직여 장애물을 피하세요." },
];

const state = {
  screen: "home",
  stage: 1,
  hp: 5,
  totalScore: 0,
  runScore: 0,
  combo: 0,
  maxCombo: 0,
  recentGames: [],
  selectedGames: [],
  selectedIndex: 0,
  currentGame: null,
  gameScore: 0,
  gameCounts: { perfect: 0, great: 0, good: 0, miss: 0 },
  muted: false,
  cameraReady: false,
  tracking: false,
  pose: null,
  hands: [],
  lastLandmarksAt: 0,
  poseLandmarker: null,
  handLandmarker: null,
  visionReady: false,
  videoStream: null,
  lastVideoTime: -1,
  gameRAF: 0,
  gameStartedAt: 0,
  difficulty: 1,
  audioContext: null,
  audioReady: false,
  saveKey: "rhythm-game-party-v1",
};

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll(".screen")];
const homeBestStage = $("bestStageHome");
const homeBestScore = $("bestScoreHome");

const camera = {
  video: $("cameraVideo"),
  overlay: $("cameraOverlay"),
  gameVideo: $("gameVideo"),
  gameOverlay: $("gameOverlay"),
};

function showScreen(name) {
  state.screen = name;
  screens.forEach((s) => s.classList.toggle("active", s.id === `screen-${name}`));
}

function loadBest() {
  try { return JSON.parse(localStorage.getItem(state.saveKey) || "{}"); }
  catch { return {}; }
}
function saveBest(stage, score) {
  const best = loadBest();
  const next = { bestStage: Math.max(best.bestStage || 1, stage), bestScore: Math.max(best.bestScore || 0, score) };
  localStorage.setItem(state.saveKey, JSON.stringify(next));
  homeBestStage.textContent = next.bestStage;
  homeBestScore.textContent = next.bestScore.toLocaleString();
}
function refreshHomeBest() {
  const best = loadBest();
  homeBestStage.textContent = best.bestStage || 1;
  homeBestScore.textContent = (best.bestScore || 0).toLocaleString();
}
refreshHomeBest();

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 2300);
}

function ensureAudio() {
  if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioContext.state === "suspended") state.audioContext.resume();
  state.audioReady = true;
}
function beep(freq = 440, duration = 0.08, type = "sine", volume = 0.04) {
  if (state.muted || !state.audioContext) return;
  const ctx = state.audioContext;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + duration);
}
function hitSound(kind) {
  ensureAudio();
  const map = { perfect: 880, great: 690, good: 520, miss: 180, stage: 980 };
  beep(map[kind] || 440, kind === "miss" ? 0.13 : 0.07, kind === "miss" ? "sawtooth" : "triangle", kind === "miss" ? .025 : .035);
}

$("soundBtn").addEventListener("click", () => {
  state.muted = !state.muted;
  $("soundBtn").textContent = state.muted ? "🔇" : "🔊";
  if (!state.muted) { ensureAudio(); beep(660); }
});

$("playBtn").addEventListener("click", async () => {
  ensureAudio();
  showScreen("calibrate");
  await setupCamera();
});
$("howBtn").addEventListener("click", () => showScreen("how"));
$("backHomeBtn").addEventListener("click", () => showScreen("home"));
$("calibrateBackBtn").addEventListener("click", () => { stopCamera(); showScreen("home"); });
$("gameOverHomeBtn").addEventListener("click", () => { stopCamera(); refreshHomeBest(); showScreen("home"); });
$("restartBtn").addEventListener("click", async () => { resetRun(); showScreen("calibrate"); await setupCamera(); });
$("cameraBtn").addEventListener("click", setupCamera);
$("startRunBtn").addEventListener("click", () => { ensureAudio(); beginRun(); });
$("stageStartBtn").addEventListener("click", startSelectedGame);
$("continueBtn").addEventListener("click", continueAfterGame);
$("nextStageBtn").addEventListener("click", () => { state.stage += 1; state.difficulty = 1 + Math.floor((state.stage - 1) / 2); prepareStage(); });
$("quitRunBtn").addEventListener("click", () => { stopCamera(); refreshHomeBest(); showScreen("home"); });

async function createVision() {
  if (state.visionReady) return true;
  try {
    $("cameraMessage").textContent = "인식 모델을 불러오는 중… (첫 실행은 조금 걸릴 수 있어요)";
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm");
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URLS.pose },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });
    state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URLS.hand },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.45,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });
    state.visionReady = true;
    return true;
  } catch (error) {
    console.error(error);
    toast("인식 모델을 불러오지 못했어요. 인터넷 연결을 확인해주세요.");
    $("cameraMessage").textContent = "인식 모델 로딩에 실패했습니다. 새로고침 후 다시 시도해주세요.";
    return false;
  }
}

async function setupCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("이 브라우저는 카메라 API를 지원하지 않습니다.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    state.videoStream = stream;
    camera.video.srcObject = stream;
    camera.gameVideo.srcObject = stream;
    await Promise.all([camera.video.play(), camera.gameVideo.play()]);
    state.cameraReady = true;
    $("cameraStatus").textContent = "카메라 준비됨";
    $("cameraStatus").classList.add("on");
    $("cameraMessage").textContent = "모델 로딩 중… 화면에 머리와 상체가 보이도록 서 주세요.";
    const ok = await createVision();
    if (ok) {
      $("cameraMessage").textContent = "준비 완료! 몸이 잘 보이면 게임 시작을 눌러주세요.";
      $("startRunBtn").disabled = false;
      startTrackingLoop();
    }
  } catch (error) {
    console.error(error);
    toast(error.name === "NotAllowedError" ? "카메라 권한이 필요합니다." : "카메라를 켤 수 없습니다.");
  }
}

function stopCamera() {
  if (state.videoStream) state.videoStream.getTracks().forEach((t) => t.stop());
  state.videoStream = null;
  state.cameraReady = false;
  $("cameraStatus").textContent = "카메라 꺼짐";
  $("cameraStatus").classList.remove("on");
  cancelAnimationFrame(state.gameRAF);
}

function startTrackingLoop() {
  if (!state.cameraReady || !state.visionReady) return;
  const tick = async () => {
    if (!state.cameraReady) return;
    if (camera.video.readyState >= 2 && camera.video.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = camera.video.currentTime;
      const now = performance.now();
      try {
        const poseResult = state.poseLandmarker.detectForVideo(camera.video, now);
        const handResult = state.handLandmarker.detectForVideo(camera.video, now);
        state.pose = poseResult.landmarks?.[0] || null;
        state.hands = handResult.landmarks || [];
        state.tracking = !!state.pose || state.hands.length > 0;
        state.lastLandmarksAt = now;
        drawTracking(camera.video, camera.overlay, state.pose, state.hands);
        drawTracking(camera.gameVideo, camera.gameOverlay, state.pose, state.hands);
        $("trackingText").textContent = state.tracking ? "추적 중 ✓" : "사람을 찾아주세요";
        $("trackingMeter").textContent = state.tracking ? "ON" : "WAIT";
      } catch (err) { console.warn(err); }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function drawTracking(video, canvas, pose, hands) {
  if (!canvas || video.readyState < 2) return;
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (pose) {
    ctx.save();
    ctx.strokeStyle = "rgba(94,231,255,.75)";
    ctx.fillStyle = "rgba(255,79,183,.9)";
    ctx.lineWidth = 4;
    const links = [[11,13],[13,15],[12,14],[14,16],[11,12],[11,23],[12,24],[23,25],[25,27],[24,26],[26,28]];
    for (const [a,b] of links) {
      const p = pose[a], q = pose[b]; if (!p || !q) continue;
      ctx.beginPath(); ctx.moveTo(p.x*canvas.width,p.y*canvas.height); ctx.lineTo(q.x*canvas.width,q.y*canvas.height); ctx.stroke();
    }
    for (const idx of [0,11,12,15,16,23,24,27,28]) {
      const p = pose[idx]; if (!p) continue;
      ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,6,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
  if (hands.length) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,217,94,.8)";
    ctx.fillStyle = "rgba(255,217,94,.95)";
    ctx.lineWidth = 3;
    for (const hand of hands) {
      for (const p of hand) { ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,3.5,0,Math.PI*2); ctx.fill(); }
    }
    ctx.restore();
  }
}

function resetRun() {
  state.stage = 1; state.hp = 5; state.totalScore = 0; state.runScore = 0; state.combo = 0; state.maxCombo = 0; state.recentGames = []; state.selectedGames = []; state.selectedIndex = 0;
}

function beginRun() {
  resetRun();
  prepareStage();
}

function gameCountForStage(stage) {
  if (stage <= 2) return 2;
  if (stage <= 5) return 3;
  return 4;
}

function difficultyLabel(stage) {
  const stars = Math.min(5, 1 + Math.floor((stage - 1) / 2));
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}

function pickGames() {
  const eligible = GAME_DEFS.filter((g) => state.stage >= g.minStage);
  const shuffled = [...eligible].sort(() => Math.random() - .5);
  const count = Math.min(gameCountForStage(state.stage), shuffled.length);
  const picks = [];
  for (const game of shuffled) {
    if (picks.length >= count) break;
    if (state.recentGames.length && game.id === state.recentGames[state.recentGames.length - 1]) continue;
    picks.push(game);
  }
  while (picks.length < count) picks.push(shuffled[picks.length % shuffled.length]);
  state.selectedGames = picks;
  state.selectedIndex = 0;
  state.recentGames.push(...picks.map((g) => g.id));
  state.recentGames = state.recentGames.slice(-5);
}

function prepareStage() {
  pickGames();
  $("introStage").textContent = String(state.stage).padStart(2, "0");
  $("introTitle").textContent = `STAGE ${state.stage}`;
  $("introSubtitle").textContent = state.stage === 1 ? "몸을 풀어봅시다!" : state.stage % 5 === 0 ? "🔥 위험한 구간입니다!" : `난이도 ${difficultyLabel(state.stage)}`;
  $("stageGamePreview").innerHTML = state.selectedGames.map((g) => `<div class="game-chip">${g.emoji} ${g.name}</div>`).join("");
  showScreen("stage-intro");
}

function startSelectedGame() {
  state.currentGame = state.selectedGames[state.selectedIndex];
  state.gameScore = 0;
  state.gameCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
  state.gameStartedAt = performance.now() + 1600;
  $("stageLabel").textContent = state.stage;
  $("gameEmoji").textContent = state.currentGame.emoji;
  $("gameTitle").textContent = state.currentGame.name;
  $("bpmMeter").textContent = getBPM();
  updateHP();
  updateScoreUI();
  $("gameMessage").textContent = "GET READY";
  showScreen("game");
  const ctx = $("gameCanvas").getContext("2d");
  resizeCanvas($("gameCanvas"));
  const game = makeMiniGame(state.currentGame.id, ctx);
  state.activeMiniGame = game;
  setTimeout(() => {
    $("gameMessage").textContent = "";
    game.start();
    runGameLoop(game);
  }, 1550);
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(640, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(480, Math.round(rect.height * devicePixelRatio));
}
window.addEventListener("resize", () => { if (state.screen === "game") resizeCanvas($("gameCanvas")); });

function getBPM() { return Math.min(180, 108 + (state.stage - 1) * 7); }
function getBeatMs() { return 60000 / getBPM(); }
function stageDuration() { return 9000 + Math.min(6000, state.stage * 200); }

function runGameLoop(game) {
  const started = performance.now();
  const loop = (now) => {
    if (state.screen !== "game" || state.activeMiniGame !== game) return;
    const elapsed = now - started;
    game.update(elapsed, now);
    game.draw(elapsed, now);
    if (elapsed >= stageDuration()) {
      game.finish();
      endCurrentGame();
      return;
    }
    state.gameRAF = requestAnimationFrame(loop);
  };
  state.gameRAF = requestAnimationFrame(loop);
}

function handPoints() {
  if (!state.hands.length) return [];
  return state.hands.map((hand) => {
    const wrist = hand[0]; const idx = hand[8];
    return { wrist, tip: idx || wrist, x: idx?.x ?? wrist?.x ?? .5, y: idx?.y ?? wrist?.y ?? .5 };
  });
}
function bestHand() {
  const hs = handPoints();
  if (hs.length) return hs[0];
  if (state.pose?.length > 16) {
    const p = state.pose[16];
    return { x:p.x, y:p.y, tip:p, wrist:p };
  }
  return null;
}
function poseCenter() {
  if (!state.pose) return {x:.5,y:.6};
  const a=state.pose[11], b=state.pose[12];
  return { x: ((a?.x || .5)+(b?.x||.5))/2, y:((a?.y||.5)+(b?.y||.5))/2 };
}
function mirroredX(x) { return 1 - x; }

function makeMiniGame(id, ctx) {
  const W = () => ctx.canvas.width, H = () => ctx.canvas.height;
  const local = { notes:[], particles:[], lastBeat:-1, completed:false, target:null, hazards:[], lane:null, startedAt:0 };
  const chart = buildChart(id);

  function clear() { ctx.clearRect(0,0,W(),H()); }
  function bg(title, subtitle) {
    const grad=ctx.createLinearGradient(0,0,W(),H()); grad.addColorStop(0,"#101024"); grad.addColorStop(1,"#05050b"); ctx.fillStyle=grad; ctx.fillRect(0,0,W(),H());
    ctx.fillStyle="rgba(255,255,255,.05)"; for(let x=0;x<W();x+=56){ctx.fillRect(x,0,1,H());} for(let y=0;y<H();y+=56){ctx.fillRect(0,y,W(),1);}
    ctx.fillStyle="#fff"; ctx.font=`900 ${Math.max(18,W()/34)}px system-ui`; ctx.textAlign="center"; ctx.fillText(title,W()/2,46);
    ctx.fillStyle="#aaa7bf"; ctx.font=`600 ${Math.max(11,W()/75)}px system-ui`; ctx.fillText(subtitle,W()/2,72);
  }
  function showHit(kind) {
    state.gameCounts[kind]++;
    const points = { perfect:100, great:70, good:40, miss:0 }[kind];
    if (kind === "miss") state.combo=0; else { state.combo++; state.maxCombo=Math.max(state.maxCombo,state.combo); }
    state.gameScore += points + (kind !== "miss" ? Math.min(50, state.combo*2) : 0);
    state.totalScore += points + (kind !== "miss" ? Math.min(50,state.combo*2) : 0);
    if (kind === "miss") state.hp = Math.max(0,state.hp-1);
    updateHP(); updateScoreUI(); hitSound(kind); feedback(kind);
    if (state.hp <= 0) local.completed = true;
  }
  function timingGrade(deltaMs) {
    const abs = Math.abs(deltaMs); const beat = getBeatMs();
    if (abs <= Math.min(85, beat*.16)) return "perfect";
    if (abs <= Math.min(145, beat*.28)) return "great";
    if (abs <= Math.min(210, beat*.4)) return "good";
    return "miss";
  }
  function noteVisual(note, progress, color) {
    const x = note.x * W(), y = note.y * H(); const r = 28 + progress*28;
    ctx.strokeStyle=color; ctx.lineWidth=5; ctx.globalAlpha=Math.max(.2,1-progress); ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,10+progress*4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle="#fff"; ctx.font=`900 ${Math.max(11,W()/82)}px system-ui`; ctx.textAlign="center"; ctx.fillText(note.label,x,y+4);
  }
  function spawnParticles(x,y,color){ for(let i=0;i<14;i++) local.particles.push({x,y,vx:(Math.random()-.5)*8,vy:(Math.random()-.5)*8,life:1,color}); }
  function drawParticles(){ local.particles=local.particles.filter(p=>p.life>0); for(const p of local.particles){p.x+=p.vx;p.y+=p.vy;p.life-=.04;ctx.globalAlpha=Math.max(0,p.life);ctx.fillStyle=p.color;ctx.fillRect(p.x,p.y,5,5);}ctx.globalAlpha=1; }

  function buildCommon() {
    const notes=[]; const beat=getBeatMs(); const start=600;
    for(let i=0;i<Math.floor(stageDuration()/beat)-1;i++) notes.push({t:start+i*beat*(state.stage<4?.9:Math.max(.52,1-(state.stage-3)*.04)), id:i});
    return notes;
  }

  const game = {
    start(){ local.startedAt=performance.now(); local.notes=chart; beep(600,.05,"triangle",.03); beep(getBPM()>145?900:740,.06,"triangle",.03); },
    update(elapsed){
      if(local.completed) return;
      if(id === "wave") updateWave(elapsed);
      if(id === "punch") updatePunch(elapsed);
      if(id === "target") updateTarget(elapsed);
      if(id === "dodge") updateDodge(elapsed);
      drawParticles();
    },
    draw(elapsed){
      clear();
      if(id === "wave") drawWave(elapsed);
      if(id === "punch") drawPunch(elapsed);
      if(id === "target") drawTarget(elapsed);
      if(id === "dodge") drawDodge(elapsed);
      drawParticles();
      if(local.completed && state.hp<=0){ ctx.fillStyle="rgba(0,0,0,.62)";ctx.fillRect(0,0,W(),H());ctx.fillStyle="#fff";ctx.font=`1000 ${Math.max(28,W()/15)}px system-ui`;ctx.textAlign="center";ctx.fillText("GAME OVER",W()/2,H()/2); }
    },
    finish(){ local.completed=true; },
    get local(){return local;}
  };

  function buildChart(gameId){
    const beat=getBeatMs(); const start=750; const notes=[];
    if(gameId === "target"){
      for(let i=0;i<Math.floor((stageDuration()-1000)/beat);i++) notes.push({t:start+i*beat*(state.stage>5?.75:1),x:.18+Math.random()*.64,y:.24+Math.random()*.5,id:i,hit:false});
    } else if(gameId === "dodge"){
      for(let i=0;i<Math.floor((stageDuration()-1000)/beat);i++) notes.push({t:start+i*beat*(state.stage>5?.75:1),lane:Math.random()<.5?"left":"right",hit:false,id:i});
    } else {
      const dirs=[]; for(let i=0;i<Math.floor((stageDuration()-1000)/beat);i++) dirs.push(i%2===0?"left":"right");
      dirs.forEach((d,i)=>notes.push({t:start+i*beat*(state.stage>5?.75:1),dir:d,hit:false,id:i}));
    }
    return notes;
  }

  function testNote(elapsed,note,condition){
    if(note.hit) return;
    const dt=elapsed-note.t;
    if(dt > Math.max(170,getBeatMs()*.45)){ note.hit=true; showHit("miss"); return; }
    if(Math.abs(dt) < Math.max(90,getBeatMs()*.22) && condition()) { note.hit=true; const kind=timingGrade(dt); showHit(kind); }
  }

  function updateWave(elapsed){
    const hand=bestHand();
    for(const n of local.notes){
      testNote(elapsed,n,()=>hand && (n.dir==="left" ? mirroredX(hand.x)<.35 : mirroredX(hand.x)>.65));
    }
  }
  function drawWave(elapsed){
    bg("손 흔들기","화살표 방향으로 손을 크게 이동하세요");
    const hand=bestHand();
    ctx.fillStyle="rgba(255,255,255,.07)";ctx.fillRect(W()*.2,H()*.20,W()*.6,H()*.58);
    ctx.strokeStyle="rgba(255,255,255,.12)";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(W()/2,H()*.2);ctx.lineTo(W()/2,H()*.78);ctx.stroke();
    for(const n of local.notes){const progress=Math.max(0,1-Math.abs(elapsed-n.t)/260);if(Math.abs(elapsed-n.t)<260&&!n.hit){const x=n.dir==="left"?W()*.31:W()*.69;ctx.fillStyle=n.dir==="left"?"#5ee7ff":"#ff4fb7";ctx.font=`1000 ${Math.max(64,W()/8)}px system-ui`;ctx.textAlign="center";ctx.fillText(n.dir==="left"?"←":"→",x,H()*.53);ctx.globalAlpha=.3;ctx.beginPath();ctx.arc(x,H()*.53,70+progress*35,0,Math.PI*2);ctx.strokeStyle=ctx.fillStyle;ctx.stroke();ctx.globalAlpha=1;}}
    if(hand){ctx.fillStyle="#ffd95e";ctx.beginPath();ctx.arc(mirroredX(hand.x)*W(),hand.y*H(),18,0,Math.PI*2);ctx.fill();}
    drawTimeline(elapsed);
  }
  function updatePunch(elapsed){
    const hand=bestHand();
    for(const n of local.notes){
      testNote(elapsed,n,()=>hand && (n.dir==="left"?mirroredX(hand.x)<.34:mirroredX(hand.x)>.66) && hand.y<.65);
    }
  }
  function drawPunch(elapsed){
    bg("펀치 마스터","目标方向에 펀치! 손을 목표에 가까이 가져가세요");
    const pulse=1+Math.sin(elapsed/90)*.04;
    const hand=bestHand();
    for(const n of local.notes){ if(Math.abs(elapsed-n.t)<320&&!n.hit){const x=n.dir==="left"?W()*.26:W()*.74;const color=n.dir==="left"?"#8d70ff":"#ff4fb7";ctx.save();ctx.translate(x,H()*.50);ctx.scale(pulse,pulse);ctx.fillStyle=color;ctx.globalAlpha=.25;ctx.beginPath();ctx.arc(0,0,105,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.fillStyle="#fff";ctx.font=`1000 ${Math.max(58,W()/9)}px system-ui`;ctx.textAlign="center";ctx.fillText("👊",0,22);ctx.restore();}}
    if(hand){ctx.fillStyle="#ffd95e";ctx.beginPath();ctx.arc(mirroredX(hand.x)*W(),hand.y*H(),18,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#ffd95e";ctx.globalAlpha=.25;ctx.lineWidth=12;ctx.beginPath();ctx.arc(mirroredX(hand.x)*W(),hand.y*H(),30,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}
    drawTimeline(elapsed);
  }
  function updateTarget(elapsed){
    const hand=bestHand();
    for(const n of local.notes){
      testNote(elapsed,n,()=>{if(!hand)return false;const hx=mirroredX(hand.x),hy=hand.y;return Math.hypot(hx-n.x,hy-n.y)<(.12+Math.max(0,5-state.stage)*.01);});
    }
  }
  function drawTarget(elapsed){
    bg("타겟 터치","손을 반짝이는 타겟 안으로 가져가세요");
    const hand=bestHand();
    for(const n of local.notes){ if(Math.abs(elapsed-n.t)<380&&!n.hit){const p=Math.abs(elapsed-n.t)/380;noteVisual(n,p,"#5ee7ff");}}
    if(hand){const hx=mirroredX(hand.x),hy=hand.y;ctx.fillStyle="#ffd95e";ctx.beginPath();ctx.arc(hx*W(),hy*H(),15,0,Math.PI*2);ctx.fill();}
    drawTimeline(elapsed);
  }
  function updateDodge(elapsed){
    const center=mirroredX(poseCenter().x);
    for(const n of local.notes){
      testNote(elapsed,n,()=>n.lane==="left"?center>.57:center<.43);
    }
  }
  function drawDodge(elapsed){
    bg("좌우 피하기","장애물 반대쪽으로 몸을 이동하세요");
    const center=mirroredX(poseCenter().x);
    ctx.fillStyle="rgba(255,255,255,.08)";ctx.fillRect(W()*.12,H()*.19,W()*.76,H()*.62);
    ctx.strokeStyle="rgba(255,255,255,.16)";ctx.beginPath();ctx.moveTo(W()/2,H()*.19);ctx.lineTo(W()/2,H()*.81);ctx.stroke();
    for(const n of local.notes){const dt=elapsed-n.t;if(dt>-400&&dt<500&&!n.hit){const x=n.lane==="left"?W()*.31:W()*.69;const y=H()*.5;ctx.fillStyle="#ff6a7c";ctx.beginPath();ctx.arc(x,y,55,0,Math.PI*2);ctx.fill();ctx.fillStyle="#fff";ctx.font=`1000 ${Math.max(40,W()/13)}px system-ui`;ctx.textAlign="center";ctx.fillText("⚠",x,y+14);}}
    ctx.fillStyle="#5cf0b2";ctx.beginPath();ctx.arc(center*W(),H()*.68,22,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#fff";ctx.font=`900 ${Math.max(13,W()/75)}px system-ui`;ctx.textAlign="center";ctx.fillText("YOU",center*W(),H()*.75);
    drawTimeline(elapsed);
  }
  function drawTimeline(elapsed){
    const y=H()-34;ctx.fillStyle="rgba(255,255,255,.08)";ctx.fillRect(W()*.12,y,W()*.76,5);const next=local.notes.find(n=>!n.hit&&n.t>=elapsed);if(next){const p=Math.max(0,Math.min(1,(next.t-elapsed)/500));ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(W()*(.12+.76*(1-p)),y+2,7,0,Math.PI*2);ctx.fill();}
  }
  return game;
}

function updateScoreUI(){ $("scoreLabel").textContent = state.totalScore.toLocaleString(); $("comboLabel").textContent = `${state.combo} COMBO`; }
function updateHP(){ $("hpRow").innerHTML = "♥".repeat(state.hp) + "♡".repeat(Math.max(0,5-state.hp)); $("hpResult").textContent = "♥".repeat(state.hp) + "♡".repeat(5-state.hp); }
function feedback(kind){ const el=$("feedback"); el.textContent={perfect:"PERFECT!",great:"GREAT!",good:"GOOD!",miss:"MISS"}[kind]; el.className="feedback"; void el.offsetWidth; el.classList.add("show"); }

function endCurrentGame(){
  cancelAnimationFrame(state.gameRAF);
  const c=state.gameCounts;
  $("gameResultScore").textContent=state.gameScore.toLocaleString();
  $("perfectCount").textContent=c.perfect; $("greatCount").textContent=c.great; $("goodCount").textContent=c.good; $("missCount").textContent=c.miss;
  const total=c.perfect+c.great+c.good+c.miss; const acc=total ? (c.perfect*1+c.great*.75+c.good*.45)/total : 0; const grade=acc>.9?"S":acc>.75?"A":acc>.58?"B":acc>.42?"C":"D";
  $("resultGrade").textContent=grade;
  $("gameResultTitle").textContent=state.hp<=0?"MISS...":"GAME CLEAR!";
  showScreen("game-result");
}

function continueAfterGame(){
  state.runScore += state.gameScore;
  if(state.hp<=0){ showGameOver(); return; }
  state.selectedIndex++;
  if(state.selectedIndex < state.selectedGames.length){ state.combo=0; startSelectedGame(); }
  else showStageResult();
}
function showStageResult(){
  state.runScore = Math.max(state.runScore, state.totalScore);
  saveBest(state.stage, state.totalScore);
  $("stageResultTitle").textContent=`STAGE ${state.stage} COMPLETE`;
  $("stageResultScore").textContent=state.totalScore.toLocaleString();
  $("maxComboResult").textContent=state.maxCombo;
  $("nextDifficulty").textContent=difficultyLabel(state.stage+1);
  updateHP(); hitSound("stage");
  showScreen("stage-result");
}
function showGameOver(){
  saveBest(state.stage, state.totalScore);
  $("finalScore").textContent=state.totalScore.toLocaleString();
  $("finalBestStage").textContent=(loadBest().bestStage || state.stage);
  showScreen("game-over");
}

// Optional keyboard testing hooks; the real gameplay path uses camera landmarks.
window.addEventListener("keydown", (e)=>{
  if(state.screen!=="game") return;
  const hand = bestHand() || {x:.5,y:.5};
  if(e.code==="ArrowLeft"||e.code==="KeyA") hand.x=.2;
  if(e.code==="ArrowRight"||e.code==="KeyD") hand.x=.8;
  if(e.code==="Space") e.preventDefault();
  if(!state.hands.length && !state.pose && e.code!=="Space") { window.__fakeHand=hand; }
});

// Clean up if the user closes/reloads the page.
window.addEventListener("beforeunload", stopCamera);
