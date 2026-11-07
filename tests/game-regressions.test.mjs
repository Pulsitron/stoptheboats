import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const html = await readFile(new URL("../public/game.html", import.meta.url), "utf8");
const leaderboardRoute = await readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8");
const leaderboardSchema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const initialMigration = await readFile(new URL("../drizzle/0000_stormy_goliath.sql", import.meta.url), "utf8");
const callsignMigration = await readFile(new URL("../drizzle/0001_flashy_loki.sql", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  let parameters=html.indexOf("(",start),parameterDepth=0;
  for(;parameters<html.length;parameters++){
    if(html[parameters]==="(")parameterDepth++;
    if(html[parameters]===")"&&--parameterDepth===0)break;
  }
  const open = html.indexOf("{", parameters+1);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function projectionFactory(width, shore, horizon, worldScale = 1) {
  const constants=html.match(/const SOLDIER_HEIGHT\s*=[^;]+;/)?.[0];
  assert.ok(constants,"missing common soldier/world scale constants");
  return new Function("W","SHORE_Y","HORIZON_Y","worldScale",`${constants}\n${["boatShoreScale","positionApproachingBoat"].map(extractFunction).join("\n")};return {project:positionApproachingBoat,shoreScale:boatShoreScale};`)(width,shore,horizon,worldScale);
}

test("all inline game scripts parse", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length >= 2);
  scripts.forEach(source => assert.doesNotThrow(() => new Function(source)));
});

test("simultaneous projectile heads remain isolated canvas subpaths", () => {
  const operations = [];
  const ctx = {
    save() {}, restore() {}, stroke() {}, fill() { operations.push("fill"); },
    beginPath() { operations.push("begin"); },
    moveTo() { operations.push("move"); }, lineTo() { operations.push("line"); },
    arc() { operations.push("arc"); },
  };
  const bullets = Array.from({ length: 7 }, (_, i) => ({ px:i, py:i, x:i*50, y:i*70, r:2 }));
  const source = ["projectileScale", "drawBullets"].map(extractFunction).join("\n");
  const drawBullets = new Function("ctx", "bullets", "qualityLevel", "HORIZON_Y", "SHORE_Y", `${source};return drawBullets;`)(ctx, bullets, 2, 100, 600);
  drawBullets();
  assert.deepEqual(operations, bullets.flatMap(() => ["begin", "move", "line", "begin", "move", "arc", "fill"]));
});

test("projectile visuals taper toward the horizon and clamp outside the water plane", () => {
  const scale = new Function("HORIZON_Y", "SHORE_Y", `${extractFunction("projectileScale")};return projectileScale;`)(100, 600);
  assert.equal(scale(100), .13);
  assert.equal(scale(-1000), .13);
  assert.ok(Math.abs(scale(600)-1.18)<1e-12);
  assert.equal(scale(2000), scale(600));
  for(let y=110;y<=600;y+=10)assert.ok(scale(y)>scale(y-10),`non-increasing projectile scale at ${y}`);
});

test("hedgehog line protects each beach sector exactly once", () => {
  const source = ["deployHedgehogLine", "hedgehogX", "interceptAtHedgehog"].map(extractFunction).join("\n");
  const makeDefence = new Function(`${source};
    let hedgehogs=[];const HEDGEHOG_SLOTS=7,W=700;let score=0,calls=[];
    const rewardKill=e=>{score+=e.type.points;calls.push(["reward",e]);};
    const hash=n=>(n%97)/97,shoreAt=x=>600,destructionSize=()=>"small";
    const spawnExplosion=(...a)=>calls.push(["particles",...a]);
    const spawnExplosionFx=(...a)=>calls.push(["splash",...a]);
    const spawnWreck=e=>calls.push(["wreck",e]);
    const SFX={explosion:s=>calls.push(["sound",s])};let cameraShake=0;
    return {
      deploy(){deployHedgehogLine();},
      intercept(e,x){return interceptAtHedgehog(e,x);},
      state(){return {hedgehogs:[...hedgehogs],score,calls:[...calls]};}
    };`)();

  const boat = { type:{ points:35, tierIndex:1 } };
  makeDefence.deploy();
  assert.deepEqual(makeDefence.state().hedgehogs.map(h => h.slot), [0,1,2,3,4,5,6]);
  assert.equal(makeDefence.intercept(boat, 350), true);
  assert.equal(makeDefence.state().hedgehogs.length, 6);
  assert.equal(makeDefence.state().score, 35);
  assert.equal(makeDefence.intercept(boat, 350), false, "the destroyed obstacle must not block a second boat");
  assert.equal(makeDefence.state().calls.filter(call => call[0] === "reward").length, 1, "only an intercepted boat earns its reward");
  makeDefence.deploy();
  assert.equal(makeDefence.state().hedgehogs.length, 7, "a later pickup replenishes missing sectors");
});

