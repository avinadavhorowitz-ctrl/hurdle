import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, get, set, update, push, remove, runTransaction, onDisconnect }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { supabaseConfig } from "./supabase-config.js";

const $ = id => document.getElementById(id);
const sbOk = supabaseConfig.url && !supabaseConfig.url.includes("YOUR");
const configured = sbOk && firebaseConfig.databaseURL && !firebaseConfig.databaseURL.includes("YOUR");
const db = configured ? getDatabase(initializeApp(firebaseConfig)) : null;
const sb = configured ? createClient(supabaseConfig.url, supabaseConfig.key) : null;

// Word checks run in the SQL database. Returns true/false, or null if the lookup failed.
const wordCache = new Map();
async function checkWord(fn, w) {
  const k = fn + w;
  if (wordCache.has(k)) return wordCache.get(k);
  const { data, error } = await sb.rpc(fn, { w });
  if (error) { toast("Couldn't check that word. Try again."); return null; }
  wordCache.set(k, data === true);
  return data === true;
}

// Each browser tab gets its own id, so a refresh keeps your seat.
const me = sessionStorage.hurdleId || (sessionStorage.hurdleId = Math.random().toString(36).slice(2));

let code = null, seat = null, room = null, cur = "", busy = false;
let unsubRoom = null, unsubConn = null;

/* ---------- helpers ---------- */
const show = id => document.querySelectorAll(".screen").forEach(e => e.classList.toggle("on", e.id === id));
function toast(t) {
  const el = $("toast"); el.textContent = t; el.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2200);
}
const list = o => (o ? Object.values(o) : []);

// green = right spot; orange = in word elsewhere; purple = in word but all copies already found; red = absent
function score(w, s) {
  const res = Array(5).fill("r"), left = {};
  for (let i = 0; i < 5; i++) {
    if (w[i] === s[i]) res[i] = "g"; else left[s[i]] = (left[s[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] === "g") continue;
    if (left[w[i]] > 0) { res[i] = "o"; left[w[i]]--; }
    else if (s.includes(w[i])) res[i] = "p";
  }
  return res;
}

/* ---------- joining ---------- */
async function joinRoom(c) {
  let mySeat = null;
  const res = await runTransaction(ref(db, "rooms/" + c), r => {
    mySeat = null;
    if (!r) { mySeat = "a"; return { players: { a: me }, phase: "waiting", round: 1, setter: "a" }; }
    const p = r.players || {};
    if (p.a === me) { mySeat = "a"; return r; }
    if (p.b === me) { mySeat = "b"; return r; }
    if (!p.b) { mySeat = "b"; r.players.b = me; r.phase = "setting"; return r; }
    return; // room is full: abort
  });
  if (!res.committed) return false;
  enterRoom(c, mySeat);
  return true;
}

function enterRoom(c, s) {
  code = c; seat = s; room = null; cur = "";
  sessionStorage.hurdleRoom = c;
  if (s === "b") remove(ref(db, "lobby/" + c));
  unsubRoom = onValue(ref(db, "rooms/" + c), snap => { room = snap.val(); render(); });
  const pres = ref(db, `rooms/${c}/online/${s}`);
  unsubConn = onValue(ref(db, ".info/connected"), snap => {
    if (snap.val()) { onDisconnect(pres).set(false); set(pres, true); }
  });
  render();
}

async function joinByNumber() {
  const c = $("roomIn").value.trim();
  if (!/^\d{1,8}$/.test(c)) return ($("homeMsg").textContent = "Enter a room number (digits only).");
  $("homeMsg").textContent = "Joining...";
  if (!(await joinRoom(c))) $("homeMsg").textContent = "That room is full. Try another number.";
}

async function joinRandom() {
  $("homeMsg").textContent = "Looking for a room...";
  const snap = await get(ref(db, "lobby"));
  for (const c of Object.keys(snap.val() || {})) {
    const exists = (await get(ref(db, "rooms/" + c))).exists();
    if (exists && (await joinRoom(c))) return;
    remove(ref(db, "lobby/" + c)); // stale or full
  }
  const c = String(Math.floor(100000 + Math.random() * 900000));
  await joinRoom(c);
  const lob = ref(db, "lobby/" + c);
  set(lob, true); onDisconnect(lob).remove();
}

function leave() {
  const c = code, waiting = room && room.phase === "waiting";
  if (unsubRoom) unsubRoom(); if (unsubConn) unsubConn();
  unsubRoom = unsubConn = null;
  if (c && seat) {
    if (waiting) { remove(ref(db, "lobby/" + c)); remove(ref(db, "rooms/" + c)); }
    else set(ref(db, `rooms/${c}/online/${seat}`), false);
  }
  code = seat = room = null; cur = "";
  delete sessionStorage.hurdleRoom;
  render();
}

/* ---------- game actions ---------- */
async function setWord() {
  const w = $("secretIn").value.trim().toLowerCase();
  if (!/^[a-z]{5}$/.test(w)) return toast("Enter a 5-letter word");
  const ok = await checkWord("is_valid_answer", w);
  if (ok === null) return;
  if (!ok) return toast("Not in the word list");
  if (!room || room.phase !== "setting") return;
  update(ref(db, "rooms/" + code), { secret: w, phase: "guessing", guesses: null, hints: null, result: null });
  $("secretIn").value = "";
}

async function submitGuess() {
  if (busy || !room || room.phase !== "guessing") return;
  if (cur.length < 5) return toast("Not enough letters");
  busy = true;
  try {
    const word = cur;
    const ok = await checkWord("is_valid_guess", word);
    if (ok === null) return;
    if (!ok) return toast("Not a valid word");
    if (!room || room.phase !== "guessing") return;
    const n = list(room.guesses).length, win = word === room.secret;
    const upd = { ["guesses/" + n]: word };
    if (win || n === 5) { upd.phase = "over"; upd.result = win ? "won" : "lost"; }
    cur = "";
    await update(ref(db, "rooms/" + code), upd);
  } finally { busy = false; }
}

function press(k) {
  if (!room || room.phase !== "guessing" || room.setter === seat) return;
  if (k === "Enter") submitGuess();
  else if (k === "Backspace") cur = cur.slice(0, -1);
  else if (/^[a-z]$/.test(k) && cur.length < 5) cur += k;
  render();
}

function playAgain() {
  const round = room.round;
  runTransaction(ref(db, "rooms/" + code), r => {
    if (!r || r.phase !== "over" || r.round !== round) return; // someone already restarted
    r.round++; r.setter = r.setter === "a" ? "b" : "a"; r.phase = "setting";
    delete r.secret; delete r.guesses; delete r.hints; delete r.result;
    return r;
  });
}

/* ---------- rendering ---------- */
function render() {
  $("bar").hidden = !code;
  if (!code) return show("home");
  if (!room) return; // first snapshot not here yet
  const opp = seat === "a" ? "b" : "a", p = room.players || {};
  const isSetter = room.setter === seat;
  const oppState = !p[opp] ? "" : (room.online || {})[opp] === false ? " · Opponent offline" : " · Opponent connected";
  $("status").textContent = `Room ${code} · Round ${room.round}${oppState}`;

  if (room.phase === "waiting") { $("rc").textContent = code; return show("wait"); }
  if (room.phase === "setting") { cur = ""; return show(isSetter ? "setword" : "guesswait"); }

  // guessing or over
  show("play");
  const over = room.phase === "over", g = list(room.guesses), guesser = !isSetter;
  $("role").textContent = over ? "" : isSetter ? `Watching your opponent guess. Your word: ${room.secret.toUpperCase()}`
                                              : `Guess ${Math.min(g.length + 1, 6)} of 6`;
  const board = $("board"), best = {}, rank = { g: 4, o: 3, p: 2, r: 1 };
  board.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const w = g[i], sc = w && score(w, room.secret);
    const live = !w && i === g.length && guesser && !over ? cur : "";
    for (let j = 0; j < 5; j++) {
      const d = document.createElement("div");
      d.className = "tile" + (sc ? " " + sc[j] : "");
      d.textContent = w ? w[j] : live[j] || "";
      board.appendChild(d);
      if (sc && (rank[sc[j]] > (rank[best[w[j]]] || 0))) best[w[j]] = sc[j];
    }
  }
  document.querySelectorAll(".key[data-k]").forEach(k => { k.className = "key" + (best[k.dataset.k] ? " " + best[k.dataset.k] : ""); });
  $("kb").style.display = guesser ? "" : "none";

  const hints = [...new Set(list(room.hints))];
  $("hintLine").textContent = isSetter ? (hints.length ? `Hints given: ${hints.length}` : "")
    : hints.length ? "Hints: " + hints.map(h => `${h.toUpperCase()} is in the word`).join(", ") : "";
  $("hintBtn").style.display = guesser && !over ? "" : "none";

  $("over").hidden = !over;
  if (over) {
    const won = room.result === "won";
    $("overMsg").textContent = guesser
      ? (won ? `You got it in ${g.length}!` : "Out of guesses. Better luck next time!")
      : (won ? `They guessed it in ${g.length}.` : "They ran out of guesses. Your word held up!");
    $("overWord").innerHTML = "";
    for (const ch of room.secret) { const d = document.createElement("div"); d.className = "tile g"; d.textContent = ch; $("overWord").appendChild(d); }
  }
}

