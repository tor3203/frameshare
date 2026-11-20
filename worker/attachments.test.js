import test from 'node:test';import assert from 'node:assert/strict';import {setup} from './test-support.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=','base64');
async function fixture(){const env=setup(),host=env.client(),peer=env.client(),outsider=env.client();const {id}=await(await host.request('/api/rooms','POST',{title:'Attachment QA',name:'Host'})).json(),root='/api/rooms/'+id;await peer.request(root+'/join','POST',{name:'Reviewer'});const asset=(await(await host.request(root+'/media','POST','clip',{'Content-Type':'video/mp4'})).json()).asset;const upload=(client=host,context={},bytes=png,type='image/png',id=crypto.randomUUID())=>client.request(root+'/attachments/'+id,'POST',bytes,{'Content-Type':type,'X-Asset':asset.id,'X-Frame-Time':'2','X-File-Name':encodeURIComponent('Pose reference.png'),...context});return {...env,host,peer,outsider,root,asset,upload};}
test('account-free guests share saved images on comments and replies with immutable version and frame anchors',async()=>{const f=await fixture();try{
 const first=await f.upload(),image=(await first.json()).attachment;assert.equal(first.status,200);assert.equal(image.asset,f.asset.id);assert.equal(image.time,2);
 const posted=await f.host.request(f.root+'/events','POST',{type:'comment',text:'',asset:f.asset.id,time:2,attachments:[image.id],requestId:crypto.randomUUID()});assert.equal(posted.status,200);const root=(await posted.json()).event;
 const replyImage=(await(await f.upload(f.peer)).json()).attachment;const reply=(await f.peer.request(f.root+'/events','POST',{type:'comment',parent:root.id,text:'Pose detail',asset:f.asset.id,time:2,attachments:[replyImage.id]}));assert.equal(reply.status,200);
 const loaded=await f.peer.request(f.root+'/attachments/'+image.id);assert.equal(loaded.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await loaded.arrayBuffer()),png);
 const notes=(await(await f.peer.request(f.root+'/events')).json()).events;assert.equal(notes.find(e=>e.id===root.id).attachments[0].name,'Pose reference.png');assert.equal(notes.filter(e=>e.type==='comment').length,2);assert.ok(notes.every(e=>e.asset===f.asset.id&&e.time===2));
 const edited=await f.host.request(f.root+'/events','POST',{type:'comment-edit',target:root.id,text:'Updated guidance',attachments:[image.id],asset:f.asset.id,time:90});assert.equal(edited.status,200);assert.equal((await edited.json()).event.time,2,'edits keep the original frame despite a stale client playhead');
 }finally{f.db.close()}});
test('attachment reads and uploads require room membership and references cannot cross owners, rooms, versions or frames',async()=>{const f=await fixture();try{
 const id=crypto.randomUUID();assert.equal((await f.upload(f.outsider,{},png,'image/png',id)).status,401);assert.equal((await f.outsider.request(f.root+'/attachments/'+id)).status,401);
 const image=(await(await f.upload()).json()).attachment;const comment={type:'comment',text:'Reference',asset:f.asset.id,time:2,attachments:[image.id]};
 assert.equal((await f.peer.request(f.root+'/events','POST',comment)).status,403);assert.equal((await f.host.request(f.root+'/events','POST',{...comment,time:3})).status,400);
 const other=(await(await f.host.request(f.root+'/media','POST','other',{'Content-Type':'video/mp4'})).json()).asset;assert.equal((await f.host.request(f.root+'/events','POST',{...comment,asset:other.id})).status,400);
 const room2=(await(await f.host.request('/api/rooms','POST',{title:'Other',name:'Host'})).json()).id;assert.equal((await f.host.request('/api/rooms/'+room2+'/attachments/'+image.id)).status,404);assert.equal((await f.host.request('/api/rooms/'+room2+'/events','POST',comment)).status,404);
 assert.equal((await f.host.request(f.root+'/events','POST',{...comment,attachments:[image.id,image.id]})).status,400);assert.equal((await f.host.request(f.root+'/events','POST',{...comment,attachments:Array(6).fill(image.id)})).status,400);
 }finally{f.db.close()}});
test('image uploads reject unsupported, malformed and oversized files and retry without changing existing content',async()=>{const f=await fixture();try{
 assert.equal((await f.upload(f.host,{},Buffer.from('<svg/>'),'image/svg+xml')).status,415);assert.equal((await f.upload(f.host,{},Buffer.from('not an image'))).status,400);
 assert.equal((await f.upload(f.host,{},Buffer.alloc(8*1024*1024+1))).status,413);assert.equal((await f.upload(f.host,{'X-Frame-Time':'NaN'})).status,400);assert.equal((await f.upload(f.host,{'X-Asset':crypto.randomUUID()})).status,404);
 const id=crypto.randomUUID();assert.equal((await f.upload(f.host,{},png,'image/png',id)).status,200);assert.equal((await f.upload(f.host,{},png,'image/png',id)).status,200);assert.equal((await f.upload(f.peer,{},png,'image/png',id)).status,403);
 const posted=await f.host.request(f.root+'/events','POST',{type:'comment',text:'Keep image',asset:f.asset.id,time:2,attachments:[id],requestId:crypto.randomUUID()});const event=(await posted.json()).event;
 assert.equal((await f.host.request(f.root+'/events','POST',{type:'comment-edit',target:event.id,text:'',asset:f.asset.id,attachments:[]})).status,400,'cannot create an empty note by removing its final attachment');
 }finally{f.db.close()}});
test('simultaneous upload IDs reserve one author before publishing image bytes',async()=>{const f=await fixture();try{
 const id=crypto.randomUUID(),responses=await Promise.all([f.upload(f.host,{},png,'image/png',id),f.upload(f.peer,{},png,'image/png',id)]);
 assert.equal(responses.filter(r=>r.status===200).length,1);assert.ok(responses.some(r=>[403,409].includes(r.status)));
 const winner=responses[0].status===200?f.host:f.peer,loser=responses[0].status===200?f.peer:f.host;
 const note={type:'comment',text:'Winning image',asset:f.asset.id,time:2,attachments:[id]};assert.equal((await winner.request(f.root+'/events','POST',note)).status,200);assert.equal((await loser.request(f.root+'/events','POST',note)).status,403);
 assert.deepEqual(Buffer.from(await(await f.peer.request(f.root+'/attachments/'+id)).arrayBuffer()),png);
 }finally{f.db.close()}});
