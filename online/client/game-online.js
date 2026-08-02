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
let introTimer = null;
let shownIntroKey = "";
let serverClockOffset = 0;
const GAME_INTRO_MS = 8000;
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
  const brand = document.querySelector(".brand");
  if (brand && !brand.querySelector(".online-link-subtitle")) {
    const onlineLabel = document.createElement("p");
    onlineLabel.className = "subtitle online-link-subtitle";
    onlineLabel.textContent = "ONLINE LINK";
    brand.appendChild(onlineLabel);
  }
  const ruleVersion = document.querySelector(".rule-version");
  if (ruleVersion) ruleVersion.textContent = "RULE 20200629 · ONLINE PLAY";
  const status = document.createElement("div");
  status.id = "onlineStatus";
  status.className = "online-status";
  status.innerHTML = `<span class="link-dot"></span><span id="onlineStatusText">LINKING</span><b id="turnTimer">--</b>`;
  document.querySelector("#arena").appendChild(status);

  const nextRound = document.createElement("button");
  nextRound.id = "onlineNextRound";
  nextRound.className = "pix-btn primary online-next-round";
  nextRound.type = "button";
  nextRound.textContent = "NEXT ROUND";
  nextRound.hidden = true;
  nextRound.addEventListener("click", requestNextRound);
  document.querySelector("#arena").appendChild(nextRound);

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

  const intro = document.createElement("section");
  intro.id = "onlineIntro";
  intro.className = "online-intro";
  intro.hidden = true;
  intro.setAttribute("aria-live", "assertive");
  intro.innerHTML = `
    <div class="intro-static" aria-hidden="true"></div>
    <article class="intro-panel pixel-box">
      <small id="introLabel">FIRST MOVE DRAW</small>
      <strong id="introPlayer">------</strong>
      <b id="introCue">?</b>
    </article>`;
  document.body.appendChild(intro);

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
  result.querySelector("#resultClose").addEventListener("click", handleResultPrimary);
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
      if (Number.isFinite(Number(roomState.serverTime))) serverClockOffset = Number(roomState.serverTime) - Date.now();
      if (roomState.phase === "lobby") { returnToLobby(); return; }
      window.MFMBridge.apply(roomState);
      handleGameIntro(roomState.game);
      updateRoundAdvance(roomState.game);
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

function stopIntroTimer() {
  clearInterval(introTimer);
  introTimer = null;
}

function hideGameIntro() {
  stopIntroTimer();
  const intro = document.querySelector("#onlineIntro");
  if (!intro) return;
  intro.hidden = true;
  intro.dataset.stage = "";
  intro.dataset.launching = "";
}

function handleGameIntro(game) {
  const intro = document.querySelector("#onlineIntro");
  if (!intro) return;
  if (game?.phase === "starting") hideResult();
  if (game?.phase !== "starting" || !game.startAt) {
    if (!intro.hidden && intro.dataset.launching !== "true") {
      stopIntroTimer();
      intro.dataset.launching = "true";
      intro.dataset.stage = "start";
      document.querySelector("#introCue").textContent = "START";
      setTimeout(hideGameIntro, 420);
    }
    return;
  }

  const key = `${game.round}:${game.startAt}`;
  if (shownIntroKey !== key) {
    shownIntroKey = key;
    intro.hidden = false;
    intro.dataset.launching = "";
  }
  stopIntroTimer();

  const update = () => {
    const players = game.players || [];
    if (!players.length) return;
    const remaining = game.startAt - syncedNow();
    const elapsed = Math.max(0, GAME_INTRO_MS - remaining);
    const actualIndex = Math.max(0, Math.min(players.length - 1, Number(game.current) || 0));
    let playerIndex = actualIndex;
    let stage = "draw";
    let label = "FIRST MOVE DRAW";
    let cue = "?";

    if (remaining > 4800) {
      playerIndex = Math.floor(elapsed / 180) % players.length;
    } else if (remaining > 3200) {
      stage = "first";
      label = "FIRST PLAYER";
      cue = "";
    } else if (remaining > 1600) {
      stage = "ready";
      label = "FIRST PLAYER";
      cue = "READY";
    } else {
      stage = "start";
      label = "FIRST PLAYER";
      cue = "START";
    }

    const player = players[playerIndex] || players[actualIndex];
    const color = PLAYER_COLORS[playerIndex] || "#c8a951";
    intro.dataset.stage = stage;
    intro.style.setProperty("--intro-color", color);
    document.querySelector("#introLabel").textContent = label;
    document.querySelector("#introPlayer").textContent = player?.nickname || "PLAYER";
    document.querySelector("#introCue").textContent = cue;
    if (remaining <= 0) stopIntroTimer();
  };

  update();
  introTimer = setInterval(update, 80);
}

function syncedNow() {
  return Date.now() + serverClockOffset;
}

function hideResult() {
  clearTimeout(resultAutoClose);
  const result = document.querySelector("#onlineResult");
  if (result) result.hidden = true;
  document.body.classList.remove("result-impact");
}

function requestNextRound() {
  if (roomState?.hostId !== memberId || roomState?.game?.phase !== "round-over") return;
  send({ type: "nextRound" });
  hideResult();
}

