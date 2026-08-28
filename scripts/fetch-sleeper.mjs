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

// Manual corrections for attribution Sleeper's API can't tell us: a roster
// that changed managers *mid-season*. Sleeper's roster snapshot (and even a
// transaction's own creator/picked_by field) reflects only the *current*
// owner, so a handoff shows the new manager for everything the old one
// actually did before it. `before` is an exclusive cutoff (ISO timestamp)
// — anything dated strictly earlier gets attributed to `team` instead of
// the real current owner; at/after the cutoff, the real owner shows as
// normal. Applies everywhere a roster's owner gets resolved for display
// (draft board, draft-pick trade history, the transaction log, and the
// player-profile "current team" — that last one intentionally uses today's
// real owner, not this override, since it asks who owns the player *now*).
const ROSTER_OWNER_OVERRIDES = [
  {
    season: "2026",
    rosterId: 12,
    before: "2026-08-22T18:56:59.745Z", // the one trade Spotted Cow actually made
    team: {
      teamName: "Caleb Williams Sucks",
      displayName: "dannyhatty06",
      avatar: "https://sleepercdn.com/avatars/thumbs/e7af4deab0289b4f5505646424895246",
      ownerId: "1129464212063006720",
    },
  },
];

// Returns the override team for (season, rosterId) if one applies at this
// date, else null (caller falls back to the real current owner).
function findOwnerOverride(season, rosterId, dateISO) {
  const o = ROSTER_OWNER_OVERRIDES.find(
    (o) =>
      o.season === season &&
      o.rosterId === rosterId &&
      (!dateISO || new Date(dateISO) < new Date(o.before))
  );
  return o ? { ...o.team, rosterId } : null;
}

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
  console.log("Fetching NFL player data (one-time, for transaction names + player profiles)...");
  const players = await fetchJSON(`${API}/players/nfl`);
  const map = new Map();
  for (const [pid, p] of Object.entries(players)) {
    map.set(pid, {
      name: p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Unknown",
      position: p.position ?? null,
      team: p.team ?? null,
      birthDate: p.birth_date ?? null,
    });
  }
  return map;
}

// A curated subset of box-score stat categories — enough for a useful game
// log without storing all 60+ fields Sleeper tracks per player per game.
const GAME_LOG_STAT_KEYS = [
  "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int",
  "rush_att", "rush_yd", "rush_td",
  "rec", "rec_tgt", "rec_yd", "rec_td",
  "fum_lost",
];

async function fetchWeeklyStats(season, week) {
  try {
    return await fetchJSON(`${API}/stats/nfl/regular/${season}/${week}`);
  } catch {
    return null;
  }
}

// Sleeper doesn't expose per-league-scored projections directly — only
// generic std/half-PPR/PPR totals, which don't reflect this league's actual
// settings (TE premium, 6pt passing TDs, IDP, etc). It does expose the same
// raw per-category projected stats (pass_yd, rec, idp_sack, ...) that real
// box scores use, though, so score them ourselves with this league's own
// scoring_settings — the same dot-product Sleeper's own engine effectively
// runs for actual games, just applied to projected stats instead.
async function fetchWeeklyProjections(season, week) {
  try {
    return await fetchJSON(`${API}/projections/nfl/regular/${season}/${week}`);
  } catch {
    return null;
  }
}

