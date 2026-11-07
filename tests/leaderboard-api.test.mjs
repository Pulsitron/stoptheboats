import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const route = await readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8");
const migrations = await Promise.all([
  "0000_stormy_goliath.sql", "0001_flashy_loki.sql", "0002_loud_layla_miller.sql", "0003_complete_toro.sql",
].map(name => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));
// Execute the real route against an in-memory SQLite D1 adapter. No network,
// Cloudflare account, user data, or real leaderboard writes enter these tests.
const source = ts.transpileModule(route.replace('await import("cloudflare:workers")', '({ env: globalThis.__testEnv })'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  migrations.forEach(sql => sqlite.exec(sql));
  const state = { now: 1000, queries: [], missCallsignCheck: false };
  const db = { prepare(sql) {
    state.queries.push(sql);
    const statement = sqlite.prepare(sql);
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async all() { return { results: statement.all(...params) }; },
      async first() {
        if (state.missCallsignCheck && /WHERE callsign = \?/.test(sql)) return null;
        return statement.get(...params) ?? null;
      },
      async run() { const result = statement.run(...params); return { success: true, meta: result }; },
    };
  } };
  class FakeDate extends Date { static now() { return state.now; } }
  const context = vm.createContext({ exports: {}, __testEnv: { DB: db }, Response, Request, URL, Date: FakeDate, console: { error() {} } });
  vm.runInContext(source, context);
  const request = (method, payload, query = "") => new Request(`https://game.test/api/leaderboard${query}`, {
    method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
  });
  return {
    sqlite, state,
    async post(payload) { const response = await context.exports.POST(request("POST", payload)); return { status: response.status, data: await response.json() }; },
    async get(query = "") { const response = await context.exports.GET(request("GET", null, query)); return { status: response.status, data: await response.json() }; },
    async rawPost(body) { const response = await context.exports.POST(new Request("https://game.test/api/leaderboard", { method: "POST", body })); return { status: response.status, data: await response.json() }; },
    row(id) { return sqlite.prepare("SELECT * FROM leaderboard_scores WHERE player_id = ?").get(id); },
    seed(id, callsign, score, boats, chain, time, headshots, timestamp = 100) {
      sqlite.prepare("INSERT INTO leaderboard_scores (player_id, callsign, score, wave, boats_stopped, best_chain, time_held, headshots, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)")
        .run(id, callsign, score, boats, chain, time, headshots, timestamp, timestamp);
    },
    close() { sqlite.close(); },
  };
}
const player = "player_test_00000001";
const base = { playerId: player, callsign: "ALPHA", score: 100, wave: 2 };

test("metric migration is append-only and preserves old scores as unknown statistics", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migrations[0]); db.exec(migrations[1]);
  db.prepare("INSERT INTO leaderboard_scores VALUES (?, ?, ?, ?, ?, ?)").run(player, "LEGACY", 100333, 12, 1, 1);
  db.exec(migrations[2]);
  const row = db.prepare("SELECT * FROM leaderboard_scores").get();
  assert.equal(row.score, 100333); assert.equal(row.callsign, "LEGACY"); assert.equal(row.wave, 12);
  for (const key of ["boats_stopped", "best_chain", "time_held", "headshots"]) assert.equal(row[key], null);
  assert.equal(db.prepare("PRAGMA index_list(leaderboard_scores)").all().filter(row => row.name.includes("_rank_idx")).length, 5);
  assert.doesNotMatch(migrations[2], /\b(?:UPDATE|DELETE|DROP|INSERT)\b/i);
  db.exec(migrations[3]);
  assert.equal(db.prepare("SELECT score FROM leaderboard_scores").get().score, 100333);
  assert.deepEqual(db.prepare("PRAGMA index_info(leaderboard_score_rank_idx)").all().map(row => row.name), ["score", "created_at", "player_id"]);
  assert.doesNotMatch(migrations[3], /\b(?:UPDATE|DELETE|INSERT|DROP TABLE)\b/i);
  db.close();
});