function handleResultPrimary() {
  const result = document.querySelector("#onlineResult");
  if (result?.dataset.primaryAction === "next-round") requestNextRound();
  else hideResult();
}

function updateRoundAdvance(game) {
  const button = document.querySelector("#onlineNextRound");
  if (!button) return;
  const available = game?.phase === "round-over" && game.result?.final === false;
  const isHost = roomState?.hostId === memberId;
  button.hidden = !available;
  button.disabled = available && !isHost;
  button.textContent = isHost ? "NEXT ROUND" : "WAIT HOST";
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
  result.dataset.primaryAction = details.primaryAction || "close";
  result.querySelector("#resultClose").textContent = details.primaryLabel || (mode === "surrender" ? "CONTINUE" : "VIEW BOARD");
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
    const final = game.result.final !== false;
    const isHost = roomState?.hostId === memberId;
    const event = game.lastEvent;
    const surrenderResult = event?.type === "surrender"
      && Number.isFinite(Number(event.seq))
      && Math.abs(Number(game.result.at || 0) - Number(event.at || 0)) < 2000
      && event.winnerMemberId === game.result.winnerMemberId;
    if (surrenderResult) shownSurrenderSeq = Math.max(shownSurrenderSeq, Number(event.seq));
    const winnerIndex = game.players.findIndex(player => player.memberId === game.result.winnerMemberId);
    const selfWon = game.result.winnerMemberId === memberId;
    const scores = [...game.players]
      .sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore)
      .map(player => `<span${player.memberId === game.result.winnerMemberId ? ' class="winner-score"' : ""}><b>${escapeResult(player.nickname)}</b><em>${final ? player.totalScore : `${player.roundScore} / ${player.totalScore}`}</em></span>`)
      .join("");
    if (surrenderResult && event.memberId === memberId) {
      openResult("surrender", {
        kicker: final ? "MATCH FORFEIT" : "ROUND FORFEIT",
        title: final ? "DEFEAT" : "YOU FORFEIT",
        winner: final ? `${game.result.winnerNickname} WINS` : `ROUND ${game.result.round} SURRENDERED`,
        reason: final ? "MATCH COMPLETE" : (isHost ? "START THE NEXT ROUND" : "NEXT ROUND REMAINS AVAILABLE"),
        color: PLAYER_COLORS[game.players.findIndex(player => player.memberId === event.memberId)] || "#c94b4b",
        scores,
        primaryLabel: !final && isHost ? "NEXT ROUND" : "VIEW BOARD",
        primaryAction: !final && isHost ? "next-round" : "close"
      });
      return;
    }
    openResult(final ? "victory" : "round", {
      kicker: final ? "MATCH COMPLETE" : `ROUND ${game.result.round} COMPLETE`,
      title: final ? (selfWon ? "YOU WIN" : "VICTORY") : (selfWon ? "ROUND WIN" : "ROUND OVER"),
      winner: final ? `${game.result.winnerNickname} WINS` : `${game.result.winnerNickname} TAKES ROUND`,
      reason: final ? game.result.reason : (isHost ? "START THE NEXT ROUND" : "WAITING FOR HOST"),
      color: PLAYER_COLORS[winnerIndex] || "#c8a951",
      scores,
      primaryLabel: !final && isHost ? "NEXT ROUND" : "VIEW BOARD",
      primaryAction: !final && isHost ? "next-round" : "close"
    });
    return;
  }
  const event = game.lastEvent;
  if (event?.type === "surrender" && Number(event.round) === Number(game.round) && event.seq > shownSurrenderSeq) {
    shownSurrenderSeq = event.seq;
    if (event.memberId !== memberId) return;
    const playerIndex = game.players.findIndex(player => player.memberId === event.memberId);
    openResult("surrender", {
      kicker: event.roundOnly ? "ROUND FORFEIT" : "PLAYER EXIT",
      title: event.roundOnly ? "YOU FORFEIT" : "SURRENDER",
      winner: event.roundOnly ? "ROUND SURRENDERED" : `${event.nickname || "PLAYER"} SURRENDERED`,
      reason: event.roundOnly ? "NEXT ROUND REMAINS AVAILABLE" : "THE MATCH CONTINUES",
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
  const left = Math.max(0, Math.ceil((deadline - syncedNow()) / 1000));
  output.textContent = String(left).padStart(2, "0");
  output.dataset.urgent = left <= 10 ? "true" : "false";
  output.dataset.final = left <= 3 ? "true" : "false";
  const total = roomState?.game?.turnSeconds || 0;
  updateProgress(total ? Math.max(0, Math.min(1, (deadline - syncedNow()) / (total * 1000))) : 0, `${left}S`);
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
  const now = syncedNow();
  const players = roomState.game?.players || [];
  const cards = document.querySelectorAll("#players .player");
  players.forEach((player, index) => {
    const member = roomState.members.find(item => item.id === player.memberId);
    const card = cards[index];
    if (!card || member?.connected !== false || player.resigned) return;
    const deadline = Number(member.reconnectUntil || 0);
    const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
    const label = card.querySelector(".connection-label");
    if (label) label.textContent = !deadline ? "LINK LOST · WAIT TURN" : seconds ? `LINK LOST ${seconds}S` : "LINK LOST · FINALIZING";
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
