import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const origin=process.argv[2]||'http://localhost:4173',report={origin,checks:[]};
function guest(){let cookie='';return async(path,method='GET',body,headers={})=>{const r=await fetch(origin+path,{method,headers:{Cookie:cookie,...headers},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});for(const c of r.headers.getSetCookie())if(c.startsWith('fs_'))cookie=c.split(';')[0];return r;}}
const a=guest(),b=guest(),anonymous=guest(),check=(name,value)=>{assert.ok(value,name);report.checks.push(name)};
let reader;
try{
 const alice=await(await a('/api/rooms','POST',{title:'Named cursor QA',name:'Cursor Alice'})).json(),root='/api/rooms/'+alice.id;
 const bob=await(await b(root+'/join','POST',{name:'Cursor Bob'})).json();check('Different identity colors',alice.color!==bob.color&&/^#[a-f0-9]{6}$/i.test(alice.color));report.colors={alice:alice.color,bob:bob.color};
 const upload=await a(root+'/media','POST',await readFile(new URL('./fixtures/review-still.png', import.meta.url)),{'Content-Type':'image/png','X-File-Name':'Cursor QA.png'});check('Review image upload',upload.status===200);const asset=(await upload.json()).asset;
 check('Color survives session restore',(await(await a(root+'/session')).json()).color===alice.color);
 const connection=crypto.randomUUID(),payload={connection,sequence:1,visible:true,asset:asset.id,x:.4,y:.5,color:bob.color,name:'Spoofed'};
 check('Cursor update accepted',(await a(root+'/cursor','POST',payload)).status===200);
 let live=await(await b(root+'/live')).json(),cursor=live.gestures.find(g=>g.kind==='cursor');check('Other guest sees server identity',cursor?.color===alice.color&&cursor?.name==='Cursor Alice'&&cursor.x===.4);
 const response=await b(root+'/stream');reader=response.body.getReader();await reader.read();check('Cursor arrives through stream',new TextDecoder().decode((await reader.read()).value).includes('"kind":"cursor"'));await reader.cancel();reader=null;
 check('Anonymous cursor access rejected',(await anonymous(root+'/cursor','POST',payload)).status===401);
 await a(root+'/cursor','POST',{...payload,sequence:2,visible:false});live=await(await b(root+'/live')).json();check('Leaving media removes cursor',!live.gestures.some(g=>g.kind==='cursor'));
 check('Cursor is absent from saved notes',(await(await b(root+'/events')).json()).events.length===0);
 await a(root+'/events','POST',{type:'presence'});await b(root+'/events','POST',{type:'presence'});live=await(await b(root+'/live')).json();check('Roster exposes both identity colors',new Set(live.people.map(p=>p.identityColor)).size===2);
 report.room=alice.id;report.asset=asset.id;report.inviteUrl=origin+'/?room='+alice.id;report.passed=true;
}catch(e){report.error=e.message;process.exitCode=1;}finally{if(reader)await reader.cancel();await mkdir(new URL('../test-results/', import.meta.url), {recursive: true});
await writeFile(new URL('../test-results/cursors-smoke.json', import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