test("every metric retains an independent personal best on lower-scoring runs", async () => {
  const f = fixture();
  let result = await f.post({ ...base, score: 900, boatsStopped: 10, bestChain: 7, timeHeld: 60, headshots: 3 });
  assert.equal(result.status, 201);
  f.state.now = 2000;
  result = await f.post({ ...base, score: 600, wave: 1, boatsStopped: 20, bestChain: 4, timeHeld: 120, headshots: 9, metric: "headshots" });
  assert.equal(result.status, 201);
  assert.deepEqual([result.data.player.score, result.data.player.boatsStopped, result.data.player.bestChain, result.data.player.timeHeld, result.data.player.headshots, result.data.player.wave], [900, 20, 7, 120, 9, 2]);
  assert.equal(result.data.metric, "headshots"); assert.equal(result.data.rank, 1);
  assert.equal(result.data.entries[0].scoreRank, 1);
  f.close();
});

test("legacy clients cannot erase new statistics, and missing stats are never fabricated", async () => {
  const f = fixture();
  assert.equal((await f.post(base)).status, 201);
  let row = f.row(player);
  for (const key of ["boats_stopped", "best_chain", "time_held", "headshots"]) assert.equal(row[key], null);
  assert.equal((await f.get("?metric=headshots")).data.entries.length, 0);
  await f.post({ ...base, boatsStopped: 11, bestChain: 5, timeHeld: 80, headshots: 0 });
  await f.post({ ...base, score: 1100, wave: 4 });
  row = f.row(player);
  assert.deepEqual([row.score, row.boats_stopped, row.best_chain, row.time_held, row.headshots], [1100, 11, 5, 80, 0]);
  assert.equal((await f.get("?metric=headshots")).data.entries.length, 0);
  f.close();
});

test("zero-score survival runs may rank for time without gaining an overall score rank", async () => {
  const f = fixture();
  const result = await f.post({ ...base, score: 0, boatsStopped: 0, bestChain: 0, timeHeld: 30, headshots: 0, metric: "timeHeld" });
  assert.equal(result.status, 201); assert.equal(result.data.player.rank, 1); assert.equal(result.data.player.scoreRank, null);
  assert.deepEqual(result.data.player.positions, { score: null, boatsStopped: null, bestChain: null, timeHeld: 1, headshots: null });
  assert.equal((await f.get()).data.entries.length, 0);
  assert.equal((await f.get("?metric=timeHeld")).data.entries.length, 1);
  f.close();
});

