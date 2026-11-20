import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './test-support.js';
async function roomFor(setup){const host=setup.client();const created=await host.request('/api/rooms','POST',{title:'Studio QA',name:'Host'});const {id}=await created.json();return {host,id,root:'/api/rooms/'+id};}
const png=Buffer.from('test-image-bytes');

test('live playback and presence stay independent of annotation history',async()=>{
 const env=setup(),{host,id,root}=await roomFor(env),guest=env.client();await guest.request(root+'/join','POST',{name:'Reviewer'});
 for(let i=0;i<70;i++){await host.request(root+'/events','POST',{type:'presence'});await host.request(root+'/events','POST',{type:'playhead',time:i,playing:i%2===0,rate:1.5});}
 assert.equal([...env.objects.keys()].filter(key=>key.startsWith(`rooms/${id}/events/`)).length,0,'transient updates never grow saved history');
 const state=await (await guest.request(root+'/live')).json();assert.equal(state.playback.time,69);assert.equal(state.playback.rate,1.5);assert.equal(state.people.length,1);assert.equal(state.people[0].name,'Host');assert.ok(state.serverTime>0);
 await guest.request(root+'/events','POST',{type:'comment',text:'Persistent note',time:3});
 assert.equal((await (await host.request(root+'/events')).json()).events.length,1);
 assert.equal((await env.client().request(root+'/live')).status,401);
});

test('media history preserves uploads and shared selection without losing notes',async()=>{
 const env=setup(),{host,root}=await roomFor(env),guest=env.client();await guest.request(root+'/join','POST',{name:'Reviewer'});
 let response=await host.request(root+'/media','POST',png,{'Content-Type':'image/png','X-File-Name':encodeURIComponent('ภาพ one.png')});assert.equal(response.status,200);const first=(await response.json()).asset;assert.equal(first.name,'ภาพ one.png');assert.equal(first.size,png.length);
 await host.request(root+'/events','POST',{type:'comment',text:'First version note',time:0,asset:first.id});
 response=await host.request(root+'/media','POST',Buffer.from('second'),{'Content-Type':'image/png','X-File-Name':'second.png'});const second=(await response.json()).asset;
 const history=await (await guest.request(root+'/assets')).json();assert.equal(history.assets.length,2);assert.ok(history.assets.some(asset=>asset.id===first.id));
 assert.equal((await (await guest.request(root+'/live')).json()).media.id,second.id);
 assert.equal((await guest.request(root+'/media/select','POST',{id:first.id})).status,200);
 const state=await (await host.request(root+'/live')).json();assert.equal(state.media.id,first.id);assert.equal(state.playback.playing,false);assert.equal(state.playback.time,0);
 assert.equal((await (await guest.request(root+'/events')).json()).events[0].asset,first.id);
 const range=await guest.request(root+'/media/'+first.id,'GET',undefined,{Range:'bytes=0-3'});assert.equal(range.status,206);assert.equal(range.headers.get('Content-Length'),'4');assert.equal(await range.text(),'test');
 const head=await guest.request(root+'/media/'+first.id,'HEAD');assert.equal(head.headers.get('Content-Length'),String(png.length));assert.equal(await head.text(),'');
 assert.equal((await guest.request(root+'/media/select','POST',{id:crypto.randomUUID()})).status,404);
 assert.equal((await host.request(root+'/media','POST','',{'Content-Type':'image/png'})).status,400);
 assert.equal((await env.client().request(root+'/assets')).status,401);
});