function computeLeagueScoredPoints(rawStats, scoringSettings) {
  if (!rawStats || !scoringSettings) return 0;
  let total = 0;
  for (const [key, weight] of Object.entries(scoringSettings)) {
    const value = rawStats[key];
    if (value) total += value * weight;
  }
  return total;
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

// The raw bracket data for the Matchups page's "Playoffs" view: the
// 8-team playoff bracket (winners_bracket — despite the name, it tracks
// every playoff team through 3 rounds of re-seeding, not just who's still
// alive) and the 4-team consolation bracket among the teams that missed
// the playoffs (losers_bracket), whose winner earns the bonus 3.13 rookie
// pick. Both are Sleeper-native brackets, not something we compute.
async function fetchPlayoffBrackets(leagueId) {
  const [winners, losers] = await Promise.all([
    fetchJSON(`${API}/league/${leagueId}/winners_bracket`).catch(() => []),
    fetchJSON(`${API}/league/${leagueId}/losers_bracket`).catch(() => []),
  ]);
  return {
    winners: winners.filter((m) => m.t1 != null || m.t2 != null),
    losers: losers.filter((m) => m.t1 != null || m.t2 != null),
  };
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
        // FAAB bid paid on a waiver claim — only meaningful for type
        // "waiver" (this league's waivers run on FAAB, not priority order).
        waiverBid: t.settings?.waiver_bid ?? null,
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
  // before it). Primarily keyed by owner_id (draft_order) since roster_id
  // isn't guaranteed stable across a different season's league object in
  // general — but draft_order can silently drop an entry for a roster
  // whose owner changed hands *after* the draft ran (Sleeper reflects only
  // the current owner, and if that owner was never on this draft's roster,
  // there's simply no key for them at all). slot_to_roster_id doesn't have
  // that problem — it's keyed by this draft's own roster_id, which for a
  // roster we already know about (from this season's own roster list) is
  // reliable — so it's a fallback for exactly that edge case. No entry for
  // the most recent season, since next season's draft hasn't happened yet,
  // or for an inaugural season's predecessor, since it never existed.
  let draftPickByOwner = {};
  let draftPickByRosterId = {};
  if (nextLeague?.draft_id) {
    try {
      const draft = await fetchJSON(`${API}/draft/${nextLeague.draft_id}`);
      draftPickByOwner = draft.draft_order || {};
      for (const [slot, rosterId] of Object.entries(draft.slot_to_roster_id || {})) {
        draftPickByRosterId[rosterId] = Number(slot);
      }
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
      const draftedAt = draftDetail.last_picked
        ? new Date(draftDetail.last_picked).toISOString()
        : draftDetail.start_time
        ? new Date(draftDetail.start_time).toISOString()
        : null;
      draftBoard = {
        rounds: draftMeta.settings?.rounds ?? null,
        draftedAt,
        picks: picks
          .map((p) => {
            const override = findOwnerOverride(season, p.roster_id, draftedAt);
            return {
              round: p.round,
              pickNo: p.pick_no,
              rosterId: p.roster_id,
              // whichever roster's original draft slot this pick position
              // belongs to — differs from rosterId (who actually drafted)
              // if the pick was traded at any point before the draft.
              originalRosterId: slotToRosterId[p.draft_slot] ?? p.roster_id,
              playerId: p.player_id ?? null,
              playerName: p.metadata
                ? `${p.metadata.first_name} ${p.metadata.last_name}`.trim()
                : "Unknown",
              position: p.metadata?.position ?? null,
              nflTeam: p.metadata?.team || null,
              teamOverride: override,
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
      draftPick: (r.owner_id ? draftPickByOwner[r.owner_id] : null) ?? draftPickByRosterId[r.roster_id] ?? null,
    };
  });

  // Every player ever on a roster this season (not just current starters),
  // for the player-profile feature (whose transaction/points history is
  // relevant, and for the most recent season, who's a free agent) and for
  // the Teams page's roster popup (grouped by starters/bench/taxi/IR).
  const rosterPlayers = {};
  for (const r of rosters) {
    rosterPlayers[r.roster_id] = {
      players: r.players || [],
      starters: r.starters || [],
      taxi: r.taxi || [],
      reserve: r.reserve || [],
    };
  }

  const matchupsByWeek = {};
  const weeklyPlayerPoints = {}; // week -> { player_id: points }, this league's exact scoring
  for (let week = 1; week <= MAX_WEEKS; week++) {
    let raw;
    try {
      raw = await fetchJSON(`${API}/league/${leagueId}/matchups/${week}`);
    } catch {
      continue;
    }
    if (!raw || raw.length === 0) continue;

    const projections = await fetchWeeklyProjections(season, week);
    const projTotalFor = (entry) => {
      if (!projections) return null;
      const starters = (entry.starters || []).filter((pid) => pid && pid !== "0");
      return starters.reduce(
        (sum, pid) => sum + computeLeagueScoredPoints(projections[pid], league.scoring_settings),
        0
      );
    };

    const byMatchupId = new Map();
    const pointsThisWeek = {};
    for (const entry of raw) {
      if (entry.matchup_id == null) continue;
      if (!byMatchupId.has(entry.matchup_id)) byMatchupId.set(entry.matchup_id, []);
      byMatchupId.get(entry.matchup_id).push(entry);
      Object.assign(pointsThisWeek, entry.players_points || {});
    }
    weeklyPlayerPoints[week] = pointsThisWeek;

    const rosterSlice = (entry) => {
      const players = entry.players || [];
      const projByPlayer = {};
      if (projections) {
        for (const pid of players) {
          projByPlayer[pid] = computeLeagueScoredPoints(projections[pid], league.scoring_settings);
        }
      }
      return {
        starters: (entry.starters || []).filter((pid) => pid && pid !== "0"),
        players,
        projByPlayer,
      };
    };

    matchupsByWeek[week] = [...byMatchupId.values()].map(([a, b]) => ({
      matchupId: a.matchup_id,
      teamA: { rosterId: a.roster_id, points: a.points ?? 0, projPoints: projTotalFor(a), ...rosterSlice(a) },
      teamB: b ? { rosterId: b.roster_id, points: b.points ?? 0, projPoints: projTotalFor(b), ...rosterSlice(b) } : null,
    }));
  }

  const { champion, lastPlace } = await findChampionAndLastPlace(leagueId, league);
  const rawTransactions = await fetchLeagueTransactions(leagueId, season);
  const playoffBracket = await fetchPlayoffBrackets(leagueId);

  return {
    season,
    leagueId,
    leagueName: league.name,
    status: league.status,
    teams,
    matchups: matchupsByWeek,
    champion,
    lastPlace,
    playoffBracket,
    draft: draftBoard,
    rawTransactions,
    rosterPlayers,
    weeklyPlayerPoints,
    rosterPositions: league.roster_positions,
    scoringSettings: league.scoring_settings,
    leagueSettings: {
      numTeams: league.settings?.num_teams,
      taxiSlots: league.settings?.taxi_slots,
      taxiYears: league.settings?.taxi_years,
      reserveSlots: league.settings?.reserve_slots,
      playoffTeams: league.settings?.playoff_teams,
      playoffWeekStart: league.settings?.playoff_week_start,
      playoffRoundType: league.settings?.playoff_round_type,
      tradeDeadline: league.settings?.trade_deadline,
      waiverType: league.settings?.waiver_type,
      waiverBudget: league.settings?.waiver_budget,
      pickTrading: league.settings?.pick_trading,
      bestBall: league.settings?.best_ball,
    },
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
  const teamRef = (season, rosterId, dateISO) => {
    const override = dateISO ? findOwnerOverride(season, rosterId, dateISO) : null;
    if (override) return override;
    const t = teamsBySeasonRoster.get(season)?.get(rosterId);
    return t
      ? { teamName: t.teamName, avatar: t.avatar, ownerId: t.ownerId, rosterId }
      : { teamName: "Unknown", avatar: null, ownerId: null, rosterId };
  };
  const playerRef = (playerId) => {
    const p = playerNames.get(playerId);
    return { playerId, name: p?.name ?? "Unknown Player", position: p?.position ?? null };
  };

  // Once a season's draft has actually happened, a traded pick "resolves"
  // into a real player — look those up by (season, original slot owner,
  // round), the same identity used for pick.tradeHistory, so a traded pick
  // can show what it turned into instead of just "2026 Rd 2 pick".
  const pickResultLookup = new Map();
  for (const s of seasonDatas) {
    if (!s.draft || !s.draft.picks.length) continue;
    const teamsPerRound = Math.round(s.draft.picks.length / s.draft.rounds);
    const byKey = new Map();
    for (const p of s.draft.picks) {
      byKey.set(`${p.originalRosterId}-${p.round}`, {
        pickInRound: ((p.pickNo - 1) % teamsPerRound) + 1,
        playerId: p.playerId,
        playerName: p.playerName,
        position: p.position,
      });
    }
    pickResultLookup.set(s.season, byKey);
  }

  // For an undrafted pick, name the team whose original slot it is — using
  // that season's own roster data when we have it, or falling back to the
  // most recent season's (roster_id identity is stable across the chain)
  // for picks tied to a future season we don't have any data for yet.
  const latestSeason = seasonDatas[seasonDatas.length - 1]?.season;
  const originalTeamName = (dp) => {
    const season = teamsBySeasonRoster.has(dp.season) ? dp.season : latestSeason;
    return teamRef(season, dp.rosterId).teamName;
  };

  // What each team walked away with in a trade — grouped by receiving
  // roster, so a trade renders as "Team A received: X, Y / Team B
  // received: 1, 2" instead of a flat, hard-to-parse add/drop list.
  const resolveTradeSides = (t) => {
    const tradeDate = new Date(t.created).toISOString();
    const sides = new Map();
    const sideFor = (rosterId) => {
      if (!sides.has(rosterId)) {
        sides.set(rosterId, { team: teamRef(t.season, rosterId, tradeDate), players: [], picks: [], faab: [] });
      }
      return sides.get(rosterId);
    };
    for (const rosterId of t.rosterIds) sideFor(rosterId);
    for (const [playerId, toRosterId] of Object.entries(t.adds)) {
      sideFor(toRosterId).players.push(playerRef(playerId));
    }
    for (const dp of t.draftPicks) {
      const result = pickResultLookup.get(dp.season)?.get(`${dp.rosterId}-${dp.round}`) ?? null;
      sideFor(dp.toRosterId).picks.push({
        season: dp.season,
        round: dp.round,
        originalRosterId: dp.rosterId,
        result,
        originalTeam: result ? null : originalTeamName(dp),
      });
    }
    for (const w of t.waiverBudget) {
      sideFor(w.toRosterId).faab.push(w.amount);
    }
    return [...sides.values()];
  };

  const allTrades = seasonDatas.flatMap((s) => s.rawTransactions.filter((t) => t.type === "trade"));

  // Every trade that's ever moved this exact pick (season/round/whichever
  // roster's original slot it is), oldest first. The one identity used
  // everywhere a pick needs tracing: draft-board history, the Teams page's
  // "picks held", and the pick-info popup.
  const getHops = (season, round, originalRosterId) =>
    allTrades
      .flatMap((t) =>
        t.draftPicks
          .filter((dp) => dp.season === season && dp.round === round && dp.rosterId === originalRosterId)
          .map((dp) => ({ t, dp }))
      )
      .sort((a, b) => a.t.created - b.t.created);

  const hopsToHistory = (season, hops) => {
    // A pick tied to a future season has no roster data under that season
    // key yet (the draft hasn't happened) — fall back to the latest known
    // season for team lookups, same as originalTeamName does.
    const lookupSeason = teamsBySeasonRoster.has(season) ? season : latestSeason;
    // getHops is oldest-first (other callers rely on that for "which hop
    // is the current holder"), but displayed history reads most-recent-first.
    return [...hops].reverse().map(({ t, dp }) => {
      const tradeDate = new Date(t.created).toISOString();
      return {
        date: tradeDate,
        from: teamRef(lookupSeason, dp.fromRosterId, tradeDate),
        to: teamRef(lookupSeason, dp.toRosterId, tradeDate),
        sides: resolveTradeSides(t),
      };
    });
  };

  for (const s of seasonDatas) {
    if (!s.draft) continue;
    for (const pick of s.draft.picks) {
      pick.tradeHistory = hopsToHistory(s.season, getHops(s.season, pick.round, pick.originalRosterId));
    }
  }

  // Future draft picks each current team holds, accounting for trades — for
  // the Teams page and the pick registry below. Every team always has
  // exactly 3 years of future picks on the board (Sleeper's own convention);
  // that window rolls forward each season regardless of whether any trade
  // happens to reference a given future year. Assumes future drafts keep
  // the same round count as the most recent one, since that's the only
  // signal we have.
  const latestTeamsList = seasonDatas[seasonDatas.length - 1].teams;
  const assumedRounds = seasonDatas[seasonDatas.length - 1]?.draft?.rounds ?? 4;
  const latestYear = parseInt(latestSeason, 10);
  const futureSeasons = [1, 2, 3].map((n) => String(latestYear + n));

  const picksHeldByRoster = {};
  for (const team of latestTeamsList) picksHeldByRoster[team.rosterId] = [];

  // Every future (season, round, original owner) combo — the full set of
  // picks that exist but haven't been drafted yet, for the registry.
  const futurePickIdentities = [];

  for (const futureSeason of futureSeasons) {
    for (let round = 1; round <= assumedRounds; round++) {
      for (const team of latestTeamsList) {
        const originalRosterId = team.rosterId;
        futurePickIdentities.push({ season: futureSeason, round, originalRosterId });
        const hops = getHops(futureSeason, round, originalRosterId);
        const finalHolder = hops.length ? hops[hops.length - 1].dp.toRosterId : originalRosterId;
        if (!picksHeldByRoster[finalHolder]) continue;
        picksHeldByRoster[finalHolder].push({
          season: futureSeason,
          round,
          originalRosterId,
          originalTeam: finalHolder !== originalRosterId ? teamRef(latestSeason, originalRosterId) : null,
        });
      }
    }
  }
  for (const list of Object.values(picksHeldByRoster)) {
    list.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
  }

  // One registry covering every pick that's ever existed — drafted or not
  // — for the pick-info popup. Real picks reuse what's already computed
  // above (draft.picks); future ones get the same treatment freshly.
  const pickRegistry = {};
  for (const s of seasonDatas) {
    if (!s.draft) continue;
    for (const pick of s.draft.picks) {
      const id = `${pick.season}-${pick.round}-${pick.originalRosterId}`;
      const teamsPerRound = Math.round(s.draft.picks.length / s.draft.rounds);
      pickRegistry[id] = {
        season: pick.season,
        round: pick.round,
        originalTeam: teamRef(pick.season, pick.originalRosterId),
        resolved: true,
        pickNo: pick.pickNo,
        pickInRound: ((pick.pickNo - 1) % teamsPerRound) + 1,
        playerId: pick.playerId,
        playerName: pick.playerName,
        position: pick.position,
        draftedByTeam: pick.teamOverride || teamRef(pick.season, pick.rosterId),
        tradeHistory: pick.tradeHistory,
      };
    }
  }
  for (const { season, round, originalRosterId } of futurePickIdentities) {
    const id = `${season}-${round}-${originalRosterId}`;
    const hops = getHops(season, round, originalRosterId);
    const finalHolder = hops.length ? hops[hops.length - 1].dp.toRosterId : originalRosterId;
    pickRegistry[id] = {
      season,
      round,
      originalTeam: teamRef(latestSeason, originalRosterId),
      resolved: false,
      currentHolderTeam: teamRef(latestSeason, finalHolder),
      tradeHistory: hopsToHistory(season, hops),
    };
  }

  // Every draft pick is its own transaction too — "how this player entered
  // the league" — so every player has at least one entry in their history,
  // even one never traded or dropped since. Not a real Sleeper transaction
  // (drafts aren't in the transactions endpoint at all), so synthesized
  // here in the same shape, reusing "adds" so it flows through existing
  // per-player filtering (adds/drops/sides) for free.
  const draftEntries = seasonDatas.flatMap((s) => {
    if (!s.draft || !s.draft.picks.length) return [];
    const teamsPerRound = Math.round(s.draft.picks.length / s.draft.rounds);
    return s.draft.picks.map((p) => {
      const pickInRound = ((p.pickNo - 1) % teamsPerRound) + 1;
      const team = p.teamOverride
        ? { teamName: p.teamOverride.teamName, avatar: p.teamOverride.avatar, ownerId: p.teamOverride.ownerId, rosterId: p.rosterId }
        : teamRef(s.season, p.rosterId);
      return {
        id: `draft-${s.season}-${p.pickNo}`,
        type: "draft",
        date: s.draft.draftedAt || `${s.season}-01-01T00:00:00.000Z`,
        season: s.season,
        round: p.round,
        originalRosterId: p.originalRosterId,
        teams: [team],
        sides: [],
        adds: [{ playerId: p.playerId, name: p.playerName, position: p.position, team }],
        drops: [],
        draftPicksTraded: [],
        faab: [],
        pickLabel: `${s.season} - ${p.round}.${String(pickInRound).padStart(2, "0")}`,
      };
    });
  });

  const realEntries = seasonDatas.flatMap((s) =>
    s.rawTransactions.map((t) => {
      const date = new Date(t.created).toISOString();
      return {
        id: t.id,
        type: t.type,
        date,
        season: t.season,
        teams: t.rosterIds.map((rid) => teamRef(t.season, rid, date)),
        sides: t.type === "trade" ? resolveTradeSides(t) : [],
        adds: Object.entries(t.adds).map(([playerId, rosterId]) => ({
          ...playerRef(playerId),
          team: teamRef(t.season, rosterId, date),
        })),
        drops: Object.entries(t.drops).map(([playerId, rosterId]) => ({
          ...playerRef(playerId),
          team: teamRef(t.season, rosterId, date),
        })),
        draftPicksTraded: t.draftPicks.map((dp) => ({
          season: dp.season,
          round: dp.round,
          originalRosterId: dp.rosterId,
          from: teamRef(t.season, dp.fromRosterId, date),
          to: teamRef(t.season, dp.toRosterId, date),
        })),
        faab: t.waiverBudget.map((w) => ({
          amount: w.amount,
          from: teamRef(t.season, w.fromRosterId, date),
          to: teamRef(t.season, w.toRosterId, date),
        })),
      };
    })
  );

  const log = [...draftEntries, ...realEntries].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Lifetime per-manager activity for the History page: trade count,
  // waiver-claim count, FAAB spent on those claims, net FAAB moved via
  // trades (received minus sent), and FAAB left on the table at the end of
  // each season (that season's starting budget, plus net FAAB traded,
  // minus FAAB spent — summed across every season). Keyed by owner id via
  // the same override-aware team identity used everywhere else, so a
  // mid-season handoff (e.g. Spotted Cow/dannyhatty06) attributes activity
  // to whoever actually made each move.
  const teamRecords = new Map();
  const recordFor = (team) => {
    if (!team?.ownerId) return null;
    if (!teamRecords.has(team.ownerId)) {
      teamRecords.set(team.ownerId, {
        ownerId: team.ownerId,
        teamName: team.teamName,
        avatar: team.avatar,
        trades: 0,
        waiverPickups: 0,
        faabSpent: 0,
        faabSpentCurrent: 0,
        faabTradedNet: 0,
        faabUnspent: 0,
        faabCurrent: 0,
      });
    }
    const r = teamRecords.get(team.ownerId);
    r.teamName = team.teamName; // keep the most recent team name/avatar
    r.avatar = team.avatar;
    return r;
  };

  for (const s of seasonDatas) {
    const isCurrentSeason = s === seasonDatas[seasonDatas.length - 1];
    const startingBudget = s.leagueSettings?.waiverBudget ?? 0;
    const perRosterBalance = new Map();
    const perRosterSpent = new Map();
    for (const team of s.teams) {
      perRosterBalance.set(team.rosterId, startingBudget);
      perRosterSpent.set(team.rosterId, 0);
    }

    for (const t of s.rawTransactions) {
      const date = new Date(t.created).toISOString();
      if (t.type === "trade") {
        const seenOwners = new Set();
        for (const rosterId of t.rosterIds) {
          const r = recordFor(teamRef(s.season, rosterId, date));
          if (r && !seenOwners.has(r.ownerId)) {
            r.trades += 1;
            seenOwners.add(r.ownerId);
          }
        }
        for (const w of t.waiverBudget) {
          const fromR = recordFor(teamRef(s.season, w.fromRosterId, date));
          const toR = recordFor(teamRef(s.season, w.toRosterId, date));
          if (fromR) fromR.faabTradedNet -= w.amount;
          if (toR) toR.faabTradedNet += w.amount;
          if (perRosterBalance.has(w.fromRosterId)) {
            perRosterBalance.set(w.fromRosterId, perRosterBalance.get(w.fromRosterId) - w.amount);
          }
          if (perRosterBalance.has(w.toRosterId)) {
            perRosterBalance.set(w.toRosterId, perRosterBalance.get(w.toRosterId) + w.amount);
          }
        }
      } else if (t.type === "waiver") {
        const rosterId = t.rosterIds[0];
        const r = recordFor(teamRef(s.season, rosterId, date));
        if (r) r.waiverPickups += 1;
        const bid = t.waiverBid || 0;
        if (bid) {
          if (r) r.faabSpent += bid;
          if (perRosterBalance.has(rosterId)) {
            perRosterBalance.set(rosterId, perRosterBalance.get(rosterId) - bid);
          }
          if (perRosterSpent.has(rosterId)) {
            perRosterSpent.set(rosterId, perRosterSpent.get(rosterId) + bid);
          }
        }
      }
    }

    for (const team of s.teams) {
      const r = recordFor(team);
      if (!r) continue;
      r.faabUnspent += perRosterBalance.get(team.rosterId) ?? 0;
      if (isCurrentSeason) {
        r.faabCurrent = perRosterBalance.get(team.rosterId) ?? 0;
        r.faabSpentCurrent = perRosterSpent.get(team.rosterId) ?? 0;
      }
    }
  }

  return { log, picksHeldByRoster, pickRegistry, teamRecords: [...teamRecords.values()] };
}

// Builds a profile for every player who's ever appeared on a roster in this
// league: bio, current team (or free agent), season-by-season stat lines
// (points via this league's own scoring, from matchup players_points
// already fetched; games played + box score via Sleeper's stats endpoint,
// real NFL games independent of fantasy rostering), and positional/overall
// rank each season among only the players relevant to this league.
async function buildPlayerProfiles(seasonDatas, playerNames) {
  const teamsBySeasonRoster = new Map();
  for (const s of seasonDatas) {
    teamsBySeasonRoster.set(s.season, new Map(s.teams.map((t) => [t.rosterId, t])));
  }
  const teamRef = (season, rosterId) => {
    const t = teamsBySeasonRoster.get(season)?.get(rosterId);
    return t ? { teamName: t.teamName, avatar: t.avatar, ownerId: t.ownerId, rosterId } : null;
  };

  const relevantPlayerIds = new Set();
  for (const s of seasonDatas) {
    for (const roster of Object.values(s.rosterPlayers)) {
      for (const pid of roster.players) relevantPlayerIds.add(pid);
    }
  }

  const profiles = new Map();
  for (const playerId of relevantPlayerIds) {
    const info = playerNames.get(playerId);
    profiles.set(playerId, {
      playerId,
      name: info?.name ?? "Unknown Player",
      position: info?.position ?? null,
      nflTeam: info?.team ?? null,
      birthDate: info?.birthDate ?? null,
      currentTeam: null,
      seasons: {},
    });
  }

  // current dynasty team (or free agent) — most recent season's rosters
  const latest = seasonDatas[seasonDatas.length - 1];
  const ownerOfPlayer = new Map();
  for (const [rosterId, roster] of Object.entries(latest.rosterPlayers)) {
    for (const pid of roster.players) ownerOfPlayer.set(pid, Number(rosterId));
  }
  for (const [playerId, profile] of profiles) {
    const rosterId = ownerOfPlayer.get(playerId);
    profile.currentTeam = rosterId != null ? teamRef(latest.season, rosterId) : null;
  }

  // season point totals — only for players who actually appeared that season
  for (const s of seasonDatas) {
    const totals = new Map();
    for (const weekPoints of Object.values(s.weeklyPlayerPoints)) {
      for (const [pid, pts] of Object.entries(weekPoints)) {
        if (!relevantPlayerIds.has(pid)) continue;
        totals.set(pid, (totals.get(pid) ?? 0) + (pts ?? 0));
      }
    }
    for (const [pid, totalPoints] of totals) {
      profiles.get(pid).seasons[s.season] = {
        totalPoints,
        gamesPlayed: 0,
        positionRank: null,
        overallRank: null,
        games: [],
      };
    }
  }

  console.log("Fetching weekly game stats for player profiles...");
  for (const s of seasonDatas) {
    const weeks = Object.keys(s.weeklyPlayerPoints).map(Number).sort((a, b) => a - b);
    for (const week of weeks) {
      const stats = await fetchWeeklyStats(s.season, week);
      if (!stats) continue;
      const pointsThisWeek = s.weeklyPlayerPoints[week] || {};
      for (const pid of Object.keys(pointsThisWeek)) {
        if (!relevantPlayerIds.has(pid)) continue;
        const seasonEntry = profiles.get(pid)?.seasons[s.season];
        if (!seasonEntry) continue;
        const stat = stats[pid];
        const gp = stat?.gp ?? 0;
        if (gp) seasonEntry.gamesPlayed += gp;
        seasonEntry.games.push({
          week,
          points: pointsThisWeek[pid] ?? 0,
          played: !!gp,
          stats: stat
            ? Object.fromEntries(
                GAME_LOG_STAT_KEYS.filter((k) => stat[k] != null).map((k) => [k, stat[k]])
              )
            : {},
        });
      }
    }
  }

  // rank within position and overall, per season, among relevant players
  for (const s of seasonDatas) {
    const entries = [...profiles.values()]
      .map((p) => ({ p, season: p.seasons[s.season] }))
      .filter((e) => e.season);

    const overall = [...entries].sort((a, b) => b.season.totalPoints - a.season.totalPoints);
    overall.forEach((e, i) => (e.season.overallRank = i + 1));

    const byPosition = new Map();
    for (const e of entries) {
      const pos = e.p.position || "UNK";
      if (!byPosition.has(pos)) byPosition.set(pos, []);
      byPosition.get(pos).push(e);
    }
    for (const group of byPosition.values()) {
      group.sort((a, b) => b.season.totalPoints - a.season.totalPoints);
      group.forEach((e, i) => (e.season.positionRank = i + 1));
    }
  }

  return Object.fromEntries(profiles);
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
  const { log: transactionLog, picksHeldByRoster, pickRegistry, teamRecords } = attachTradeHistoryAndBuildLog(seasonDatas, playerNames);
  await fs.writeFile("data/transactions.json", JSON.stringify(transactionLog, null, 2));
  await fs.writeFile("data/future-picks.json", JSON.stringify(picksHeldByRoster, null, 2));
  await fs.writeFile("data/pick-registry.json", JSON.stringify(pickRegistry, null, 2));
  await fs.writeFile("data/team-records.json", JSON.stringify(teamRecords, null, 2));

  const playerProfiles = await buildPlayerProfiles(seasonDatas, playerNames);
  await fs.writeFile("data/players.json", JSON.stringify(playerProfiles, null, 2));

  const seasons = [];
  for (const s of seasonDatas) {
    // internal-only, not needed by the site
    delete s.rawTransactions;
    delete s.weeklyPlayerPoints;
    // rosterPlayers is kept — the Teams page's roster popup needs it
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
