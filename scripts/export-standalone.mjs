import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=process.argv[2];
if(!destination||!path.isAbsolute(destination))throw new Error('An absolute output HTML path is required');
let html=fs.readFileSync(path.join(root,'public/game.html'),'utf8');
for(const [name,mime] of [['captain.mp4','video/mp4'],['captain-poster.jpg','image/jpeg'],['captain-end.jpg','image/jpeg'],['soldier.mp4','video/mp4'],['soldier-poster.jpg','image/jpeg'],['soldier-end.jpg','image/jpeg']]){
  const source='/media/'+name;
  if(!html.includes(source))throw new Error('Missing media reference: '+source);
  const uri='data:'+mime+';base64,'+fs.readFileSync(path.join(root,'public/media',name)).toString('base64');
  html=html.replaceAll(source,uri);
}
// Embed every explicitly referenced audio asset as well as the ending clips.
// Streaming <audio> and the short-sample fetch/decode cache both accept data URIs.
const audioFiles=[...new Set(html.match(/\/audio\/[a-z0-9-]+\.mp3/g)||[])];
if(audioFiles.length<11||!audioFiles.includes('/audio/music-menu.mp3')||!audioFiles.includes('/audio/music-battle.mp3'))throw new Error('Expected both music tracks and the recorded effects library');
for(const source of audioFiles){
  const bytes=fs.readFileSync(path.join(root,'public',source));
  html=html.replaceAll(source,'data:audio/mpeg;base64,'+bytes.toString('base64'));
}
fs.writeFileSync(destination,html);
console.log(destination);
