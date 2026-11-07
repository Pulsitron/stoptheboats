#!/usr/bin/env node
/**
 * Real Cloudflare workerd + persistent local D1 integration check.
 * Run: node tests/leaderboard-d1.integration.mjs
 * Uses only a fresh temporary database. No account, remote D1, or preview server.
 * The actual TypeScript API route is transpiled unchanged into a tiny test worker;
 * the cloudflare:workers import and SQL execute in workerd, not a mocked adapter.
 */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare, Log, LogLevel} from 'miniflare';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const route=await readFile(path.join(root,'app/api/leaderboard/route.ts'),'utf8');
const compiled=ts.transpileModule(route,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},
}).outputText.replace(/^export /gm,''); // Framework route exports become local worker functions.
const script=compiled+`\nexport default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/api/leaderboard') return new Response('Not found', {status:404});
    if (request.method === 'OPTIONS') return OPTIONS();
    if (request.method === 'GET') return GET(request);
    if (request.method === 'POST') return POST(request);
    return new Response('Method not allowed', {status:405});
  }
};\n`;
const migrationNames=(await readdir(path.join(root,'drizzle'))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
assert.ok(migrationNames.length>=4,'Expected all shipped leaderboard migrations');
const migrations=await Promise.all(migrationNames.map(name=>readFile(path.join(root,'drizzle',name),'utf8')));
const directory=await mkdtemp(path.join(os.tmpdir(),'tidebreak-leaderboard-d1-'));
const databaseId='local-integration-only';
const checks=[];
let runtime;
const playerId='integration_player_000001';
const legacyId='legacy_player_0000000001';
const payload={playerId,callsign:'D1 INTEGRATION',score:600,wave:3,boatsStopped:12,bestChain:7,timeHeld:90,headshots:4};

function start(){
  return new Miniflare({
    modules:true,script,compatibilityDate:'2026-02-12',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:databaseId},d1Persist:path.join(directory,'d1'),
    // Expected missing-schema diagnostics are checked through the HTTP response.
    log:new Log(LogLevel.NONE),
  });
}
async function request(method,body,query=''){
  const response=await runtime.dispatchFetch('https://local-integration.test/api/leaderboard'+query,{
    method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
  });
  return {status:response.status,data:await response.json()};
}
async function applyMigration(db,sql){
  // Drizzle's explicit delimiters preserve multi-line CTE/UPDATE statements.
  for(const statement of sql.split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean)){
    await db.prepare(statement).run();
  }
}
function passed(name){checks.push(name);console.log('PASS '+name);}

try{
  runtime=start();
  await runtime.ready;
  assert.equal((await request('GET')).status,503);
  assert.equal((await request('POST',payload)).status,503);
  passed('Unmigrated real D1 reports failure instead of claiming a save');

  const db=await runtime.getD1Database('DB');
  await applyMigration(db,migrations[0]);
  await db.prepare('INSERT INTO leaderboard_scores (player_id,callsign,score,wave,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(legacyId,'LEGACY SAVED',1200,5,100,100).run();
  assert.equal((await request('POST',payload)).status,503);
  assert.equal((await request('GET',undefined,'?metric=headshots')).status,503);
  passed('Legacy schema reproduces failed saves and missing metric queries');

  for(const migration of migrations.slice(1))await applyMigration(db,migration);
  const legacy=await db.prepare('SELECT * FROM leaderboard_scores WHERE player_id = ?').bind(legacyId).first();
  assert.equal(legacy.score,1200);assert.equal(legacy.callsign,'LEGACY SAVED');assert.equal(legacy.wave,5);
  assert.equal(legacy.headshots,null);assert.equal(legacy.boats_stopped,null);
  passed('All shipped migrations preserve existing scores and unknown legacy stats');

  let result=await request('POST',payload);
  assert.equal(result.status,201);assert.equal(result.data.accepted,true);assert.equal(result.data.player.score,600);
  assert.equal(result.data.player.rank,2);assert.equal(result.data.player.headshots,4);
  passed('Actual API route saves successfully through the cloudflare:workers DB binding');

  result=await request('POST',{...payload,score:400,wave:2,boatsStopped:18,bestChain:5,timeHeld:120,headshots:8,metric:'headshots'});
  assert.equal(result.status,201);
  assert.deepEqual([result.data.player.score,result.data.player.wave,result.data.player.boatsStopped,result.data.player.bestChain,result.data.player.timeHeld,result.data.player.headshots],[600,3,18,7,120,8]);
  const duplicate=await request('POST',{...payload,playerId:'integration_player_000002'});
  assert.equal(duplicate.status,409);
  passed('Lower-score runs retain independent bests and duplicate callsigns are rejected');

  await runtime.dispose();runtime=undefined;
  runtime=start();
  await runtime.ready;
  const expected={score:600,boatsStopped:18,bestChain:7,timeHeld:120,headshots:8};
  for(const metric of Object.keys(expected)){
    result=await request('GET',undefined,'?metric='+metric+'&playerId='+playerId);
    assert.equal(result.status,200);assert.equal(result.data.player[metric],expected[metric]);
    assert.equal(result.data.player.scoreRank,2);
    assert.equal(result.data.player.rank,metric==='score'?2:1);
    const entry=result.data.entries.find(item=>item.callsign===payload.callsign);
    assert.ok(entry,'Saved player missing after restart in '+metric);assert.equal(entry[metric],expected[metric]);
  }
  const restartedDb=await runtime.getD1Database('DB');
  const count=await restartedDb.prepare('SELECT COUNT(*) AS n FROM leaderboard_scores').first();
  assert.equal(count.n,2);
  passed('Persisted records and all five rankings survive a complete workerd restart');
  console.log(JSON.stringify({passed:checks.length,failed:0,realD1:true,restarted:true,remoteWrites:0}));
}finally{
  if(runtime)await runtime.dispose();
  await rm(directory,{recursive:true,force:true});
}
