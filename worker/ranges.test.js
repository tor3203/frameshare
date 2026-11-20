import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {setup} from './test-support.js';import {collaborationView,playbackTimeAt} from './collaboration.js';
async function model(){
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{value:0,checked:false,style:{},classList:{add(){},remove(){}},focus(){},setPointerCapture(){},hasPointerCapture(){return true},releasePointerCapture(){},getBoundingClientRect(){return {left:0,width:400}},setAttribute(){}});return nodes.get(id)};
 const c=vm.createContext({$:get,video:{duration:4,currentTime:0,paused:true,pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()}},asset:{id:'A',type:'video/mp4'},room:'room',client:'guestA',fps:24,localStorage:{},fmt:n=>n.toFixed(3),explore(){c.follow=false},scheduleBroadcast(){c.broadcasts=(c.broadcasts||0)+1},syncComparison(){c.referenceTime=c.video.currentTime+2},console});
 vm.runInContext(await readFile('web/ranges.js','utf8'),c);return {c,get,run:s=>vm.runInContext(s,c)};
}
test('inclusive source-frame range bounds include single frames and clamp invalid local preferences',async()=>{
 const b=await model();assert.equal(b.run('rangeWindow({in:24,out:47,fps:24},4).start'),1);assert.equal(b.run('rangeWindow({in:24,out:47,fps:24},4).end'),2);
 assert.equal(b.run('rangeWindow({in:24,out:24,fps:24},4).end'),25/24);assert.equal(b.run('normalizedRange({in:-10,out:99999,fps:24},4).out'),95);
 assert.equal(b.run('normalizedRange({in:70,out:2,fps:24},4).out'),70);assert.equal(b.run('normalizedRange(null,4,30).out'),119);
});
test('moving a range keeps its frame count and loop mode while clamping at both clip edges',async()=>{
 const b=await model();b.run('r={in:20,out:69,fps:24,loop:true}');
 for(const [delta,start,end] of [[10,30,79],[999,46,95],[-999,0,49],[0,20,69]]){b.c.delta=delta;b.run('moved=shiftedPlaybackRange(r,delta,4)');assert.equal(b.run('moved.in'),start);assert.equal(b.run('moved.out'),end);assert.equal(b.run('moved.out-moved.in+1'),50);assert.equal(b.run('moved.loop'),true);}
 assert.equal(b.run('shiftedPlaybackRange({in:0,out:95,fps:24},100,4).in'),0);
 b.run('playbackRange=r;video.currentTime=2;video.paused=false;movePlaybackRange(10)');assert.equal(b.c.video.currentTime,2,'moving a range never retimes the source playhead or feedback');assert.equal(b.c.video.paused,true);assert.equal(b.c.follow,false);assert.equal(b.run('rangeDirty'),true);b.run('restorePlaybackRange()');assert.equal(b.run('playbackRange.in'),30);assert.equal(b.run('playbackRange.out'),79);
});
test('range-band dragging uses its original boundaries, and a plain click still seeks',async()=>{
 const b=await model();b.run('playbackRange={in:20,out:69,fps:24,loop:true};video.currentTime=2');
 const pointer=x=>({button:0,pointerId:1,clientX:x,preventDefault(){},stopPropagation(){}}),band=b.get('rangeFill');
 band.onpointerdown(pointer(100));band.onpointermove(pointer(120));assert.equal(b.run('playbackRange.in'),25);band.onpointermove(pointer(140));assert.equal(b.run('playbackRange.in'),30,'delta is measured from the start, not accumulated on each event');assert.equal(b.run('playbackRange.out'),79);band.onpointerup(pointer(140));
 b.get('seek').oninput=()=>{b.c.video.currentTime=Number(b.get('seek').value)};band.onpointerdown(pointer(100));band.onpointermove(pointer(101));band.onpointerup(pointer(101));assert.equal(b.c.video.currentTime,1.01);assert.equal(b.run('playbackRange.in'),30,'small pointer jitter does not move the range');
 let prevented=false;band.onkeydown({key:'ArrowRight',shiftKey:true,stopPropagation(){},preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(b.run('playbackRange.in'),40);assert.equal(b.run('playbackRange.out'),89);
});
test('range playback wraps multiple cycles and stops on the inclusive Out source frame',async()=>{
 const b=await model();b.run('r={in:24,out:47,fps:24,loop:true}');assert.equal(b.run('rangePlaybackTime(1,3.25,r,4)'),1.25);assert.equal(b.run('rangePlaybackTime(0,0,r,4)'),1);
 assert.equal(b.run('rangePlaybackTime(1,3.25,{...r,loop:false},4)'),47/24);
 assert.equal(b.run('rangePlaybackTime(1,1,{in:30,out:30,fps:30,loop:true},4,30)').toFixed(6),'1.000000');
});
test('local edits, Reset and FPS changes persist per guest and version',async()=>{
 const b=await model();b.run("editPlaybackRange('in',24);editPlaybackRange('out',47);editPlaybackRange('loop',true)");assert.equal(b.c.follow,false);assert.equal(b.run('rangeDirty'),true);assert.equal(b.get('rangeIn').max,96,'frame handles share the playhead time axis, including clip end');assert.equal(b.get('rangeFill').style.left,'25%');assert.equal(b.get('rangeFill').style.width,'25%');
 b.run('restorePlaybackRange()');assert.equal(b.run('playbackRange.in'),24);assert.equal(b.run('playbackRange.loop'),true);
 b.c.client='guestB';b.run('restorePlaybackRange()');assert.equal(b.run('playbackRange'),null);
 b.c.client='guestA';b.run('restorePlaybackRange();fps=30;retimePlaybackRange()');assert.equal(b.run('playbackRange.in'),30);assert.equal(b.run('playbackRange.out'),59);
 b.run("editPlaybackRange('reset')");assert.equal(b.run('playbackRange.in'),0);assert.equal(b.run('playbackRange.out'),119);assert.equal(b.run('playbackRange.loop'),true);
 b.c.asset={id:'B',type:'video/mp4'};b.run('restorePlaybackRange()');assert.equal(b.run('playbackRange'),null);
});
test('loop and stop move A and its aligned B together without rewriting feedback source times',async()=>{
 const b=await model();b.run("history=[{asset:'A',time:1},{asset:'B',time:3}];snapshot=JSON.stringify(history);playbackRange={in:24,out:47,fps:24,loop:true};video.paused=false;video.currentTime=2.125;enforcePlaybackRange()");assert.equal(b.c.video.currentTime,1.125);assert.equal(b.c.referenceTime,3.125);
 b.run('playbackRange.loop=false;video.currentTime=2;enforcePlaybackRange()');assert.equal(b.c.video.currentTime,47/24);assert.equal(b.c.video.paused,true);assert.equal(b.run('JSON.stringify(history)'),b.run('snapshot'));
 b.run('playbackRange.loop=true;video.currentTime=4;enforcePlaybackRange(true)');assert.equal(b.c.video.currentTime,1);assert.equal(b.c.video.paused,false);
 b.run('video.pause();video.currentTime=0;enforcePlaybackRange()');assert.equal(b.c.video.currentTime,0,'paused inspection outside the range stays on original source frames');
});
test('received ranges survive metadata delays and refresh before presenter handoff',async()=>{
 const b=await model();b.c.video.duration=NaN;b.run('receivePlaybackRange({in:24,out:47,fps:24,loop:true})');assert.equal(b.run('playbackRange.out'),47);assert.equal(b.run('rangeDirty'),false);
 b.c.video.duration=4;b.run('restorePlaybackRange()');assert.equal(b.run('playbackRangeState().out'),47);b.run('receivePlaybackRange(null)');assert.equal(b.run('playbackRangeState()'),null);
});
test('server range projection respects looping on lease expiry and non-looping Out on handoff',()=>{
 const p={time:1,at:1000,playing:true,rate:1,range:{in:24,out:47,fps:24,loop:true}};
 assert.equal(playbackTimeAt(p,4250),1.25);const state=collaborationView({presenter:{expires:4250},playback:p,requests:[]},5000);assert.equal(state.playback.time,1.25);assert.equal(state.playback.playing,false);assert.equal(p.playing,true);
 assert.equal(playbackTimeAt({...p,range:{...p.range,loop:false}},4250),47/24);
});
test('account-free guests receive durable ranges, Reset and offsets without changing annotations; stale and malformed writes fail',async()=>{
 const env=setup(),a=env.client(),b=env.client();try{
 const {id}=await(await a.request('/api/rooms','POST',{title:'Ranges',name:'Host'})).json(),root='/api/rooms/'+id;await b.request(root+'/join','POST',{name:'Reviewer'});
 const upload=async(headers={})=>(await(await a.request(root+'/media','POST','movie',{'Content-Type':'video/mp4',...headers})).json()).asset;
 const first=await upload(),second=await upload({'X-Version-Of':first.id});await a.request(root+'/media/select','POST',{id:first.id});
 for(const item of [first,second]){await a.request(root+'/events','POST',{type:'comment',asset:item.id,time:3,text:'Source frame 72'});await a.request(root+'/events','POST',{type:'stroke',asset:item.id,time:3,points:[[.1,.2],[.3,.4]],color:'#ffffff'});}
 const before=(await(await b.request(root+'/events')).json()).events,connection=crypto.randomUUID(),control=(await(await a.request(root+'/control','POST',{action:'claim',connection})).json()).control;
 const body={action:'playback',connection,term:control.term,sequence:1,asset:first.id,time:1,playing:true,rate:1,range:{in:24,out:47,fps:24,loop:true},comparison:{asset:second.id,mode:'side',offset:2}};
 assert.equal((await a.request(root+'/control','POST',body)).status,200);let live=await(await b.request(root+'/live')).json();assert.deepEqual(live.playback.range,body.range);assert.equal(live.playback.comparison.offset,2);
 assert.deepEqual((await(await b.request(root+'/live')).json()).playback.range,body.range,'fresh request recovers the same durable range');
 assert.equal((await b.request(root+'/control','POST',{...body,connection:crypto.randomUUID()})).status,409);
 for(const range of [{...body.range,in:-1},{...body.range,out:2},{...body.range,fps:0},{...body.range,loop:'yes'},{...body.range,out:2.5}])assert.equal((await a.request(root+'/control','POST',{...body,sequence:2,range})).status,400);
 const {range,...legacy}=body;assert.equal((await a.request(root+'/control','POST',{...legacy,sequence:2})).status,200);assert.deepEqual((await(await b.request(root+'/live')).json()).playback.range,range,'older clients cannot accidentally erase the current range');
 assert.equal((await a.request(root+'/control','POST',{...body,sequence:3,range:null,playing:false})).status,200);live=await(await b.request(root+'/live')).json();assert.equal(live.playback.range,null);assert.equal(live.playback.comparison.offset,2);
 assert.deepEqual((await(await b.request(root+'/events')).json()).events,before);
 }finally{env.db.close()}
});
