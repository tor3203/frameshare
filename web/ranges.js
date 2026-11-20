/* Playback windows use inclusive source-frame boundaries; annotations never move. */
let playbackRange=null,rangeDirty=false,rangeKeyLoaded='';
let rangeBandDrag=null,timelineScrub=null;
function normalizedRange(value,duration,rate=24) {
  rate=[24,25,30,60].includes(Number(value?.fps))?Number(value.fps):rate;
  const last=Number.isFinite(duration)?Math.max(0,Math.ceil(duration*rate-.000001)-1):51840000;
  const start=Math.max(0,Math.min(last,Math.floor(Number(value?.in)||0)));
  const end=Math.max(start,Math.min(last,value?.out!==undefined&&Number.isFinite(Number(value.out))?Math.floor(Number(value.out)):last));
  return {in:start,out:end,fps:rate,loop:Boolean(value?.loop)};
}
function rangeWindow(value,duration,rate=24) {
  const r=normalizedRange(value,duration,rate);
  return {...r,start:r.in/r.fps,end:Math.min(Number.isFinite(duration)?duration:Infinity,(r.out+1)/r.fps),last:r.out/r.fps};
}
function shiftedPlaybackRange(value,delta,duration,rate=24){
  const r=normalizedRange(value,duration,rate),last=Math.max(0,Math.ceil(duration*r.fps-.000001)-1);
  const shift=Math.max(-r.in,Math.min(last-r.out,Math.round(Number(delta)||0)));
  return {...r,in:r.in+shift,out:r.out+shift};
}
function movePlaybackRange(delta,original=playbackRange){
  if(!asset?.type.startsWith('video')||!Number.isFinite(video.duration))return;
  const next=shiftedPlaybackRange(original,delta,video.duration,fps),current=normalizedRange(playbackRange,video.duration,fps);
  if(next.in===current.in&&next.out===current.out)return;
  explore();video.pause();playbackRange=next;rangeDirty=true;persistPlaybackRange();renderPlaybackRange();scheduleBroadcast();
}
function rangePlaybackTime(time,elapsed,value,duration,rate=24) {
  const r=rangeWindow(value,duration,rate),target=Math.max(r.start,time+Math.max(0,elapsed));
  if(target<r.end)return target;
  if(!r.loop||r.end<=r.start)return r.last;
  const span=r.end-r.start,phase=(target-r.start)%span;
  return r.start+(phase>=span-.0000001?0:phase);
}
function rangeKey(){return 'frameRange:'+room+':'+client+':'+asset?.id;}
function restorePlaybackRange(){
  rangeKeyLoaded=rangeKey();rangeDirty=false;
  try{playbackRange=JSON.parse(localStorage[rangeKeyLoaded]||'null');}catch{playbackRange=null;}
  renderPlaybackRange();
}
function persistPlaybackRange(){if(asset)localStorage[rangeKey()]=JSON.stringify(playbackRange);}
function playbackRangeState(){return asset?.type.startsWith('video')&&playbackRange?normalizedRange(playbackRange,video.duration,fps):null;}
function receivePlaybackRange(value){
  rangeDirty=false;playbackRange=value?normalizedRange(value,NaN,fps):null;persistPlaybackRange();renderPlaybackRange();
}
function renderPlaybackRange(){
  const usable=Boolean(asset?.type.startsWith('video')&&Number.isFinite(video.duration)&&video.duration>0);
  const r=rangeWindow(playbackRange,usable?video.duration:0,fps),last=usable?Math.max(0,Math.ceil(video.duration*r.fps-.000001)-1):0;
  for(const id of ['rangeIn','rangeOut','setIn','setOut','resetRange'])$(id).disabled=!usable;
  for(const [id,value] of [['rangeIn',r.in],['rangeOut',r.out]]){const input=$(id);input.max=usable?video.duration*r.fps:1;input.value=value;input.setAttribute('aria-valuetext','Frame '+value+' · '+fmt(value/r.fps));}
  $('rangeInLabel').textContent='In '+r.in+' · '+fmt(r.start);
  $('rangeOutLabel').textContent='Out '+r.out+' · '+fmt(r.last);
  $('rangeFill').style.left=(usable?r.start/video.duration*100:0)+'%';
  $('rangeFill').style.width=(usable?Math.min(100,(r.end-r.start)/video.duration*100):100)+'%';
  $('rangeFill').disabled=!usable;
  $('rangeFill').setAttribute('aria-valuemin','0');$('rangeFill').setAttribute('aria-valuemax',String(Math.max(0,last-(r.out-r.in))));
  $('rangeFill').setAttribute('aria-valuenow',String(r.in));$('rangeFill').setAttribute('aria-valuetext','In '+r.in+', Out '+r.out+' · '+(r.out-r.in+1)+' frames');
  $('rangeFill').title=r.in===0&&r.out===last?'This range fills the clip. Shorten it with In or Out before moving it. Click to seek.':'Drag the green segment to move In and Out together. Click to seek. Arrow keys move one frame; Shift moves ten.';
  $('rangeSummary').textContent=!usable?'Playback range · video only':r.in===0&&r.out===last?'Full clip':(r.out-r.in+1)+' frames · '+fmt(r.end-r.start)+' · '+r.fps+' fps';
  $('loop').checked=r.loop;video.loop=false;
}
function editPlaybackRange(edge,value){
  if(!asset?.type.startsWith('video')||!Number.isFinite(video.duration))return;
  explore();if(edge!=='loop')video.pause();const r=normalizedRange(playbackRange,video.duration,fps);
  if(edge==='in'){r.in=Math.max(0,Math.min(r.out,Math.floor(value)));}
  else if(edge==='out'){r.out=Math.max(r.in,Math.min(Math.ceil(video.duration*r.fps-.000001)-1,Math.floor(value)));}
  else if(edge==='loop')r.loop=Boolean(value);
  else if(edge==='reset'){r.in=0;r.out=Math.max(0,Math.ceil(video.duration*r.fps-.000001)-1);}
  playbackRange=r;rangeDirty=true;persistPlaybackRange();renderPlaybackRange();scheduleBroadcast();
}
function prepareRangePlayback(){
  const r=rangeWindow(playbackRange,video.duration,fps);
  if(video.currentTime<r.start||video.currentTime>=r.end)video.currentTime=r.start;
}
function retimePlaybackRange(){
  if(!playbackRange)return;
  const old=rangeWindow(playbackRange,video.duration,fps);
  playbackRange=normalizedRange({in:Math.floor(old.start*fps+.000001),out:Math.ceil(old.end*fps-.000001)-1,fps,loop:old.loop},video.duration,fps);
  explore();rangeDirty=true;persistPlaybackRange();scheduleBroadcast();
}
function enforcePlaybackRange(ended=false){
  if(!asset?.type.startsWith('video')||!Number.isFinite(video.duration)||video.paused&&!ended)return;
  const r=rangeWindow(playbackRange,video.duration,fps),time=video.currentTime;
  if(time<r.start){video.currentTime=r.start;syncComparison(true);return;}
  if(time+0.000001<r.end&&!ended)return;
  if(r.loop){video.currentTime=rangePlaybackTime(ended?r.end:time,0,playbackRange,video.duration,fps);syncComparison(true);if(video.paused)video.play().catch(()=>{});}
  else {video.pause();video.currentTime=r.last;syncComparison(true);scheduleBroadcast();}
}
$('setIn').onclick=()=>{const r=rangeWindow(playbackRange,video.duration,fps);editPlaybackRange('in',Math.floor((video.currentTime+.000001)*r.fps));};
$('setOut').onclick=()=>{const r=rangeWindow(playbackRange,video.duration,fps);editPlaybackRange('out',Math.floor((video.currentTime+.000001)*r.fps));};
$('resetRange').onclick=()=>editPlaybackRange('reset');
$('rangeIn').oninput=()=>editPlaybackRange('in',Number($('rangeIn').value));
$('rangeOut').oninput=()=>editPlaybackRange('out',Number($('rangeOut').value));
$('loop').onchange=()=>editPlaybackRange('loop',$('loop').checked);
function seekTimelineAt(x){
  if($('seek').disabled||!Number.isFinite(video.duration))return;
  const rect=$('timelineRail').getBoundingClientRect();if(!rect.width)return;
  $('seek').value=Math.max(0,Math.min(1,(x-rect.left)/rect.width))*video.duration;$('seek').oninput();
}
$('rangeFill').onpointerdown=event=>{
  if(event.button!==0||$('rangeFill').disabled)return;event.preventDefault();event.stopPropagation();
  rangeBandDrag={pointer:event.pointerId,x:event.clientX,asset:asset.id,range:normalizedRange(playbackRange,video.duration,fps),moved:false};
  $('rangeFill').focus({preventScroll:true});$('rangeFill').setPointerCapture(event.pointerId);
};
$('rangeFill').onpointermove=event=>{
  const drag=rangeBandDrag;if(!drag||drag.pointer!==event.pointerId)return;
  if(asset?.id!==drag.asset){rangeBandDrag=null;return;}
  if(!drag.moved&&Math.abs(event.clientX-drag.x)<3)return;
  drag.moved=true;$('rangeFill').classList.add('dragging');const width=$('timelineRail').getBoundingClientRect().width;
  if(width)movePlaybackRange((event.clientX-drag.x)/width*video.duration*drag.range.fps,drag.range);
};
$('rangeFill').onpointerup=event=>{
  const drag=rangeBandDrag;if(!drag||drag.pointer!==event.pointerId)return;
  rangeBandDrag=null;$('rangeFill').classList.remove('dragging');if($('rangeFill').hasPointerCapture(event.pointerId))$('rangeFill').releasePointerCapture(event.pointerId);
  if(!drag.moved&&asset?.id===drag.asset)seekTimelineAt(event.clientX);
};
$('rangeFill').onpointercancel=$('rangeFill').onlostpointercapture=()=>{rangeBandDrag=null;$('rangeFill').classList.remove('dragging');};
$('rangeFill').onkeydown=event=>{
  event.stopPropagation();if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
  const r=normalizedRange(playbackRange,video.duration,fps),last=Math.max(0,Math.ceil(video.duration*r.fps-.000001)-1);
  movePlaybackRange(event.key==='Home'?-r.in:event.key==='End'?last-r.out:(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10:1));
};
$('timelineRail').onpointerdown=event=>{
  if(event.button!==0||$('seek').disabled)return;event.preventDefault();timelineScrub=event.pointerId;$('timelineRail').setPointerCapture(event.pointerId);seekTimelineAt(event.clientX);
};
$('timelineRail').onpointermove=event=>{if(timelineScrub===event.pointerId)seekTimelineAt(event.clientX);};
$('timelineRail').onpointerup=$('timelineRail').onpointercancel=event=>{if(timelineScrub!==event.pointerId)return;timelineScrub=null;if($('timelineRail').hasPointerCapture(event.pointerId))$('timelineRail').releasePointerCapture(event.pointerId);};
// Both requestAnimationFrame and media events cover short ranges and clip endings.
const rangeTimeUpdate=video.ontimeupdate;video.ontimeupdate=(...args)=>{enforcePlaybackRange();rangeTimeUpdate?.(...args);};
const rangeEnded=video.onended;video.onended=(...args)=>{enforcePlaybackRange(true);rangeEnded?.(...args);};
if(typeof requestAnimationFrame==='function'){
  const tick=()=>{if(!video.paused)enforcePlaybackRange();requestAnimationFrame(tick);};requestAnimationFrame(tick);
}
