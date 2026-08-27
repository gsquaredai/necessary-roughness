// Pulls league history from Sleeper's public API and writes it to /data as JSON
// that the static site reads directly. Re-run any time (manually or via the
// GitHub Action) to refresh current-season standings/matchups.
//
// NOTE: bump CURRENT_LEAGUE_ID each new season to that season's Sleeper
// league_id — Sleeper links each season back to the previous one via
// previous_league_id, so older seasons are discovered automatically.

const CURRENT_LEAGUE_ID = "1312043132170301440";
const MAX_WEEKS = 18;
const API = "https://api.sleeper.app/v1";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function buildSeasonChain(startId) {
  const chain = [];
  let id = startId;
  while (id && id !== "0") {
    const league = await fetchJSON(`${API}/league/${id}`);
    chain.push(league);
    id = league.previous_league_id;
  }
  return chain.reverse(); // oldest season first
}

async function findChampionAndLastPlace(leagueId, league) {
  let champion = league.metadata?.latest_league_winner_roster_id
    ? Number(league.metadata.latest_league_winner_roster_id)
    : null;
  let lastPlace = null;

  try {
    const winners = await fetchJSON(`${API}/league/${leagueId}/winners_bracket`);
    const final = winners.find((m) => m.p === 1 && m.w != null);
    if (final) champion = final.w;
  } catch {
    // bracket not available (e.g. season still in regular season) — fall back to metadata field
  }

  try {
    const losers = await fetchJSON(`${API}/league/${leagueId}/losers_bracket`);
    const final = losers.find((m) => m.p === 1 && m.w != null && m.l != null);
    if (final) lastPlace = final.l; // the loser of the "last place" match finishes last
  } catch {
    // no losers bracket configured
  }

  return { champion, lastPlace };
}

async function buildSeason(league) {
  const leagueId = league.league_id;
  const season = league.season;

  const [users, rosters] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}/users`),
    fetchJSON(`${API}/league/${leagueId}/rosters`),
  ]);

  const usersByOwnerId = Object.fromEntries(users.map((u) => [u.user_id, u]));

  // Sleeper gives each manager two images: an account profile picture (avatar,
  // an id you resolve against the CDN) and, if they've set one, a per-league
  // team logo (metadata.avatar, already a full URL). Prefer the team logo.
  const resolveAvatar = (user) => {
    if (user?.metadata?.avatar) return user.metadata.avatar;
    if (user?.avatar) return `https://sleepercdn.com/avatars/thumbs/${user.avatar}`;
    return null;
  };

  // Team names come straight from Sleeper and often carry emoji or "fancy
  // font" styling (from unicode-text-generator sites — mathematical
  // alphanumeric symbols, not real font styling). Neither survives the
  // pixel font, so normalize both away here at the source. NFKD's
  // compatibility decomposition maps styled-letter unicode back to plain
  // ASCII (e.g. "𝓑𝓵𝓪𝓬𝓴 𝓞𝓹𝓼" -> "Black Ops").
  const cleanTeamName = (str) =>
    str
      .normalize("NFKD")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "") // regional indicators (flag emoji)
      .replace(/[‍️]/gu, "") // zero-width joiner / variation selector
      .replace(/\s+/g, " ")
      .trim();

  const teams = rosters.map((r) => {
    const user = usersByOwnerId[r.owner_id];
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id ?? null,
      teamName: cleanTeamName(
        user?.metadata?.team_name || user?.display_name || `Team ${r.roster_id}`
      ),
      displayName: user?.display_name || "Unknown",
      avatar: resolveAvatar(user),
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      fpts: (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
      fptsAgainst:
        (r.settings?.fpts_against ?? 0) + (r.settings?.fpts_against_decimal ?? 0) / 100,
    };
  });

  const matchupsByWeek = {};
  for (let week = 1; week <= MAX_WEEKS; week++) {
    let raw;
    try {
      raw = await fetchJSON(`${API}/league/${leagueId}/matchups/${week}`);
    } catch {
      continue;
    }
    if (!raw || raw.length === 0) continue;

    const byMatchupId = new Map();
    for (const entry of raw) {
      if (entry.matchup_id == null) continue;
      if (!byMatchupId.has(entry.matchup_id)) byMatchupId.set(entry.matchup_id, []);
      byMatchupId.get(entry.matchup_id).push(entry);
    }

    matchupsByWeek[week] = [...byMatchupId.values()].map(([a, b]) => ({
      matchupId: a.matchup_id,
      teamA: { rosterId: a.roster_id, points: a.points ?? 0 },
      teamB: b ? { rosterId: b.roster_id, points: b.points ?? 0 } : null,
    }));
  }

  const maxByRoster = {};
  for (const week of Object.values(matchupsByWeek)) {
    for (const m of week) {
      for (const side of [m.teamA, m.teamB]) {
        if (!side) continue;
        if (side.points > (maxByRoster[side.rosterId] ?? 0)) {
          maxByRoster[side.rosterId] = side.points;
        }
      }
    }
  }
  for (const team of teams) {
    team.maxPF = maxByRoster[team.rosterId] ?? 0;
  }

  const { champion, lastPlace } = await findChampionAndLastPlace(leagueId, league);

  return {
    season,
    leagueId,
    leagueName: league.name,
    status: league.status,
    teams,
    matchups: matchupsByWeek,
    champion,
    lastPlace,
  };
}

async function main() {
  console.log("Walking season chain from", CURRENT_LEAGUE_ID);
  const leagueChain = await buildSeasonChain(CURRENT_LEAGUE_ID);
  console.log(
    "Seasons found:",
    leagueChain.map((l) => l.season).join(", ")
  );

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });

  const seasons = [];
  for (const league of leagueChain) {
    console.log(`Fetching season ${league.season}...`);
    const seasonData = await buildSeason(league);
    await fs.writeFile(
      `data/${league.season}.json`,
      JSON.stringify(seasonData, null, 2)
    );
    seasons.push(league.season);
  }

  const currentSeason = leagueChain[leagueChain.length - 1];
  await fs.writeFile(
    "data/index.json",
    JSON.stringify(
      {
        leagueName: currentSeason.name,
        seasons,
        currentSeason: currentSeason.season,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
