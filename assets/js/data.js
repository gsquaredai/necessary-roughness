const seasonCache = new Map();
let indexCache = null;
let transactionsCache = null;
let playersCache = null;
let pickRegistryCache = null;

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

async function loadPickRegistry() {
  if (pickRegistryCache) return pickRegistryCache;
  const res = await fetch("data/pick-registry.json");
  pickRegistryCache = await res.json();
  return pickRegistryCache;
}

let rivalriesCache = null;
async function loadRivalries() {
  if (rivalriesCache) return rivalriesCache;
  try {
    const res = await fetch("data/rivalries.json");
    rivalriesCache = await res.json();
  } catch {
    rivalriesCache = [];
  }
  return rivalriesCache;
}

// League median (the middle score across every team that week) for the
// bonus median win/loss each team's record includes, per the League
// Median rule. Regular season only — playoffs don't use it.
function weekMedian(season, week) {
  const scores = [];
  for (const m of season.matchups[week] || []) {
    scores.push(m.teamA.points);
    if (m.teamB) scores.push(m.teamB.points);
  }
  if (!scores.length) return null;
  scores.sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  return scores.length % 2 === 0 ? (scores[mid - 1] + scores[mid]) / 2 : scores[mid];
}

// Best-possible-lineup projected total for a team that week — the spread
// basis for Pick-Em. Same nested-eligibility greedy fill a "potential
// points" calc would use, just run on projections instead of actual
// scores: exact positions first, then FLEX, then SUPER_FLEX, then
// IDP_FLEX, each slot always taking the single highest-projected
// still-available eligible player. That fill order is provably optimal
// here because each later category's eligibility is a superset of the
// ones already filled (a classic nested/laminar-matroid greedy).
function computeOptimalProjectedLineup(playerIds, projByPlayer, playersDb, rosterPositions) {
  const slotCounts = {};
  for (const pos of rosterPositions || []) {
    if (pos === "BN") continue;
    slotCounts[pos] = (slotCounts[pos] || 0) + 1;
  }

  const pool = (playerIds || [])
    .map((pid) => ({
      id: pid,
      pos: playersDb[pid]?.position || null,
      pts: projByPlayer && projByPlayer[pid] != null ? projByPlayer[pid] : 0,
    }))
    .filter((p) => p.pos);

  const used = new Set();
  let total = 0;

  // `eligible` is either an array of exact position codes, or a predicate
  // function — needed for IDP_FLEX, since Sleeper labels individual
  // defensive players with granular codes (DE, DT, CB, S, OLB, ILB, ...)
  // rather than a fixed small set, so "anything that isn't offense" is the
  // only reliable eligibility check there.
  function takeBest(eligible, count) {
    const isEligible = typeof eligible === "function" ? eligible : (pos) => eligible.includes(pos);
    for (let i = 0; i < count; i++) {
      let best = null;
      for (const p of pool) {
        if (used.has(p.id) || !isEligible(p.pos)) continue;
        if (!best || p.pts > best.pts) best = p;
      }
      if (best) {
        used.add(best.id);
        total += best.pts;
      }
    }
  }

  const OFFENSE_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K"]);

  for (const exact of ["QB", "RB", "WR", "TE"]) {
    if (slotCounts[exact]) takeBest([exact], slotCounts[exact]);
  }
  if (slotCounts.FLEX) takeBest(["RB", "WR", "TE"], slotCounts.FLEX);
  if (slotCounts.WRRB_FLEX) takeBest(["WR", "RB"], slotCounts.WRRB_FLEX);
  if (slotCounts.REC_FLEX) takeBest(["WR", "TE"], slotCounts.REC_FLEX);
  if (slotCounts.SUPER_FLEX) takeBest(["QB", "RB", "WR", "TE"], slotCounts.SUPER_FLEX);
  if (slotCounts.IDP_FLEX) takeBest((pos) => !OFFENSE_POSITIONS.has(pos), slotCounts.IDP_FLEX);

  return total;
}

