/* FrameShare review client. Live playback is intentionally independent of note loading. */
const $ = id => document.getElementById(id);
const video = $('video'), image = $('image'), canvas = $('canvas'), ctx = canvas.getContext('2d');
let roomTitleUpdated=0,lastRoomTitle='';
let room = new URLSearchParams(location.search).get('room');
// A linked review is a local route, never a shared media-selection command.
function parseReviewTarget(search) {
  const p = new URLSearchParams(search), id = p.get('asset'), raw = p.get('frame'), rate = Number(p.get('fps') || 24);
  if (!id || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id) || raw === null || !/^\d{1,10}$/.test(raw) || ![24,25,30,60].includes(rate)) return null;
  const comment = p.get('comment');
  return {asset:id, frame:Number(raw), fps:rate, comment:comment && comment.length <= 1000 ? comment : null};
}
let reviewTarget = parseReviewTarget(location.search), linkedExploration = Boolean(reviewTarget), targetApplied = false, targetCommentFound = false, highlightedComment = '', highlightScrolled = false;
let client = sessionStorage.frameClient || (sessionStorage.frameClient = crypto.randomUUID());
let joined = false, asset = null, assets = [], events = [], drawing = false, points = [], pen = false;
let tool = 'select', drawingTime = 0, busy = false, liveBusy = false, lastPresenter = '', clockOffset = 0;
let eventWatermark = 0, liveTimer, noteTimer, heartbeatTimer, syncTimer, syncQueue = Promise.resolve();
let fps = 24, lastHeartbeat = 0, commentSignature = '', replyTo = null, editing = null, draftAnchor = null;
let lastPlayback = null, pendingLead = false, leadSince = 0, uploadBusy = false, lastAssetSignature = '';
let leadRequestAt=0,leadRequestNotice='',leadRequestCancelled=false,lastHandoffSignature='';
let toastTimer, draftBeforeEditing = null,identityColor='#63d5ff';
let reviewControlBusy=false;
function reviewControlView({own,following,presenter,pending,sameGuest,busy,available}){
  if(own)return {mode:'presenting',status:'You’re presenting',detail:'Your playback, range and comparison are shared with followers.',lead:'Stop presenting',follow:null,disabled:busy||!available};
  const follow=following?'Explore locally':presenter?'Resume following':'Return to shared review';
  if(pending&&presenter)return {mode:'requested',status:'Control requested',detail:following?'Waiting for the presenter while you keep following.':'Waiting for the presenter. You are exploring locally.',lead:'Request pending',follow,disabled:true};
  if(!following)return {mode:'local',status:'Exploring locally',detail:presenter?'Your playback is independent. Resume following to rejoin the presenter.':'Your playback is independent. Lead review when you want to present.',lead:presenter?'Request control':'Lead review',follow,disabled:busy||!available};
  if(presenter)return {mode:'following',status:sameGuest?'Following your other session':'Following '+presenter.name,detail:sameGuest?'Another window or your previous page holds control. A disconnected page releases it within 15 seconds.':'The presenter controls shared playback, range and comparison.',lead:'Request control',follow,disabled:busy||!available};
  return {mode:'ready',status:'No presenter',detail:'Choose Lead review to control playback for the room.',lead:'Lead review',follow:null,disabled:busy||!available};
}
function renderReviewControls(){
  const own=ownsControl(),presenter=control.presenter,pending=Boolean(presenter&&control.requests?.some(r=>r.owner===client+':'+connectionId));
  const view=reviewControlView({own,following:$('follow').checked&&!linkedExploration,presenter,pending,sameGuest:presenter?.owner?.startsWith(client+':'),busy:reviewControlBusy,available:joined&&Boolean(asset)});
  if($('reviewControlStatus').textContent!==view.status)$('reviewControlStatus').textContent=view.status;if($('reviewControlDetail').textContent!==view.detail)$('reviewControlDetail').textContent=view.detail;$('reviewControlPanel').setAttribute('data-mode',view.mode);
  $('leadAction').textContent=reviewControlBusy?'Updating control…':view.lead;$('leadAction').disabled=view.disabled||reviewControlBusy;
  $('leadAction').title=own?'Stop presenting and return control to the room. The current frame and range are saved.':presenter?'Ask the current presenter to pass control to this window.':'Present this review to everyone following. Only one window can lead at a time.';
  $('followAction').hidden=!view.follow;$('followAction').textContent=view.follow||'';$('followAction').disabled=reviewControlBusy||!joined||!asset;
  $('followAction').title=$('follow').checked?'Explore playback locally. Other participants keep their current view.':'Resume the shared version, playback, range and comparison. Your local annotations stay saved.';
}
$('leadAction').onclick=safeAction(async()=>{
  if(reviewControlBusy)return;reviewControlBusy=true;renderReviewControls();
  try{await $('present').onchange();}finally{reviewControlBusy=false;updateSyncHint();}
});
$('followAction').onclick=safeAction(async()=>{
  if(reviewControlBusy||ownsControl())return;reviewControlBusy=true;renderReviewControls();
  try{if($('follow').checked&&!linkedExploration)explore();else await followSharedReview();}finally{reviewControlBusy=false;updateSyncHint();}
});
// Per-page identity prevents two tabs sharing a guest cookie from sharing control.
const connectionId=crypto.randomUUID();
let control={version:0,term:0,presenter:null,requests:[]},playSequence=0,remoteGestures=[],gestureSequence=0,gesturePending=null,gestureBusy=false,gestureTimer,strokeId='',reconnecting=false,lastControlVersion=-1,localLaser=null;
let outboxBusy=false,liveStream=null,streamOnline=false,lastRevision,mediaEpoch=0,versionChangeBusy=false;
function startStream(){if(liveStream)liveStream.close();if(typeof EventSource==='undefined')return;liveStream=new EventSource('/api/rooms/'+room+'/stream');liveStream.onopen=()=>{streamOnline=true;};liveStream.onerror=()=>{streamOnline=false;};liveStream.onmessage=event=>{try{const data=JSON.parse(event.data);if(versionChangeBusy)return;if(!joined){liveStream.close();return;}const current=data.control?.version>=lastControlVersion;applyControl(data.control);remoteGestures=data.gestures||[];if(current&&(data.control?.playback?.playlist||data.control?.playback?.asset===asset?.id)){lastPlayback=data.control.playback;applyPlayback(lastPlayback);}renderDrawing();if(data.revision!==lastRevision){lastRevision=data.revision;refresh().catch(()=>{});} }catch{streamOnline=false;}};}

