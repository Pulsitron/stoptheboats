import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html=await readFile(new URL('../public/game.html',import.meta.url),'utf8');
const from=html.indexOf('const Leaderboard = (function(){');
const to=html.indexOf('// User-driven composer handoffs',from);
assert.ok(from>=0&&to>from,'Leaderboard controller is missing');
const source=html.slice(from,to)+'\nglobalThis.board=Leaderboard;';
const key={name:'stop-the-boats:callsign',id:'stop-the-boats:player-id',records:'stop-the-boats:personal-records-v2',pending:'stop-the-boats:leaderboard-pending'};
const stats={boatsStopped:12,bestChain:5,timeHeld:125,headshots:3};
const json=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const accepted=payload=>json({accepted:true,metric:payload.metric,entries:[],rank:4,player:{...payload,scoreRank:4,positions:{score:4}}});

async function createClient({storage=new Map(),storageDenied=false,handler}={}){
  let now=0,nextId=0,idCount=0,fetchHandler=handler;
  const timers=new Map(),elements=new Map(),requests=[];
  class Event {
    constructor(type,options={}){this.type=type;Object.assign(this,options);}
    preventDefault(){} stopPropagation(){}
  }
  class Target {
    constructor(){this.listeners=new Map();}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
    dispatchEvent(event){event.target ||= this;for(const fn of this.listeners.get(event.type)||[])fn(event);return true;}
  }
  class Element extends Target {
    constructor(){super();this.value='';this.textContent='';this.children=[];this.disabled=false;this.hidden=false;this.attrs=new Map();
      const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)};
    }
    appendChild(child){this.children.push(child);return child;}
    replaceChildren(...children){this.children=children;}
    setAttribute(name,value){this.attrs.set(name,String(value));}
    getAttribute(name){return this.attrs.get(name)??null;}
    focus(){document.activeElement=this;}select(){}
  }
  const window=new Target(),document=new Target();
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  Object.assign(document,{hidden:false,activeElement:null,getElementById:element,createElement:()=>new Element(),createDocumentFragment:()=>new Element()});
  const context=vm.createContext(Object.assign(window,{
    window,self:window,document,navigator:{onLine:true},location:{protocol:'https:',origin:'https://game.example'},
    CustomEvent:Event,AbortController,URL,console,
    crypto:{randomUUID:()=>`test-player-${String(++idCount).padStart(12,'0')}`},
    localStorage:{
      getItem(name){if(storageDenied)throw new Error('Storage denied');return storage.get(name)??null;},
      setItem(name,value){if(storageDenied)throw new Error('Storage denied');storage.set(name,String(value));},
      removeItem(name){if(storageDenied)throw new Error('Storage denied');storage.delete(name);},
    },
    setTimeout(fn,delay=0){const id=++nextId;timers.set(id,{fn,at:now+Number(delay)});return id;},
    clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{fn(now);return 0;},
    MilitaryRanks:{grades:[],forPosition:position=>({name:position?'Ranked':'Recruit',level:position?1:0}),badgeSVG:()=>'<svg></svg>'},
    fetch:async(url,options={})=>{
      const request={url:String(url),method:options.method||'GET',payload:options.body?JSON.parse(options.body):null,options};requests.push(request);
      if(fetchHandler)return fetchHandler(request);
      return request.method==='POST'?accepted(request.payload):json({entries:[],player:null,metric:new URL(request.url,'https://game.example').searchParams.get('metric')||'score'});
    },
  }));
  const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
  vm.runInContext(source,context,{timeout:2000});await flush();
  const client={
    storage,requests,window,document,element,flush,
    api:window.board,
    setHandler:next=>{fetchHandler=next;},
    posts:()=>requests.filter(request=>request.method==='POST'),
    saveStatus:()=>element('leaderboardSaveStatus').textContent,
    async finish(score=1000,wave=3,details=stats){window.board.finishRun(score,wave,false,details);await flush();},
    async changeName(name){element('callsignInput').value=name;element('callsignInput').dispatchEvent(new Event('change'));await flush();},
    async submit(){element('leaderboardForm').dispatchEvent(new Event('submit'));await flush();},
    async event(type,target=window){target.dispatchEvent(new Event(type));await flush();},
    async advance(milliseconds){
      const target=now+milliseconds;let steps=0;
      while(true){const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
        assert.ok(++steps<100,'Unbounded retry timer loop');now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}
      now=target;await flush();
    },
  };
  return client;
}

