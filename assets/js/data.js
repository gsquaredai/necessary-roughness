const seasonCache = new Map();
let indexCache = null;
let transactionsCache = null;
let playersCache = null;

const TYPE_LABEL = {
  draft: "Draft",
  trade: "Trade",
  waiver: "Waiver",
  free_agent: "Free Agent",
  commissioner: "Commissioner",
};

async function loadTransactions() {
  if (transactionsCache) return transactionsCache;
  const res = await fetch("data/transactions.json");
  transactionsCache = await res.json();
  return transactionsCache;
}

async function loadPlayers() {
  if (playersCache) return playersCache;
  const res = await fetch("data/players.json");
  playersCache = await res.json();
  return playersCache;
}

function nflLogoImgHTML(teamAbbr) {
  if (!teamAbbr) return `<span class="nfl-logo"></span>`;
  return `<img class="nfl-logo" src="assets/img/nfl/${teamAbbr}.png" onerror="this.style.visibility='hidden';" alt="">`;
}

// A handful of NFL abbreviations are 2 letters (GB, KC, LV, NE, NO, SF, TB)
// while the rest are 3 — normalize to 3 for a consistent column.
// Display-only: image lookups still use Sleeper's original code.
const NFL_ABBR_3 = { GB: "GNB", KC: "KAN", LV: "LVR", NE: "NWE", NO: "NOR", SF: "SFO", TB: "TAM" };
function nflAbbr3(teamAbbr) {
  return NFL_ABBR_3[teamAbbr] || teamAbbr;
}

// "Jeremiyah Love" -> "J. Love"
function abbreviateName(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}

// Every player name on the site is clickable, opening their profile modal.
function playerLinkHTML(playerId, displayText) {
  if (!playerId) return displayText;
  return `<span class="player-link" data-player-id="${playerId}">${displayText}</span>`;
}

// A traded pick shows what it actually turned into once that season's
// draft has happened (e.g. "2025 - 1.01 (RB - J. Love)"), or which team's
// slot it is if the draft hasn't happened yet ("2027 3rd (Black Ops)").
function pickLabel(pk) {
  if (pk.result) {
    const { pickInRound, playerId, playerName, position } = pk.result;
    const posPart = position ? `${position} - ` : "";
    const nameHTML = playerLinkHTML(playerId, abbreviateName(playerName));
    return `${pk.season} - ${pk.round}.${String(pickInRound).padStart(2, "0")} (${posPart}${nameHTML})`;
  }
  return `${pk.season} ${ordinal(pk.round)} (${pk.originalTeam || "?"})`;
}

