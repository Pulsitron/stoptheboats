export const runtime = "edge";

const MAX_GLOBAL_SCORES = 100;
// Only these literal SQL columns can be selected by a request. Never interpolate
// an unvalidated query parameter into an ORDER BY expression.
const METRICS = {
  score: "score",
  boatsStopped: "boats_stopped",
  bestChain: "best_chain",
  timeHeld: "time_held",
  headshots: "headshots",
} as const;
type Metric = keyof typeof METRICS;
const STAT_LIMITS = {
  boatsStopped: 1_000_000,
  bestChain: 1_000_000,
  timeHeld: 604_800,
  headshots: 10_000_000,
} as const;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

type LeaderboardRow = {
  player_id: string;
  callsign: string;
  score: number;
  wave: number;
  boats_stopped: number | null;
  best_chain: number | null;
  time_held: number | null;
  headshots: number | null;
  updated_at: number;
  score_rank: number | null;
  boats_stopped_rank?: number | null;
  best_chain_rank?: number | null;
  time_held_rank?: number | null;
  headshots_rank?: number | null;
};

async function getDatabase() {
  // Keep the Cloudflare-only module out of the Node-rendered page bundle.
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("no such table") || message.includes("leaderboard_scores")) {
    return "The leaderboard is being commissioned. Try again in a moment.";
  }
  return "The leaderboard is temporarily unavailable.";
}

function isCallsignConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: leaderboard_scores.callsign") ||
    message.includes("leaderboard_callsign_unique_idx");
}

function callsignTaken() {
  return json({ error: "That callsign is already taken. Choose another." }, 409);
}

function normalizeCallsign(value: unknown) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9 _-]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 16);
}

function validPlayerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function selectedMetric(value: unknown): Metric | null {
  if (value == null || value === "") return "score";
  return typeof value === "string" && Object.hasOwn(METRICS, value) ? value as Metric : null;
}

function publicRecord(row: LeaderboardRow) {
  return {
    callsign: row.callsign,
    score: row.score,
    wave: row.wave,
    boatsStopped: row.boats_stopped,
    bestChain: row.best_chain,
    timeHeld: row.time_held,
    headshots: row.headshots,
    scoreRank: row.score_rank,
    updatedAt: row.updated_at,
  };
}

function publicEntries(rows: LeaderboardRow[]) {
  return rows.map((row, index) => ({ rank: index + 1, ...publicRecord(row) }));
}

async function getTopScores(db: D1Database, metric: Metric) {
  const column = METRICS[metric];
  // Rank by score before filtering to another category: every badge is based
  // on the same overall score position, never the selected category position.
  const result = await db.prepare(
    `WITH score_positions AS (
       SELECT *, CASE WHEN score > 0 THEN ROW_NUMBER() OVER (
         ORDER BY score DESC, created_at ASC, player_id ASC
       ) END AS score_rank
       FROM leaderboard_scores
     )
     SELECT * FROM score_positions
     WHERE ${column} > 0
     ORDER BY ${column} DESC, created_at ASC, player_id ASC
     LIMIT ?`
  ).bind(MAX_GLOBAL_SCORES).all<LeaderboardRow>();
  return result.results ?? [];
}

async function getPlayerRecord(db: D1Database, playerId: string, metric: Metric) {
  // Ties favour the older player record, then identity, never last update time:
  // improving headshots cannot demote an unchanged score. Counts include all
  // saved players, not just the displayed Top 100.
  const rankColumns = Object.values(METRICS).map(column => `
    CASE WHEN me.${column} > 0 THEN 1 + (
      SELECT COUNT(*) FROM leaderboard_scores AS other
      WHERE other.${column} > me.${column}
        OR (other.${column} = me.${column} AND (
          other.created_at < me.created_at OR (
            other.created_at = me.created_at AND other.player_id < me.player_id
          )
        ))
    ) END AS ${column}_rank`).join(",");
  const row = await db.prepare(
    `SELECT me.*, ${rankColumns} FROM leaderboard_scores AS me WHERE me.player_id = ?`
  ).bind(playerId).first<LeaderboardRow>();
  if (!row) return null;
  const positions = {
    score: row.score_rank,
    boatsStopped: row.boats_stopped_rank ?? null,
    bestChain: row.best_chain_rank ?? null,
    timeHeld: row.time_held_rank ?? null,
    headshots: row.headshots_rank ?? null,
  };
  return { ...publicRecord(row), rank: positions[metric], positions };
}

