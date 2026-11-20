import {collaborationView,playbackTimeAt,projectedSequence,sequenceBounds,changeCollaboration,LEASE_MS,readControl,readGestures,saveGesture} from './collaboration.js';
// Room IDs are private invite capabilities. There is deliberately no room directory.
const SECURITY={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_UPLOAD=80*1024*1024;
const MAX_ATTACHMENT=8*1024*1024;
async function attachmentBytes(req){
 if(Number(req.headers.get('Content-Length'))>MAX_ATTACHMENT)throw new Problem('Images must be 8 MB or smaller.',413);
 const reader=req.body?.getReader();if(!reader)throw new Problem('Choose an image.');let size=0,chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_ATTACHMENT){await reader.cancel();throw new Problem('Images must be 8 MB or smaller.',413);}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function validAttachment(bytes,type){
 if(type==='image/png')return bytes.length>=24&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)&&String.fromCharCode(...bytes.slice(12,16))==='IHDR';
 if(type==='image/jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217;
 if(type==='image/webp')return bytes.length>=20&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 return false;
}
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{...SECURITY,...headers}});
class Problem extends Error{constructor(message,status=400){super(message);this.status=status}}
function nameOf(body){const name=typeof body?.name==='string'?body.name.trim():'';if(!name||name.length>40||/[\u0000-\u001f\u007f]/.test(name))throw new Problem('Enter a display name between 1 and 40 characters.');return name}
async function bodyOf(req){if(Number(req.headers.get('Content-Length'))>60000)throw new Problem('Request too large.',413);const text=await req.text();if(text.length>60000)throw new Problem('Request too large.',413);try{const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))throw 0;return body}catch{throw new Problem('Invalid JSON request.')}}
async function read(bucket,key){const object=await bucket.get(key);return object?object.json():null}
async function save(bucket,key,value){const text=JSON.stringify(value);await bucket.put(key,text,new TextEncoder().encode(text).length<1800?{customMetadata:{value:text}}:{})}
function listedValue(object){const value=object.customMetadata?.value||object.customMetadata?.event;return value?JSON.parse(value):null}
async function listValues(bucket,prefix){let cursor,values=[];do{const page=await bucket.list({prefix,cursor,limit:200,include:['customMetadata']});values.push(...await Promise.all(page.objects.map(o=>listedValue(o)||read(bucket,o.key))));cursor=page.truncated?page.cursor:undefined}while(cursor);return values.filter(Boolean)}
const cookieName=id=>'fs_'+id;
async function guestColor(env,id){const state=await changeCollaboration(env.DB,'rooms/'+id+'/identity/colors',s=>{s.colorIndex=s.nextColorIndex||0;s.nextColorIndex=s.colorIndex+1;});const palette=['#63d5ff','#ffad66','#cf9bff','#70e0ad','#ff8cae','#ead966','#8baaff','#efabdf','#a6dc73','#79ddd5','#eaa480','#b9adff'];if(state.colorIndex<palette.length)return palette[state.colorIndex];const hue=(state.colorIndex*137.508)%360;const channel=n=>{const k=(n+hue/30)%12;return Math.round((.66-.28*Math.max(-1,Math.min(k-3,9-k,1)))*255).toString(16).padStart(2,'0')};return '#'+channel(0)+channel(8)+channel(4);}
async function guestSession(req,env,id){const cookie=(req.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(id)+'='));const token=cookie?.slice(cookieName(id).length+1);if(!/^[a-f0-9]{64}$/.test(token||''))return null;const guest=await read(env.BUCKET,`rooms/${id}/sessions/${token}`);if(guest?.expires>Date.now()&&!guest.color){guest.color=await guestColor(env,id);await save(env.BUCKET,`rooms/${id}/sessions/${token}`,guest);}return guest?.expires>Date.now()?{...guest,key:`rooms/${id}/sessions/${token}`}:null}
async function join(req,env,id,name,status=200){const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');const guest={name,color:await guestColor(env,id),clientId:crypto.randomUUID(),expires:Date.now()+7*86400000};await save(env.BUCKET,`rooms/${id}/sessions/${token}`,guest);return json({id,joined:true,name,color:guest.color,clientId:guest.clientId},status,{'Set-Cookie':`${cookieName(id)}=${token}; Path=/api/rooms/${id}; HttpOnly; SameSite=Lax; Max-Age=604800${new URL(req.url).protocol==='https:'?'; Secure':''}`})}
function method(req,...allowed){if(!allowed.includes(req.method))throw new Problem('Method not allowed.',405)}
async function targetEvent(bucket,prefix,target,type){if(typeof target!=='string'||!target.startsWith(prefix+'events/')||target.includes('..'))throw new Problem('Invalid annotation.');const event=await read(bucket,target);if(!event||event.type!==type)throw new Problem('Annotation not found.',404);return event}
function eventTime(event){if(!Number.isFinite(event.time)||event.time<0||event.time>864000)throw new Problem('Invalid frame time.')}
function requestedRange(header,size){
 const match=/^bytes=(\d*)-(\d*)$/.exec(header||'');
 if(!match||(!match[1]&&!match[2]))return null;
 let start,end;
 if(!match[1]){const suffix=Number(match[2]);if(!suffix)return null;start=Math.max(0,size-suffix);end=size-1}
 else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return null;
 return {offset:start,length:end-start+1};
}

async function roomAssets(bucket,db,prefix){
 const [items,current,records]=await Promise.all([listValues(bucket,prefix+'assets/'),read(bucket,prefix+'asset'),db.prepare('SELECT key,value FROM collaboration_state WHERE key >= ? AND key < ?').bind(prefix+'catalog/',prefix+'catalog0').all()]);
 const values=new Map(records.results.map(r=>[r.key,JSON.parse(r.value)])),unique=new Map(items.map(a=>[a.id,a]));if(current)unique.set(current.id,current);
 const ordered=values.get(prefix+'catalog/order')?.ids||[],fallback=[...unique.values()].sort((a,b)=>(b.created||0)-(a.created||0));
 return fallback.map((a,index)=>{const version=values.get(prefix+'catalog/version/'+a.id),shotId=version?.shotId||a.id,shot=values.get(prefix+'catalog/shot/'+shotId);const readable=readableName(a,index);return {...a,displayName:readable,shotId,shotName:shot?.name||readableName(unique.get(shotId)||a,index),versionLabel:version?.label||'v1',reviewStatus:version?.status||'needs-review',reviewedBy:version?.reviewedBy||null,reviewedAt:version?.reviewedAt||null,shotOrder:ordered.includes(shotId)?ordered.indexOf(shotId):ordered.length+fallback.findIndex(x=>(values.get(prefix+'catalog/version/'+x.id)?.shotId||x.id)===shotId)};}).sort((a,b)=>a.shotOrder-b.shotOrder||(b.created||0)-(a.created||0)||a.id.localeCompare(b.id));
}
function readableName(asset,index=0){const name=asset?.name||'';return !name||/^Media$/i.test(name)||/^[a-f0-9]{8}-[a-f0-9-]{27}\.[a-z0-9]+$/i.test(name)?(asset?.type.startsWith('image')?'Image':'Clip')+' · '+(asset?.created?new Date(asset.created).toISOString().slice(0,16).replace('T',' '):'Upload '+(index+1)):name;}
async function catalogPatch(db,key,patch){return changeCollaboration(db,key,s=>Object.assign(s,patch));}
async function catalogSave(db,key,value){await db.prepare('INSERT INTO collaboration_state (key,value,version) VALUES (?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run();}
function labelOf(value,fallback,max){const result=typeof value==='string'?value.trim():fallback;if(!result||result.length>max||/[\u0000-\u001f\u007f]/.test(result))throw new Problem('Enter a valid name (up to '+max+' characters).');return result;}

export default {async fetch(req,env){try{
 const url=new URL(req.url),parts=url.pathname.split('/').filter(Boolean),bucket=env.BUCKET;
 if(parts[0]!=='api')return new Response(HTML,{headers:{...SECURITY,'Content-Type':'text/html; charset=utf-8'}});
 if(parts[1]!=='rooms')throw new Problem('Not found.',404);
 if(!['GET','HEAD'].includes(req.method)&&req.headers.get('Origin')&&req.headers.get('Origin')!==url.origin)throw new Problem('Use this room from its invite link.',403);
 if(parts.length===2){method(req,'POST');const body=await bodyOf(req),name=nameOf(body),id=crypto.randomUUID();await save(bucket,`rooms/${id}/meta`,{title:String(body.title||'Untitled review').trim().slice(0,120)||'Untitled review',created:Date.now()});return join(req,env,id,name,201)}
 const id=parts[2];if(!UUID.test(id||''))throw new Problem('Invalid room.');
 const prefix=`rooms/${id}/`,meta=await read(bucket,prefix+'meta');if(!meta)throw new Problem('Room not found.',404);
 if(parts[3]==='join'&&parts.length===4){method(req,'POST');return join(req,env,id,nameOf(await bodyOf(req)))}
 const guest=await guestSession(req,env,id);
 if(parts[3]==='session'&&parts.length===4){method(req,'GET','POST');if(req.method==='POST'){if(!guest)throw new Problem('Join this review first.',401);guest.name=nameOf(await bodyOf(req));const {key,...saved}=guest;await save(bucket,key,saved)}return json(guest?{joined:true,name:guest.name,color:guest.color,clientId:guest.clientId}:{joined:false})}
 if(!guest)throw new Problem('Enter your name to join this private review.',401);
 if(parts.length===3){method(req,'GET','POST');if(req.method==='POST'){const body=await bodyOf(req);meta.title=labelOf(body.title,'',120);meta.updated=Date.now();await save(bucket,prefix+'meta',meta)}return json(meta)}

 // Live transport never scans saved comments/sketches. Presence overwrites one
 // small record per guest, rather than growing the annotation history forever.
 if(parts[3]==='stream'&&parts.length===4){
  method(req,'GET');const encoder=new TextEncoder();let stopped=false,timer;
  const stream=new ReadableStream({start(controller){let ticks=0;const tick=async()=>{try{if(stopped||req.signal.aborted){controller.close();return;}
   const result=await env.DB.prepare('SELECT key,value FROM collaboration_state WHERE key IN (?,?)').bind(prefix+'live/control',prefix+'live/annotations').all();const values=new Map(result.results.map(r=>[r.key,JSON.parse(r.value)]));
   const control=collaborationView(values.get(prefix+'live/control')),gestures=await readGestures(env.DB,prefix);
   if(stopped)return;controller.enqueue(encoder.encode('data: '+JSON.stringify({control,gestures,revision:values.get(prefix+'live/annotations'),serverTime:Date.now()})+'\n\n'));
   if(++ticks>=8){controller.close();return;}timer=setTimeout(tick,200);
  }catch{if(!stopped){try{controller.close()}catch{}}}};controller.enqueue(encoder.encode('retry: 100\n\n'));tick();},cancel(){stopped=true;clearTimeout(timer)}});
  return new Response(stream,{headers:{...SECURITY,'Content-Type':'text/event-stream','X-Accel-Buffering':'no'}});
 }
 if(parts[3]==='control'&&parts.length===4){
  method(req,'POST');const b=await bodyOf(req);if(!UUID.test(b.connection||''))throw new Problem('Invalid connection.');
  const owner=guest.clientId+':'+b.connection;
  const state=await changeCollaboration(env.DB,prefix+'live/control',async s=>{
   const now=Date.now(),mine=s.presenter?.owner===owner;
   if(b.action==='claim'){
    if(!s.presenter){s.term++;s.presenter={owner,name:guest.name,expires:now+LEASE_MS};s.requests=[];s.sequence=0;}
    else if(!mine){s.requests=s.requests.filter(r=>r.owner!==owner);s.requests.push({owner,name:guest.name,at:now});s.requests=s.requests.slice(-10);}
   }else if(b.action==='cancel'){s.requests=s.requests.filter(r=>r.owner!==owner);}
   else if(b.action==='release'||b.action==='handoff'||b.action==='deny'){
    if(!mine||b.term!==s.term)throw new Problem('Presenter control has changed.',409);
    const target=s.requests.find(r=>r.owner===b.target);
    if(b.action==='handoff'&&!target)throw new Problem('That request expired.',409);
    if(b.action==='deny'){s.requests=s.requests.filter(r=>r.owner!==b.target);return;}
    if(s.playback){const point=projectedSequence(s.playback,now);s.playback.time=playbackTimeAt(s.playback,now);if(point){s.playback.asset=point.asset;s.playback.playlist.position=point.position;}s.playback.playing=false;s.playback.at=now;s.playback.id=crypto.randomUUID();}
    s.term++;s.sequence=0;s.presenter=b.action==='handoff'?{owner:target.owner,name:target.name,expires:now+LEASE_MS}:null;s.requests=[];
   }else if(b.action==='playback'){
    if(!mine||b.term!==s.term)throw new Problem('You no longer lead this review.',409);
    if(!Number.isSafeInteger(b.sequence)||b.sequence<=s.sequence)return;
    eventTime(b);if(typeof b.playing!=='boolean')throw new Problem('Invalid playback state.');
    const active=await read(bucket,prefix+'asset');let playlist=null;if(b.playlist){const items=await roomAssets(bucket,env.DB,prefix),list=b.playlist.items;if(!Array.isArray(list)||!list.length||list.length>30)throw new Problem('Choose 1 to 30 video shots.');const shots=new Set();for(const entry of list){const item=items.find(a=>a.id===entry.id);if(!item?.type.startsWith('video')||shots.has(item.shotId)||!Number.isFinite(entry.duration)||entry.duration<=0||entry.duration>86400||![24,25,30,60].includes(entry.fps))throw new Problem('Invalid sequence shot.');if((entry.in!==undefined||entry.out!==undefined)&&b.playlist.editVersion!==1)throw new Problem('Refresh this window to present an edited sequence.',409);const last=Math.max(0,Math.ceil(entry.duration*entry.fps-.000001)-1);if((entry.in!==undefined&&(!Number.isSafeInteger(entry.in)||entry.in<0||entry.in>last))||(entry.out!==undefined&&(!Number.isSafeInteger(entry.out)||entry.out<(entry.in||0)||entry.out>last)))throw new Problem('Invalid sequence trim.');shots.add(item.shotId);}const total=list.reduce((n,e)=>n+sequenceBounds(e).span,0);if(!Number.isFinite(b.playlist.position)||b.playlist.position<0||b.playlist.position>total||typeof b.playlist.loop!=='boolean'||!list.some(e=>e.id===b.asset))throw new Problem('Invalid sequence position.');playlist={...(b.playlist.editVersion===1?{editVersion:1}:{}),items:list.map(e=>({id:e.id,duration:e.duration,fps:e.fps,...(e.in!==undefined?{in:e.in}:{}),...(e.out!==undefined?{out:e.out}:{})})),position:b.playlist.position,loop:b.playlist.loop};}if(!playlist&&active?.id!==b.asset)throw new Problem('Shared media changed.',409);
    let comparison=null;
    if(b.comparison&&b.comparison.mode!=='off'){const items=await roomAssets(bucket,env.DB,prefix),a=items.find(a=>a.id===b.asset),reference=items.find(a=>a.id===b.comparison.asset);if(!reference||reference.id===a?.id||reference.shotId!==a?.shotId||reference.type.split('/')[0]!==a?.type.split('/')[0]||!['side','wipe'].includes(b.comparison.mode))throw new Problem('Compare two versions of the same shot.');comparison={asset:reference.id,mode:b.comparison.mode,offset:Math.max(-864000,Math.min(864000,Number.isFinite(Number(b.comparison.offset))?Number(b.comparison.offset):0)),y:Math.max(0,Math.min(100,Number.isFinite(Number(b.comparison.y))?Number(b.comparison.y):50)),angle:Math.max(-90,Math.min(90,Number.isFinite(Number(b.comparison.angle))?Number(b.comparison.angle):0)),wipe:Math.max(0,Math.min(100,Number.isFinite(Number(b.comparison.wipe))?Number(b.comparison.wipe):50))};}
    let range=b.range===undefined&&s.playback?.asset===b.asset?s.playback.range||null:b.range??null;
    if(range!==null){if(active.type.split('/')[0]!=='video'||!Number.isSafeInteger(range.in)||!Number.isSafeInteger(range.out)||range.in<0||range.out<range.in||range.out>51840000||![24,25,30,60].includes(range.fps)||typeof range.loop!=='boolean')throw new Problem('Invalid playback range.');range={in:range.in,out:range.out,fps:range.fps,loop:range.loop};}
    s.sequence=b.sequence;s.presenter.expires=now+LEASE_MS;s.playback={playlist,range:playlist?null:range,comparison:playlist?null:comparison,type:'playhead',asset:b.asset,time:b.time,playing:b.playing,rate:Math.max(.25,Math.min(2,Number(b.rate)||1)),name:guest.name,client:guest.clientId,at:now,id:crypto.randomUUID()};
   }else throw new Problem('Invalid presenter action.');
  });return json({control:state,serverTime:Date.now()});
 }
 if(parts[3]==='cursor'&&parts.length===4){
  method(req,'POST');const b=await bodyOf(req);if(!UUID.test(b.connection||'')||!Number.isSafeInteger(b.sequence)||b.sequence<1||typeof b.visible!=='boolean')throw new Problem('Invalid cursor.');
  if(b.visible&&(!UUID.test(b.asset||'')||![b.x,b.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))throw new Problem('Invalid cursor position.');
  await saveGesture(env.DB,prefix+'live/cursors/'+guest.clientId+':'+b.connection,prefix,{kind:'cursor',asset:b.asset,x:b.x,y:b.y,name:guest.name,color:guest.color,client:guest.clientId,owner:guest.clientId+':'+b.connection,sequence:b.sequence,expires:b.visible?Date.now()+8000:0});return json({ok:true});
 }
 if(parts[3]==='gesture'&&parts.length===4){
  method(req,'POST');const b=await bodyOf(req);if(!UUID.test(b.connection||'')||!UUID.test(b.strokeId||'')||!['laser','preview','clear'].includes(b.kind))throw new Problem('Invalid gesture.');
  if(b.kind!=='clear'){eventTime(b);if(!UUID.test(b.asset||'')||!Array.isArray(b.points)||b.points.length<1||b.points.length>1500||!b.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=1))||!/^#[a-f0-9]{6}$/i.test(b.color)||!['pen','arrow','rectangle','laser'].includes(b.tool))throw new Problem('Invalid gesture.');}
  const key=prefix+'live/gestures/'+guest.clientId+':'+b.connection;
  if(!Number.isSafeInteger(b.sequence)||b.sequence<1)throw new Problem('Invalid gesture sequence.');
  await saveGesture(env.DB,key,prefix,{...b,color:b.kind==='laser'?guest.color:b.color,identityColor:guest.color,name:guest.name,client:guest.clientId,owner:guest.clientId+':'+b.connection,width:Math.max(1,Math.min(12,Number(b.width)||3)),expires:Date.now()+(b.kind==='laser'?1500:b.kind==='clear'?0:5000)});if(Math.random()<.02)await env.DB.prepare('DELETE FROM collaboration_gestures WHERE expires < ?').bind(Date.now()-60000).run();return json({ok:true});
 }
 if(parts[3]==='live'&&parts.length===4){method(req,'GET');const [media,legacy,people,raw,gestures]=await Promise.all([read(bucket,prefix+'asset'),read(bucket,prefix+'live/playback'),listValues(bucket,prefix+'live/people/'),readControl(env.DB,prefix+'live/control'),readGestures(env.DB,prefix)]);const control=collaborationView(raw);let playback=raw?control.playback:legacy;if(!playback?.playlist&&playback?.asset!==media?.id)playback=legacy;return json({review:{title:meta.title,updated:meta.updated||meta.created||0},media,playback,control,gestures:gestures.filter(g=>g.expires>Date.now()&&g.kind!=='clear'),people:people.filter(p=>Date.now()-p.at<45000),serverTime:Date.now()})}
 if(parts[3]==='attachments'&&parts.length===5){
  method(req,'GET','POST');const attachmentId=parts[4];if(!UUID.test(attachmentId))throw new Problem('Invalid attachment.');const key=prefix+'attachments/'+attachmentId,info=await read(bucket,key+'/meta');
  if(req.method==='GET'){if(!info?.ready)throw new Problem('Attachment not found.',404);const object=await bucket.get(key+'/image');if(!object)throw new Problem('Attachment not found.',404);return new Response(object.body,{headers:{...SECURITY,'Content-Type':info.type,'Cache-Control':'private, max-age=86400','Content-Disposition':'inline'}});}
  const assetId=req.headers.get('X-Asset'),time=Number(req.headers.get('X-Frame-Time'));if(!UUID.test(assetId||'')||req.headers.get('X-Frame-Time')===null)throw new Problem('Choose a version and frame.');eventTime({time});
  let media=await read(bucket,prefix+'assets/'+assetId);if(!media){const current=await read(bucket,prefix+'asset');if(current?.id===assetId)media=current;}if(!media)throw new Problem('Media not found.',404);
  if(info){if(info.client!==guest.clientId||info.asset!==assetId||info.time!==time)throw new Problem('Attachment upload belongs to another note context.',403);if(info.ready)return json({attachment:info});}
  const type=req.headers.get('Content-Type')?.split(';')[0];if(!['image/png','image/jpeg','image/webp'].includes(type))throw new Problem('Use PNG, JPG or WebP images.',415);
  const bytes=await attachmentBytes(req);if(!validAttachment(bytes,type))throw new Problem('This file is not a valid PNG, JPG or WebP image.');
  let name='Reference image';try{name=decodeURIComponent(req.headers.get('X-File-Name')||name)}catch{}name=name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180)||'Reference image';
  const attachment={id:attachmentId,asset:assetId,time,name,type,size:bytes.length,client:guest.clientId};
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  const reserved={...attachment,digest,ready:false};const reservation=await bucket.put(key+'/meta',JSON.stringify(reserved),{onlyIf:new Headers({'If-None-Match':'*'})});
  if(!reservation){const previous=await read(bucket,key+'/meta');if(previous.client!==guest.clientId||previous.asset!==assetId||previous.time!==time||previous.digest!==digest)throw new Problem('Attachment upload already exists. Retry with a fresh upload.',409);}
  await bucket.put(key+'/image',bytes,{httpMetadata:{contentType:type},onlyIf:new Headers({'If-None-Match':'*'})});await save(bucket,key+'/meta',{...reserved,ready:true});return json({attachment});
 }
 if(parts[3]==='assets'&&parts.length===4){method(req,'GET');return json({assets:await roomAssets(bucket,env.DB,prefix)})}
 if(parts[3]==='review-status'&&parts.length===4){method(req,'POST');const b=await bodyOf(req);if(!['needs-review','changes-requested','approved'].includes(b.status))throw new Problem('Invalid review status.');const items=await roomAssets(bucket,env.DB,prefix),item=items.find(a=>a.id===b.asset);if(!item)throw new Problem('Media not found.',404);await catalogPatch(env.DB,prefix+'catalog/version/'+item.id,{status:b.status,reviewedBy:guest.name,reviewedAt:Date.now()});return json({ok:true});}
 if(parts[3]==='shot-order'&&parts.length===4){method(req,'POST');const b=await bodyOf(req),items=await roomAssets(bucket,env.DB,prefix),ids=[...new Set(items.map(a=>a.shotId))];if(!ids.includes(b.shotId)||!['up','down'].includes(b.direction))throw new Problem('Invalid shot move.');await changeCollaboration(env.DB,prefix+'catalog/order',s=>{const order=[...(s.ids||[]).filter(id=>ids.includes(id)),...ids.filter(id=>!s.ids?.includes(id))],from=order.indexOf(b.shotId),to=from+(b.direction==='up'?-1:1);if(to>=0&&to<order.length)[order[from],order[to]]=[order[to],order[from]];s.ids=order;});return json({ok:true});}
 if(parts[3]==='thumbnails'&&parts.length===5){method(req,'GET','POST');const mediaId=parts[4];if(!UUID.test(mediaId))throw new Problem('Invalid media.');let asset=await read(bucket,prefix+'assets/'+mediaId);if(!asset){const current=await read(bucket,prefix+'asset');if(current?.id===mediaId)asset=current;}if(!asset)throw new Problem('Media not found.',404);const key=prefix+'thumbnails/'+mediaId;if(req.method==='POST'){if(req.headers.get('Content-Type')!=='image/jpeg')throw new Problem('Use a JPEG thumbnail.',415);if(Number(req.headers.get('Content-Length'))>150000)throw new Problem('Thumbnail too large.',413);const bytes=new Uint8Array(await req.arrayBuffer());if(bytes.length>150000)throw new Problem('Thumbnail too large.',413);if(bytes.length<4||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new Problem('Invalid JPEG thumbnail.');if(!(await bucket.get(key)))await bucket.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'},onlyIf:new Headers({'If-None-Match':'*'})});return json({ok:true});}const object=await bucket.get(key);if(!object)throw new Problem('Thumbnail not generated yet.',404);return new Response(object.body,{headers:{...SECURITY,'Content-Type':'image/jpeg','Cache-Control':'private, max-age=86400'}});}
 if(parts[3]==='versions'&&parts.length===4){
  method(req,'POST');const b=await bodyOf(req),items=await roomAssets(bucket,env.DB,prefix),item=items.find(a=>a.id===b.asset);if(!item)throw new Problem('Media not found.',404);
  const shotId=b.shotId||crypto.randomUUID();if(!UUID.test(shotId)||b.shotId&&!items.some(a=>a.shotId===shotId))throw new Problem('Shot group not found.',404);
  const name=labelOf(b.shotName,item.shotName,120),label=labelOf(b.versionLabel,item.versionLabel,40);
  await catalogPatch(env.DB,prefix+'catalog/shot/'+shotId,{name});await catalogPatch(env.DB,prefix+'catalog/version/'+item.id,{shotId,label});return json({ok:true});
 }


 if(parts[3]==='events'&&parts.length===4){method(req,'GET','POST');if(req.method==='POST'){
  const event=await bodyOf(req);if(event.requestId!==undefined&&!UUID.test(event.requestId))throw new Problem('Invalid retry identifier.');if(!['comment','stroke','playhead','presence','resolve','stroke-hide','stroke-edit','comment-edit'].includes(event.type))throw new Problem('Invalid event.');
  if(['comment','stroke','playhead'].includes(event.type))eventTime(event);
  if(event.asset!==undefined&&!UUID.test(event.asset))throw new Problem('Invalid media reference.');
  if(event.type==='comment'&&event.parent){const parent=await targetEvent(bucket,prefix,event.parent,'comment');if(parent.parent||parent.asset!==event.asset)throw new Problem('Reply to a thread in this media item.')}
  if(event.type==='comment-edit'){const target=await targetEvent(bucket,prefix,event.target,'comment');if(target.client!==guest.clientId)throw new Problem('You can edit only your own comments.',403);event.asset=target.asset}
  if(event.type==='comment'||event.type==='comment-edit'){
   const target=event.type==='comment-edit'?await targetEvent(bucket,prefix,event.target,'comment'):null;
   if(target)event.time=target.time;
   if(event.attachments!==undefined){
    if(!Array.isArray(event.attachments)||event.attachments.length>5)throw new Problem('Attach up to 5 images per note.');
    const ids=event.attachments.map(a=>typeof a==='string'?a:a?.id);if(new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id||'')))throw new Problem('Invalid image attachment.');
    event.attachments=await Promise.all(ids.map(async id=>{const image=await read(bucket,prefix+'attachments/'+id+'/meta');if(!image?.ready)throw new Problem('Attachment not found or still uploading.',404);if(image.client!==guest.clientId)throw new Problem('Attach only images you uploaded.',403);if(image.asset!==event.asset||Math.abs(image.time-event.time)>.000001)throw new Problem('Attachments must stay on their original version and frame.');return {id:image.id,name:image.name,type:image.type,size:image.size};}));
   }
   const hasImages=event.attachments!==undefined?event.attachments.length:target?.attachments?.length;
   if(typeof event.text!=='string'||(!event.text.trim()&&!hasImages)||event.text.length>4000)throw new Problem('Write a comment or attach an image (up to 4000 characters).');event.text=event.text.trim();
  }
  if(event.type==='stroke'){
   if(!Array.isArray(event.points)||event.points.length<2||event.points.length>1500||!event.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=1))||!/^#[a-f0-9]{6}$/i.test(event.color))throw new Problem('Invalid drawing.');
   if(event.tool&&!['pen','arrow','rectangle'].includes(event.tool))throw new Problem('Invalid drawing tool.');event.width=Math.max(1,Math.min(12,Number(event.width)||3));
  }
  if(event.type==='stroke-edit'){const target=await targetEvent(bucket,prefix,event.target,'stroke');if(target.client!==guest.clientId)throw new Problem('You can edit only your own drawings.',403);if(!Array.isArray(event.points)||event.points.length<2||event.points.length>1500||!event.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&n>=0&&n<=1)))throw new Problem('Invalid drawing edit.');event.asset=target.asset;event.time=target.time;}
  if(event.type==='stroke-hide'){const target=await targetEvent(bucket,prefix,event.target,'stroke');if(target.client!==guest.clientId)throw new Problem('You can undo only your own drawings.',403);if(typeof event.hidden!=='boolean')throw new Problem('Invalid drawing change.');event.asset=target.asset}
  if(event.type==='resolve'){const target=await targetEvent(bucket,prefix,event.target,'comment');if(typeof event.resolved!=='boolean')throw new Problem('Invalid note status.');event.asset=target.asset}
  if(event.type==='playhead'){if(await readControl(env.DB,prefix+'live/control'))throw new Problem('Update your browser to use presenter control.',409);if(typeof event.playing!=='boolean')throw new Problem('Invalid playback state.');const active=await read(bucket,prefix+'asset');if(active&&event.asset!==active.id)throw new Problem('The shared media changed. Refresh before presenting.',409);event.rate=Math.max(.25,Math.min(2,Number(event.rate)||1))}
  const key=prefix+'events/'+(event.requestId?'retry-'+guest.clientId+'-'+event.requestId:Date.now()+'-'+crypto.randomUUID()),saved={...event,identityColor:guest.color,name:guest.name,client:guest.clientId,at:Date.now(),id:key};
  if(event.requestId){const previous=await read(bucket,key);if(previous)return json({ok:true,event:previous});}
  if(event.type==='presence')await save(bucket,prefix+'live/people/'+guest.clientId,saved);
  else if(event.type==='playhead')await save(bucket,prefix+'live/playback',saved);
  else if(event.requestId){const result=await bucket.put(key,JSON.stringify(saved),{onlyIf:new Headers({'If-None-Match':'*'})});if(!result)return json({ok:true,event:await read(bucket,key)});}else await save(bucket,key,saved);
  if(!['presence','playhead'].includes(event.type))await env.DB.prepare('INSERT INTO collaboration_state (key,value,version) VALUES (?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(prefix+'live/annotations',JSON.stringify(crypto.randomUUID())).run();
  return json({ok:true,event:saved});
 }
 const watermark=Date.now(),since=Number(url.searchParams.get('since'))||0;
 const page=await bucket.list({prefix:prefix+'events/',cursor:url.searchParams.get('cursor')||undefined,limit:since?500:50,include:['customMetadata']});
 const recent=page.objects.filter(o=>!since||!o.uploaded||new Date(o.uploaded).getTime()>=since);
 const events=await Promise.all(recent.map(async o=>listedValue(o)||read(bucket,o.key)));
 return json({events:events.filter(Boolean),cursor:page.truncated?page.cursor:null,watermark});
 }

 if(parts[3]==='media'){
  if(parts[4]==='select'&&parts.length===5){method(req,'POST');const body=await bodyOf(req);if(!UUID.test(body.id||''))throw new Problem('Invalid media.');let asset=await read(bucket,prefix+'assets/'+body.id);if(!asset){const current=await read(bucket,prefix+'asset');if(current?.id===body.id)asset=current}if(!asset)throw new Problem('Media not found.',404);await save(bucket,prefix+'asset',asset);await save(bucket,prefix+'live/playback',{type:'playhead',asset:asset.id,time:0,playing:false,rate:1,name:guest.name,client:guest.clientId,at:Date.now(),id:crypto.randomUUID()});return json({ok:true,asset})}
  if(parts.length===4&&req.method==='POST'){
   const revisionOf=req.headers.get('X-Version-Of');let revisionBase,revisionItems;if(revisionOf){revisionItems=await roomAssets(bucket,env.DB,prefix);revisionBase=revisionItems.find(a=>a.id===revisionOf);if(!revisionBase)throw new Problem('Original version not found.',404);}
   const type=req.headers.get('Content-Type')||'';if(!/^(video\/(mp4|webm|quicktime)|image\/(png|jpeg|webp|gif))$/.test(type))throw new Problem('Choose an MP4, WebM, MOV, PNG, JPG, WebP, or GIF file.',415);
   const length=Number(req.headers.get('Content-Length'));if(length>MAX_UPLOAD)throw new Problem('Maximum file size is 80 MB.',413);
   if(length<0||!Number.isFinite(length))throw new Problem('Invalid upload length.');
   let name=req.headers.get('X-File-Name')||'Media';try{name=decodeURIComponent(name)}catch{}name=name.slice(0,200);
   const mediaId=crypto.randomUUID();let size;
   // Re-establish the native length lost when the hosting proxy wraps a request.
   // Streaming known-size uploads keeps the 80 MB limit below Worker memory limits.
   if(length>0&&Number.isSafeInteger(length)&&typeof FixedLengthStream!=='undefined'){
    const stream=new FixedLengthStream(length);await Promise.all([bucket.put(prefix+'media/'+mediaId,stream.readable,{httpMetadata:{contentType:type}}),req.body.pipeTo(stream.writable)]);size=length;
   }else{
    const bytes=await req.arrayBuffer();if(!bytes.byteLength)throw new Problem('The file is empty.');if(bytes.byteLength>MAX_UPLOAD)throw new Problem('Maximum file size is 80 MB.',413);size=bytes.byteLength;await bucket.put(prefix+'media/'+mediaId,bytes,{httpMetadata:{contentType:type}});
   }
   const asset={id:mediaId,type,name,size,created:Date.now()};
   const previous=await read(bucket,prefix+'asset');if(previous)await save(bucket,prefix+'assets/'+previous.id,previous);
   await save(bucket,prefix+'assets/'+mediaId,asset);if(revisionBase)await catalogSave(env.DB,prefix+'catalog/version/'+mediaId,{shotId:revisionBase.shotId,label:'v'+(revisionItems.filter(a=>a.shotId===revisionBase.shotId).length+1)});await save(bucket,prefix+'asset',asset);
   await save(bucket,prefix+'live/playback',{type:'playhead',asset:mediaId,time:0,playing:false,rate:1,name:guest.name,client:guest.clientId,at:Date.now(),id:crypto.randomUUID()});return json({ok:true,asset});
  }
  method(req,'GET','HEAD');
  if(parts.length===5){
   if(!UUID.test(parts[4]))throw new Problem('Invalid media.');const key=prefix+'media/'+parts[4];
   const info=typeof bucket.head==='function'?await bucket.head(key):await bucket.get(key);if(!info)throw new Problem('Media not found.',404);
   const headers=new Headers({...SECURITY,'Accept-Ranges':'bytes'});info.writeHttpMetadata(headers);
   let range;if(req.headers.has('Range')){range=requestedRange(req.headers.get('Range'),info.size);if(!range){headers.set('Content-Range','bytes */'+info.size);return new Response(null,{status:416,headers})}headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${info.size}`)}
   if(Number.isFinite(info.size))headers.set('Content-Length',String(range?range.length:info.size));
   const object=req.method==='HEAD'?null:await bucket.get(key,range?{range}:undefined);
   return new Response(object?.body||null,{status:range?206:200,headers});
  }
  if(parts.length===4)return json(await read(bucket,prefix+'asset'));
 }
 throw new Problem('Not found.',404);
 }catch(error){if(error instanceof Problem||error.status)return json({error:error.message},error.status);console.error('Review request failed',error.message,error.stack);return json({error:'Request failed. Please try again.'},500)}}};
