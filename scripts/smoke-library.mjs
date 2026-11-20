import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const origin=process.argv[2]||'http://localhost:4173',report={origin,checks:[]};
function guest(){let cookie='';return async(path,method='GET',body,headers={})=>{const r=await fetch(origin+path,{method,headers:{Cookie:cookie,...headers},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});for(const c of r.headers.getSetCookie())if(c.startsWith('fs_'))cookie=c.split(';')[0];return r;}}
const a=guest(),b=guest(),anonymous=guest(),check=(name,value)=>{assert.ok(value,name);report.checks.push(name)};
try{
 const {id}=await(await a('/api/rooms','POST',{title:'Shot browser QA',name:'Catalog QA'})).json(),root='/api/rooms/'+id;report.room=id;
 check('Account-free guest access',(await b(root+'/join','POST',{name:'Catalog Reviewer'})).status===200);
 const upload=async(file,name,type,headers={})=>{const r=await a(root+'/media','POST',await readFile(new URL('./fixtures/'+file, import.meta.url)),{'Content-Type':type,'X-File-Name':name,...headers});assert.equal(r.status,200);return (await r.json()).asset;};
 const first=await upload('review-clock-30s.mp4','Hero-v1.mp4','video/mp4');await a(root+'/versions','POST',{asset:first.id,shotId:first.id,shotName:'Shot 010 · Hero',versionLabel:'v1 · original'});await a(root+'/review-status','POST',{asset:first.id,status:'approved'});
 const revised=await upload('review-revised-18s.mp4','Hero-v2.mp4','video/mp4',{'X-Version-Of':first.id});let items=(await(await b(root+'/assets')).json()).assets;
 check('New revision starts at Needs review',items.find(a=>a.id===revised.id).reviewStatus==='needs-review');check('Earlier approval retained',items.find(a=>a.id===first.id).reviewStatus==='approved');
 await b(root+'/review-status','POST',{asset:revised.id,status:'changes-requested'});await a(root+'/versions','POST',{asset:revised.id,shotId:first.id,shotName:'Shot 010 · Hero',versionLabel:'v2 · lighting'});
 const still=await upload('review-still.png','Composition.png','image/png');await a(root+'/versions','POST',{asset:still.id,shotId:still.id,shotName:'Shot 020 · Composition',versionLabel:'v1'});await a(root+'/review-status','POST',{asset:still.id,status:'approved'});
 const third=await upload('review-clock-30s.mp4','Turntable.mp4','video/mp4');await a(root+'/versions','POST',{asset:third.id,shotId:third.id,shotName:'Shot 030 · Turntable',versionLabel:'v1'});
 items=(await(await b(root+'/assets')).json()).assets;const edit=items.find(a=>a.id===revised.id);check('Status survives version rename',edit.reviewStatus==='changes-requested'&&edit.versionLabel==='v2 · lighting'&&edit.reviewedBy==='Catalog Reviewer');
 const before=[...new Set(items.map(a=>a.shotId))],last=before.at(-1);check('Shot move accepted',(await a(root+'/shot-order','POST',{shotId:last,direction:'up'})).status===200);const after=[...new Set((await(await b(root+'/assets')).json()).assets.map(a=>a.shotId))];check('Other guest receives shared order',after.indexOf(last)===before.length-2);
 const jpeg=await readFile(new URL('./fixtures/review-thumbnail.jpg', import.meta.url));check('Thumbnail upload',(await a(root+'/thumbnails/'+first.id,'POST',jpeg,{'Content-Type':'image/jpeg'})).status===200);const image=await b(root+'/thumbnails/'+first.id);check('Other guest can read thumbnail',image.status===200&&image.headers.get('Content-Type')==='image/jpeg');check('Anonymous thumbnail blocked',(await anonymous(root+'/thumbnails/'+first.id)).status===401);
 check('Anonymous status change blocked',(await anonymous(root+'/review-status','POST',{asset:first.id,status:'approved'})).status===401);check('No annotation side effects',(await(await b(root+'/events')).json()).events.length===0);
 await a(root+'/media/select','POST',{id:revised.id});report.assets={first:first.id,revised:revised.id,still:still.id,third:third.id};report.inviteUrl=origin+'/?room='+id;report.passed=true;
}catch(e){report.error=e.message;process.exitCode=1;}
await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
await writeFile(new URL('../test-results/library-smoke.json', import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
