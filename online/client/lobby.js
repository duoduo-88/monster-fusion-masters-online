import QRCode from "qrcode";

const $ = selector => document.querySelector(selector);
const LOGO_FONT = {
  M:["0110110","0100100","0110110","1011010","1101011"], O:["01110","10010","10001","10010","01110"],
  N:["11001","11010","10101","10110","10011"], S:["1110","1000","1110","0001","1110"],
  T:["11110","10101","01100","00100","01100"], E:["1111","1000","0111","1000","1111"],
  R:["1111","1001","1111","1010","1101"], F:["1111","1000","1110","1000","1100"],
  U:["11011","10010","11011","10010","01110"], I:["11","10","11","10","11"],
  A:["00100","01100","01010","11110","10001"]
};
const LOGO_PHASE = { S:-1, T:-1 };
const PLAYER_COLORS = ["#6cbebc", "#d3655d", "#c8a951", "#8c78c4", "#72aa83", "#d8894b", "#cf6f9d", "#4f87c5", "#a8bd55"];
const apiBase = String(window.MFM_CONFIG?.apiBase || "").replace(/\/$/, "") || location.origin;
const store = sessionStorage;
const recoveryStore = localStorage;
const state = {
  nickname: store.getItem("mfm:nickname") || "",
  accessToken: store.getItem("mfm:test-access") || "",
  room: null,
  code: "",
  token: "",
  memberId: "",
  socket: null,
  reconnectTimer: null,
  roomRefreshTimer: null,
  intentionalClose: false
};

function drawLobbyLogo() {
  const logo = $("#lobbyLogo");
  if (!logo) return;
  const stepX = 7.19, stepY = 6.36, tileW = 6.19;
  logo.replaceChildren();
  for (const word of ["MONSTER", "FUSION", "MASTERS"]) {
    const row = document.createElement("span");
    row.className = "hex-logo-word";
    for (const letter of word) {
      const glyph = document.createElement("span");
      glyph.className = "hex-logo-letter";
      glyph.setAttribute("aria-hidden", "true");
      const phase = LOGO_PHASE[letter] || 1;
      const points = [];
      for (let y = 0; y < 5; y++) for (let x = 0; x < LOGO_FONT[letter][y].length; x++) {
        if (LOGO_FONT[letter][y][x] === "1") points.push({ x:x * stepX + (y % 2) * phase * stepX / 2, y:y * stepY });
      }
      const minX = Math.min(...points.map(point => point.x));
      const maxX = Math.max(...points.map(point => point.x));
      const width = maxX - minX + tileW;
      glyph.style.width = `${width}px`;
      glyph.style.flexBasis = `${width}px`;
      for (const point of points) {
        const dot = document.createElement("i");
        dot.className = "hex-logo-dot";
        dot.style.left = `${point.x - minX}px`;
        dot.style.top = `${point.y}px`;
        glyph.appendChild(dot);
      }
      row.appendChild(glyph);
    }
    logo.appendChild(row);
  }
  const mobileOnlineLabel = document.createElement("span");
  mobileOnlineLabel.className = "mobile-online-link";
  mobileOnlineLabel.textContent = "ONLINE LINK";
  logo.lastElementChild?.appendChild(mobileOnlineLabel);
}

function setScreen(name) {
  $("#identityScreen").hidden = name !== "identity";
  $("#lobbyScreen").hidden = name !== "lobby";
  $("#roomScreen").hidden = name !== "room";
  if (name === "lobby" && state.nickname) refreshRoomList();
}

function nicknameValid(value) {
  return /^[A-Za-z0-9]{1,6}$/.test(value);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1700);
}

function setLink(online, text = online ? "ONLINE" : "OFFLINE") {
  const el = $("#linkState");
  el.classList.toggle("online", online);
  el.querySelector("span").textContent = text;
}

async function request(path, options = {}) {
  const { auth = true, ...fetchOptions } = options;
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (auth && state.accessToken) headers.authorization = `Bearer ${state.accessToken}`;
  const response = await fetch(`${apiBase}${path}`, {
    ...fetchOptions,
    headers
  });
  const data = await response.json().catch(() => ({ error: "BAD SERVER RESPONSE" }));
  if (response.status === 401 && data.error === "TEST ACCESS REQUIRED") clearIdentity("TEST ACCESS EXPIRED");
  if (!response.ok || data.ok === false) throw new Error(data.error || `SERVER ${response.status}`);
  return data;
}

