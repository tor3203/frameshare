import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const origin=process.argv[2]||'http://127.0.0.1:4173';
const videoPath=process.argv[3];
const report={origin,at:new Date().toISOString(),checks:[]};
const check=(name,condition)=>{report.checks.push({name,passed:Boolean(condition)});assert.ok(condition,name)};
function client(){const cookies=new Map();return {async request(path,method='GET',body,headers={}){
 const response=await fetch(origin+path,{method,redirect:'manual',headers:{...(cookies.size?{Cookie:[...cookies.values()].join('; ')}:{}),...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})});
 for(const set of response.headers.getSetCookie()){const cookie=set.split(';')[0],name=cookie.split('=')[0];if(name.startsWith('fs_'))cookies.set(name,cookie)}
 return response;
}}}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const host=client(),guest=client(),anonymous=client();
 const home=await anonymous.request('/');check('Public home page with no account cookies',home.status===200&&(await home.text()).includes('FrameShare'));
 const created=await host.request('/api/rooms','POST',{title:'FrameShare · shared test room',name:'QA Host'},{'Content-Type':'application/json'});check('Create room without account credentials',created.status===201);const room=await created.json();report.room=room.id;report.inviteUrl=origin+'/?room='+room.id;
 const path='/api/rooms/'+room.id;
 check('Private room rejected before guest join',(await anonymous.request(path)).status===401);
 const join=await guest.request(path+'/join','POST',{name:'QA Guest'},{'Content-Type':'application/json'});check('Guest joins with just a name',join.status===200);
 const png=await readFile(new URL('./fixtures/review-still.png', import.meta.url));
 let response=await host.request(path+'/media','POST',png,{'Content-Type':'image/png','X-File-Name':encodeURIComponent('Review still · QA.png'),'Content-Length':String(png.length)});
 const upload=await response.json();report.imageUploadStatus=response.status;report.imageUploadError=upload.error;
 check('Image upload succeeds: HTTP '+response.status,response.status===200);const image=upload.asset;
 const bytes=Buffer.from(await (await guest.request(path+'/media/'+image.id)).arrayBuffer());check('Guest downloads byte-identical uploaded image',digest(bytes)===digest(png));
 check('Unjoined client cannot download image',(await anonymous.request(path+'/media/'+image.id)).status===401);
 const root=(await (await guest.request(path+'/events','POST',{type:'comment',text:'Guest upload and note synchronization verified.',time:0,asset:image.id,name:'spoofed'})).json()).event;
 const history=await (await host.request(path+'/events')).json();check('Guest comment attributed by server session',history.events.some(event=>event.id===root.id&&event.name==='QA Guest'));
 check('Host can reply',(await host.request(path+'/events','POST',{type:'comment',text:'Host can read the guest note.',time:0,asset:image.id,parent:root.id})).status===200);
 if(videoPath){
  const clip=await readFile(videoPath);response=await host.request(path+'/media','POST',clip,{'Content-Type':'video/mp4','X-File-Name':'review-clock-30s.mp4','Content-Length':String(clip.length)});const videoUpload=await response.json();report.videoUploadStatus=response.status;report.videoUploadError=videoUpload.error;check('Video upload succeeds: HTTP '+response.status,response.status===200);const video=videoUpload.asset;
  const assets=await (await guest.request(path+'/assets')).json();check('Both media versions retained',assets.assets.length===2);
  const range=await guest.request(path+'/media/'+video.id,'GET',undefined,{Range:'bytes=0-1023'});check('Video partial read succeeds',range.status===206&&(await range.arrayBuffer()).byteLength===1024);
  check('Stale playhead is rejected',(await host.request(path+'/events','POST',{type:'playhead',asset:image.id,time:2,playing:true})).status===409);
  await host.request(path+'/events','POST',{type:'playhead',asset:video.id,time:2,playing:false,rate:1});
  const live=await (await guest.request(path+'/live')).json();check('Guest sees current media and paused playhead',live.media.id===video.id&&live.playback.time===2&&live.playback.playing===false);
  await host.request(path+'/media/select','POST',{id:image.id});check('Shared media selection is visible',(await (await guest.request(path+'/live')).json()).media.id===image.id);
  await host.request(path+'/media/select','POST',{id:video.id});
 }
}catch(error){report.error=error.message;process.exitCode=1}
finally{await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
await writeFile(new URL('../test-results/live-smoke.json', import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