test('committing a first callsign automatically saves every independent personal record',async()=>{
  const h=await createClient();await h.finish();await h.finish(700,2,{boatsStopped:18,bestChain:2,timeHeld:90,headshots:8});
  assert.equal(h.posts().length,0,'A placeholder callsign was submitted without a name');
  await h.changeName('  new pilot  ');
  assert.equal(h.posts().length,1);
  const payload=h.posts()[0].payload;
  assert.deepEqual({...payload,playerId:null,metric:null},{playerId:null,metric:null,callsign:'NEW PILOT',score:1000,wave:3,boatsStopped:18,bestChain:5,timeHeld:125,headshots:8});
  assert.match(h.saveStatus(),/confirmed saved/i);assert.equal(h.element('submitScoreBtn').disabled,true);
});

test('failed saves remain local, retry only a bounded number of times and recover on reconnect',async()=>{
  const h=await createClient({storage:new Map([[key.name,'RETRY PILOT']])});
  h.setHandler(request=>request.method==='POST'?Promise.reject(new Error('Network offline')):json({entries:[],player:null,metric:'score'}));
  await h.finish();assert.equal(h.posts().length,1);assert.equal(JSON.parse(h.storage.get(key.records)).score,1000);
  assert.doesNotMatch(h.saveStatus(),/confirmed saved/i);
  await h.advance(90000);assert.equal(h.posts().length,4,'Expected initial attempt and three bounded retries');
  h.setHandler(request=>request.method==='POST'?accepted(request.payload):json({entries:[],player:null,metric:'score'}));
  await h.event('online');assert.equal(h.posts().length,5);assert.match(h.saveStatus(),/confirmed saved/i);
  await h.advance(90000);assert.equal(h.posts().length,5,'A confirmed save kept retrying');
});

test('persisted bests resume their upload after a page reload using the same player identity',async()=>{
  const storage=new Map([[key.name,'RETURN PILOT']]);const first=await createClient({storage});
  first.setHandler(request=>request.method==='POST'?Promise.reject(new Error('Offline')):json({entries:[],player:null,metric:'score'}));
  await first.finish();const failed=first.posts()[0].payload;
  const restored=await createClient({storage});
  assert.equal(restored.posts().length,1);assert.equal(restored.posts()[0].payload.playerId,failed.playerId);
  assert.equal(restored.posts()[0].payload.score,1000);assert.equal(restored.posts()[0].payload.headshots,3);
  assert.match(restored.saveStatus(),/confirmed saved/i);
});

test('known offline status keeps records queued without making doomed save requests',async()=>{
  const h=await createClient({storage:new Map([[key.name,'OFFLINE PILOT']])});
  h.window.navigator.onLine=false;await h.finish();await h.advance(90000);
  assert.equal(h.posts().length,0);assert.match(h.saveStatus(),/waiting for a connection/i);
  assert.equal(JSON.parse(h.storage.get(key.records)).score,1000);
  h.window.navigator.onLine=true;await h.event('online');
  assert.equal(h.posts().length,1);assert.match(h.saveStatus(),/confirmed saved/i);
});

test('callsign conflicts stop automatic retries until the player commits a different name',async()=>{
  const h=await createClient({storage:new Map([[key.name,'TAKEN']])});
  h.setHandler(request=>request.method==='POST'?json({error:'Callsign is already in use'},409):json({entries:[],player:null,metric:'score'}));
  await h.finish();assert.equal(h.posts().length,1);assert.match(h.saveStatus(),/callsign|name/i);
  await h.advance(90000);await h.event('online');h.api.open();await h.flush();
  assert.equal(h.posts().length,1,'Conflicting name was retried automatically');
  h.setHandler(request=>request.method==='POST'?accepted(request.payload):json({entries:[],player:null,metric:'score'}));
  await h.changeName('AVAILABLE');assert.equal(h.posts().length,2);assert.equal(h.posts()[1].payload.callsign,'AVAILABLE');
  assert.match(h.saveStatus(),/confirmed saved/i);
});