// Named rivalry (if any) between two owner ids, order-independent.
function findRivalry(rivalries, ownerIdA, ownerIdB) {
  if (!ownerIdA || !ownerIdB) return null;
  return (
    rivalries.find(
      (r) =>
        (r.owners[0] === ownerIdA && r.owners[1] === ownerIdB) ||
        (r.owners[0] === ownerIdB && r.owners[1] === ownerIdA)
    ) || null
  );
}

// The one stable identity for a draft pick everywhere on the site: which
// season, which round, and whose original draft slot it is — independent
// of who currently holds it or who it was drafted by.
function pickId(pk) {
  return `${pk.season}-${pk.round}-${pk.originalRosterId}`;
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

// Wraps just the "year/round" portion of a pick reference in its own
// clickable span (not the player name link, which may sit right next to
// it) — clicking it opens the pick-info popup for this exact pick.
function pickLinkHTML(pk, displayText) {
  if (pk.originalRosterId == null) return displayText;
  return `<span class="pick-link" data-pick-id="${pickId(pk)}">${displayText}</span>`;
}

// The "draft" synthetic transaction entries carry season/round/
// originalRosterId alongside a precomputed pickLabel string — wrap that
// string in the same clickable pick-link.
function txnPickLabelHTML(t) {
  return pickLinkHTML({ season: t.season, round: t.round, originalRosterId: t.originalRosterId }, t.pickLabel);
}

// A traded pick shows what it actually turned into once that season's
// draft has happened (e.g. "2025 - 1.01 (RB - J. Love)"), or which team's
// slot it is if the draft hasn't happened yet ("2027 3rd (Black Ops)").
function pickLabel(pk) {
  if (pk.result) {
    const { pickInRound, playerId, playerName, position } = pk.result;
    const posPart = position ? `${position} - ` : "";
    const nameHTML = playerLinkHTML(playerId, abbreviateName(playerName));
    const prefix = pickLinkHTML(pk, `${pk.season} - ${pk.round}.${String(pickInRound).padStart(2, "0")}`);
    return `${prefix} (${posPart}${nameHTML})`;
  }
  const prefix = pickLinkHTML(pk, `${pk.season} ${ordinal(pk.round)}`);
  return `${prefix} (${pk.originalTeam || "?"})`;
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

const TROPHY_SVG = `
  <svg class="trophy-icon" viewBox="0 0 7 7" xmlns="http://www.w3.org/2000/svg" fill="currentColor" shape-rendering="crispEdges">
    <rect x="0" y="0" width="1" height="2"/>
    <rect x="6" y="0" width="1" height="2"/>
    <rect x="1" y="0" width="5" height="1"/>
    <rect x="1" y="1" width="5" height="2"/>
    <rect x="2" y="3" width="3" height="1"/>
    <rect x="3" y="4" width="1" height="1"/>
    <rect x="1" y="5" width="5" height="1"/>
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

function teamCellHTML(team, { champ = false, second = false, third = false, last = false } = {}) {
  const name = team?.teamName ?? "Unknown";
  const mine = isMyTeam(team?.ownerId);
  return `
    <span class="team-cell">
      ${avatarImgHTML(team)}
      <span class="team-name">${name}</span>
      ${mine ? '<span class="badge you">You</span>' : ""}
      ${champ ? '<span class="badge champ">Champ</span>' : ""}
      ${second ? '<span class="badge second">2nd</span>' : ""}
      ${third ? '<span class="badge third">3rd</span>' : ""}
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

// ---------- site-wide "which team are you" (localStorage, casual) ----------
// Separate from Pick-Em's real login — this is purely a per-browser
// convenience so the site can highlight "your" team wherever it shows up.
// Persists until the browser's storage is cleared.

const SITE_IDENTITY_KEY = "nr_site_identity_v1";

function loadSiteIdentity() {
  try {
    return JSON.parse(localStorage.getItem(SITE_IDENTITY_KEY));
  } catch {
    return null;
  }
}

function saveSiteIdentity(team) {
  try {
    localStorage.setItem(
      SITE_IDENTITY_KEY,
      JSON.stringify({ ownerId: team.ownerId, rosterId: team.rosterId, teamName: team.teamName })
    );
  } catch {
    // localStorage unavailable — highlighting just won't persist
  }
}

function clearSiteIdentity() {
  try {
    localStorage.removeItem(SITE_IDENTITY_KEY);
  } catch {
    // ignore
  }
}

function isMyTeam(ownerId) {
  const id = loadSiteIdentity();
  return !!(id && ownerId && id.ownerId === ownerId);
}

async function openSiteIdentityPicker() {
  const idx = await loadIndex();
  const season = await loadSeason(idx.currentSeason);
  let root = document.getElementById("player-modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "player-modal-root";
    document.body.appendChild(root);
  }
  const current = loadSiteIdentity();
  const rows = season.teams
    .slice()
    .sort((a, b) => a.teamName.localeCompare(b.teamName))
    .map(
      (t) => `
        <div class="team-list-row" data-roster-id="${t.rosterId}" role="button" tabindex="0">
          ${avatarImgHTML(t)}
          <div class="team-list-info">
            <div class="team-name">${t.teamName}</div>
            <div class="team-list-owner">${t.displayName}</div>
          </div>
        </div>
      `
    )
    .join("");
  root.innerHTML = `
    <div class="modal-overlay" id="player-modal-overlay">
      <div class="modal-box">
        <button class="modal-close" id="player-modal-close">&times;</button>
        <div class="modal-header">
          <h2>Which team are you?</h2>
          <div class="modal-subtitle">Highlights your team across the site on this browser.</div>
        </div>
        <div class="modal-tab-content">
          <div class="team-box-list">${rows}</div>
          ${current ? `<button type="button" id="site-identity-clear" class="link-btn" style="display: block; margin: 14px auto 0;">Clear</button>` : ""}
        </div>
      </div>
    </div>
  `;
  root.querySelector("#player-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "player-modal-overlay") closePlayerModal();
  });
  root.querySelector("#player-modal-close").addEventListener("click", closePlayerModal);
  root.querySelectorAll(".team-list-row").forEach((row) => {
    row.addEventListener("click", () => {
      saveSiteIdentity(teamById(season, Number(row.dataset.rosterId)));
      location.reload();
    });
  });
  root.querySelector("#site-identity-clear")?.addEventListener("click", () => {
    clearSiteIdentity();
    location.reload();
  });
}

function refreshSiteIdentityBar() {
  const bar = document.getElementById("site-identity-bar");
  if (!bar) return;
  const id = loadSiteIdentity();
  bar.innerHTML = id
    ? `<button type="button" class="site-identity-btn" id="site-identity-btn">Playing as <strong>${id.teamName}</strong> &middot; change</button>`
    : `<button type="button" class="site-identity-btn site-identity-btn-empty" id="site-identity-btn">Pick your team &rarr; highlight it across the site</button>`;
  bar.querySelector("#site-identity-btn").addEventListener("click", openSiteIdentityPicker);
}

function renderSiteIdentityBar() {
  const page = document.querySelector(".page");
  if (!page || document.getElementById("site-identity-bar")) return;
  const bar = document.createElement("div");
  bar.className = "site-identity-bar";
  bar.id = "site-identity-bar";
  page.parentNode.insertBefore(bar, page);
  refreshSiteIdentityBar();
}

const SITE_IDENTITY_PROMPTED_KEY = "nr_site_identity_prompted_v1";

function maybeAutoPromptSiteIdentity() {
  if (loadSiteIdentity()) return;
  // pickem.html has its own inline "which team are you" screen and forces
  // it before showing anything else — don't stack the generic modal on it.
  if (document.body.dataset.page === "pickem") return;
  let prompted = false;
  try {
    prompted = localStorage.getItem(SITE_IDENTITY_PROMPTED_KEY) === "1";
  } catch {}
  if (prompted) return;
  try {
    localStorage.setItem(SITE_IDENTITY_PROMPTED_KEY, "1");
  } catch {}
  openSiteIdentityPicker();
}

document.addEventListener("DOMContentLoaded", () => {
  setActiveNav();
  renderSiteIdentityBar();
  maybeAutoPromptSiteIdentity();
});

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
          } &mdash; ${txnPickLabelHTML(t)}</span></div>`;
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

// ---------- matchup detail modal ----------
// Shared by matchups.html (every regular-season/playoff matchup card) and
// history.html (the Highest Single-Week Team Score list) — both open the
// same side-by-side roster/scoring popup for a given week's matchup.

// A given week's matchup entry for a roster, regardless of which side
// (teamA/teamB) it ended up on.
function matchupEntryForRosterInWeek(season, week, rosterId) {
  if (rosterId == null) return null;
  const matchups = season.matchups?.[week] || season.matchups?.[String(week)] || [];
  return matchups.find((m) => m.teamA.rosterId === rosterId || m.teamB?.rosterId === rosterId) || null;
}

let matchupPlayersCache = null;

function matchupPlayerRowHTML(players, playerId, season, week, played, side) {
  const p = players[playerId];
  const name = p ? p.name : "Unknown Player";
  const meta = p ? [p.position, p.nflTeam].filter(Boolean).join(" &middot; ") : "";
  let pts, isProj;
  if (played) {
    const game = p?.seasons?.[season.season]?.games?.find((g) => g.week === week);
    pts = game ? game.points : null;
    isProj = false;
  } else {
    pts = side.projByPlayer ? side.projByPlayer[playerId] : null;
    isProj = true;
  }
  return `
    <div class="roster-player">
      <span>${playerLinkHTML(playerId, name)}${meta ? `<span class="player-meta">${meta}</span>` : ""}</span>
      <span class="info-stat-value${isProj ? " proj-primary" : ""}">${pts != null ? fmtPts(pts) : "—"}</span>
    </div>
  `;
}

function matchupRosterGroupHTML(title, playerIds, players, season, week, played, side) {
  if (!playerIds.length) return "";
  return `
    <div class="roster-group">
      <div class="roster-group-title">${title} (${playerIds.length})</div>
      ${playerIds.map((pid) => matchupPlayerRowHTML(players, pid, season, week, played, side)).join("")}
    </div>
  `;
}

function matchupSideHTML(season, week, team, side, players, played) {
  if (!team || !side) return `<div class="empty-state">No roster data for this team.</div>`;
  const starters = new Set(side.starters || []);
  const bench = (side.players || []).filter((pid) => !starters.has(pid));
  const totalHTML = played
    ? `${fmtPts(side.points)} pts`
    : `<span class="proj-primary">Proj ${side.projPoints != null ? fmtPts(side.projPoints) : "—"}</span>`;
  return `
    <div class="info-section-title">${team.teamName} &mdash; ${totalHTML}</div>
    ${matchupRosterGroupHTML("Starters", side.starters || [], players, season, week, played, side)}
    ${matchupRosterGroupHTML("Bench", bench, players, season, week, played, side)}
  `;
}

// ---------- Pick-Em vote tallies (read-only) ----------
// Shared by matchups.html, pickem.html, and index.html — all of which
// define their own Firebase `auth`/`db` (same project) and kick off an
// anonymous sign-in on load.

async function waitForFirebaseAuth() {
  if (auth.currentUser) return;
  await new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged((user) => {
      if (user) {
        unsub();
        resolve();
      }
    });
  });
}

// matchupId -> {rosterId: pickCount} for a given week's Pick-Em picks.
// Fails closed (returns {}) if Firebase isn't reachable so the pick-count
// UI just quietly doesn't show rather than erroring.
async function loadPickCounts(week) {
  try {
    await waitForFirebaseAuth();
    const snap = await db.collection("picks").where("week", "==", week).get();
    const counts = {};
    snap.docs.forEach((d) => {
      const data = d.data();
      if (!data.picks) return;
      for (const [matchupId, rosterId] of Object.entries(data.picks)) {
        if (!counts[matchupId]) counts[matchupId] = {};
        counts[matchupId][rosterId] = (counts[matchupId][rosterId] || 0) + 1;
      }
    });
    return counts;
  } catch {
    return {};
  }
}

// The spread for one matchup: each side's best-possible-lineup projected
// total, and the rounded-to-nearest-0.5 point difference between them.
function matchupSpreadInfo(season, players, m) {
  const teamA = teamById(season, m.teamA.rosterId);
  const teamB = teamById(season, m.teamB.rosterId);
  const totalA = computeOptimalProjectedLineup(m.teamA.players, m.teamA.projByPlayer, players, season.rosterPositions);
  const totalB = computeOptimalProjectedLineup(m.teamB.players, m.teamB.projByPlayer, players, season.rosterPositions);
  const spread = Math.round(Math.abs(totalA - totalB) * 2) / 2;
  return { m, teamA, teamB, totalA, totalB, spread };
}

// All-time Pick-Em pool points per ownerId, graded through the last
// actually-played week (an unplayed week has no real result to grade
// against yet). Fails closed (returns an empty map) if Firebase isn't
// reachable.
async function computePickEmPoints(season, players) {
  const points = new Map();
  try {
    await waitForFirebaseAuth();
    const snap = await db.collection("picks").get();
    const gradedThroughWeek = latestWeekWithData(season) ?? 0;
    snap.docs.forEach((d) => {
      const data = d.data();
      const week = Number(data.week);
      if (week > gradedThroughWeek) return;
      if (!points.has(data.ownerId)) points.set(data.ownerId, 0);
      const matchups = (season.matchups[week] || []).filter((m) => m.teamB);
      for (const m of matchups) {
        const pickedRosterId = data.picks ? data.picks[m.matchupId] : null;
        if (pickedRosterId == null) continue;
        const { totalA, totalB, spread } = matchupSpreadInfo(season, players, m);
        const favIsA = totalA >= totalB;
        const actualMargin = favIsA ? m.teamA.points - m.teamB.points : m.teamB.points - m.teamA.points;
        let coveringRosterId = null;
        if (actualMargin > spread) coveringRosterId = favIsA ? m.teamA.rosterId : m.teamB.rosterId;
        else if (actualMargin < spread) coveringRosterId = favIsA ? m.teamB.rosterId : m.teamA.rosterId;
        if (coveringRosterId != null && pickedRosterId === coveringRosterId) {
          points.set(data.ownerId, points.get(data.ownerId) + 1);
        }
      }
    });
  } catch {
    // Firebase unreachable — return whatever's accumulated (likely empty).
  }
  return points;
}

async function openMatchupModal(season, week, rosterIdA, rosterIdB) {
  let root = document.getElementById("player-modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "player-modal-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="modal-overlay" id="player-modal-overlay">
      <div class="modal-box wide"><div class="empty-state">Loading...</div></div>
    </div>
  `;
  root.querySelector("#player-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "player-modal-overlay") closePlayerModal();
  });

  if (!matchupPlayersCache) matchupPlayersCache = await loadPlayers();
  const players = matchupPlayersCache;

  const entry = matchupEntryForRosterInWeek(season, week, rosterIdA);
  const sideA = entry ? (entry.teamA.rosterId === rosterIdA ? entry.teamA : entry.teamB) : null;
  const sideB = entry ? (entry.teamA.rosterId === rosterIdB ? entry.teamA : entry.teamB) : null;
  const teamA = teamById(season, rosterIdA);
  const teamB = teamById(season, rosterIdB);
  const played = weekHasBeenPlayed(season, week);

  const box = document.getElementById("player-modal-root").querySelector(".modal-box");
  box.innerHTML = `
    <button class="modal-close" id="player-modal-close">&times;</button>
    <div class="modal-header">
      <h2>Week ${week}</h2>
      <div class="modal-subtitle">${teamA ? teamA.teamName : "?"} vs ${teamB ? teamB.teamName : "?"}</div>
    </div>
    <div class="modal-tab-content matchup-modal-columns">
      <div>${matchupSideHTML(season, week, teamA, sideA, players, played)}</div>
      <div>${matchupSideHTML(season, week, teamB, sideB, players, played)}</div>
    </div>
  `;
  box.querySelector("#player-modal-close").addEventListener("click", closePlayerModal);
}

