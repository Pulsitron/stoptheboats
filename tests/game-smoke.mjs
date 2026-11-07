#!/usr/bin/env node
/**
 * Offline smoke/regression harness for the single-file coastal-defence game.
 * Usage: node tests/game-smoke.mjs [game.html] [--strict]
 * Defaults to ../public/game.html relative to this test, independent of cwd.
 * Executes a test-only instrumented copy; never edits the input HTML.
 * DOM, canvas, audio, storage, timers and fetch are isolated in this VM.
 * No real fetch, WebSocket, filesystem or other network API enters the VM.
 * This checks execution/logic, not pixel appearance or browser accessibility.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const filename = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'))
  || fileURLToPath(new URL('../public/game.html', import.meta.url));
const strict = process.argv.includes('--strict');
const html = fs.readFileSync(filename, 'utf8');
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/i.test(match[1]) && !/application\/json/i.test(match[1]))
  .map(match => match[2]);
assert.ok(inlineScripts.length, 'No inline scripts found');
const gameIndex = inlineScripts.findLastIndex(source => /function\s+resetGame\s*\(/.test(source));
assert.ok(gameIndex >= 0, 'No resetGame() closure found');
const injection = '\n;globalThis.__gameTest = { evaluate: expression => eval(expression) };\n';
const closingIife = /\}\)\s*\(\s*\)\s*;?\s*$/;
assert.match(inlineScripts[gameIndex], closingIife, 'Expected final game IIFE');
inlineScripts[gameIndex] = inlineScripts[gameIndex].replace(closingIife, match => injection + match);
// Expose clip metadata only inside this isolated test copy. Hosted files use
// /media paths; standalone exports embed the same clips as data URIs.
const clipIndex = inlineScripts.findIndex(source => source.includes('const BreachClip ='));
const clipReturn = 'return {show,reset,finish,prepare,isOpen:()=>active};';
assert.ok(clipIndex >= 0 && inlineScripts[clipIndex].includes(clipReturn), 'Missing clip controller test hook');
inlineScripts[clipIndex] = inlineScripts[clipIndex].replace(clipReturn, 'return {clips,activeVideo:()=>video,show,reset,finish,prepare,isOpen:()=>active};');

let clock = 0, sequence = 0, drawCalls = 0, seed = 42, canvasTrace = null;
let fetchHandler = async () => ({entries: [], rank: null, player: null, metric: 'score'});
let assetFetchHandler = async () => ({ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(64)});
let decodeAudioHandler = async () => ({duration:1,length:44100,sampleRate:44100,numberOfChannels:1,getChannelData:()=>new Float32Array(44100)});
const audioElements=[];
const externalActions = [];
const frames = new Map(), timers = new Map(), requests = [], warnings = [], results = [];
const elements = new Map();
class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, {type, bubbles: true, cancelable: true, defaultPrevented: false}, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.immediate = this.stopped = true; }
}
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({listener, once: options?.once, capture: options===true||!!options?.capture});
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.listener !== listener));
  }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    for (const item of [...(this.listeners.get(event.type) || [])].sort((a,b)=>Number(b.capture)-Number(a.capture))) {
      item.listener.call(this, event);
      if (item.once) this.removeEventListener(event.type, item.listener);
      if (event.immediate) break;
    }
    if (event.bubbles && !event.stopped && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}
function canvasContext(canvas = null) {
  return new Proxy({
    measureText: value => ({width: String(value).length * 7}),
    createLinearGradient: () => ({addColorStop() {}}),
    createRadialGradient: () => ({addColorStop() {}}),
    createConicGradient: () => ({addColorStop() {}}),
    createPattern: () => ({}),
    createImageData: (width, height) => ({data: new Uint8ClampedArray(width * height * 4), width, height}),
    getImageData: () => ({data: new Uint8ClampedArray(4), width: 1, height: 1}),
    getTransform: () => ({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}),
    isPointInPath: () => false,
  }, {
    get(object, property) {
      if (property in object) return object[property];
      return (...args) => {
        drawCalls++;
        if (canvasTrace) canvasTrace.push({method: String(property), args, canvas, fillStyle: object.fillStyle, strokeStyle: object.strokeStyle, alpha: object.globalAlpha, composite: object.globalCompositeOperation});
        for (const value of args) if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`Canvas ${String(property)} received non-finite numeric argument`);
        }
      };
    },
  });
}
class Element extends Target {
  constructor(tag = 'div', id = '') {
    super(); this.tagName = tag.toUpperCase(); this.id = id;
    this.style = {setProperty(name, value) {this[name] = value;}, removeProperty(name) {delete this[name];}};
    this.dataset = {}; this.attributes = new Map(); this.children = [];
    this.value = ''; this.textContent = ''; this.innerHTML = ''; this.hidden = false;
    this.disabled = false; this.width = 760; this.height = 900; this.tabIndex = 0;
    this.currentTime=0;this.muted=false;this.volume=1;this.paused=true;
    this.readyState=4;this.duration=60;this.loop=false;
    this.playCalls=0;this.pauseCalls=0;this.playOutcomes=[];this.playHistory=[];this.pendingPlays=[];this.loadCalls=0;this.sourceWrites=0;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      toggle: (value, force) => { const on = force ?? !classes.has(value); if (on) classes.add(value); else classes.delete(value); return on; },
      toString: () => [...classes].join(' '),
    };
  }
  get className() { return this.classList.toString(); }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set className(value) { for (const cls of this.classList.toString().split(' ')) this.classList.remove(cls); this.classList.add(...String(value).split(/\s+/)); }
  getContext() { return this.context ||= canvasContext(this); }
  getBoundingClientRect() {
    const width = parseFloat(this.style.width) || this.width || 760;
    const height = parseFloat(this.style.height) || this.height || 900;
    return {x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height};
  }
  get clientWidth() { return this.getBoundingClientRect().width; }
  get clientHeight() { return this.getBoundingClientRect().height; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return this.clientHeight; }
  setAttribute(name, value) {
    if(name==='src')this.sourceWrites++;
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    if (name === 'hidden' || name === 'disabled') this[name] = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden' || name === 'disabled') this[name] = false; }
  appendChild(child) { child.parentNode = this; this.children.push(child); if(child.id)elements.set(child.id,child);return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parentNode?.children?.splice(this.parentNode.children.indexOf(this), 1); }
  contains(other) { return other === this || this.children.some(child => child.contains?.(other)); }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  click() {
    if(this.tagName==='A'&&this.download)externalActions.push({kind:'download',href:this.href,filename:this.download});
    this.dispatchEvent(new FakeEvent('click'));
  }
  select() {}
  play() {
    this.playCalls++;this.playHistory.push({muted:this.muted,currentTime:this.currentTime});const outcome=this.playOutcomes.shift();
    if(outcome==='reject')return Promise.reject(new Error('Simulated media play rejection'));
    this.paused=false;if(outcome==='pending')return new Promise(resolve=>this.pendingPlays.push(resolve));return Promise.resolve();
  }
  pause() { this.pauseCalls++;this.paused=true; }
  load() { this.loadCalls++; }
  toBlob(callback, type = 'image/png') { callback(new Blob(['offline-png-test-only'], {type})); }
  toDataURL(type = 'image/png') { return `data:${type};base64,b2ZmbGluZS10ZXN0LW9ubHk=`; }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return true; }
  scrollIntoView() {}
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; }
  matches(selector) { return selector.split(',').some(part => {
    part = part.trim();
    if(part==='*')return true;
    const attributes=[...part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)];
    if(attributes.some(([,name,value])=>this.getAttribute(name)===null||(value!==undefined&&this.getAttribute(name)!==value)))return false;
    part=part.replace(/\[[^\]]*\]/g,'');
    if(!part)return true;
    const id=part.match(/#([\w-]+)/)?.[1];if(id&&id!==this.id)return false;
    const classes=[...part.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
    if(classes.some(name=>!this.classList.contains(name)))return false;
    const tag=part.match(/^[a-z][\w-]*/i)?.[0];
    return !tag||tag.toLowerCase()===this.tagName.toLowerCase();
  }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(element => selector === '*' || element.matches(selector));
  }
}
const window = new Target();
const document = new Target();
document.parentNode = window;
document.body = new Element('body'); document.body.parentNode = document;
document.documentElement = new Element('html'); document.activeElement = document.body;
document.hidden = false; document.visibilityState = 'visible'; document.readyState = 'complete';
document.getElementById = id => {
  if (!elements.has(id)) { const element = new Element(id.toLowerCase().includes('canvas') ? 'canvas' : 'div', id); element.parentNode = document; elements.set(id, element); }
  return elements.get(id);
};
document.createElement = tag => {const element=new Element(tag);if(String(tag).toLowerCase()==='audio')audioElements.push(element);return element;};
document.createElementNS = (_, tag) => new Element(tag);
document.createDocumentFragment = () => new Element('fragment');
document.querySelector = selector => /^#[\w-]+$/.test(selector) ? document.getElementById(selector.slice(1)) : document.querySelectorAll(selector)[0] || null;
document.querySelectorAll = selector => {
  const parts = selector.trim().split(/\s+/);
  if (parts.length > 1) {
    let roots = document.querySelectorAll(parts.shift());
    for (const part of parts) roots = roots.flatMap(root => root.querySelectorAll(part));
    return roots;
  }
  return [...new Set([...elements.values(), ...document.body.querySelectorAll('*')])].filter(element => element.matches(selector));
};
for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid\s*=\s*["']([^"']+)["'][^>]*)>/gi)) {
  const element = new Element(match[1], match[3]); element.parentNode = document;
  for (const attr of match[2].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)) element.setAttribute(attr[1], attr[2]);
  elements.set(match[3], element);
}
// A lightweight tree parser supplies real child selectors (banner/upgrade cards).
// Script/style text is omitted; the scripts are executed separately below.
const bodyMarkup = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html)
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
const stack = [document.body];
for (const match of bodyMarkup.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
  const [, close, tag, attrs] = match;
  if (close) {
    const index = stack.findLastIndex(node => node.tagName.toLowerCase() === tag.toLowerCase());
    if (index > 0) stack.length = index;
    continue;
  }
  const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
  const element = id ? elements.get(id) : new Element(tag);
  for (const attr of attrs.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)) element.setAttribute(attr[1], attr[2]);
  for (const name of ['hidden', 'disabled']) if (new RegExp(`(?:^|\\s)${name}(?:\\s|=|$)`).test(attrs)) element[name] = true;
  stack.at(-1).appendChild(element);
  if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag) && !attrs.endsWith('/')) stack.push(element);
}
const audioAllocations={context:0,gain:0,oscillator:0,bufferSource:0,filter:0,panner:0,mediaSource:0,decode:0};
const audioSources=[];
function audioNode() {
  const finite=args=>args.forEach(value=>{if(typeof value==='number')assert.ok(Number.isFinite(value),'Audio scheduled a non-finite numeric value');});
  const param = () => {let value=0;return {get value(){return value;},set value(next){finite([next]);value=next;},setValueAtTime(next,...args){finite([next,...args]);this.value=next;},linearRampToValueAtTime(next,...args){finite([next,...args]);this.value=next;},exponentialRampToValueAtTime(next,...args){finite([next,...args]);this.value=next;},setTargetAtTime(next,...args){finite([next,...args]);this.value=next;},cancelScheduledValues(...args){finite(args);}};};
  return {starts:[],stops:[],connect() {}, disconnect() {}, start(...args){finite(args);this.starts.push(args);},stop(...args){finite(args);this.stops.push(args);},addEventListener() {},gain:param(),frequency:param(),Q:param(),playbackRate:param(),detune:param(),threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),pan:param()};
}
class AudioContext {
  constructor() { audioAllocations.context++;this.state = 'running'; this.sampleRate = 44100; this.destination = audioNode(); }
  get currentTime() { return clock / 1000; }
  createGain() { audioAllocations.gain++;return audioNode(); }
  createOscillator() { audioAllocations.oscillator++;const node=audioNode();audioSources.push(node);return node; }
  createBufferSource() { audioAllocations.bufferSource++;const node=audioNode();audioSources.push(node);return node; }
  createBiquadFilter() { audioAllocations.filter++;return audioNode(); }
  createStereoPanner() { audioAllocations.panner++;return audioNode(); }
  createDynamicsCompressor() { return audioNode(); }
  createWaveShaper() { return audioNode(); }
  createMediaElementSource(element) { audioAllocations.mediaSource++;return {...audioNode(),mediaElement:element}; }
  decodeAudioData(buffer) { assert.ok(buffer.byteLength>0,'Audio decoder received no sample bytes');audioAllocations.decode++;return decodeAudioHandler(buffer); }
  createBuffer(channels, length) { return {getChannelData: () => new Float32Array(length)}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}
const storage = new Map();
const schedule = (fn, delay = 0, repeat = false) => { const id = ++sequence; timers.set(id, {fn, at: clock + Number(delay), delay: Number(delay), repeat}); return id; };
const seededMath = Object.create(Math);
seededMath.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
Object.assign(window, {
  window, self: window, globalThis: window, document,
  innerWidth: Number(process.env.SMOKE_WIDTH || 1280), innerHeight: Number(process.env.SMOKE_HEIGHT || 900), devicePixelRatio: 1,
  navigator: {hardwareConcurrency: 8, deviceMemory: 8, userAgent: 'Offline Node smoke harness'},
  location: {protocol: 'https:', href: 'https://offline.invalid/game.html', origin: 'https://offline.invalid'},
  performance: {now: () => clock}, Math: seededMath, console, AudioContext,
  URL, URLSearchParams, Blob, File,
  Event: FakeEvent, CustomEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent,
  HTMLElement: Element, HTMLCanvasElement: Element, HTMLInputElement: Element,
  Path2D: class {moveTo() {} lineTo() {} arc() {} closePath() {}},
  localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)},
  crypto: {randomUUID: () => 'offline-smoke-test-only'},
  requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
  cancelAnimationFrame: id => frames.delete(id),
  setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
  setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
  matchMedia: query => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}}),
  getComputedStyle: element => ({...element.style, getPropertyValue: key => element.style[key] || ''}),
  ResizeObserver: class {observe() {} disconnect() {}},
  open: (url, target, features) => { externalActions.push({kind:'open',url,target,features});return {closed:false,close(){this.closed=true;}}; },
  fetch: async (url, options = {}) => {
    requests.push({url: String(url), method: options.method || 'GET', ...(options.body?{body:JSON.parse(options.body)}:{})});
    if(/\/audio\/|^data:audio\//.test(String(url)))return assetFetchHandler(String(url),options);
    const response=await fetchHandler(String(url),options);
    return response?.json?response:{ok:true,status:200,json:async()=>response};
  },
});
const context = vm.createContext(window);
const run = source => vm.runInContext(source, context, {timeout: 3000});
const activeVideo=()=>run('BreachClip.activeVideo()');
const evaluate = source => window.__gameTest.evaluate(source);
const exists = name => evaluate(`typeof ${name} !== 'undefined'`);
const state = () => JSON.parse(evaluate(`JSON.stringify({running,gameOver,score,wave,frame,spawnTimer,player:{x:player.x,y:player.y,cooldown:player.cooldown,targetX:player.targetX},bullets:bullets.length,enemies:enemies.length,airstrikeWarning:typeof airstrikeWarning==='undefined'?null:airstrikeWarning,dragging:typeof dragging==='undefined'?null:dragging,artilleryTimer:typeof artillery==='undefined'?null:artillery.timer,keys:typeof keys==='undefined'?{}:keys})`));
function dispatch(target, type, init = {}) { target.dispatchEvent(new FakeEvent(type, init)); }
function key(keyName, down, target = document.body) {
  const code = keyName === ' ' ? 'Space' : /^[a-z]$/i.test(keyName) ? 'Key' + keyName.toUpperCase() : /^\d$/.test(keyName) ? 'Digit' + keyName : keyName;
  dispatch(target, down ? 'keydown' : 'keyup', {key: keyName, code, repeat: false});
}
function tick(count = 1) {
  for (let n = 0; n < count; n++) {
    clock += 1000 / 60;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) {
      if (timer.repeat) timer.at += Math.max(timer.delay, 1); else timers.delete(id);
      timer.fn();
    }
    const callbacks = [...frames.values()]; frames.clear();
    for (const fn of callbacks) fn(clock);
  }
}
function elapseTimers(milliseconds) {
  clock+=milliseconds;
  for(const [id,timer] of [...timers])if(timer.at<=clock){
    if(timer.repeat)timer.at=clock+Math.max(timer.delay,1);else timers.delete(id);
    timer.fn();
  }
}
function start() { document.getElementById('startBtn').click(); }
function check(name, fn) {
  try { const detail = fn(); results.push({test: name, status: 'PASS', ...(detail ? {detail} : {})}); }
  catch (error) { results.push({test: name, status: 'FAIL', error: error.stack}); }
}
async function checkAsync(name, fn) {
  try { const detail=await fn();results.push({test:name,status:'PASS',...(detail?{detail}:{})}); }
  catch(error) { results.push({test:name,status:'FAIL',error:error.stack}); }
}
async function flushMicrotasks() { for(let index=0;index<8;index++)await Promise.resolve(); }
function regression(name, passes, detail) {
  if (!passes) warnings.push({test: name, detail});
  else results.push({test: name, status: 'PASS'});
}

