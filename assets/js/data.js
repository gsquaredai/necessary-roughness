const seasonCache = new Map();
let indexCache = null;

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
