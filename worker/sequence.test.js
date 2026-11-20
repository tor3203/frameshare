import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {sequencePoint,sequenceBounds,projectedSequence,collaborationView} from './collaboration.js';import {setup} from './test-support.js';
const items=[{id:'A',duration:2,fps:24},{id:'B',duration:3,fps:30},{id:'C',duration:1,fps:24}];
test('combined time maps boundaries, loops and ends to exact original source frames',async()=>{
 for(const [position,id,time] of [[0,'A',0],[2,'B',0],[3,'B',1],[5,'C',0],[6,'C',23/24]]){const p=sequencePoint(items,position);assert.equal(p.asset,id);assert.ok(Math.abs(p.time-time)<1e-9);}
 assert.equal(sequencePoint(items,12.5,true).time,.5);assert.equal(sequencePoint(items,-2).position,0);
 const source=await readFile('web/sequence.js','utf8'),start=source.indexOf('function sequencePoint('),end=source.indexOf('function sequenceKey',start),c=vm.createContext({items});vm.runInContext(source.slice(start,end),c);
 for(const position of [0,1.99,2,4.5,5,6,15])for(const loop of [false,true]){c.position=position;c.loop=loop;assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(sequencePoint(items,position,loop))',c)),sequencePoint(items,position,loop));}
});
test('trimmed cuts project inclusive In/Out frames without retiming source feedback',async()=>{
 const cut=[{id:'A',duration:4,fps:24,in:24,out:47},{id:'B',duration:4,fps:24,in:48,out:95}];
 assert.equal(sequenceBounds(cut[0]).span,1);assert.equal(sequencePoint(cut,0).time,1);assert.equal(sequencePoint(cut,.5).time,1.5);assert.equal(sequencePoint(cut,1).asset,'B');assert.equal(sequencePoint(cut,1).time,2);assert.equal(sequencePoint(cut,3).time,95/24);assert.equal(sequencePoint(cut,3,true).time,1);
 const one=[{id:'A',duration:4,fps:24,in:24,out:24}];assert.equal(sequencePoint(one,100).time,1);assert.ok(Math.abs(sequenceBounds(one[0]).span-1/24)<1e-9);
 const source=await readFile('web/sequence.js','utf8'),start=source.indexOf('function sequencePoint('),end=source.indexOf('function sequenceKey(',start),c=vm.createContext({items:cut});vm.runInContext(source.slice(start,end),c);
 for(const position of [0,.5,1,2,3,10])for(const loop of [false,true]){c.position=position;c.loop=loop;assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(sequencePoint(items,position,loop))',c)),sequencePoint(cut,position,loop));}
});
test('cut trims clamp to one source frame and drag reorder keeps immutable IDs and trims',async()=>{
 const source=await readFile('web/sequence-editor.js','utf8'),start=source.indexOf('function cutOffset('),end=source.indexOf('function commitCut(',start),c=vm.createContext({sequenceBounds,item:{id:'A',duration:4,fps:24,in:24,out:47},items:[{id:'A',duration:4,fps:24,in:24,out:47},{id:'B',duration:4,fps:24},{id:'C',duration:4,fps:24}]});vm.runInContext(source.slice(start,end),c);
 assert.equal(vm.runInContext("trimmedCutItem(item,'in',999).in",c),47);assert.equal(vm.runInContext("trimmedCutItem(item,'out',-20).out",c),24);assert.equal(vm.runInContext("trimmedCutItem(item,'out',999).out",c),95);
 assert.equal(vm.runInContext("reorderedCut(items,'A','B',true).map(e=>e.id).join(',')",c),'B,A,C');assert.equal(vm.runInContext("reorderedCut(items,'C','A',false).map(e=>e.id).join(',')",c),'C,A,B');assert.equal(vm.runInContext("reorderedCut(items,'A','C',true)[2].in",c),24);assert.equal(vm.runInContext("cutOffset(items,'B')",c),1);
});
test('pointer edge drags and clip drops apply final coordinates, cancel safely and keep trim bounds',async()=>{
 const source=await readFile('web/sequence-editor.js','utf8'),helpers=source.slice(source.indexOf('function cutOffset('),source.indexOf('function commitCut(')),gesture=source.slice(source.indexOf('function beginCutDrag('),source.indexOf('function moveCutSelection('));
 const item={id:'A',duration:4,fps:24,in:24,out:95},items=[item,{id:'B',duration:4,fps:24}],classes={add(){},remove(){}},caption={},clip={style:{},classList:classes,querySelector(){return caption},setPointerCapture(){},hasPointerCapture(){return true},releasePointerCapture(){},focus(){},getBoundingClientRect(){return {left:0,width:210}}},status={},scroll={scrollLeft:0,getBoundingClientRect(){return {left:0,right:800}}};
 const c=vm.createContext({fmt:n=>n.toFixed(3),sequenceBounds,sequenceItems:items,cutDrag:null,cutSelection:'',cutSignature:'',document:{elementFromPoint(){return {closest(){return {dataset:{cutId:'B'},classList:classes,getBoundingClientRect(){return {left:210,width:280}}}}}}},$:id=>id==='cutTrack'?{children:[]}:id==='cutScroll'?scroll:status,renderCutEditor(){},commitCut(next){c.saved=next},explore(){},seekSequence(){}});vm.runInContext(helpers+gesture,c);
 const event=(x,edge)=>({button:0,pointerId:1,clientX:x,clientY:50,target:{closest(){return edge?{dataset:{trim:edge}}:null}},preventDefault(){}});c.item=item;c.clip=clip;c.down=event(210,'out');vm.runInContext('beginCutDrag(down,item,clip,70)',c);clip.onpointerup(event(140));assert.equal(c.saved[0].out,71,'final pointer-up is honored even if no intermediate move is delivered');assert.equal(c.saved[0].in,24);
 c.saved=null;c.down=event(210,'out');vm.runInContext('beginCutDrag(down,item,clip,70)',c);clip.onpointermove(event(-999));clip.onpointercancel(event(-999));assert.equal(c.saved,null);
 c.down=event(30);vm.runInContext('beginCutDrag(down,item,clip,70)',c);clip.onpointerup(event(470));assert.equal(c.saved[0].id,'B');assert.equal(c.saved[1].in,24);
});
test('manual end scrubs stop on the retained last frame while remote loop projection wraps',async()=>{
 const source=await readFile('web/sequence.js','utf8'),snippet=source.slice(source.indexOf('function seekSequence('),source.indexOf('async function openSequenceBuilder(')),list=[{id:'A',duration:4,fps:24,in:24,out:47}],nodes={loop:{checked:true},follow:{checked:false},present:{checked:false},fps:{}};
 let value=0;const video={readyState:4,duration:4,pause(){},play(){return Promise.resolve()}};Object.defineProperty(video,'currentTime',{get:()=>value,set:n=>{value=Math.floor(n*1e6)/1e6;}});
 const c=vm.createContext({sequenceActive:true,sequenceItems:list,sequencePoint,sequencePending:null,sequenceLoading:false,asset:{id:'A'},assets:[{id:'A'}],video,ownsControl:()=>false,$:id=>nodes[id],renderSequence(){},saveSequence(){},scheduleBroadcast(){},updateTime(){},fps:24});vm.runInContext(snippet,c);
 vm.runInContext('seekSequence(1,false,false)',c);assert.equal(Math.floor((value+.000001)*24),47,'paused frame survives microsecond media-time rounding');vm.runInContext('seekSequence(1,false,true)',c);assert.equal(Math.floor((value+.000001)*24),24);
});
test('saved edited cuts migrate older local preferences and resist writes from an older open tab',async()=>{
 const source=await readFile('web/sequence.js','utf8'),helpers=source.slice(source.indexOf('function sequenceKey('),source.indexOf('function sequencePosition(')),localStorage={'frameSequence:room:guest':'{"active":true,"playlist":{"position":2}}'},c=vm.createContext({room:'room',client:'guest',localStorage});vm.runInContext(helpers,c);assert.equal(JSON.parse(vm.runInContext('savedSequenceValue()',c)).playlist.position,2);
 localStorage[vm.runInContext('sequenceKey()',c)]='{"active":true,"playlist":{"position":1,"items":[{"in":24,"out":47}]}}';localStorage['frameSequence:room:guest']='{"active":false}';const restored=JSON.parse(vm.runInContext('savedSequenceValue()',c));assert.equal(restored.active,true);assert.equal(restored.playlist.items[0].in,24);
 c.client='other';assert.equal(vm.runInContext('savedSequenceValue()',c),'null');
});
test('sequence keyboard stepping crosses trimmed cuts once and respects each source frame rate',async()=>{
 const source=await readFile('web/sequence.js','utf8'),start=source.indexOf('function sequencePoint('),end=source.indexOf('function stepSequenceFrame(',start),items=[{id:'A',duration:4,fps:24,in:24,out:47},{id:'B',duration:4,fps:60,in:60,out:119},{id:'C',duration:4,fps:30,in:30,out:59}],c=vm.createContext({items});vm.runInContext(source.slice(start,end),c);
 const step=(id,time,direction,seconds=false)=>{Object.assign(c,{id,time,direction,seconds});return JSON.parse(vm.runInContext('JSON.stringify(sequenceStepPoint(items,id,time,direction,seconds))',c));};
 let p=step('A',47/24+.00001,1);assert.equal(p.asset,'B');assert.equal(Math.floor((p.time+.000001)*60),60);
 p=step('B',1,-1);assert.equal(p.asset,'A');assert.equal(Math.floor((p.time+.000001)*24),47);
 p=step('C',1,-1);assert.equal(p.asset,'B');assert.equal(Math.floor((p.time+.000001)*60),119);
 p=step('B',119/60+.00001,1);assert.equal(p.asset,'C');assert.equal(Math.floor((p.time+.000001)*30),30);
 p=step('A',1,-1);assert.equal(p.asset,'A');assert.equal(Math.floor((p.time+.000001)*24),24);
 p=step('C',59/30,1);assert.equal(p.asset,'C');assert.equal(Math.floor((p.time+.000001)*30),59);
 p=step('A',1,1,true);assert.equal(p.asset,'B');
});
test('disconnect freezes sequence on the correct shot instead of projecting source time into the previous shot',()=>{
 const p={asset:'A',time:1,at:1000,playing:true,rate:1,playlist:{items,position:1,loop:true},id:'p'};assert.equal(projectedSequence(p,3500).asset,'B');
 const state=collaborationView({presenter:{expires:3500},playback:p,requests:[]},5000);assert.equal(state.playback.asset,'B');assert.equal(state.playback.time,1.5);assert.equal(state.playback.playlist.position,3.5);assert.equal(state.playback.playing,false);assert.equal(p.asset,'A');
});
test('account-free sequence sync, reload, handoff and validation preserve source feedback',async()=>{
 const env=setup(),a=env.client(),b=env.client();try{const {id}=await(await a.request('/api/rooms','POST',{title:'Sequence',name:'Host'})).json(),root='/api/rooms/'+id;await b.request(root+'/join','POST',{name:'Reviewer'});const clips=[];for(let i=0;i<3;i++)clips.push((await(await a.request(root+'/media','POST','movie',{'Content-Type':'video/mp4'})).json()).asset);
 const list=clips.map(c=>({id:c.id,duration:4,fps:24}));await a.request(root+'/events','POST',{type:'comment',asset:clips[1].id,time:1,text:'Source frame 24'});await a.request(root+'/events','POST',{type:'stroke',asset:clips[1].id,time:1,points:[[.1,.2],[.3,.4]],color:'#ffffff'});const before=(await(await b.request(root+'/events')).json()).events;
 const connection=crypto.randomUUID(),term=(await(await a.request(root+'/control','POST',{action:'claim',connection})).json()).control.term;
 const body={action:'playback',connection,term,sequence:1,asset:clips[1].id,time:1,playing:false,playlist:{items:list,position:5,loop:true},range:null,comparison:null};assert.equal((await a.request(root+'/control','POST',body)).status,200);
 for(let i=0;i<2;i++){const live=await(await b.request(root+'/live')).json();assert.deepEqual(live.playback.playlist,body.playlist);assert.equal(live.playback.asset,clips[1].id);}
 for(const playlist of [{...body.playlist,position:-1},{...body.playlist,items:[list[0],list[0]]},{...body.playlist,items:[{...list[0],id:crypto.randomUUID()}]},{...body.playlist,items:[{...list[0],duration:0}]}])assert.equal((await a.request(root+'/control','POST',{...body,sequence:2,playlist})).status,400);
 assert.equal((await b.request(root+'/control','POST',{...body,connection:crypto.randomUUID()})).status,409);
 const other=crypto.randomUUID();await b.request(root+'/control','POST',{action:'claim',connection:other});const live=await(await a.request(root+'/live')).json();assert.equal((await a.request(root+'/control','POST',{action:'handoff',connection,term,target:live.control.requests[0].owner})).status,200);assert.deepEqual((await(await b.request(root+'/live')).json()).playback.playlist,body.playlist);assert.deepEqual((await(await b.request(root+'/events')).json()).events,before);
 }finally{env.db.close();}
});
test('edited sequences retain trims and source feedback for another guest and reject stale or invalid edits',async()=>{
 const env=setup(),a=env.client(),b=env.client();try{const {id}=await(await a.request('/api/rooms','POST',{title:'Cut',name:'Editor'})).json(),root='/api/rooms/'+id;await b.request(root+'/join','POST',{name:'Reviewer'});const clips=[];for(let i=0;i<2;i++)clips.push((await(await a.request(root+'/media','POST','movie',{'Content-Type':'video/mp4'})).json()).asset);
 await a.request(root+'/events','POST',{type:'comment',asset:clips[1].id,time:2,text:'Source frame 48'});await a.request(root+'/events','POST',{type:'stroke',asset:clips[1].id,time:2,points:[[.1,.2],[.4,.5]],color:'#ffffff'});const before=(await(await b.request(root+'/events')).json()).events;
 const connection=crypto.randomUUID(),term=(await(await a.request(root+'/control','POST',{action:'claim',connection})).json()).control.term;
 const items=[{id:clips[0].id,duration:4,fps:24,in:24,out:47},{id:clips[1].id,duration:4,fps:24,in:48,out:71}],playlist={editVersion:1,items,position:1,loop:true},body={action:'playback',connection,term,sequence:1,asset:clips[1].id,time:2,playing:false,playlist,range:null,comparison:null};assert.equal((await a.request(root+'/control','POST',body)).status,200);
 for(let i=0;i<2;i++)assert.deepEqual((await(await b.request(root+'/live')).json()).playback.playlist,playlist);
 for(const change of [{in:-1},{in:24.5},{out:10},{out:96}])assert.equal((await a.request(root+'/control','POST',{...body,sequence:2,playlist:{...playlist,items:[{...items[0],...change},items[1]]}})).status,400);
 const {editVersion,...old}=playlist;assert.equal((await a.request(root+'/control','POST',{...body,sequence:2,playlist:old})).status,409,'older windows cannot publish an incompatible edit');
 const reversed={...playlist,items:[items[1],items[0]],position:0};assert.equal((await a.request(root+'/control','POST',{...body,sequence:2,playlist:reversed})).status,200);assert.deepEqual((await(await b.request(root+'/live')).json()).playback.playlist.items,reversed.items);assert.deepEqual((await(await b.request(root+'/events')).json()).events,before);
 }finally{env.db.close();}
});
