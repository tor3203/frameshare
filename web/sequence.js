/* Sequence time is navigation only. Every annotation still uses asset + source time. */
let sequenceActive=false,sequenceItems=[],sequencePending=null,sequenceLoading=false,sequenceRestored=false,sequenceSignature='',sequenceDraft=[],sequenceDrag=null,sequenceDirty=false;
function sequencePoint(items,position,loop=false){
 const total=items.reduce((n,e)=>n+sequenceBounds(e).span,0),tail=items.at(-1);let p=Math.max(0,Number(position)||0);p=loop&&total?p%total:Math.min(p,Math.max(0,total-Math.min(tail?sequenceBounds(tail).span:0,1/(tail?.fps||24))));let start=0;
 for(let index=0;index<items.length;index++){const e=items[index],b=sequenceBounds(e);if(p<start+b.span||index===items.length-1)return {index,asset:e.id,time:b.start+Math.max(0,p-start),position:p,total};start+=b.span;}return null;
}
function sequenceBounds(item){
 const rate=item.fps||24,last=Math.max(0,Math.ceil(item.duration*rate-.000001)-1),first=Math.max(0,Math.min(last,Number.isInteger(item.in)?item.in:0)),out=Math.max(first,Math.min(last,Number.isInteger(item.out)?item.out:last));
 const start=first/rate,end=Math.min(item.duration,(out+1)/rate);return {in:first,out,start,end,span:end-start};
}
function sequenceStepPoint(items,id,time,direction,seconds=false){
 const index=items.findIndex(e=>e.id===id);if(index<0)return null;const item=items[index],b=sequenceBounds(item),offset=items.slice(0,index).reduce((n,e)=>n+sequenceBounds(e).span,0);
 if(seconds)return sequencePoint(items,offset+Math.max(0,time-b.start)+direction,false);
 const next=Math.floor((time+.00002)*item.fps)+direction;
 if(next>b.out&&index<items.length-1)return sequencePoint(items,offset+b.span+.0000001,false);
 if(next<b.in&&index>0){const previous=items[index-1],p=sequenceBounds(previous);return sequencePoint(items,offset-(p.end-p.out/previous.fps),false);}
 return sequencePoint(items,offset+(Math.max(b.in,Math.min(b.out,next))-b.in)/item.fps+.0000001,false);
}
function stepSequenceFrame(direction,seconds=false){const anchor=sequencePending||{asset:asset?.id,time:video.currentTime||0},point=sequenceStepPoint(sequenceItems,anchor.asset,anchor.time,direction,seconds);if(!point)return;explore();video.pause();seekSequence(point.position,false);}
function sequenceKey(){return 'frameSequenceEdit:'+room+':'+client;}
function savedSequenceValue(){return localStorage[sequenceKey()]||localStorage['frameSequence:'+room+':'+client]||'null';}
function sequencePosition(){let start=0;for(const e of sequenceItems){if(e.id===asset?.id)return start+Math.max(0,Math.min(sequenceBounds(e).span,(video.currentTime||0)-sequenceBounds(e).start));start+=sequenceBounds(e).span;}return 0;}
function sequenceState(){return sequenceActive?{editVersion:1,items:sequenceItems.map(e=>({...e})),position:sequencePending?.position??sequencePosition(),loop:$('loop').checked}:null;}
function saveSequence(){if(joined&&sequenceRestored)localStorage[sequenceKey()]=JSON.stringify({active:sequenceActive,playlist:sequenceState(),draft:sequenceDraft,dirty:sequenceDirty,following:$('follow').checked});}
const sequencePanel=el('details','sequence-panel');sequencePanel.id='sequencePanel';sequencePanel.innerHTML='<summary title="Choose video shots and play them in order. Notes keep their original version and frame.">Sequence playback <span id="sequenceSummary" class="subtle">Single shot</span></summary><div class="sequence-toolbar"><button id="editSequence" title="Select one video version per shot and reorder your sequence.">Choose shots</button><button id="exitSequence" hidden title="Return to reviewing the current shot on its own.">Exit sequence</button><span class="subtle">Nondestructive cut · single view · source-frame feedback</span></div><div id="sequenceQueue" class="sequence-queue"></div><p id="sequenceMessage" class="subtle" role="status"></p>';
document.querySelector('.stage').before(sequencePanel);
const sequencePrevious=button('Previous shot',()=>skipSequence(-1),'Open the previous shot at its first source frame.'),sequenceNext=button('Next shot',()=>skipSequence(1),'Open the next shot at its first source frame.');$('sequenceQueue').before(sequencePrevious,sequenceNext);
function skipSequence(delta){const index=sequenceItems.findIndex(e=>e.id===asset?.id),next=Math.max(0,Math.min(sequenceItems.length-1,index+delta));explore();seekSequence(sequenceItems.slice(0,next).reduce((n,e)=>n+sequenceBounds(e).span,0),false);}
const sequenceDialog=el('dialog');sequenceDialog.id='sequenceDialog';sequenceDialog.innerHTML='<h2>Build a sequence</h2><p>Select one version per shot. Move selected shots into playback order.</p><div id="sequenceChoices" class="sequence-choices"></div><div class="dialog-actions"><button id="cancelSequence">Cancel</button><button id="startSequence" class="primary">Use sequence</button></div><p id="sequenceBuildStatus" role="status"></p>';document.body.append(sequenceDialog);
const sequenceBoundaries=el('div','sequence-boundaries');sequenceBoundaries.id='sequenceBoundaries';$('timelineRail').append(sequenceBoundaries);
function renderSequence(){
 const active=sequenceActive;sequencePanel.classList.toggle('active',active);$('exitSequence').hidden=!active;
 sequencePrevious.hidden=sequenceNext.hidden=!active;sequencePrevious.disabled=sequenceItems[0]?.id===asset?.id;sequenceNext.disabled=sequenceItems.at(-1)?.id===asset?.id;
 $('sequenceSummary').textContent=active?sequenceItems.length+' shots · '+fmt(sequenceItems.reduce((n,e)=>n+sequenceBounds(e).span,0)):'Single shot';
 for(const id of ['rangeIn','rangeOut','rangeFill'])$(id).hidden=active;
 document.querySelector('.range-labels').hidden=active;document.querySelector('.playback-range').hidden=active;
 $('compareMode').disabled=active;$('fps').disabled=active;sequenceBoundaries.hidden=!active;
 $('seek').title=active?'Seek across all shots in the sequence. Feedback stays on the current shot’s source frame.':'Seek within A and its linked reference B. Followers explore locally; presenters share the new position.';
 $('loop').title=active?'Repeat the whole sequence. Presenters share this setting with followers.':'Loop A’s In/Out range. Presenters share this setting.';$('loop').parentElement.title=$('loop').title;
 const signature=JSON.stringify([active,sequenceItems,asset?.id,assets.map(a=>[a.id,a.shotName,a.versionLabel])]);
 if(signature!==sequenceSignature){sequenceSignature=signature;$('sequenceQueue').replaceChildren();sequenceBoundaries.replaceChildren();let start=0;const total=sequenceItems.reduce((n,e)=>n+sequenceBounds(e).span,0);
  if(active)for(const [index,e] of sequenceItems.entries()){const item=assets.find(a=>a.id===e.id),time=start;const b=button((index+1)+'. '+(item?.shotName||item?.name||'Shot')+' · '+(item?.versionLabel||'v1'),()=>{explore();seekSequence(time,false);},'Open this sequence shot at its first source frame.');b.classList.toggle('active',e.id===asset?.id);$('sequenceQueue').append(b);const mark=el('span','sequence-boundary');mark.style.left=start/total*100+'%';mark.title=(item?.shotName||'Shot')+' · '+fmt(start);sequenceBoundaries.append(mark);start+=sequenceBounds(e).span;}
 }
 if(active){const total=sequenceItems.reduce((n,e)=>n+sequenceBounds(e).span,0),p=sequencePending?.position??sequencePosition();$('seek').max=total;$('seek').value=p;$('time').textContent=fmt(p)+' / '+fmt(total)+' · sequence';$('sequenceMessage').textContent='Shot '+(sequenceItems.findIndex(e=>e.id===asset?.id)+1)+' of '+sequenceItems.length+' · frame '+frame(video.currentTime||0)+' in this version'+((()=>{const item=sequenceItems.find(e=>e.id===asset?.id);if(!item)return false;const b=sequenceBounds(item);return video.currentTime<b.start-.00001||video.currentTime>=b.end;})()?' · outside cut; Play returns to the kept range':'');}
}
function seekSequence(position,playing=false,remote=false){
 if(!sequenceActive)return;const point=sequencePoint(sequenceItems,position,remote&&$('loop').checked);if(!point)return;
 const next=assets.find(a=>a.id===point.asset);if(!next){$('sequenceMessage').textContent='Loading sequence media…';return;}
 sequencePending={...point,playing};const same=asset?.id===point.asset,following=$('follow').checked,presenting=ownsControl();
 if(!same){sequenceLoading=true;setAsset(next);sequenceLoading=false;$('follow').checked=following;$('present').checked=presenting;receiveComparison(null);}
 fps=sequenceItems[point.index].fps;$('fps').value=fps;
 if(same&&video.readyState>=1||!same&&video.readyState>=1){applySequencePending();}
 renderSequence();if(!remote){saveSequence();scheduleBroadcast();}
}
function applySequencePending(){const p=sequencePending;if(!p||asset?.id!==p.asset||video.readyState<1)return;sequencePending=null;video.currentTime=Math.min(video.duration,p.playing?p.time:Math.floor((p.time+.00001)*fps)/fps+.00001);if(p.playing)video.play().catch(()=>{$('reviewControlDetail').textContent='Click Play once to allow sequence playback.';});else video.pause();updateTime();}
async function openSequenceBuilder(){
 if(!joined)return;await loadAssets();sequenceDraft=sequenceActive?sequenceItems.map(e=>e.id):sequenceDraft.filter(id=>assets.some(a=>a.id===id));renderSequenceChoices();$('sequenceBuildStatus').textContent='';sequenceDialog.showModal();
}
function renderSequenceChoices(){
 const holder=$('sequenceChoices');holder.replaceChildren();const groups=shotsInOrder().filter(g=>g.versions.some(v=>v.type.startsWith('video'))),ordered=[...sequenceDraft.map(id=>groups.find(g=>g.versions.some(v=>v.id===id))).filter(Boolean),...groups.filter(g=>!g.versions.some(v=>sequenceDraft.includes(v.id)))];
 for(const group of ordered){const versions=group.versions.filter(v=>v.type.startsWith('video')),selected=sequenceDraft.find(id=>versions.some(v=>v.id===id)),row=el('div','sequence-choice');row.draggable=Boolean(selected);row.ondragstart=()=>{sequenceDrag=selected;};row.ondragover=e=>{if(selected)e.preventDefault();};row.ondrop=e=>{e.preventDefault();const from=sequenceDraft.indexOf(sequenceDrag),to=sequenceDraft.indexOf(selected);if(from>=0&&to>=0){sequenceDraft.splice(to,0,sequenceDraft.splice(from,1)[0]);renderSequenceChoices();}};
  const check=el('input');check.type='checkbox';check.checked=Boolean(selected);check.setAttribute('aria-label','Include '+versions[0].shotName);check.title='Include this shot in the sequence.';check.onchange=()=>{sequenceDraft=sequenceDraft.filter(id=>!versions.some(v=>v.id===id));if(check.checked)sequenceDraft.push(select.value);renderSequenceChoices();};const select=el('select');select.title='Choose the version to play for this shot.';select.setAttribute('aria-label','Version for '+versions[0].shotName);for(const v of versions){const option=el('option','',versionName(v));option.value=v.id;select.append(option);}select.value=selected||versions[0].id;select.onchange=()=>{if(selected){sequenceDraft[sequenceDraft.indexOf(selected)]=select.value;renderSequenceChoices();}};row.append(check,el('span','',versions[0].shotName),select);
  for(const [label,delta] of [['Up',-1],['Down',1]]){const index=sequenceDraft.indexOf(selected),b=button(label,()=>{const to=index+delta;[sequenceDraft[index],sequenceDraft[to]]=[sequenceDraft[to],sequenceDraft[index]];renderSequenceChoices();},'Move this shot '+label.toLowerCase()+' in the sequence.');b.disabled=!selected||index+delta<0||index+delta>=sequenceDraft.length;row.append(b);}holder.append(row);
 }if(!groups.length)holder.append(el('p','','Upload video shots to build a sequence. Images remain available for individual review.'));
}
async function buildSequence(){
 if(!sequenceDraft.length||sequenceDraft.length>30)throw Error('Select 1 to 30 shots.');$('startSequence').disabled=true;$('cancelSequence').disabled=true;$('sequenceBuildStatus').textContent='Reading clip durations…';
 try{const items=[];for(const id of sequenceDraft){const probe=document.createElement('video');probe.preload='metadata';probe.muted=true;try{const duration=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Clip metadata timed out. Check the upload and try again.')),12000);probe.onloadedmetadata=()=>{clearTimeout(timer);Number.isFinite(probe.duration)&&probe.duration>0?resolve(probe.duration):reject(Error('This clip has no playable duration.'));};probe.onerror=()=>{clearTimeout(timer);reject(Error('A selected clip cannot play in this browser.'));};probe.src='/api/rooms/'+room+'/media/'+id;});const saved=sequenceItems.find(e=>e.id===id);items.push({id,duration,fps:Number(localStorage['frameFps:'+id])||24,...(saved?{in:sequenceBounds(saved).in,out:sequenceBounds(saved).out}:{})});}finally{probe.removeAttribute('src');probe.load();}}
  explore();sequenceItems=items;sequenceActive=true;sequenceDirty=true;sequenceRestored=true;receiveComparison(null);$('loop').checked=false;sequenceDialog.close();sequencePanel.open=true;seekSequence(0,false);saveSequence();
 }finally{$('startSequence').disabled=false;$('cancelSequence').disabled=false;}
}
$('editSequence').onclick=safeAction(openSequenceBuilder);$('startSequence').onclick=safeAction(async()=>{try{await buildSequence();}catch(e){$('sequenceBuildStatus').textContent=e.message;throw e;}});$('cancelSequence').onclick=()=>sequenceDialog.close();
function exitSequence(){sequenceActive=false;sequencePending=null;video.pause();renderSequence();renderPlaybackRange();updateTime();saveSequence();scheduleBroadcast();}
$('exitSequence').onclick=safeAction(async()=>{explore();if(ownsControl())await api('/media/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:asset.id})});exitSequence();});
const sequenceBroadcast=broadcast;broadcast=async()=>{if(!sequenceActive)return sequenceBroadcast();if(!ownsControl()||!joined||sequencePending)return;const result=await controlAction('playback',{sequence:++playSequence,asset:asset.id,time:video.currentTime||0,playing:!video.paused,rate:video.playbackRate||1,playlist:sequenceState(),range:null,comparison:null});sequenceDirty=false;return result;};
const sequenceApply=applyPlayback;applyPlayback=latest=>{
 if(linkedExploration||!$('follow').checked||ownsControl())return sequenceApply(latest);
 if(!latest?.playlist){if(sequenceActive){sequenceActive=false;sequencePending=null;renderSequence();if(latest?.asset){const next=assets.find(a=>a.id===latest.asset);if(next)setAsset(next);}}return sequenceApply(latest);}
 lastPlayback=latest;if(!assets.length){loadAssets().then(()=>applyPlayback(latest)).catch(()=>{});return;}
 sequenceActive=true;sequenceDirty=false;sequenceRestored=true;sequenceItems=latest.playlist.items;receiveComparison(null);$('loop').checked=latest.playlist.loop;
 if(latest.id===lastPresenter&&!sequencePending)return;lastPresenter=latest.id;
 const elapsed=latest.playing?Math.max(0,Date.now()+clockOffset-latest.at)/1000*(latest.rate||1):0;video.playbackRate=latest.rate||1;$('rate').value=video.playbackRate;
 seekSequence(latest.playlist.position+elapsed,latest.playing,true);saveSequence();
};
const sequenceSetAsset=setAsset;setAsset=next=>{if(sequenceActive&&!sequenceLoading&&next?.id!==asset?.id){sequenceActive=false;sequencePending=null;}sequenceSetAsset(next);renderSequence();};
const sequenceControl=applyControl;applyControl=next=>{if(next&&next.version>=lastControlVersion&&!ownsControl()&&next.presenter?.owner===client+':'+connectionId&&next.playback?.playlist&&!sequenceDirty){$('follow').checked=true;lastPresenter='';applyPlayback(next.playback);}sequenceControl(next);};
const sequenceLoaded=video.onloadedmetadata;video.onloadedmetadata=(...args)=>{if(sequenceActive){applySequencePending();updateTime();renderMarkers();}else sequenceLoaded?.(...args);};
const sequenceUpdate=updateTime;updateTime=()=>{sequenceUpdate();renderSequence();};
const sequenceTimeUpdate=video.ontimeupdate;video.ontimeupdate=(...args)=>{sequenceTimeUpdate?.(...args);renderSequence();};
const sequenceRenderRange=renderPlaybackRange;renderPlaybackRange=()=>{if(!sequenceActive)return sequenceRenderRange();video.loop=false;};
const sequenceRanges=enforcePlaybackRange;enforcePlaybackRange=(ended=false)=>{if(!sequenceActive)return sequenceRanges(ended);if(sequencePending||video.paused&&!ended)return;const index=sequenceItems.findIndex(e=>e.id===asset?.id),item=sequenceItems[index];if(!item)return;if(video.currentTime<sequenceBounds(item).start){video.currentTime=sequenceBounds(item).start+.00001;return;}if(ended||video.currentTime>=sequenceBounds(item).end-.000001){const next=index+1;if(next<sequenceItems.length||$('loop').checked){const time=next<sequenceItems.length?sequenceItems.slice(0,next).reduce((n,e)=>n+sequenceBounds(e).span,0):0;seekSequence(time,true);}else{video.pause();video.currentTime=sequenceBounds(item).out/item.fps+.00001;saveSequence();scheduleBroadcast();}}};
const sequencePrepare=prepareRangePlayback;prepareRangePlayback=()=>{if(!sequenceActive)return sequencePrepare();const current=sequenceItems.find(e=>e.id===asset?.id),last=sequenceItems.at(-1);if(!current)return;const b=sequenceBounds(current);if(asset?.id===last?.id&&video.currentTime>=b.out/current.fps)seekSequence(0,false);else if(video.currentTime<b.start||video.currentTime>=b.end)video.currentTime=b.start;};
const sequenceSeek=$('seek').oninput;$('seek').oninput=()=>{if(!sequenceActive)return sequenceSeek();explore();seekSequence(Number($('seek').value),!video.paused);};
const sequenceSeekAt=seekTimelineAt;seekTimelineAt=x=>{if(!sequenceActive)return sequenceSeekAt(x);const rect=$('timelineRail').getBoundingClientRect();explore();seekSequence(Math.max(0,Math.min(1,(x-rect.left)/rect.width))*sequenceItems.reduce((n,e)=>n+sequenceBounds(e).span,0),!video.paused);};
const sequenceLoop=$('loop').onchange;$('loop').onchange=()=>{if(!sequenceActive)return sequenceLoop();explore();saveSequence();scheduleBroadcast();};
const sequenceMarkers=renderMarkers;renderMarkers=()=>{if(!sequenceActive)return sequenceMarkers();$('markers').replaceChildren();let start=0;const total=sequenceItems.reduce((n,e)=>n+sequenceBounds(e).span,0);for(const item of sequenceItems){const offset=start;for(const e of events.filter(e=>e.asset===item.id&&(e.type==='comment'&&!e.parent||e.type==='stroke'&&!hiddenStrokes().get(e.id))&&e.time>=sequenceBounds(item).start-.000001&&e.time<sequenceBounds(item).end-.000001)){const b=button('',()=>{explore();seekSequence(offset+e.time-sequenceBounds(item).start,false);},'Open annotation on its original version and frame.');b.className='marker';b.style.left=Math.min(99.5,(offset+e.time-sequenceBounds(item).start)/total*100)+'%';$('markers').append(b);}start+=sequenceBounds(item).span;}};
const sequenceAccept=acceptGuest;acceptGuest=guest=>{sequenceAccept(guest);if(sequenceRestored)return;sequenceRestored=true;try{const stored=JSON.parse(savedSequenceValue());if(stored){sequenceDraft=stored.draft||[];sequenceDirty=Boolean(stored.dirty);if(stored.active&&stored.playlist&&!reviewTarget){sequenceActive=true;sequenceItems=stored.playlist.items;sequencePending={...sequencePoint(sequenceItems,stored.playlist.position),playing:false};$('follow').checked=stored.following!==false;$('loop').checked=stored.playlist.loop;loadAssets().then(()=>{if(sequenceActive)seekSequence(stored.playlist.position,false,true);}).catch(()=>{});}}}catch{}renderSequence();};
const sequenceExplore=explore;explore=()=>{sequenceExplore();saveSequence();};
const sequenceFollow=followSharedReview;followSharedReview=async()=>{sequenceActive=false;sequenceDirty=false;sequencePending=null;await sequenceFollow();saveSequence();renderSequence();};
window.addEventListener('pagehide',saveSequence);setInterval(()=>{if(sequenceActive&&!sequencePending)saveSequence();},1000);
