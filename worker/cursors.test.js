import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './test-support.js';

test('guests have distinct stable colors; cursors are authenticated, ordered and transient',async()=>{
 const env=setup(),a=env.client(),b=env.client();const created=await(await a.request('/api/rooms','POST',{title:'Cursor QA',name:'Alice'})).json(),root='/api/rooms/'+created.id;
 const bob=await(await b.request(root+'/join','POST',{name:'Bob'})).json();assert.match(created.color,/^#[a-f0-9]{6}$/i);assert.notEqual(created.color,bob.color);
 assert.equal((await(await a.request(root+'/session')).json()).color,created.color);
 const renamed=await(await a.request(root+'/session','POST',{name:'Alice renamed'})).json();assert.equal(renamed.color,created.color);
 const connection=crypto.randomUUID(),cursor={connection,sequence:2,visible:true,asset:crypto.randomUUID(),x:.2,y:.7,name:'Spoofed',color:bob.color};
 assert.equal((await a.request(root+'/cursor','POST',cursor)).status,200);
 const live=await(await b.request(root+'/live')).json(),remote=live.gestures.find(g=>g.kind==='cursor');assert.equal(remote.color,created.color);assert.equal(remote.name,'Alice renamed');assert.equal(remote.x,.2);
 await a.request(root+'/cursor','POST',{...cursor,sequence:1,x:.9});assert.equal((await(await b.request(root+'/live')).json()).gestures.find(g=>g.kind==='cursor').x,.2);
 // Cursor row is independent of a simultaneous drawing preview.
 await a.request(root+'/gesture','POST',{connection,sequence:1,kind:'preview',strokeId:crypto.randomUUID(),asset:cursor.asset,tool:'pen',points:[[.2,.7],[.3,.8]],time:0,color:'#ffffff'});
 assert.equal((await(await b.request(root+'/live')).json()).gestures.length,2);
 const stream=(await b.request(root+'/stream')).body.getReader();await stream.read();const packet=new TextDecoder().decode((await stream.read()).value);assert.match(packet,/"kind":"cursor"/);await stream.cancel();
 await a.request(root+'/cursor','POST',{connection,sequence:3,visible:false});assert.equal((await(await b.request(root+'/live')).json()).gestures.filter(g=>g.kind==='cursor').length,0);
 assert.equal((await(await b.request(root+'/events')).json()).events.length,0);
 assert.equal((await a.request(root+'/cursor','POST',{...cursor,sequence:4,x:1.1})).status,400);assert.equal((await env.client().request(root+'/cursor','POST',cursor)).status,401);
 await a.request(root+'/events','POST',{type:'presence',identityColor:bob.color});const people=(await(await b.request(root+'/live')).json()).people;assert.equal(people[0].identityColor,created.color);
});
