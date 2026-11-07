import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercise the real inline game scripts in the isolated smoke VM. These are
// logic tests, not claims of physical device or browser layout verification.
const runner = fileURLToPath(new URL('./game-smoke.mjs', import.meta.url));
const profiles = [
  { name:'small phone portrait', width:320, height:568, dpr:2, threads:4, memory:2 },
  { name:'phone landscape', width:844, height:390, dpr:3, threads:8, memory:4 },
  { name:'small phone landscape', width:667, height:375, dpr:2, threads:4, memory:2 },
  { name:'tablet portrait', width:768, height:1024, dpr:2, threads:8, memory:8 },
  { name:'tablet landscape', width:1366, height:1024, dpr:2, threads:8, memory:8 },
];
for (const profile of profiles) {
  test(`mobile game behavior: ${profile.name}`, () => {
    const result = spawnSync(process.execPath,[runner,'--strict','--mobile-only'],{
      encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024,
      env:{...process.env,SMOKE_TOUCH:'1',SMOKE_WIDTH:String(profile.width),SMOKE_HEIGHT:String(profile.height),
        SMOKE_DPR:String(profile.dpr),SMOKE_THREADS:String(profile.threads),SMOKE_MEMORY:String(profile.memory)},
    });
    assert.ifError(result.error);
    let report;
    try { report=JSON.parse(result.stdout); }
    catch { assert.fail(`Smoke runner produced no JSON: ${result.stderr}\n${result.stdout}`); }
    const failures=report.results.filter(item=>item.status!=='PASS');
    assert.equal(result.status,0,JSON.stringify({failures,regressions:report.regressions},null,2));
    assert.ok(report.summary.passed>=15,'Mobile behavioral checks did not run');
    assert.equal(report.summary.realNetworkRequests,0);
  });
}