for(const [name,makeData] of [
  ['empty response',()=>({})],
  ['missing accepted flag',payload=>({entries:[],player:payload})],
  ['missing saved player',()=>({accepted:true,entries:[]})],
  ['lower saved score',payload=>({accepted:true,entries:[],player:{...payload,score:payload.score-1}})],
  ['missing known statistic',payload=>({accepted:true,entries:[],player:{...payload,headshots:null}})],
  ['a different saved callsign',payload=>({accepted:true,entries:[],player:{...payload,callsign:'SOMEONE ELSE'}})],
])test(`HTTP 200 with ${name} never claims the personal records were saved`,async()=>{
  const h=await createClient({storage:new Map([[key.name,'VERIFY PILOT']])});
  h.setHandler(request=>request.method==='POST'?json(makeData(request.payload)):json({entries:[],player:null,metric:'score'}));
  await h.finish();assert.equal(h.posts().length,1);
  assert.doesNotMatch(h.saveStatus(),/confirmed saved/i);assert.equal(h.element('submitScoreBtn').disabled,false);
  assert.equal(JSON.parse(h.storage.get(key.records)).headshots,3);
});

test('a stronger record earned during an upload is serialized and saved after the first response',async()=>{
  const h=await createClient({storage:new Map([[key.name,'BUSY PILOT']])}),pending=[];
  h.setHandler(request=>request.method==='POST'?new Promise(resolve=>pending.push({request,resolve})):json({entries:[],player:null,metric:'score'}));
  await h.finish();await h.finish(800,2,{boatsStopped:18,bestChain:9,timeHeld:200,headshots:7});
  assert.equal(pending.length,1,'Uploads overlapped');
  pending[0].resolve(accepted(pending[0].request.payload));await h.flush();
  assert.equal(pending.length,2);assert.equal(pending[1].request.payload.score,1000);assert.equal(pending[1].request.payload.headshots,7);
  assert.doesNotMatch(h.saveStatus(),/confirmed saved/i,'Earlier result confirmed records that had not yet been uploaded');
  pending[1].resolve(accepted(pending[1].request.payload));await h.flush();
  assert.match(h.saveStatus(),/confirmed saved/i);assert.equal(h.posts().length,2);
});

test('blocked localStorage still uses one player identity for reads and writes throughout the tab',async()=>{
  const h=await createClient({storageDenied:true});
  h.api.selectMetric('headshots');await h.flush();await h.finish();await h.changeName('PRIVATE PILOT');
  assert.equal(h.posts().length,1);
  const ids=h.requests.map(request=>request.payload?.playerId||new URL(request.url,'https://game.example').searchParams.get('playerId'));
  assert.equal(new Set(ids).size,1,'Storage errors created a new identity per request');
  assert.match(h.saveStatus(),/confirmed saved/i);
});

test('a stalled save times out, unlocks submission and succeeds on the bounded retry',async()=>{
  const h=await createClient({storage:new Map([[key.name,'TIMEOUT PILOT']])});
  h.setHandler(request=>request.method==='POST'?new Promise(()=>{}):json({entries:[],player:null,metric:'score'}));
  await h.finish();assert.equal(h.element('submitScoreBtn').disabled,true);
  await h.advance(12001);assert.equal(h.element('submitScoreBtn').disabled,false);assert.match(h.saveStatus(),/timed out/i);
  h.setHandler(request=>request.method==='POST'?accepted(request.payload):json({entries:[],player:null,metric:'score'}));
  await h.advance(3001);assert.equal(h.posts().length,2);assert.match(h.saveStatus(),/confirmed saved/i);
});

test('an older leaderboard GET cannot erase a newer confirmed POST',async()=>{
  const h=await createClient({storage:new Map([[key.name,'RACE PILOT']])});let releaseRead;
  h.setHandler(request=>request.method==='POST'?accepted(request.payload):new Promise(resolve=>{releaseRead=resolve;}));
  h.api.open();await h.flush();assert.equal(typeof releaseRead,'function');
  await h.finish();assert.match(h.saveStatus(),/confirmed saved/i);
  releaseRead(json({entries:[],player:null,metric:'score'}));await h.flush();
  assert.match(h.saveStatus(),/confirmed saved/i);assert.equal(h.element('submitScoreBtn').disabled,true);
});

test('successful rankings refresh cannot overwrite a failed personal-record save message',async()=>{
  const h=await createClient({storage:new Map([[key.name,'STATUS PILOT']])});
  h.setHandler(request=>request.method==='POST'?Promise.reject(new Error('Save network failure')):json({entries:[],player:null,metric:'score'}));
  await h.finish();const failure=h.saveStatus();assert.match(failure,/failure|saved on|upload/i);
  h.api.selectMetric('headshots');await h.flush();assert.equal(h.saveStatus(),failure);
  assert.doesNotMatch(h.saveStatus(),/confirmed saved/i);
});
