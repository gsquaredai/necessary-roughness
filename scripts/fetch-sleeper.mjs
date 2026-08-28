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

// Manual corrections for draft-pick attribution Sleeper's API can't tell us:
// a roster that changed managers *mid-season*, after that season's draft
// already happened. Sleeper's roster snapshot (and even the pick's own
// picked_by field) reflects only the *current* owner, so a handoff that
// happened after the draft but before we fetch shows the new manager for
// picks the old one actually made. Standings/matchups for that season are
// unaffected — those correctly track the manager mid-season, this only
// overrides who the draft board credits.
const DRAFT_PICK_OWNER_OVERRIDES = [
  {
    season: "2026",
    rosterId: 12,
    team: {
      teamName: "Caleb Williams Sucks",
      displayName: "dannyhatty06",
      avatar: "https://sleepercdn.com/avatars/thumbs/e7af4deab0289b4f5505646424895246",
      ownerId: "1129464212063006720",
    },
  },
];

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

// Fetched once (not per-season) since it's the same reference table
// regardless of league/season — reduced immediately to just name/position
// so it doesn't stick around in memory as the full ~14MB payload.
async function fetchPlayerNames() {
  console.log("Fetching NFL player data (one-time, for transaction player names)...");
  const players = await fetchJSON(`${API}/players/nfl`);
  const map = new Map();
  for (const [pid, p] of Object.entries(players)) {
    map.set(pid, {
      name: p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Unknown",
      position: p.position ?? null,
    });
  }
  return map;
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

// All transactions (trades, waiver claims, free agent moves) for a league,
// across every week. Sleeper buckets everything before week 1 into leg 1
// along with actual week-1 activity, so there's no separate "preseason"
// call needed — looping legs 1..MAX_WEEKS catches everything.
async function fetchLeagueTransactions(leagueId, season) {
  const all = [];
  for (let leg = 1; leg <= MAX_WEEKS; leg++) {
    let txns;
    try {
      txns = await fetchJSON(`${API}/league/${leagueId}/transactions/${leg}`);
    } catch {
      continue;
    }
    for (const t of txns) {
      if (t.status !== "complete") continue;
      all.push({
        id: t.transaction_id,
        type: t.type,
        created: t.created,
        season,
        rosterIds: t.roster_ids || [],
        adds: t.adds || {},
        drops: t.drops || {},
        draftPicks: (t.draft_picks || []).map((dp) => ({
          season: dp.season,
          round: dp.round,
          rosterId: dp.roster_id,
          fromRosterId: dp.previous_owner_id,
          toRosterId: dp.owner_id,
        })),
        waiverBudget: (t.waiver_budget || []).map((w) => ({
          amount: w.amount,
          fromRosterId: w.sender,
          toRosterId: w.receiver,
        })),
      });
    }
  }
  return all;
}

async function buildSeason(league, nextLeague) {
  const leagueId = league.league_id;
  const season = league.season;

  const [users, rosters] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}/users`),
    fetchJSON(`${API}/league/${leagueId}/rosters`),
  ]);

  const usersByOwnerId = Object.fromEntries(users.map((u) => [u.user_id, u]));

  // The rookie draft order that resulted from THIS season's standings is the
  // draft that ran going into the *next* season, not this league's own
  // draft_id (that one ran going into this season, based on the season
  // before it). Keyed by owner_id (draft_order, unlike slot_to_roster_id,
  // maps directly to user_id, which — unlike roster_id — stays consistent
  // across a different season's league object). No entry for the most
  // recent season, since next season's draft hasn't happened yet, or for
  // an inaugural season's predecessor, since it never existed.
  let draftPickByOwner = {};
  if (nextLeague?.draft_id) {
    try {
      const draft = await fetchJSON(`${API}/draft/${nextLeague.draft_id}`);
      draftPickByOwner = draft.draft_order || {};
    } catch {
      // no draft data available for next season
    }
  }

  // The actual draft board for THIS season — the one that ran before it
  // started, setting up that season's rosters (round-by-round, who took
  // whom). Usually just league.draft_id, but a league can have more than
  // one draft object on record (e.g. 2024 has both the real 25-round
  // startup snake draft and an unused, empty 4-round "dud" draft) — so
  // pull every draft for the league and use whichever one actually has
  // picks, preferring a snake draft / more rounds if more than one does.
  let draftBoard = null;
  try {
    const leagueDrafts = await fetchJSON(`${API}/league/${leagueId}/drafts`);
    const ranked = [...(leagueDrafts || [])].sort((a, b) => {
      const snakeA = a.type === "snake" ? 1 : 0;
      const snakeB = b.type === "snake" ? 1 : 0;
      if (snakeA !== snakeB) return snakeB - snakeA;
      return (b.settings?.rounds ?? 0) - (a.settings?.rounds ?? 0);
    });
    for (const draftMeta of ranked) {
      const picks = await fetchJSON(`${API}/draft/${draftMeta.draft_id}/picks`).catch(() => []);
      if (!picks.length) continue;
      // the /drafts list endpoint's summary objects don't include
      // slot_to_roster_id — only the single-draft detail endpoint does.
      const draftDetail = await fetchJSON(`${API}/draft/${draftMeta.draft_id}`).catch(() => draftMeta);
      const slotToRosterId = draftDetail.slot_to_roster_id || {};
      draftBoard = {
        rounds: draftMeta.settings?.rounds ?? null,
        picks: picks
          .map((p) => {
            const override = DRAFT_PICK_OWNER_OVERRIDES.find(
              (o) => o.season === season && o.rosterId === p.roster_id
            );
            return {
              round: p.round,
              pickNo: p.pick_no,
              rosterId: p.roster_id,
              // whichever roster's original draft slot this pick position
              // belongs to — differs from rosterId (who actually drafted)
              // if the pick was traded at any point before the draft.
              originalRosterId: slotToRosterId[p.draft_slot] ?? p.roster_id,
              playerName: p.metadata
                ? `${p.metadata.first_name} ${p.metadata.last_name}`.trim()
                : "Unknown",
              position: p.metadata?.position ?? null,
              nflTeam: p.metadata?.team || null,
              teamOverride: override?.team ?? null,
            };
          })
          .sort((a, b) => a.pickNo - b.pickNo),
      };
      break;
    }
  } catch {
    // no draft data available for this season
  }

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
      // "Potential points" — what the team would have scored with an optimal
      // lineup every week. Sleeper computes this itself (same number their
      // own detailed standings view shows) and exposes it right on the
      // roster, so just use it directly rather than re-deriving it.
      maxPF: (r.settings?.ppts ?? 0) + (r.settings?.ppts_decimal ?? 0) / 100,
      draftPick: r.owner_id ? draftPickByOwner[r.owner_id] ?? null : null,
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

  const { champion, lastPlace } = await findChampionAndLastPlace(leagueId, league);
  const rawTransactions = await fetchLeagueTransactions(leagueId, season);

  return {
    season,
    leagueId,
    leagueName: league.name,
    status: league.status,
    teams,
    matchups: matchupsByWeek,
    champion,
    lastPlace,
    draft: draftBoard,
    rawTransactions,
  };
}

// Attaches each traded draft pick's ownership history (chain of trades that
// moved it from its original slot owner to whoever finally drafted with
// it), and produces the flat, human-readable transaction log for the
// Transactions page. Both need the same trade data across every season
// (a pick can be traded years before its draft happens), so this runs once
// after all seasons are built rather than per-season.
function attachTradeHistoryAndBuildLog(seasonDatas, playerNames) {
  const teamsBySeasonRoster = new Map();
  for (const s of seasonDatas) {
    const byRoster = new Map(s.teams.map((t) => [t.rosterId, t]));
    teamsBySeasonRoster.set(s.season, byRoster);
  }
  const teamRef = (season, rosterId) => {
    const t = teamsBySeasonRoster.get(season)?.get(rosterId);
    return t
      ? { teamName: t.teamName, avatar: t.avatar, ownerId: t.ownerId, rosterId }
      : { teamName: "Unknown", avatar: null, ownerId: null, rosterId };
  };
  const playerRef = (playerId) => {
    const p = playerNames.get(playerId);
    return { playerId, name: p?.name ?? "Unknown Player", position: p?.position ?? null };
  };

  // What each team walked away with in a trade — grouped by receiving
  // roster, so a trade renders as "Team A received: X, Y / Team B
  // received: 1, 2" instead of a flat, hard-to-parse add/drop list.
  const resolveTradeSides = (t) => {
    const sides = new Map();
    const sideFor = (rosterId) => {
      if (!sides.has(rosterId)) {
        sides.set(rosterId, { team: teamRef(t.season, rosterId), players: [], picks: [], faab: [] });
      }
      return sides.get(rosterId);
    };
    for (const rosterId of t.rosterIds) sideFor(rosterId);
    for (const [playerId, toRosterId] of Object.entries(t.adds)) {
      sideFor(toRosterId).players.push(playerRef(playerId));
    }
    for (const dp of t.draftPicks) {
      sideFor(dp.toRosterId).picks.push({ season: dp.season, round: dp.round });
    }
    for (const w of t.waiverBudget) {
      sideFor(w.toRosterId).faab.push(w.amount);
    }
    return [...sides.values()];
  };

  const allTrades = seasonDatas.flatMap((s) => s.rawTransactions.filter((t) => t.type === "trade"));

  for (const s of seasonDatas) {
    if (!s.draft) continue;
    for (const pick of s.draft.picks) {
      const hops = allTrades
        .flatMap((t) =>
          t.draftPicks
            .filter(
              (dp) => dp.season === pick.season /* set below */ &&
                dp.round === pick.round &&
                dp.rosterId === pick.originalRosterId
            )
            .map((dp) => ({ t, dp }))
        )
        .sort((a, b) => a.t.created - b.t.created);
      pick.tradeHistory = hops.map(({ t, dp }) => ({
        date: new Date(t.created).toISOString(),
        from: teamRef(s.season, dp.fromRosterId),
        to: teamRef(s.season, dp.toRosterId),
        sides: resolveTradeSides(t),
      }));
    }
  }

  const log = seasonDatas
    .flatMap((s) =>
      s.rawTransactions.map((t) => ({
        id: t.id,
        type: t.type,
        date: new Date(t.created).toISOString(),
        season: t.season,
        teams: t.rosterIds.map((rid) => teamRef(t.season, rid)),
        sides: t.type === "trade" ? resolveTradeSides(t) : [],
        adds: Object.entries(t.adds).map(([playerId, rosterId]) => ({
          ...playerRef(playerId),
          team: teamRef(t.season, rosterId),
        })),
        drops: Object.entries(t.drops).map(([playerId, rosterId]) => ({
          ...playerRef(playerId),
          team: teamRef(t.season, rosterId),
        })),
        draftPicksTraded: t.draftPicks.map((dp) => ({
          season: dp.season,
          round: dp.round,
          from: teamRef(t.season, dp.fromRosterId),
          to: teamRef(t.season, dp.toRosterId),
        })),
        faab: t.waiverBudget.map((w) => ({
          amount: w.amount,
          from: teamRef(t.season, w.fromRosterId),
          to: teamRef(t.season, w.toRosterId),
        })),
      }))
    )
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  return log;
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

  const playerNames = await fetchPlayerNames();

  const seasonDatas = [];
  for (let i = 0; i < leagueChain.length; i++) {
    const league = leagueChain[i];
    const nextLeague = leagueChain[i + 1];
    console.log(`Fetching season ${league.season}...`);
    const seasonData = await buildSeason(league, nextLeague);
    seasonDatas.push(seasonData);
  }

  // draft_picks entries reference the pick by its *target* season (the
  // season string on the pick itself, i.e. which draft it's for) — stamp
  // that onto each pick before cross-referencing trades against it.
  for (const s of seasonDatas) {
    if (!s.draft) continue;
    for (const pick of s.draft.picks) pick.season = s.season;
  }

  console.log("Cross-referencing trades against draft picks...");
  const transactionLog = attachTradeHistoryAndBuildLog(seasonDatas, playerNames);
  await fs.writeFile("data/transactions.json", JSON.stringify(transactionLog, null, 2));

  const seasons = [];
  for (const s of seasonDatas) {
    delete s.rawTransactions; // internal-only, not needed by the site
    await fs.writeFile(`data/${s.season}.json`, JSON.stringify(s, null, 2));
    seasons.push(s.season);
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
