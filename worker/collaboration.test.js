import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './test-support.js';
import {collaborationView,LEASE_MS} from './collaboration.js';

test('simultaneous claims, explicit handoff and stale presenter rejection',async()=>{
 const env=setup(),a=env.client(),b=env.client();
 const {id}=await(await a.request('/api/rooms','POST',{title:'Control QA',name:'Alice'})).json(),root='/api/rooms/'+id;
 await b.request(root+'/join','POST',{name:'Bob'});
 const asset=(await(await a.request(root+'/media','POST','png',{'Content-Type':'image/png'})).json()).asset;
 const ca=crypto.randomUUID(),cb=crypto.randomUUID();
 const action=(who,connection,action,extra={})=>who.request(root+'/control','POST',{connection,action,...extra});
 const results=await Promise.all([action(a,ca,'claim'),action(b,cb,'claim')]);assert.ok(results.every(r=>r.status===200));
 let state=(await(await a.request(root+'/live')).json()).control;assert.equal(state.requests.length,1);
 const first=state.presenter.name==='Alice'?a:b,second=first===a?b:a,firstConnection=first===a?ca:cb,secondConnection=first===a?cb:ca;
 const term=state.term;
 assert.equal((await action(first,firstConnection,'playback',{term,sequence:2,asset:asset.id,time:6.055,playing:true,rate:1})).status,200);
 await action(first,firstConnection,'playback',{term,sequence:1,asset:asset.id,time:0,playing:false});
 state=(await(await b.request(root+'/live')).json()).control;assert.equal(state.playback.time,6.055);
 assert.equal((await action(second,secondConnection,'playback',{term,sequence:99,asset:asset.id,time:0,playing:false})).status,409);
 assert.equal((await action(first,firstConnection,'handoff',{term,target:state.requests[0].owner})).status,200);
 assert.equal((await action(first,firstConnection,'playback',{term,sequence:100,asset:asset.id,time:0,playing:false})).status,409);
 state=(await(await second.request(root+'/live')).json()).control;assert.equal(state.term,term+1);assert.equal(state.playback.playing,false);
 // Another tab sharing a cookie still cannot use its sibling's presenter lease.
 assert.equal((await action(second,crypto.randomUUID(),'release',{term:state.term})).status,409);
 const key='rooms/'+id+'/live/control',saved=JSON.parse((await env.db.prepare('SELECT value FROM collaboration_state WHERE key=?').bind(key).first()).value);saved.presenter.expires=Date.now()-1;await env.db.prepare('UPDATE collaboration_state SET value=? WHERE key=?').bind(JSON.stringify(saved),key).run();
 assert.equal((await(await a.request(root+'/live')).json()).control.presenter,null);
 assert.equal((await action(first,firstConnection,'claim')).status,200);
 assert.equal((await env.client().request(root+'/control','POST',{connection:ca,action:'claim'})).status,401);
});

test('expired playback stops at lease end; retrying saved strokes creates one annotation',async()=>{
 const now=Date.now(),view=collaborationView({version:2,term:1,presenter:{expires:now-1000},requests:[],playback:{id:'x',at:now-LEASE_MS-1000,time:2,rate:1,playing:true}},now);
 assert.equal(view.playback.time,17);assert.equal(view.playback.playing,false);
 const env=setup(),a=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Retry',name:'A'})).json(),root='/api/rooms/'+id;
 const event={type:'stroke',requestId:crypto.randomUUID(),strokeId:crypto.randomUUID(),points:[[0,0],[1,1]],color:'#ffffff',time:1};
 const results=await Promise.all(Array.from({length:5},()=>a.request(root+'/events','POST',event)));
 const saved=await Promise.all(results.map(r=>r.json()));assert.equal(new Set(saved.map(r=>r.event.id)).size,1);assert.equal((await(await a.request(root+'/events')).json()).events.length,1);
});

test('live gestures are bounded, expire, and never enter saved history',async()=>{
 const env=setup(),a=env.client(),b=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Gestures',name:'A'})).json(),root='/api/rooms/'+id;await b.request(root+'/join','POST',{name:'B'});
 const gesture={connection:crypto.randomUUID(),strokeId:crypto.randomUUID(),asset:crypto.randomUUID(),kind:'laser',tool:'laser',points:[[.2,.3]],color:'#ff0000',time:0,sequence:2};
 assert.equal((await a.request(root+'/gesture','POST',gesture)).status,200);
 let live=await(await b.request(root+'/live')).json();assert.equal(live.gestures.length,1);assert.equal(live.gestures[0].name,'A');assert.equal((await(await b.request(root+'/events')).json()).events.length,0);
 await a.request(root+'/gesture','POST',{...gesture,sequence:1,kind:'clear'});assert.equal((await(await b.request(root+'/live')).json()).gestures.length,1);
 await a.request(root+'/gesture','POST',{...gesture,sequence:3,kind:'clear'});assert.equal((await(await b.request(root+'/live')).json()).gestures.length,0);
 assert.equal((await a.request(root+'/gesture','POST',{...gesture,points:[[2,0]]})).status,400);
});

test('stream delivers changes incrementally and a fresh stream recovers latest state',async()=>{
 const env=setup(),a=env.client();const {id}=await(await a.request('/api/rooms','POST',{title:'Stream',name:'A'})).json(),root='/api/rooms/'+id;
 const response=await a.request(root+'/stream');assert.match(response.headers.get('Content-Type'),/event-stream/);
 const reader=response.body.getReader(),decoder=new TextDecoder();await reader.read();
 const first=decoder.decode((await reader.read()).value);assert.match(first,/"version":0/);
 await a.request(root+'/control','POST',{connection:crypto.randomUUID(),action:'claim'});
 const next=decoder.decode((await reader.read()).value);assert.match(next,/"name":"A"/);await reader.cancel();
 const fresh=(await a.request(root+'/stream')).body.getReader();await fresh.read();assert.match(decoder.decode((await fresh.read()).value),/"name":"A"/);await fresh.cancel();
 assert.equal((await env.client().request(root+'/stream')).status,401);
});