// ---------- shared trade-hop chain renderer ----------

// Renders a pick's (or player's) full trade-hop chain: "Team A -> Team B
// (date)" plus what each side received in that trade. Used by the Drafts
// page's per-pick history panel and the pick-info popup.
function renderTradeHopsHTML(tradeHistory, emptyText) {
  if (!tradeHistory || tradeHistory.length === 0) {
    return `<div class="history-empty">${emptyText}</div>`;
  }
  const hops = tradeHistory
    .map(
      (h) => `
        <div class="history-hop">
          <div class="history-hop-top">
            <span class="history-team">${h.from.teamName}</span>
            <span class="history-arrow">&rarr;</span>
            <span class="history-team">${h.to.teamName}</span>
            <span class="history-date">${new Date(h.date).toLocaleDateString()}</span>
          </div>
          <div class="history-hop-trade">${tradeSidesHTML(h.sides)}</div>
        </div>
      `
    )
    .join("");
  return `<div class="history-chain">${hops}</div>`;
}

// ---------- pick-info modal ----------

// Navigates to the exact pick in the Drafts tab (season + overall pick
// number), which scrolls to and expands that row on load.
function goToDraftPick(season, pickNo) {
  location.href = `drafts.html?season=${encodeURIComponent(season)}&pickNo=${encodeURIComponent(pickNo)}`;
}