function clearIdentity(message = "") {
  store.removeItem("mfm:nickname");
  store.removeItem("mfm:test-access");
  state.nickname = "";
  state.accessToken = "";
  state.intentionalClose = true;
  state.socket?.close(1000, "TEST ACCESS ENDED");
  $("#nickname").value = "";
  $("#testCode").value = "";
  $("#nicknameView").textContent = "------";
  $("#identityError").textContent = message;
  setScreen("identity");
}

function saveSession(data) {
  state.code = data.code;
  state.token = data.token;
  state.memberId = data.memberId;
  store.setItem(`mfm:room:${data.code}`, JSON.stringify({ token: data.token, memberId: data.memberId, role: data.role }));
  try { recoveryStore.setItem(`mfm:resume:${data.code}`, JSON.stringify({ token:data.token, memberId:data.memberId, role:data.role, nickname:state.nickname, savedAt:Date.now() })); } catch {}
}

function readRecovery(code, nickname = state.nickname) {
  try {
    const saved = JSON.parse(recoveryStore.getItem(`mfm:resume:${code}`) || "null");
    return saved?.token && saved?.memberId && saved.nickname === nickname ? saved : null;
  } catch { return null; }
}

function clearRecovery(code) {
  try { if (code) recoveryStore.removeItem(`mfm:resume:${code}`); } catch {}
}

function clearRoomSession() {
  if (state.code) { store.removeItem(`mfm:room:${state.code}`); clearRecovery(state.code); }
  state.room = null;
  state.code = "";
  state.token = "";
  state.memberId = "";
}

function chooseJoinRole(role) {
  const input = document.querySelector(`input[name="joinRole"][value="${role}"]`);
  if (input) input.checked = true;
}

async function joinRoom(code, password, role) {
  const data = await request(`/api/rooms/${code}/join`, {
    method: "POST",
    body: JSON.stringify({ nickname: state.nickname, password, role })
  });
  saveSession(data);
  history.replaceState(null, "", `?room=${data.code}`);
  connectRoom();
}