test('threaded replies, edits and undo retain author permissions',async()=>{
 const env=setup(),{host,root}=await roomFor(env),guest=env.client();await guest.request(root+'/join','POST',{name:'Reviewer'});
 const post=(who,event)=>who.request(root+'/events','POST',event);
 const note=(await (await post(host,{type:'comment',text:'Root',time:1})).json()).event;
 assert.equal((await post(guest,{type:'comment',text:'Reply',time:1,parent:note.id})).status,200);
 assert.equal((await post(guest,{type:'comment-edit',target:note.id,text:'Forged edit'})).status,403);
 assert.equal((await post(host,{type:'comment-edit',target:note.id,text:'Edited by author'})).status,200);
 assert.equal((await post(guest,{type:'resolve',target:note.id,resolved:true})).status,200);
 const stroke=(await (await post(host,{type:'stroke',time:1,points:[[.1,.2],[.7,.8]],color:'#ffffff',tool:'arrow',width:6})).json()).event;
 assert.equal((await post(guest,{type:'stroke-hide',target:stroke.id,hidden:true})).status,403);
 assert.equal((await post(host,{type:'stroke-hide',target:stroke.id,hidden:true})).status,200);
 assert.equal((await post(host,{type:'stroke-hide',target:stroke.id,hidden:false})).status,200);
 assert.equal((await post(host,{type:'stroke',time:1,points:[[.1,.2],[.7,.8]],color:'#ffffff',tool:'script'})).status,400);
 const other=await roomFor(env);assert.equal((await post(host,{type:'comment',text:'Wrong room',time:0,parent:other.root+'/events/not-a-real-event'})).status,400);
 const renamed=await guest.request(root+'/session','POST',{name:'New Name'});assert.equal(renamed.status,200);
 const renamedNote=(await (await post(guest,{type:'comment',text:'New author name',time:2,name:'Forged'})).json()).event;assert.equal(renamedNote.name,'New Name');
 assert.equal((await post(host,{type:'resolve',target:stroke.id,resolved:true})).status,404);
});

test('malformed requests fail with useful errors',async()=>{
 const env=setup(),{host,root}=await roomFor(env);
 assert.equal((await host.request(root+'/events','POST','broken json')).status,400);
 assert.equal((await host.request(root+'/events','POST',{type:'playhead',time:1,playing:'yes'})).status,400);
 assert.equal((await host.request(root+'/events','POST',{type:'comment',time:-1,text:'bad'})).status,400);
 assert.equal((await host.request(root+'/events','POST',{type:'comment',time:0,text:'ok',asset:'wrong'})).status,400);
 assert.equal((await host.request(root+'/live','POST',{})).status,405);
 assert.equal((await host.request('/api/other/'+crypto.randomUUID())).status,404);
});

test('byte ranges and stale playback fail safely after media switches',async()=>{
 const env=setup(),{host,root}=await roomFor(env);
 let response=await host.request(root+'/media','POST',png,{'Content-Type':'image/png'});const first=(await response.json()).asset;
 response=await host.request(root+'/media','POST',Buffer.from('replacement'),{'Content-Type':'image/png'});const second=(await response.json()).asset;
 assert.equal((await host.request(root+'/events','POST',{type:'playhead',time:4,playing:true,asset:first.id})).status,409);
 assert.equal((await (await host.request(root+'/live')).json()).playback.asset,second.id);
 const suffix=await host.request(root+'/media/'+first.id,'GET',undefined,{Range:'bytes=-5'});assert.equal(suffix.status,206);assert.equal(await suffix.text(),'bytes');
 for(const range of ['bytes=9999-','bytes=5-1','bytes=-0','bytes=0-2,5-7','nonsense']){
  const result=await host.request(root+'/media/'+first.id,'GET',undefined,{Range:range});assert.equal(result.status,416,range);assert.equal(result.headers.get('Content-Range'),'bytes */'+png.length);
 }
 assert.equal((await host.request(root+'/media','POST','small',{'Content-Type':'image/png','Content-Length':String(81*1024*1024)})).status,413);
});

test('known-length upload streaming preserves the file body',async()=>{
 const original=globalThis.FixedLengthStream;
 globalThis.FixedLengthStream=class{constructor(size){let count=0;const stream=new TransformStream({transform(chunk,controller){count+=chunk.byteLength;assert.ok(count<=size);controller.enqueue(chunk)},flush(){assert.equal(count,size)}});this.readable=stream.readable;this.writable=stream.writable}};
 try{const env=setup(),{host,root}=await roomFor(env);const response=await host.request(root+'/media','POST',png,{'Content-Type':'image/png','Content-Length':String(png.length)});assert.equal(response.status,200);const asset=(await response.json()).asset;assert.equal(await (await host.request(root+'/media/'+asset.id)).text(),png.toString());}
 finally{if(original===undefined)delete globalThis.FixedLengthStream;else globalThis.FixedLengthStream=original;}
});