/* ---------- wiring ---------- */
for (const row of ["qwertyuiop", "asdfghjkl", "zxcvbnm"]) {
  const r = document.createElement("div"); r.className = "krow";
  if (row[0] === "z") r.appendChild(mkKey("Enter", "Enter", true));
  for (const ch of row) r.appendChild(mkKey(ch, ch));
  if (row[0] === "z") r.appendChild(mkKey("Backspace", "Del", true));
  $("kb").appendChild(r);
}
function mkKey(k, label, wide) {
  const b = document.createElement("button");
  b.className = "key" + (wide ? " wide" : ""); b.textContent = label;
  if (!wide) b.dataset.k = k;
  b.onclick = () => press(k);
  return b;
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Enter" || k === "Backspace" || /^[a-z]$/.test(k)) { e.preventDefault(); press(k); }
});
$("roomIn").onkeydown = e => e.key === "Enter" && joinByNumber();
$("secretIn").onkeydown = e => e.key === "Enter" && setWord();
$("joinBtn").onclick = joinByNumber;
$("randBtn").onclick = joinRandom;
$("secretBtn").onclick = setWord;
$("leave").onclick = leave;
$("againBtn").onclick = playAgain;
$("hintBtn").onclick = () => {
  if (room && room.phase === "guessing") push(ref(db, `rooms/${code}/hints`), room.secret[Math.floor(Math.random() * 5)]);
};

if (!configured) {
  $("homeMsg").textContent = "Setup needed: add your Firebase and Supabase settings to firebase-config.js and supabase-config.js (see README).";
  $("joinBtn").disabled = $("randBtn").disabled = true;
} else if (sessionStorage.hurdleRoom) {
  joinRoom(sessionStorage.hurdleRoom).then(ok => { if (!ok) delete sessionStorage.hurdleRoom; });
}
