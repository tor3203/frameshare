import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function browser(search='') {
  const nodes=new Map(),requests=[],history=[],clipboard=[];
  function node(tag='div') {return {tagName:tag.toUpperCase(),value:'',checked:false,children:[],attributes:{},style:{},classList:{toggle(){}},currentTime:0,duration:4,readyState:0,paused:true,scrollTop:0,
    setAttribute(k,v){this.attributes[k]=v},getAttribute(k){return this.attributes[k]},removeAttribute(){},addEventListener(){},getContext(){return {}},getBoundingClientRect(){return {width:640,height:360}},
    append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},load(){},focus(){this.focused=true},scrollIntoView(){this.scrolled=true},
    querySelectorAll(){return this.children.flatMap(child=>[...(child.attributes?.['data-comment-id']?[child]:[]),...child.querySelectorAll()])}};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
  const c=vm.createContext({document:{getElementById:get,createElement:node,addEventListener(){},querySelector(){return null}},location:{search,origin:'https://review.test',pathname:'/',hash:''},history:{replaceState(a,b,url){history.push(url)}},navigator:{clipboard:{async writeText(value){clipboard.push(value)}}},URLSearchParams,devicePixelRatio:1,crypto,sessionStorage:{},localStorage:{},ResizeObserver:class{observe(){}},window:{addEventListener(){}},setTimeout(){return 1},clearTimeout(){},setInterval(){},console,fetch:async(url,options={})=>{requests.push({url,options});throw Error('Unexpected request '+url)}});
  const script=(await readFile('web/app.js','utf8')).replace(/^boot\(\);/m,'')+'\n'+await readFile('web/editor.js','utf8')+'\n'+await readFile('web/onion.js','utf8')+'\n'+await readFile('web/ranges.js','utf8')+'\n'+await readFile('web/attachments.js','utf8');
  vm.runInContext(script,c);
  vm.runInContext("renderDrawing=renderMarkers=renderVersionOptions=renderPeople=updateSyncHint=()=>{};saveView=restoreView=saveDraft=loadDraft=()=>{};joined=true;room='room';$('noteFilter').value='all';",c);
  return {c,get,requests,history,clipboard,run:code=>vm.runInContext(code,c)};
}

test('frame links round-trip source version, frame and FPS; malformed targets are rejected',async()=>{
  const b=await browser();b.run(`asset={id:'${B}',type:'video/mp4'};fps=30;video.currentTime=1.1;link=reviewLink();parsed=parseReviewTarget(link.slice(link.indexOf('?')));`);
  assert.equal(b.run('parsed.asset'),B);assert.equal(b.run('parsed.frame'),33);assert.equal(b.run('parsed.fps'),30);
  for(const suffix of ['frame=-1','frame=NaN','frame=1.2','frame=Infinity','frame=999999999999','frame=2&fps=0','frame=2&fps=29.97'])assert.equal(b.run(`parseReviewTarget('?asset=${A}&${suffix}')`),null);
  assert.equal(b.run("parseReviewTarget('?asset=bad&frame=0')"),null);
  assert.equal(b.run(`parseReviewTarget('?asset=${A}')`),null);
  b.run(`asset={id:'${A}',type:'image/png'};video.currentTime=3`);assert.equal(new URL(b.run('reviewLink()')).searchParams.get('frame'),'0');
});

test('linked frame waits for metadata, survives a fresh guest load and never changes shared selection',async()=>{
  const search=`?room=room&asset=${B}&frame=48&fps=24`;
  for(let reload=0;reload<2;reload++){
    const b=await browser(search);b.run(`assets=[{id:'${A}',type:'video/mp4',name:'original'},{id:'${B}',type:'video/mp4',name:'revised'}];loadAssets=async()=>{};refresh=async()=>{};syncComparison=()=>{};`);
    await b.run('openReviewTarget()');assert.equal(b.run('asset.id'),B);assert.equal(b.get('follow').checked,false);assert.equal(b.run('pendingVersionTime'),2);
    b.get('video').readyState=1;b.get('video').onloadedmetadata();assert.equal(b.get('video').currentTime,2);
    b.run(`api=async()=>({serverTime:Date.now(),media:{id:'${A}',type:'video/mp4'},control:{version:1,presenter:{name:'Lead',owner:'another'},requests:[]},playback:{asset:'${A}',time:1,playing:true}})`);
    await b.run('liveSync()');assert.equal(b.run('asset.id'),B);assert.equal(b.get('video').currentTime,2);assert.equal(b.get('video').paused,true);assert.equal(b.requests.length,0);
    await b.run(`selectVersion('${A}')`);assert.equal(b.run('asset.id'),A);assert.equal(b.get('follow').checked,false);assert.equal(b.requests.length,0,'local navigation never calls /media/select');
  }
});