async function openPickModal(id) {
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

  const registry = await loadPickRegistry();
  const pick = registry[id];
  const box = root.querySelector(".modal-box");
  if (!pick) {
    box.innerHTML = `<div class="empty-state">Pick not found.</div>`;
    return;
  }

  const title = `${pick.season} &middot; Round ${pick.round}`;

  let statusHTML;
  if (pick.resolved) {
    const posPart = pick.position ? `${pick.position} - ` : "";
    const nameHTML = playerLinkHTML(pick.playerId, pick.playerName);
    const teamName = pick.draftedByTeam ? pick.draftedByTeam.teamName : "Unknown";
    const teamHTML = pick.draftedByTeam
      ? `<span class="pick-goto-draft" data-season="${pick.season}" data-pick-no="${pick.pickNo}">${teamName}</span>`
      : teamName;
    statusHTML = `
      <div class="player-bio-row"><span class="player-bio-label">Selected</span><span>${posPart}${nameHTML} (${teamHTML})</span></div>
    `;
  } else {
    statusHTML = `
      <div class="player-bio-row"><span class="player-bio-label">Currently Held By</span><span>${
        pick.currentHolderTeam ? teamCellHTML(pick.currentHolderTeam) : "—"
      }</span></div>
    `;
  }

  box.innerHTML = `
    <button class="modal-close" id="player-modal-close">&times;</button>
    <div class="modal-header">
      <h2>${pick.season} Round ${pick.round}</h2>
      <div class="modal-subtitle">Draft Pick</div>
    </div>
    <div class="modal-tab-content">
      <div class="player-bio">
        ${statusHTML}
        <div class="player-bio-row"><span class="player-bio-label">Original Team</span><span>${
          pick.originalTeam ? teamCellHTML(pick.originalTeam) : "—"
        }</span></div>
      </div>
      <div class="roster-group-title" style="margin-top: 16px;">Trade History</div>
      ${renderTradeHopsHTML(pick.tradeHistory, "Never traded — held by its original team since the draft order was set.")}
    </div>
  `;

  box.querySelector("#player-modal-close").addEventListener("click", closePlayerModal);
  box.querySelector(".pick-goto-draft")?.addEventListener("click", (e) => {
    goToDraftPick(e.target.dataset.season, e.target.dataset.pickNo);
  });
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

document.addEventListener(
  "click",
  (e) => {
    const link = e.target.closest(".pick-link");
    if (!link) return;
    e.stopPropagation();
    openPickModal(link.dataset.pickId);
  },
  true
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePlayerModal();
});