check('inline scripts and initial draw', () => {
  inlineScripts.forEach((source, index) => vm.runInContext(source, context, {filename: `${filename}:script${index + 1}`, timeout: 5000}));
  assert.ok(window.__gameTest); assert.ok(drawCalls > 0); evaluate('draw()');
  assert.ok(Number.isFinite(state().player.x));
  assert.equal(audioAllocations.context,0,'Initial page created audio hardware before a gesture');assert.equal(audioElements.length,2,'Initial page did not preload both supplied music recordings');assert.ok(audioElements.every(el=>el.playCalls===0),'Initial page attempted audible playback');
  return `${drawCalls} canvas calls; ${inlineScripts.length} scripts`;
});
if (window.__gameTest) {
  await checkAsync('both ending decoders prime muted once and late warm-up cannot interrupt an active ending',async()=>{
    const captain=document.getElementById('breachVideo'),soldier=document.getElementById('soldierVideo'),next=document.getElementById('breachContinue'),still=document.getElementById('breachStill');
    const videos=[captain,soldier],counts=videos.map(video=>video.playCalls);
    for(const video of videos)video.playOutcomes=['pending'];
    run('BreachClip.prepare();BreachClip.prepare()');
    videos.forEach((video,index)=>{assert.equal(video.playCalls,counts[index]+1);assert.equal(video.playHistory.at(-1).muted,true);assert.equal(video.controls,false);assert.equal(video.hidden,true);});
    assert.equal(run('BreachClip.isOpen()'),false);assert.equal(next.hidden,true);
    for(const video of videos){dispatch(video,'ended',{bubbles:false});dispatch(video,'error',{bubbles:false});}assert.equal(next.hidden,true,'Priming media events opened a completion state');
    run("BreachClip.show(()=>{},'soldier')");assert.equal(activeVideo(),soldier);soldier.currentTime=.3;
    videos.forEach(video=>video.pendingPlays.shift()());await flushMicrotasks();
    assert.equal(captain.paused,true);assert.equal(captain.currentTime,0);assert.equal(soldier.paused,false,'Late warm-up paused the selected clip');assert.equal(soldier.currentTime,.3,'Late warm-up rewound the selected clip');
    dispatch(captain,'ended',{bubbles:false});dispatch(captain,'error',{bubbles:false});captain.currentTime=99;dispatch(captain,'timeupdate',{bubbles:false});
    assert.equal(next.hidden,true);assert.equal(still.hidden,true,'Inactive media event replaced the active clip');
    dispatch(soldier,'ended',{bubbles:false});assert.equal(next.hidden,false);next.click();
    const warmedCounts=videos.map(video=>video.playCalls);run('BreachClip.prepare()');await flushMicrotasks();videos.forEach((video,index)=>assert.equal(video.playCalls,warmedCounts[index],'Already warmed decoder was played again'));
  });
  check('music and effects mute independently, persist their preferences and restore on a new audio instance',()=>{
    const audioSource=html.slice(html.indexOf('const AudioCore ='),html.indexOf('const MusicEngine ='));
    const probe=()=>run('(function(){'+audioSource+';return AudioCore;})()');
    const musicButton=document.getElementById('musicToggle'),sfxButton=document.getElementById('sfxToggle');
    run('AudioCore.ensure();AudioCore.setMusicMuted(false);AudioCore.setSfxMuted(false)');
    musicButton.click();assert.equal(run('AudioCore.isMusicMuted()'),true);assert.equal(run('AudioCore.isSfxMuted()'),false);
    assert.equal(run('AudioCore.musicGain().gain.value'),0);assert.ok(run('AudioCore.sfxGain().gain.value')>0);
    assert.equal(musicButton.getAttribute('aria-pressed'),'false');assert.equal(sfxButton.getAttribute('aria-pressed'),'true');
    assert.deepEqual(JSON.parse(storage.get('tidebreak.audio.v1')),{musicMuted:true,sfxMuted:false});
    let restored=probe();assert.equal(restored.isMusicMuted(),true);assert.equal(restored.isSfxMuted(),false);
    sfxButton.click();assert.equal(run('AudioCore.isMusicMuted()'),true);assert.equal(run('AudioCore.isSfxMuted()'),true);
    musicButton.click();assert.equal(run('AudioCore.isMusicMuted()'),false);assert.equal(run('AudioCore.isSfxMuted()'),true);
    assert.ok(run('AudioCore.musicGain().gain.value')>0);assert.equal(run('AudioCore.sfxGain().gain.value'),0);
    assert.deepEqual(JSON.parse(storage.get('tidebreak.audio.v1')),{musicMuted:false,sfxMuted:true});
    restored=probe();restored.ensure();assert.equal(restored.isMusicMuted(),false);assert.equal(restored.isSfxMuted(),true);assert.equal(restored.sfxGain().gain.value,0);
    start();assert.equal(run('AudioCore.isSfxMuted()'),true,'Restart reset a saved audio preference');
    storage.set('tidebreak.audio.v1','invalid json');restored=probe();assert.equal(restored.isMusicMuted(),false);assert.equal(restored.isSfxMuted(),false);
    run('AudioCore.setMusicMuted(false);AudioCore.setSfxMuted(false);MusicEngine.stop()');
  });
  await checkAsync('recorded effects preload once, decode once, and never queue delayed shots',async()=>{
    run('SFX.stopAll();AudioCore.setSfxMuted(false)');
    const sources=audioSources.length,decodeBefore=audioAllocations.decode;
    assert.equal(run('SFX.laser()'),false,'An unready sample emitted a fallback or delayed shot');
    const first=run('SFX.preload()'),second=run('SFX.preload()');assert.equal(first,second,'Parallel preload requests were not deduplicated');await first;
    const status=JSON.parse(run('JSON.stringify(SFX.status())'));assert.equal(status.ready,12);assert.equal(status.total,12);assert.deepEqual(status.failed,[]);assert.equal(status.active,0);
    assert.equal(audioAllocations.decode-decodeBefore,12);assert.equal(requests.filter(item=>/\/audio\/sfx-|^data:audio\//.test(item.url)).length,12);assert.equal(audioSources.length,sources,'A skipped shot played late after decoding');
    await run('SFX.preload()');assert.equal(audioAllocations.decode-decodeBefore,12);
    for(const method of ['laser','sniper','mortar','artillery','flare','radio','jetFlyby']){run('SFX.stopAll()');assert.equal(run(`SFX.${method}()`),true,'Recorded '+method+' did not play');}
    run('SFX.stopAll()');assert.equal(run('SFX.machineGun(16/60)'),true);
    for(const size of ['small','medium','big']){run('SFX.stopAll()');assert.equal(run(`SFX.explosion('${size}')`),true);}
    assert.equal(audioAllocations.oscillator,0,'Recorded effects retained synthesized tones');run('SFX.stopAll()');
  });
  await checkAsync('muted channels allocate no sound voices and music remains independent from effects',async()=>{
    run('AudioCore.setMusicMuted(true);AudioCore.setSfxMuted(true);MusicEngine.play("march")');
    let before=JSON.stringify(audioAllocations);
    run('SFX.laser();SFX.machineGun(16/60);SFX.sniper();SFX.mortar();SFX.artillery();SFX.explosion("big");SFX.flare();SFX.radio();SFX.jetFlyby()');
    assert.equal(JSON.stringify(audioAllocations),before,'Muted SFX still built audio nodes');
    for(let i=0;i<30;i++)elapseTimers(100);
    assert.equal(JSON.stringify(audioAllocations),before,'Muted music still scheduled sound voices');
    run('MusicEngine.setPaused(false);MusicEngine.setVisible(true);AudioCore.setMusicMuted(false)');await flushMicrotasks();
    assert.equal(document.getElementById('battleMusicAudio').paused,false,'Unmuting music did not resume the supplied recording');assert.equal(run('AudioCore.isSfxMuted()'),true);assert.equal(audioAllocations.oscillator,0);
    run('AudioCore.setSfxMuted(false);MusicEngine.stop()');
  });
  await checkAsync('cached music recordings stream independently with no duplicate elements or stale-play overlap',async()=>{
    run('MusicEngine.stop();MusicEngine.setPaused(false);MusicEngine.setVisible(true);AudioCore.setMusicMuted(false);MusicEngine.prepare()');
    const menu=document.getElementById('menuMusicAudio'),battle=document.getElementById('battleMusicAudio'),count=audioElements.length;
    assert.equal(count,2,'Music did not reuse exactly two streaming elements');assert.equal(menu.loop,true);assert.equal(battle.loop,true);assert.equal(menu.controls,false);assert.equal(battle.controls,false);
    const loads=[menu.loadCalls,battle.loadCalls];run('MusicEngine.prepare();MusicEngine.prepare()');assert.deepEqual([menu.loadCalls,battle.loadCalls],loads,'Music preparation reloads cached recordings');
    run('MusicEngine.play("menu")');await flushMicrotasks();menu.currentTime=7;
    assert.equal(menu.paused,false);assert.equal(battle.paused,true);
    run('MusicEngine.play("march")');await flushMicrotasks();battle.currentTime=11;assert.equal(menu.paused,true);assert.equal(battle.paused,false);
    run('MusicEngine.setPaused(true)');assert.equal(battle.paused,true);assert.equal(battle.currentTime,11);run('MusicEngine.setPaused(false)');await flushMicrotasks();assert.equal(battle.paused,false);assert.equal(battle.currentTime,11);
    run('MusicEngine.setVisible(false)');assert.ok(menu.paused&&battle.paused);run('MusicEngine.setVisible(true)');await flushMicrotasks();assert.equal(battle.paused,false);
    run('AudioCore.setMusicMuted(true)');assert.ok(menu.paused&&battle.paused);run('AudioCore.setMusicMuted(false)');await flushMicrotasks();assert.equal(battle.paused,false);
    run('MusicEngine.stop()');battle.playOutcomes=['pending'];run('MusicEngine.play("march");MusicEngine.play("march")');battle.pendingPlays.shift()();await flushMicrotasks();assert.equal(battle.paused,false,'Repeated current-track requests invalidated their own pending play');
    run('MusicEngine.stop()');menu.playOutcomes=['pending'];battle.playOutcomes=['pending'];run('MusicEngine.play("menu");MusicEngine.play("march")');menu.pendingPlays.shift()();battle.pendingPlays.shift()();await flushMicrotasks();assert.equal(menu.paused,true);assert.equal(battle.paused,false);
    assert.equal(audioElements.length,count);assert.ok(audioAllocations.mediaSource<=2,'Repeated scene changes created duplicate media sources');assert.equal(audioAllocations.oscillator,0);run('MusicEngine.stop()');
  });
  await checkAsync('music autoplay rejection is quiet, retries only on gestures, and cannot interrupt an ending',async()=>{
    dispatch(document.getElementById('startBtn'),'pointerdown');await flushMicrotasks();
    const battle=document.getElementById('battleMusicAudio');run('MusicEngine.stop();MusicEngine.setPaused(false)');battle.playOutcomes=['reject'];run('MusicEngine.play("march")');await flushMicrotasks();
    assert.equal(run('MusicEngine.status().tracks.march.blocked'),true);const attempts=battle.playCalls;for(let i=0;i<10;i++)elapseTimers(100);assert.equal(battle.playCalls,attempts,'Autoplay rejection created a retry loop');
    dispatch(window,'pointerdown');await flushMicrotasks();assert.equal(battle.paused,false);assert.equal(run('MusicEngine.status().tracks.march.blocked'),false);
    run('MusicEngine.stop()');battle.playOutcomes=['pending'];run('MusicEngine.play("march");BreachClip.show(()=>{},"soldier")');battle.pendingPlays.shift()();await flushMicrotasks();assert.ok(audioElements.every(el=>el.paused),'A late music promise played underneath an ending');assert.equal(run('MusicEngine.current()'),null);run('BreachClip.reset();MusicEngine.stop()');
  });
  check('sample voices enforce rate limits, per-kind limits, reserved support capacity and idempotent cleanup',()=>{
    run('SFX.stopAll();AudioCore.setSfxMuted(false)');const before=audioSources.length;
    assert.equal(run('SFX.laser()'),true);assert.equal(run('SFX.laser()'),false,'Rifle rate limit did not suppress duplicate same-tick shots');
    for(let i=0;i<3;i++){elapseTimers(70);assert.equal(run('SFX.laser()'),true);}elapseTimers(70);assert.equal(run('SFX.laser()'),false,'Rifle per-kind voice limit exceeded');
    for(const method of ['mortar','artillery'])for(let i=0;i<2;i++){elapseTimers(150);assert.equal(run(`SFX.${method}()`),true);}
    for(let i=0;i<2;i++){elapseTimers(60);assert.equal(run('SFX.explosion("small")'),true);}
    assert.equal(run('SFX.status().active'),10);assert.equal(run('SFX.flare()'),false,'Ordinary combat exceeded its voice budget');assert.equal(run('SFX.radio()'),true);assert.equal(run('SFX.jetFlyby()'),true);assert.equal(run('SFX.status().active'),12);
    assert.equal(audioSources.length-before,12);run('SFX.stopAll();SFX.stopAll()');audioSources.slice(before).forEach(source=>{source.onended?.();source.onended?.();});assert.equal(run('SFX.status().active'),0);
    const sources=audioSources.length;document.hidden=true;assert.equal(run('SFX.laser()'),false);document.hidden=false;assert.equal(audioSources.length,sources);assert.equal(run('SFX.laser()'),true);run('AudioCore.setSfxMuted(true)');assert.equal(run('SFX.status().active'),0);run('AudioCore.setSfxMuted(false)');
  });
  check('machine gun cadence profiles and sniper use distinct natural-pitch recordings',()=>{
    run('SFX.stopAll();AudioCore.setSfxMuted(false)');
    const shoot=(expression,profile)=>{const before=audioSources.length;assert.equal(run(expression),true);assert.equal(audioSources.length,before+1);assert.equal(run('SFX.status().lastGunProfile'),profile);const source=audioSources.at(-1);assert.equal(source.playbackRate.value,1,'Firearm recording was pitch-shifted');return source;};
    const normal=shoot('SFX.machineGun(16/60)','standard');run('SFX.stopAll()');
    const rapid=shoot('SFX.machineGun(4/60)','rapid');run('SFX.stopAll()');
    const sniper=shoot('SFX.sniper()','sniper');
    assert.notEqual(normal.buffer,rapid.buffer,'Normal and rapid fire reuse the same take');assert.notEqual(normal.buffer,sniper.buffer,'Machine gun and sniper reuse the same recording');assert.notEqual(rapid.buffer,sniper.buffer);
    run('SFX.stopAll()');const fastA=shoot('SFX.machineGun(10/60)','fast');elapseTimers(170);const fastB=shoot('SFX.machineGun(10/60)','fast');assert.notEqual(fastA.buffer,fastB.buffer,'Upgraded cadence does not alternate its two real takes');
    run('SFX.stopAll()');document.hidden=true;const count=audioSources.length;assert.equal(run('SFX.machineGun(4/60)'),false);assert.equal(run('SFX.sniper()'),false);assert.equal(audioSources.length,count);document.hidden=false;
  });
  check('maximum-rate gunfire never skips a round through stale tails or exceeds the bounded mixer',()=>{
    run('SFX.stopAll();AudioCore.setSfxMuted(false)');let previous=audioSources.length;
    for(let i=0;i<180;i++){
      assert.equal(run('SFX.machineGun(4/60)'),true,'Rapid-fire sound missing at round '+i);assert.equal(audioSources.length,++previous);assert.ok(run('SFX.status().active')<=12);
      assert.equal(run('SFX.machineGun(4/60)'),false,'Duplicate same-tick shot was audible');elapseTimers(67);
    }
    run('SFX.stopAll()');assert.equal(run('SFX.status().active'),0);
  });
  check('player gun transients keep priority under a full mixer without stealing radio or jet voices',()=>{
    run('SFX.stopAll();AudioCore.setSfxMuted(false)');
    for(let i=0;i<4;i++){assert.equal(run('SFX.laser()'),true);elapseTimers(70);}
    for(const method of ['mortar','artillery'])for(let i=0;i<2;i++){assert.equal(run(`SFX.${method}()`),true);elapseTimers(150);}
    for(let i=0;i<2;i++){assert.equal(run('SFX.explosion("small")'),true);elapseTimers(60);}
    assert.equal(run('SFX.radio()'),true);const radio=audioSources.at(-1);assert.equal(run('SFX.jetFlyby()'),true);const jet=audioSources.at(-1);const stopCounts=[radio.stops.length,jet.stops.length];
    assert.equal(run('SFX.status().active'),12);assert.equal(run('SFX.machineGun(4/60)'),true);assert.ok(run('SFX.status().active')<=12);
    assert.deepEqual([radio.stops.length,jet.stops.length],stopCounts,'Incoming firearm cut a priority support recording');
    run('AudioCore.setSfxMuted(true)');assert.equal(run('SFX.status().active'),0);run('AudioCore.setSfxMuted(false)');
  });
  check('weapon events select actual rounded cadence once per volley and never sound blocked shots',()=>{
    start();evaluate('waveRest=100000;enemies=[]');run('SFX.stopAll()');
    run('globalThis.__gunCalls=[];globalThis.__savedMachineGun=SFX.machineGun;globalThis.__savedSniper=SFX.sniper;SFX.machineGun=(...args)=>__gunCalls.push({kind:"machine",args});SFX.sniper=(...args)=>__gunCalls.push({kind:"sniper",args})');
    try{
      evaluate('player.cooldown=0;upgrades.cadence=0;player.rapidTimer=0;bullets=[];applyPowerup("spread5");fireBullet()');
      let calls=JSON.parse(run('JSON.stringify(__gunCalls)'));assert.equal(calls.length,1);assert.equal(calls[0].kind,'machine');assert.equal(calls[0].args[0],16/60);assert.equal(state().bullets,5);
      evaluate('fireBullet()');assert.equal(run('__gunCalls.length'),1,'Cooldown-blocked volley emitted a sound');
      evaluate('player.cooldown=0;upgrades.cadence=4;fireBullet()');calls=JSON.parse(run('JSON.stringify(__gunCalls)'));assert.equal(calls[1].args[0],10/60);
      evaluate('player.cooldown=0;player.rapidTimer=20;fireBullet()');calls=JSON.parse(run('JSON.stringify(__gunCalls)'));assert.equal(calls[2].args[0],4/60);
      evaluate('toggleSniper();sniper.cooldown=0;floatingPassengers=[];fireSniper()');calls=JSON.parse(run('JSON.stringify(__gunCalls)'));assert.equal(calls.length,4);assert.equal(calls[3].kind,'sniper');
      evaluate('fireSniper()');assert.equal(run('__gunCalls.length'),4,'Reload-blocked sniper emitted a sound');
      for(const call of calls)assert.ok(call.args.every(Number.isFinite),'Firearm event supplied non-finite audio parameters');
    }finally{run('SFX.machineGun=__savedMachineGun;SFX.sniper=__savedSniper;delete globalThis.__gunCalls;delete globalThis.__savedMachineGun;delete globalThis.__savedSniper;SFX.stopAll()');}
  });
  await checkAsync('missing or undecodable effects fail quietly without retries, delayed playback or breaking other samples',async()=>{
    const source=html.slice(html.indexOf('const SFX ='),html.indexOf('const AudioSettings =')),requests=[];
    let index=0;const fakeFetch=async url=>{requests.push(url);const sample=index++;return sample===0?{ok:false,status:404}:{ok:true,arrayBuffer:async()=>new ArrayBuffer(sample===1?1:64)};};
    const originalDecode=decodeAudioHandler;decodeAudioHandler=async bytes=>{if(bytes.byteLength===1)throw new Error('Simulated malformed sample');return originalDecode(bytes);};
    try{
      const probe=new Function('AudioCore','document','window','fetch',source+';return SFX;')(run('AudioCore'),{hidden:false,addEventListener(){}},new Target(),fakeFetch);
      const before=audioSources.length;assert.equal(probe.laser(),false);await probe.preload();await probe.preload();
      assert.equal(probe.status().ready,10);assert.equal(probe.status().total,12);assert.equal(probe.status().failed.length,2);assert.equal(requests.length,12);assert.equal(audioSources.length,before,'Failed sample triggered delayed playback');
      assert.equal(probe.laser(),false);assert.equal(probe.artillery(),true);probe.stopAll();probe.stopAll();assert.equal(probe.status().active,0);await probe.preload();assert.equal(requests.length,12,'Missing sample created a retry loop');
    }finally{decodeAudioHandler=originalDecode;}
  });
  await checkAsync('native music fallback preserves independent mute and unaffected-track recovery after a media error',async()=>{
    const source=html.slice(html.indexOf('const MusicEngine ='),html.indexOf('const SFX =')),media=[],events=new Target();let muted=false;
    const fakeDocument={hidden:false,createElement(){const el=new Element('audio');media.push(el);return el;},body:{appendChild(){}}};
    const audio={ensure:()=>null,resume(){},isMusicMuted:()=>muted};
    const probe=new Function('AudioCore','document','window',source+';return MusicEngine;')(audio,fakeDocument,events);
    assert.equal(media.length,2);assert.ok(media.every(el=>el.playCalls===0));probe.play('menu');await flushMicrotasks();assert.equal(media[0].paused,false);assert.equal(media[0].volume,.56);
    muted=true;dispatch(events,'audiopreferenceschange');assert.ok(media.every(el=>el.paused));muted=false;dispatch(events,'audiopreferenceschange');await flushMicrotasks();assert.equal(media[0].paused,false);
    dispatch(media[0],'error',{bubbles:false});assert.equal(media[0].paused,true);const attempts=media[0].playCalls;probe.play('menu');assert.equal(media[0].playCalls,attempts,'Failed music entered a hot playback loop');
    probe.play('march');await flushMicrotasks();assert.equal(media[1].paused,false,'A failed menu recording disabled the battle recording');assert.equal(probe.status().tracks.menu.error,true);probe.stop();
  });
  await checkAsync('rapid leaderboard transitions never overlap menu and battle music and paused scenes retain their position',async()=>{
    start();evaluate('waveRest=100000;enemies=[]');await flushMicrotasks();const menu=document.getElementById('menuMusicAudio'),battle=document.getElementById('battleMusicAudio');battle.currentTime=23;
    for(let i=0;i<10;i++){
      run('Leaderboard.open()');assert.ok(menu.paused||battle.paused,'Opening rankings overlaps the two recordings');assert.equal(run('MusicEngine.current()'),'menu');
      run('Leaderboard.close()');assert.ok(menu.paused||battle.paused,'Closing rankings overlaps the two recordings');assert.equal(run('MusicEngine.current()'),'march');
    }
    await flushMicrotasks();assert.equal(menu.paused,true);assert.equal(battle.paused,false);assert.equal(battle.currentTime,23);
    run('AudioSettings.open()');assert.equal(battle.paused,true);run('AudioSettings.close()');await flushMicrotasks();assert.equal(battle.paused,false);assert.equal(battle.currentTime,23);
    run('AudioCore.setMusicMuted(true)');run('Leaderboard.open();Leaderboard.close()');assert.ok(menu.paused&&battle.paused);run('AudioCore.setMusicMuted(false)');await flushMicrotasks();assert.equal(battle.paused,false);run('MusicEngine.stop();SFX.stopAll()');
  });
  check('ending playback cuts live effect tails and repeated cleanup cannot corrupt the voice budget',()=>{
    run('MusicEngine.stop();AudioCore.setSfxMuted(false);SFX.stopAll()');
    let before=audioSources.length;run('SFX.explosion("big");SFX.jetFlyby();SFX.radio()');
    const active=audioSources.slice(before);assert.ok(active.length>0,'No effects were emitted for cleanup test');
    run("BreachClip.show(()=>{},'soldier')");assert.ok(active.every(node=>node.stops.some(args=>args.length===0)),'An old effect tail continued beneath the clip');
    run('BreachClip.reset();SFX.stopAll()');active.forEach(node=>{node.onended?.();node.onended?.();});
    for(let i=0;i<20;i++){
      before=audioSources.length;run('SFX.jetFlyby();SFX.stopAll();SFX.stopAll()');
      const emitted=audioSources.slice(before);assert.equal(emitted.length,1,'Cleanup leaked or corrupted SFX voice capacity');emitted.forEach(node=>node.onended?.());
    }
  });
  check('start, keyboard movement/fire, 300 update/draw frames', () => {
    start(); assert.equal(state().running, true);
    const initialX = state().player.x; key('ArrowRight', true); key(' ', true);
    evaluate('update();draw()');
    assert.ok(state().player.x > initialX); assert.ok(state().bullets > 0);
    key('ArrowRight', false);
    for (let index = 1; index < 300; index++) { if (state().running) evaluate('update()'); evaluate('draw()'); }
    key(' ', false);
    return state();
  });
  check('reset clears entities, score, weapons', () => {
    evaluate('resetGame();draw()');
    const current = state();
    assert.equal(current.score, 0); assert.equal(current.wave, 1); assert.equal(current.gameOver, false);
    assert.equal(current.bullets, 0); assert.equal(current.enemies, 0); assert.equal(current.artilleryTimer, 0);
  });
  check('help freezes simulation and resumes', () => {
    start(); tick(5); run('GameHelp.open()'); const before = state(); tick(30);
    assert.equal(state().running, false); assert.equal(state().spawnTimer, before.spawnTimer);
    run('GameHelp.close()'); assert.equal(state().running, true);
  });
  check('leaderboard pause regression', () => {
    start(); tick(5); run('Leaderboard.open()'); const before = state(); tick(30);
    regression('leaderboard freezes simulation', state().spawnTimer === before.spawnTimer && !state().running, 'Opening leaderboard leaves the live run advancing beneath it.');
    run('Leaderboard.close()');
  });
  check('focus/input regressions', () => {
    start(); key('ArrowRight', true); dispatch(window, 'blur');
    regression('blur clears held keys', !Object.values(state().keys).some(Boolean), 'Held controls survive window blur; lost keyup can leave movement/fire stuck.');
    key('ArrowRight', false); start();
    const input = document.getElementById('callsignInput'); input.focus(); key('a', true, input);
    regression('editable field ignores gameplay keys', !state().keys.a, 'Typing in callsign is recorded as gameplay movement.'); key('a', false, input); input.blur();
  });
  check('pointer hold and cancel regressions', () => {
    start(); const canvas = document.getElementById('gameCanvas');
    dispatch(canvas, 'pointerdown', {clientX: canvas.clientWidth / 2, clientY: canvas.clientHeight - 100, pointerId: 1, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true});
    evaluate('bullets=[];player.cooldown=0');
    for (let index = 0; index < 20; index++) evaluate('update()');
    regression('held pointer autofires', state().bullets > 0, 'Pointerdown fires only once; holding/dragging does not continue firing.');
    dispatch(window, 'pointercancel', {pointerId: 1});
    regression('pointercancel releases drag', !state().dragging && state().player.targetX == null, 'Cancelled touch leaves dragging/target active.');
    dispatch(window, 'pointerup', {pointerId: 1});
  });
  check('artillery targets and fires', () => {
    if (!exists('activateArtillery')) return 'Skipped: no artillery feature';
    start(); evaluate('activateArtillery();spawnEnemy()');
    let sawShell = false;
    for (let index = 0; index < 100; index++) { evaluate('update();draw()'); sawShell ||= evaluate('bullets.some(b=>b.artillery)'); }
    assert.ok(sawShell, 'No artillery shell fired at active target');
  });
  check('reset clears transient controls and warnings', () => {
    start(); key('ArrowRight', true);
    if (exists('airstrikeWarning')) evaluate('airstrikeWarning=30');
    if (exists('dragging')) evaluate('dragging=true');
    evaluate('resetGame();draw()'); const current = state();
    regression('reset clears held keys', !Object.values(current.keys).some(Boolean), 'resetGame retains previous run held keys.');
    regression('reset clears drag', !current.dragging, 'resetGame retains previous run dragging state.');
    regression('reset clears airstrike warning', !current.airstrikeWarning, 'resetGame retains an obsolete airstrike warning after clearing its scheduled blast.');
    key('ArrowRight', false);
  });
  if (exists('started')) {
    const frozenSnapshot = () => evaluate('JSON.stringify({frame,playTicks,spawnTimer,waveRest,player,sniper,environment,weatherSchedule,bullets,hostileShots,enemies,powerups,particles,mines,scheduledBlasts,explosionsFx,waterRipples,oilSlicks,wrecks,floatingPassengers,bloodSprays,hedgehogs,floatingText,artillery,airstrikeWarning,comboTimer,bannerTimer,airstrikeRun:typeof airstrikeRun==="undefined"?null:airstrikeRun,mortarEmplacements:typeof mortarEmplacements==="undefined"?null:mortarEmplacements,illuminationFlares:typeof illuminationFlares==="undefined"?null:illuminationFlares,flareSupply:typeof flareSupply==="undefined"?null:flareSupply})');
    check('audio settings open without changing preferences and pause/resume the live action',()=>{
      start();const preferences=run('JSON.stringify([AudioCore.isMusicMuted(),AudioCore.isSfxMuted()])');
      document.getElementById('muteBtn').click();assert.equal(run('AudioSettings.isOpen()'),true);assert.equal(state().running,false);
      assert.equal(run('JSON.stringify([AudioCore.isMusicMuted(),AudioCore.isSfxMuted()])'),preferences,'Opening settings muted channels');
      const frozen=frozenSnapshot();tick(60);assert.equal(frozenSnapshot(),frozen,'Audio settings did not freeze gameplay');
      run('AudioSettings.close()');assert.equal(state().running,true);assert.equal(run('AudioSettings.isOpen()'),false);
      key('p',true);key('p',false);run('AudioSettings.open();AudioSettings.close()');assert.equal(state().running,false,'Closing audio settings cancelled a pre-existing pause');key('p',true);key('p',false);
    });
    check('manual pause fully freezes simulation and weapon clocks', () => {
      start(); evaluate("applyPowerup('spread3');applyPowerup('spread5');activateArtillery();spawnEnemy();spawnExplosion(100,100,'#fff')");
      tick(3); key('p', true); key('p', false);
      assert.equal(state().running, false); const frozen = frozenSnapshot(); tick(60);
      assert.equal(frozenSnapshot(), frozen, 'Paused gameplay state changed');
      key('p', true); key('p', false); assert.equal(state().running, true); tick(2);
      assert.notEqual(frozenSnapshot(), frozen, 'Resumed game did not advance');
    });
    check('help and leaderboard completely freeze the simulation', () => {
      for (const controller of ['GameHelp', 'Leaderboard']) {
        start(); evaluate("applyPowerup('spread3');activateArtillery();spawnEnemy()"); tick(3);
        run(`${controller}.open()`); const frozen = frozenSnapshot(); tick(60);
        assert.equal(frozenSnapshot(), frozen, `${controller} did not freeze all state`);
        run(`${controller}.close()`); assert.equal(state().running, true);
      }
    });
    check('Escape closes modal and resumes without opening pause panel', () => {
      for (const controller of ['GameHelp', 'Leaderboard']) {
        start(); run(`${controller}.open()`); key('Escape', true); key('Escape', false);
        regression(`${controller} Escape resumes game`, state().running && !evaluate('paused'), 'Escape bubbles from the modal close handler into the game pause handler and pauses again.');
      }
    });
    check('3-way/5-way timers, shot counts, fallback and expiration', () => {
      start(); evaluate("waveRest=100000;applyPowerup('spread3');fireBullet()");
      assert.equal(evaluate('player.spread3Timer'), 1200); assert.equal(state().bullets, 3);
      evaluate("bullets=[];player.cooldown=0;applyPowerup('spread5');fireBullet()");
      assert.equal(evaluate('player.spread5Timer'), 600); assert.equal(state().bullets, 5);
      for (let index = 0; index < 600; index++) evaluate('update()');
      assert.equal(evaluate('player.spread5Timer'), 0); assert.equal(evaluate('player.spread3Timer'), 600);
      assert.equal(evaluate('activeSpreadLevel()'), 1);
      evaluate('bullets=[];player.cooldown=0;fireBullet()'); assert.equal(state().bullets, 3);
      for (let index = 0; index < 600; index++) evaluate('update()');
      assert.equal(evaluate('activeSpreadLevel()'), 0);
      evaluate('bullets=[];player.cooldown=0;fireBullet()'); assert.equal(state().bullets, 1);
    });
    check('cleared waves auto-advance once with banner and uninterrupted held fire', () => {
      start(); key(' ', true); key('ArrowRight', true);
      evaluate('dragging=true;waveSpawned=waveQuota;enemies=[];waveRest=0;update();draw()');
      assert.equal(state().running, true); assert.equal(state().wave, 2);
      assert.equal(evaluate('waveSpawned'), 0); assert.equal(evaluate('waveRest'), 90);
      assert.equal(evaluate('upgrades.cadence'), 1); assert.equal(state().keys[' '], true);
      assert.equal(state().keys.ArrowRight, true); assert.equal(state().dragging, true);
      assert.equal(elements.has('upgradePanel'), false, 'Blocking upgrade panel remains in document');
      assert.ok(document.getElementById('waveBanner').classList.contains('show'));
      assert.match(document.getElementById('waveBanner').querySelector('strong').textContent, /02/);
      assert.match(document.getElementById('waveBanner').querySelector('small').textContent, /FASTER RIFLE/);
      evaluate('bullets=[];player.cooldown=0;update()'); assert.ok(state().bullets>0);
      assert.equal(state().wave, 2); assert.equal(evaluate('upgrades.cadence'), 1, 'Reward applied twice');
      key(' ', false); key('ArrowRight', false); dispatch(window, 'pointerup');
      for (let index=0;index<250;index++) evaluate('update()');
      assert.ok(state().enemies>0, 'Next wave did not spawn automatically');
    });
    check('automatic requisitions rotate, cap at four and fall back to capped supplies', () => {
      start();
      for(let index=0;index<12;index++) evaluate('advanceWave()');
      assert.equal(evaluate('JSON.stringify(upgrades)'), JSON.stringify({cadence:4,velocity:4,mobility:4}));
      evaluate('advanceWave()');assert.equal(evaluate('inventory.cluster'),1);
      evaluate('inventory.cluster=9;advanceWave()');assert.equal(evaluate('inventory.cluster'),9);
    });
    check('horizon spawn uses scaled collision bounds and does not mutate shared types', () => {
      start(); evaluate("waveRest=100000;spawnEnemy();enemies[0].speed=0;enemies[0].type.family='rowboat'");
      assert.equal(evaluate('enemies[0].y'),evaluate('HORIZON_Y+5'));
      const horizonScale=evaluate('boatShoreScale(enemies[0].baseType)*.10');
      assert.equal(evaluate('enemies[0].depthScale'),horizonScale);
      assert.equal(evaluate('enemies[0].type.w'),evaluate('enemies[0].baseType.w')*horizonScale);
      assert.equal(evaluate('enemies[0].type.h'),evaluate('enemies[0].baseType.h')*horizonScale);
      assert.equal(evaluate('enemies[0].type===enemies[0].baseType'),false);
      evaluate("{const e=enemies[0];e.hp=e.maxHp=5;bullets=[{x:e.x+e.type.w+2,y:e.y+e.type.h/2,vx:0,vy:0,r:2,damage:1}];update();}");
      assert.equal(evaluate('enemies[0].hp'),5,'Invisible full-size hull absorbed a shot');
      evaluate("{const e=enemies[0];bullets=[{x:e.x+e.type.w/2,y:e.y+e.type.h/2,vx:0,vy:0,r:2,damage:1}];update();draw();}");
      assert.equal(evaluate('enemies[0].hp'),4,'Visible projected hull did not absorb a shot');
      const baseWidth=evaluate('enemies[0].baseType.w');
      evaluate('enemies[0].approach=.5;positionApproachingBoat(enemies[0]);draw()');
      assert.ok(evaluate('enemies[0].depthScale')>horizonScale);assert.equal(evaluate('enemies[0].baseType.w'),baseWidth);
    });
    check('fast rifle segment hits a horizon hull before its endpoint is culled', () => {
      start();
      evaluate("waveRest=100000;spawnEnemy();{const e=enemies[0],base=ENEMY_TYPES.find(t=>t.family==='rowboat'&&t.tierIndex===0);e.baseType=base;e.type={...base};e.approach=0;e.speed=0;e.hp=e.maxHp=5;positionApproachingBoat(e);bullets=[{x:e.x+e.type.w/2,y:e.y+e.type.h+.5,vx:0,vy:-13.2,r:2.2,damage:1}];update();}");
      assert.equal(evaluate('enemies[0].hp'),4,'The swept path crossed the tiny hull but horizon culling discarded it before collision');
    });
    check('every projected boat can eventually reach shore on short and tall viewports', () => {
      const stranded=JSON.parse(evaluate(`JSON.stringify(ENEMY_TYPES.flatMap(baseType=>[.1,.5,.9].flatMap(lane=>{
        const boat={baseType,type:{...baseType},lane,wobble:0,approach:0};
        for(let step=0;step<=400;step++){
          boat.approach=step/200;positionApproachingBoat(boat);
          if(boat.y+boat.type.h*.98>=shoreAt(boat.x+boat.type.w/2))return [];
        }
        return [baseType.name+' lane '+lane];
      })))`));
      assert.deepEqual(stranded,[],'Projected hulls never cross the shoreline: '+stranded.join(', '));
      const aboveHorizon=JSON.parse(evaluate(`JSON.stringify(ENEMY_TYPES.flatMap(baseType=>[0,.5,1].flatMap(approach=>{
        const boat={baseType,type:{...baseType},lane:.5,wobble:0,approach};positionApproachingBoat(boat);
        return boat.y<HORIZON_Y?[baseType.name+' approach '+approach]:[];
      })))`));
      assert.deepEqual(aboveHorizon,[],'Projected boat crossed above the horizon');
    });
    check('shoreline boats and passengers retain one shared soldier-relative scale', () => {
      start();
      const invalid=JSON.parse(evaluate(`JSON.stringify(ENEMY_TYPES.flatMap(baseType=>{
        const boat={baseType,type:{...baseType},lane:.5,wobble:0,approach:1};positionApproachingBoat(boat);
        const expected=baseType.lengthM/SOLDIER_METRES*WATER_FORESHORTENING;
        return Math.abs(boat.type.h/player.h-expected)>1e-10?[baseType.name]:[];
      }))`));
      assert.deepEqual(invalid,[],'Boat/soldier scale varied by viewport or family');
      const sizes=JSON.parse(evaluate(`JSON.stringify(ENEMY_TYPES.map(baseType=>{const e={baseType,type:{...baseType},lane:.5,wobble:0,approach:1};positionApproachingBoat(e);return passengerWorldSize(e)/player.h;}))`));
      assert.ok(sizes.every(size=>Math.abs(size-6/46)<1e-10),'Passenger head size depends on boat tier instead of distance');
      assert.ok(evaluate('player.w===30*worldScale&&player.h===SOLDIER_HEIGHT*worldScale'),'Soldier hitbox is not world scaled');
    });
    const prepareGunboat = () => {
      start(); evaluate("waveRest=100000;spawnEnemy();{const e=enemies[0],base=ENEMY_TYPES.find(t=>t.family==='lifeboat');e.baseType=base;e.type={...base};e.approach=.6;e.lane=.5;e.speed=0;e.fireCooldown=0;e.fireWindup=0;positionApproachingBoat(e);e.prevX=e.x;e.prevY=e.y;}");
    };
    check('lifeboat fire locks aim, warns for 60 ticks and emits one shot per cooldown', () => {
      prepareGunboat(); evaluate('updateCounterfire()');
      assert.equal(evaluate('enemies[0].fireWindup'),60);assert.equal(evaluate('hostileShots.length'),0);
      const aim=evaluate('JSON.stringify([enemies[0].aimX,enemies[0].aimY])');
      evaluate('player.x=0');
      for(let index=0;index<59;index++)evaluate('updateCounterfire()');
      assert.equal(evaluate('hostileShots.length'),0);assert.equal(evaluate('enemies[0].fireWindup'),1);
      assert.equal(evaluate('JSON.stringify([enemies[0].aimX,enemies[0].aimY])'),aim,'Aim tracked the dodge');
      evaluate('updateCounterfire();draw()');assert.equal(evaluate('hostileShots.length'),1);
      assert.equal(evaluate('enemies[0].fireWindup'),0);
      assert.ok(evaluate('enemies[0].fireCooldown')>=420&&evaluate('enemies[0].fireCooldown')<600);
      const cooldown=evaluate('enemies[0].fireCooldown');
      for(let index=0;index<30;index++)evaluate('updateCounterfire()');
      assert.equal(evaluate('enemies[0].fireCooldown'),cooldown-30);
      assert.ok(evaluate('hostileShots.length')<=1);
    });
    check('non-lifeboats cannot fire and destroying an aiming boat cancels its shot', () => {
      prepareGunboat();evaluate("enemies[0].type.family='rowboat';updateCounterfire()");
      assert.equal(evaluate('enemies[0].fireWindup'),0);assert.equal(evaluate('hostileShots.length'),0);
      evaluate("enemies[0].type.family='lifeboat';updateCounterfire();enemies=[]");
      for(let index=0;index<70;index++)evaluate('updateCounterfire()');
      assert.equal(evaluate('hostileShots.length'),0);
    });
    check('return-fire global cap includes warnings and live shots', () => {
      prepareGunboat();
      evaluate("{const e=enemies[0];enemies=Array.from({length:7},(_,i)=>({...e,type:{...e.type},x:e.x+i*3,fireCooldown:0,fireWindup:0}));updateCounterfire();}");
      assert.equal(evaluate('enemies.filter(e=>e.fireWindup>0).length'),3);
      evaluate('player.x=0');for(let index=0;index<60;index++)evaluate('updateCounterfire()');
      assert.equal(evaluate('hostileShots.length'),3);
      assert.equal(evaluate('enemies.filter(e=>e.fireWindup>0).length'),0);
    });
    check('stationary player is hit by return fire and a lateral dodge survives', () => {
      prepareGunboat();evaluate('updateCounterfire()');
      for(let index=0;index<360&&!state().gameOver;index++)evaluate('updateCounterfire()');
      assert.equal(state().gameOver,false);assert.equal(state().running,true);
      assert.equal(evaluate('player.lives'),2,'One projectile should cost exactly one life');
      prepareGunboat();evaluate('updateCounterfire();player.x=0');
      for(let index=0;index<360;index++)evaluate('updateCounterfire()');
      assert.equal(state().gameOver,false);assert.equal(evaluate('hostileShots.length'),0);
      assert.equal(evaluate('player.lives'),3,'Dodging a round should preserve all lives');
    });
    const hitSoldier = () => evaluate("{const pose=getPlayerPose(),x=pose.hitX,y=pose.hitY;hostileShots=[{x,y:y-20,px:x,py:y-20,vx:0,vy:40,aimX:x,aimY:y+100,life:20}];updateCounterfire();draw();}");
    check('three projectile hits end the run and immunity prevents stacked damage', () => {
      start();evaluate('waveRest=100000;enemies=[]');assert.equal(evaluate('player.lives'),3);
      hitSoldier();assert.equal(evaluate('player.lives'),2);assert.equal(evaluate('player.hitInvulnerability'),90);assert.equal(state().gameOver,false);
      assert.equal(document.getElementById('livesVal').textContent,'2/3 · HOP');assert.equal(document.getElementById('dashBtn').textContent,'HOP BOOST · SHIFT');
      hitSoldier();assert.equal(evaluate('player.lives'),2,'Immediate second round bypassed immunity');assert.equal(evaluate('hostileShots.length'),0);
      for(let index=0;index<89;index++)evaluate('update()');assert.equal(evaluate('player.hitInvulnerability'),1);
      hitSoldier();assert.equal(evaluate('player.lives'),2,'Last immune frame accepted damage');
      evaluate('update()');hitSoldier();assert.equal(evaluate('player.lives'),1);assert.equal(state().running,true);
      assert.equal(document.getElementById('livesVal').textContent,'1/3 · CRAWL');assert.equal(document.getElementById('dashBtn').disabled,true);
      for(let index=0;index<90;index++)evaluate('update()');hitSoldier();
      assert.equal(evaluate('player.lives'),0);assert.equal(state().gameOver,true);assert.equal(state().running,false);
      assert.match(document.querySelector('#overlay h1').innerHTML,/Soldier/);
      assert.equal(run('BreachClip.isOpen()'),true,'Third projectile hit must play the soldier clip');
      const video=activeVideo();
      assert.ok(String(video.src||video.getAttribute('src'))===run('BreachClip.clips.soldier.src'),'Third hit selected the wrong clip');
      assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),false,'Rankings must wait for the death clip Continue button');
    });
    check('projectile immunity pauses with play and resets to three lives', () => {
      start();evaluate('waveRest=100000;enemies=[]');hitSoldier();
      key('p',true);key('p',false);const frozen=frozenSnapshot();tick(120);assert.equal(frozenSnapshot(),frozen);
      key('p',true);key('p',false);evaluate('update()');assert.equal(evaluate('player.hitInvulnerability'),89);
      start();assert.equal(evaluate('player.lives'),3);assert.equal(evaluate('player.hitInvulnerability'),0);
      evaluate('spawnEnemy();triggerGameOver(enemies[0])');assert.equal(state().gameOver,true,'Three lives incorrectly prevented a shoreline breach');
      assert.equal(evaluate('player.lives'),3);assert.equal(run('BreachClip.isOpen()'),true);
    });
    check('injury stages align visible poses, weapon origins, movement and hittable body', () => {
      const speeds=[];
      for(const lives of [3,2,1]){
        start();evaluate(`waveRest=100000;enemies=[];player.lives=${lives};player.x=W*.45;player.runBlend=1;player.runPhase=.9;`);
        key('ArrowRight',true);const x=evaluate('player.x');evaluate('update()');key('ArrowRight',false);
        speeds.push(evaluate('player.x')-x);
        const pose=JSON.parse(evaluate('JSON.stringify(getPlayerPose())'));
        assert.equal(pose.stage,3-lives);
        for(const field of ['x','y','groundY','muzzleX','muzzleY','hitX','hitY','hitW','hitH'])assert.ok(Number.isFinite(pose[field]),field+' is not finite');
        assert.ok(pose.hitW>0&&pose.hitH>0);
        if(lives===1)assert.ok(pose.hitW>pose.hitH,'Crawling collision body should be wider than it is tall');
        evaluate('player.cooldown=0;bullets=[];fireBullet()');
        assert.equal(evaluate('bullets[0].x'),pose.muzzleX);assert.equal(evaluate('bullets[0].y'),pose.muzzleY);
        for(const facing of [-1,1]){
          evaluate(`player.facing=${facing};player.runBlend=1;player.runPhase=.9`);
          const before=frozenSnapshot(),trace=[];canvasTrace=trace;try{evaluate('drawPlayer();drawPlayer()');}finally{canvasTrace=null;}
          assert.equal(frozenSnapshot(),before,'Injury drawing mutates gameplay');assert.ok(trace.length>20);
        }
        evaluate('player.hitInvulnerability=0');hitSoldier();assert.equal(evaluate('player.lives'),lives-1,'Injured pose is not hittable');
      }
      assert.ok(speeds[0]>speeds[1]&&speeds[1]>speeds[2]&&speeds[2]>0,'Run, hop and crawl should get progressively slower but remain mobile');
      assert.ok(Math.abs(speeds[1]/speeds[0]-.72)<1e-9);assert.ok(Math.abs(speeds[2]/speeds[0]-.42)<1e-9);
      for(const [lives,boost] of [[3,2.6],[2,1.6]]){
        start();evaluate(`waveRest=100000;enemies=[];player.lives=${lives};player.x=W*.45;player.dashCooldown=0;dash()`);
        key('ArrowRight',true);const x=evaluate('player.x');evaluate('update()');key('ArrowRight',false);
        assert.ok(Math.abs((evaluate('player.x')-x)/speeds[3-lives]-boost)<1e-9,'Injury-specific dash boost changed');
      }
      start();evaluate('player.lives=1;player.dashCooldown=0;dash()');assert.equal(evaluate('player.dashTimer'),0,'Crawling must not use a standing sprint');
      start();assert.equal(evaluate('getPlayerPose().stage'),0);assert.equal(evaluate('player.lives'),3);
    });
    check('soldier animation follows travelled distance, settles at walls and survives direction/injury transitions',()=>{
      for(const lives of [3,2,1]){
        start();evaluate(`waveRest=100000;enemies=[];player.lives=${lives};player.x=W*.4;clearInput();keys.ArrowRight=true;for(let i=0;i<12;i++)update()`);
        assert.ok(evaluate('player.animVelocity')>0&&evaluate('player.runPhase')>0&&evaluate('player.runBlend')>.9);
        const movingPhase=evaluate('player.runPhase');evaluate('clearInput();keys.ArrowLeft=true;update()');
        assert.equal(evaluate('player.facing'),-1);assert.equal(evaluate('player.animTurn'),1);assert.ok(evaluate('player.runPhase')>movingPhase,'Reversing changed gait time backwards');
        evaluate('for(let i=0;i<12;i++)update()');assert.ok(evaluate('player.animVelocity')<0&&evaluate('player.lean')<0);
        evaluate('player.x=0');const wallPhase=evaluate('player.runPhase');evaluate('for(let i=0;i<120;i++)update()');
        assert.equal(evaluate('player.x'),0);assert.equal(evaluate('player.runPhase'),wallPhase,'Blocked soldier runs in place');assert.ok(evaluate('player.runBlend')<1e-8);assert.ok(Math.abs(evaluate('player.animVelocity'))<1e-8);
        evaluate('clearInput();player.targetX=W*.5;update()');assert.ok(evaluate('player.x')>0&&evaluate('player.runPhase')>wallPhase,'Pointer movement does not animate');
        evaluate('player.targetX=null;clearInput();for(let i=0;i<120;i++)update()');const idle=evaluate('player.runPhase');evaluate('for(let i=0;i<10;i++)update()');assert.equal(evaluate('player.runPhase'),idle);
      }
      start();for(const field of ['runPhase','runBlend','animVelocity','animAcceleration','animTurn','lean'])assert.equal(evaluate('player.'+field),0,'New game kept motion state '+field);assert.equal(evaluate('player.facing'),1);
    });
    check('articulated soldier render remains finite and pure through gait phases, injury transitions, scope and reduced motion',()=>{
      start();const reducedMotionBefore=evaluate('environment.reducedMotion');evaluate('waveRest=100000;enemies=[];clearInput()');
      for(const quality of [0,2])for(const lives of [3,2,1,0])for(const facing of [-1,1]){
        evaluate(`qualityLevel=${quality};player.lives=${lives};player.facing=${facing};player.runBlend=1;player.lean=${facing}*.07;player.recoil=1;player.muzzleFlash=3;`);
        for(let phase=0;phase<16;phase++){
          evaluate(`player.runPhase=${phase}*Math.PI/8`);const before=frozenSnapshot(),randomBefore=seed;
          evaluate('drawPlayer();drawPlayer()');assert.equal(frozenSnapshot(),before,'Rendering advances soldier animation');assert.equal(seed,randomBefore,'Soldier drawing consumes gameplay randomness');
        }
        evaluate('sniper.active=true;sniper.x=player.x;sniper.y=player.y;drawSniperScope();sniper.active=false');
      }
      evaluate('environment.reducedMotion=true;player.lives=2;player.runPhase=3.6;player.runBlend=1;player.muzzleFlash=0;player.recoil=0');
      const pose=JSON.parse(evaluate('JSON.stringify(getPlayerPose())'));
      for(const field of ['bob','hop','compression','torsoSway','shoulderRoll','gearBounce','helmetLag','turn'])assert.ok(pose[field]===0,'Reduced motion retained '+field);
      evaluate(`drawPlayer();environment.reducedMotion=${reducedMotionBefore};resetGame()`);
    });
    check('hostile rounds explode on beach contact once and missed blasts do not kill', () => {
      start();evaluate("waveRest=100000;enemies=[];{const x=W*.1,y=shoreAt(x)+20;hostileShots=[{x,y:y-6,px:x,py:y-6,vx:0,vy:12,aimX:x,aimY:y,life:20}];updateCounterfire();draw();}");
      assert.equal(evaluate('hostileShots.length'),0);assert.equal(state().gameOver,false);
      assert.equal(evaluate("explosionsFx.filter(f=>f.flavor==='sand').length"),1);
      assert.ok(evaluate('particles.length')>0,'Beach blast emitted no particles');
      assert.ok(evaluate("explosionsFx.every(f=>f.y>=shoreAt(f.x))"),'Beach impact rendered offshore');
      const count=evaluate('explosionsFx.length');evaluate('updateCounterfire()');assert.equal(evaluate('explosionsFx.length'),count,'Impact repeated after round removal');
      const before=evaluate('JSON.stringify(particles)');evaluate('updateFx()');assert.notEqual(evaluate('JSON.stringify(particles)'),before);
    });
    check('offshore projectile expiry is silent but a direct soldier hit creates a beach blast', () => {
      start();evaluate("enemies=[];hostileShots=[{x:W*.1,y:HORIZON_Y+20,px:W*.1,py:HORIZON_Y+20,vx:0,vy:1,aimX:W*.1,aimY:SHORE_Y+40,life:1}];updateCounterfire()");
      assert.equal(evaluate('hostileShots.length'),0);assert.equal(evaluate('explosionsFx.length'),0);assert.equal(state().gameOver,false);
      evaluate('player.lives=1');hitSoldier();
      assert.equal(state().gameOver,true);assert.equal(evaluate("explosionsFx.filter(f=>f.flavor==='sand').length"),1);
      const before=evaluate('JSON.stringify(particles)');tick(3);assert.equal(evaluate('JSON.stringify(particles)'),before,'Impact work continued beneath the immediate ending clip');
      assert.equal(run('BreachClip.isOpen()'),true);assert.equal(activeVideo().paused,false);
    });
    check('pause freezes both telegraph timers and fired enemy projectiles', () => {
      prepareGunboat();evaluate('updateCounterfire()');key('p',true);key('p',false);
      let frozen=frozenSnapshot();tick(90);assert.equal(frozenSnapshot(),frozen);
      key('p',true);key('p',false);evaluate('player.x=0');
      for(let index=0;index<60;index++)evaluate('updateCounterfire()');
      assert.equal(evaluate('hostileShots.length'),1);
      run('GameHelp.open()');frozen=frozenSnapshot();tick(90);assert.equal(frozenSnapshot(),frozen);run('GameHelp.close()');
    });
    check('sniper toggle suppresses rifle autofire and returns to rifle controls', () => {
      start();evaluate('waveRest=100000');key(' ',true);key('e',true);key('e',false);
      assert.equal(evaluate('sniper.active'),true);assert.equal(state().keys[' '],false);
      dispatch(document.body,'keydown',{key:'e',code:'KeyE',repeat:true});assert.equal(evaluate('sniper.active'),true);
      evaluate("bullets=[];keys[' ']=true;dragging=true;player.cooldown=0");
      for(let index=0;index<60;index++)evaluate('update()');
      assert.equal(state().bullets,0);assert.equal(evaluate('sniper.shots'),0);
      key(' ',true);assert.equal(evaluate('sniper.shots'),1);
      dispatch(document.body,'keydown',{key:' ',code:'Space',repeat:true});
      for(let index=0;index<70;index++)evaluate('update()');
      assert.equal(evaluate('sniper.shots'),1,'Holding Space autofired the sniper');
      key('e',true);key('e',false);assert.equal(evaluate('sniper.active'),false);
      key(' ',true);evaluate('update()');assert.ok(state().bullets>0);key(' ',false);
    });
    check('sniper point hit rewards once, clear miss preserves targets, reload is 42 ticks', () => {
      start();evaluate("waveRest=100000;toggleSniper();floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:0,size:5,age:12,life:200,maxLife:200,vx:0,vy:0,drift:0}];sniper.x=floatingPassengers[0].x;sniper.y=passengerHeadY(floatingPassengers[0])");
      assert.equal(evaluate('fireSniper()'),true);assert.equal(state().score,15);
      assert.equal(evaluate('sniper.headshots'),1);assert.equal(evaluate('floatingPassengers.length'),0);
      assert.equal(evaluate('sniper.cooldown'),42);assert.equal(evaluate('fireSniper()'),false);
      for(let index=0;index<41;index++)evaluate('update()');
      assert.equal(evaluate('sniper.cooldown'),1);assert.equal(evaluate('fireSniper()'),false);
      evaluate("update();floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:0,size:5,age:12,life:200,maxLife:200,vx:0,vy:0,drift:0}];sniper.x=floatingPassengers[0].x+12;sniper.y=passengerHeadY(floatingPassengers[0])");
      assert.equal(evaluate('fireSniper()'),true);assert.equal(evaluate('floatingPassengers.length'),1);
      assert.equal(state().score,15);assert.equal(evaluate('sniper.headshots'),1);evaluate('draw()');
    });
    check('top-bar headshots increment immediately, stay visible outside scope, ignore misses and reset per run',()=>{
      start();const value=document.getElementById('headshotVal'),hud=document.getElementById('headshotHud');
      assert.equal(value.textContent,'0');assert.equal(hud.getAttribute('aria-label'),'0 headshots');
      evaluate("waveRest=100000;toggleSniper();floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:0,size:5,age:12,life:200,maxLife:200,vx:0,vy:0,drift:0}];sniper.x=floatingPassengers[0].x;sniper.y=passengerHeadY(floatingPassengers[0]);fireSniper()");
      assert.equal(value.textContent,'1');assert.equal(hud.getAttribute('aria-label'),'1 headshot');
      evaluate('toggleSniper()');assert.equal(evaluate('sniper.active'),false);assert.equal(value.textContent,'1');assert.equal(hud.hidden,false);
      evaluate("toggleSniper();sniper.cooldown=0;sniper.x=0;fireSniper()");assert.equal(value.textContent,'1','A miss incremented the HUD');
      evaluate("sniper.cooldown=0;floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:0,size:5,age:12,life:200,maxLife:200,vx:0,vy:0,drift:0}];sniper.x=floatingPassengers[0].x;sniper.y=passengerHeadY(floatingPassengers[0]);fireSniper()");
      assert.equal(value.textContent,'2');assert.equal(hud.getAttribute('aria-label'),'2 headshots');
      evaluate('resetGame()');assert.equal(value.textContent,'0');assert.equal(hud.getAttribute('aria-label'),'0 headshots');
    });
    check('sniper rejects expired/emerging passengers and only removes nearest eligible head', () => {
      start();evaluate("toggleSniper();sniper.x=W*.5;sniper.y=HORIZON_Y+60;floatingPassengers=[{x:sniper.x,y:sniper.y,phase:0,size:5,age:7,life:100},{x:sniper.x,y:sniper.y,phase:0,size:5,age:20,life:0}];fireSniper()");
      assert.equal(state().score,0);assert.equal(evaluate('floatingPassengers.length'),2);
      evaluate("sniper.cooldown=0;floatingPassengers=[{x:sniper.x+1.5,y:sniper.y,phase:0,size:5,age:20,life:100},{x:sniper.x,y:sniper.y,phase:0,size:5,age:20,life:100}];fireSniper()");
      assert.equal(evaluate('floatingPassengers.length'),1);assert.equal(evaluate('floatingPassengers[0].x'),evaluate('sniper.x+1.5'));
      assert.equal(state().score,15);
    });
    check('sniper pointer aims in world coordinates without moving or dragging the soldier', () => {
      start();key('e',true);key('e',false);const canvas=document.getElementById('gameCanvas');
      const x=canvas.clientWidth*.37,y=canvas.clientHeight*.45,before=state().player.x;
      dispatch(canvas,'pointermove',{clientX:x,clientY:y,pointerId:1});
      assert.ok(Math.abs(evaluate('sniper.x')-evaluate('W*.37'))<.001);
      assert.ok(Math.abs(evaluate('sniper.y')-evaluate('H*.45'))<.001);
      dispatch(canvas,'pointerdown',{clientX:x,clientY:y,pointerId:1,button:0,buttons:1});
      assert.equal(evaluate('sniper.shots'),1);assert.equal(state().dragging,false);assert.equal(state().player.targetX,null);
      assert.equal(state().player.x,before);evaluate('draw()');
    });
    check('high-resolution scope redraws the world at optical scale with exact central-reticle alignment', () => {
      start();evaluate('toggleSniper();sniper.x=W*.37;sniper.y=H*.45;cameraShake=0;draw()');
      const geometry=JSON.parse(evaluate('JSON.stringify(sniperScopeGeometry())'));
      assert.equal(geometry.cx,evaluate('W*.5'));assert.ok(geometry.radius>=evaluate('Math.min(W,H)*.38'));
      assert.equal(geometry.zoom,4);assert.equal(document.getElementById('gameCanvas').style.cursor,'none');
      const before=frozenSnapshot(),lens=evaluate('scopeCanvas');
      const trace=[];canvasTrace=trace;try{evaluate('drawSniperScope()');}finally{canvasTrace=null;}
      assert.equal(frozenSnapshot(),before,'Scope rendering mutated simulation state');
      assert.equal(evaluate("ctx===canvas.getContext('2d')"),true,'Scope left the active drawing context redirected');
      assert.equal(trace.some(item=>item.method==='drawImage'&&item.args[0]===document.getElementById('gameCanvas')),false,'Scope enlarged the low-resolution main canvas instead of redrawing detail');
      const source=trace.find(item=>item.canvas===lens&&item.method==='setTransform'&&item.args[0]>geometry.zoom*.95);
      assert.ok(source,'Scope did not render with an optical-scale world transform');
      const ratio=lens.width/(geometry.radius*2),scale=ratio*geometry.zoom;
      assert.ok(Math.abs(source.args[0]-scale)<.03);assert.ok(Math.abs(source.args[3]-scale)<.03);
      assert.ok(Math.abs(source.args[4]+evaluate('sniper.x')*scale-lens.width/2)<.03,'Horizontal aim and reticle diverge');
      assert.ok(Math.abs(source.args[5]+evaluate('sniper.y')*scale-lens.height/2)<.03,'Vertical aim and reticle diverge');
      assert.ok(trace.filter(item=>item.canvas===lens&&item.method==='arc').length>10,'No vector world detail rendered into the optical canvas');
      assert.ok(lens.width*lens.height<=1450000,'Scope exceeded its bounded raster budget');
      const mask=trace.find(item=>item.method==='fillRect'&&item.fillStyle==='#020507'&&item.args[0]===0&&item.args[1]===0&&item.args[2]===evaluate('W')&&item.args[3]===evaluate('H'));
      assert.ok(mask,'Outside field of view was not completely masked');
      assert.ok(trace.indexOf(source)<trace.indexOf(mask),'Scope world was not rendered before the outer mask');
      assert.ok(trace.some(item=>item.method==='arc'&&item.args[0]===geometry.cx&&item.args[1]===geometry.cy&&item.args[2]===geometry.radius));
      assert.ok(trace.some(item=>item.method==='clip'),'Magnified view was not clipped to a circle');
      assert.equal(evaluate(`(()=>{const original=renderWorldScene;let calls=0;try{renderWorldScene=(...args)=>{calls++;return original(...args);};draw();return calls;}finally{renderWorldScene=original;}})()`),1,'Sniper mode rendered the whole world twice per frame');
      assert.equal(evaluate(`(()=>{const original=renderWorldScene;try{renderWorldScene=()=>{throw new Error('test-only render failure');};try{drawSniperScope();}catch{}return ctx===canvas.getContext('2d');}finally{renderWorldScene=original;}})()`),true,'Failed lens render leaked its context into the main renderer');
      key('e',true);key('e',false);const inactive=[];canvasTrace=inactive;try{evaluate('drawSniperScope()');}finally{canvasTrace=null;}
      assert.equal(inactive.length,0,'Leaving scope left a mask over the normal view');
    });
    check('polished sea, hulls and explosion layers stay finite, bounded and pure under repeated normal/scope rendering',()=>{
      start();evaluate('waveRest=100000;enemies=[];for(let i=0;i<12;i++){spawnEnemy();const e=enemies.at(-1);e.baseType=ENEMY_TYPES[i];e.type={...e.baseType};e.passengerSpots=buildPassengerLayout(e.type);e.approach=[.02,.3,.65,1][i%4];e.lane=.1+(i%4)*.25;positionApproachingBoat(e);e.prevX=e.x;e.prevY=e.y;}for(let i=0;i<30;i++)spawnExplosionFx(W*.5,H*.45,"large",i%2?"water":"fire");');
      assert.ok(evaluate('explosionsFx.length<=LIMITS.explosions'));
      for(const quality of [0,1,2])for(const age of [0,8,30,60]){
        evaluate(`qualityLevel=${quality};explosionsFx.forEach(f=>f.age=${age});sniper.active=false;draw()`);
        const before=frozenSnapshot(),randomBefore=seed;
        evaluate('for(let i=0;i<2;i++)renderWorldScene()');
        assert.equal(frozenSnapshot(),before,'Normal graphics changed simulation state');assert.equal(seed,randomBefore,'Drawing consumed game randomness');
        evaluate('sniper.active=true;sniper.x=W*.5;sniper.y=H*.45;drawSniperScope()');
        const scoped=frozenSnapshot();evaluate('drawSniperScope();drawSniperScope()');assert.equal(frozenSnapshot(),scoped,'Scope graphics changed simulation state');
        assert.equal(evaluate("ctx===canvas.getContext('2d')"),true,'Effects leaked a redirected drawing context');
        assert.ok(evaluate('scopeCanvas.width*scopeCanvas.height<=1450000'));
      }
      evaluate('resetGame()');
    });
    check('fictional passengers animate arms and render their target head at the shared anchor', () => {
      start();evaluate("floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:.5,size:5,age:25,life:200,maxLife:200,vx:0,vy:0,drift:0}]");
      const render=()=>{const trace=[];canvasTrace=trace;try{evaluate('drawFloatingPassengers()');}finally{canvasTrace=null;}return trace;};
      const first=render(),headY=evaluate('passengerHeadY(floatingPassengers[0])'),radius=evaluate('passengerHeadRadius(floatingPassengers[0])');
      assert.ok(first.some(item=>item.method==='translate'&&item.args[0]===evaluate('W*.5')&&item.args[1]===headY),'Passenger detail is not centered on its target anchor');
      assert.ok(first.some(item=>item.method==='ellipse'&&item.args[0]===0&&item.args[1]===0&&item.args[2]<=radius&&item.args[2]>radius*.8&&item.args[3]<=radius),'Face extended beyond its gameplay head circle');
      assert.ok(first.filter(item=>item.method==='lineTo').length>=6,'Silhouette has no articulated body/arms');
      evaluate('floatingPassengers[0].age+=12');const second=render();
      assert.notDeepEqual(first.filter(item=>item.method==='lineTo').map(item=>item.args),second.filter(item=>item.method==='lineTo').map(item=>item.args),'Passenger limbs did not animate');
      evaluate('floatingPassengers[0].life=20');assert.ok(evaluate('passengerHeadY(floatingPassengers[0])')>headY,'Passenger did not submerge near expiry');
    });
    check('passenger identities are seeded and persistent while detailed rendering stays finite and pure',()=>{
      start();const rngBefore=seed;
      const appearances=JSON.parse(evaluate('JSON.stringify(Array.from({length:160},(_,i)=>createPassengerAppearance(100+i*31)))'));
      assert.equal(seed,rngBefore,'Appearance generation consumed combat randomness');
      assert.ok(new Set(appearances.map(a=>JSON.stringify(a))).size>150,'Fictional appearances did not vary');
      assert.ok(new Set(appearances.map(a=>a.skin)).size>=6);assert.ok(new Set(appearances.map(a=>a.hairStyle)).size===6);
      for(const a of appearances){for(const color of ['skin','skinShade','skinLight','hair','shirt','shirtShade'])assert.match(a[color],/^#[0-9a-f]{6}$/i);assert.ok(Number.isInteger(a.hairStyle)&&a.hairStyle>=0&&a.hairStyle<=5);assert.ok(a.headWidth>=.86&&a.headWidth<=1);assert.ok(a.headHeight>=.92&&a.headHeight<=1);assert.ok(a.eyeSpacing>=.24&&a.eyeSpacing<=.32);assert.equal(typeof a.facialHair,'boolean');}
      assert.deepEqual(JSON.parse(evaluate('JSON.stringify(createPassengerAppearance(100))')),appearances[0]);
      evaluate('spawnEnemy();enemies[0].approach=.75;positionApproachingBoat(enemies[0]);releasePassengers(enemies[0]);floatingPassengers.forEach(p=>{p.age=30;p.life=200;})');
      assert.ok(evaluate('floatingPassengers.length>0&&floatingPassengers.every(p=>p.appearance)'));
      const identity=evaluate('JSON.stringify(floatingPassengers.map(p=>p.appearance))');
      for(const quality of [0,1,2])for(const size of [.25,1,3,7]){
        evaluate(`qualityLevel=${quality};floatingPassengers.forEach(p=>p.size=${size});`);
        const before=frozenSnapshot(),randomBefore=seed;
        evaluate('drawFloatingPassengers();drawFloatingPassengers()');assert.equal(frozenSnapshot(),before);assert.equal(seed,randomBefore);
        evaluate('sniper.active=true;sniper.x=W*.5;sniper.y=H*.45;drawSniperScope();sniper.active=false');
        assert.equal(evaluate('JSON.stringify(floatingPassengers.map(p=>p.appearance))'),identity,'Drawing changed passenger identity');
      }
      const callsAt=(size,scoped=false)=>{evaluate(`floatingPassengers.forEach(p=>p.size=${size});sniper.active=${scoped}`);const trace=[],before=frozenSnapshot(),anchors=evaluate('JSON.stringify(floatingPassengers.map(p=>[passengerHeadY(p),passengerHeadRadius(p)]))');canvasTrace=trace;try{evaluate('drawFloatingPassengers()');}finally{canvasTrace=null;}assert.equal(frozenSnapshot(),before,'LOD drawing changed passenger age or identity');assert.equal(evaluate('JSON.stringify(floatingPassengers.map(p=>[passengerHeadY(p),passengerHeadRadius(p)]))'),anchors,'LOD changed target anchors');return trace.length;};
      const distant=callsAt(1),near=callsAt(6),scoped=callsAt(1,true);
      assert.ok(distant<near*.6,'Distant passengers retain expensive close-up detail');assert.ok(distant<scoped*.6,'Scope does not restore distant facial detail');evaluate('sniper.active=false');
      evaluate('updateFx()');assert.equal(evaluate('JSON.stringify(floatingPassengers.map(p=>p.appearance))'),identity,'Animation changed passenger identity');
      evaluate('resetGame()');
    });
    check('headshot spray is hit-only, bounded, animated, pause-safe and expires completely', () => {
      start();evaluate("waveRest=100000;toggleSniper();floatingPassengers=[{x:W*.5,y:HORIZON_Y+80,phase:0,size:5,age:30,life:30,maxLife:200,vx:0,vy:0,drift:0}];sniper.x=floatingPassengers[0].x;sniper.y=passengerHeadY(floatingPassengers[0]);fireSniper();draw()");
      assert.ok(evaluate('bloodSprays.length')>=18,'Headshot effect is not clearly denser than the old small spray');assert.equal(evaluate('sniper.headshots'),1);
      assert.ok(evaluate('bloodSprays.every(p=>p.x===sniper.x&&p.y===sniper.y)'),'Spray did not originate at the drawn head');
      const hitCount=evaluate('bloodSprays.length');evaluate('sniper.cooldown=0;sniper.x=0;fireSniper()');assert.equal(evaluate('bloodSprays.length'),hitCount,'Miss emitted a headshot effect');
      key('p',true);key('p',false);const frozen=frozenSnapshot();tick(60);assert.equal(frozenSnapshot(),frozen);
      key('p',true);key('p',false);
      evaluate('for(let i=0;i<30;i++)spawnHeadshotSpray({x:100,y:200,size:6,phase:0,life:100})');assert.ok(evaluate('bloodSprays.length')<=192);
      const before=evaluate('JSON.stringify(bloodSprays)');evaluate('updateFx();drawHeadshotSprays()');assert.notEqual(evaluate('JSON.stringify(bloodSprays)'),before);
      evaluate('for(let i=0;i<60;i++)updateFx();drawHeadshotSprays()');assert.equal(evaluate('bloodSprays.length'),0);
      evaluate('spawnHeadshotSpray({x:100,y:200,size:6,phase:0,life:100});resetGame()');assert.equal(evaluate('bloodSprays.length'),0);
    });
    check('sniper cooldown and environment freeze on pause then reset completely', () => {
      start();evaluate('waveRest=100000;toggleSniper();fireSniper();playTicks=6000;updateEnvironment();draw()');
      key('p',true);key('p',false);const frozen=frozenSnapshot();tick(90);assert.equal(frozenSnapshot(),frozen);
      assert.equal(evaluate('fireSniper()'),false);evaluate('toggleSniper()');assert.equal(evaluate('sniper.active'),true);
      evaluate('resetGame()');
      assert.equal(evaluate('sniper.active'),false);
      for(const field of ['cooldown','flash','hit','shots','headshots'])assert.equal(evaluate('sniper.'+field),0);
      for(const field of ['time','night','dusk','dawn','cloud','rain','snow','fog','weatherIndex'])assert.equal(evaluate('environment.'+field),0);
      assert.equal(evaluate('environment.wind'),.25);assert.equal(run('BreachClip.isOpen()'),false);
    });
    check('seeded random fronts vary between runs while shortened nights preserve daylight in a 251-second cycle', () => {
      start();
      const sequence=seed=>JSON.parse(evaluate(`(()=>{resetEnvironment(${seed});const out=[];for(let i=0;i<12;i++){out.push([weatherSchedule.current.index,weatherSchedule.next.index,weatherSchedule.hold,weatherSchedule.transition,weatherSchedule.next.rain,weatherSchedule.next.snow]);advanceWeatherFront();}return JSON.stringify(out);})()`));
      const plan=sequence(1234);assert.deepEqual(sequence(1234),plan);assert.notDeepEqual(sequence(4321),plan);
      assert.ok(new Set(plan.map(row=>row[1])).size>=4);assert.ok(plan.every(row=>row[0]!==row[1]));
      evaluate('resetEnvironment(1234);playTicks=0');
      const seen=new Set();
      for(let i=0;i<600;i++){
        const previous=JSON.parse(evaluate('JSON.stringify(environment)'));
        evaluate(`playTicks=${i}*60;updateEnvironment()`);seen.add(evaluate('environment.weatherIndex'));
        for(const field of ['cloud','rain','snow','fog','night','dawn','dusk']){
          const value=evaluate('environment.'+field);assert.ok(value>=0&&value<=1,field+' out of bounds');
          assert.ok(Math.abs(value-previous[field])<=.035001,'Weather snapped abruptly: '+field);
        }
      }
      assert.ok(seen.size>=4);assert.equal(evaluate('DAY_CYCLE_SECONDS'),251);
      evaluate('resetEnvironment(1234);playTicks=100*60;for(let i=0;i<200;i++)updateEnvironment();draw()');assert.ok(evaluate('environment.night')<.01);
      evaluate('playTicks=170*60;for(let i=0;i<200;i++)updateEnvironment();draw()');assert.ok(evaluate('environment.night')>.95);
      evaluate('playTicks=251*60;for(let i=0;i<200;i++)updateEnvironment();draw()');assert.ok(evaluate('environment.night')<.01);
    });
    check('rain, snow and mist overlay the sea and beach rather than only the sky', () => {
      start();
      const render=()=>{const trace=[];canvasTrace=trace;try{evaluate('drawEnvironment()');}finally{canvasTrace=null;}return trace;};
      evaluate('environment.rain=1;environment.snow=0;environment.fog=0;environment.time=70');
      const rain=render();
      assert.ok(rain.some(call=>call.method==='lineTo'&&call.strokeStyle==='#c3dfeb'&&call.args[1]>evaluate('SHORE_Y')),'Rain does not reach the beach');
      assert.ok(rain.some(call=>call.method==='lineTo'&&call.strokeStyle==='#c3dfeb'&&call.args[1]<evaluate('HORIZON_Y')),'Rain does not cover the sky');
      evaluate('environment.rain=0;environment.snow=1;environment.fog=0;environment.time=140');
      const snow=render();
      assert.ok(snow.some(call=>call.method==='arc'&&call.fillStyle==='#e8f1ec'&&call.args[1]>evaluate('SHORE_Y')),'Snow does not reach the beach');
      assert.ok(snow.some(call=>call.method==='arc'&&call.fillStyle==='#e8f1ec'&&call.args[1]<evaluate('HORIZON_Y')),'Snow does not cover the sky');
      evaluate('environment.rain=0;environment.snow=0;environment.fog=1;environment.time=105');
      const fog=render(),fogCanvas=evaluate('weatherCache.fog');
      assert.ok(fog.some(call=>call.method==='drawImage'&&call.args[0]===fogCanvas&&call.args[2]+call.args[4]>evaluate('SHORE_Y')),'Mist banks do not obscure nearshore targets');
      assert.ok(fog.some(call=>call.method==='fillRect'&&call.args[0]===0&&call.args[1]===0&&call.args[2]===evaluate('W')&&call.args[3]===evaluate('H')&&call.alpha>=.15),'Mist lacks a full-playfield veil');
    });
    check('wet ground and snow accumulate, persist between conditions and reset cleanly', () => {
      start();
      const forceWeather=(index,rain,snow)=>evaluate(`playTicks=0;weatherSchedule.start=0;weatherSchedule.hold=100000;weatherSchedule.current={index:${index},cloud:.8,rain:${rain},snow:${snow},fog:.1,wind:.3};weatherSchedule.next={...weatherSchedule.current};`);
      forceWeather(2,1,0);evaluate('for(let i=0;i<900;i++)updateEnvironment()');
      assert.ok(evaluate('environment.wetness')>.8);assert.ok(evaluate('environment.snowCover')<.01);
      forceWeather(0,0,0);evaluate('for(let i=0;i<150;i++)updateEnvironment()');assert.ok(evaluate('environment.wetness')>.6,'Puddles vanished immediately after the rain');
      forceWeather(4,0,1);evaluate('for(let i=0;i<1200;i++)updateEnvironment()');assert.ok(evaluate('environment.snowCover')>.8);
      const before=evaluate('JSON.stringify(environment)'),trace=[];canvasTrace=trace;try{evaluate('drawWeatherTerrain()');}finally{canvasTrace=null;}
      assert.equal(evaluate('JSON.stringify(environment)'),before,'Terrain drawing advances weather accumulation');
      assert.ok(trace.some(call=>call.method==='clip'),'Weather terrain is not constrained to the beach');
      assert.ok(trace.filter(call=>call.method==='ellipse').length>20,'Beach surface has no puddles or snow drifts');
      forceWeather(0,0,0);evaluate('for(let i=0;i<150;i++)updateEnvironment()');assert.ok(evaluate('environment.snowCover')>.7,'Snow coverage vanished immediately on clear weather');
      evaluate('resetGame()');assert.equal(evaluate('environment.wetness'),0);assert.equal(evaluate('environment.snowCover'),0);
    });
    check('flares have limited charges, pause-safe lifetime, timed replenishment and scoped targeting', () => {
      start();evaluate('waveRest=100000;toggleSniper();sniper.x=W*.6;sniper.y=HORIZON_Y+(SHORE_Y-HORIZON_Y)*.5');
      key('f',true);key('f',false);assert.equal(evaluate('flareSupply.charges'),2);assert.equal(evaluate('illuminationFlares.length'),1);
      assert.equal(evaluate('illuminationFlares[0].targetX'),evaluate('sniper.x'));assert.equal(evaluate('illuminationFlares[0].targetY'),evaluate('sniper.y'));
      dispatch(document.body,'keydown',{key:'f',code:'KeyF',repeat:true});assert.equal(evaluate('flareSupply.charges'),2,'Held F depleted flare supplies');
      key('p',true);key('p',false);const frozen=frozenSnapshot();tick(60);assert.equal(frozenSnapshot(),frozen);assert.equal(evaluate('deployFlare()'),false);
      key('p',true);key('p',false);evaluate('deployFlare();deployFlare()');assert.equal(evaluate('flareSupply.charges'),0);assert.equal(evaluate('deployFlare()'),false);assert.equal(evaluate('illuminationFlares.length'),3);
      evaluate('for(let i=0;i<960;i++)updateEnvironment()');assert.equal(evaluate('illuminationFlares.length'),0);assert.equal(evaluate('flareSupply.charges'),0);
      evaluate('for(let i=960;i<2100;i++)updateEnvironment()');assert.equal(evaluate('flareSupply.charges'),1);
      evaluate('resetGame()');assert.equal(evaluate('illuminationFlares.length'),0);assert.equal(evaluate('flareSupply.charges'),3);assert.equal(evaluate('flareSupply.recharge'),0);
    });
    check('night darkness contains moving lighthouse openings and localized flare illumination', () => {
      start();evaluate('environment.night=1;environment.time=100;weatherCache.maskKey="";deployFlare();illuminationFlares[0].age=60');
      const before=frozenSnapshot(),trace=[];canvasTrace=trace;try{evaluate('drawLighthouseStructures();drawNightLighting()');}finally{canvasTrace=null;}
      assert.equal(frozenSnapshot(),before,'Night lighting advances flare clocks');
      assert.ok(trace.some(call=>call.method==='fillRect'&&call.composite==='destination-out'),'Flare failed to cut localized light into the darkness');
      assert.ok(trace.filter(call=>call.method==='fill'&&call.composite==='destination-out').length>=2,'Both lighthouses must illuminate sea sectors');
      assert.ok(trace.some(call=>call.method==='drawImage'&&call.args[0]===evaluate('weatherCache.nightMask')&&call.args[3]===evaluate('W')&&call.args[4]===evaluate('H')),'Darkness does not cover the full screen');
      assert.ok(trace.some(call=>call.method==='fillRect'&&call.fillStyle==='rgba(1,7,14,0.84)'),'Night mask must be noticeably darker than the old 61% shade');
      const beam=evaluate('JSON.stringify(lighthouseBeam(lighthousePositions()[0]))');evaluate('environment.time+=10');assert.notEqual(evaluate('JSON.stringify(lighthouseBeam(lighthousePositions()[0]))'),beam,'Lighthouse beam does not sweep');
      evaluate('environment.reducedMotion=true');const steady=evaluate('JSON.stringify(lighthouseBeam(lighthousePositions()[0]))');evaluate('environment.time+=10');assert.equal(evaluate('JSON.stringify(lighthouseBeam(lighthousePositions()[0]))'),steady);evaluate('environment.reducedMotion=false');
    });
    check('mortars launch five finite beach-origin arcs before damaging targets', () => {
      start();evaluate("waveRest=100000;spawnEnemy();{const e=enemies[0];e.approach=.62;e.speed=0;positionApproachingBoat(e);e.prevX=e.x;e.prevY=e.y;e.hp=e.maxHp=4;}inventory.cluster=1;deployCluster()");
      assert.equal(evaluate('inventory.cluster'),0);assert.equal(evaluate('scheduledBlasts.length'),5);assert.equal(state().score,0);assert.equal(state().enemies,1);
      assert.ok(evaluate("scheduledBlasts.every(b=>b.telegraph==='mortar'&&b.mode==='radius'&&b.originY>shoreAt(b.originX)&&b.arc>=80)"));
      assert.ok(evaluate('scheduledBlasts.every(b=>supportShellPoint(b,0).y===b.originY&&supportShellPoint(b,1).y===b.y&&supportShellPoint(b,.5).y<(b.originY+b.y)/2)'));
      const before=frozenSnapshot();evaluate('drawClusterTelegraphs();drawClusterTelegraphs()');assert.equal(frozenSnapshot(),before,'Drawing a shell caused an impact or launch');
      evaluate('for(let i=0;i<71;i++)updateSupportWeapons()');assert.equal(state().enemies,1,'Mortar dealt damage before shell impact');
      evaluate('updateSupportWeapons()');assert.equal(state().enemies,0);assert.ok(state().score>0);assert.ok(evaluate('explosionsFx.length')>0);
      evaluate('for(let i=0;i<100;i++)updateSupportWeapons()');assert.equal(evaluate('scheduledBlasts.length'),0);assert.equal(evaluate('mortarEmplacements.length'),0);
      evaluate('inventory.cluster=9;for(let i=0;i<9;i++)deployCluster()');assert.ok(evaluate('scheduledBlasts.length')<=32);assert.ok(evaluate('mortarEmplacements.length')<=4);
    });
    check('airstrike waits for radio, flies left-to-right and damages only after visible bomb flight', () => {
      start();evaluate("waveRest=100000;spawnEnemy();{const e=enemies[0];e.approach=.62;e.speed=0;positionApproachingBoat(e);e.prevX=e.x;e.prevY=e.y;e.hp=e.maxHp=7;}inventory.airstrike=2;deployAirstrike()");
      assert.equal(evaluate('inventory.airstrike'),1);assert.equal(evaluate('airstrikeRun.age'),0);assert.equal(evaluate('scheduledBlasts.length'),0);assert.equal(state().enemies,1);
      evaluate('deployAirstrike()');assert.equal(evaluate('inventory.airstrike'),1,'Concurrent strike consumed supply');
      key('p',true);key('p',false);const frozen=frozenSnapshot();tick(60);assert.equal(frozenSnapshot(),frozen);key('p',true);key('p',false);
      evaluate('for(let i=0;i<44;i++)updateSupportWeapons()');assert.equal(evaluate('scheduledBlasts.length'),0);assert.equal(evaluate('airstrikeWarning'),1);assert.equal(state().enemies,1);
      const x=evaluate('airstrikeJetPosition(airstrikeRun).x');evaluate('updateSupportWeapons();for(let i=0;i<20;i++)updateSupportWeapons()');assert.ok(evaluate('airstrikeJetPosition(airstrikeRun).x')>x);
      evaluate('while(airstrikeRun&&!scheduledBlasts.length)updateSupportWeapons()');assert.ok(evaluate('scheduledBlasts.length')>0);assert.equal(state().enemies,1,'A bomb hit instantly when released');
      assert.ok(evaluate("scheduledBlasts.every(b=>b.telegraph==='bomb'&&b.mode==='radius'&&b.frames>0&&b.originY<b.y)"));
      const flying=frozenSnapshot();evaluate('drawAirstrikeWarning();drawClusterTelegraphs()');assert.equal(frozenSnapshot(),flying,'Jet render released or detonated payload');
      evaluate('for(let i=0;i<300;i++)updateSupportWeapons()');assert.equal(evaluate('airstrikeRun'),null);assert.equal(evaluate('scheduledBlasts.length'),0);assert.equal(state().enemies,0);assert.ok(state().score>0);
      evaluate('inventory.airstrike=1;deployAirstrike();resetGame()');assert.equal(evaluate('airstrikeRun'),null);assert.equal(evaluate('mortarEmplacements.length'),0);
    });
    check('collision-triggered endings select preloaded media and start before score persistence without reloads',()=>{
      const videos=[document.getElementById('breachVideo'),document.getElementById('soldierVideo')];
      const mediaState=videos.map(video=>({loads:video.loadCalls,writes:video.sourceWrites,source:video.getAttribute('src')}));
      run('globalThis.__originalFinishRun=Leaderboard.finishRun;globalThis.__recordWorkSawPlaying=false;Leaderboard.finishRun=function(...args){globalThis.__recordWorkSawPlaying=BreachClip.isOpen()&&!BreachClip.activeVideo().paused&&document.getElementById("breachClip").classList.contains("open");return globalThis.__originalFinishRun.apply(this,args);};');
      try{
        for(const kind of ['soldier','breach','soldier']){
          start();evaluate(kind==='soldier'?"triggerGameOver(null,'fire')":'spawnEnemy();triggerGameOver(enemies[0])');
          assert.equal(window.__recordWorkSawPlaying,true,'Records work ran before video playback was requested');
          const video=activeVideo(),other=videos.find(item=>item!==video);
          assert.equal(video.hidden,false);assert.equal(other.hidden,true);assert.equal(other.paused,true);
          videos.forEach((item,index)=>{assert.equal(item.loadCalls,mediaState[index].loads,'Game over reloaded media');assert.equal(item.sourceWrites,mediaState[index].writes,'Game over changed a video source');assert.ok(item.getAttribute('src')===mediaState[index].source,'Static media source changed');});
          const beforeDraw=drawCalls,before=frozenSnapshot();tick(10);assert.equal(drawCalls,beforeDraw,'The game kept drawing under its cinematic');assert.equal(frozenSnapshot(),before,'Gameplay advanced beneath its cinematic');
          run('BreachClip.reset()');
        }
      }finally{run('Leaderboard.finishRun=globalThis.__originalFinishRun;delete globalThis.__originalFinishRun;delete globalThis.__recordWorkSawPlaying;');}
    });
    check('both game-over videos hold the correct final picture without native controls until Continue', () => {
      const still=document.getElementById('breachStill'),board=document.getElementById('leaderboardModal'),next=document.getElementById('breachContinue');
      assert.equal(run('Boolean(BreachClip.clips.soldier.src&&BreachClip.clips.breach.src&&BreachClip.clips.soldier.src!==BreachClip.clips.breach.src)'),true,'Soldier and breach must map to distinct, nonempty clips');
      assert.equal(run('Boolean(BreachClip.clips.soldier.endFrame&&BreachClip.clips.breach.endFrame&&BreachClip.clips.soldier.endFrame!==BreachClip.clips.breach.endFrame)'),true,'Each clip needs its own final picture');
      assert.doesNotMatch(html,/id=["']breachSkip["']/,'An ending skip control remains in markup');
      for(const kind of ['breach','soldier'])for(const completion of ['ended','error']){
        start();evaluate(kind==='soldier'?"triggerGameOver(null,'fire')":'spawnEnemy();triggerGameOver(enemies[0])');
        const video=activeVideo();
        assert.ok(String(video.src||video.getAttribute('src'))===run(`BreachClip.clips.${kind}.src`),'Game-over cause selected the wrong clip');
        assert.ok(still.src===run(`BreachClip.clips.${kind}.endFrame`),'Final picture does not match the selected clip');
        assert.equal(still.hidden,true);assert.equal(video.controls,false);assert.equal(video.getAttribute('controls'),null);
        assert.equal(run('BreachClip.isOpen()'),true);assert.equal(board.classList.contains('open'),false);
        assert.equal(next.hidden,true);next.click();assert.equal(board.classList.contains('open'),false,'Early Continue bypassed playback');
        document.body.focus();key('Tab',true);key('Tab',false);assert.equal(document.activeElement,document.getElementById('breachClip'),'Tab escaped the playing clip to background controls');
        key('Escape',true);key('Escape',false);assert.equal(next.hidden,true,'Escape skipped an unfinished ending');assert.equal(video.paused,false,'Escape interrupted automatic playback');assert.equal(still.hidden,true);
        elapseTimers(900);assert.equal(board.classList.contains('open'),false,'Leaderboard overlapped clip');
        const before=requests.length;
        video.currentTime=completion==='ended'?3.2:.6;
        dispatch(video,completion,{bubbles:false});
        assert.equal(run('BreachClip.isOpen()'),true);assert.equal(board.classList.contains('open'),false);
        assert.equal(next.hidden,false);assert.equal(document.activeElement,next);
        document.body.focus();key('Tab',true);key('Tab',false);assert.equal(document.activeElement,next,'Tab escaped the completed clip instead of focusing Continue');
        assert.equal(video.paused,true);assert.equal(video.controls,false);assert.equal(still.hidden,false);
        const heldTime=video.currentTime,heldSource=still.src;key('Escape',true);key('Escape',false);
        assert.equal(run('BreachClip.isOpen()'),true,'Escape dismissed the held ending instead of requiring Continue');
        elapseTimers(15000);assert.equal(board.classList.contains('open'),false,'Continue gate timed out into rankings');
        assert.equal(video.currentTime,heldTime,'A completed video rewound before Continue');assert.ok(still.src===heldSource,'The held picture changed');assert.equal(still.hidden,false);
        assert.equal(requests.length,before);next.click();
        assert.equal(run('BreachClip.isOpen()'),false);assert.equal(board.classList.contains('open'),true);
        assert.equal(video.paused,true);assert.equal(video.currentTime,0);assert.equal(video.controls,false);assert.equal(still.hidden,true);const opened=requests.length;
        assert.equal(next.hidden,true);assert.equal(document.getElementById('leaderboardActions').hidden,false);
        assert.equal(opened,before+1);dispatch(video,'ended',{bubbles:false});dispatch(video,'error',{bubbles:false});next.click();
        assert.equal(requests.length,opened,'Completion opened leaderboard more than once');
      }
    });
    check('Soldier last-picture fallback covers the black video tail without truncating audio or opening Continue early',()=>{
      start();const video=document.getElementById('soldierVideo'),still=document.getElementById('breachStill'),next=document.getElementById('breachContinue');
      evaluate("triggerGameOver(null,'fire')");const holdAt=run('BreachClip.clips.soldier.holdAt');
      assert.ok(holdAt>3&&holdAt<3.1,'Hold time must precede the known black tail');
      video.currentTime=holdAt-.02;dispatch(video,'timeupdate',{bubbles:false});assert.equal(still.hidden,true);
      video.currentTime=holdAt;dispatch(video,'timeupdate',{bubbles:false});assert.equal(still.hidden,false);
      assert.equal(next.hidden,true);assert.equal(video.paused,false,'Freezing the picture must not truncate the remaining audio');
      assert.equal(video.controls,false);assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),false);
      video.currentTime=3.233333;dispatch(video,'ended',{bubbles:false});assert.equal(next.hidden,false);assert.equal(still.hidden,false);assert.equal(video.paused,true);
      next.click();assert.equal(still.hidden,true);assert.equal(video.currentTime,0);
    });
    check('ending clip sound follows only the effects preference, including active preference changes',()=>{
      start();let video;
      run("AudioCore.setMusicMuted(true);AudioCore.setSfxMuted(false);BreachClip.show(()=>{},'soldier')");
      video=activeVideo();
      assert.equal(video.muted,false,'Music mute silenced the ending clip');assert.equal(run('AudioCore.isMusicMuted()'),true);
      run('AudioCore.setSfxMuted(true)');assert.equal(video.muted,true);run('AudioCore.setMusicMuted(false)');assert.equal(video.muted,true,'Music unmute overrode the effects preference');
      run('AudioCore.setSfxMuted(false)');assert.equal(video.muted,false);
      run("BreachClip.reset();AudioCore.setSfxMuted(true);BreachClip.show(()=>{},'breach')");video=activeVideo();assert.equal(video.muted,true,'New ending ignored stored effects mute');
      run('BreachClip.reset();AudioCore.setMusicMuted(false);AudioCore.setSfxMuted(false)');
    });
    check('video-frame holds are frame-accurate and stale callbacks cannot affect another ending',()=>{
      start();const video=document.getElementById('soldierVideo'),still=document.getElementById('breachStill'),callbacks=new Map(),cancelled=[];let id=0;
      video.requestVideoFrameCallback=callback=>{callbacks.set(++id,callback);return id;};
      video.cancelVideoFrameCallback=handle=>{cancelled.push(handle);callbacks.delete(handle);};
      try{
        run("BreachClip.show(()=>{},'soldier')");assert.equal(callbacks.size,1);
        let [handle,callback]=callbacks.entries().next().value;callbacks.delete(handle);callback(0,{mediaTime:1});assert.equal(still.hidden,true);assert.equal(callbacks.size,1);
        [handle,callback]=callbacks.entries().next().value;callbacks.delete(handle);callback(0,{mediaTime:run('BreachClip.clips.soldier.holdAt')});
        assert.equal(still.hidden,false);assert.equal(document.getElementById('breachContinue').hidden,true);assert.equal(callbacks.size,0);
        run("BreachClip.show(()=>{},'soldier')");const pending=callbacks.entries().next().value;
        run("BreachClip.show(()=>{},'breach')");assert.ok(cancelled.includes(pending[0]));assert.equal(callbacks.size,0);assert.equal(still.hidden,true);
        pending[1](0,{mediaTime:99});assert.equal(still.hidden,true,'An obsolete Soldier frame froze the breach video');
        assert.equal(video.controls,false);run('BreachClip.reset()');
      }finally{delete video.requestVideoFrameCallback;delete video.cancelVideoFrameCallback;}
    });
    check('post-run leaderboard focuses a missing callsign and starts a clean new game', () => {
      start();storage.delete('stop-the-boats:callsign');
      evaluate('score=123;spawnEnemy();triggerGameOver(enemies[0])');
      dispatch(activeVideo(),'ended',{bubbles:false});document.getElementById('breachContinue').click();tick(1);
      assert.equal(document.activeElement,document.getElementById('callsignInput'));
      assert.equal(document.getElementById('submitScoreBtn').disabled,false);
      const board=document.getElementById('leaderboardModal'),actions=document.getElementById('leaderboardActions');
      assert.equal(actions.hidden,false);document.getElementById('leaderboardNewGame').click();
      assert.equal(board.classList.contains('open'),false);assert.equal(actions.hidden,true);
      assert.equal(state().running,true);assert.equal(state().gameOver,false);assert.equal(state().score,0);assert.equal(state().wave,1);
      assert.equal(run('BreachClip.isOpen()'),false);assert.equal(evaluate('sniper.active'),false);
      elapseTimers(15000);assert.equal(board.classList.contains('open'),false,'Old result timer interrupted new game');
      run('Leaderboard.open()');assert.equal(actions.hidden,true,'In-run leaderboard exposes restart controls');run('Leaderboard.close()');
    });
    check('hostile-fire death plays Soldier then Continue opens rankings; redeploy invalidates old completion', () => {
      start();let video=document.getElementById('soldierVideo');const plays=video.playCalls;
      evaluate("triggerGameOver(null,'fire')");assert.equal(run('BreachClip.isOpen()'),true);assert.ok(video.playCalls>plays);
      assert.ok(String(video.src||video.getAttribute('src'))===run('BreachClip.clips.soldier.src'),'Soldier death selected the wrong clip');
      elapseTimers(700);assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),false);
      dispatch(video,'ended',{bubbles:false});
      assert.equal(document.getElementById('breachContinue').hidden,false);
      assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),false);
      document.getElementById('breachContinue').click();assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),true);
      start();evaluate('spawnEnemy();triggerGameOver(enemies[0])');assert.equal(run('BreachClip.isOpen()'),true);
      video=activeVideo();
      assert.ok(String(video.src||video.getAttribute('src'))===run('BreachClip.clips.breach.src'),'A shoreline breach must retain its own clip');
      start();dispatch(video,'ended',{bubbles:false});dispatch(video,'error',{bubbles:false});elapseTimers(13000);
      assert.equal(run('BreachClip.isOpen()'),false);assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),false);
      assert.equal(state().running,true);
    });
    await checkAsync('video autoplay rejection retries muted; watchdog exposes Continue without auto-advancing', async () => {
      start();const video=document.getElementById('breachVideo'),play=document.getElementById('breachPlay');
      video.playOutcomes=['reject','reject'];const before=video.playCalls;
      run('globalThis.__clipCompletions=0;BreachClip.show(()=>globalThis.__clipCompletions++)');await flushMicrotasks();
      assert.equal(video.playCalls,before+2);assert.equal(video.muted,true);assert.equal(play.hidden,false);assert.equal(video.controls,false);
      document.body.focus();key('Tab',true);key('Tab',false);assert.equal(document.activeElement,play,'Autoplay fallback did not trap Tab on Play clip');
      play.click();await flushMicrotasks();assert.equal(play.hidden,true);assert.equal(video.playCalls,before+3);
      elapseTimers(12001);assert.equal(run('BreachClip.isOpen()'),true);assert.equal(window.__clipCompletions,0);
      const next=document.getElementById('breachContinue');assert.equal(next.hidden,false);assert.equal(video.controls,false);assert.equal(document.getElementById('breachStill').hidden,false);next.click();
      assert.equal(run('BreachClip.isOpen()'),false);assert.equal(window.__clipCompletions,1);
      dispatch(video,'ended',{bubbles:false});assert.equal(window.__clipCompletions,1);
      video.playOutcomes=['reject','reject'];run('BreachClip.show(()=>globalThis.__clipCompletions++);BreachClip.reset()');await flushMicrotasks();
      assert.equal(run('BreachClip.isOpen()'),false);assert.equal(play.hidden,true);elapseTimers(13000);assert.equal(window.__clipCompletions,1);
    });
    await checkAsync('each personal metric improves independently and score sharing uses the exact last run',async()=>{
      await flushMicrotasks();start();storage.delete('stop-the-boats:callsign');
      run("Leaderboard.finishRun(2000,4,false,{boatsStopped:12,bestChain:7,timeHeld:180,headshots:2});Leaderboard.finishRun(1200,2,false,{boatsStopped:20,bestChain:5,timeHeld:210,headshots:6})");
      const best=JSON.parse(run('JSON.stringify(Leaderboard.getRecords())'));
      assert.deepEqual(best,{score:2000,wave:4,boatsStopped:20,bestChain:7,timeHeld:210,headshots:6});
      const exact=JSON.parse(run("JSON.stringify(Leaderboard.getShareSnapshot('score'))"));
      assert.equal(exact.recordKind,'Last run');assert.equal(exact.score,1200);assert.equal(exact.wave,2);assert.equal(exact.bestChain,5);
      const before=requests.filter(item=>item.method==='POST').length;
      fetchHandler=async(_,options)=>{
        const payload=JSON.parse(options.body);
        return {accepted:true,metric:payload.metric,rank:12,entries:[],player:{...payload,rank:12,scoreRank:12,positions:{score:12,boatsStopped:3,bestChain:7,timeHeld:5,headshots:1}}};
      };
      const input=document.getElementById('callsignInput');input.value='QA PILOT';dispatch(input,'input');
      dispatch(document.getElementById('leaderboardForm'),'submit');await flushMicrotasks();
      assert.equal(requests.filter(item=>item.method==='POST').length,before+1);
      const first=requests.filter(item=>item.method==='POST').at(-1).body;
      for(const [key,value]of Object.entries(best))assert.equal(first[key],value,'Missing or mixed-up personal record '+key);
      run("Leaderboard.finishRun(1000,3,false,{boatsStopped:2,bestChain:8,timeHeld:90,headshots:0})");await flushMicrotasks();
      assert.equal(requests.filter(item=>item.method==='POST').length,before+2,'Lower-scoring improvement never submitted');
      const second=requests.filter(item=>item.method==='POST').at(-1).body;
      assert.equal(second.score,2000);assert.equal(second.bestChain,8);assert.equal(second.boatsStopped,20);assert.equal(second.headshots,6);
      const rank=JSON.parse(run("JSON.stringify(Leaderboard.getShareSnapshot('rank'))"));
      assert.equal(rank.recordKind,'Personal bests');assert.equal(rank.rankName,'Colonel');assert.equal(rank.scoreRank,12);assert.equal(rank.score,2000);
      const latest=JSON.parse(run("JSON.stringify(Leaderboard.getShareSnapshot('score'))"));
      assert.equal(latest.score,1000);assert.equal(latest.headshots,0);assert.equal(latest.timeHeld,90,'Share Score mixed independent PBs into last-run stats');
      storage.delete('stop-the-boats:callsign');fetchHandler=async()=>({entries:[],rank:null,player:null,metric:'score'});
    });
    await checkAsync('a new record earned during submission queues the latest independent achievements',async()=>{
      await flushMicrotasks();storage.set('stop-the-boats:callsign','QA PILOT');const pending=[];
      fetchHandler=(url,options)=>new Promise(resolve=>pending.push({payload:JSON.parse(options.body),resolve}));
      run("Leaderboard.finishRun(2000,4,false,{boatsStopped:20,bestChain:8,timeHeld:210,headshots:7})");
      assert.equal(pending.length,1);assert.equal(pending[0].payload.headshots,7);
      run("Leaderboard.finishRun(1000,3,false,{boatsStopped:21,bestChain:8,timeHeld:211,headshots:8})");
      assert.equal(pending.length,1,'Concurrent score writes were not serialized');
      const respond=item=>item.resolve({accepted:true,metric:item.payload.metric,rank:12,entries:[],player:{...item.payload,scoreRank:12,positions:{score:12}}});
      respond(pending[0]);await flushMicrotasks();assert.equal(pending.length,2,'New achievements were lost during an in-flight request');
      assert.equal(pending[1].payload.score,2000);assert.equal(pending[1].payload.boatsStopped,21);assert.equal(pending[1].payload.timeHeld,211);assert.equal(pending[1].payload.headshots,8);
      respond(pending[1]);await flushMicrotasks();assert.equal(pending.length,2,'Identical achievements were resubmitted indefinitely');
      const records=JSON.parse(run('JSON.stringify(Leaderboard.getRecords())'));
      assert.equal(records.headshots,8);assert.equal(records.boatsStopped,21);assert.equal(records.timeHeld,211);
      storage.delete('stop-the-boats:callsign');fetchHandler=async()=>({entries:[],rank:null,player:null,metric:'score'});
    });
    await checkAsync('category switches discard stale responses and military grade uses overall score rank',async()=>{
      await flushMicrotasks();const pending=[];fetchHandler=(url)=>new Promise(resolve=>pending.push({url,resolve}));
      run("Leaderboard.selectMetric('boatsStopped');Leaderboard.selectMetric('headshots')");
      assert.equal(pending.length,2);assert.equal(new URL(pending[0].url,'https://offline.invalid').searchParams.get('metric'),'boatsStopped');
      assert.equal(new URL(pending[1].url,'https://offline.invalid').searchParams.get('metric'),'headshots');
      const own=JSON.parse(run('JSON.stringify(Leaderboard.getRecords())'));
      pending[1].resolve({metric:'headshots',entries:[{rank:1,callsign:'LATEST',score:2000,wave:4,headshots:99,scoreRank:12}],player:{...own,callsign:'QA PILOT',rank:1,scoreRank:12,positions:{score:12,headshots:1}}});await flushMicrotasks();
      assert.equal(document.getElementById('boardMetric-headshots').getAttribute('aria-selected'),'true');
      assert.equal(document.getElementById('boardMetric-boatsStopped').getAttribute('aria-selected'),'false');
      assert.equal(document.getElementById('boardMetricLabel').textContent,'Headshots');
      assert.equal(document.getElementById('militaryRankName').textContent,'Colonel','Category #1 incorrectly awarded Field Marshal');
      const list=document.getElementById('leaderboardList');assert.equal(list.querySelectorAll('.leaderboardScore')[0].textContent,'99');
      pending[0].resolve({metric:'boatsStopped',entries:[{rank:1,callsign:'STALE',boatsStopped:900,wave:9,scoreRank:1}],player:{...own,callsign:'QA PILOT',rank:1,scoreRank:1,positions:{score:1}}});await flushMicrotasks();
      assert.equal(list.querySelectorAll('.leaderboardNameText')[0].textContent,'LATEST');
      assert.equal(document.getElementById('militaryRankName').textContent,'Colonel','Stale category response overwrote current rank');
      const before=run('JSON.stringify(Leaderboard.getRecords())');
      fetchHandler=async()=>({entries:[],player:null,metric:'score'});run("Leaderboard.selectMetric('score')");await flushMicrotasks();
      assert.equal(run('JSON.stringify(Leaderboard.getRecords())'),before,'Empty network response erased device PBs');
      assert.equal(document.getElementById('militaryRankName').textContent,'Recruit');
      const metricBefore=document.getElementById('boardMetricLabel').textContent;run("Leaderboard.selectMetric('score;DROP TABLE')");assert.equal(document.getElementById('boardMetricLabel').textContent,metricBefore);
      assert.equal(run("Leaderboard.formatMetric('timeHeld',3661)"),'1:01:01');assert.equal(run("Leaderboard.formatMetric('headshots',null)"),'—');
    });
    await checkAsync('unverified ranks cannot be shared and confirmed rank shares use the saved callsign',async()=>{
      await flushMicrotasks();const own=JSON.parse(run('JSON.stringify(Leaderboard.getRecords())'));
      fetchHandler=async()=>({metric:'score',entries:[],player:{...own,callsign:'SAVED PILOT',scoreRank:1,positions:{score:1}}});
      run("Leaderboard.selectMetric('score')");await flushMicrotasks();
      const input=document.getElementById('callsignInput');input.value='UNSAVED NAME';dispatch(input,'input');
      let rank=JSON.parse(run("JSON.stringify(Leaderboard.getShareSnapshot('rank'))"));
      assert.equal(rank.callsign,'SAVED PILOT');assert.equal(rank.scoreRank,1);assert.equal(rank.rankName,'Field Marshal');
      assert.equal(document.getElementById('leaderboardShareRank').disabled,false);
      fetchHandler=async()=>{throw new Error('Simulated network unavailable');};run("Leaderboard.selectMetric('score')");await flushMicrotasks();
      assert.equal(document.getElementById('leaderboardShareRank').disabled,true);
      rank=JSON.parse(run("JSON.stringify(Leaderboard.getShareSnapshot('rank'))"));assert.equal(rank.scoreRank,null,'Stale network rank remains shareable');
      assert.match(document.getElementById('militaryRankPosition').textContent,/awaiting network/i);
      fetchHandler=async()=>({entries:[],player:null,metric:'score'});run("Leaderboard.selectMetric('score')");await flushMicrotasks();
      assert.equal(document.getElementById('submitScoreBtn').disabled,false,'Missing server record cannot be restored');
    });
    check('share captions and image cards preserve unknown stats and sanitize names',()=>{
      const normalized=JSON.parse(run("JSON.stringify(AchievementShare.normalizeSnapshot({callsign:'<img/onerror=bad>ACE',score:-4,boatsStopped:null,bestChain:2,timeHeld:65,headshots:Infinity,scoreRank:null,badgeLevel:100},'rank'))"));
      assert.equal(normalized.score,0);assert.equal(normalized.headshots,null);assert.equal(normalized.boatsStopped,null);assert.equal(normalized.badgeLevel,15);
      assert.doesNotMatch(normalized.callsign,/[<>/=]/);
      const caption=run("AchievementShare.buildCaption({callsign:'ACE',score:1234,boatsStopped:null,bestChain:2,timeHeld:65,headshots:0,scoreRank:null,rankName:'Recruit',mode:'rank'})");
      assert.match(caption,/Recruit.*unranked/);assert.match(caption,/1:05 held/);assert.match(caption,/0 headshots/);assert.doesNotMatch(caption,/null|NaN|undefined|0 boats/);
      assert.match(caption,/https:\/\/offline\.invalid\//);
      const trace=[];canvasTrace=trace;try{run("AchievementShare.drawCard({callsign:'ACE',score:1234,boatsStopped:12,bestChain:3,timeHeld:65,headshots:4,scoreRank:2,rankName:'General',badgeLevel:14,mode:'score',recordKind:'Last run',wave:5})");}finally{canvasTrace=null;}
      const card=document.getElementById('shareCardCanvas');assert.equal(card.width,1080);assert.equal(card.height,1080);
      const words=trace.filter(item=>item.method==='fillText').map(item=>String(item.args[0]));
      for(const expected of ['ACE','GENERAL','1,234','12','3','1:05','4','LAST RUN'])assert.ok(words.includes(expected),'Missing achievement text '+expected);
      assert.match(card.getAttribute('aria-label'),/1,234 points/);
    });
    await checkAsync('share modal pauses play, preserves the leaderboard pause, and exposes safe composer links',async()=>{
      start();run('Leaderboard.open()');await flushMicrotasks();document.getElementById('leaderboardShareScore').click();
      assert.equal(run('AchievementShare.isOpen()'),true);assert.equal(state().running,false);
      const frozen=frozenSnapshot();tick(60);assert.equal(frozenSnapshot(),frozen);
      const x=new URL(document.getElementById('shareX').href),facebook=new URL(document.getElementById('shareFacebook').href);
      assert.equal(x.origin,'https://x.com');assert.equal(x.pathname,'/intent/tweet');assert.equal(x.searchParams.get('text'),document.getElementById('shareCaption').value);
      assert.equal(facebook.origin,'https://www.facebook.com');assert.equal(facebook.searchParams.get('u'),'https://offline.invalid/');
      key('Escape',true);key('Escape',false);assert.equal(run('AchievementShare.isOpen()'),false);
      assert.equal(document.getElementById('leaderboardModal').classList.contains('open'),true,'Escape closed the underlying board too');
      assert.equal(state().running,false);run('Leaderboard.close()');assert.equal(state().running,true);
      run("AchievementShare.open('score')");run('AchievementShare.close()');assert.equal(state().running,true);
    });
    await checkAsync('native sharing supports PNG files, cancellation and text-only fallback without auto-posting',async()=>{
      start();run("AchievementShare.open('score')");const shared=[];
      window.navigator.canShare=data=>!!data.files?.length;window.navigator.share=async data=>{shared.push(data);};
      document.getElementById('shareNative').click();await flushMicrotasks();
      assert.equal(shared.length,1);assert.equal(shared[0].files[0].type,'image/png');assert.match(shared[0].files[0].name,/\.png$/);
      assert.equal(shared[0].text,document.getElementById('shareCaption').value);
      const downloads=externalActions.filter(item=>item.kind==='download').length;
      window.navigator.share=async()=>{const error=new Error('Cancelled');error.name='AbortError';throw error;};
      document.getElementById('shareNative').click();await flushMicrotasks();assert.match(document.getElementById('shareStatus').textContent,/cancelled/i);
      assert.equal(externalActions.filter(item=>item.kind==='download').length,downloads,'Cancel unexpectedly forced a download');
      assert.equal(document.getElementById('shareNative').disabled,false);
      window.navigator.share=async()=>{const error=new Error('Permission denied');error.name='NotAllowedError';throw error;};
      document.getElementById('shareNative').click();await flushMicrotasks();assert.match(document.getElementById('shareStatus').textContent,/could not|unavailable|download/i);
      assert.equal(externalActions.filter(item=>item.kind==='download').length,downloads,'Permission rejection unexpectedly forced a download');
      assert.equal(document.getElementById('shareNative').disabled,false);
      window.navigator.canShare=()=>false;window.navigator.share=async data=>shared.push(data);
      document.getElementById('shareNative').click();await flushMicrotasks();assert.equal(shared.length,2);assert.equal(shared[1].files,undefined);
      assert.match(shared[1].text,/https:\/\/offline\.invalid/);run('AchievementShare.close()');delete window.navigator.share;delete window.navigator.canShare;
    });
    await checkAsync('unsupported sharing and clipboard failures retain manual Instagram/download alternatives',async()=>{
      start();run("AchievementShare.open('score')");document.getElementById('shareNative').click();await flushMicrotasks();
      assert.match(document.getElementById('shareStatus').textContent,/no app share sheet/i);
      const before=externalActions.filter(item=>item.kind==='download').length;document.getElementById('shareInstagram').click();
      assert.equal(externalActions.filter(item=>item.kind==='download').length,before+1);assert.match(document.getElementById('shareStatus').textContent,/Open Instagram/);
      const copied=[];window.navigator.clipboard={writeText:async text=>copied.push(text)};document.getElementById('shareCopy').click();await flushMicrotasks();
      assert.equal(copied[0],document.getElementById('shareCaption').value);
      window.navigator.clipboard={writeText:async()=>{throw new Error('Permission denied');}};document.getElementById('shareCopy').click();await flushMicrotasks();
      assert.equal(document.activeElement,document.getElementById('shareCaption'));assert.match(document.getElementById('shareStatus').textContent,/Caption selected/);
      delete window.navigator.clipboard;run('AchievementShare.close()');
    });
    await checkAsync('restart and delayed share completions cannot reopen the modal or leave gameplay paused',async()=>{
      start();run("AchievementShare.open('score')");let settle;
      window.navigator.canShare=()=>true;window.navigator.share=()=>new Promise(resolve=>{settle=resolve;});
      document.getElementById('shareNative').click();assert.equal(document.getElementById('shareNative').disabled,true);
      evaluate('resetGame()');assert.equal(run('AchievementShare.isOpen()'),false);assert.equal(evaluate('modalPauses.size'),0);
      settle();await flushMicrotasks();assert.equal(run('AchievementShare.isOpen()'),false);
      delete window.navigator.share;delete window.navigator.canShare;
      const card=document.getElementById('shareCardCanvas'),original=card.toBlob;let finishBlob;
      card.toBlob=callback=>{finishBlob=callback;};start();run("AchievementShare.open('rank')");run('AchievementShare.close()');
      finishBlob(new Blob(['late'],{type:'image/png'}));assert.equal(run('AchievementShare.isOpen()'),false);assert.equal(document.getElementById('shareDownload').disabled,true);
      card.toBlob=original;assert.equal(state().running,true);
    });
    check('full run reset clears persistent and transient state', () => {
      start(); evaluate("applyPowerup('spread3');applyPowerup('spread5');applyPowerup('rapid');applyPowerup('artillery');applyPowerup('hedgehog');applyPowerup('mine');applyPowerup('cluster');applyPowerup('airstrike');upgrades.cadence=3;upgrades.velocity=2;upgrades.mobility=1;kills=4;combo=3;bestCombo=5;playTicks=900;dash();deployAirstrike();hostileShots.push({x:100,y:100,vx:0,vy:3.5,aimX:100,aimY:700,life:200});resetGame();draw()");
      const zeroFields = ['score','frame','spawnTimer','kills','combo','comboTimer','bestCombo','playTicks','killsSinceDrop','bannerTimer','airstrikeWarning','waveSpawned','upgrades.cadence','upgrades.velocity','upgrades.mobility','player.dashTimer','player.dashCooldown','player.shotNumber','player.spread3Timer','player.spread5Timer','player.rapidTimer','artillery.timer','inventory.mine','inventory.cluster','inventory.airstrike'];
      for (const field of zeroFields) assert.equal(evaluate(field), 0, field + ' not reset');
      assert.equal(evaluate('player.lives'),3);assert.equal(evaluate('player.hitInvulnerability'),0);
      for (const list of ['bullets','hostileShots','enemies','powerups','particles','mines','scheduledBlasts','explosionsFx','waterRipples','oilSlicks','wrecks','floatingPassengers','bloodSprays','hedgehogs','floatingText']) assert.equal(evaluate(list + '.length'), 0, list + ' not cleared');
      for (const flag of ['started','paused','gameOver','dragging','placingMine']) assert.equal(evaluate(flag), false, flag + ' not cleared');
      assert.equal(evaluate('modalPauses.size'), 0);
      regression('reset clears running state', !state().running, 'resetGame sets started=false but leaves running=true, so a direct reset still advances live simulation.');
    });
  }
  check('resize and render at mobile width', () => {
    window.innerWidth = 390; window.innerHeight = 844; evaluate('resize();draw()');
    assert.ok(Number.isFinite(state().player.y));
  });
}
await Promise.resolve(); await Promise.resolve();
const failed = results.filter(result => result.status === 'FAIL');
console.log(JSON.stringify({file: filename, viewport: {width: window.innerWidth, height: window.innerHeight}, results, regressions: warnings, offlineNetworkRequests: requests, summary: {passed: results.length - failed.length, failed: failed.length, regressions: warnings.length, canvasCalls: drawCalls, realNetworkRequests: 0}}, null, 2));
process.exitCode = failed.length || (strict && warnings.length) ? 1 : 0;