// Renders a trade's "sides" (grouped by receiving team) as
// "Team A received: X, Y / Team B received: 1, 2" lines.
function tradeSidesHTML(sides) {
  if (!sides || sides.length === 0) return "";
  return sides
    .map((side) => {
      const items = [
        ...side.players.map(
          (p) => `${playerLinkHTML(p.playerId, p.name)}${p.position ? ` (${p.position})` : ""}`
        ),
        ...side.picks.map(pickLabel),
        ...side.faab.map((amt) => `$${amt} FAAB`),
      ];
      return `<div class="trade-side"><span class="trade-side-team">${side.team.teamName} received:</span> ${
        items.length ? items.join(", ") : "nothing"
      }</div>`;
    })
    .join("");
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

// ---------- player profile modal ----------

function ageAt(birthDateStr) {
  if (!birthDateStr) return null;
  const birth = new Date(birthDateStr + "T00:00:00Z");
  return (Date.now() - birth.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

async function openPlayerModal(playerId) {
  let root = document.getElementById("player-modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "player-modal-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="modal-overlay" id="player-modal-overlay">
      <div class="modal-box"><div class="empty-state">Loading...</div></div>
    </div>
  `;
  root.querySelector("#player-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "player-modal-overlay") closePlayerModal();
  });

  const [players, txns] = await Promise.all([loadPlayers(), loadTransactions()]);
  const player = players[playerId];
  const box = root.querySelector(".modal-box");
  if (!player) {
    box.innerHTML = `<div class="empty-state">Player not found.</div>`;
    return;
  }

  const seasons = Object.keys(player.seasons).sort((a, b) => b - a);
  const age = ageAt(player.birthDate);
  const relatedTxns = txns.filter(
    (t) =>
      t.adds.some((a) => a.playerId === playerId) ||
      t.drops.some((d) => d.playerId === playerId) ||
      t.sides.some((s) => s.players.some((p) => p.playerId === playerId))
  );

  const state = { tab: "bio", season: seasons[0] || null };

  function renderBio() {
    const latest = seasons[0] ? player.seasons[seasons[0]] : null;
    return `
      <div class="player-bio">
        <div class="player-bio-row"><span class="player-bio-label">Age</span><span>${
          age != null ? age.toFixed(1) : "—"
        }</span></div>
        <div class="player-bio-row"><span class="player-bio-label">NFL Team</span><span>${nflLogoImgHTML(
          player.nflTeam
        )} ${player.nflTeam ? nflAbbr3(player.nflTeam) : "—"}</span></div>
        <div class="player-bio-row"><span class="player-bio-label">Dynasty Team</span><span>${
          player.currentTeam ? teamCellHTML(player.currentTeam) : '<span class="muted">Free Agent</span>'
        }</span></div>
        ${
          latest
            ? `
          <div class="player-bio-row"><span class="player-bio-label">${seasons[0]} Position Rank</span><span>${
                player.position || ""
              }${latest.positionRank ?? "—"}</span></div>
          <div class="player-bio-row"><span class="player-bio-label">${seasons[0]} Overall Rank</span><span>#${
                latest.overallRank ?? "—"
              }</span></div>`
            : ""
        }
      </div>
    `;
  }

  function renderSeasons() {
    if (!seasons.length) return `<div class="empty-state">No season data.</div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Season</th><th class="num">GP</th><th class="num">Pts</th><th class="num">Pos Rank</th><th class="num">Overall</th></tr></thead>
          <tbody>
            ${seasons
              .map((s) => {
                const d = player.seasons[s];
                return `<tr>
                  <td>${s}</td>
                  <td class="num">${d.gamesPlayed}</td>
                  <td class="num">${d.totalPoints.toFixed(2)}</td>
                  <td class="num">${player.position || ""}${d.positionRank ?? "—"}</td>
                  <td class="num">#${d.overallRank ?? "—"}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderGames() {
    const seasonData = state.season ? player.seasons[state.season] : null;
    const seasonPicker = `
      <select id="player-modal-season-select">
        ${seasons
          .map((s) => `<option value="${s}" ${s === state.season ? "selected" : ""}>${s}</option>`)
          .join("")}
      </select>
    `;
    if (!seasonData || !seasonData.games.length) {
      return `${seasonPicker}<div class="empty-state">No games logged for this season.</div>`;
    }
    const rows = [...seasonData.games]
      .sort((a, b) => a.week - b.week)
      .map((g) => {
        const statParts = Object.entries(g.stats)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        return `<tr>
          <td>${g.week}</td>
          <td class="num">${g.points.toFixed(2)}</td>
          <td>${g.played ? "Yes" : "No"}</td>
          <td class="game-log-stats">${statParts || "—"}</td>
        </tr>`;
      })
      .join("");
    return `
      ${seasonPicker}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Wk</th><th class="num">Pts</th><th>Played</th><th>Stats</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderTxns() {
    if (!relatedTxns.length) return `<div class="empty-state">No transaction history.</div>`;
    return relatedTxns
      .map((t) => {
        let details = "";
        if (t.type === "draft") {
          const a = t.adds[0];
          details = `<div class="txn-details"><span class="txn-add">${playerLinkHTML(a.playerId, a.name)}${
            a.position ? ` (${a.position})` : ""
          } &mdash; ${t.pickLabel}</span></div>`;
        } else if (t.type === "trade") {
          details = `<div class="history-hop-trade">${tradeSidesHTML(t.sides)}</div>`;
        } else {
          const parts = [
            ...t.adds.map(
              (a) => `<span class="txn-add">+ ${playerLinkHTML(a.playerId, a.name)}${
                a.position ? ` (${a.position})` : ""
              }</span>`
            ),
            ...t.drops.map(
              (d) => `<span class="txn-drop">- ${playerLinkHTML(d.playerId, d.name)}${
                d.position ? ` (${d.position})` : ""
              }</span>`
            ),
          ];
          if (parts.length) details = `<div class="txn-details">${parts.join("")}</div>`;
        }
        return `
          <div class="txn-row">
            <div class="txn-row-top">
              <span class="txn-type txn-type-${t.type}">${TYPE_LABEL[t.type] || t.type}</span>
              <span class="txn-teams">${t.teams.map((tm) => tm.teamName).join(" & ") || "Unknown"}</span>
              <span class="txn-date">${new Date(t.date).toLocaleDateString()}</span>
            </div>
            ${details}
          </div>
        `;
      })
      .join("");
  }

  function renderTabContent() {
    const content = root.querySelector("#player-modal-content");
    if (!content) return;
    if (state.tab === "bio") content.innerHTML = renderBio();
    else if (state.tab === "seasons") content.innerHTML = renderSeasons();
    else if (state.tab === "games") {
      content.innerHTML = renderGames();
      const sel = content.querySelector("#player-modal-season-select");
      if (sel)
        sel.addEventListener("change", () => {
          state.season = sel.value;
          renderTabContent();
        });
    } else if (state.tab === "txns") content.innerHTML = renderTxns();
  }

  box.innerHTML = `
    <button class="modal-close" id="player-modal-close">&times;</button>
    <div class="modal-header">
      <h2>${player.name}</h2>
      <div class="modal-subtitle">${player.position || ""}${
    player.nflTeam ? " &middot; " + nflAbbr3(player.nflTeam) : ""
  }</div>
    </div>
    <div class="view-toggle" id="player-modal-tabs">
      <button type="button" data-tab="bio" class="active">Bio</button>
      <button type="button" data-tab="seasons">Seasons</button>
      <button type="button" data-tab="games">Game Log</button>
      <button type="button" data-tab="txns">Transactions (${relatedTxns.length})</button>
    </div>
    <div class="modal-tab-content" id="player-modal-content"></div>
  `;

  box.querySelector("#player-modal-close").addEventListener("click", closePlayerModal);
  box.querySelector("#player-modal-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    state.tab = btn.dataset.tab;
    box.querySelectorAll("#player-modal-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    renderTabContent();
  });

  renderTabContent();
}

function closePlayerModal() {
  const root = document.getElementById("player-modal-root");
  if (root) root.innerHTML = "";
}

// Capture phase + stopPropagation: player links sometimes sit inside other
// clickable elements (e.g. a draft pick row that expands on click) — this
// intercepts before those ancestor handlers fire, so clicking a name only
// opens the player modal, not both that and the ancestor's own behavior.
document.addEventListener(
  "click",
  (e) => {
    const link = e.target.closest(".player-link");
    if (!link) return;
    e.stopPropagation();
    openPlayerModal(link.dataset.playerId);
  },
  true
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePlayerModal();
});