function roomEntry(room) {
  const entry = document.createElement("article");
  entry.className = "room-entry";
  const phase = room.phase === "lobby" ? "LOBBY" : "LIVE";
  const timer = room.turnSeconds ? `${room.turnSeconds} SEC` : "NO TIMER";
  entry.innerHTML = `
    <div class="room-entry-code"><strong></strong><small>${phase}</small></div>
    <div class="room-entry-meta">
      <span>${room.playerCount} / 4 PLAYERS</span><span>${room.watchCount} WATCH</span>
      <span>${timer}</span><span class="${room.hasPassword ? "locked" : "open"}">${room.hasPassword ? "LOCKED" : "OPEN"}</span>
      ${phase === "LIVE" ? '<span class="live">IN GAME</span>' : ""}
    </div>
    <div class="room-entry-actions"><button class="pix-btn primary" type="button" data-role="player">PLAY</button><button class="pix-btn" type="button" data-role="spectator">WATCH</button></div>`;
  entry.querySelector("strong").textContent = room.code;
  const play = entry.querySelector('[data-role="player"]');
  play.disabled = room.phase !== "lobby" || room.playerCount >= 4;
  entry.querySelectorAll("[data-role]").forEach(button => button.addEventListener("click", async () => {
    const role = button.dataset.role;
    $("#joinCode").value = room.code;
    chooseJoinRole(role);
    $("#lobbyError").textContent = "";
    if (room.hasPassword) {
      $("#joinPassword").focus();
      $("#lobbyError").textContent = "ENTER ROOM PASSWORD";
      $("#joinForm").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    button.disabled = true;
    try { await joinRoom(room.code, "", role); }
    catch (error) { $("#lobbyError").textContent = error.message; button.disabled = false; refreshRoomList(); }
  }));
  return entry;
}

async function refreshRoomList() {
  if ($("#lobbyScreen").hidden || !state.nickname) return;
  const empty = $("#roomListEmpty");
  empty.classList.remove("error");
  try {
    const data = await request("/api/rooms");
    $("#roomList").replaceChildren(...data.rooms.map(roomEntry));
    empty.hidden = data.rooms.length > 0;
    empty.textContent = "NO ACTIVE ROOMS";
  } catch {
    $("#roomList").replaceChildren();
    empty.hidden = false;
    empty.classList.add("error");
    empty.textContent = "ROOM SCAN FAILED";
  }
}

function wsUrl() {
  const base = new URL(apiBase);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `/ws/${state.code}`;
  base.search = new URLSearchParams({ token: state.token, access: state.accessToken }).toString();
  return base.href;
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
  else toast("LINK OFFLINE");
}

function connectRoom() {
  clearTimeout(state.reconnectTimer);
  state.intentionalClose = false;
  state.socket?.close();
  const socket = new WebSocket(wsUrl());
  state.socket = socket;
  setLink(false, "LINKING");
  socket.addEventListener("open", () => { if (state.socket === socket) setLink(true); });
  socket.addEventListener("message", event => {
    if (state.socket !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "error") { $("#roomError").textContent = message.error; toast(message.error); return; }
    if (message.type === "state") {
      state.room = message.room;
      renderRoom();
      if (message.room.phase === "game") enterGame();
    }
  });
  socket.addEventListener("close", event => {
    if (state.socket !== socket) return;
    setLink(false, "RECONNECTING");
    if (state.intentionalClose) return;
    if (event.code === 4001) {
      clearRoomSession();
      setScreen("lobby");
      $("#lobbyError").textContent = "ROOM SESSION EXPIRED";
      return;
    }
    state.reconnectTimer = setTimeout(connectRoom, 1200);
  });
}

function inviteLink() {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", state.code);
  return url.href;
}

async function drawQr() {
  const canvas = $("#qrCanvas");
  await QRCode.toCanvas(canvas, inviteLink(), {
    width: 224,
    margin: 1,
    color: { dark: "#000000", light: "#f1eedc" },
    errorCorrectionLevel: "M"
  });
}

function memberItem(member, self, host) {
  const li = document.createElement("li");
  li.className = `member${member.id === self.id ? " self" : ""}${member.ready ? " ready" : ""}`;
  if (member.color) li.style.setProperty("--member-color", member.color);
  const main = document.createElement("div");
  main.className = "member-main";
  main.innerHTML = `<i class="member-dot"></i><strong class="member-name"></strong><span class="member-tags"></span>`;
  main.querySelector(".member-name").textContent = member.nickname;
  const tags = main.querySelector(".member-tags");
  if (member.isHost) tags.insertAdjacentHTML("beforeend", "<span>HOST</span>");
  if (!member.connected) {
    const deadline = Number(member.reconnectUntil || 0);
    const seconds = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
    const label = !deadline ? "LINK LOST · WAIT TURN" : seconds ? `LINK LOST · ${seconds}S` : "LINK LOST · FINALIZING";
    tags.insertAdjacentHTML("beforeend", `<span class="link-lost-tag" data-reconnect-until="${deadline}">${label}</span>`);
  }
  if (member.role === "player" && !member.isHost) tags.insertAdjacentHTML("beforeend", `<span>${member.ready ? "READY" : "WAIT"}</span>`);
  li.appendChild(main);
  if (host && member.id !== self.id) {
    const actions = document.createElement("div");
    actions.className = "member-actions";
    const move = document.createElement("button");
    move.type = "button";
    move.textContent = member.role === "player" ? "WATCH" : "PLAY";
    move.onclick = () => send({ type: "role", memberId: member.id, role: member.role === "player" ? "spectator" : "player" });
    const kick = document.createElement("button");
    kick.type = "button";
    kick.textContent = "KICK";
    kick.onclick = () => send({ type: "kick", memberId: member.id });
    actions.append(move, kick);
    li.appendChild(actions);
  }
  return li;
}

function renderRoom() {
  const room = state.room;
  if (!room) return;
  setScreen("room");
  const self = room.members.find(member => member.id === room.selfId);
  if (!self) return;
  const host = room.hostId === room.selfId;
  const players = room.members.filter(member => member.role === "player");
  const watchers = room.members.filter(member => member.role === "spectator");
  $("#roomCode").textContent = room.code;
  $("#roomTimer").textContent = room.turnSeconds ? `${room.turnSeconds} SEC` : "NO TIMER";
  $("#roomLock").textContent = room.hasPassword ? "LOCKED" : "OPEN";
  $("#roomPhase").textContent = room.phase.toUpperCase();
  $("#playerCount").textContent = `${players.length} / 4`;
  $("#watchCount").textContent = String(watchers.length);
  $("#playerList").replaceChildren(...players.map(member => memberItem(member, self, host)));
  $("#watchList").replaceChildren(...watchers.map(member => memberItem(member, self, host)));
  $("#inviteUrl").textContent = inviteLink();
  $("#selfRole").textContent = self.role === "player" ? "PLAYER" : "WATCH";
  $("#selfState").textContent = self.role === "player" ? (host ? "HOST CONTROL" : (self.ready ? "READY" : "NOT READY")) : "SPECTATING";
  const usedColors = new Set(players.filter(member => member.id !== self.id).map(member => member.color));
  $("#colorPicker").hidden = self.role !== "player";
  document.querySelectorAll(".color-choice").forEach(button => {
    button.classList.toggle("selected", button.dataset.color === self.color);
    button.disabled = room.phase !== "lobby" || usedColors.has(button.dataset.color);
  });
  $("#roomTimerEdit").hidden = !host;
  const roomTimerInput = $("#roomTimerInput");
  if (document.activeElement !== roomTimerInput) roomTimerInput.value = String(room.turnSeconds || 0);
  roomTimerInput.disabled = room.phase !== "lobby";
  $("#setRoomTimer").disabled = room.phase !== "lobby";
  $("#readyBtn").hidden = self.role !== "player" || host;
  $("#readyBtn").textContent = self.ready ? "CANCEL READY" : "READY";
  $("#moveSelf").textContent = self.role === "player" ? "MOVE TO WATCH" : "JOIN PLAYERS";
  $("#moveSelf").disabled = room.phase !== "lobby" || (self.role === "spectator" && players.length >= 4);
  $("#startBtn").hidden = !host;
  $("#startBtn").disabled = room.phase !== "lobby" || players.length < 2 || !players.filter(player => !player.isHost).every(player => player.ready);
  drawQr().catch(() => { $("#roomError").textContent = "QR GENERATION FAILED"; });
}

function updateReconnectLabels() {
  const now = Date.now();
  document.querySelectorAll(".link-lost-tag").forEach(tag => {
    const deadline = Number(tag.dataset.reconnectUntil || 0);
    const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
    tag.textContent = !deadline ? "LINK LOST · WAIT TURN" : seconds ? `LINK LOST · ${seconds}S` : "LINK LOST · FINALIZING";
  });
}

function enterGame() {
  const self = state.room?.members.find(member => member.id === state.memberId);
  if (!self) return;
  state.intentionalClose = true;
  state.socket?.close(1000, "ENTER GAME");
  const url = new URL("./game.html", location.href);
  url.searchParams.set("online", "1");
  url.searchParams.set("room", state.code);
  url.searchParams.set("member", state.memberId);
  url.searchParams.set("role", self.role);
  location.href = url.href;
}

async function resumeInvite() {
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
  if (code) $("#joinCode").value = code;
  if (!state.nickname || !state.accessToken) return;
  setScreen("lobby");
  if (!code) return;
  const saved = JSON.parse(store.getItem(`mfm:room:${code}`) || "null") || readRecovery(code);
  if (saved?.token) {
    saveSession({ ...saved, code });
    connectRoom();
  }
}

$("#identityForm").addEventListener("submit", async event => {
  event.preventDefault();
  const nickname = $("#nickname").value.trim().toUpperCase();
  if (!nicknameValid(nickname)) { $("#identityError").textContent = "USE 1–6 LETTERS OR NUMBERS"; return; }
  const testCode = $("#testCode").value.trim();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  $("#identityError").textContent = "VERIFYING TEST ACCESS...";
  try {
    const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
    const recovery = code ? readRecovery(code, nickname) : null;
    const access = !testCode && recovery
      ? await request("/api/access/resume", { method: "POST", auth: false, body: JSON.stringify({ nickname, code, roomToken:recovery.token }) })
      : await request("/api/access", { method: "POST", auth: false, body: JSON.stringify({ nickname, testCode }) });
    state.nickname = nickname;
    state.accessToken = access.token;
    store.setItem("mfm:nickname", nickname);
    store.setItem("mfm:test-access", access.token);
    $("#testCode").value = "";
    $("#nicknameView").textContent = nickname;
    $("#identityError").textContent = "";
    if (access.room) saveSession({ ...access.room, token:recovery?.token });
    setScreen("lobby");
    resumeInvite();
  } catch (error) {
    const code = new URLSearchParams(location.search).get("room")?.toUpperCase();
    if (error.message === "ROOM RESUME EXPIRED") clearRecovery(code);
    $("#identityError").textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});

$("#changeNickname").addEventListener("click", () => {
  clearIdentity();
});

function syncCustomTimer() {
  const custom = $("#turnSeconds").value === "custom";
  const input = $("#customTurnSeconds");
  input.hidden = !custom;
  input.required = custom;
  $("#customTimerHint").hidden = !custom;
}

$("#turnSeconds").addEventListener("change", () => {
  syncCustomTimer();
  if (!$("#customTurnSeconds").hidden) $("#customTurnSeconds").focus();
});
syncCustomTimer();

$("#createForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#lobbyError").textContent = "";
  const customTimer = $("#turnSeconds").value === "custom";
  const turnSeconds = customTimer ? Math.trunc(Number($("#customTurnSeconds").value)) : Number($("#turnSeconds").value);
  if (customTimer && (!Number.isInteger(turnSeconds) || turnSeconds < 10 || turnSeconds > 600)) {
    $("#lobbyError").textContent = "TURN TIMER MUST BE 10–600 SEC";
    return;
  }
  try {
    const data = await request("/api/rooms", { method: "POST", body: JSON.stringify({ nickname: state.nickname, password: $("#createPassword").value, turnSeconds }) });
    saveSession(data);
    history.replaceState(null, "", `?room=${data.code}`);
    connectRoom();
  } catch (error) { $("#lobbyError").textContent = error.message; }
});