const outboxKey=()=> 'frameOutbox:'+room+':'+client;
function queuedEvents(){try{return JSON.parse(localStorage[outboxKey()]||'[]')}catch{return []}}
function saveQueue(items){localStorage[outboxKey()]=JSON.stringify(items)}
async function flushOutbox(){if(outboxBusy||!joined)return;outboxBusy=true;try{for(const item of queuedEvents()) {const response=await api('/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)});events=events.filter(e=>e.requestId!==item.requestId);mergeEvents([response.event]);saveQueue(queuedEvents().filter(e=>e.requestId!==item.requestId));}renderComments();renderDrawing();renderMarkers();}finally{outboxBusy=false}}
const ownsControl=()=>control.presenter?.owner===client+':'+connectionId;
async function controlAction(action,extra={}){if((action==='release'||action==='handoff')&&ownsControl()){clearTimeout(syncTimer);$('present').checked=true;await broadcast();}if(action==='claim'){leadRequestNotice='';leadRequestCancelled=false;}if(action==='cancel'){leadRequestCancelled=true;leadRequestNotice='';}const result=await api('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,connection:connectionId,term:control.term,...extra})});applyControl(result.control);if(action==='playback'&&JSON.stringify(extra.range)===JSON.stringify(playbackRangeState()))rangeDirty=false;if(action==='playback'&&JSON.stringify(extra.comparison)===JSON.stringify(comparisonState()))comparisonDirty=false;return result;}
function applyControl(next){if(!next||next.version<lastControlVersion)return;const was=ownsControl(),wasPending=control.requests?.some(r=>r.owner===client+':'+connectionId);control=next;lastControlVersion=next.version;$('present').checked=ownsControl();if(was&&!ownsControl()){$('follow').checked=true;lastPresenter='';video.pause();}if(!was&&ownsControl()){if(!rangeDirty&&control.playback?.asset===asset?.id&&control.playback.range!==undefined)receivePlaybackRange(control.playback.range);if(!comparisonDirty&&control.playback?.asset===asset?.id&&control.playback.comparison!==undefined)receiveComparison(control.playback.comparison);playSequence=0;$('follow').checked=true;toast('You are now presenting.');if(control.playback?.asset===asset?.id&&Number.isFinite(video.duration)){video.pause();video.currentTime=control.playback.time;}broadcast().catch(()=>{});}const request=control.presenter?control.requests?.find(r=>r.owner===client+':'+connectionId):null;if(request){leadRequestAt=request.at;leadRequestNotice='';}else if(wasPending&&!ownsControl()&&!leadRequestCancelled){leadRequestNotice=Date.now()+clockOffset-leadRequestAt>=30000?'Your presenter request expired. Send a new request when the presenter is ready.':'Your presenter request was declined.';toast(leadRequestNotice);}if(ownsControl())leadRequestNotice='';leadRequestCancelled=false;const holder=$('handoff'),signature=JSON.stringify([ownsControl(),ownsControl()?control.requests:[],Boolean(request),leadRequestNotice]);if(signature!==lastHandoffSignature){lastHandoffSignature=signature;holder.replaceChildren();if(ownsControl()){for(const request of control.requests||[]){holder.append(el('span','',request.name+' wants to present'),button('Pass control',()=>controlAction('handoff',{target:request.owner})),button('Decline',()=>controlAction('deny',{target:request.owner})));}}else if(control.presenter&&control.requests?.some(r=>r.owner===client+':'+connectionId)){holder.append(el('span','','Presenter request pending · expires in '+Math.max(0,Math.ceil((leadRequestAt+30000-Date.now()-clockOffset)/1000))+'s'),button('Cancel request',()=>controlAction('cancel')));}else if(leadRequestNotice){holder.append(el('span','',leadRequestNotice),button('Request again',()=>controlAction('claim')));}}if(request&&!ownsControl()){const label=holder.querySelector('span');if(label)label.textContent='Presenter request pending · expires in '+Math.max(0,Math.ceil((request.at+30000-Date.now()-clockOffset)/1000))+'s';}updateSyncHint();}
function queueGesture(kind){if(!joined||!asset)return;gesturePending={kind,asset:asset.id,connection:connectionId,strokeId,time:drawingTime,points:points.length?[...points]:[[0,0]],tool,color:kind==='laser'?identityColor:$('color').value,width:Number($('lineWidth').value),sequence:++gestureSequence};if(kind==='laser')localLaser={...gesturePending,expires:Date.now()+clockOffset+1500};if(!gestureTimer)gestureTimer=setTimeout(sendGesture,100);}
async function sendGesture(){gestureTimer=null;if(gestureBusy||!gesturePending)return;gestureBusy=true;const payload=gesturePending;gesturePending=null;try{await api('/gesture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch{}finally{gestureBusy=false;if(gesturePending&&!gestureTimer)gestureTimer=setTimeout(sendGesture,100);}}

const fmt = value => { const time = Math.max(0, Number(value) || 0); return String(Math.floor(time / 60)).padStart(2, '0') + ':' + (time % 60).toFixed(3).padStart(6, '0'); };
const frame = time => Math.floor(((Number(time) || 0) + .000001) * fps);
const sameFrame = (a, b) => asset?.type.startsWith('image') || frame(a) === frame(b);
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function safeAction(fn) { return (...args) => { try { return Promise.resolve(fn(...args)).catch(error => toast(error.message)); } catch (error) { toast(error.message); } }; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, action, label) { const node = el('button', '', text); node.type = 'button'; const tips={'Request again':'Send a new request to take over shared playback from the current presenter.','Pass control':'Give presenter control to this coworker. You will return to following the shared review.','Decline':'Decline this presenter request and keep leading the review.','Cancel request':'Withdraw your request to become the presenter.','Reply':'Reply in this version’s comment thread at its original frame.','Edit':'Edit your own comment. Its original version and frame are retained.','✓ Resolve':'Mark this comment thread as resolved. Its notes remain available in All notes and Resolved.','Reopen':'Mark this resolved comment thread as open for further review.'};node.title=(tips[text]||label||(/^\d+:/.test(text)?'Jump to this comment’s frame in version A.':text)).slice(0,199); if (label) node.setAttribute('aria-label', label); node.onclick = safeAction(action); return node; }
async function api(path = '', options = {}) {
  const response = await fetch('/api/rooms' + (room ? '/' + room : '') + path, { ...options, ...(typeof AbortSignal !== 'undefined' ? { signal: AbortSignal.timeout(20000) } : {}) });
  let data; try { data = await response.json(); } catch { throw Error('Could not reach the review server. Retrying shortly.'); }
  if (response.status === 401) showJoin();
  if (!response.ok) {const error=Error(data.error || 'Request failed.');error.status=response.status;throw error;}
  return data;
}
function mergeEvents(incoming) { events = [...new Map([...events, ...incoming].map(event => [event.id, event])).values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)); }
async function post(event) {
  if (!joined || !room) throw Error('Join a review room first.');
  const durable=!['presence','playhead'].includes(event.type);const payload={asset:asset?.id,...event,...(durable?{requestId:event.requestId||crypto.randomUUID()}:{}),client,name:$('name').value};if(durable){saveQueue([...queuedEvents(),payload]);mergeEvents([{...payload,id:'pending:'+payload.requestId,at:Date.now()}]);renderComments();renderDrawing();try{await flushOutbox();return {ok:true};}catch(error){if(error.status&&error.status<500&&error.status!==401){saveQueue(queuedEvents().filter(e=>e.requestId!==payload.requestId));events=events.filter(e=>e.requestId!==payload.requestId);throw error;}toast('Saved on this device. Will send when reconnected.');return {queued:true};}}
  const response = await api('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: asset?.id, ...event, client, name: $('name').value }) });
  if (response.event && !['presence', 'playhead'].includes(event.type)) { mergeEvents([response.event]); renderComments(); renderDrawing(); renderMarkers(); updateUndo(); }
  return response;
}
function privateLink() { return location.origin + location.pathname + '?room=' + encodeURIComponent(room); }
function reviewLink(comment = null) {
  const rate = fps, time = comment ? comment.time : asset?.type.startsWith('image') ? 0 : video.currentTime || 0;
  const p = new URLSearchParams({room,asset:comment?.asset || asset.id,frame:String(Math.floor((time + .000001) * rate)),fps:String(rate)});
  if (comment) p.set('comment', comment.id);
  return location.origin + location.pathname + '?' + p;
}
async function copyReviewLink(comment = null) {
  if (!asset) return;
  if (comment?.id.startsWith('pending:')) throw Error('Wait for this comment to finish saving before copying its link.');
  const link = reviewLink(comment);
  try { await navigator.clipboard.writeText(link); toast((comment ? 'Comment' : 'Frame') + ' link copied. Recipients open it locally and join with just a name.'); }
  catch { $('copyLinkTitle').textContent = comment ? 'Copy comment link' : 'Copy frame link'; $('copyLinkURL').value = link; $('copyLinkDialog').showModal(); $('copyLinkURL').select(); }
}
$('copyFrameLink').onclick = safeAction(() => copyReviewLink());
$('closeCopyLink').onclick = () => $('copyLinkDialog').close();
function clearReviewTarget() {
  linkedExploration = false; reviewTarget = null; pendingVersionTime = null; highlightedComment = ''; commentSignature = ''; mediaEpoch++; $('linkStatus').hidden = true;
  const p = new URLSearchParams(location.search); for (const key of ['asset','frame','fps','comment']) p.delete(key);
  history.replaceState(null, '', location.pathname + '?' + p + location.hash); renderComments();
}
async function followSharedReview() {
  clearReviewTarget(); $('follow').checked = true; lastPresenter = '';
  const epoch = mediaEpoch, data = await api('/live'); if (epoch !== mediaEpoch || linkedExploration) return;
  if(!data.playback?.playlist)setAsset(data.media); applyControl(data.control); lastPlayback = data.playback; applyPlayback(lastPlayback); updateSyncHint();
}
async function openReviewTarget() {
  if (!reviewTarget || targetApplied) return;
  await loadAssets();
  const selected = assets.find(item => item.id === reviewTarget.asset);
  if (!selected) { $('linkStatus').hidden = false; $('linkStatus').textContent = 'This linked version is unavailable. Choose another version or Resume following.'; $('follow').checked = false; return; }
  pendingVersionTime = reviewTarget.frame / reviewTarget.fps;
  setAsset(selected); fps = reviewTarget.fps; $('fps').value = fps; $('follow').checked = false; targetApplied = true;
  $('linkStatus').hidden = false; $('linkStatus').textContent = 'Opened a linked frame · exploring locally. Use Resume following to rejoin the room.';
  if (selected.type.startsWith('image')) { pendingVersionTime = null; video.currentTime = 0; }
  else if (video.readyState >= 1) applyPendingSourceTime();
  await refresh(); updateTime(); updateSyncHint();
}
function applyLinkedComment() {
  if (!reviewTarget?.comment || !targetApplied || targetCommentFound || asset?.id !== reviewTarget.asset) return;
  const comment = events.find(event => event.id === reviewTarget.comment && event.type === 'comment' && event.asset === reviewTarget.asset);
  if (!comment) { $('linkStatus').textContent = 'Linked frame opened. The comment is unavailable or still loading. You are exploring locally.'; return; }
  targetCommentFound = true; highlightedComment = comment.id; highlightScrolled = false; commentSignature = '';
  $('noteFilter').value = 'all'; $('noteSearch').value = '';
  pendingVersionTime = comment.time; if (video.readyState >= 1 || asset.type.startsWith('image')) applyPendingSourceTime();
  $('linkStatus').textContent = 'Linked comment highlighted · exploring locally. Use Resume following to rejoin the room.';
}
function applyPendingSourceTime() {
  if (pendingVersionTime === null) return false;
  const requested = pendingVersionTime, limit = Number.isFinite(video.duration) ? Math.max(0, video.duration - .000001) : requested;
  video.pause(); video.currentTime = Math.max(0, Math.min(requested, limit)); pendingVersionTime = null;
  if (linkedExploration) $('follow').checked = false;
  if (requested > limit && linkedExploration) $('linkStatus').textContent = 'Linked frame is past the end of this version. Showing its final frame locally.';
  return true;
}
function rememberRoom(title) {
  let recent; try { recent = JSON.parse(localStorage.frameReviews || '[]'); } catch { recent = []; }
  recent = [{ id: room, title }, ...recent.filter(item => item.id !== room)].slice(0, 12);
  localStorage.frameReviews = JSON.stringify(recent); renderRecents();
}
function renderRecents() {
  let recent; try { recent = JSON.parse(localStorage.frameReviews || '[]'); } catch { recent = []; }
  $('recents').replaceChildren();
  for (const item of recent) { const link = el('a', item.id === room ? 'recent active' : 'recent', item.title); link.title='Open this review room. You may need to enter a display name.';link.href = '?room=' + encodeURIComponent(item.id); $('recents').append(link); }
}
function applyRoomTitle(meta){if(!meta||typeof meta.title!=='string'||(meta.updated||0)<roomTitleUpdated)return;roomTitleUpdated=meta.updated||0;if(lastRoomTitle===meta.title)return;lastRoomTitle=meta.title;$('title').textContent=$('roomLabel').textContent=meta.title;document.title=meta.title+' — FrameShare';rememberRoom(meta.title);}
$('renameReview').onclick=()=>{if(!joined)return;$('reviewTitleInput').value=$('title').textContent;$('renameReviewError').textContent='';$('renameReviewDialog').showModal();$('reviewTitleInput').focus();$('reviewTitleInput').select();};
$('cancelReviewRename').onclick=()=>$('renameReviewDialog').close();
$('renameReviewForm').onsubmit=async event=>{event.preventDefault();$('renameReviewError').textContent='';const title=$('reviewTitleInput').value.trim();if(!title){$('renameReviewError').textContent='Give this review a name.';$('reviewTitleInput').focus();return;}$('saveReviewTitle').disabled=true;try{const meta=await api('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});applyRoomTitle(meta);$('renameReviewDialog').close();toast('Review name updated for everyone.');}catch(error){$('renameReviewError').textContent=error.message;}finally{$('saveReviewTitle').disabled=false;}};
window.addEventListener('storage',event=>{if(event.key==='frameReviews')renderRecents();});
function askRoom() { $('hostName').value = localStorage.frameName || ''; $('createDialog').showModal(); $('hostName').focus(); }
$('newRoom').onclick = $('newRoomHeader').onclick = askRoom;
$('cancel').onclick = () => $('createDialog').close();
$('createForm').onsubmit = safeAction(async event => {
  event.preventDefault(); const title = $('roomName').value.trim(), name = $('hostName').value.trim(); if (!title || !name) return;
  $('createButton').disabled = true;
  try { const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, name }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not create the review.'); localStorage.frameName = name; location.href = '?room=' + data.id; }
  finally { $('createButton').disabled = false; }
});
$('invite').onclick = safeAction(async () => { if (!room) return askRoom(); const link = privateLink(); try { await navigator.clipboard.writeText(link); toast('Private invite copied. Your coworker only needs a name to join.'); } catch { $('inviteLink').value = link; $('inviteDialog').showModal(); $('inviteLink').select(); } });
$('closeInvite').onclick = () => $('inviteDialog').close();
$('joinDialog').oncancel = event => event.preventDefault();
function showJoin() { if (!joined && $('joinDialog').open) return; joined = false;$('renameReview').disabled=true;renderReviewControls();if(liveStream)liveStream.close(); $('present').checked = false; video.pause(); $('reviewApp').inert = true; $('invite').disabled = true; $('connection').textContent = 'Enter your name to join'; $('joinName').value = localStorage.frameName || ''; if (!$('joinDialog').open) $('joinDialog').showModal(); $('joinName').focus(); }
function acceptGuest(guest) {const first=!joined;identityColor=guest.color||identityColor;if(first)$('color').value=identityColor; joined = true; client = guest.clientId; $('name').value = guest.name; $('name').readOnly = true; localStorage.frameName = guest.name; $('reviewApp').inert = false; $('invite').disabled = false; $('changeName').disabled=false;$('renameReview').disabled=false; if ($('joinDialog').open) $('joinDialog').close(); }
$('joinForm').onsubmit = async event => { event.preventDefault(); $('joinError').textContent = ''; $('joinButton').disabled = true; try { const guest = await api('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('joinName').value.trim() }) }); acceptGuest(guest); await startRoom(); } catch (error) { $('joinError').textContent = error.message; } finally { $('joinButton').disabled = false; } };
$('changeName').onclick = safeAction(async () => { $('profileName').value = $('name').value; $('profileDialog').showModal(); $('profileName').focus(); });
$('closeProfile').onclick = () => $('profileDialog').close();
$('profileForm').onsubmit = safeAction(async event => { event.preventDefault(); const guest = await api('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('profileName').value.trim() }) }); acceptGuest(guest); $('profileDialog').close(); await post({ type: 'presence' }); toast('Display name updated.'); });

// Media versions stay in the room, with separate annotations for each item.
$('upload').onclick = $('replace').onclick = () => {revisionOf=null;return room && joined ? $('file').click() : askRoom();};
$('file').onchange = safeAction(async () => { try{for (const file of $('file').files) await upload(file);}finally{$('file').value = '';revisionOf=null;} });
$('dropzone').ondragover = event => { event.preventDefault(); $('dropzone').classList.add('dragging'); };
$('dropzone').ondragleave = () => $('dropzone').classList.remove('dragging');
$('dropzone').ondrop = safeAction(async event => { revisionOf=null;event.preventDefault(); $('dropzone').classList.remove('dragging'); for (const file of event.dataTransfer.files) await upload(file); });
async function upload(file) {
  if (!file) return; if (!joined) return askRoom(); if (file.size > 80 * 1024 * 1024) throw Error('Choose a file smaller than 80 MB.'); if (uploadBusy) throw Error('Wait for the current upload to finish.');
  uploadBusy = true; $('uploadProgress').hidden = false; $('uploadProgress').value = 0; $('uploadStatus').textContent = 'Uploading ' + file.name + '…';
  try {
    await new Promise((resolve, reject) => { const request = new XMLHttpRequest(); request.open('POST', '/api/rooms/' + room + '/media'); request.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); if(revisionOf)request.setRequestHeader('X-Version-Of',revisionOf);request.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); request.upload.onprogress = event => { if (event.lengthComputable) { $('uploadProgress').value = event.loaded / event.total; $('uploadStatus').textContent = 'Uploading ' + file.name + ' · ' + Math.round(event.loaded / event.total * 100) + '%'; } }; request.onerror = () => reject(Error('Upload interrupted. Please try again.')); request.onload = () => { let data; try { data = JSON.parse(request.responseText); } catch { reject(Error('Upload failed. Please try again.')); return; } if (request.status === 401) showJoin(); if (request.status < 200 || request.status >= 300) reject(Error(data.error || 'Upload failed.')); else resolve(data); }; request.send(file); });
    await liveSync(); await loadAssets(); toast(file.name + ' is ready for review.');
  } finally { uploadBusy = false; $('uploadProgress').hidden = true; $('uploadStatus').textContent = ''; }
}
async function loadAssets() { if (!joined) return;const epoch=mediaEpoch;const data=await api('/assets');if(epoch!==mediaEpoch)return;assets=data.assets;renderVersionOptions(); }
$('assetSelect').onchange = safeAction(async () => { if (!$('assetSelect').value || $('assetSelect').value === asset?.id) return; saveDraft(); await api('/media/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('assetSelect').value }) }); await liveSync(); });
function setAsset(next) {
  if (!next || next.id === asset?.id) return;
  hideAttachmentPreview();saveView();selectedDrawing=null;editDrag=null;saveDraft(); const previous = asset; asset = next; lastPresenter = ''; commentSignature = ''; replyTo = editing = null; draftAnchor = null; clearTimeout(syncTimer); $('present').checked = false; video.pause(); $('follow').checked = true;
  $('empty').hidden = true; $('wrap').hidden = false; const isVideo = asset.type.startsWith('video'); video.hidden = !isVideo; image.hidden = isVideo; const src = '/api/rooms/' + room + '/media/' + asset.id;
  if (isVideo) { image.removeAttribute('src'); video.src = typeof cachedMediaSource==='function'&&cachedMediaSource(asset.id)||src; } else { video.removeAttribute('src'); video.load(); image.src = src; }
  $('filename').textContent = asset.name;compareAsset=null;renderVersionOptions(); $('mediaError').hidden = true; $('assetSelect').value = asset.id;
  fps = Number(localStorage['frameFps:' + asset.id]) || 24; $('fps').value = fps;alignmentPreview=false;restoreView();restorePlaybackRange();
  for (const id of ['play', 'back', 'forward', 'seek', 'frameJump', 'rate', 'loop', 'mute']) $(id).disabled = !isVideo;
  $('copyFrameLink').disabled = false; $('exportFrame').disabled = false; $('exportNotes').disabled=false; $('note').disabled = false; $('postNote').disabled = false;
  loadDraft(); updateTime(); renderComments(); renderDrawing(); renderMarkers(); loadAssets().catch(() => {});
  if (previous) toast('Reviewing ' + asset.name);
}
function mediaError(message) { $('mediaError').textContent = message; $('mediaError').hidden = false; }
video.onerror = () => mediaError('This browser could not play the clip. Try MP4 with H.264 video, or WebM. Your upload is retained.');
image.onerror = () => mediaError('This image could not be displayed. Try a PNG, JPG, or WebP image.');

// Frame-specific drawing tools and reversible undo/redo.
function setTool(next) { tool = next; pen = next !== 'select'; canvas.style.pointerEvents = 'auto';canvas.style.cursor=next==='pan'?'grab':next==='select'?'default':'crosshair';if(next!=='select')selectedDrawing=null; for (const id of ['select', 'pan', 'pen', 'arrow', 'rectangle', 'laser']) $(id).classList.toggle('active', id === next); if (pen && next!=='laser') video.pause(); }
function setPen(value) { setTool(value ? 'pen' : 'select'); }
for (const id of ['select', 'pan', 'pen', 'arrow', 'rectangle', 'laser']) $(id).onclick = () => setTool(id);
function hiddenStrokes() { const hidden = new Map(); for (const event of events) if (event.type === 'stroke-hide') hidden.set(event.target, event.hidden); return hidden; }
function visibleStrokes(time = video.currentTime || 0) { const hidden = hiddenStrokes(); return events.filter(event => event.type === 'stroke' && event.asset === asset?.id && sameFrame(event.time, time) && !hidden.get(event.id)).map(editedStroke); }
function drawStrokes(context, width, height, strokes) {
  context.lineJoin = context.lineCap = 'round';
  for (const stroke of strokes) { const path = editedStroke(stroke).points; if (!path?.length) continue; context.strokeStyle = context.fillStyle = stroke.color; context.lineWidth = (stroke.width || 3) * width / 640; const start = [path[0][0] * width, path[0][1] * height], end = [path.at(-1)[0] * width, path.at(-1)[1] * height]; context.beginPath();
    if (stroke.tool === 'rectangle') context.rect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
    else if (stroke.tool === 'arrow') { context.moveTo(...start); context.lineTo(...end); const angle = Math.atan2(end[1] - start[1], end[0] - start[0]), head = Math.max(12, (stroke.width || 3) * 4) * width / 640; context.moveTo(end[0] - head * Math.cos(angle - .5), end[1] - head * Math.sin(angle - .5)); context.lineTo(...end); context.lineTo(end[0] - head * Math.cos(angle + .5), end[1] - head * Math.sin(angle + .5)); }
    else { path.forEach((point, index) => context[index ? 'lineTo' : 'moveTo'](point[0] * width, point[1] * height)); if (path.length < 2 || start[0] === end[0] && start[1] === end[1]) { context.arc(start[0], start[1], context.lineWidth / 2, 0, Math.PI * 2); context.fill(); } }
    context.stroke();
  }
}
function renderDrawing() {renderCursors();renderReferenceDrawing(); const rect = canvas.getBoundingClientRect(); canvas.width = Math.round(rect.width * devicePixelRatio); canvas.height = Math.round(rect.height * devicePixelRatio); const strokes = visibleStrokes(drawing ? drawingTime : video.currentTime || 0); if (drawing) strokes.push({ points, tool, color: $('color').value, width: Number($('lineWidth').value) }); if(tool==='laser'&&drawing)strokes.pop();
  const now=Date.now()+clockOffset;
  for(const g of remoteGestures){if(g.expires<=now||g.asset!==asset?.id||g.owner===client+':'+connectionId||events.some(e=>e.strokeId===g.strokeId))continue;if(g.kind==='preview'&&sameFrame(g.time,video.currentTime||0))strokes.push(g);}
  drawOnionLayers(ctx,canvas.width,canvas.height,asset,drawing?drawingTime:video.currentTime||0,fps,'a');drawStrokes(ctx, canvas.width, canvas.height, strokes);
  const lasers=remoteGestures.filter(g=>g.kind==='laser'&&g.asset===asset?.id&&g.expires>now&&g.owner!==client+':'+connectionId);if(localLaser&&localLaser.expires>now&&!drawing)lasers.push(localLaser);if(drawing&&tool==='laser')lasers.push({points,expires:now+1500,color:identityColor});
  for(const g of lasers){const p=g.points.at(-1);ctx.save();ctx.globalAlpha=Math.min(1,(g.expires-now)/700);ctx.fillStyle=g.color;ctx.shadowColor=g.color;ctx.shadowBlur=12*devicePixelRatio;ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,5*devicePixelRatio,0,Math.PI*2);ctx.fill();ctx.restore();}renderSelection();updateUndo();updateAlignmentUI(); }
const point = event => { const rect = canvas.getBoundingClientRect(), clamp = n => Math.max(0, Math.min(1, n)); return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)]; };
canvas.onpointerdown = event => { if (!asset || !joined) return; if(tool!=='laser')video.pause(); strokeId=crypto.randomUUID();drawingTime = video.currentTime || 0; drawing = true; points = [point(event)]; canvas.setPointerCapture(event.pointerId);queueGesture(tool==='laser'?'laser':'preview'); renderDrawing(); };
canvas.onpointermove = event => { if (!drawing) return; if (tool === 'pen') { if (points.length < 1500) points.push(point(event)); } else points = [points[0], point(event)];queueGesture(tool==='laser'?'laser':'preview'); renderDrawing(); };
canvas.onpointerup = safeAction(async () => { if (!drawing) return;if(tool==='laser'){queueGesture('laser');drawing=false;points=[];renderDrawing();return;} const stroke = { type: 'stroke',strokeId, asset: asset.id, points: points.length === 1 ? [points[0], points[0]] : points, tool, color: $('color').value, width: Number($('lineWidth').value), time: drawingTime }; drawing = false; points = []; await post(stroke);queueGesture('clear'); renderDrawing(); });
canvas.onpointercancel = () => {queueGesture('clear'); drawing = false; points = []; renderDrawing(); };
function ownStroke(hidden) { const states = hiddenStrokes(); return events.filter(event => event.type === 'stroke' && event.asset === asset?.id && event.client === client && sameFrame(event.time, video.currentTime) && Boolean(states.get(event.id)) === hidden).at(-1); }
function updateUndo() { $('undo').disabled = !ownStroke(false); $('redo').disabled = !ownStroke(true);updateEditButtons(); }
$('undo').onclick = safeAction(async () => { const stroke = ownStroke(false); if (stroke) await post({ type: 'stroke-hide', target: stroke.id, hidden: true }); });
$('redo').onclick = safeAction(async () => { const stroke = ownStroke(true); if (stroke) await post({ type: 'stroke-hide', target: stroke.id, hidden: false }); });

// Playback calculations use server clock offset, not an assumption that devices agree.
async function broadcast() {
  if (!$('present').checked || !asset || !joined || desiredComparison&&desiredComparison.mode!=='off'&&!compareAsset) return;
  const state = { range:playbackRangeState(),comparison:comparisonState(),term:control.term,type: 'playhead', asset: asset.id, time: video.currentTime || 0, playing: !video.paused, rate: video.playbackRate || 1 };
  const pending = syncQueue.then(() => { if (joined && $('present').checked && asset?.id === state.asset && state.term===control.term) return controlAction('playback',{...state,sequence:++playSequence}); });
  syncQueue = pending.catch(() => {});
  return pending;
}
function scheduleBroadcast() { clearTimeout(syncTimer); if (!$('present').checked) return; syncTimer = setTimeout(() => broadcast().catch(error => toast(error.message)), 60); }
video.onplay = video.onpause = video.onseeked = video.onended = video.onratechange = scheduleBroadcast;
$('present').onchange = safeAction(async () => {try{if(linkedExploration)await followSharedReview();await controlAction(ownsControl()?'release':'claim');}finally{$('present').checked=ownsControl();} });
$('follow').onchange = safeAction(async () => { lastPresenter = ''; if ($('follow').checked) { if(linkedExploration) { await followSharedReview(); $('linkStatus').hidden=true; } else applyPlayback(lastPlayback); } updateSyncHint(); });
function explore() { if (!$('present').checked) { $('follow').checked = false; updateSyncHint(); } }
function stepReview(direction,seconds=false){if(typeof sequenceActive!=='undefined'&&sequenceActive)return stepSequenceFrame(direction,seconds);jump((video.currentTime||0)+direction*(seconds?1:1/fps));}
function jump(time, local = true) { if (!asset) return; if (local) explore(); video.pause(); video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : time, time)); updateTime(); }
$('play').onclick = safeAction(async () => { if (!asset?.type.startsWith('video')) return; explore(); if (video.paused) {prepareRangePlayback();await video.play();} else video.pause(); });
for (const [id, delta] of [['back', -1], ['forward', 1]]) $(id).onclick = () => stepReview(delta);
$('seek').oninput = () => { explore(); video.currentTime = Number($('seek').value); updateTime(); };
$('frameJump').onchange = () => jump(Number($('frameJump').value) / fps);
$('fps').onchange = () => { fps = Number($('fps').value); if (asset) localStorage['frameFps:' + asset.id] = fps; retimePlaybackRange(); updateTime(); renderDrawing(); renderMarkers(); };
$('rate').onchange = () => { explore(); video.playbackRate = Number($('rate').value); };
$('loop').onchange = () => video.loop = $('loop').checked;
$('mute').onchange = () => video.muted = $('mute').checked;
function updateTime() {syncComparison(); renderPlaybackRange(); $('time').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration); $('seek').max = Number.isFinite(video.duration) ? video.duration : 1; $('seek').value = video.currentTime || 0; if (document.activeElement !== $('frameJump')) $('frameJump').value = frame(video.currentTime); $('noteTime').textContent = editing ? 'Editing your note' : 'At ' + fmt(draftAnchor ?? video.currentTime) + ' · frame ' + frame(draftAnchor ?? video.currentTime); renderDrawing(); }
video.ontimeupdate = updateTime;
video.onloadedmetadata = () => {const alignedSwap=applyPendingSourceTime();syncComparison(true); lastPresenter = ''; updateTime(); renderMarkers(); if(!alignedSwap)applyPlayback(lastPlayback); };
image.onload = () => { applyPendingSourceTime(); renderDrawing(); renderMarkers(); };
new ResizeObserver(renderDrawing).observe($('wrap'));
function applyPlayback(latest) {if(linkedExploration)return;if(latest?.asset===asset?.id&&$('follow').checked&&!ownsControl()&&latest.range!==undefined)receivePlaybackRange(latest.range);if(latest?.asset===asset?.id&&latest.comparison!==undefined&&control.presenter&&$('follow').checked&&!ownsControl())receiveComparison(latest.comparison);
  if (!latest || drawing || latest.asset && latest.asset !== asset?.id || !Number.isFinite(video.duration)) return;
  lastPlayback = latest;
  if (false) { $('present').checked = false; $('follow').checked = true; toast(latest.name + ' is leading the review.'); }
  if (latest.id === lastPresenter || $('present').checked || !$('follow').checked) return;
  lastPresenter = latest.id;
  const rate = latest.rate || 1, elapsed=latest.playing?Math.max(0,Date.now()+clockOffset-latest.at)/1000*rate:0, target=latest.playing?rangePlaybackTime(latest.time,elapsed,playbackRange,video.duration,fps):Math.min(video.duration,latest.time);
  video.playbackRate = rate; $('rate').value = rate;
  if (!latest.playing || Math.abs(video.currentTime - target) > .25 || video.paused) video.currentTime = Math.max(0, target);
  if (latest.playing && target < video.duration) video.play().catch(() => { $('reviewControlDetail').textContent = 'Click Play once to allow synchronized playback in this browser.'; }); else video.pause();
  updateSyncHint();
}
function updateSyncHint() { renderReviewControls(); if(control.presenter&&!ownsControl()&&$('follow').checked){$('syncHint').textContent='Following '+control.presenter.name+'. Use Request control to take over.';return;} $('syncHint').textContent = $('present').checked ? 'You’re leading. Playback and frame changes are shared with the room.' : !$('follow').checked ? 'Exploring locally. Use Resume following to rejoin shared playback.' : control.presenter?.name ? 'Following ' + control.presenter.name + ' · shared playback' : 'Ready to follow. Choose Lead review to present to everyone.'; }
function renderMarkers() { $('markers').replaceChildren(); const duration = video.duration; if (!Number.isFinite(duration) || !duration) return; const positions = new Map(); for (const event of [...events.filter(e => e.type === 'comment' && !e.parent && e.asset === asset?.id), ...visibleStrokesAll()]) positions.set(frame(event.time), event.time); for (const [number, time] of positions) { const marker = button('', () => jump(time), 'Jump to annotation at frame ' + number); marker.className = 'marker'; marker.style.left = Math.min(99.5, time / duration * 100) + '%'; marker.title = 'Frame ' + number + ' · ' + fmt(time); $('markers').append(marker); } }
function visibleStrokesAll() { const hidden = hiddenStrokes(); return events.filter(event => event.type === 'stroke' && event.asset === asset?.id && !hidden.get(event.id)); }
function nextAnnotation(direction) { const times = [...new Set(events.filter(event => ['stroke', 'comment'].includes(event.type) && event.asset === asset?.id).map(event => frame(event.time)))].sort((a, b) => a - b); const current = frame(video.currentTime); const next = direction > 0 ? times.find(number => number > current) : times.filter(number => number < current).at(-1); if (next !== undefined) jump(next / fps); }
$('prevNote').onclick = () => nextAnnotation(-1); $('nextNote').onclick = () => nextAnnotation(1);

// Notes keep their original frame while the reviewer types, even if playback moves.
function draftKey() { return 'frameDraft:' + room + ':' + (asset?.id || 'room'); }
function saveDraft() { if (!room || !asset || editing) return; localStorage[draftKey()] = JSON.stringify({ text: $('note').value, time: draftAnchor }); }
function loadDraft() { let draft; try { draft = JSON.parse(localStorage[draftKey()] || '{}'); } catch { draft = {}; } $('note').value = draft.text || ''; draftAnchor = Number.isFinite(draft.time) ? draft.time : null; composerContext(); }
$('note').oninput = () => { if (draftAnchor === null) draftAnchor = video.currentTime || 0; saveDraft(); updateTime(); };
function composerContext() { $('replyContext').hidden = !replyTo && !editing; $('replyLabel').textContent = editing ? 'Editing your comment' : replyTo ? 'Replying to ' + replyTo.name : ''; $('postNote').textContent = editing ? 'Save changes' : replyTo ? 'Post reply ↗' : 'Post comment ↗'; }
$('cancelReply').onclick = () => { editing = replyTo = null; draftAnchor = null; loadDraft(); updateTime(); };
function textOf(comment) { return events.filter(event => event.type === 'comment-edit' && event.target === comment.id).at(-1)?.text ?? comment.text; }
function resolved(comment) { return events.filter(event => event.type === 'resolve' && event.target === comment.id).at(-1)?.resolved || false; }
$('commentForm').onsubmit = safeAction(async event => {
  event.preventDefault(); const text = $('note').value.trim(); if (!text || !asset) return; $('postNote').disabled = true;
  try { if (editing) await post({ type: 'comment-edit', target: editing.id, text, asset: editing.asset }); else await post({ type: 'comment', text, time: draftAnchor ?? video.currentTime ?? 0, ...(replyTo ? { parent: replyTo.id } : {}) }); const restore = editing && draftBeforeEditing; $('note').value = restore ? restore.text : ''; editing = replyTo = null; draftAnchor = restore ? restore.time : null; draftBeforeEditing=null; saveDraft(); composerContext(); updateTime(); }
  finally { $('postNote').disabled = false; }
});
$('noteFilter').onchange = $('noteSearch').oninput = () => { commentSignature = ''; renderComments(); };
function renderComments() {
  const all = events.filter(event => event.type === 'comment' && event.asset === asset?.id), roots = all.filter(event => !event.parent).sort((a, b) => a.time - b.time || a.at - b.at);
  const signature = JSON.stringify([all, events.filter(event => ['resolve', 'comment-edit'].includes(event.type) && event.asset === asset?.id), $('noteFilter').value, $('noteSearch').value, client, highlightedComment]); if (signature === commentSignature) return; commentSignature = signature;
  const scroller = $('comments'), previousScroll = scroller.scrollTop, query = $('noteSearch').value.toLowerCase(), filter = $('noteFilter').value;
  scroller.replaceChildren(); $('count').textContent = roots.length + ' threads · ' + all.length + ' notes';
  for (const root of roots) {
    const replies = all.filter(comment => comment.parent === root.id), done = resolved(root); if (filter === 'open' && done || filter === 'resolved' && !done) continue; if (query && ![root, ...replies].some(comment => (textOf(comment) + ' ' + comment.name).toLowerCase().includes(query))) continue;
    const card = el('article', 'comment' + (done ? ' resolved' : ''));
    for (const comment of [root, ...replies]) { const content = el('div', (comment.parent ? 'reply' : 'comment-body') + (comment.id === highlightedComment ? ' linked-comment' : '')); content.setAttribute('data-comment-id', comment.id); if(comment.id===highlightedComment){content.tabIndex=-1;content.setAttribute('aria-label','Linked comment');} const heading = el('div', 'comment-heading'); heading.append(authorLabel(comment), button(fmt(comment.time), () => jump(comment.time))); const copy = button('Copy comment link', () => copyReviewLink(comment)); copy.title='Copy a link to this comment, its version and original frame. Recipients explore locally.'; copy.className='text-button'; copy.disabled=comment.id.startsWith('pending:'); content.append(heading, el('p', '', textOf(comment)), copy);renderCommentAttachments(content,comment); if (comment.client === client) { const edit = button('Edit', () => { beginAttachmentComment(comment,true); }); edit.className = 'text-button'; content.append(edit); } card.append(content); }
    const actions = el('div', 'comment-actions'); actions.append(button('Reply', () => { beginAttachmentComment(root); }), button(done ? 'Reopen' : '✓ Resolve', () => post({ type: 'resolve', target: root.id, resolved: !done }))); card.append(actions); scroller.append(card);
  }
  if (!scroller.children.length) scroller.append(el('p', 'comment-empty', !asset ? 'Upload media to start the conversation.' : query || filter !== 'all' ? 'No notes match this filter.' : 'Pause on a frame and leave your first note.'));
  restoreAttachmentPreview();scroller.scrollTop = previousScroll; if(highlightedComment&&!highlightScrolled){const target=[...scroller.querySelectorAll('[data-comment-id]')].find(node=>node.getAttribute('data-comment-id')===highlightedComment);if(target){highlightScrolled=true;target.scrollIntoView({block:'nearest'});target.focus({preventScroll:true});}}
}

// Fast live polling and slower durable-note polling have separate request lifecycles.
async function readEvents() { let all = [], cursor = null, watermark = Infinity; do { const query = new URLSearchParams(); if (cursor) query.set('cursor', cursor); if (eventWatermark) query.set('since', String(Math.max(0, eventWatermark - 30000))); const data = await api('/events?' + query); all.push(...data.events); cursor = data.cursor; watermark = Math.min(watermark, data.watermark || 0); } while (cursor && joined); return { all, watermark }; }
async function refresh() { if (!joined || !room || busy) return; busy = true; try { const data = await readEvents(); if (!joined) return; eventWatermark = data.watermark; mergeEvents(data.all); applyLinkedComment(); renderComments(); renderDrawing(); renderMarkers(); if (!lastPlayback) { const old = events.filter(event => event.type === 'playhead' && event.asset === asset?.id).at(-1); if (old) applyPlayback(old); } $('notesStatus').textContent = ''; } catch (error) { $('notesStatus').textContent = 'Notes reconnecting… Your draft is kept.'; throw error; } finally { busy = false; } }
async function liveSync() {
  if (!joined || !room || liveBusy || versionChangeBusy) return; liveBusy = true; const sent = Date.now(),epoch=mediaEpoch;
  try { const data = await api('/live'); if (!joined||versionChangeBusy||epoch!==mediaEpoch) return; clockOffset = data.serverTime - (sent + Date.now()) / 2;applyRoomTitle(data.review); if(!linkedExploration&&!sequenceActive&&!data.playback?.playlist&&($('follow').checked||ownsControl()))setAsset(data.media);const current=data.control?.version>=lastControlVersion;applyControl(data.control);remoteGestures=data.gestures||[];renderDrawing();if(reconnecting){reconnecting=false;lastPresenter='';refresh().catch(()=>{});flushOutbox().catch(()=>{});} if (current&&data.playback) { lastPlayback = data.playback; applyPlayback(data.playback); } renderPeople(data.people); $('connection').textContent = '● Connected'+(queuedEvents().length?' · '+queuedEvents().length+' pending':''); }
  catch (error) { reconnecting=true;$('connection').textContent = 'Reconnecting… drafts and pending notes kept'; throw error; } finally { liveBusy = false; }
}
async function liveLoop() { try { await liveSync(); } catch {} if (joined) liveTimer = setTimeout(liveLoop, document.visibilityState==='hidden'?2500:streamOnline?1500:250); }
async function noteLoop() { try { if(reviewTarget&&!targetApplied)await openReviewTarget();await loadAssets();await flushOutbox();await refresh(); } catch {} if (joined) noteTimer = setTimeout(noteLoop, 2500); }
async function startRoom() { const meta = await api(); applyRoomTitle({...meta,updated:meta.updated||meta.created||0}); clearTimeout(liveTimer); clearTimeout(noteTimer); clearInterval(heartbeatTimer); if(reviewTarget){$('follow').checked=false;try{await openReviewTarget();}catch(error){toast('Linked frame is reconnecting. '+error.message);}} startStream();liveLoop(); noteLoop(); post({ type: 'presence' }).catch(() => {}); heartbeatTimer = setInterval(() => { if (joined) { if (Date.now()-lastHeartbeat>15000) { lastHeartbeat=Date.now();post({ type: 'presence' }).catch(() => {}); } if ($('present').checked) broadcast().catch(() => {}); } }, 3000); flushOutbox().catch(()=>{});updateSyncHint(); }
setInterval(()=>{if(remoteGestures.length||localLaser||drawing&&tool==='laser')renderDrawing();},100);
window.addEventListener('online',()=>{if(joined){reconnecting=true;liveSync().catch(()=>{});}});

// Portable review exports are local downloads; no files are sent to another service.
function download(blob, filename) { const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('exportNotes').onclick = safeAction(async () => { const selected = events.filter(event => event.asset === asset?.id && !['presence', 'playhead'].includes(event.type)); download(new Blob([JSON.stringify({ review: $('title').textContent, media: currentVersion(), exported: new Date().toISOString(), notes: selected }, null, 2)], { type: 'application/json' }), 'frameshare-review-notes.json'); });
$('exportFrame').onclick = safeAction(async () => { if (!asset) return; const source = asset.type.startsWith('video') ? video : image, width = source.videoWidth || source.naturalWidth, height = source.videoHeight || source.naturalHeight; if (!width || !height) throw Error('Wait until the media has loaded.'); const output = document.createElement('canvas'); output.width = width; output.height = height; const context = output.getContext('2d'); context.drawImage(source, 0, 0, width, height); drawStrokes(context, width, height, visibleStrokes()); const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png')); if (!blob) throw Error('Could not export this frame.'); download(blob, 'frameshare-frame-' + frame(video.currentTime) + '.png'); });
document.addEventListener('keydown', event => { if(event.defaultPrevented||event.target.tagName==='SUMMARY'||event.target.closest?.('[data-trim]'))return;if(event.code==='Space'&&event.target.tagName==='BUTTON')return; if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return; if (event.code === 'Space') { event.preventDefault(); $('play').click(); } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const direction = event.key === 'ArrowLeft' ? -1 : 1; stepReview(direction,event.shiftKey); } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); nextAnnotation(event.key === 'ArrowUp' ? -1 : 1); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $(event.shiftKey ? 'redo' : 'undo').click(); } else if (event.key.toLowerCase() === 'p') setTool('pen'); else if (event.key.toLowerCase() === 'l') setTool('laser'); else if (event.key.toLowerCase() === 'v') setTool('select'); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && joined) { liveSync().catch(() => {}); refresh().catch(() => {}); } });
async function boot() { renderRecents(); if (!room) { $('name').value = localStorage.frameName || ''; return; } try { const guest = await api('/session'); if (!guest.joined) return showJoin(); acceptGuest(guest); await startRoom(); } catch (error) { toast(error.message); $('connection').textContent = 'Unable to open room'; } }
// Revised-shot comparison: media/annotations retain their immutable asset IDs.
let revisionOf=null,compareAsset=null,pendingVersionTime=null,desiredComparison=null,comparisonStorageLoaded='',organizeAsset=null,alignmentOffset=0,alignmentPreview=false,comparisonDirty=false;
const referenceVideo=$('compareVideo'),referenceImage=$('compareImage'),referenceCanvas=$('compareCanvas');
function currentVersion(){return assets.find(a=>a.id===asset?.id)||asset;}
function versionName(item){return (item?.versionLabel||'v1')+' · '+(item?.displayName||item?.name||'Media');}
function groupVersions(){const current=currentVersion();return assets.filter(a=>a.shotId===(current?.shotId||current?.id));}
function compareKey(){return 'frameCompare:'+room+':'+asset?.id;}
function comparisonState(){return compareAsset&&$('compareMode').value!=='off'?{asset:compareAsset.id,mode:$('compareMode').value,wipe:Number($('wipe').value),angle:Number($('wipeAngle').value)||0,y:Number($('wipeY').value),offset:alignmentOffset}:null;}
function storeComparison(){comparisonDirty=true;if(asset)localStorage[compareKey()]=JSON.stringify(comparisonState());}
function renderVersionOptions(){
 const current=currentVersion(),groups=new Map();for(const item of assets)if(!groups.has(item.shotId))groups.set(item.shotId,item.shotName);
 $('shotSelect').replaceChildren();for(const [id,name] of groups)$('shotSelect').append(new Option(name,id));if(current)$('shotSelect').value=current.shotId||current.id;
 const versions=groupVersions();$('assetSelect').replaceChildren();for(const item of versions)$('assetSelect').append(new Option('A · '+versionName(item),item.id));if(asset)$('assetSelect').value=asset.id;
 $('assetCount').textContent=versions.length+' version'+(versions.length===1?'':'s');$('organizeVersions').disabled=$('addRevision').disabled=!asset;
 const candidates=versions.filter(a=>a.id!==asset?.id&&a.type.split('/')[0]===asset?.type.split('/')[0]);let selected=$('compareSelect').value;
 if(asset&&comparisonStorageLoaded!==asset.id){comparisonStorageLoaded=asset.id;let saved;try{saved=JSON.parse(localStorage[compareKey()]||'null')}catch{}if(saved&&!desiredComparison)desiredComparison=saved;else if(!desiredComparison)$('compareMode').value='off';}
 if(desiredComparison){selected=desiredComparison.asset;$('compareMode').value=desiredComparison.mode;$('wipe').value=desiredComparison.wipe??50;$('wipeAngle').value=desiredComparison.angle??0;$('wipeY').value=desiredComparison.y??50;alignmentOffset=Number.isFinite(desiredComparison.offset)?desiredComparison.offset:0;}
 $('compareSelect').replaceChildren();for(const item of candidates)$('compareSelect').append(new Option(versionName(item),item.id));
 if(!candidates.length)$('compareSelect').append(new Option('Add another revision to compare',''));
 $('compareSelect').value=candidates.some(a=>a.id===selected)?selected:candidates[0]?.id||'';
 if(desiredComparison&&candidates.some(a=>a.id===desiredComparison.asset))desiredComparison=null;
 $('compareMode').disabled=!candidates.length;$('compareSelect').disabled=!candidates.length;
 if(!candidates.length)$('compareMode').value='off';
 renderShotBrowser();$('versionStatus').disabled=!current;$('versionStatus').value=current?.reviewStatus||'needs-review';$('filename').textContent=current?.displayName||current?.name||'No media yet';$('labelA').textContent='A · '+versionName(current);$('noteVersion').textContent='Notes & drawings for A · '+versionName(current);updateComparison();
}
function updateComparison(){
 renderReviewSetupSummary();
 const item=assets.find(a=>a.id===$('compareSelect').value),mode=$('compareMode').value,enabled=Boolean(item&&mode!=='off');
 $('dropzone').classList.toggle('side',enabled&&mode==='side');$('dropzone').classList.toggle('wipe',enabled&&mode==='wipe');$('dropzone').style.setProperty('--wipe',$('wipe').value+'%');$('wipeDivider').setAttribute('aria-valuenow',$('wipe').value);$('wipeDivider').setAttribute('aria-valuetext','Position '+$('wipe').value+'%, angle '+$('wipeAngle').value+' degrees');
 $('alignmentTools').hidden=!(enabled&&asset?.type.startsWith('video'));$('referenceControls').hidden=!enabled;$('paneB').hidden=!enabled;$('labelA').hidden=!enabled;$('wipeDivider').hidden=!(enabled&&mode==='wipe');$('reviewReference').disabled=!enabled;renderWipeGeometry();
 if(!enabled){alignmentPreview=false;compareAsset=null;referenceVideo.pause();$('compareHint').textContent='Notes and drawings belong to A.';return;}
 if(compareAsset?.id!==item.id){alignmentPreview=false;compareAsset=item;referenceVideo.pause();const src='/api/rooms/'+room+'/media/'+item.id,isVideo=item.type.startsWith('video');referenceVideo.hidden=!isVideo;referenceImage.hidden=isVideo;referenceVideo.removeAttribute('src');referenceImage.removeAttribute('src');if(isVideo)referenceVideo.src=src;else{referenceVideo.load();referenceImage.src=src;}}
 $('labelB').textContent='B · '+versionName(item);syncComparison(true);renderDrawing();
}
function syncComparison(force=false){
 if(!compareAsset)return;if(alignmentPreview&&!video.paused)alignmentPreview=false;updateAlignmentUI();if(alignmentPreview){renderReferenceDrawing();return;}let hint='Playback linked · audio from A · notes and drawings stay with each version.';
 if(compareAsset.type.startsWith('video')&&Number.isFinite(referenceVideo.duration)){
  const time=(video.currentTime||0)+alignmentOffset,end=Math.max(0,referenceVideo.duration-.001),target=Math.max(0,Math.min(time,end)),ended=time>=referenceVideo.duration,before=time<0;
  if(force||video.paused||Math.abs(referenceVideo.currentTime-target)>.10){if(Math.abs(referenceVideo.currentTime-target)>.005)referenceVideo.currentTime=target;}
  referenceVideo.playbackRate=video.playbackRate||1;referenceVideo.muted=true;
  if(!video.paused&&!ended&&!before){if(referenceVideo.paused)referenceVideo.play().catch(()=>{$('compareHint').textContent='Press Play to allow both versions to play.';});}else referenceVideo.pause();
  if(ended)hint='B is past its end: holding the last frame. Original feedback stays in place.';else if(before)hint='B has not started yet: holding the first frame. Original feedback stays in place.';else if(alignmentOffset)hint='Playback linked with timing offset · audio from A · original feedback timestamps retained.';
 }
 $('compareHint').textContent=hint;renderReferenceDrawing();
}
function renderReferenceDrawing(){if(!compareAsset||!referenceCanvas)return;const rect=referenceCanvas.getBoundingClientRect();referenceCanvas.width=Math.round(rect.width*devicePixelRatio);referenceCanvas.height=Math.round(rect.height*devicePixelRatio);const hidden=hiddenStrokes(),rate=Number(localStorage['frameFps:'+compareAsset.id])||fps,time=referenceVideo.currentTime||0;const strokes=events.filter(e=>e.type==='stroke'&&e.asset===compareAsset.id&&!hidden.get(e.id)&&(compareAsset.type.startsWith('image')||Math.floor((e.time+.000001)*rate)===Math.floor((time+.000001)*rate)));const referenceContext=referenceCanvas.getContext('2d');drawOnionLayers(referenceContext,referenceCanvas.width,referenceCanvas.height,compareAsset,time,rate,'b');drawStrokes(referenceContext,referenceCanvas.width,referenceCanvas.height,strokes);}
function receiveComparison(value){comparisonDirty=false;if(asset)localStorage[compareKey()]=JSON.stringify(value);const next=value||{mode:'off'};const current=comparisonState();if(JSON.stringify(current)===JSON.stringify(value))return;desiredComparison=next;if(!value){$('compareMode').value='off';desiredComparison=null;updateComparison();}else renderVersionOptions();}
for(const id of ['compareMode','compareSelect','wipe'])$(id).oninput=()=>{if(id==='compareSelect'){alignmentOffset=0;alignmentPreview=false;}desiredComparison=null;updateComparison();storeComparison();scheduleBroadcast();};
referenceVideo.onseeked=renderReferenceDrawing;referenceVideo.onloadedmetadata=()=>syncComparison(true);referenceVideo.onerror=()=>{$('compareHint').textContent='B could not play. Try an MP4/H.264 revision.';};referenceImage.onload=renderReferenceDrawing;
for(const event of ['onplay','onpause','onseeked','onended','onratechange']){const previous=video[event];video[event]=(...args)=>{previous?.(...args);syncComparison(true);};}
setInterval(()=>{if(compareAsset&&(!video.paused||!referenceVideo.paused))syncComparison();},80);
new ResizeObserver(renderReferenceDrawing).observe($('compareWrap'));
$('addRevision').onclick=()=>{if(!asset)return;revisionOf=asset.id;$('file').click();};
$('shotSelect').onchange=safeAction(async()=>{const next=assets.find(a=>a.shotId===$('shotSelect').value);if(!next)return;desiredComparison=null;$('compareMode').value='off';await selectVersion(next.id);});
async function selectVersion(id,time=null,comparison=null){if(versionChangeBusy)return;if(linkedExploration){const next=assets.find(item=>item.id===id);if(!next)return;pendingVersionTime=time??0;setAsset(next);$('follow').checked=false;if(video.readyState>=1)applyPendingSourceTime();if(comparison){desiredComparison=comparison;renderVersionOptions();storeComparison();}updateSyncHint();return;}saveDraft();const leading=ownsControl()&&$('present').checked;versionChangeBusy=true;mediaEpoch++;clearTimeout(syncTimer);$('reviewReference').disabled=true;$('assetSelect').disabled=true;$('shotSelect').disabled=true;try{const response=await api('/media/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});pendingVersionTime=time;if(comparison)desiredComparison=comparison;setAsset(response.asset);if(time!==null){lastPlayback=null;$('present').checked=leading;if(!leading)$('follow').checked=false;if(Number.isFinite(video.duration))video.currentTime=Math.min(video.duration,time);}await loadAssets();if(comparison){desiredComparison=comparison;renderVersionOptions();storeComparison();}if(leading){$('present').checked=true;await controlAction('playback',{term:control.term,sequence:++playSequence,asset:id,time:time??0,playing:false,rate:video.playbackRate||1,range:playbackRangeState(),comparison:comparisonState()});}updateSyncHint();}finally{mediaEpoch++;versionChangeBusy=false;$('assetSelect').disabled=false;$('shotSelect').disabled=false;$('reviewReference').disabled=!compareAsset||$('compareMode').value==='off';}}
$('assetSelect').onchange=safeAction(()=>selectVersion($('assetSelect').value));
$('reviewReference').onclick=safeAction(async()=>{if(!compareAsset)return;const id=compareAsset.id,previous=asset.id,time=asset.type.startsWith('video')?referenceVideo.currentTime||0:video.currentTime||0,mode=$('compareMode').value,wipe=100-Number($('wipe').value);const comparison={asset:previous,mode,wipe,angle:Number($('wipeAngle').value)||0,y:Number($('wipeY').value),offset:-alignmentOffset};await selectVersion(id,time,comparison);});
$('organizeVersions').onclick=()=>{organizeAsset=asset.id;const current=currentVersion(),groups=new Map(assets.map(a=>[a.shotId,a.shotName]));$('versionGroup').replaceChildren();for(const [id,name] of groups)$('versionGroup').append(new Option(name,id));$('versionGroup').append(new Option('＋ New shot group',''));$('versionGroup').value=current.shotId;$('shotName').value=current.shotName;$('versionLabel').value=current.versionLabel;$('versionsDialog').showModal();};
$('versionGroup').onchange=()=>{$('shotName').value=assets.find(a=>a.shotId===$('versionGroup').value)?.shotName||'';};
$('closeVersions').onclick=()=>$('versionsDialog').close();
$('versionsForm').onsubmit=safeAction(async event=>{event.preventDefault();$('saveVersion').disabled=true;try{await api('/versions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({asset:organizeAsset,shotId:$('versionGroup').value||undefined,shotName:$('shotName').value,versionLabel:$('versionLabel').value})});await loadAssets();$('versionsDialog').close();toast('Version group saved. Original notes and drawings retained.');}finally{$('saveVersion').disabled=false;}});
// Cursor presence is transient and separate from drawing previews.
let cursorSequence=0,cursorPending=null,cursorBusy=false,cursorTimer=null,localCursor=null,lastCursorSent=0;
function colorFor(value){return /^#[a-f0-9]{6}$/i.test(value||'')?value:'#a0a7b0';}
function authorLabel(comment){const node=el('span','author',comment.name);if(comment.identityColor)node.style.color=colorFor(comment.identityColor);return node;}
function renderPeople(people){const holder=$('people');holder.classList.add('participant-list');holder.replaceChildren();const unique=new Map(people.map(p=>[p.client,p]));unique.set(client,{client,name:$('name').value,identityColor});for(const person of unique.values()){const chip=el('span','participant'),dot=el('span','person-dot');dot.style.setProperty('--person-color',colorFor(person.identityColor));chip.append(dot,el('span','',person.name+(person.client===client?' (you)':'')));holder.append(chip);}}
function queueCursor(value){if(!joined||!room)return;localCursor=value;cursorPending={...value,connection:connectionId,sequence:++cursorSequence};if(!cursorTimer)cursorTimer=setTimeout(sendCursor,100);}
async function sendCursor(){cursorTimer=null;if(cursorBusy||!cursorPending)return;cursorBusy=true;const payload=cursorPending;cursorPending=null;try{await api('/cursor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});lastCursorSent=Date.now();}catch{}finally{cursorBusy=false;if(cursorPending&&!cursorTimer)cursorTimer=setTimeout(sendCursor,100);}}
function cursorMediaAt(x,y){const stage=$('dropzone').getBoundingClientRect(),mode=$('compareMode').value,useB=compareAsset&&mode!=='off'&&(mode==='side'?x>=stage.left+stage.width/2:wipeSideB(x-stage.left,y-stage.top,stage.width,stage.height));const target=useB?referenceCanvas:canvas,media=useB?compareAsset:asset,rect=target.getBoundingClientRect();if(!media||!rect.width||!rect.height||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return {visible:false};return {visible:true,asset:media.id,x:(x-rect.left)/rect.width,y:(y-rect.top)/rect.height};}
$('dropzone').onpointermove=event=>{if(event.pointerType==='touch')return;queueCursor(cursorMediaAt(event.clientX,event.clientY));};
$('dropzone').onpointerleave=()=>queueCursor({visible:false});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){localCursor=null;queueCursor({visible:false});}});
window.addEventListener('blur',()=>queueCursor({visible:false}));
setInterval(()=>{if(joined&&localCursor?.visible&&document.visibilityState!=='hidden'&&Date.now()-lastCursorSent>2000)queueCursor(localCursor);},2000);
function renderCursors(){const holder=$('remoteCursors');if(!holder)return;holder.replaceChildren();const now=Date.now()+clockOffset,stage=$('dropzone').getBoundingClientRect();for(const cursor of remoteGestures){if(cursor.kind!=='cursor'||cursor.expires<=now||cursor.owner===client+':'+connectionId)continue;let target;if(cursor.asset===asset?.id)target=canvas;else if(cursor.asset===compareAsset?.id&&$('compareMode').value!=='off')target=referenceCanvas;else continue;const rect=target.getBoundingClientRect();if(!rect.width||!rect.height)continue;const x=rect.left-stage.left+cursor.x*rect.width,y=rect.top-stage.top+cursor.y*rect.height,node=el('div','remote-cursor'+(x>stage.width-170?' near-right':'')+(y>stage.height-50?' near-bottom':''));node.style.left=x+'px';node.style.top=y+'px';node.style.setProperty('--person-color',colorFor(cursor.color));node.setAttribute('data-client',cursor.client);node.append(el('span','cursor-arrow','➤'),el('span','cursor-name',cursor.name));holder.append(node);}}
// HUD is a local display preference; it never changes room authority.
let hudVisible=localStorage.frameHud==='true',hudSignature='';
function renderHud(){const hud=$('reviewHud'),toggle=$('toggleHud');if(!hud||!toggle)return;hud.hidden=!hudVisible;toggle.setAttribute('aria-pressed',String(hudVisible));toggle.setAttribute('aria-label',hudVisible?'Hide review HUD':'Show review HUD');if(!hudVisible)return;
 const offline=typeof navigator!=='undefined'&&navigator.onLine===false,uncertain=offline||reconnecting,leader=control.presenter?.name||'No presenter',mine=ownsControl();
 const playback=!joined?'Join to review':mine?'You · presenting':!$('follow').checked?'You · local exploration':control.presenter?'Following '+leader:'You · no shared presenter';
 const link=offline?'Offline':reconnecting?'Reconnecting':streamOnline?'Connected · live updates':'Connected · polling fallback';
 const rows=[[uncertain?'Lead (last known)':'Shared lead',leader],['Your playback',playback],['Connection',link],['Frame',asset?.type.startsWith('video')?frame(video.currentTime)+' · '+fmt(video.currentTime)+' · '+fps+' fps':asset?'Still image':'No media'],['View',$('compareMode').value==='side'?'Side-by-side':$('compareMode').value==='wipe'?'Wipe':'Single version']];
 const signature=JSON.stringify(rows);if(signature===hudSignature)return;hudSignature=signature;hud.replaceChildren();for(const [label,value] of rows){const row=el('div',label==='Connection'&&uncertain?'hud-warning':'');row.append(el('strong','',label+': '),el('span','',value));hud.append(row);}}
$('toggleHud').onclick=()=>{hudVisible=!hudVisible;localStorage.frameHud=String(hudVisible);renderHud();};
window.addEventListener('offline',renderHud);window.addEventListener('online',renderHud);setInterval(()=>{if(hudVisible)renderHud();},250);renderHud();
boot();

$('mediaActions').addEventListener('click',event=>{if(event.target.closest('button'))$('mediaActions').open=false;});
document.addEventListener('click',event=>{if(!$('mediaActions').contains(event.target))$('mediaActions').open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('mediaActions').open){$('mediaActions').open=false;$('mediaActions').querySelector('summary').focus();}});

function referenceFrameRate(){return Number(localStorage['frameFps:'+compareAsset?.id])||fps;}
function alignmentLocked(){return Boolean(control.presenter&&!ownsControl()&&$('follow').checked);}
function updateAlignmentUI(){renderReviewSetupSummary();const ready=Boolean(compareAsset?.type.startsWith('video')&&Number.isFinite(video.duration)&&Number.isFinite(referenceVideo.duration)),locked=alignmentLocked(),rate=referenceFrameRate();$('alignmentB').disabled=$('alignFrames').disabled=!ready||locked;$('resetAlignment').disabled=!ready||locked||(!alignmentOffset&&!alignmentPreview);$('cancelAlignment').hidden=!alignmentPreview;$('alignmentA').textContent=frame(video.currentTime||0)+' · '+fmt(video.currentTime||0);$('alignmentB').max=ready?Math.max(0,Math.floor((referenceVideo.duration-.001)*rate)):0;if(!alignmentPreview&&document.activeElement!==$('alignmentB'))$('alignmentB').value=Math.floor(((referenceVideo.currentTime||0)+.000001)*rate);$('alignmentSummary').textContent=alignmentOffset?'B '+(alignmentOffset>=0?'+':'')+Math.round(alignmentOffset*rate)+' frames · '+Number(alignmentOffset.toFixed(4))+' s':'Same time';$('alignmentStatus').textContent=locked?'You are following the presenter. Request control or choose Explore locally to adjust alignment.':alignmentPreview?'Local preview: B is independent. Align current frames applies this match; Cancel restores the saved offset.':'B frames use '+rate+' fps. Notes and drawings stay on each version’s original source frame.';}
$('alignmentB').oninput=()=>{if(alignmentLocked()||!compareAsset)return;const value=Number($('alignmentB').value),rate=referenceFrameRate();if(!$('alignmentB').value||!Number.isInteger(value)||value<0||value>Number($('alignmentB').max))return;video.pause();referenceVideo.pause();alignmentPreview=true;referenceVideo.currentTime=value/rate;updateAlignmentUI();renderReferenceDrawing();};
function commitAlignment(value){alignmentPreview=false;alignmentOffset=Math.max(-864000,Math.min(864000,value));desiredComparison=null;syncComparison(true);storeComparison();scheduleBroadcast();}
$('alignFrames').onclick=()=>{if(alignmentLocked()||!compareAsset||!Number.isFinite(referenceVideo.duration))return;const value=Number($('alignmentB').value);if(!$('alignmentB').value||!Number.isInteger(value)||value<0||value>Number($('alignmentB').max)){toast('Choose a valid source frame from B.');return;}commitAlignment(value/referenceFrameRate()-(video.currentTime||0));toast('Frames aligned. Original notes and drawings retained.');};
$('resetAlignment').onclick=()=>{if(!alignmentLocked())commitAlignment(0);};
$('cancelAlignment').onclick=()=>{alignmentPreview=false;syncComparison(true);};

// Layout disclosure is local; collapsing never changes shared review state.
function renderReviewSetupSummary(){
 const current=currentVersion(),reference=assets.find(a=>a.id===$('compareSelect').value),mode=$('compareMode').value;
 const entries={reviewSetupShot:current?.shotName||current?.displayName||current?.name||'No shot selected',reviewSetupVersion:current?'A · '+(current.versionLabel||'v1'):'',reviewSetupStatus:current?({'needs-review':'Needs review','changes-requested':'Changes requested',approved:'Approved'}[current.reviewStatus]||'Needs review'):'',reviewSetupCompare:current?(mode!=='off'&&reference?(mode==='side'?'Side-by-side':'Wipe')+' · B '+(reference.versionLabel||'v1')+(alignmentOffset?' · '+(alignmentOffset>0?'+':'')+Number(alignmentOffset.toFixed(3))+' s':''):'Single view'):''};
 for(const [id,text] of Object.entries(entries)){const node=$(id);if(node.textContent!==text)node.textContent=text;node.hidden=!text;node.title=text.slice(0,199);}
}
$('reviewControls').open=localStorage['frameReviewControls:'+room]==='true';
$('reviewControls').ontoggle=()=>{localStorage['frameReviewControls:'+room]=String($('reviewControls').open);requestAnimationFrame(()=>{renderDrawing();renderWipeGeometry();});};
