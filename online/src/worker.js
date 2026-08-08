const ROOM_CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const RADIUS = 4;
const MAX_HAND = 5;
const RECONNECT_GRACE_MS = 120_000;
const GAME_INTRO_MS = 8_000;
const PLACEMENT_SETTLE_MS = 1_250;
const TURN_TRANSITION_MS = 2_000;
const TURN_DEAL_MS = 900;
const FINISHED_ROOM_TTL_MS = 30 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const ACCESS_ATTEMPT_LIMIT = 8;
const ACCESS_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const PLAYER_COLORS = ["#6cbebc", "#d3655d", "#c8a951", "#8c78c4", "#72aa83", "#d8894b", "#cf6f9d", "#4f87c5", "#a8bd55"];

function normalizePlayerColor(value) {
  const color = String(value || "").toLowerCase();
  return PLAYER_COLORS.includes(color) ? color : "";
}

function availablePlayerColor(members, excludeId = "") {
  const used = new Set(members.filter(member => member.id !== excludeId && member.role === "player").map(member => normalizePlayerColor(member.color)).filter(Boolean));
  return PLAYER_COLORS.find(color => !used.has(color)) || PLAYER_COLORS[0];
}

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...extra }
});

const errorJson = (message, status = 400) => json({ ok: false, error: message }, status);
const nicknameOk = value => /^[A-Za-z0-9]{1,6}$/.test(String(value || ""));
const roomCodeOk = value => /^[A-Z2-9]{6}$/.test(String(value || "").toUpperCase());
const K = (q, r) => `${q},${r}`;
const inside = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= RADIUS;
const scoreFor = n => n === 2 ? 1 : n === 3 ? 2 : n === 4 ? 4 : n === 5 ? 7 : n === 6 ? 10 : n >= 7 ? n * 2 : 0;

function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => ROOM_CODE[byte % ROOM_CODE.length]).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ""))) return null;
  try {
    const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { return null; }
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function secureTextEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right)))
  ]);
  return constantTimeEqual(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

async function accessSignature(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function issueAccessToken(env, nickname) {
  const now = Date.now();
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    v: 1,
    nickname,
    issuedAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    nonce: randomToken().slice(0, 24)
  })));
  const signature = base64UrlEncode(await accessSignature(env.TEST_TOKEN_SECRET, payload));
  return { token: `${payload}.${signature}`, expiresAt: now + ACCESS_TOKEN_TTL_MS };
}

async function verifyAccessToken(token, env) {
  if (!env.TEST_TOKEN_SECRET || !token) return null;
  const [payloadPart, signaturePart, extra] = String(token).split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) return null;
  const supplied = base64UrlDecode(signaturePart);
  if (!supplied) return null;
  const expected = await accessSignature(env.TEST_TOKEN_SECRET, payloadPart);
  if (!constantTimeEqual(supplied, expected)) return null;
  const bytes = base64UrlDecode(payloadPart);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const now = Date.now();
    if (payload.v !== 1 || !nicknameOk(payload.nickname) || !Number.isSafeInteger(payload.expiresAt)) return null;
    if (payload.expiresAt <= now || payload.expiresAt > now + ACCESS_TOKEN_TTL_MS + 60_000) return null;
    return payload;
  } catch { return null; }
}

function bearerToken(request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function recordInviteAttempt(env, request, success) {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const key = await digest(`mfm-test-access:${address}`);
  const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("MFM_ROOM_DIRECTORY_V1"));
  const response = await directory.fetch("https://directory/access-attempt", {
    method: "POST",
    body: JSON.stringify({ key, success, now: Date.now() })
  });
  return response.json();
}

async function bodyJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin") || "*";
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function rotate(edges, amount) {
  const n = ((amount % 6) + 6) % 6;
  return edges.map((_, index) => edges[(index - n + 6) % 6]);
}

function combinations(n, k) {
  const out = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const edges = Array.from({ length: n }, (_, index) => (mask >> index) & 1);
    if (edges.reduce((sum, bit) => sum + bit, 0) === k) out.push(edges);
  }
  return out;
}

function canonical(edges) {
  let best = "";
  for (let turn = 0; turn < 6; turn++) {
    const value = rotate(edges, turn).join("");
    if (!best || value < best) best = value;
  }
  return best;
}

function variants(count) {
  const seen = new Set();
  const out = [];
  for (const edges of combinations(6, count)) {
    const value = canonical(edges);
    if (!seen.has(value)) { seen.add(value); out.push(edges); }
  }
  return out;
}

function templatesFor(sides) {
  const base = variants(sides);
  if (sides >= 3 && sides <= 5) return base.flatMap(edges => [
    { edges: [...edges], center: false },
    { edges: [...edges], center: true }
  ]);
  return base.map(edges => ({ edges: [...edges], center: sides === 6 }));
}

const TEMPLATES = Array.from({ length: 7 }, (_, sides) => templatesFor(sides));

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index--) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [items[index], items[random]] = [items[random], items[index]];
  }
  return items;
}

function makeDeck(twoCount = 8) {
  const counts = [2, twoCount * 2, twoCount, twoCount, 4, 2, 2];
  let tileId = 1;
  const deck = [];
  counts.forEach((count, sides) => {
    for (let index = 0; index < count; index++) {
      const template = TEMPLATES[sides][index % TEMPLATES[sides].length];
      deck.push({ id: tileId++, sides, edges: [...template.edges], center: template.center, handRotation: 0 });
    }
  });
  return shuffle(deck);
}

function coordRows(q) {
  const rows = [];
  for (let r = -RADIUS; r <= RADIUS; r++) if (inside(q, r)) rows.push(r);
  return rows;
}

function coordCell(value) {
  const match = String(value || "").trim().toUpperCase().match(/^([A-I])([1-9])$/);
  if (!match) return null;
  const q = match[1].charCodeAt(0) - 65 - RADIUS;
  const r = coordRows(q)[Number(match[2]) - 1];
  return r === undefined ? null : { q, r };
}

function edgeNeighbor(q, r, edge) {
  return [q + DIRS[edge][0], r + DIRS[edge][1]];
}

function canPlace(game, q, r, edges) {
  if (!inside(q, r) || game.board[K(q, r)]) return false;
  for (let edge = 0; edge < 6; edge++) {
    const [nq, nr] = edgeNeighbor(q, r, edge);
    const neighbor = game.board[K(nq, nr)];
    if (neighbor && edges[edge] !== neighbor.edges[(edge + 3) % 6]) return false;
  }
  return true;
}

