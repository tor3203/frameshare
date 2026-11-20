import {localDatabase} from '../scripts/local-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

function setup(){
 const objects=new Map(),db=localDatabase();
 const bucket={async put(key,body,options={}){objects.set(key,{bytes:Buffer.from(await new Response(body).arrayBuffer()),options,uploaded:new Date()})},async get(key){const o=objects.get(key);return o?{json:async()=>JSON.parse(o.bytes),body:o.bytes,writeHttpMetadata(h){h.set('Content-Type',o.options.httpMetadata?.contentType||'application/json')}}:null},async list({prefix,limit=50,cursor}){const keys=[...objects.keys()].filter(key=>key.startsWith(prefix)).sort(),start=Number(cursor)||0;return {objects:keys.slice(start,start+limit).map(key=>({key,uploaded:objects.get(key).uploaded,customMetadata:objects.get(key).options.customMetadata})),truncated:start+limit<keys.length,cursor:String(start+limit)}}};
 function client(){let cookie='';return {get cookie(){return cookie},async request(path,method='GET',body,headers={}){const response=await worker.fetch(new Request('https://review.test'+path,{method,headers:{Cookie:cookie,...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),{BUCKET:bucket,DB:db});if(response.headers.get('Set-Cookie'))cookie=response.headers.get('Set-Cookie').split(';')[0];return response}}}
 return {objects,bucket,client};
}

test('private invites join with only a name and protect every room resource',async()=>{
 const {client}=setup(),host=client(),coworker=client(),anonymous=client();
 assert.equal((await host.request('/api/rooms','POST',{title:'Review'})).status,400);
 const created=await host.request('/api/rooms','POST',{title:'Private review',name:'Host'});assert.equal(created.status,201);
 assert.match(created.headers.get('Set-Cookie'),/HttpOnly/);assert.match(created.headers.get('Set-Cookie'),/Secure/);assert.match(created.headers.get('Set-Cookie'),/SameSite=Lax/);
 const {id}=await created.json(),root='/api/rooms/'+id;
 assert.deepEqual(await (await coworker.request(root+'/session')).json(),{joined:false});
 for(const path of ['', '/events','/media','/media/'+crypto.randomUUID()])assert.equal((await anonymous.request(root+path)).status,401,path+' needs a joined session');
 assert.equal((await anonymous.request(root+'/events','POST',{type:'comment',text:'No session',time:0})).status,401);
 for(const name of ['', ' '.repeat(3),'x'.repeat(41),'bad\nname'])assert.equal((await coworker.request(root+'/join','POST',{name})).status,400);
 const joined=await coworker.request(root+'/join','POST',{name:'  Coworker  '});assert.equal(joined.status,200);const guest=await joined.json();assert.equal(guest.name,'Coworker');assert.equal(guest.joined,true);
 assert.equal((await coworker.request(root)).status,200);
 await coworker.request(root+'/events','POST',{type:'comment',text:'Joined without an account',time:0,name:'Forged author',client:'forged-client'});
 const events=(await (await host.request(root+'/events')).json()).events;assert.equal(events[0].name,'Coworker');assert.equal(events[0].client,guest.clientId);
 await host.request(root+'/media','POST','private image bytes',{'Content-Type':'image/png'});
 const asset=await (await coworker.request(root+'/media')).json();assert.equal(await (await coworker.request(root+'/media/'+asset.id)).text(),'private image bytes');
 assert.equal((await anonymous.request(root+'/media/'+asset.id)).status,401);
 assert.equal((await coworker.request(root+'/events','POST',{type:'presence'},{Origin:'https://elsewhere.test'})).status,403);
 const other=await host.request('/api/rooms','POST',{title:'Another room',name:'Other host'}),otherId=(await other.json()).id;
 assert.equal((await coworker.request('/api/rooms/'+otherId)).status,401,'a room session grants no other room access');
});

test('existing invite URLs work and expired sessions must rejoin',async()=>{
 const {client,objects,bucket}=setup(),guest=client(),id=crypto.randomUUID(),root='/api/rooms/'+id;
 await bucket.put(`rooms/${id}/meta`,JSON.stringify({title:'Existing review',created:Date.now()}));
 const response=await guest.request(root+'/join','POST',{name:'Returning reviewer'});assert.equal(response.status,200);
 const token=guest.cookie.split('=')[1],key=`rooms/${id}/sessions/${token}`;
 const session=JSON.parse(objects.get(key).bytes);session.expires=Date.now()-1;await bucket.put(key,JSON.stringify(session));
 assert.deepEqual(await (await guest.request(root+'/session')).json(),{joined:false});assert.equal((await guest.request(root+'/events')).status,401);
 assert.equal((await guest.request(root+'/join','POST',{name:'Returning reviewer'})).status,200);assert.equal((await guest.request(root)).status,200);
 const stranger=client();assert.equal((await stranger.request('/api/rooms/'+crypto.randomUUID()+'/join','POST',{name:'Guest'})).status,404);
 assert.equal((await stranger.request(root+'/join','GET')).status,405);
 assert.equal((await stranger.request(root+'/events','GET',undefined,{Cookie:'fs_'+id+'=bad-token'})).status,401);
});