$("#joinForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#lobbyError").textContent = "";
  const code = $("#joinCode").value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) { $("#lobbyError").textContent = "BAD ROOM CODE"; return; }
  try {
    await joinRoom(code, $("#joinPassword").value, new FormData(event.currentTarget).get("joinRole"));
  } catch (error) { $("#lobbyError").textContent = error.message; }
});

$("#refreshRooms").addEventListener("click", refreshRoomList);

$("#copyInvite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast("LINK COPIED"); }
  catch { $("#roomError").textContent = "COPY FAILED"; }
});
$("#readyBtn").addEventListener("click", () => send({ type: "ready" }));
for (const color of PLAYER_COLORS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "color-choice";
  button.dataset.color = color;
  button.style.setProperty("--choice", color);
  button.title = color.toUpperCase();
  button.setAttribute("aria-label", `Choose player color ${color}`);
  button.addEventListener("click", () => send({ type: "color", color }));
  $("#colorChoices").appendChild(button);
}
$("#setRoomTimer").addEventListener("click", () => {
  const turnSeconds = Math.trunc(Number($("#roomTimerInput").value));
  if (!Number.isInteger(turnSeconds) || turnSeconds !== 0 && (turnSeconds < 10 || turnSeconds > 600)) {
    $("#roomError").textContent = "TURN TIMER MUST BE 0 OR 10-600 SEC";
    return;
  }
  $("#roomError").textContent = "";
  send({ type: "turnTimer", turnSeconds });
});
$("#startBtn").addEventListener("click", () => send({ type: "start", twoCount: 8 }));
$("#moveSelf").addEventListener("click", () => {
  const self = state.room?.members.find(member => member.id === state.memberId);
  if (self) send({ type: "role", memberId: self.id, role: self.role === "player" ? "spectator" : "player" });
});
$("#leaveBtn").addEventListener("click", () => {
  state.intentionalClose = true;
  send({ type: "leave" });
  state.socket?.close(1000, "LEFT ROOM");
  clearRoomSession();
  history.replaceState(null, "", location.pathname);
  setScreen("lobby");
  setLink(false, "LOCAL");
});

function drawNoise() {
  const canvas = $("#noise");
  const width = canvas.width = innerWidth;
  const height = canvas.height = innerHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  for (let index = 0; index < Math.floor(width * height / 1800); index++) {
    ctx.fillStyle = Math.random() > .5 ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.3)";
    ctx.fillRect(Math.random() * width | 0, Math.random() * height | 0, Math.random() > .8 ? 2 : 1, 1);
  }
}

addEventListener("resize", drawNoise);
drawLobbyLogo();
drawNoise();
setInterval(drawNoise, 180);
state.roomRefreshTimer = setInterval(refreshRoomList, 5000);
setInterval(updateReconnectLabels, 250);
async function boot() {
  $("#nickname").value = state.nickname;
  $("#nicknameView").textContent = state.nickname || "------";
  if (!state.nickname || !state.accessToken) {
    setScreen("identity");
    return;
  }
  try {
    await request("/api/access");
    setScreen("lobby");
    resumeInvite();
  } catch {
    clearIdentity("ENTER TEST CODE AGAIN");
  }
}
boot();
request("/api/health").then(() => setLink(true, "SERVER")).catch(() => setLink(false, apiBase === location.origin ? "LOCAL" : "OFFLINE"));
