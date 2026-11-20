import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './test-support.js';

test('group existing versions, add revisions, and retain original annotation ownership',async()=>{
 const env=setup(),a=env.client(),b=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Versions',name:'Host'})).json(),root='/api/rooms/'+id;
 await b.request(root+'/join','POST',{name:'Reviewer'});
 const upload=async(name,headers={})=>(await(await a.request(root+'/media','POST',Buffer.from(name),{'Content-Type':'video/mp4','X-File-Name':name,...headers})).json()).asset;
 const first=await upload('shot-v1.mp4'),second=await upload('shot-v2.mp4');
 await a.request(root+'/events','POST',{type:'comment',asset:first.id,time:1,text:'v1 note'});
 await a.request(root+'/events','POST',{type:'stroke',asset:second.id,time:1,points:[[0,0],[1,1]],color:'#ffffff'});
 let items=(await(await b.request(root+'/assets')).json()).assets;assert.notEqual(items[0].shotId,items[1].shotId);
 assert.equal((await a.request(root+'/versions','POST',{asset:second.id,shotId:first.id,shotName:'Shot 010',versionLabel:'v2 · lighting'})).status,200);
 items=(await(await b.request(root+'/assets')).json()).assets;assert.ok(items.every(a=>a.shotId===first.id&&a.shotName==='Shot 010'));assert.equal(items.find(a=>a.id===second.id).versionLabel,'v2 · lighting');
 const third=await upload('shot-v3.mp4',{'X-Version-Of':second.id});items=(await(await b.request(root+'/assets')).json()).assets;assert.equal(items.find(a=>a.id===third.id).shotId,first.id);assert.equal(items.find(a=>a.id===third.id).versionLabel,'v3');
 const events=(await(await b.request(root+'/events')).json()).events;assert.equal(events.find(e=>e.type==='comment').asset,first.id);assert.equal(events.find(e=>e.type==='stroke').asset,second.id);
 assert.equal((await b.request(root+'/versions','POST',{asset:second.id,shotName:'Separate shot',versionLabel:'v1'})).status,200);
 items=(await(await a.request(root+'/assets')).json()).assets;assert.notEqual(items.find(a=>a.id===second.id).shotId,first.id);
 assert.equal((await b.request(root+'/versions','POST',{asset:third.id,shotId:crypto.randomUUID(),shotName:'Invalid',versionLabel:'v4'})).status,404);
 assert.equal((await env.client().request(root+'/versions','POST',{asset:first.id})).status,401);
});

test('presenter shares comparison settings and rejects unrelated references',async()=>{
 const env=setup(),a=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Compare',name:'Host'})).json(),root='/api/rooms/'+id;
 const upload=async(headers={})=>(await(await a.request(root+'/media','POST','movie',{'Content-Type':'video/mp4',...headers})).json()).asset;
 const first=await upload(),second=await upload({'X-Version-Of':first.id}),other=await upload();await a.request(root+'/media/select','POST',{id:second.id});
 const connection=crypto.randomUUID(),state=(await(await a.request(root+'/control','POST',{action:'claim',connection})).json()).control;
 const playback={action:'playback',connection,term:state.term,sequence:1,asset:second.id,time:3,playing:false,comparison:{asset:first.id,mode:'wipe',wipe:35,angle:45,y:60}};
 assert.equal((await a.request(root+'/control','POST',playback)).status,200);const live=await(await a.request(root+'/live')).json();assert.equal(live.playback.comparison.asset,first.id);assert.equal(live.playback.comparison.wipe,35);assert.equal(live.playback.comparison.angle,45);assert.equal(live.playback.comparison.y,60);
 assert.equal((await a.request(root+'/control','POST',{...playback,sequence:2,comparison:{asset:other.id,mode:'side'}})).status,400);
 assert.equal((await a.request(root+'/control','POST',{...playback,sequence:3,comparison:null})).status,200);
 assert.equal((await(await a.request(root+'/live')).json()).playback.comparison,null);
});

test('alignment offsets sync to guests and preserve feedback source times through reset',async()=>{
 const env=setup(),a=env.client(),b=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Alignment QA',name:'Host'})).json(),root='/api/rooms/'+id;await b.request(root+'/join','POST',{name:'Peer'});
 const upload=async(headers={})=>(await(await a.request(root+'/media','POST','movie',{'Content-Type':'video/mp4',...headers})).json()).asset;const first=await upload(),second=await upload({'X-Version-Of':first.id});await a.request(root+'/media/select','POST',{id:second.id});
 for(const asset of [first,second]){await a.request(root+'/events','POST',{type:'comment',asset:asset.id,time:1.25,text:asset.id});await a.request(root+'/events','POST',{type:'stroke',asset:asset.id,time:1.25,points:[[.1,.2],[.3,.4]],tool:'arrow',color:'#ff0000'});}
 const before=(await(await b.request(root+'/events')).json()).events;const connection=crypto.randomUUID(),state=(await(await a.request(root+'/control','POST',{action:'claim',connection})).json()).control;let sequence=0;
 for(const offset of [2,-1.5,0]){const response=await a.request(root+'/control','POST',{action:'playback',connection,term:state.term,sequence:++sequence,asset:second.id,time:3,playing:false,comparison:{asset:first.id,mode:'side',offset}});assert.equal(response.status,200);const live=await(await b.request(root+'/live')).json();assert.equal(live.playback.comparison.offset,offset);assert.equal(live.playback.time,3);}
 assert.deepEqual((await(await b.request(root+'/events')).json()).events,before,'alignment never rewrites notes or drawings');
 assert.equal((await b.request(root+'/control','POST',{action:'playback',connection:crypto.randomUUID(),term:state.term,sequence:1,asset:second.id,time:0,playing:false,comparison:{asset:first.id,mode:'wipe',offset:10}})).status,409,'follower cannot replace presenter alignment');env.db.close();
});