test('comment link reveals and focuses an exact resolved reply on its original source frame',async()=>{
  const id='rooms/room/events/reply';const b=await browser(`?room=room&asset=${B}&frame=48&fps=24&comment=${encodeURIComponent(id)}`);
  b.run(`asset={id:'${B}',type:'video/mp4'};targetApplied=true;video.readyState=1;events=[{id:'root',asset:asset.id,type:'comment',time:2,at:1,name:'A',client:'other',text:'Root'},{id:'${id}',parent:'root',asset:asset.id,type:'comment',time:2.01,at:2,name:'B',client:'other',text:'Exact reply'},{id:'resolved',type:'resolve',asset:asset.id,target:'root',resolved:true}];$('noteFilter').value='open';$('noteSearch').value='hidden';applyLinkedComment();renderComments();`);
  assert.equal(b.get('video').currentTime,2.01,'saved source time is authoritative, even between frame boundaries');assert.equal(b.get('noteFilter').value,'all');assert.equal(b.get('noteSearch').value,'');
  const target=b.get('comments').querySelectorAll().find(n=>n.attributes['data-comment-id']===id);assert.ok(target.className.includes('linked-comment'));assert.equal(target.focused,true);assert.equal(target.scrolled,true);
  await b.run(`copyReviewLink(events[1])`);const url=new URL(b.clipboard[0]);assert.equal(url.searchParams.get('comment'),id);assert.equal(url.searchParams.get('asset'),B);assert.equal(url.searchParams.get('frame'),'48');
});

test('Follow presenter clears the route and restores shared version, time and comparison without publishing',async()=>{
  const b=await browser(`?room=room&asset=${B}&frame=48&fps=24&comment=note`);
  b.run(`asset={id:'${B}',type:'video/mp4'};pendingVersionTime=2;highlightedComment='note';video.readyState=1;api=async(path,options)=>{if(options)throw Error('must be read-only');return {media:{id:'${A}',type:'video/mp4'},control:{version:1,presenter:{owner:'other',name:'Lead'},requests:[]},playback:{id:'shared',asset:'${A}',time:1,playing:false,comparison:{asset:'${B}',mode:'side',offset:1}}}};loadAssets=async()=>{};receiveComparison=value=>received=value;`);
  await b.run('followSharedReview()');assert.equal(b.run('asset.id'),A);assert.equal(b.get('video').currentTime,1);assert.equal(b.run('received.offset'),1);assert.equal(b.get('follow').checked,true);assert.equal(b.run('pendingVersionTime'),null);assert.equal(b.run('highlightedComment'),'');assert.equal(b.history.at(-1),'/?room=room');
});

test('unavailable versions and comments keep the recipient local with a useful status',async()=>{
  const b=await browser(`?room=room&asset=${B}&frame=48&fps=24&comment=missing`);b.run('loadAssets=async()=>{}');await b.run('openReviewTarget()');assert.equal(b.get('follow').checked,false);assert.match(b.get('linkStatus').textContent,/unavailable/);
  b.run(`asset={id:'${B}',type:'video/mp4'};targetApplied=true;applyLinkedComment()`);assert.equal(b.run('highlightedComment'),'');assert.match(b.get('linkStatus').textContent,/comment is unavailable/);
  b.run('pendingVersionTime=999;applyPendingSourceTime()');assert.ok(b.get('video').currentTime<4);assert.match(b.get('linkStatus').textContent,/final frame/);
  await assert.rejects(b.run("copyReviewLink({id:'pending:test',asset:asset.id,time:0})"),/finish saving/);
});