test("boats use interpolated transforms without per-passenger pixel snapping", () => {
  assert.match(html, /e\.prevX=e\.x;e\.prevY=e\.y/);
  assert.match(html, /const rx=e\.prevX\+\(e\.x-e\.prevX\)\*alpha/);
  assert.doesNotMatch(extractFunction("drawEnemy"), /ctx\.transform\(1,0,e\.roll/);
  assert.doesNotMatch(extractFunction("drawPassengerPixels"), /Math\.round/);
});

test("attack pacing ramps gradually, including in later waves", () => {
  const playerSpeed = Number(html.match(/const player = \{[\s\S]*?speed:\s*([\d.]+)/)?.[1]);
  assert.equal(playerSpeed, 8.2);
  assert.match(extractFunction('update'), /updatePlayerAnimation\(player\.x-previousPlayerX,previousFacing\)/);

  const speedSource = extractFunction("boatSpeedMultiplier");
  const multiplier = new Function(`${speedSource};return boatSpeedMultiplier;`)();
  assert.equal(multiplier(1), .72);
  assert.equal(multiplier(8), 1.02);
  assert.ok(multiplier(10) > multiplier(6));
  assert.ok(multiplier(1) < multiplier(2));
  assert.ok(multiplier(20) < 1.25);
  assert.ok(multiplier(20)-multiplier(19) < multiplier(10)-multiplier(9));
  for(let wave=2;wave<=50;wave++){
    assert.ok(multiplier(wave)>multiplier(wave-1), `boat speed did not rise at wave ${wave}`);
    assert.ok(multiplier(wave)-multiplier(wave-1)<=.044, `boat speed rose too sharply at wave ${wave}`);
  }

  const intervalSource = extractFunction("spawnIntervalForWave");
  const interval = new Function(`${intervalSource};return spawnIntervalForWave;`)();
  assert.equal(interval(1), 92);
  assert.equal(interval(9), 68);
  assert.equal(interval(15), 58);
  assert.equal(interval(30), 45);
  assert.equal(interval(1000), 40);
  for(let wave=2;wave<=50;wave++){
    assert.ok(interval(wave)<=interval(wave-1), `spawn interval increased at wave ${wave}`);
    assert.ok(interval(wave-1)-interval(wave)<=3, `spawn interval fell too sharply at wave ${wave}`);
  }
});

test("the former body shield is completely removed", () => {
  assert.doesNotMatch(html, /shieldTimer|AEGIS SHIELD|shieldVal|kind === ['"]shield['"]/i);
  assert.match(html, /HEDGEHOG LINE/);
});

test("in-game help explains controls and every power-up", () => {
  assert.match(html, /id="helpBtn"/);
  const help = html.match(/<section id="helpModal"[\s\S]*?<\/section>/)?.[0];
  assert.ok(help, "missing in-game help dialog");
  assert.match(help, /automatic|automatically/i);
  assert.match(help, /One unblocked landing ends the operation/);
  assert.match(help, /All upgrades reset on a new run/);
  assert.match(help, /A \/ D or ← \/ →/);
  assert.match(help, /Hold FIRE with your other thumb, Space, or the mouse to keep firing/);
  assert.match(help, /On touch, hold the left or right thumb button/);
  assert.match(help, /Shift or DASH/);
  assert.match(help, /P or Escape\. Help and rankings also pause the action/);
  assert.match(help, /press E or tap SNIPER/);
  assert.match(help, /Headshots earn \+15/);
  assert.match(help, /4× scope with blacked-out surroundings/);
  assert.match(help, /0\.7 seconds/);
  assert.match(help, /3-Way Spread/);
  assert.match(help, /5-Way Spread/);
  assert.match(help, /Twin automatic beach turrets for 10 seconds/);
  assert.match(help, /Czech Hedgehogs/);
  assert.match(help, /Sea Mine/);
  assert.match(help, /Mortar/);
  assert.doesNotMatch(help, /Cluster Strike/);
  assert.match(help, /Air Strike/);
  assert.match(html, /gamehelpvisibility/);
  assert.match(html, /gameboardvisibility/);
});

test("pause synchronization requires a live run and no active pause reasons", () => {
  const sync = new Function("started", "gameOver", "paused", "modalPauses", `
    let running, cleared=false;
    const clearInput=()=>{cleared=true;},syncGameMusic=()=>{},SFX={stopAll(){}};
    ${extractFunction("syncPause")}
    syncPause();
    return {running,cleared};
  `);
  const cases = [
    {name:"active run", values:[true,false,false,new Set()], expected:true},
    {name:"menu", values:[false,false,false,new Set()], expected:false},
    {name:"game over", values:[true,true,false,new Set()], expected:false},
    {name:"manual pause", values:[true,false,true,new Set()], expected:false},
    {name:"help", values:[true,false,false,new Set(["gamehelpvisibility"])], expected:false},
    {name:"leaderboard", values:[true,false,false,new Set(["gameboardvisibility"])], expected:false},
    {name:"overlapping modals", values:[true,false,false,new Set(["gamehelpvisibility","gameboardvisibility"])], expected:false},
  ];
  for (const {name,values,expected} of cases) {
    assert.deepEqual(sync(...values), {running:expected,cleared:true}, name);
  }
});

test("scene music prioritizes endings and switches between menu and paused battle without overlap",()=>{
  const scene=new Function('started','gameOver','running','modalPauses','ending',`
    const calls=[],BreachClip={isOpen:()=>ending},MusicEngine={play:track=>calls.push(['play',track]),stop:()=>calls.push(['stop']),setPaused:value=>calls.push(['paused',value])};
    ${extractFunction('syncGameMusic')}
    syncGameMusic();return calls;
  `);
  for(const [started,gameOver,running,modals,ending,expected] of [
    [false,false,false,[],false,[['play','menu'],['paused',false]]],
    [true,false,true,[],false,[['play','march'],['paused',false]]],
    [true,false,false,[],false,[['play','march'],['paused',true]]],
    [true,false,false,['gamehelpvisibility'],false,[['play','march'],['paused',true]]],
    [true,false,false,['gameboardvisibility'],false,[['play','menu'],['paused',false]]],
    [true,true,false,[],false,[['play','menu'],['paused',false]]],
    [true,true,false,['gameboardvisibility'],true,[['stop']]],
  ])assert.deepEqual(scene(started,gameOver,running,new Set(modals),ending),expected);
});

test("the first Start gesture primes recorded audio without briefly launching menu music",()=>{
  const create=new Function('event',`
    const calls=[],start={contains:target=>target?.insideStart===true},document={getElementById:()=>start},window={removeEventListener(){}};
    const AudioCore={ensure:()=>calls.push('ensure'),resume:()=>calls.push('resume')},BreachClip={prepare:()=>calls.push('clips')},SFX={prepare:()=>calls.push('sample-fetch'),preload:()=>calls.push('sample-decode')},MusicEngine={prepare:()=>calls.push('music-preload'),play:track=>calls.push(track)};
    ${extractFunction('unlockAudioOnce')}
    unlockAudioOnce(event);return calls;
  `);
  const start=create({target:{insideStart:true}});assert.ok(!start.includes('menu'),'Start gesture briefly started the menu track');assert.ok(start.includes('sample-decode'));
  assert.ok(create({target:{}}).includes('menu'),'A menu interaction does not unlock its music');
  const source=html.slice(html.indexOf('const AudioCore ='),html.indexOf('const AudioSettings ='));
  assert.doesNotMatch(source,/createOscillator\(|noiseBuffer\(|scheduleMarchStep|noteFreq\(/,'Procedural fallback remains in recorded audio');
  assert.match(extractFunction('deployFlare'),/SFX\.flare\(/);assert.match(extractFunction('updateSupportWeapons'),/SFX\.mortar\(/);
});

test("machine gun and sniper ship distinct recorded files and select audio once per trigger event",async()=>{
  const paths=['sfx-machine-gun.mp3','sfx-machine-gun-rapid.mp3','sfx-sniper.mp3'];
  const files=await Promise.all(paths.map(name=>readFile(new URL('../public/audio/'+name,import.meta.url))));
  files.forEach((bytes,index)=>assert.ok(bytes.length>700,'Missing firearm recording '+paths[index]));
  for(let i=0;i<files.length;i++)for(let j=i+1;j<files.length;j++)assert.equal(files[i].equals(files[j]),false,'Distinct weapon files contain identical audio');
  const source=extractFunction('fireBullet');
  assert.equal((source.match(/SFX\.machineGun\(/g)||[]).length,1);
  assert.match(source,/SFX\.machineGun\(Math\.ceil\(rate\)\/60/);
  assert.doesNotMatch(source,/SFX\.laser/);
  assert.match(extractFunction('fireSniper'),/SFX\.sniper\(/);assert.doesNotMatch(extractFunction('fireSniper'),/SFX\.laser/);
  const audio=html.slice(html.indexOf('const SFX ='),html.indexOf('const AudioSettings ='));
  assert.doesNotMatch(audio,/setInterval\(|createOscillator\(/,'Gun cadence must follow gameplay events, not an independent audio loop');
});

test("wave transitions automatically reward players without blocking controls", () => {
  const source = extractFunction("advanceWave");
  assert.doesNotMatch(html, /id="upgradePanel"|function offerUpgrade\(|let choosingUpgrade/);
  assert.doesNotMatch(source, /running\s*=\s*false|clearInput\(|syncPause\(/);
  assert.match(source, /showBanner\(/);
  assert.match(source, /waveSpawned\s*=\s*0/);
  assert.match(extractFunction("update"), /advanceWave\(\)/);
});

test("horizon projection grows cloned hull dimensions and preserves boat definitions", () => {
  const {project,shoreScale} = projectionFactory(700,600,100);
  const baseType = Object.freeze({w:100,h:150,lengthM:6});
  const nearScale=shoreScale(baseType),farScale=nearScale*.10;
  const boat = {baseType,type:{...baseType},approach:0,lane:.3,wobble:0};
  project(boat);
  assert.equal(boat.y, 105);
  assert.equal(boat.depthScale, farScale);
  assert.equal(boat.type.w, baseType.w*farScale);
  assert.equal(boat.type.h, baseType.h*farScale);
  const distant = {...boat.type};
  boat.approach=.5;project(boat);
  assert.ok(boat.y>105&&boat.y<600);
  assert.ok(boat.type.w>distant.w&&boat.type.w<baseType.w);
  boat.approach=1;project(boat);
  assert.equal(boat.type.w,baseType.w*nearScale);assert.equal(boat.type.h,baseType.h*nearScale);
  assert.equal(boat.depthScale,nearScale);
  assert.ok(Math.abs(boat.y+boat.type.h-600)<1e-10,"projected bow remains anchored at the shoreline");
  assert.equal(baseType.w,100);assert.equal(baseType.h,150);
  assert.match(extractFunction("spawnEnemy"), /const type = \{\.\.\.baseType\}/);
  assert.match(extractFunction("spawnEnemy"), /positionApproachingBoat\(enemy\)/);
});

test("every boat retains perspective and a reachable landing on short landscape screens", () => {
  const start=html.indexOf("const BOAT_FAMILIES =");
  const end=html.indexOf("function buildPassengerLayout",start);
  assert.ok(start>=0&&end>start,"missing boat definitions");
  const types=new Function(`${html.slice(start,end)};return ENEMY_TYPES;`)();
  assert.ok(types.length>0);
  const W=844,shore=240,horizon=91;
  const viewportScale=(shore-horizon-18)/(14*46/1.8*.8);
  const {project,shoreScale}=projectionFactory(W,shore,horizon,viewportScale);
  for(const type of types){
    const baseType=Object.freeze({...type});
    const boat={baseType,type:{...baseType},approach:0,lane:.5,wobble:0};
    const projected=[];
    for(const approach of [0,.5,1]){
      boat.approach=approach;project(boat);
      assert.ok(boat.y>=horizon,`${type.name}: hull crossed above the horizon at ${approach}`);
      assert.ok(boat.x>=0&&boat.x+boat.type.w<=W,`${type.name}: hull crossed the horizontal viewport`);
      assert.ok(Math.abs(boat.type.w/baseType.w-boat.type.h/baseType.h)<1e-12,`${type.name}: aspect ratio changed`);
      projected.push({width:boat.type.w,height:boat.type.h,scale:boat.depthScale});
    }
    assert.ok(projected[0].width<projected[1].width&&projected[1].width<projected[2].width,`${type.name}: approach did not grow the hull`);
    assert.ok(Math.abs(projected[0].scale-.1*shoreScale(baseType))<1e-12);
    assert.ok(Math.abs(projected[2].scale-shoreScale(baseType))<1e-12);
    assert.ok(Math.abs(projected[2].width/projected[0].width-10)<1e-10,`${type.name}: perspective ratio changed`);
    assert.ok(Math.abs(projected[2].height/(46*viewportScale)-type.lengthM/1.8*.8)<1e-10,`${type.name}: hull-to-soldier scale changed on landscape`);
    assert.ok(Math.abs(boat.y+boat.type.h-shore)<1e-10,`${type.name}: projected hull lost shoreline anchor`);
    boat.approach=1.25;project(boat);
    assert.ok(boat.y+boat.type.h*.98>=shore,`${type.name}: actual bow collision can never reach the shoreline`);
    assert.equal(baseType.w,type.w);assert.equal(baseType.h,type.h);
  }
});

test("passenger release and sniper targeting share the rendered perspective and bob", () => {
  assert.match(extractFunction("drawPassengerPixels"), /ctx\.scale\(e\.depthScale\|\|1,e\.depthScale\|\|1\)/);
  assert.match(extractFunction("releasePassengers"), /const scale=e\.depthScale\|\|1/);
  assert.match(extractFunction("releasePassengers"), /worldX=cx\+\(spot\.x\*cos-spot\.y\*sin\)\*scale/);
  assert.match(extractFunction("releasePassengers"), /size:passengerWorldSize\(e\)/);
  assert.match(extractFunction("drawFloatingPassengers"), /passengerHeadY\(p\)/);
  assert.match(extractFunction("fireSniper"), /passengerHeadY\(p\)/);
});

test("sniper precision shots reward the nearest eligible passenger once and enforce reload", () => {
  const source=["passengerHeadY","passengerHeadRadius","fireSniper"].map(extractFunction).join("\n");
  const create = new Function("floatingPassengers", `
    let running=true,placingMine=false,score=0,frame=0;
    const sniper={active:true,x:100,y:100,cooldown:0,flash:0,hit:0,shots:0,headshots:0};
    const player={x:100},W=700,SFX={sniper(){}},floatingText=[],waterRipples=[],LIMITS={ripples:28};
    const pushBounded=(list,item)=>list.push(item),syncSniperUI=()=>{},spawnHeadshotSpray=()=>{};
    ${source}
    return {fire:fireSniper,state:()=>({score,sniper:{...sniper},remaining:[...floatingPassengers]}),reload(){sniper.cooldown=0;}};
  `);
  const target=(x,overrides={})=>({x,y:100,size:3,phase:0,age:8,life:100,...overrides});
  const sniper=create([target(101.5),target(100),target(100,{age:7}),target(100,{life:0})]);
  assert.equal(sniper.fire(),true);
  assert.equal(sniper.state().score,15);
  assert.equal(sniper.state().sniper.headshots,1);
  assert.equal(sniper.state().sniper.cooldown,42);
  assert.equal(sniper.state().remaining.length,3);
  assert.equal(sniper.state().remaining[0].x,101.5,"nearest target should be removed, not first candidate");
  assert.equal(sniper.fire(),false,"held/repeated input cannot bypass reload");
  assert.equal(sniper.state().score,15);
  assert.equal(sniper.state().sniper.shots,1);
  const miss=create([target(105),target(100,{age:7}),target(100,{life:0})]);
  assert.equal(miss.fire(),true);
  assert.equal(miss.state().score,0);
  assert.equal(miss.state().sniper.headshots,0);
  assert.equal(miss.state().remaining.length,3);
  assert.match(extractFunction("fireBullet"), /sniper\.active/);
  assert.match(extractFunction("update"), /!sniper\.active && \(keys\[' '\] \|\| dragging \|\| touchHeld\.fire\)/);
});

test("sniper detail is rendered directly into a bounded optical canvas, not upscaled from the game", () => {
  const scope=extractFunction("drawSniperScope");
  assert.doesNotMatch(scope,/drawImage\(canvas[,)]/);
  assert.match(scope,/renderWorldScene\(false\)/);
  assert.match(scope,/finally/);
  assert.match(extractFunction("draw"),/sniper\.active/);
  assert.match(extractFunction("renderWorldScene"),/drawEnvironment\(\)/);
});

test("mortars and jet payloads use update-driven visible projectiles", () => {
  const mortar=extractFunction("deployCluster"),airstrike=extractFunction("deployAirstrike");
  assert.doesNotMatch(airstrike,/mode:\s*['"]all['"]/);
  assert.match(airstrike,/SFX\.radio/);
  assert.match(mortar,/mortar/);
  assert.match(extractFunction("update"),/updateSupportWeapons\(\)/);
  assert.match(extractFunction("resetGame"),/resetSupportWeapons\(\)/);
  for(const name of ["drawAirstrikeWarning","drawClusterTelegraphs"]){
    assert.doesNotMatch(extractFunction(name),/executeBlast\(|SFX\.|\.splice\(|scheduledBlasts\.push\(/);
  }
});

test("randomized weather stays seeded and bounded with shorter nights and unchanged daylight", () => {
  const profileSource=html.match(/const environmentProfiles = (\[[\s\S]*?\n  \]);/)?.[1];
  assert.ok(profileSource,"missing weather profiles");
  const create=new Function(`
    const environment={};const environmentProfiles=${profileSource};let playTicks=0;
    ${html.slice(html.indexOf('const ORIGINAL_DAY_CYCLE_SECONDS='),html.indexOf('const weatherSchedule='))}
    ${html.match(/const weatherSchedule=[^;]+;/)?.[0]}
    let illuminationFlares=[],flareUIState='';const flareSupply={charges:3,max:3,recharge:0,rechargeTicks:2100},weatherCache={},updateFlareUI=()=>{};
    ${["environmentSmooth","weatherRandom","chooseWeatherIndex","createWeatherTarget","advanceWeatherFront","resetEnvironment","updateEnvironment","getEnvironmentLabel"].map(extractFunction).join("\n")}
    resetEnvironment(123);
    return {reset:resetEnvironment,at(seconds){playTicks=seconds*60;for(let i=0;i<300;i++)updateEnvironment();return {...environment};},label:getEnvironmentLabel,state:()=>({...environment}),cycle:DAY_CYCLE_SECONDS,
      plan(seed){resetEnvironment(seed);const plan=[];for(let i=0;i<16;i++){plan.push(JSON.parse(JSON.stringify(weatherSchedule)));advanceWeatherFront();}return plan;}};
  `);
  const weather=create();
  assert.equal(weather.state().time,0);assert.equal(weather.state().night,0);
  assert.equal(weather.label(),"Day · Clear skies");
  assert.equal(weather.cycle,251);
  assert.ok(weather.at(100).night<.001,'Shorter nights also shortened daylight');
  assert.ok(weather.at(170).night>.99);
  assert.ok(weather.at(251).night<.001);
  const plan=weather.plan(1234);
  assert.deepEqual(weather.plan(1234),plan,'Supplied seed must reproduce the same fronts');
  assert.notDeepEqual(weather.plan(4321),plan,'Different seeds must vary fronts and durations');
  assert.ok(new Set(plan.map(p=>p.hold)).size>8);
  assert.ok(new Set(plan.map(p=>p.next.index)).size>=4);
  for(const [i,front] of plan.entries()){
    assert.notEqual(front.current.index,front.next.index,'Adjacent fronts repeated the same condition');
    assert.ok(front.hold>=(i?18:14)&&front.hold<=(i?52:24));
    assert.ok(front.transition>=7&&front.transition<=13);
    for(const field of ['cloud','rain','fog','snow'])assert.ok(front.next[field]>=0&&front.next[field]<=1);
  }
  weather.reset();assert.equal(weather.state().weatherIndex,0);
  assert.equal(weather.state().rain,0);assert.equal(weather.state().snow,0);
  assert.equal(weather.label(),"Day · Clear skies");
  assert.match(extractFunction("update"), /updateEnvironment\(\)/);
  assert.match(extractFunction("resetGame"), /resetEnvironment\(\)/);
  assert.doesNotMatch(extractFunction("updateEnvironment"), /Date\.|performance\.|Math\.random/);
  assert.doesNotMatch(extractFunction("drawEnvironment"),/Math\.random/);
  assert.match(extractFunction("drawNightLighting"),/night\*\.84/);
});

test("night envelope is exactly half as long at every darkness threshold without shortening daylight",()=>{
  const constants=html.slice(html.indexOf('const ORIGINAL_DAY_CYCLE_SECONDS='),html.indexOf('const weatherSchedule='));
  const {phase,night,cycle}=new Function(`${constants}\n${extractFunction('environmentSmooth')}\nreturn {phase:getDayPhaseSeconds,cycle:DAY_CYCLE_SECONDS,night:seconds=>environmentSmooth(57,84,seconds/2)*(1-environmentSmooth(132,166,seconds/2))};`)();
  for(const [time,expected] of [[0,0],[100,100],[114,114],[141,168],[170,226],[223,332],[250,359],[251,0],[-1,359],[502,0]])assert.equal(phase(time),expected);
  for(let time=0;time<251;time+=.25)assert.ok(Math.abs(phase(time+cycle)-phase(time))<1e-9,'Lighting phase is not periodic');
  for(const point of [114,223])assert.ok(Math.abs(phase(point+1e-6)-phase(point-1e-6))<.00001,'Dusk or dawn phase jumps');
  for(const threshold of [0,.25,.5,.9,.99]){
    let oldDuration=0,newDuration=0;
    for(let i=0;i<36000;i++)if(night((i+.5)/100)>threshold)oldDuration+=.01;
    for(let i=0;i<25100;i++)if(night(phase((i+.5)/100))>threshold)newDuration+=.01;
    assert.ok(Math.abs(oldDuration/2-newDuration)<.021,'Night duration was not halved at threshold '+threshold);
    if(threshold===0){assert.ok(Math.abs(oldDuration-218)<.001);assert.ok(Math.abs(newDuration-109)<.001);assert.ok(Math.abs((360-oldDuration)-(cycle-newDuration))<.001,'Daylight duration changed');}
  }
  assert.equal(night(phase(251-1e-6)),0);assert.equal(night(phase(251)),0);
});

test("cached mist feathers both axes to transparent edges instead of displaying rectangle seams", () => {
  const makeCanvas=()=>{
    const draws=[],context=new Proxy({
      createLinearGradient(...args){return {kind:'linear',args,stops:[],addColorStop(offset,color){this.stops.push([offset,color]);}};},
      createRadialGradient(...args){return {kind:'radial',args,stops:[],addColorStop(offset,color){this.stops.push([offset,color]);}};},
      fillRect(...args){draws.push({args,composite:this.globalCompositeOperation,style:this.fillStyle});}
    },{get(object,key){return key in object?object[key]:()=>{};}});
    return {width:0,height:0,draws,getContext:()=>context};
  };
  const cache={cloudsReady:false,clouds:makeCanvas(),nightClouds:makeCanvas(),fog:makeCanvas()};
  new Function('weatherCache','hash',extractFunction('prepareWeatherClouds')+';prepareWeatherClouds();')(cache,n=>(n%97)/97);
  const masks=cache.fog.draws.filter(draw=>draw.composite==='destination-in'&&draw.style.kind==='linear');
  assert.ok(masks.length>=2,'Both edges need alpha feather masks');
  assert.ok(masks.some(({style})=>style.args[0]===style.args[2]&&style.args[1]!==style.args[3]),'No vertical fade');
  assert.ok(masks.some(({style})=>style.args[0]!==style.args[2]&&style.args[1]===style.args[3]),'No horizontal fade');
  for(const {style} of masks){
    assert.deepEqual(style.stops[0],[0,'rgba(0,0,0,0)']);
    assert.deepEqual(style.stops.at(-1),[1,'rgba(0,0,0,0)']);
  }
});

test("swept rifle segments hit tiny hulls without tunnelling and reject clear misses", () => {
  const hits = new Function(`${extractFunction("bulletHitsBoat")};return bulletHitsBoat;`)();
  const boat = {x:100,y:100,type:{w:6,h:8}};
  assert.equal(hits({px:103,py:115,x:103,y:95},boat),true,"fast vertical shot crosses the entire tiny hull");
  assert.equal(hits({px:95,py:104,x:115,y:104},boat),true,"horizontal artillery segment crosses hull");
  assert.equal(hits({px:110,py:112,x:98,y:98},boat),true,"diagonal segment crosses hull");
  assert.equal(hits({px:108,py:115,x:108,y:95},boat),false,"parallel segment passes beside hull");
  assert.equal(hits({px:103,py:125,x:103,y:115},boat),false,"segment stops before hull");
  assert.equal(hits({px:103,py:95,x:103,y:85},boat),false,"segment starts past hull and moves away");
  assert.equal(hits({x:103,y:104},boat),true,"stationary point inside hull remains a hit");
  assert.equal(hits({x:110,y:104},boat),false,"stationary point outside hull remains a miss");
  assert.match(extractFunction("update"), /bulletHitsBoat\(b,\s*e\)/);
});

test("orange lifeboat return fire uses a visible warning, shot cap and swept hitbox", () => {
  assert.match(html, /const ENEMY_AIM_TICKS = 60/);
  assert.match(html, /const MAX_HOSTILE_SHOTS = 3/);
  const source = extractFunction("updateCounterfire");
  assert.match(source, /family!==['"]lifeboat['"]/);
  assert.match(source, /fireWindup=ENEMY_AIM_TICKS/);
  assert.match(source, /hostileShots\.length<MAX_HOSTILE_SHOTS/);
  assert.match(source, /fireCooldown=420\+Math\.floor\(Math\.random\(\)\*180\)/);
  assert.match(source, /damagePlayerFromProjectile\(\)/);
  assert.match(extractFunction("drawCounterfire"), /INCOMING/);
});

test("three projectile lives have bounded damage, immunity and a distinct breach rule", () => {
  const create = new Function(`
    let running=true,gameOver=false,overCount=0;
    const player={lives:3,hitInvulnerability:0,x:0,y:100,w:30},floatingText=[];
    const updateLivesUI=()=>{},updateTacticalUI=()=>{},showBanner=()=>{},pushBounded=(list,item)=>list.push(item);
    const triggerGameOver=()=>{gameOver=true;running=false;overCount++;};
    ${extractFunction("damagePlayerFromProjectile")}
    return {hit:damagePlayerFromProjectile,clear(){player.hitInvulnerability=0;},pause(){running=false;},resume(){running=true;},state:()=>({lives:player.lives,immunity:player.hitInvulnerability,gameOver,overCount})};
  `);
  const game=create();
  assert.equal(game.hit(),true);assert.deepEqual(game.state(),{lives:2,immunity:90,gameOver:false,overCount:0});
  assert.equal(game.hit(),false);game.clear();game.pause();assert.equal(game.hit(),false);
  game.resume();assert.equal(game.hit(),true);assert.equal(game.state().lives,1);
  game.clear();assert.equal(game.hit(),true);assert.equal(game.state().lives,0);assert.equal(game.state().overCount,1);
  game.clear();assert.equal(game.hit(),false);assert.equal(game.state().overCount,1);
  assert.match(extractFunction("resetGame"),/player\.lives=3/);
  assert.match(extractFunction("update"),/player\.hitInvulnerability--/);
  assert.match(extractFunction("update"),/triggerGameOver\(e\)/);
});

test("injury poses keep muzzle and swept missile geometry attached at every display scale", () => {
  const create = new Function("worldScale", `
    const SOLDIER_HEIGHT=48,frame=0,environment={reducedMotion:false};
    const player={x:200,y:500,w:30,h:44,lives:3,runBlend:0,runPhase:0,facing:1,lean:0,recoil:0};
    ${extractFunction("getPlayerPose")}
    ${extractFunction("projectileHitsPlayer")}
    return {player,environment,pose:getPlayerPose,hit:projectileHitsPlayer};
  `);
  for(const scale of [.55,1,1.4]){
    const game=create(scale),heights=[];
    for(const lives of [3,2,1,0]){
      game.player.lives=lives;
      const pose=game.pose();heights.push(pose.hitH);
      assert.equal(pose.stage,3-lives);
      for(const field of ['x','y','groundY','muzzleX','muzzleY','hitX','hitY','hitW','hitH'])assert.ok(Number.isFinite(pose[field]),field);
      assert.ok(pose.muzzleY<pose.groundY,'The rifle muzzle must remain above the beach');
      assert.equal(game.hit({px:pose.hitX,py:pose.hitY-100,x:pose.hitX,y:pose.hitY+100}),true,'Swept missiles tunnelled through the torso');
      assert.equal(game.hit({px:pose.hitX+pose.hitW+20,py:pose.hitY-100,x:pose.hitX+pose.hitW+20,y:pose.hitY+100}),false,'Clear miss was counted as damage');
      assert.equal(game.hit({px:pose.hitX,py:pose.hitY,x:pose.hitX,y:pose.hitY}),true,'Stationary overlapping missiles should hit');
      game.player.facing=-1;const left=game.pose();game.player.facing=1;
      const center=game.player.x+game.player.w/2;
      assert.ok(Math.abs((left.muzzleX-center)+(pose.muzzleX-center))<1e-9,'Rifle origin does not mirror about the soldier');
      assert.ok(Math.abs(left.muzzleY-pose.muzzleY)<1e-9,'Rifle vertical anchor changes when facing is reversed');
      if(lives<=1)assert.ok(pose.hitW>pose.hitH,'Crawling/fallen torso must be wider than tall');
    }
    assert.ok(heights[2]<heights[0]/2,'Prone torso kept the old standing hitbox');
    game.player.lives=2;game.player.runBlend=1;game.player.runPhase=Math.PI*2*(.27+.61/2);
    assert.ok(game.pose().bob>6,'One-legged movement must hop');
    game.environment.reducedMotion=true;assert.equal(game.pose().bob,0,'Reduced-motion hopping should not bounce');
  }
});

test("distance-driven soldier gait has finite joints, stable contact and exact rifle anchors",()=>{
  const create=new Function('worldScale',`
    const SOLDIER_HEIGHT=48,environment={reducedMotion:false};let frame=0;
    const player={x:200,y:500,w:30*worldScale,h:48*worldScale,lives:3,speed:8.2,runBlend:0,runPhase:0,facing:1,lean:0,recoil:0,animVelocity:0,animAcceleration:0,animTurn:0};
    ${extractFunction('getPlayerPose')}
    ${extractFunction('playerGaitFoot')}
    ${extractFunction('playerLimbJoint')}
    ${extractFunction('updatePlayerAnimation')}
    return {player,environment,pose:getPlayerPose,foot:playerGaitFoot,joint:playerLimbJoint,update:updatePlayerAnimation,setFrame:value=>frame=value};
  `);
  for(const scale of [.4,.7,1,1.6]){
    const game=create(scale),world=(pose,x,y)=>({x:pose.x+Math.cos(pose.angle)*x*scale*pose.facing-Math.sin(pose.angle)*y*scale,y:pose.y+Math.sin(pose.angle)*x*scale*pose.facing+Math.cos(pose.angle)*y*scale});
    for(const lives of [3,2,1,0])for(const facing of [-1,1])for(let step=0;step<=64;step++){
      Object.assign(game.player,{lives,facing,runBlend:1,runPhase:step/64*Math.PI*2,lean:facing*.07,recoil:step%5});
      const before=JSON.stringify(game.player),pose=game.pose();
      for(const [field,value] of Object.entries(pose))assert.ok(Number.isFinite(value),field+' is non-finite');
      const muzzle=world(pose,pose.muzzleLocalX,pose.muzzleLocalY),stock=world(pose,pose.stockLocalX,pose.stockLocalY),grip=world(pose,pose.foreGripX,pose.foreGripY);
      assert.ok(Math.abs(muzzle.x-pose.muzzleX)<1e-9&&Math.abs(muzzle.y-pose.muzzleY)<1e-9,'Barrel differs from bullet origin');
      assert.ok(Math.abs(stock.x-muzzle.x)<1e-9&&Math.abs(stock.y-muzzle.y-15*scale)<1e-9,'Rifle turns away from the sea during the gait');
      assert.ok(Math.abs(grip.x-muzzle.x)<1e-9&&Math.abs(grip.y-muzzle.y-8*scale)<1e-9,'Supporting hand detached from foregrip');
      for(const side of [-1,1]){
        const foot=game.foot(pose,side),contact=world(pose,foot.x,foot.y);
        for(const value of Object.values(foot))assert.ok(Number.isFinite(value));
        assert.ok(contact.y<=pose.groundY+1e-9,'Foot sinks through beach');
        if(foot.contact)assert.ok(Math.abs(contact.y-pose.groundY)<1e-9,'Stance foot floats above beach');
        const joint=game.joint(side*4,6.5,foot.x,foot.y,8.5,9.8,-1);assert.ok(Number.isFinite(joint.x)&&Number.isFinite(joint.y));
      }
      assert.equal(JSON.stringify(game.player),before,'Pose solver mutates motion state');
    }
    for(const args of [[0,0,0,0,8,9],[0,0,1e-9,1e-9,8,9],[0,0,1e4,-1e4,8,9],[-8,2,3,-7,6.5,7.5,-1]])for(const value of Object.values(game.joint(...args)))assert.ok(Number.isFinite(value));
    Object.assign(game.player,{lives:3,runBlend:0,runPhase:0,lean:0,recoil:0,animVelocity:0,animAcceleration:0,animTurn:0});
    for(let i=0;i<90;i++)game.update(8.2,1);
    assert.ok(game.player.runPhase>0&&game.player.runBlend>.99&&game.player.animVelocity>8&&game.player.lean>0);
    const phase=game.player.runPhase;for(let i=0;i<120;i++)game.update(0,1);
    assert.equal(game.player.runPhase,phase,'Standing still advances gait');assert.ok(game.player.runBlend<1e-8);assert.ok(Math.abs(game.player.lean)<1e-6);
    game.player.facing=-1;game.update(-8.2,1);assert.equal(game.player.animTurn,1);
    for(let i=0;i<60;i++)game.update(-8.2,-1);
    assert.ok(game.player.animVelocity< -8&&game.player.lean<0&&game.player.animTurn<1e-6);
    game.environment.reducedMotion=true;
    for(const lives of [3,2,1,0]){
      Object.assign(game.player,{lives,runBlend:1,runPhase:1.7,recoil:0});const initial=game.pose();
      for(const field of ['bob','hop','compression','torsoSway','shoulderRoll','gearBounce','helmetLag','turn'])assert.ok(initial[field]===0,'Reduced motion retains '+field);
      game.setFrame(1000);assert.deepEqual(game.pose(),initial,'Reduced-motion idle geometry drifts with clock');
    }
  }
  const update=extractFunction('update');
  assert.ok(update.indexOf('updatePlayerAnimation(player.x-previousPlayerX,previousFacing)')>update.indexOf('player.x = Math.max(0, Math.min(W - player.w, player.x))'),'Animation runs before boundary clamping');
});

test("fictional passenger appearances are cached at spawn without changing target geometry",()=>{
  const start=html.indexOf('const PASSENGER_SKINS='),end=html.indexOf('function releasePassengers(',start);
  assert.ok(start>=0&&end>start);
  const appearance=new Function(`${extractFunction('hash')}\n${html.slice(start,end)};return createPassengerAppearance;`)();
  const sample=appearance(42);assert.deepEqual(appearance(42),sample);assert.notDeepEqual(appearance(43),sample);
  assert.match(extractFunction('releasePassengers'),/appearance:createPassengerAppearance\(/);
  const draw=extractFunction('drawFloatingPassengers');
  assert.match(draw,/p\.appearance\|\|PASSENGER_DEFAULT_APPEARANCE/);
  assert.match(draw,/ctx\.translate\(p\.x,headY\)/);
  assert.match(draw,/headR=passengerHeadRadius\(p\)/);
  assert.doesNotMatch(draw,/Math\.random\(|p\.appearance\s*=/);
  assert.doesNotMatch(extractFunction('passengerHeadRadius'),/appearance/);
});

test("three-way and five-way spread pickups have independent timed priority", () => {
  assert.match(html, /const SPREAD_3_DURATION = 20 \* 60/);
  assert.match(html, /const SPREAD_5_DURATION = 10 \* 60/);
  assert.match(html, /POWERUP_TYPES = \['spread3', 'spread5', 'rapid', 'artillery'/);
  assert.doesNotMatch(html, /POWERUP_TYPES\s*=\s*\[[^\]]*['"]spread['"]/);
  const player = { spread3Timer: 0, spread5Timer: 0 };
  const activeSpreadLevel = new Function("player", `${extractFunction("activeSpreadLevel")};return activeSpreadLevel;`)(player);
  assert.equal(activeSpreadLevel(), 0);
  player.spread3Timer = 1200;
  assert.equal(activeSpreadLevel(), 1);
  player.spread5Timer = 600;
  assert.equal(activeSpreadLevel(), 2, "five-way spread should override three-way while active");
  player.spread5Timer = 0;
  assert.equal(activeSpreadLevel(), 1, "remaining three-way time should resume after five-way expires");
  assert.match(extractFunction("update"), /player\.spread3Timer--/);
  assert.match(extractFunction("update"), /player\.spread5Timer--/);
});

test("artillery deploys two timed beach turrets with damaging shells", () => {
  assert.match(html, /const ARTILLERY_DURATION = 10 \* 60/);
  assert.match(html, /turrets:\s*\[[\s\S]*side:\s*-1[\s\S]*side:\s*1/);
  assert.match(extractFunction("activateArtillery"), /ARTILLERY_DURATION/);
  assert.match(extractFunction("updateArtillery"), /damage:\s*2/);
  assert.match(extractFunction("updateArtillery"), /turret\.cooldown = 44/);
  assert.match(extractFunction("updateArtillery"), /SFX\.artillery\(\)/);
  assert.match(extractFunction("update"), /updateArtillery\(\)/);
  assert.match(extractFunction("update"), /e\.hp -= b\.damage \|\| 1/);
  assert.match(extractFunction("renderWorldScene"), /drawArtillery\(\)/);
  assert.match(extractFunction("drawArtillery"), /artilleryPosition\(turret\)/);
});

test("personal best and global Top 100 are integrated into the game-over flow", () => {
  assert.match(html, /id="hudBestVal"/);
  assert.match(html, /id="leaderboardModal"/);
  assert.match(html, /stop-the-boats:personal-best/);
  assert.match(extractFunction("triggerGameOver"), /Leaderboard\.finishRun\(score, wave, false, \{boatsStopped:kills,bestChain:bestCombo,timeHeld:Math\.floor\(playTicks\/60\),headshots:sniper\.headshots\}\)/);
  assert.match(extractFunction("finishRun"), /metrics\.slice\(1\)\.forEach/);
  assert.match(extractFunction("transmitScore"), /payload=\{playerId:getPlayerId\(\),callsign,\.\.\.bests,metric\}/);
  assert.match(html, /fetchTopScores\(false\)\.finally/);
  assert.match(html, /transmitScore\(savedCallsign,\s*true\)/);
  assert.match(html, /entries\.slice\(0,\s*100\)/);
  assert.doesNotMatch(html, /innerHTML\s*=\s*.*callsign/);
});

test("all five leaderboard categories retain independent personal records", () => {
  for(const metric of ['score','boatsStopped','bestChain','timeHeld','headshots']){
    assert.match(html,new RegExp('id="boardMetric-'+metric+'"'));
    assert.match(leaderboardRoute,new RegExp(metric+':'));
  }
  for(const column of ['boats_stopped','best_chain','time_held','headshots']){
    assert.match(leaderboardSchema,new RegExp('integer\\("'+column+'"\\)'));
    assert.match(leaderboardRoute,new RegExp('MAX\\(COALESCE\\(leaderboard_scores\\.'+column));
  }
  assert.match(extractFunction('getShareSnapshot'), /lastRun\?lastRun:bests/);
  assert.match(extractFunction('fetchTopScores'), /metric!==selectedMetric/);
});

test("military ranks cover every overall position and new players remain Recruit", () => {
  const start=html.indexOf('const MilitaryRanks ='),end=html.indexOf('const Leaderboard =',start);
  assert.ok(start>=0&&end>start);
  const ranks=new Function(html.slice(start,end)+';return MilitaryRanks;')();
  const expected=[[1,'Field Marshal'],[2,'General'],[3,'Lieutenant General'],[4,'Major General'],[5,'Major General'],[6,'Brigadier'],[10,'Brigadier'],[11,'Colonel'],[20,'Colonel'],[21,'Lieutenant Colonel'],[35,'Lieutenant Colonel'],[36,'Major'],[50,'Major'],[51,'Captain'],[75,'Captain'],[76,'Lieutenant'],[100,'Lieutenant'],[101,'Second Lieutenant'],[200,'Second Lieutenant'],[201,'Warrant Officer'],[350,'Warrant Officer'],[351,'Sergeant'],[500,'Sergeant'],[501,'Corporal'],[750,'Corporal'],[751,'Private'],[999999,'Private']];
  for(const [place,name] of expected)assert.equal(ranks.forPosition(place).name,name,'wrong grade at #'+place);
  for(const place of [null,undefined,0,-1,NaN,Infinity,'1',1.5])assert.equal(ranks.forPosition(place).name,'Recruit');
  const badges=ranks.grades.map(grade=>ranks.badgeSVG(grade.level));
  assert.equal(new Set(badges).size,16,'Ranks should have distinct insignia');
  badges.forEach(svg=>{assert.match(svg,/<svg/);assert.doesNotMatch(svg,/NaN|undefined/);});
});

test("breach and soldier-down videos require Continue before rankings and offer post-run restart", () => {
  const source=extractFunction("triggerGameOver");
  assert.match(html, /<video[^>]+id="breachVideo"[^>]+src="\/media\/captain\.mp4"/);
  assert.doesNotMatch(html, /id="breachSkip"/);
  assert.match(html, /id="breachContinue"[^>]*hidden/);
  assert.match(html, /id="leaderboardNewGame"/);
  assert.match(source, /BreachClip\.show\(\(\)=>\{if\(gameOver\)Leaderboard\.open\(\);\},cause==='fire'\?'soldier':'breach'\)/);
  assert.match(extractFunction("finishRun"), /autoOpen\s*=\s*true/);
  assert.match(extractFunction("finishRun"), /if\(autoOpen\)/);
  const clip=html.slice(html.indexOf("const BreachClip ="),html.indexOf("const GameHelp ="));
  assert.match(clip, /soldier:[^\n]*\/media\/soldier\.mp4/);
  assert.match(clip, /function show\(callback,kind='breach'\)/);
  assert.match(clip, /candidate\.addEventListener\('ended',\(\)=>\{if\(active&&candidate===video\)complete\(\)/);
  assert.match(clip, /candidate\.addEventListener\('error',\(\)=>\{if\(active&&candidate===video\)complete\(/);
  assert.doesNotMatch(clip, /skip\.addEventListener|Clip skipped/);
  assert.match(clip, /continueBtn\.addEventListener\('click',\(\)=>\{if\(ready\)finish\(\)/);
  assert.match(clip, /continueBtn\.hidden=false/);
  assert.match(clip, /ready=true;clearTimeout\(watchdog\)/);
  assert.match(clip, /if\(!active\)return/);
  assert.match(clip, /media\.muted=true/);
  assert.match(clip, /play\.hidden=false/);
  assert.match(clip, /token===serial/);
  assert.match(clip, /12000/);
  assert.match(extractFunction("resetGame"), /BreachClip\.reset\(\)/);
  assert.match(html, /new CustomEvent\('gamerestart'\)/);
});

test("ending videos share one responsive square, hide transport controls and keep final pictures", () => {
  for(const id of ['breachVideo','soldierVideo']){
    const tag=html.match(new RegExp('<video\\b[^>]*id="'+id+'"[^>]*>'))?.[0];
    assert.ok(tag);assert.doesNotMatch(tag,/\scontrols(?:\s|=|>)/);
    assert.match(tag,/playsinline/);assert.match(tag,/tabindex="-1"/);assert.match(tag,/preload="auto"/);assert.match(tag,/class="endingVideo"/);
  }
  assert.match(html,/#breachMedia\s*\{[^}]*width:100%;[^}]*aspect-ratio:1;/);
  assert.match(html,/\.endingVideo,#breachStill\s*\{[^}]*position:absolute;inset:0;[^}]*width:100%;height:100%;object-fit:contain;/);
  assert.match(html,/#breachStill\[hidden\][^{]*\{display:none;/);
  assert.match(html,/\.breachCard\s*\{[^}]*calc\(100dvh - 160px\)/);
  const clip=html.slice(html.indexOf("const BreachClip ="),html.indexOf("const GameHelp ="));
  assert.doesNotMatch(clip,/video\.controls\s*=\s*true/);
  assert.match(clip,/candidate\.removeAttribute\('controls'\)/);
  assert.match(clip,/soldier:[^\n]*endFrame:'\/media\/soldier-end\.jpg'[^\n]*holdAt:92\/30/);
  assert.match(clip,/breach:[^\n]*endFrame:'\/media\/captain-end\.jpg'/);
  assert.match(clip,/still\.src=clip\.endFrame/);
  assert.match(clip,/function holdLastFrame\(\)[\s\S]*?still\.hidden=false;stopFrameWatch\(\)/);
  assert.match(clip,/requestVideoFrameCallback/);assert.match(clip,/cancelVideoFrameCallback/);
  assert.match(clip,/candidate\.addEventListener\('timeupdate'/);
  assert.match(clip,/if\(!active\|\|ready\|\|token!==serial\)return/);
  assert.doesNotMatch(clip,/key==='Escape'[^\n]*complete\(/);
});

test("ending videos are prewarmed and start synchronously before records work without reloading media",()=>{
  const clip=html.slice(html.indexOf('const BreachClip ='),html.indexOf('const GameHelp ='));
  const source=extractFunction('triggerGameOver'),start=extractFunction('startGame');
  assert.ok(source.indexOf('BreachClip.show(')<source.indexOf('Leaderboard.finishRun('));
  assert.match(start,/BreachClip\.prepare\(\)/);
  assert.match(extractFunction('unlockAudioOnce'),/BreachClip\.prepare\(\)/);
  assert.match(clip,/function prepare\(\)/);assert.match(clip,/candidate\.muted=true/);
  assert.doesNotMatch(clip,/\.load\(\)|setAttribute\(['"]src|video\.src\s*=/);
  assert.match(clip,/warmed\.has\(candidate\)\|\|warming\.has\(candidate\)/);
  assert.match(clip,/if\(!active\|\|candidate!==video\)/);
  assert.match(extractFunction('loop'),/if\(BreachClip\.isOpen\(\)\)[^\n]*requestAnimationFrame\(loop\);return/);
});

test("global leaderboard retains every personal best and returns only the Top 100", () => {
  assert.match(leaderboardRoute, /ON CONFLICT\(player_id\) DO UPDATE/);
  assert.match(leaderboardRoute, /MAX\(leaderboard_scores\.score, excluded\.score\)/);
  assert.match(leaderboardRoute, /const MAX_GLOBAL_SCORES = 100/);
  assert.match(leaderboardRoute, /ORDER BY score DESC, created_at ASC, player_id ASC/);
  assert.doesNotMatch(leaderboardRoute, /DELETE FROM leaderboard_scores/);
  assert.match(leaderboardRoute, /Access-Control-Allow-Origin/);
});

test("callsigns are normalized, ownership-checked, and race-safe", () => {
  assert.match(leaderboardSchema, /uniqueIndex\("leaderboard_callsign_unique_idx"\)\.on\(table\.callsign\)/);
  assert.match(leaderboardRoute, /WHERE callsign = \?/);
  assert.match(leaderboardRoute, /callsignOwner\.player_id !== playerId/);
  assert.match(leaderboardRoute, /That callsign is already taken\. Choose another\./);
  assert.match(leaderboardRoute, /isCallsignConflict\(error\)/);
  assert.match(leaderboardRoute, /callsign = excluded\.callsign/);
  assert.match(html, /error\.status\s*===\s*409/);
  assert.match(html, /callsignInput\.select\(\)/);
  assert.match(extractFunction("renderEntries"), /displayCallsign\(entry\.callsign\)/);
  assert.match(extractFunction("displayCallsign"), /\^A-Z0-9 _~-/);
});

test("the callsign migration preserves scores and resolves existing duplicates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(initialMigration);
  const insert = db.prepare(
    `INSERT INTO leaderboard_scores
       (player_id, callsign, score, wave, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insert.run("player-0000000001", "ACE", 250, 2, 10, 10);
  insert.run("player-0000000002", "ACE", 750, 4, 20, 20);
  insert.run("player-0000000003", "WAVE", 500, 3, 30, 30);

  db.exec(callsignMigration);
  const rows = db
    .prepare("SELECT player_id, callsign, score FROM leaderboard_scores ORDER BY player_id")
    .all();
  assert.equal(rows.length, 3, "no existing score should be deleted");
  assert.equal(rows[1].callsign, "ACE", "the highest-scoring duplicate keeps the callsign");
  assert.equal(rows[0].callsign, "ACE~2");
  assert.equal(new Set(rows.map(row => row.callsign)).size, rows.length);
  assert.throws(
    () => insert.run("player-0000000004", "ACE", 1000, 5, 40, 40),
    /UNIQUE constraint failed/
  );
  db.close();
});

test("a boat reaching the shoreline remains intact and simply ends the game", () => {
  const source = extractFunction("triggerGameOver");
  assert.match(source, /breacher\.y=shoreAt\(bowX\)/);
  assert.doesNotMatch(source, /spawnExplosionFx|spawnWreck|SFX\.explosion/);
});
