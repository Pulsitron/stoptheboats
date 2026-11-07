// Read-only deployment check. This never inserts sample scores into a live board.
const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run check:leaderboard -- https://your-game-address');
  process.exit(1);
}
let endpoint;
try {
  const base = new URL(target);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Use an HTTP(S) address.');
  endpoint = new URL('/api/leaderboard', base);
} catch (error) {
  console.error('Invalid game address: ' + error.message);
  process.exit(1);
}
let failed = false;
for (const metric of ['score', 'boatsStopped', 'bestChain', 'timeHeld', 'headshots']) {
  const url = new URL(endpoint);
  url.searchParams.set('metric', metric);
  try {
    const response = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(15000)});
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !Array.isArray(data.entries) || data.metric !== metric) {
      throw new Error(data?.error || `HTTP ${response.status}: the address did not return leaderboard data.`);
    }
    console.log(`PASS ${metric}: leaderboard API responded.`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${metric}: ${error.message}`);
  }
}
if (failed) {
  console.error('Check the DB binding and deploy with npm run deploy so database migrations are applied. Static-only hosts cannot run the supplied D1 backend.');
  process.exitCode = 1;
} else {
  console.log('All five categories are reachable. This read-only check did not submit a score.');
}