function tileGroups(tile) {
  const active = tile.edges.map((on, index) => on ? index : -1).filter(index => index >= 0);
  if (tile.center && active.length) return [{ edges: active, center: true }];
  const on = new Set(active);
  const seen = new Set();
  const groups = [];
  for (const edge of active) {
    if (seen.has(edge)) continue;
    const group = [];
    const queue = [edge];
    seen.add(edge);
    while (queue.length) {
      const current = queue.shift();
      group.push(current);
      for (const next of [(current + 5) % 6, (current + 1) % 6]) {
        if (on.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    groups.push({ edges: group, center: false });
  }
  return groups;
}

const nodeId = (key, group) => `${key}#${group}`;
function readNode(id) {
  const cut = id.lastIndexOf("#");
  return { key: id.slice(0, cut), group: Number(id.slice(cut + 1)) };
}

function groupForEdge(tile, edge) {
  return tileGroups(tile).findIndex(group => group.edges.includes(edge));
}

function pathComponent(game, startKey, startGroup) {
  const first = game.board[startKey];
  const groups = first && tileGroups(first);
  if (!first || !groups[startGroup]) return null;
  const firstId = nodeId(startKey, startGroup);
  const seen = new Set([firstId]);
  const queue = [firstId];
  let open = false;
  while (queue.length) {
    const id = queue.shift();
    const ref = readNode(id);
    const tile = game.board[ref.key];
    const group = tileGroups(tile)[ref.group];
    for (const edge of group.edges) {
      const [nq, nr] = edgeNeighbor(tile.q, tile.r, edge);
      if (!inside(nq, nr)) { open = true; continue; }
      const key = K(nq, nr);
      const neighbor = game.board[key];
      if (!neighbor || !neighbor.edges[(edge + 3) % 6]) { open = true; continue; }
      const nextId = nodeId(key, groupForEdge(neighbor, (edge + 3) % 6));
      if (!seen.has(nextId)) { seen.add(nextId); queue.push(nextId); }
    }
  }
  return { nodes: [...seen], keys: [...new Set([...seen].map(id => readNode(id).key))], closed: !open };
}

function scorePlacement(game, key) {
  const tile = game.board[key];
  const results = [];
  const checked = new Set();
  if (!tile) return results;
  tileGroups(tile).forEach((_, group) => {
    const component = pathComponent(game, key, group);
    if (!component) return;
    const signature = component.nodes.slice().sort().join("|");
    if (checked.has(signature)) return;
    checked.add(signature);
    if (!component.closed || game.scored.includes(signature)) return;
    const points = scoreFor(component.keys.length);
    if (!points) return;
    game.scored.push(signature);
    results.push({ ...component, points });
  });
  return results;
}

function legalMoves(game, player) {
  for (const tile of player.hand) {
    for (let turn = 0; turn < 6; turn++) {
      const edges = rotate(tile.edges, turn);
      for (let q = -RADIUS; q <= RADIUS; q++) {
        for (let r = -RADIUS; r <= RADIUS; r++) if (inside(q, r) && canPlace(game, q, r, edges)) return true;
      }
    }
  }
  return false;
}

function drawTiles(game, player, amount = 2) {
  let drawn = 0;
  while (drawn < amount && player.hand.length < MAX_HAND && game.deck.length) {
    player.hand.push(game.deck.shift());
    drawn++;
  }
  return drawn;
}

function pushLog(game, entry) {
  game.logs.unshift({ id: ++game.logSeq, at: Date.now(), round: game.round, turn: game.turn, ...entry });
  game.logs = game.logs.slice(0, 120);
}

function beginTurn(game) {
  const active = game.players.filter(player => !player.resigned);
  if (!active.length) { game.locked = true; return; }
  let guard = 0;
  while (game.players[game.current]?.resigned && guard++ < game.players.length) game.current = (game.current + 1) % game.players.length;
  game.turn++;
  const player = game.players[game.current];
  player.playedThisTurn = false;
  const drawn = drawTiles(game, player, 2);
  const drawnIds = drawn ? player.hand.slice(-drawn).map(tile => tile.id) : [];
  game.turnActiveAt = Date.now() + (drawn ? TURN_DEAL_MS : 250);
  game.turnDeadline = game.turnSeconds ? game.turnActiveAt + game.turnSeconds * 1000 : null;
  pushLog(game, { type: "turn", memberId: player.memberId, text: `${player.nickname} TURN${drawn ? ` · DRAW ${drawn}` : ""}` });
  game.lastEvent = { seq: ++game.eventSeq, type: "turn", at: Date.now(), memberId: player.memberId, drawn, drawnIds };
}

function nextTurn(game) {
  if (game.locked) return;
  let next = game.current;
  for (let count = 0; count < game.players.length; count++) {
    next = (next + 1) % game.players.length;
    if (!game.players[next].resigned) break;
  }
  game.current = next;
  beginTurn(game);
}

function scheduleTurnTransition(game, type, player, auto = false) {
  const now = Date.now();
  game.turnDeadline = null;
  game.turnActiveAt = null;
  game.transitionUntil = now + TURN_TRANSITION_MS;
  game.pendingTurnAdvance = true;
  game.lastEvent = {
    seq: ++game.eventSeq,
    type,
    auto,
    at: now,
    memberId: player.memberId,
    passCount: player.consecutivePasses || 0
  };
}

function finishCurrentTurn(game, auto = false) {
  const player = game.players[game.current];
  if (!player || player.resigned) return { error: "PLAYER NOT AVAILABLE" };
  if (player.playedThisTurn) {
    pushLog(game, { type: "end", memberId: player.memberId, text: `${player.nickname} ENDED TURN${auto ? " · AUTO" : ""}` });
    scheduleTurnTransition(game, "end", player, auto);
    return { ok: true, type: "end" };
  }
  if ((player.consecutivePasses || 0) >= 3) {
    pushLog(game, { type: "pass-defeat", memberId: player.memberId, text: `${player.nickname} PASS LIMIT · DEFEATED` });
    return surrenderGamePlayer(game, player.memberId, "PASS LIMIT · DEFEATED", true);
  }
  player.consecutivePasses = (player.consecutivePasses || 0) + 1;
  pushLog(game, { type: "pass", memberId: player.memberId, text: `${player.nickname} ${auto ? "TIME OUT · AUTO PASS" : "PASSED"} · ${player.consecutivePasses}/3` });
  scheduleTurnTransition(game, "pass", player, auto);
  return { ok: true, type: "pass" };
}

function awardRoundWin(game, winner = null) {
  if (game.roundWinnerAwarded) return game.players.find(player => player.memberId === game.roundWinnerMemberId) || winner;
  const ranked = [...game.players].filter(player => !player.resigned).sort((a, b) => b.roundScore - a.roundScore || b.totalScore - a.totalScore);
  const roundWinner = winner || ranked[0] || null;
  if (roundWinner) roundWinner.roundWins = (roundWinner.roundWins || 0) + 1;
  game.roundWinnerAwarded = true;
  game.roundWinnerMemberId = roundWinner?.memberId || null;
  return roundWinner;
}

function finishGame(game, reason, winner = null, awardCurrentRound = true) {
  const ranked = [...game.players].sort((a, b) => b.totalScore - a.totalScore || b.roundScore - a.roundScore);
  const champion = winner || ranked[0] || null;
  if (awardCurrentRound) awardRoundWin(game, winner);
  game.locked = true;
  game.phase = "game-over";
  game.turnDeadline = null;
  game.turnActiveAt = null;
  game.transitionUntil = null;
  game.pendingTurnAdvance = false;
  game.startAt = null;
  game.result = {
    id: `${game.round}:${game.turn}:${Date.now()}`,
    final: true,
    round: game.round,
    reason,
    winnerMemberId: champion?.memberId || null,
    winnerNickname: champion?.nickname || "NO WINNER",
    winnerScore: champion?.totalScore || 0,
    at: Date.now()
  };
  pushLog(game, { type: "result", memberId: champion?.memberId, text: `${champion?.nickname || "NO WINNER"} WINS · ${reason}` });
}

function finishRound(game, reason, winner = null) {
  const roundWinner = awardRoundWin(game, winner);
  if (game.round >= 3) {
    finishGame(game, reason, null, false);
    return;
  }
  game.locked = true;
  game.phase = "round-over";
  game.turnDeadline = null;
  game.turnActiveAt = null;
  game.transitionUntil = null;
  game.pendingTurnAdvance = false;
  game.startAt = null;
  game.result = {
    id: `${game.round}:${game.turn}:${Date.now()}`,
    final: false,
    round: game.round,
    reason,
    winnerMemberId: roundWinner?.memberId || null,
    winnerNickname: roundWinner?.nickname || "NO WINNER",
    winnerScore: roundWinner?.roundScore || 0,
    at: Date.now()
  };
  pushLog(game, { type: "result", memberId: roundWinner?.memberId, text: `ROUND ${game.round} · ${roundWinner?.nickname || "NO WINNER"} LEADS` });
}

function startNextRound(game) {
  if (!game || game.phase !== "round-over" || game.round >= 3) return false;
  const activeIndices = game.players.map((player, index) => player.withdrawn ? -1 : index).filter(index => index >= 0);
  if (activeIndices.length < 2) return false;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  game.round++;
  game.turn = 0;
  game.current = activeIndices[random[0] % activeIndices.length];
  game.deck = makeDeck(game.twoCount);
  game.deckTotal = game.deck.length;
  game.board = {};
  game.scoreMarks = [];
  game.scored = [];
  game.locked = true;
  game.phase = "starting";
  game.turnDeadline = null;
  game.turnActiveAt = null;
  game.transitionUntil = null;
  game.pendingTurnAdvance = false;
  game.startAt = Date.now() + GAME_INTRO_MS;
  game.result = null;
  game.settleUntil = null;
  game.pendingAdvance = false;
  game.roundWinnerAwarded = false;
  game.roundWinnerMemberId = null;
  for (const player of game.players) {
    player.hand = [];
    player.roundScore = 0;
    player.consecutivePasses = 0;
    player.playedThisTurn = false;
    player.resigned = Boolean(player.withdrawn);
    if (!player.resigned) drawTiles(game, player, 2);
  }
  game.lastEvent = { seq: ++game.eventSeq, type: "round-start", at: Date.now(), round: game.round };
  pushLog(game, { type: "round", text: `ROUND ${game.round} START` });
  return true;
}

function surrenderGamePlayer(game, memberId, reason = "SURRENDERED", roundOnly = false) {
  if (!game || game.locked && game.phase !== "starting" && game.phase !== "round-over") return { ok: false };
  const playerIndex = game.players.findIndex(player => player.memberId === memberId);
  if (playerIndex < 0) return { ok: false };
  const player = game.players[playerIndex];
  if (player.resigned) return { ok: true };
  const wasCurrent = playerIndex === game.current;
  player.resigned = true;
  if (!roundOnly) player.withdrawn = true;
  player.hand = [];
  pushLog(game, { type: "surrender", memberId, text: `${player.nickname} ${reason}` });
  const active = game.players.filter(item => !item.resigned);
  game.lastEvent = { seq: ++game.eventSeq, type: "surrender", at: Date.now(), round: game.round, memberId, nickname: player.nickname, roundOnly, winnerMemberId: active.length === 1 ? active[0].memberId : null };
  if (game.phase === "starting" || game.phase === "round-over") {
    if (active.length <= 1) {
      if (roundOnly) finishRound(game, `${player.nickname} ${reason}`, active[0] || null);
      else finishGame(game, `${player.nickname} ${reason}`, active[0] || null);
    }
    else if (game.phase === "starting" && wasCurrent) {
      for (let step = 1; step <= game.players.length; step++) {
        const candidate = (playerIndex + step) % game.players.length;
        if (!game.players[candidate].resigned) { game.current = candidate; break; }
      }
    }
    return { ok: true };
  }
  if (active.length <= 1) {
    if (roundOnly) finishRound(game, `${player.nickname} ${reason}`, active[0] || null);
    else finishGame(game, `${player.nickname} ${reason}`, active[0] || null);
  }
  else if (wasCurrent) {
    nextTurn(game);
    checkRoundEnd(game);
  } else checkRoundEnd(game);
  return { ok: true };
}

function checkRoundEnd(game) {
  const active = game.players.filter(player => !player.resigned);
  const noMoves = active.every(player => !player.hand.length || !legalMoves(game, player));
  if (!game.deck.length && noMoves) {
    finishRound(game, `ROUND ${game.round} COMPLETE`);
    return true;
  }
  return false;
}

function createGame(members, twoCount = 8, turnSeconds = 0) {
  const deck = makeDeck(twoCount);
  const players = members
    .filter(member => member.role === "player")
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((member, index) => ({ memberId: member.id, nickname: member.nickname, color: normalizePlayerColor(member.color) || PLAYER_COLORS[index % PLAYER_COLORS.length], hand: [], roundScore: 0, totalScore: 0, roundWins: 0, consecutivePasses: 0, playedThisTurn: false, resigned: false, withdrawn: false }));
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const game = {
    round: 1, turn: 0, current: players.length ? random[0] % players.length : 0, deck, deckTotal: deck.length, players,
    board: {}, scoreMarks: [], scored: [], logs: [], logSeq: 0,
    locked: true, phase: "starting", eventSeq: 0, lastEvent: null, twoCount,
    turnSeconds, turnDeadline: null, turnActiveAt: null, transitionUntil: null, pendingTurnAdvance: false,
    startAt: Date.now() + GAME_INTRO_MS, result: null, roundWinnerAwarded: false, roundWinnerMemberId: null,
    settleUntil: null, pendingAdvance: false
  };
  for (const player of players) drawTiles(game, player, 2);
  pushLog(game, { type: "round", text: "ROUND 1 START" });
  return game;
}

function normalizedPlacementSpecs(message) {
  const source = message.action === "placeBatch" ? message.placements : [{
    tileId: message.tileId,
    coord: message.coord,
    boardStep: message.boardStep,
    rotation: message.rotation
  }];
  if (!Array.isArray(source) || !source.length || source.length > MAX_HAND) return null;
  const seenTiles = new Set();
  const seenCells = new Set();
  const specs = [];
  for (const raw of source) {
    const tileId = Number(raw?.tileId);
    const cell = coordCell(raw?.coord);
    const boardStep = Math.max(0, Math.min(5, Math.trunc(Number(raw?.boardStep) || 0)));
    const rotation = Math.max(0, Math.min(5, Math.trunc(Number(raw?.rotation) || 0)));
    if (!Number.isInteger(tileId) || !cell) return null;
    const key = K(cell.q, cell.r);
    if (seenTiles.has(tileId) || seenCells.has(key)) return null;
    seenTiles.add(tileId);
    seenCells.add(key);
    specs.push({ tileId, cell, key, boardStep, rotation });
  }
  return specs;
}

function placeTilesAtomically(game, playerIndex, memberId, message) {
  const specs = normalizedPlacementSpecs(message);
  if (!specs) return { error: "BAD PLACEMENT SET" };

  // Validate against a temporary game so a rejected batch never leaves a
  // partially mutated hand, board, score list, or log behind.
  const next = structuredClone(game);
  const player = next.players[playerIndex];
  const eventSeq = game.eventSeq + 1;
  const placements = [];
  let batchPoints = 0;

  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    const tileIndex = player.hand.findIndex(tile => tile.id === spec.tileId);
    if (tileIndex < 0) return { error: "TILE NOT FOUND" };
    const tile = player.hand[tileIndex];
    const edges = rotate(tile.edges, spec.rotation - spec.boardStep);
    if (!canPlace(next, spec.cell.q, spec.cell.r, edges)) return { error: "NO MATCH" };

    player.hand.splice(tileIndex, 1);
    player.playedThisTurn = true;
    player.consecutivePasses = 0;
    const placed = { ...tile, edges, q: spec.cell.q, r: spec.cell.r, owner: playerIndex };
    next.board[spec.key] = placed;
    const scored = scorePlacement(next, spec.key);
    const points = scored.reduce((sum, result) => sum + result.points, 0);
    const contacts = DIRS.reduce((sum, [dq, dr]) => sum + (next.board[K(spec.cell.q + dq, spec.cell.r + dr)] ? 1 : 0), 0);
    const delay = index === 0 ? 0 : index * 105 + ((eventSeq * 41 + index * 67) % 71);
    batchPoints += points;

    if (points) {
      player.roundScore += points;
      player.totalScore += points;
      for (let markIndex = 0; markIndex < scored.length; markIndex++) {
        const result = scored[markIndex];
        next.scoreMarks.push({
          id: `${eventSeq}:${index}:${markIndex}`,
          nodes: result.nodes,
          keys: result.keys,
          points: result.points,
          player: playerIndex
        });
      }
      pushLog(next, {
        type: "score", memberId, key: spec.key, points,
        tileCount: scored.reduce((sum, result) => sum + result.keys.length, 0),
        text: `${player.nickname} CLOSED · +${points}`
      });
    } else {
      pushLog(next, { type: "place", memberId, key: spec.key, text: `${player.nickname} PLAYED ${tile.sides}-EDGE` });
    }
    placements.push({ key: spec.key, tile: placed, contacts, scored, points, delay });
  }

  next.eventSeq = eventSeq;
  next.lastEvent = {
    seq: eventSeq,
    type: placements.length > 1 ? "place-batch" : "place",
    at: Date.now() + 180,
    memberId,
    key: placements[0].key,
    tile: placements[0].tile,
    contacts: placements[0].contacts,
    scored: placements.flatMap(item => item.scored),
    points: batchPoints,
    placements
  };
  const lastDelay = placements.reduce((maximum, placement) => Math.max(maximum, placement.delay || 0), 0);
  const settleDuration = lastDelay + PLACEMENT_SETTLE_MS;
  next.settleUntil = Date.now() + settleDuration;
  next.pendingAdvance = !player.hand.length;
  Object.assign(game, next);
  return { ok: true };
}

function gameAction(game, memberId, message) {
  if (!game || game.locked) return { error: "GAME LOCKED" };
  const playerIndex = game.players.findIndex(player => player.memberId === memberId);
  if (playerIndex < 0) return { error: "WATCH MODE" };
  const player = game.players[playerIndex];
  const action = message.action;

  if (action === "rotate") {
    const tile = player.hand.find(tile => tile.id === Number(message.tileId));
    if (!tile) return { error: "TILE NOT FOUND" };
    tile.handRotation = ((tile.handRotation || 0) + (message.direction < 0 ? -1 : 1) + 6) % 6;
    return { ok: true };
  }

  if (action === "reorder") {
    const ids = Array.isArray(message.tileIds) ? message.tileIds.map(Number) : [];
    const currentIds = player.hand.map(tile => tile.id);
    if (ids.length !== currentIds.length || new Set(ids).size !== ids.length || ids.some(id => !currentIds.includes(id))) return { error: "BAD HAND ORDER" };
    const tiles = new Map(player.hand.map(tile => [tile.id, tile]));
    player.hand = ids.map(id => tiles.get(id));
    return { ok: true };
  }

  if (playerIndex !== game.current) return { error: "NOT YOUR TURN" };
  if (player.resigned) return { error: "SURRENDERED" };
  if (game.transitionUntil && game.transitionUntil > Date.now()) return { error: "TURN CHANGING" };

  if (action === "place" || action === "placeBatch") return placeTilesAtomically(game, playerIndex, memberId, message);

  if (game.settleUntil && game.settleUntil > Date.now()) return { error: "BOARD SETTLING" };

  if (action === "pass") {
    return finishCurrentTurn(game, false);
  }

  if (action === "surrender") {
    return surrenderGamePlayer(game, memberId, "SURRENDERED ROUND", true);
  }

  return { error: "UNKNOWN ACTION" };
}

function publicGame(game, viewerId, role) {
  if (!game) return null;
  const lastEvent = game.lastEvent
    ? {
        ...game.lastEvent,
        drawnIds: game.lastEvent.memberId === viewerId ? game.lastEvent.drawnIds : undefined
      }
    : null;
  return {
    round: game.round,
    turn: game.turn,
    current: game.current,
    deckCount: game.deck.length,
    deckTotal: game.deckTotal,
    board: game.board,
    scoreMarks: game.scoreMarks,
    logs: game.logs,
    locked: game.locked,
    phase: game.phase,
    result: game.result,
    lastEvent,
    turnSeconds: game.turnSeconds,
    turnDeadline: game.turnDeadline,
    turnActiveAt: game.turnActiveAt || null,
    transitionUntil: game.transitionUntil || null,
    startAt: game.startAt || null,
    settleUntil: game.settleUntil || null,
    players: game.players.map(player => ({
      memberId: player.memberId,
      nickname: player.nickname,
      color: player.color,
      handCount: player.hand.length,
      hand: role === "player" && player.memberId === viewerId ? player.hand : undefined,
      roundScore: player.roundScore,
      totalScore: player.totalScore,
      roundWins: player.roundWins || 0,
      consecutivePasses: player.consecutivePasses || 0,
      playedThisTurn: Boolean(player.playedThisTurn),
      resigned: player.resigned
    }))
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request);
    const url = new URL(request.url);
    let response;

    if (url.pathname === "/api/access" && request.method === "POST") {
      if (!env.TEST_INVITE_CODE || !env.TEST_TOKEN_SECRET) response = errorJson("TEST ACCESS NOT CONFIGURED", 503);
      else {
        const body = await bodyJson(request);
        const nickname = String(body.nickname || "").trim().toUpperCase();
        const suppliedCode = String(body.testCode || "").trim().toLowerCase();
        const expectedCode = String(env.TEST_INVITE_CODE).trim().toLowerCase();
        const valid = nicknameOk(nickname) && await secureTextEqual(suppliedCode, expectedCode);
        const rate = await recordInviteAttempt(env, request, valid);
        if (!valid) response = errorJson(rate.allowed ? "INVALID CALLSIGN OR TEST CODE" : "TOO MANY ATTEMPTS · TRY LATER", rate.allowed ? 401 : 429);
        else response = json({ ok: true, ...(await issueAccessToken(env, nickname)) }, 200, { "cache-control": "no-store" });
      }
    }
    else if (url.pathname === "/api/access/resume" && request.method === "POST") {
      if (!env.TEST_TOKEN_SECRET) response = errorJson("TEST ACCESS NOT CONFIGURED", 503);
      else {
        const body = await bodyJson(request);
        const nickname = String(body.nickname || "").trim().toUpperCase();
        const code = String(body.code || "").trim().toUpperCase();
        const roomToken = String(body.roomToken || "");
        if (!nicknameOk(nickname) || !roomCodeOk(code) || !roomToken) response = errorJson("ROOM RESUME NOT AVAILABLE", 401);
        else {
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          const resumed = await stub.fetch("https://room/resume", { method:"POST", body:JSON.stringify({ nickname, token:roomToken }) });
          if (!resumed.ok) response = errorJson("ROOM RESUME EXPIRED", 401);
          else {
            const member = await resumed.json();
            response = json({ ok:true, ...(await issueAccessToken(env, nickname)), room:{ code, memberId:member.memberId, role:member.role } }, 200, { "cache-control":"no-store" });
          }
        }
      }
    }
    else if (url.pathname === "/api/access" && request.method === "GET") {
      const access = await verifyAccessToken(bearerToken(request), env);
      response = access
        ? json({ ok: true, nickname: access.nickname, expiresAt: access.expiresAt }, 200, { "cache-control": "no-store" })
        : errorJson("TEST ACCESS REQUIRED", 401);
    }
    else if (url.pathname === "/api/health") response = json({ ok: true, service: "MFM ONLINE" });
    else if ((url.pathname === "/api/rooms" || /^\/api\/rooms\//i.test(url.pathname)) && !(await verifyAccessToken(bearerToken(request), env))) {
      response = errorJson("TEST ACCESS REQUIRED", 401);
    }
    else if (url.pathname === "/api/rooms" && request.method === "GET") {
      const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("MFM_ROOM_DIRECTORY_V1"));
      const listed = await directory.fetch("https://directory/list");
      const { rooms: entries = [] } = await listed.json();
      const rooms = [];
      const stale = [];
      await Promise.all(entries.map(async entry => {
        const stub = env.ROOMS.get(env.ROOMS.idFromName(entry.code));
        const infoResponse = await stub.fetch("https://room/info");
        if (!infoResponse.ok) { stale.push(entry.code); return; }
        rooms.push(await infoResponse.json());
      }));
      if (stale.length) await directory.fetch("https://directory/remove", { method: "POST", body: JSON.stringify({ codes: stale }) });
      rooms.sort((a, b) => (a.phase === "lobby" ? 0 : 1) - (b.phase === "lobby" ? 0 : 1) || b.createdAt - a.createdAt);
      response = json({ ok: true, rooms });
    }
    else if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = await bodyJson(request);
      if (!nicknameOk(body.nickname)) response = errorJson("CALLSIGN MUST BE 1–6 LETTERS OR NUMBERS");
      else {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        response = await stub.fetch("https://room/create", { method: "POST", body: JSON.stringify({ ...body, code }) });
        if (response.ok) {
          const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("MFM_ROOM_DIRECTORY_V1"));
          await directory.fetch("https://directory/register", { method: "POST", body: JSON.stringify({ code, createdAt: Date.now() }) });
        }
      }
    } else {
      const match = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join))?$/i);
      const wsMatch = url.pathname.match(/^\/ws\/([A-Z2-9]{6})$/i);
      if (match) {
        const code = match[1].toUpperCase();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        response = match[2]
          ? await stub.fetch("https://room/join", { method: "POST", body: await request.text() })
          : await stub.fetch("https://room/info");
        if (response.ok) {
          const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("MFM_ROOM_DIRECTORY_V1"));
          await directory.fetch("https://directory/register", { method: "POST", body: JSON.stringify({ code }) });
        }
      } else if (wsMatch) {
        const access = await verifyAccessToken(url.searchParams.get("access") || "", env);
        if (!access) return errorJson("TEST ACCESS REQUIRED", 401);
        const code = wsMatch[1].toUpperCase();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const roomToken = url.searchParams.get("token") || "";
        return stub.fetch(new Request(`https://room/socket?token=${encodeURIComponent(roomToken)}`, request));
      } else {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
        return env.ASSETS.fetch(new Request(new URL("./index.html", request.url), request));
      }
    }
    return withCors(response, request);
  }
};

