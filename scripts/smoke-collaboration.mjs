import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const origin=process.argv[2]||'http://127.0.0.1:4173';
const report={origin,at:new Date().toISOString(),checks:[]};
function check(name,value){assert.ok(value,name);report.checks.push(name)}
function client(){let cookie='';return {async call(path,method='GET',body){const response=await fetch(origin+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':body instanceof Uint8Array?'video/mp4':'application/json'}:{})},...(body?{body:body instanceof Uint8Array?body:JSON.stringify(body)}:{})});for(const set of response.headers.getSetCookie())if(set.startsWith('fs_'))cookie=set.split(';')[0];return response}}}
const a=client(),b=client(),anonymous=client();
let reader;
try{
 const created=await a.call('/api/rooms','POST',{title:'Realtime collaboration QA',name:'Presenter QA'});check('Account-free creation',created.status===201);
 const {id}=await created.json(),root='/api/rooms/'+id;report.room=id;
 check('Name-only independent guest join',(await b.call(root+'/join','POST',{name:'Reviewer QA'})).status===200);
 check('Anonymous stream is protected',(await anonymous.call(root+'/stream')).status===401);
 const upload=await a.call(root+'/media','POST',await readFile(new URL('./fixtures/review-clock-30s.mp4', import.meta.url)));check('Video upload',upload.status===200);const asset=(await upload.json()).asset;
 const ca=crypto.randomUUID(),cb=crypto.randomUUID(),action=(who,connection,action,extra={})=>who.call(root+'/control','POST',{connection,action,...extra});
 let response=await action(a,ca,'claim');check('Presenter claim',response.status===200);let state=(await response.json()).control;
 const term=state.term;
 check('Ordered playback accepted',(await action(a,ca,'playback',{term,sequence:2,asset:asset.id,time:6.055,playing:false,rate:1})).status===200);
 await action(a,ca,'playback',{term,sequence:1,asset:asset.id,time:0,playing:false,rate:1});
 check('Old sequence cannot rewind',(await(await b.call(root+'/live')).json()).playback.time===6.055);
 const stream=await b.call(root+'/stream');check('SSE content type',stream.headers.get('Content-Type')?.includes('text/event-stream'));reader=stream.body.getReader();const decoder=new TextDecoder();let buffer='',snapshots=[];
 async function until(predicate){const started=Date.now();while(Date.now()-started<8000){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,index);buffer=buffer.slice(index+2);if(packet.startsWith('data: ')){const data=JSON.parse(packet.slice(6));snapshots.push({data,received:Date.now()});if(predicate(data))return data;}}}throw Error('Expected live snapshot did not arrive');}
 await until(data=>data.control?.playback?.time===6.055);const sent=Date.now();
 const gesture={connection:ca,strokeId:crypto.randomUUID(),asset:asset.id,kind:'laser',tool:'laser',points:[[.7,.5]],time:6.055,color:'#ff0000',sequence:1};
 check('Laser accepted',(await a.call(root+'/gesture','POST',gesture)).status===200);
 await until(data=>data.gestures.some(g=>g.kind==='laser'));report.laserRoundTripMs=Date.now()-sent;
 await reader.cancel();reader=null;check('Stream delivers incremental updates',snapshots.length>1);
 response=await action(b,cb,'claim');state=(await response.json()).control;check('Second presenter waits for handoff',state.presenter.name==='Presenter QA'&&state.requests.length===1);
 check('Explicit handoff',(await action(a,ca,'handoff',{term,target:state.requests[0].owner})).status===200);
 check('Previous presenter is rejected',(await action(a,ca,'playback',{term,sequence:9,asset:asset.id,time:0,playing:true})).status===409);
 const stroke={type:'stroke',asset:asset.id,time:6.055,points:[[.2,.2],[.7,.6]],color:'#ff0000',tool:'arrow',strokeId:crypto.randomUUID(),requestId:crypto.randomUUID()};
 const first=await a.call(root+'/events','POST',stroke);check('Drawing persisted',first.status===200);const saved=(await first.json()).event;
 const retry=await(await a.call(root+'/events','POST',stroke)).json();check('Lost-response retry returns same annotation',retry.event.id===saved.id);
 const reopened=await b.call(root+'/stream');reader=reopened.body.getReader();buffer='';const latest=await until(data=>data.control.presenter?.name==='Reviewer QA');check('Reconnect restores presenter and paused frame',latest.control.playback.time>=6.055&&!latest.control.playback.playing);await reader.cancel();reader=null;
 const events=(await(await b.call(root+'/events')).json()).events;check('One durable drawing; laser excluded',events.filter(e=>e.type==='stroke').length===1&&!events.some(e=>e.type==='laser'));
 report.inviteUrl=origin+'/?room='+id;report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}finally{if(reader)await reader.cancel();await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
await writeFile(new URL('../test-results/collaboration-smoke.json', import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
