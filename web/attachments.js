/* Saved references belong to notes. Pinning and opacity are browser-local. */
let draftAttachments=[],attachmentUploadBusy=false,pinnedAttachment=null,attachmentOpacity=60;
const attachmentURL=id=>'/api/rooms/'+room+'/attachments/'+encodeURIComponent(id);
const attachmentDraftBase=()=> 'frameDraft:'+room+':'+(asset?.id||'room');
function draftKey(){return attachmentDraftBase()+(replyTo?':reply:'+replyTo.id:'');}
function attachmentsOf(comment){return events.filter(e=>e.type==='comment-edit'&&e.target===comment.id&&Array.isArray(e.attachments)).at(-1)?.attachments??comment.attachments??[];}
function saveDraft(){
  if(!room||!asset||editing)return;
  localStorage[draftKey()]=JSON.stringify({text:$('note').value,time:draftAnchor,attachments:draftAttachments});
  localStorage[attachmentDraftBase()+':context']=JSON.stringify(replyTo?{id:replyTo.id,name:replyTo.name,time:replyTo.time,asset:replyTo.asset}:null);
}
function loadDraft(restoreContext=true){
  if(restoreContext){try{const parent=JSON.parse(localStorage[attachmentDraftBase()+':context']||'null');replyTo=parent?.asset===asset?.id&&typeof parent.id==='string'?parent:null;}catch{replyTo=null;}}
  let draft;try{draft=JSON.parse(localStorage[draftKey()]||'{}')}catch{draft={}}
  $('note').value=draft.text||'';draftAnchor=Number.isFinite(draft.time)?draft.time:replyTo?.time??null;
  draftAttachments=Array.isArray(draft.attachments)?draft.attachments.slice(0,5):[];composerContext();
}
function beginAttachmentComment(comment,edit=false){
  if(attachmentUploadBusy)throw Error('Wait for the image upload to finish before changing comment context.');
  saveDraft();editing=edit?comment:null;replyTo=edit?null:comment;draftAnchor=comment.time;
  if(edit){$('note').value=textOf(comment);draftAttachments=[...attachmentsOf(comment)];}
  else {loadDraft(false);draftAnchor=comment.time;saveDraft();}
  composerContext();updateTime();$('note').focus();
}
const originalComposerContext=composerContext;
composerContext=()=>{originalComposerContext();renderComposerAttachments();};
function renderComposerAttachments(){
  const holder=$('draftAttachments');holder.replaceChildren();
  for(const item of draftAttachments){const card=el('div','draft-attachment'),img=el('img');img.src=attachmentURL(item.id);img.alt=item.name;const remove=button('Remove',()=>{draftAttachments=draftAttachments.filter(a=>a.id!==item.id);saveDraft();renderComposerAttachments();});remove.disabled=attachmentUploadBusy;remove.title='Remove this image from the unsent note. Posted attachments are unchanged.';card.append(img,el('span','',item.name),remove);holder.append(card);}
  $('attachImages').disabled=!asset||attachmentUploadBusy||draftAttachments.length>=5;
  $('cancelReply').disabled=attachmentUploadBusy;
  $('postNote').disabled=!asset||attachmentUploadBusy;
  $('attachmentUploadStatus').textContent=attachmentUploadBusy?'Uploading reference image…':'PNG, JPG, WebP · up to 5 images · 8 MB each';
}
async function addCommentImages(files){
  if(!joined||!asset)throw Error('Join and choose a version before attaching images.');
  if(attachmentUploadBusy)throw Error('Wait for the current image upload to finish.');
  const images=Array.from(files);if(!images.length)return;if(draftAttachments.length+images.length>5)throw Error('Attach up to 5 images per note.');
  for(const file of images){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Use PNG, JPG or WebP images.');if(!file.size||file.size>8*1024*1024)throw Error('Images must be between 1 byte and 8 MB.');}
  const originAsset=asset.id,originEdit=editing?.id,originParent=replyTo?.id;
  draftAnchor=editing?.time??replyTo?.time??draftAnchor??(asset.type.startsWith('image')?0:video.currentTime||0);
  const time=draftAnchor,key=draftKey();saveDraft();attachmentUploadBusy=true;renderComposerAttachments();
  try{for(const file of images){
    const id=crypto.randomUUID(),response=await fetch('/api/rooms/'+room+'/attachments/'+id,{method:'POST',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name||'Pasted reference.png'),'X-Asset':originAsset,'X-Frame-Time':String(time)},body:file,signal:AbortSignal.timeout(60000)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Image upload failed. Please try again.');
    const item={id:data.attachment.id,name:data.attachment.name,type:data.attachment.type,size:data.attachment.size};
    if(asset?.id===originAsset&&editing?.id===originEdit&&replyTo?.id===originParent){draftAttachments.push(item);saveDraft();}
    else {let saved;try{saved=JSON.parse(localStorage[key]||'{}')}catch{saved={}}localStorage[key]=JSON.stringify({...saved,time,attachments:[...(saved.attachments||[]),item].slice(0,5)});toast('Image saved with the draft on its original version.');}
  }}finally{attachmentUploadBusy=false;renderComposerAttachments();updateTime();}
}
$('attachImages').onclick=()=>$('attachmentFiles').click();
$('attachmentFiles').onchange=safeAction(async()=>{try{await addCommentImages($('attachmentFiles').files)}finally{$('attachmentFiles').value='';}});
const imageFiles=transfer=>Array.from(transfer?.files||[]).filter(file=>file.type.startsWith('image/'));
$('commentForm').addEventListener('dragover',event=>{event.preventDefault();$('commentForm').classList.add('attachment-dragging');});
$('commentForm').addEventListener('dragleave',event=>{if(!$('commentForm').contains(event.relatedTarget))$('commentForm').classList.remove('attachment-dragging');});
$('commentForm').addEventListener('drop',safeAction(async event=>{event.preventDefault();event.stopPropagation();$('commentForm').classList.remove('attachment-dragging');const files=imageFiles(event.dataTransfer);if(!files.length)throw Error('Drop PNG, JPG or WebP reference images here.');await addCommentImages(files);}));
$('note').addEventListener('paste',safeAction(async event=>{const files=imageFiles(event.clipboardData);if(!files.length)return;event.preventDefault();await addCommentImages(files);}));
$('cancelReply').onclick=()=>{if(attachmentUploadBusy)return;const wasEditing=Boolean(editing);editing=null;replyTo=null;if(!wasEditing)localStorage.removeItem(attachmentDraftBase()+':context');loadDraft();updateTime();};
$('commentForm').onsubmit=safeAction(async event=>{
  event.preventDefault();if(attachmentUploadBusy)throw Error('Wait for the image upload to finish.');
  const text=$('note').value.trim();if(!asset||!text&&!draftAttachments.length)return;
  const key=draftKey(),originAsset=asset.id,originEdit=editing,originParent=replyTo;
  const payload={asset:originAsset,text,attachments:draftAttachments.map(a=>a.id),...(originEdit?{type:'comment-edit',target:originEdit.id}:{type:'comment',time:draftAnchor??video.currentTime??0,...(originParent?{parent:originParent.id}:{})})};
  $('postNote').disabled=true;
  try{await post(payload);if(!originEdit)localStorage.removeItem(key);
    if(asset?.id===originAsset&&editing?.id===originEdit?.id&&replyTo?.id===originParent?.id){editing=replyTo=null;if(!originEdit)localStorage.removeItem(attachmentDraftBase()+':context');loadDraft();updateTime();}
  }finally{renderComposerAttachments();}
});
function renderCommentAttachments(content,comment){
  const items=attachmentsOf(comment);if(!items.length)return;const grid=el('div','comment-attachments');
  for(const item of items){const pin=button('',()=>pinCommentImage(comment,item),'Pin '+item.name+' over A');pin.className='attachment-thumbnail';pin.title='Pin this reference over A. Its note stays on the original frame. Opacity and visibility are local to you.';const img=el('img');img.src=attachmentURL(item.id);img.alt=item.name;img.loading='lazy';img.onerror=()=>{pin.classList.add('attachment-unavailable');pin.title='This image could not load. Reconnect or refresh to try again.';};pin.append(img,el('span','',item.name));grid.append(pin);}content.append(grid);
}
const previewKey=()=> 'frameAttachmentPreview:'+room+':'+client+':'+asset?.id;
const opacityKey=()=> 'frameAttachmentOpacity:'+room+':'+client;
function displayPinnedImage(item){
  pinnedAttachment=item;let opacity=Number(localStorage[opacityKey()]||60);attachmentOpacity=Number.isFinite(opacity)?Math.max(5,Math.min(100,opacity)):60;
  const overlay=$('attachmentOverlay');overlay.src=attachmentURL(item.id);overlay.alt='Pinned reference: '+item.name;overlay.style.opacity=attachmentOpacity/100;overlay.hidden=false;
  $('attachmentPreviewTools').hidden=false;$('attachmentPreviewName').textContent=item.name+' · local over A';$('attachmentOpacity').value=attachmentOpacity;$('attachmentOpacityValue').textContent=attachmentOpacity+'%';
}
function pinCommentImage(comment,item){
  if(comment.asset!==asset?.id)return;displayPinnedImage({...item,comment:comment.id,asset:comment.asset});localStorage[previewKey()]=JSON.stringify({id:item.id,comment:comment.id});
}
function restoreAttachmentPreview(){
  if(!joined||!asset)return;if(pinnedAttachment?.asset===asset.id)return;
  hideAttachmentPreview();let saved;try{saved=JSON.parse(localStorage[previewKey()]||'null')}catch{return}if(!saved)return;
  const comment=events.find(e=>e.type==='comment'&&e.id===saved.comment&&e.asset===asset.id),item=comment&&attachmentsOf(comment).find(a=>a.id===saved.id);
  if(item)displayPinnedImage({...item,comment:comment.id,asset:asset.id});
}
function hideAttachmentPreview(){pinnedAttachment=null;$('attachmentOverlay').hidden=true;$('attachmentOverlay').removeAttribute('src');$('attachmentPreviewTools').hidden=true;}
$('closeAttachmentPreview').onclick=()=>{if(asset)localStorage.removeItem(previewKey());hideAttachmentPreview();};
$('attachmentOverlay').onerror=()=>{hideAttachmentPreview();toast('Reference image could not load. Reconnect and click its thumbnail to retry.');};
$('attachmentOpacity').oninput=()=>{attachmentOpacity=Math.max(5,Math.min(100,Number($('attachmentOpacity').value)||60));$('attachmentOverlay').style.opacity=attachmentOpacity/100;$('attachmentOpacityValue').textContent=attachmentOpacity+'%';localStorage[opacityKey()]=attachmentOpacity;};