export class RoomDirectory {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const rooms = await this.ctx.storage.get("rooms") || {};
    if (url.pathname === "/access-attempt" && request.method === "POST") {
      const body = await bodyJson(request);
      const now = Number(body.now) || Date.now();
      const key = String(body.key || "");
      const attempts = await this.ctx.storage.get("accessAttempts") || {};
      for (const [entryKey, entry] of Object.entries(attempts)) if (!entry?.expiresAt || entry.expiresAt <= now) delete attempts[entryKey];
      if (body.success) delete attempts[key];
      else if (key) {
        const entry = attempts[key] || { count: 0, expiresAt: now + ACCESS_ATTEMPT_WINDOW_MS };
        entry.count++;
        attempts[key] = entry;
      }
      const ordered = Object.entries(attempts).sort((a, b) => b[1].expiresAt - a[1].expiresAt).slice(0, 500);
      await this.ctx.storage.put("accessAttempts", Object.fromEntries(ordered));
      const current = attempts[key];
      return json({ ok: true, allowed: !current || current.count <= ACCESS_ATTEMPT_LIMIT, retryAt: current?.expiresAt || null });
    }
    if (url.pathname === "/list") {
      return json({ ok: true, rooms: Object.entries(rooms).map(([code, createdAt]) => ({ code, createdAt })) });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = await bodyJson(request);
      if (!roomCodeOk(body.code)) return errorJson("BAD ROOM CODE");
      rooms[body.code.toUpperCase()] = Number(body.createdAt) || rooms[body.code.toUpperCase()] || Date.now();
      const ordered = Object.entries(rooms).sort((a, b) => b[1] - a[1]).slice(0, 200);
      await this.ctx.storage.put("rooms", Object.fromEntries(ordered));
      return json({ ok: true });
    }
    if (url.pathname === "/remove" && request.method === "POST") {
      const body = await bodyJson(request);
      for (const code of body.codes || []) delete rooms[String(code).toUpperCase()];
      await this.ctx.storage.put("rooms", rooms);
      return json({ ok: true });
    }
    return errorJson("NOT FOUND", 404);
  }
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.loaded = false;
  }

  async load() {
    if (!this.loaded) {
      this.room = await this.ctx.storage.get("room") || null;
      this.loaded = true;
    }
    return this.room;
  }

  async save() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  memberView(member) {
    const playerIndex = this.room.members.filter(item => item.role === "player").findIndex(item => item.id === member.id);
    return {
      id: member.id,
      nickname: member.nickname,
      role: member.role,
      ready: member.ready,
      connected: member.connected,
      reconnectUntil: !member.connected ? member.reconnectDeadline || null : null,
      isHost: member.id === this.room.hostId,
      joinedAt: member.joinedAt,
      color: normalizePlayerColor(member.color) || (playerIndex >= 0 ? PLAYER_COLORS[playerIndex % PLAYER_COLORS.length] : null)
    };
  }

  snapshot(memberId) {
    const self = this.room.members.find(member => member.id === memberId);
    return {
      code: this.room.code,
      phase: this.room.phase,
      hasPassword: Boolean(this.room.passwordHash),
      turnSeconds: this.room.turnSeconds || 0,
      serverTime: Date.now(),
      hostId: this.room.hostId,
      selfId: memberId,
      members: this.room.members.map(member => this.memberView(member)),
      game: publicGame(this.room.game, memberId, self?.role)
    };
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") return this.create(request);
    if (url.pathname === "/join" && request.method === "POST") return this.join(request);
    if (url.pathname === "/resume" && request.method === "POST") return this.resume(request);
    if (url.pathname === "/info") return this.info();
    if (url.pathname === "/socket") return this.socket(request);
    return errorJson("NOT FOUND", 404);
  }

  async create(request) {
    if (this.room) return errorJson("ROOM CODE COLLISION", 409);
    const body = await bodyJson(request);
    if (!nicknameOk(body.nickname) || !roomCodeOk(body.code)) return errorJson("BAD ROOM DATA");
    const turnSeconds = Number(body.turnSeconds);
    if (!Number.isInteger(turnSeconds) || turnSeconds !== 0 && (turnSeconds < 10 || turnSeconds > 600)) return errorJson("TURN TIMER MUST BE 10-600 SEC");
    const token = randomToken();
    const member = {
      id: crypto.randomUUID(), nickname: body.nickname.toUpperCase(), role: "player", ready: false,
      connected: false, joinedAt: Date.now(), disconnectedAt: Date.now(), reconnectDeadline: null, tokenHash: await digest(token), color: PLAYER_COLORS[0]
    };
    this.room = {
      code: body.code, phase: "lobby", hostId: member.id,
      passwordHash: body.password ? await digest(body.password) : "",
      turnSeconds,
      members: [member], game: null, createdAt: Date.now()
    };
    this.syncReconnectDeadlines();
    await this.save();
    await this.scheduleAlarm();
    return json({ ok: true, code: this.room.code, token, memberId: member.id, role: member.role }, 201);
  }

  async join(request) {
    if (!this.room) return errorJson("ROOM NOT FOUND", 404);
    const body = await bodyJson(request);
    if (!nicknameOk(body.nickname)) return errorJson("BAD CALLSIGN");
    if (this.room.passwordHash && await digest(body.password || "") !== this.room.passwordHash) return errorJson("WRONG PASSWORD", 403);
    const nickname = body.nickname.toUpperCase();
    if (this.room.members.some(member => member.nickname === nickname)) return errorJson("CALLSIGN ALREADY IN ROOM", 409);
    const role = body.role === "spectator" ? "spectator" : "player";
    if (this.room.phase !== "lobby" && role !== "spectator") return errorJson("GAME ALREADY STARTED · WATCH ONLY", 409);
    if (role === "player" && this.room.members.filter(member => member.role === "player").length >= 4) return errorJson("PLAYER SLOTS FULL", 409);
    if (role === "spectator" && this.room.members.filter(member => member.role === "spectator").length >= 32) return errorJson("WATCH SLOTS FULL", 409);
    const token = randomToken();
    const member = {
      id: crypto.randomUUID(), nickname, role, ready: false,
      connected: false, joinedAt: Date.now(), disconnectedAt: Date.now(), reconnectDeadline: null, tokenHash: await digest(token), color: role === "player" ? availablePlayerColor(this.room.members) : null
    };
    this.room.members.push(member);
    this.syncReconnectDeadlines();
    await this.save();
    await this.scheduleAlarm();
    await this.broadcast();
    return json({ ok: true, code: this.room.code, token, memberId: member.id, role });
  }

  async resume(request) {
    if (!this.room) return errorJson("ROOM NOT FOUND", 404);
    const body = await bodyJson(request);
    if (!nicknameOk(body.nickname) || !body.token) return errorJson("BAD RESUME", 401);
    const tokenHash = await digest(body.token);
    const nickname = String(body.nickname).toUpperCase();
    const member = this.room.members.find(item => item.tokenHash === tokenHash && item.nickname === nickname);
    if (!member) return errorJson("ROOM SESSION EXPIRED", 401);
    return json({ ok:true, memberId:member.id, role:member.role });
  }

  async info() {
    if (!this.room) return errorJson("ROOM NOT FOUND", 404);
    let touched = false;
    for (const member of this.room.members) if (!member.connected && !member.disconnectedAt) {
      member.disconnectedAt = Date.now();
      touched = true;
    }
    if (this.syncReconnectDeadlines()) touched = true;
    if (touched) {
      await this.save();
      await this.scheduleAlarm();
    }
    return json({ ok: true, code: this.room.code, phase: this.room.phase, hasPassword: Boolean(this.room.passwordHash), turnSeconds: this.room.turnSeconds || 0, createdAt: this.room.createdAt || 0, playerCount: this.room.members.filter(member => member.role === "player").length, watchCount: this.room.members.filter(member => member.role === "spectator").length });
  }

  async socket(request) {
    if (!this.room) return errorJson("ROOM NOT FOUND", 404);
    if (request.headers.get("Upgrade") !== "websocket") return errorJson("WEBSOCKET REQUIRED", 426);
    const token = new URL(request.url).searchParams.get("token") || "";
    const tokenHash = await digest(token);
    const member = this.room.members.find(item => item.tokenHash === tokenHash);
    if (!member) return errorJson("BAD SESSION", 401);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [member.id, member.role]);
    server.serializeAttachment({ memberId: member.id });
    member.connected = true;
    member.disconnectedAt = null;
    member.reconnectDeadline = null;
    this.syncReconnectDeadlines();
    await this.save();
    await this.scheduleAlarm();
    queueMicrotask(() => this.broadcast());
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, data) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch {}
  }

  async broadcast() {
    if (!this.room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.memberId) this.send(ws, { type: "state", room: this.snapshot(attachment.memberId) });
    }
  }

  closeMemberSockets(memberId, code = 4001, reason = "REMOVED") {
    for (const ws of this.ctx.getWebSockets(memberId)) {
      try { ws.close(code, reason); } catch {}
    }
  }

  transferHost() {
    if (this.room.members.some(member => member.id === this.room.hostId)) return;
    const candidate = [...this.room.members].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    this.room.hostId = candidate?.id || null;
  }

  reconnectTimerShouldRun(member) {
    if (member.connected || !member.disconnectedAt) return false;
    const game = this.room.game;
    if (this.room.phase !== "game" || member.role !== "player" || !game) return true;
    if (game.phase === "starting" || game.locked || (game.transitionUntil && game.transitionUntil > Date.now())) return false;
    const current = game.players[game.current];
    return current?.memberId === member.id && !current.resigned;
  }

  syncReconnectDeadlines(now = Date.now()) {
    let changed = false;
    for (const member of this.room.members) {
      const shouldRun = this.reconnectTimerShouldRun(member);
      if (shouldRun && !member.reconnectDeadline) {
        const game = this.room.game;
        member.reconnectDeadline = this.room.phase === "game" && game?.turnSeconds
          ? Math.max(now, Number(game.turnDeadline) || now)
          : now + RECONNECT_GRACE_MS;
        changed = true;
      } else if (!shouldRun && member.reconnectDeadline) {
        member.reconnectDeadline = null;
        changed = true;
      }
    }
    return changed;
  }

  removeMember(memberId) {
    this.room.members = this.room.members.filter(member => member.id !== memberId);
    this.transferHost();
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const attachment = ws.deserializeAttachment();
    const member = this.room?.members.find(item => item.id === attachment?.memberId);
    if (!member) { ws.close(4001, "SESSION EXPIRED"); return; }
    let message;
    try { message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
    catch { this.send(ws, { type: "error", error: "BAD MESSAGE" }); return; }

    const host = member.id === this.room.hostId;
    let error = "";
    if (message.type === "ready") {
      if (member.id === this.room.hostId) error = "HOST USE START";
      else if (this.room.phase !== "lobby" || member.role !== "player") error = "READY NOT AVAILABLE";
      else member.ready = !member.ready;
    } else if (message.type === "turnTimer") {
      const turnSeconds = Number(message.turnSeconds);
      if (!host) error = "HOST ONLY";
      else if (this.room.phase !== "lobby") error = "TIMER LOCKED";
      else if (!Number.isInteger(turnSeconds) || turnSeconds !== 0 && (turnSeconds < 10 || turnSeconds > 600)) error = "TURN TIMER MUST BE 0 OR 10-600 SEC";
      else this.room.turnSeconds = turnSeconds;
    } else if (message.type === "start") {
      const players = this.room.members.filter(item => item.role === "player");
      if (!host) error = "HOST ONLY";
      else if (this.room.phase !== "lobby") error = "ALREADY STARTED";
      else if (players.length < 2) error = "NEED 2 PLAYERS";
      else if (!players.filter(player => player.id !== this.room.hostId).every(player => player.ready)) error = "ALL GUEST PLAYERS MUST READY";
      else {
        this.room.game = createGame(this.room.members, Math.max(8, Math.min(15, Number(message.twoCount) || 8)), this.room.turnSeconds || 0);
        this.room.phase = "game";
      }
    } else if (message.type === "role") {
      const target = this.room.members.find(item => item.id === message.memberId);
      const nextRole = message.role === "spectator" ? "spectator" : "player";
      if (this.room.phase !== "lobby") error = "ROLE LOCKED";
      else if (!host && target?.id !== member.id) error = "HOST ONLY";
      else if (!target) error = "PLAYER NOT FOUND";
      else if (nextRole === "player" && this.room.members.filter(item => item.role === "player").length >= 4) error = "PLAYER SLOTS FULL";
      else { target.role = nextRole; target.ready = false; if (nextRole === "player") target.color = availablePlayerColor(this.room.members, target.id); }
    } else if (message.type === "color") {
      const color = normalizePlayerColor(message.color);
      const inUse = this.room.members.some(item => item.id !== member.id && item.role === "player" && normalizePlayerColor(item.color) === color);
      if (this.room.phase !== "lobby" || member.role !== "player") error = "COLOR LOCKED";
      else if (!color) error = "BAD COLOR";
      else if (inUse) error = "COLOR IN USE";
      else member.color = color;
    } else if (message.type === "kick") {
      if (!host) error = "HOST ONLY";
      else if (message.memberId === member.id) error = "USE LEAVE";
      else if (!this.room.members.some(item => item.id === message.memberId)) error = "PLAYER NOT FOUND";
      else {
        if (this.room.phase === "game") surrenderGamePlayer(this.room.game, message.memberId, "REMOVED · SURRENDERED");
        this.closeMemberSockets(message.memberId);
        this.removeMember(message.memberId);
      }
    } else if (message.type === "leave") {
      if (this.room.phase === "game" && member.role === "player") surrenderGamePlayer(this.room.game, member.id, "LEFT · SURRENDERED");
      this.removeMember(member.id);
      this.closeMemberSockets(member.id, 1000, "LEFT ROOM");
    } else if (message.type === "nextRound") {
      if (!host) error = "HOST ONLY";
      else if (this.room.phase !== "game" || this.room.game?.phase !== "round-over") error = "NEXT ROUND NOT AVAILABLE";
      else if (!startNextRound(this.room.game)) error = "CANNOT START NEXT ROUND";
    } else if (message.type === "game") {
      if (this.room.phase !== "game") error = "GAME NOT STARTED";
      else {
        const result = gameAction(this.room.game, member.id, message);
        error = result.error || "";
      }
    } else if (message.type !== "ping") error = "UNKNOWN MESSAGE";

    if (error) this.send(ws, { type: "error", error });
    this.syncReconnectDeadlines();
    await this.save();
    await this.scheduleAlarm();
    if (!this.room.members.length) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.broadcast();
  }

  async webSocketClose(ws) {
    await this.load();
    const attachment = ws.deserializeAttachment();
    const member = this.room?.members.find(item => item.id === attachment?.memberId);
    if (member) {
      member.connected = false;
      member.disconnectedAt = Date.now();
      member.reconnectDeadline = null;
      this.syncReconnectDeadlines();
      await this.save();
      await this.scheduleAlarm();
      await this.broadcast();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async scheduleAlarm() {
    if (!this.room) return;
    const deadlines = [];
    if (this.room.phase === "game" && this.room.game?.phase === "starting" && this.room.game.startAt) deadlines.push(this.room.game.startAt);
    if (this.room.phase === "game" && this.room.game?.settleUntil) deadlines.push(this.room.game.settleUntil);
    if (this.room.phase === "game" && this.room.game?.transitionUntil) deadlines.push(this.room.game.transitionUntil);
    if (this.room.phase === "game" && this.room.game?.turnDeadline) deadlines.push(this.room.game.turnDeadline);
    if (this.room.phase === "game" && this.room.game?.phase === "game-over" && this.room.game.result?.at) deadlines.push(this.room.game.result.at + FINISHED_ROOM_TTL_MS);
    for (const member of this.room.members) if (!member.connected && member.reconnectDeadline) deadlines.push(member.reconnectDeadline);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, Math.min(...deadlines)));
  }

  async alarm() {
    await this.load();
    if (!this.room) return;
    const now = Date.now();
    const game = this.room.game;
    if (this.room.phase === "game" && game?.phase === "game-over" && game.result?.at && game.result.at + FINISHED_ROOM_TTL_MS <= now) {
      const code = this.room.code;
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "ROOM EXPIRED"); } catch {} }
      await this.ctx.storage.deleteAll();
      this.room = null;
      const directory = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("MFM_ROOM_DIRECTORY_V1"));
      await directory.fetch("https://directory/remove", { method: "POST", body: JSON.stringify({ codes: [code] }) });
      return;
    }
    if (this.room.phase === "game" && game?.phase === "starting" && game.startAt && game.startAt <= now) {
      game.startAt = null;
      game.phase = "playing";
      game.locked = false;
      game.lastEvent = {
        seq: ++game.eventSeq,
        type: "start",
        at: now,
        memberId: game.players[game.current]?.memberId || null
      };
      beginTurn(game);
    }
    if (this.room.phase === "game" && game?.settleUntil && game.settleUntil <= now) {
      game.settleUntil = null;
      const advance = game.pendingAdvance;
      game.pendingAdvance = false;
      if (advance && !checkRoundEnd(game)) finishCurrentTurn(game, false);
    }
    if (this.room.phase === "game" && game?.transitionUntil && game.transitionUntil <= now) {
      game.transitionUntil = null;
      const advance = game.pendingTurnAdvance;
      game.pendingTurnAdvance = false;
      if (advance && !checkRoundEnd(game)) nextTurn(game);
    }
    if (this.room.phase === "game" && game?.turnDeadline && game.turnDeadline <= now && !game.locked) {
      const player = game.players[game.current];
      const member = this.room.members.find(item => item.id === player?.memberId);
      if (member?.connected === false) game.turnDeadline = null;
      else finishCurrentTurn(game, true);
    }
    this.syncReconnectDeadlines(now);
    const expired = this.room.members.filter(member => !member.connected && member.reconnectDeadline && member.reconnectDeadline <= now);
    if (this.room.phase === "game") for (const member of expired) if (member.role === "player") surrenderGamePlayer(this.room.game, member.id, "LINK LOST · SURRENDERED");
    const expiredIds = new Set(expired.map(member => member.id));
    this.room.members = this.room.members.filter(member => !expiredIds.has(member.id));
    this.transferHost();
    this.syncReconnectDeadlines(now);
    if (!this.room.members.length) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.save();
    await this.broadcast();
    await this.scheduleAlarm();
  }
}