test("Top 100 category ordering and personal positions include every saved player", async () => {
  const f = fixture();
  for (let i = 1; i <= 105; i++) f.seed(`player_${String(i).padStart(12, "0")}`, `P${i}`, i, 106-i, i%7, i*2, i%9, 100+i);
  const lastScoreId = "player_000000000001";
  let result = await f.get(`?metric=score&playerId=${lastScoreId}`);
  assert.equal(result.data.entries.length, 100); assert.equal(result.data.entries[0].score, 105);
  assert.equal(result.data.player.scoreRank, 105); assert.equal(result.data.player.rank, 105);
  result = await f.get(`?metric=boatsStopped&playerId=${lastScoreId}`);
  assert.equal(result.data.entries[0].callsign, "P1"); assert.equal(result.data.entries[0].scoreRank, 105);
  assert.equal(result.data.player.rank, 1); assert.equal(result.data.player.positions.score, 105);
  assert.equal(result.data.entries.length, 100);
  for (const metric of ["bestChain", "timeHeld", "headshots"]) {
    const board = (await f.get(`?metric=${metric}&playerId=${lastScoreId}`)).data;
    board.entries.forEach((entry, index) => {
      assert.equal(entry.rank, index+1); assert.ok(entry[metric] > 0);
      if (index) assert.ok(board.entries[index-1][metric] >= entry[metric]);
      assert.equal("player_id" in entry || "playerId" in entry, false);
    });
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM leaderboard_scores").get().n, 105);
  f.close();
});

test("ties use player creation time then identity consistently across board and personal positions", async () => {
  const f = fixture();
  f.seed("player_000000000003", "CHARLIE", 100, 5, 2, 30, 1, 102);
  f.seed("player_000000000002", "BRAVO", 100, 5, 2, 30, 1, 100);
  f.seed("player_000000000001", "ALPHA", 100, 5, 2, 30, 1, 100);
  for (const metric of ["score", "boatsStopped", "bestChain", "timeHeld", "headshots"]) {
    const result = await f.get(`?metric=${metric}&playerId=player_000000000002`);
    assert.deepEqual(result.data.entries.map(entry => entry.callsign), ["ALPHA", "BRAVO", "CHARLIE"]);
    assert.equal(result.data.player.rank, 2); assert.equal(result.data.player.scoreRank, 2);
  }
  f.close();
});

test("improving another metric does not demote an unchanged tied score", async () => {
  const f = fixture();
  f.seed(player, "ALPHA", 100, 5, 2, 30, 1, 100);
  f.seed("player_test_00000002", "BRAVO", 100, 5, 2, 30, 1, 200);
  const updated = await f.post({ ...base, score: 50, boatsStopped: 8, bestChain: 3, timeHeld: 60, headshots: 10 });
  assert.equal(updated.status, 201); assert.equal(f.row(player).updated_at, 1000);
  assert.equal(f.row(player).created_at, 100); assert.equal(updated.data.player.scoreRank, 1);
  assert.equal(updated.data.entries[0].callsign, "ALPHA");
  f.close();
});

test("invalid metric, identity, body, negative, fractional, and unbounded statistics reject before DB writes", async () => {
  const f = fixture();
  for (const body of [
    { ...base, metric: "score DESC; DROP TABLE leaderboard_scores" },
    { ...base, metric: "toString" }, { ...base, playerId: "short" }, { ...base, callsign: "💥" },
    { ...base, score: null }, { ...base, score: "100" }, { ...base, score: -1 }, { ...base, score: 1.5 }, { ...base, score: Infinity },
    { ...base, score: 10_000_001 }, { ...base, wave: 0 }, { ...base, wave: 10_001 },
    { ...base, boatsStopped: -1 }, { ...base, bestChain: .5 }, { ...base, timeHeld: 604_801 },
    { ...base, headshots: 10_000_001 }, { ...base, boatsStopped: "4" }, { ...base, score: 0 },
  ]) assert.equal((await f.post(body)).status, 400, JSON.stringify(body));
  for (const body of ["{", "null", "[]", '"abc"']) assert.equal((await f.rawPost(body)).status, 400);
  assert.equal((await f.get("?metric=__proto__")).status, 400);
  assert.equal((await f.get("?playerId=bad")).status, 400);
  assert.equal(f.state.queries.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM leaderboard_scores").get().n, 0);
  f.close();
});

test("normalized duplicate callsigns reject atomically without overwriting either player's records", async () => {
  const f = fixture();
  await f.post(base);
  const second = { ...base, playerId: "player_test_00000002", callsign: "BRAVO", score: 300 };
  await f.post(second);
  const result = await f.post({ ...second, callsign: "  alpha  ", score: 9000 });
  assert.equal(result.status, 409); assert.equal(f.row(player).score, 100); assert.equal(f.row(second.playerId).score, 300);
  assert.equal(f.row(second.playerId).callsign, "BRAVO");
  // Simulate a race after the optimistic ownership read: the unique index must
  // still reject the write and the handler must return the same 409 contract.
  f.state.missCallsignCheck = true;
  const raced = await f.post({ ...second, callsign: "ＡＬＰＨＡ", score: 9999 });
  assert.equal(raced.status, 409); assert.equal(f.row(second.playerId).callsign, "BRAVO");
  f.close();
});

test("idempotent submissions preserve ordering timestamps and returning users can rename their own record", async () => {
  const f = fixture();
  const payload = { ...base, boatsStopped: 5, bestChain: 2, timeHeld: 50, headshots: 1 };
  await f.post(payload);
  f.state.now = 2000;
  const result = await f.post({ ...payload, callsign: "renamed" });
  assert.equal(result.status, 201); assert.equal(f.row(player).callsign, "RENAMED");
  assert.equal(f.row(player).updated_at, 1000); assert.equal(f.row(player).created_at, 1000);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM leaderboard_scores").get().n, 1);
  f.close();
});
