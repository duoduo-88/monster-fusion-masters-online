const params = new URLSearchParams(location.search);
const roomCode = params.get("room")?.toUpperCase() || "";
const memberId = params.get("member") || "";
const role = params.get("role") === "spectator" ? "spectator" : "player";
const saved = JSON.parse(sessionStorage.getItem(`mfm:room:${roomCode}`) || "null");
const apiBase = String(window.MFM_CONFIG?.apiBase || "").replace(/\/$/, "") || location.origin;
let socket = null;
let roomState = null;
let reconnectTimer = null;
let intentionalClose = false;
let warnedTurn = -1;
let shownResultId = "";
let shownSurrenderSeq = 0;
let resultAutoClose = null;
let linkOnline = false;
const PLAYER_COLORS = ["#6cbebc", "#d3655d", "#c8a951", "#8c78c4"];

if (!roomCode || !memberId || !saved?.token || !window.MFMBridge) location.replace("./");
else start();

function webSocketUrl() {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/${roomCode}`;
  url.search = new URLSearchParams({ token: saved.token }).toString();
  return url.href;
}

function addOnlineUi() {
  const ruleVersion = document.querySelector(".rule-version");
  if (ruleVersion) ruleVersion.textContent = "RULE 20200629 · ONLINE PLAY";
  const status = document.createElement("div");
  status.id = "onlineStatus";
  status.className = "online-status";
  status.innerHTML = `<span class="link-dot"></span><span id="onlineStatusText">LINKING</span><b id="turnTimer">--</b>`;
  document.querySelector("#arena").appendChild(status);

  const warning = document.createElement("div");
  warning.id = "turnWarning";
  warning.className = "turn-warning";
  warning.textContent = "10 SEC REMAIN";
  document.body.appendChild(warning);

  const mobileTimer = document.createElement("section");
  mobileTimer.id = "mobileTurnTimer";
  mobileTimer.className = "mobile-turn-timer pixel-box";
  mobileTimer.innerHTML = `
    <span class="mobile-turn-copy"><small>TURN TIMER</small><strong id="mobileTurnName">WAIT</strong></span>
    <span class="turn-progress mobile-self-timer"><span class="turn-progress-track"><i></i></span><b class="turn-progress-value">--</b></span>`;
  document.body.appendChild(mobileTimer);

  const result = document.createElement("section");
  result.id = "onlineResult";
  result.className = "online-result";
  result.hidden = true;
  result.setAttribute("role", "dialog");
  result.setAttribute("aria-modal", "true");
  result.setAttribute("aria-labelledby", "onlineResultTitle");
  result.innerHTML = `
    <div class="result-flash" aria-hidden="true"></div>
    <div class="result-hexes" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="result-sparks" aria-hidden="true">${Array.from({length:24}, (_, index) => `<i style="--spark:${index}"></i>`).join("")}</div>
    <article class="result-panel pixel-box">
      <span class="result-kicker" id="onlineResultKicker">MATCH COMPLETE</span>
      <h2 id="onlineResultTitle">VICTORY</h2>
      <strong class="result-winner" id="onlineResultWinner">PLAYER WINS</strong>
      <p class="result-reason" id="onlineResultReason"></p>
      <div class="result-scores" id="onlineResultScores"></div>
      <div class="result-actions">
        <button type="button" class="pix-btn" id="resultClose">VIEW BOARD</button>
        <button type="button" class="pix-btn danger" id="resultLeave">LEAVE ROOM</button>
      </div>
    </article>`;
  document.body.appendChild(result);
  result.querySelector("#resultClose").addEventListener("click", hideResult);
  result.querySelector("#resultLeave").addEventListener("click", leaveRoom);
  const roomTag = document.createElement("span");
  roomTag.className = "online-room-tag";
  roomTag.textContent = `ROOM ${roomCode} · ${role === "spectator" ? "WATCH" : "PLAYER"}`;
  document.querySelector(".header-actions").prepend(roomTag);
  if (role === "spectator") {
    window.MFMBridge.setMobileTab("status");
  }
}

function setStatus(online, text) {
  linkOnline = online;
  const status = document.querySelector("#onlineStatus");
  status?.classList.toggle("connected", online);
  const label = document.querySelector("#onlineStatusText");
  if (label) label.textContent = text;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else window.MFMBridge.error("LINK OFFLINE");
}

function connect() {
  clearTimeout(reconnectTimer);
  socket?.close();
  const nextSocket = new WebSocket(webSocketUrl());
  socket = nextSocket;
  setStatus(false, "LINKING");
  nextSocket.addEventListener("open", () => { if (socket === nextSocket) setStatus(true, "ONLINE"); });
  nextSocket.addEventListener("message", event => {
    if (socket !== nextSocket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "error") { window.MFMBridge.error(message.error); return; }
    if (message.type === "state") {
      roomState = message.room;
      if (roomState.phase === "lobby") { returnToLobby(); return; }
      window.MFMBridge.apply(roomState);
      decorateTimerBars();
      handleGameResult(roomState.game);
    }
  });
  nextSocket.addEventListener("close", event => {
    if (socket !== nextSocket) return;
    setStatus(false, "RECONNECTING");
    if (intentionalClose) return;
    if (event.code === 4001) { sessionStorage.removeItem(`mfm:room:${roomCode}`); returnToLobby(); return; }
    reconnectTimer = setTimeout(connect, 1200);
  });
}

function hideResult() {
  clearTimeout(resultAutoClose);
  const result = document.querySelector("#onlineResult");
  if (result) result.hidden = true;
  document.body.classList.remove("result-impact");
}

function openResult(mode, details) {
  const result = document.querySelector("#onlineResult");
  if (!result) return;
  clearTimeout(resultAutoClose);
  result.className = `online-result ${mode}`;
  result.style.setProperty("--victory-color", details.color || "#c8a951");
  document.querySelector("#onlineResultKicker").textContent = details.kicker;
  document.querySelector("#onlineResultTitle").textContent = details.title;
  document.querySelector("#onlineResultWinner").textContent = details.winner;
  document.querySelector("#onlineResultReason").textContent = details.reason || "";
  document.querySelector("#onlineResultScores").innerHTML = details.scores || "";
  result.querySelector("#resultClose").textContent = mode === "surrender" ? "CONTINUE" : "VIEW BOARD";
  result.querySelector("#resultLeave").hidden = mode === "surrender";
  result.hidden = false;
  document.body.classList.remove("result-impact");
  void document.body.offsetWidth;
  document.body.classList.add("result-impact");
  if (mode === "surrender") resultAutoClose = setTimeout(hideResult, 2800);
}

function handleGameResult(game) {
  if (!game) return;
  if (game.result?.id && game.result.id !== shownResultId) {
    shownResultId = game.result.id;
    const winnerIndex = game.players.findIndex(player => player.memberId === game.result.winnerMemberId);
    const selfWon = game.result.winnerMemberId === memberId;
    const scores = [...game.players]
      .sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore)
      .map(player => `<span${player.memberId === game.result.winnerMemberId ? ' class="winner-score"' : ""}><b>${escapeResult(player.nickname)}</b><em>${player.totalScore}</em></span>`)
      .join("");
    openResult("victory", {
      kicker: "MATCH COMPLETE",
      title: selfWon ? "YOU WIN" : "VICTORY",
      winner: `${game.result.winnerNickname} WINS`,
      reason: game.result.reason,
      color: PLAYER_COLORS[winnerIndex] || "#c8a951",
      scores
    });
    return;
  }
  const event = game.lastEvent;
  if (event?.type === "surrender" && event.seq > shownSurrenderSeq) {
    shownSurrenderSeq = event.seq;
    const playerIndex = game.players.findIndex(player => player.memberId === event.memberId);
    openResult("surrender", {
      kicker: "PLAYER EXIT",
      title: "SURRENDER",
      winner: `${event.nickname || "PLAYER"} SURRENDERED`,
      reason: "THE MATCH CONTINUES",
      color: PLAYER_COLORS[playerIndex] || "#c94b4b",
      scores: ""
    });
  }
}

function escapeResult(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
}

function returnToLobby() {
  intentionalClose = true;
  socket?.close(1000, "RETURN LOBBY");
  const url = new URL("./", location.href);
  url.searchParams.set("room", roomCode);
  location.href = url.href;
}

function leaveRoom() {
  if (!confirm("LEAVE THIS ROOM?")) return;
  intentionalClose = true;
  send({ type: "leave" });
  socket?.close(1000, "LEFT ROOM");
  sessionStorage.removeItem(`mfm:room:${roomCode}`);
  location.replace("./");
}

function updateTimer() {
  decorateReconnectState();
  const output = document.querySelector("#turnTimer");
  if (!output) return;
  const deadline = roomState?.game?.turnDeadline;
  const current = roomState?.game?.players?.[roomState.game.current];
  const mobileName = document.querySelector("#mobileTurnName");
  if (mobileName) {
    const isSelf = role === "player" && current?.memberId === memberId;
    mobileName.textContent = !linkOnline ? "RECONNECTING" : isSelf ? "YOUR TURN" : (current?.nickname || "WAIT");
    mobileName.style.color = !linkOnline ? "#c8a951" : isSelf ? (current?.color || "#f1eedc") : "#8d8a7b";
  }
  if (!linkOnline || !deadline || current?.resigned) { output.textContent = "--"; output.dataset.urgent = "false"; output.dataset.final = "false"; updateProgress(0, "--"); return; }
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  output.textContent = String(left).padStart(2, "0");
  output.dataset.urgent = left <= 10 ? "true" : "false";
  output.dataset.final = left <= 3 ? "true" : "false";
  const total = roomState?.game?.turnSeconds || 0;
  updateProgress(total ? Math.max(0, Math.min(1, (deadline - Date.now()) / (total * 1000))) : 0, `${left}S`);
  if (role === "player" && current?.memberId === memberId && left <= 10 && left > 0 && warnedTurn !== roomState.game.turn) {
    warnedTurn = roomState.game.turn;
    const warning = document.querySelector("#turnWarning");
    warning.classList.remove("show");
    void warning.offsetWidth;
    warning.classList.add("show");
    setTimeout(() => warning.classList.remove("show"), 1500);
  }
}

function decorateReconnectState() {
  if (!roomState?.members?.length) return;
  const now = Date.now();
  const players = roomState.game?.players || [];
  const cards = document.querySelectorAll("#players .player");
  players.forEach((player, index) => {
    const member = roomState.members.find(item => item.id === player.memberId);
    const card = cards[index];
    if (!card || member?.connected !== false || player.resigned) return;
    const seconds = Math.max(0, Math.ceil(((member.reconnectUntil || now) - now) / 1000));
    const meta = card.querySelector(".player-meta");
    if (meta) meta.textContent = seconds ? `LINK LOST · ${seconds}S` : "LINK LOST · FINALIZING";
  });
}

function timerBar(className) {
  const wrap = document.createElement("span");
  wrap.className = `turn-progress ${className}`;
  wrap.innerHTML = '<span class="turn-progress-track"><i></i></span><b class="turn-progress-value">--</b>';
  return wrap;
}

function decorateTimerBars() {
  if (!roomState?.game?.turnSeconds) return;
  const cards = document.querySelectorAll("#players .player");
  cards.forEach(card => card.querySelector(".turn-progress")?.remove());
  const active = cards[roomState.game.current];
  const current = roomState.game.players?.[roomState.game.current];
  if (active && !current?.resigned) active.appendChild(timerBar("roster-timer"));
}

function updateProgress(ratio, label = "--") {
  document.querySelectorAll(".turn-progress i").forEach(bar => { bar.style.width = `${ratio * 100}%`; });
  document.querySelectorAll(".turn-progress-value").forEach(value => { value.textContent = label; });
  document.querySelectorAll(".turn-progress").forEach(bar => bar.classList.toggle("urgent", ratio > 0 && ratio <= 10 / (roomState?.game?.turnSeconds || 1)));
}

function start() {
  window.MFMBridge.init({ memberId, role });
  addOnlineUi();
  connect();
  addEventListener("mfm:action", event => {
    const message = { ...event.detail };
    if (message.type === "game" && message.action === "place") message.boardStep = window.MFMBridge.boardStep?.() || 0;
    send(message);
  });
  addEventListener("mfm:leave", leaveRoom);
  setInterval(updateTimer, 200);
}
