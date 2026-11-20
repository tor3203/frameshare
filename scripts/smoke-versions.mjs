import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.argv[2]||'http://localhost:4173',report={origin,checks:[]};
function guest(){let cookie='';return async(path,method='GET',body,headers={})=>{const r=await fetch(origin+path,{method,headers:{Cookie:cookie,...headers},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});for(const c of r.headers.getSetCookie())if(c.startsWith('fs_'))cookie=c.split(';')[0];return r;}}
const host=guest(),reviewer=guest(),check=(name,value)=>{assert.ok(value,name);report.checks.push(name)};
try{
 const {id}=await(await host('/api/rooms','POST',{title:'Revised shot comparison QA',name:'Version QA'})).json(),root='/api/rooms/'+id;report.room=id;
 check('Name-only guest access',(await reviewer(root+'/join','POST',{name:'Revision Reviewer'})).status===200);
 const upload=async(path,name,headers={})=>{const r=await host(root+'/media','POST',await readFile(path),{'Content-Type':'video/mp4','X-File-Name':name,...headers});check(name+' upload',r.status===200);return (await r.json()).asset;};
 const v1=await upload(new URL('./fixtures/review-clock-30s.mp4', import.meta.url),'Shot010-v1.mp4');
 check('Name shot group',(await host(root+'/versions','POST',{asset:v1.id,shotId:v1.id,shotName:'Shot 010 · lighting',versionLabel:'v1 · original'})).status===200);
 const v2=await upload(new URL('./fixtures/review-revised-18s.mp4', import.meta.url),'Shot010-v2.mp4',{'X-Version-Of':v1.id});
 await host(root+'/events','POST',{type:'comment',asset:v1.id,time:6,text:'Original version note only.'});await reviewer(root+'/events','POST',{type:'comment',asset:v2.id,time:6,text:'Revised version note only.'});
 await host(root+'/events','POST',{type:'stroke',asset:v1.id,time:6,points:[[.2,.3],[.7,.5]],tool:'arrow',color:'#ff0000'});await reviewer(root+'/events','POST',{type:'stroke',asset:v2.id,time:6,points:[[.3,.4],[.6,.6]],tool:'rectangle',color:'#00ff00'});
 const items=(await(await reviewer(root+'/assets')).json()).assets;check('Versions grouped and visible to another guest',items.length===2&&items.every(a=>a.shotId===v1.id&&a.shotName==='Shot 010 · lighting'));
 const connection=crypto.randomUUID(),control=(await(await host(root+'/control','POST',{action:'claim',connection})).json()).control;
 const playback={action:'playback',connection,term:control.term,sequence:1,asset:v2.id,time:6,playing:false,comparison:{asset:v1.id,mode:'side',wipe:50}};
 check('Presenter shares side-by-side pair',(await host(root+'/control','POST',playback)).status===200);
 check('Other guest receives pair',(await(await reviewer(root+'/live')).json()).playback.comparison.asset===v1.id);
 check('Presenter shares wipe mode',(await host(root+'/control','POST',{...playback,sequence:2,comparison:{asset:v1.id,mode:'wipe',wipe:35}})).status===200);
 const notes=(await(await reviewer(root+'/events')).json()).events;check('Notes and drawings remain version-specific',notes.filter(e=>e.asset===v1.id).length===2&&notes.filter(e=>e.asset===v2.id).length===2);
 await host(root+'/control','POST',{action:'release',connection,term:control.term});
 report.v1=v1.id;report.v2=v2.id;report.inviteUrl=origin+'/?room='+id;report.passed=true;
}catch(e){report.error=e.message;process.exitCode=1;}
await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
await writeFile(new URL('../test-results/versions-smoke.json', import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