async function boardResponse(db: D1Database, metric: Metric, playerId?: string) {
  const [rows, player] = await Promise.all([
    getTopScores(db, metric),
    playerId ? getPlayerRecord(db, playerId, metric) : Promise.resolve(null),
  ]);
  return { metric, entries: publicEntries(rows), player };
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const metric = selectedMetric(params.get("metric"));
  if (!metric) return json({ error: "Unknown leaderboard category." }, 400);
  const playerId = params.get("playerId") || undefined;
  if (playerId && !validPlayerId(playerId)) return json({ error: "Invalid player identity." }, 400);
  try {
    const db = await getDatabase();
    return json(await boardResponse(db, metric, playerId));
  } catch (error) {
    console.error("leaderboard GET failed", error);
    return json({ error: errorMessage(error) }, 503);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
    body = value as Record<string, unknown>;
  } catch {
    return json({ error: "Send a valid score record." }, 400);
  }
  const metric = selectedMetric(body.metric);
  if (!metric) return json({ error: "Unknown leaderboard category." }, 400);
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const callsign = normalizeCallsign(body.callsign);
  const score = body.score;
  if (!validPlayerId(playerId)) return json({ error: "Invalid player identity." }, 400);
  if (!callsign) return json({ error: "Enter a callsign." }, 400);
  if (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0 || score > 10_000_000) {
    return json({ error: "Invalid score." }, 400);
  }
  const stats: Record<keyof typeof STAT_LIMITS, number | null> = {
    boatsStopped: null, bestChain: null, timeHeld: null, headshots: null,
  };
  for (const name of Object.keys(STAT_LIMITS) as (keyof typeof STAT_LIMITS)[]) {
    const value = body[name];
    if (value == null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > STAT_LIMITS[name]) {
      return json({ error: `Invalid ${name} record.` }, 400);
    }
    stats[name] = value;
  }
  if (score === 0 && !Object.values(stats).some(value => value != null && value > 0)) {
    return json({ error: "Finish a run before submitting a record." }, 400);
  }
  const requestedWave = body.wave;
  if (requestedWave != null && (typeof requestedWave !== "number" || !Number.isSafeInteger(requestedWave) || requestedWave < 1 || requestedWave > 10_000)) {
    return json({ error: "Invalid wave." }, 400);
  }
  const wave = typeof requestedWave === "number" ? requestedWave : Math.min(10_000, 1 + Math.floor(score / 250));
  try {
    const now = Date.now();
    const db = await getDatabase();
    const callsignOwner = await db.prepare(
      `SELECT player_id FROM leaderboard_scores WHERE callsign = ? LIMIT 1`
    ).bind(callsign).first<{ player_id: string }>();
    if (callsignOwner && callsignOwner.player_id !== playerId) return callsignTaken();

    // Each category keeps its own best, even when a later run has a lower score.
    // Missing legacy stats remain unknown. No fake zeros or guessed backfills.
    const upsert = db.prepare(
      `INSERT INTO leaderboard_scores
         (player_id, callsign, score, wave, boats_stopped, best_chain, time_held, headshots, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         callsign = excluded.callsign,
         score = MAX(leaderboard_scores.score, excluded.score),
         boats_stopped = CASE WHEN excluded.boats_stopped IS NULL THEN leaderboard_scores.boats_stopped
           ELSE MAX(COALESCE(leaderboard_scores.boats_stopped, 0), excluded.boats_stopped) END,
         best_chain = CASE WHEN excluded.best_chain IS NULL THEN leaderboard_scores.best_chain
           ELSE MAX(COALESCE(leaderboard_scores.best_chain, 0), excluded.best_chain) END,
         time_held = CASE WHEN excluded.time_held IS NULL THEN leaderboard_scores.time_held
           ELSE MAX(COALESCE(leaderboard_scores.time_held, 0), excluded.time_held) END,
         headshots = CASE WHEN excluded.headshots IS NULL THEN leaderboard_scores.headshots
           ELSE MAX(COALESCE(leaderboard_scores.headshots, 0), excluded.headshots) END,
         wave = CASE WHEN excluded.score > leaderboard_scores.score THEN excluded.wave
           ELSE leaderboard_scores.wave END,
         updated_at = CASE WHEN excluded.score > leaderboard_scores.score
           OR excluded.boats_stopped > COALESCE(leaderboard_scores.boats_stopped, -1)
           OR excluded.best_chain > COALESCE(leaderboard_scores.best_chain, -1)
           OR excluded.time_held > COALESCE(leaderboard_scores.time_held, -1)
           OR excluded.headshots > COALESCE(leaderboard_scores.headshots, -1)
           THEN excluded.updated_at ELSE leaderboard_scores.updated_at END`
    ).bind(playerId, callsign, score, wave, stats.boatsStopped, stats.bestChain, stats.timeHeld, stats.headshots, now, now);
    // Keep every player's row. Only read queries limit the public board to 100.
    try {
      await upsert.run();
    } catch (error) {
      if (isCallsignConflict(error)) return callsignTaken();
      throw error;
    }
    const result = await boardResponse(db, metric, playerId);
    return json({ accepted: true, rank: result.player?.rank ?? null, ...result }, 201);
  } catch (error) {
    console.error("leaderboard POST failed", error);
    return json({ error: errorMessage(error) }, 503);
  }
}
