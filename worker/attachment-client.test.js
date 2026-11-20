import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',IMAGE='33333333-3333-4333-8333-333333333333';
async function browser(){
 const nodes=new Map(),requests=[],posts=[];function node(){return {value:'',hidden:true,style:{},children:[],handlers:{},classList:{add(){},remove(){}},append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},addEventListener(type,fn){this.handlers[type]=fn},removeAttribute(name){delete this[name]},focus(){},contains(){return false}}};const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
 const storage={removeItem(key){delete this[key]}};
 const c=vm.createContext({$:get,el:()=>node(),button:(text,fn)=>({...node(),onclick:fn}),safeAction:fn=>fn,composerContext(){},room:'room',client:'guestA',joined:true,asset:{id:A,type:'video/mp4'},events:[],video:{currentTime:2},editing:null,replyTo:null,draftAnchor:null,localStorage:storage,crypto,AbortSignal,toast(){},textOf:comment=>comment.text,updateTime(){},post:async payload=>posts.push(payload),fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({attachment:{id:IMAGE,name:'Reference.png',type:'image/png',size:100}})}}});
 vm.runInContext(await readFile('web/attachments.js','utf8'),c);return {c,get,requests,posts,run:s=>vm.runInContext(s,c)};
}
const file={type:'image/png',size:100,name:'Reference.png'};
test('upload captures version/frame before async playback changes and preserves a draft after a version switch',async()=>{
 const b=await browser();let resolve;b.c.fetch=async(url,options)=>{b.requests.push({url,options});return new Promise(r=>resolve=r)};b.c.file=file;
 const upload=b.run('addCommentImages([file])');assert.equal(b.requests[0].options.headers['X-Asset'],A);assert.equal(b.requests[0].options.headers['X-Frame-Time'],'2');
 b.c.video.currentTime=9;b.c.asset={id:B,type:'video/mp4'};b.run('draftAttachments=[];draftAnchor=9');resolve({ok:true,json:async()=>({attachment:{id:IMAGE,name:'Reference.png',type:'image/png',size:100}})});await upload;
 assert.equal(b.run('draftAttachments.length'),0);const saved=JSON.parse(b.c.localStorage['frameDraft:room:'+A]);assert.equal(saved.time,2);assert.equal(saved.attachments[0].id,IMAGE);
});
test('paste and drop use the same validated attachment pipeline and preserve text-only clipboard behavior',async()=>{
 const b=await browser();let prevented=0,stopped=0;
 await b.get('note').handlers.paste({clipboardData:{files:[file]},preventDefault(){prevented++}});assert.equal(b.requests.length,1);assert.equal(prevented,1);
 await b.get('note').handlers.paste({clipboardData:{files:[]},preventDefault(){prevented++}});assert.equal(prevented,1);
 await b.get('commentForm').handlers.drop({dataTransfer:{files:[file]},preventDefault(){prevented++},stopPropagation(){stopped++}});assert.equal(b.requests.length,2);assert.equal(stopped,1);assert.equal(b.requests[1].options.headers['X-Frame-Time'],'2');
 b.c.bad={type:'image/svg+xml',size:20,name:'bad.svg'};await assert.rejects(b.run('addCommentImages([bad])'),/PNG, JPG or WebP/);
});
test('reply drafts restore image references after refresh and image-only submission keeps its original parent/version/time',async()=>{
 const b=await browser();b.c.file=file;b.c.replyTo={id:'thread',name:'Host',asset:A,time:2};b.c.draftAnchor=2;await b.run('addCommentImages([file])');b.run('saveDraft();draftAttachments=[];replyTo=null;draftAnchor=null;loadDraft()');
 assert.equal(b.run('replyTo.id'),'thread');assert.equal(b.run('draftAttachments.length'),1);b.c.video.currentTime=8;await b.get('commentForm').onsubmit({preventDefault(){}});
 assert.deepEqual(JSON.parse(JSON.stringify(b.posts[0])),{asset:A,text:'',attachments:[IMAGE],type:'comment',time:2,parent:'thread'});assert.equal(b.run('draftAttachments.length'),0);
});
test('pin and opacity are local per participant and version, survive refresh, and never seek or publish playback',async()=>{
 const b=await browser();b.run(`comment={id:'comment',type:'comment',asset:asset.id,time:2,text:'Reference',attachments:[{id:'${IMAGE}',name:'Reference.png'}]};events=[comment];snapshot=JSON.stringify(events);pinCommentImage(comment,comment.attachments[0])`);
 b.get('attachmentOpacity').value='35';b.get('attachmentOpacity').oninput();assert.equal(b.c.video.currentTime,2);assert.equal(b.posts.length,0);assert.equal(b.get('attachmentOverlay').hidden,false);
 b.run('hideAttachmentPreview();restoreAttachmentPreview()');assert.equal(b.get('attachmentOpacityValue').textContent,'35%');assert.equal(b.get('attachmentOverlay').hidden,false);
 b.c.client='guestB';b.run('hideAttachmentPreview();restoreAttachmentPreview()');assert.equal(b.get('attachmentOverlay').hidden,true);
 b.c.client='guestA';b.c.asset={id:B,type:'video/mp4'};b.run('restoreAttachmentPreview()');assert.equal(b.get('attachmentOverlay').hidden,true);assert.equal(b.run('JSON.stringify(events)===snapshot'),true);
});
test('editing text retains existing attachment IDs and edit events retain effective attachment lists',async()=>{
 const b=await browser();b.run(`comment={id:'comment',type:'comment',asset:asset.id,time:2,text:'Before',attachments:[{id:'${IMAGE}',name:'Reference.png'}]};events=[comment];beginAttachmentComment(comment,true)`);b.get('note').value='After';b.c.video.currentTime=10;await b.get('commentForm').onsubmit({preventDefault(){}});assert.equal(b.posts[0].target,'comment');assert.deepEqual(Array.from(b.posts[0].attachments),[IMAGE]);assert.equal(b.posts[0].asset,A);
 b.run("events.push({type:'comment-edit',target:'comment',attachments:[]})");assert.equal(b.run('attachmentsOf(comment).length'),0);
});
