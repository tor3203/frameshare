import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './test-support.js';

async function review(){const env=setup(),host=env.client(),guest=env.client();const {id}=await(await host.request('/api/rooms','POST',{title:'Shot browser QA',name:'Host'})).json(),root='/api/rooms/'+id;await guest.request(root+'/join','POST',{name:'Reviewer'});const upload=async(name,headers={})=>(await(await host.request(root+'/media','POST','media',{'Content-Type':'video/mp4','X-File-Name':name,...headers})).json()).asset;return {...env,host,guest,root,upload};}

test('review status belongs to its version and survives grouping and renaming',async()=>{
 const env=await review(),{host,guest,root,upload}=env;const first=await upload('v1.mp4');
 assert.equal((await host.request(root+'/review-status','POST',{asset:first.id,status:'approved'})).status,200);
 const second=await upload('v2.mp4',{'X-Version-Of':first.id});let items=(await(await guest.request(root+'/assets')).json()).assets;assert.equal(items.find(a=>a.id===first.id).reviewStatus,'approved');assert.equal(items.find(a=>a.id===second.id).reviewStatus,'needs-review');
 // Independent catalog edits merge; neither operation can discard the other.
 await Promise.all([guest.request(root+'/review-status','POST',{asset:second.id,status:'changes-requested'}),host.request(root+'/versions','POST',{asset:second.id,shotId:first.id,shotName:'Shot 010',versionLabel:'v2 · revised'})]);
 items=(await(await host.request(root+'/assets')).json()).assets;const revised=items.find(a=>a.id===second.id);assert.equal(revised.reviewStatus,'changes-requested');assert.equal(revised.reviewedBy,'Reviewer');assert.equal(revised.shotName,'Shot 010');assert.equal(revised.versionLabel,'v2 · revised');assert.equal(items.find(a=>a.id===first.id).reviewStatus,'approved');
 assert.equal((await host.request(root+'/review-status','POST',{asset:first.id,status:'invalid'})).status,400);assert.equal((await env.client().request(root+'/review-status','POST',{asset:first.id,status:'approved'})).status,401);
 assert.equal((await(await host.request(root+'/events')).json()).events.length,0);
});

test('shared shot order moves whole groups and includes subsequently uploaded shots',async()=>{
 const {host,guest,root,upload}=await review();const a=await upload('a.mp4'),b=await upload('b.mp4'),c=await upload('c.mp4');
 const groups=async()=>[...new Set((await(await guest.request(root+'/assets')).json()).assets.map(a=>a.shotId))];const before=await groups();const last=before.at(-1);await host.request(root+'/shot-order','POST',{shotId:last,direction:'up'});const after=await groups();assert.equal(after.indexOf(last),before.length-2);
 await upload('a-v2.mp4',{'X-Version-Of':a.id});assert.deepEqual(await groups(),after,'revision does not move its shot');const d=await upload('d.mp4');assert.ok((await groups()).includes(d.id));assert.equal((await host.request(root+'/shot-order','POST',{shotId:crypto.randomUUID(),direction:'up'})).status,400);
});

test('thumbnails require room access and malformed or oversized previews fail safely',async()=>{
 const env=await review(),{host,guest,root,upload}=env;const asset=await upload('92b04cb2-9be8-4d0a-ad04-f397786deba9.mp4'),path=root+'/thumbnails/'+asset.id;
 const meta=(await(await host.request(root+'/assets')).json()).assets[0];assert.ok(meta.displayName.startsWith('Clip · '));assert.notEqual(meta.displayName,asset.name);
 assert.equal((await guest.request(path)).status,404);assert.equal((await host.request(path,'POST','text',{'Content-Type':'image/jpeg'})).status,400);assert.equal((await host.request(path,'POST','data',{'Content-Type':'text/html'})).status,415);
 const bytes=Buffer.from([255,216,0,0,255,217]);assert.equal((await host.request(path,'POST',bytes,{'Content-Type':'image/jpeg'})).status,200);const result=await guest.request(path);assert.equal(result.headers.get('Content-Type'),'image/jpeg');assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
 assert.equal((await env.client().request(path)).status,401);assert.equal((await env.client().request(path,'POST',bytes,{'Content-Type':'image/jpeg'})).status,401);assert.equal((await host.request(path,'POST',Buffer.alloc(150001),{'Content-Type':'image/jpeg'})).status,413);
});
