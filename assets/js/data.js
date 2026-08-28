const seasonCache = new Map();
let indexCache = null;
let transactionsCache = null;

async function loadTransactions() {
  if (transactionsCache) return transactionsCache;
  const res = await fetch("data/transactions.json");
  transactionsCache = await res.json();
  return transactionsCache;
}

async function loadIndex() {
  if (indexCache) return indexCache;
  const res = await fetch("data/index.json");
  indexCache = await res.json();
  return indexCache;
}

async function loadSeason(season) {
  if (seasonCache.has(season)) return seasonCache.get(season);
  const res = await fetch(`data/${season}.json`);
  const data = await res.json();
  seasonCache.set(season, data);
  return data;
}

async function loadLatestCompletedSeason() {
  const idx = await loadIndex();
  const seasonKeys = idx.seasons.slice().reverse();
  for (const key of seasonKeys) {
    const season = await loadSeason(key);
    if (season.status === "complete" && season.champion != null) return season;
  }
  return null;
}

async function loadAllSeasons() {
  const idx = await loadIndex();
  return Promise.all(idx.seasons.map(loadSeason));
}

function teamById(season, rosterId) {
  return season.teams.find((t) => t.rosterId === rosterId);
}

function record(team) {
  return team.ties ? `${team.wins}-${team.losses}-${team.ties}` : `${team.wins}-${team.losses}`;
}

function fmtPts(n) {
  return n.toFixed(2);
}

// If a local 8-bit team image exists at assets/img/teams/<ownerId>.png, use it.
// Otherwise fall back to the team's Sleeper logo, and if that's missing too,
// render a blank placeholder. No manifest to maintain — just drop a PNG in
// that folder named after the manager's Sleeper owner ID and it takes over.
function avatarImgHTML(team) {
  const fallback = team?.avatar || "";
  if (team?.ownerId) {
    const localSrc = `assets/img/teams/${team.ownerId}.png`;
    const onerror = fallback
      ? `this.onerror=null;this.src='${fallback}';`
      : `this.onerror=null;this.style.visibility='hidden';`;
    return `<img class="avatar" src="${localSrc}" onerror="${onerror}" alt="" loading="lazy">`;
  }
  if (fallback) return `<img class="avatar" src="${fallback}" alt="" loading="lazy">`;
  return `<span class="avatar"></span>`;
}

const CROWN_SVG = `
  <svg class="crown-icon" viewBox="0 0 11 5" xmlns="http://www.w3.org/2000/svg" fill="currentColor" shape-rendering="crispEdges">
    <rect x="1" y="0" width="1" height="1"/>
    <rect x="5" y="0" width="1" height="1"/>
    <rect x="9" y="0" width="1" height="1"/>
    <rect x="0" y="1" width="3" height="1"/>
    <rect x="4" y="1" width="3" height="1"/>
    <rect x="8" y="1" width="3" height="1"/>
    <rect x="0" y="2" width="3" height="1"/>
    <rect x="4" y="2" width="3" height="1"/>
    <rect x="8" y="2" width="3" height="1"/>
    <rect x="0" y="3" width="11" height="2"/>
  </svg>
`;

const FOOTBALL_SVG = `
  <svg class="football-icon" viewBox="0 0 9 7" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="#8b5a2b">
      <rect x="3" y="0" width="3" height="1"/>
      <rect x="2" y="1" width="5" height="1"/>
      <rect x="1" y="2" width="7" height="1"/>
      <rect x="0" y="3" width="9" height="1"/>
      <rect x="1" y="4" width="7" height="1"/>
      <rect x="2" y="5" width="5" height="1"/>
      <rect x="3" y="6" width="3" height="1"/>
    </g>
    <g fill="#f5eee0">
      <rect x="4" y="2" width="1" height="3"/>
      <rect x="3" y="2" width="1" height="1"/>
      <rect x="3" y="4" width="1" height="1"/>
      <rect x="5" y="2" width="1" height="1"/>
      <rect x="5" y="4" width="1" height="1"/>
    </g>
  </svg>
`;

const CONFETTI_COLORS = ["#f2c94c", "#4fd47a", "#4cc9f0", "#ff5d6c", "#e8e8f0"];

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Spawns a one-shot confetti + football burst into `container` (which must
// be position:relative or position:absolute), then cleans itself up once
// the animations finish. Call after the champion card's HTML is in the DOM.
function playChampionCelebration(container) {
  const layer = document.createElement("div");
  layer.className = "celebration-layer";

  const pieceCount = 28;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${randBetween(2, 98)}%`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = `${randBetween(0, 0.5)}s`;
    piece.style.animationDuration = `${randBetween(1.6, 2.6)}s`;
    piece.style.setProperty("--spin", `${Math.round(randBetween(180, 540))}deg`);
    layer.appendChild(piece);
  }

  const footballLeft = document.createElement("div");
  footballLeft.className = "football-piece football-left";
  footballLeft.innerHTML = FOOTBALL_SVG;
  layer.appendChild(footballLeft);

  const footballRight = document.createElement("div");
  footballRight.className = "football-piece football-right";
  footballRight.innerHTML = FOOTBALL_SVG;
  layer.appendChild(footballRight);

  container.appendChild(layer);
  setTimeout(() => layer.remove(), 3200);
}

function teamCellHTML(team, { champ = false, last = false } = {}) {
  const name = team?.teamName ?? "Unknown";
  return `
    <span class="team-cell">
      ${avatarImgHTML(team)}
      <span class="team-name">${name}</span>
      ${champ ? '<span class="badge champ">Champ</span>' : ""}
      ${last ? '<span class="badge last">Last</span>' : ""}
    </span>
  `;
}

function standingsSorted(season) {
  return [...season.teams].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.fpts - a.fpts;
  });
}

function weekHasBeenPlayed(season, week) {
  return season.matchups[week].some((m) => m.teamA.points > 0 || m.teamB?.points > 0);
}

function latestWeekWithData(season) {
  const weeks = Object.keys(season.matchups)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((w) => weekHasBeenPlayed(season, w));
  return weeks.length ? weeks[weeks.length - 1] : null;
}

function setActiveNav() {
  const page = document.body.dataset.page;
  document.querySelectorAll("nav.main-nav a").forEach((a) => {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
  });
}

document.addEventListener("DOMContentLoaded", setActiveNav);
