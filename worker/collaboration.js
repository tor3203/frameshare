// Shared authority lives in D1, never in one Worker isolate's memory.
export const LEASE_MS = 15000;
export function sequencePoint(items,position,loop=false){
 const total=items.reduce((n,e)=>n+sequenceBounds(e).span,0),tail=items.at(-1);let p=Math.max(0,Number(position)||0);p=loop&&total?p%total:Math.min(p,Math.max(0,total-Math.min(tail?sequenceBounds(tail).span:0,1/(tail?.fps||24))));let start=0;
 for(let index=0;index<items.length;index++){const e=items[index],b=sequenceBounds(e);if(p<start+b.span||index===items.length-1)return {index,asset:e.id,time:b.start+Math.max(0,p-start),position:p,total};start+=b.span;}return null;
}
export function sequenceBounds(item){
 const rate=item.fps||24,last=Math.max(0,Math.ceil(item.duration*rate-.000001)-1),first=Math.max(0,Math.min(last,Number.isInteger(item.in)?item.in:0)),out=Math.max(first,Math.min(last,Number.isInteger(item.out)?item.out:last));
 const start=first/rate,end=Math.min(item.duration,(out+1)/rate);return {in:first,out,start,end,span:end-start};
}
export function projectedSequence(playback,now){const list=playback?.playlist;if(!list?.items?.length)return null;return sequencePoint(list.items,list.position+(playback.playing?Math.max(0,now-playback.at)/1000*(playback.rate||1):0),list.loop);}
export function playbackTimeAt(playback,now) {
  const sequence=projectedSequence(playback,now);if(sequence)return sequence.time;
  if(!playback?.playing)return playback?.time||0;
  const time=playback.time+Math.max(0,now-playback.at)/1000*(playback.rate||1),r=playback.range;
  if(!r)return time;
  const start=r.in/r.fps,end=(r.out+1)/r.fps;
  if(time<end)return Math.max(start,time);
  if(!r.loop)return r.out/r.fps;
  const span=end-start,phase=(time-start)%span;
  return start+(phase>=span-.0000001?0:phase);
}
export function collaborationView(state, now = Date.now()) {
  if (!state) return {version:0,term:0,presenter:null,requests:[]};
  state = structuredClone(state);
  if (state.presenter && state.presenter.expires <= now) {
    if (state.playback?.playing) {const point=projectedSequence(state.playback,state.presenter.expires);state.playback.time=playbackTimeAt(state.playback,state.presenter.expires);if(point){state.playback.asset=point.asset;state.playback.playlist.position=point.position;}state.playback.playing=false;state.playback.at=state.presenter.expires;state.playback.id += ':expired';}
    state.presenter=null;
  }
  state.requests=(state.requests||[]).filter(r=>now-r.at<30000);
  return state;
}
export async function readControl(db,key){const row=await db.prepare('SELECT value FROM collaboration_state WHERE key = ?').bind(key).first();return row?JSON.parse(row.value):null;}
export async function readGestures(db,room){const result=await db.prepare('SELECT value FROM collaboration_gestures WHERE room = ? AND expires > ?').bind(room,Date.now()).all();return result.results.map(r=>JSON.parse(r.value));}
export async function saveGesture(db,key,room,value){await db.prepare('INSERT INTO collaboration_gestures (key,room,value,sequence,expires) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, sequence=excluded.sequence, expires=excluded.expires WHERE excluded.sequence > collaboration_gestures.sequence').bind(key,room,JSON.stringify(value),value.sequence,value.expires).run();}
export async function changeCollaboration(database,key,change) {
 const db=database.withSession?database.withSession('first-primary'):database;
 for(let attempt=0;attempt<12;attempt++){
  const row=await db.prepare('SELECT value,version FROM collaboration_state WHERE key = ?').bind(key).first();
  const state=collaborationView(row?JSON.parse(row.value):null);await change(state);state.version=(Number(state.version)||0)+1;state.updated=Date.now();
  if(!row){const created=await db.prepare('INSERT INTO collaboration_state (key,value,version) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING RETURNING key').bind(key,JSON.stringify(state),state.version).first();if(created)return state;}
  else {const saved=await db.prepare('UPDATE collaboration_state SET value = ?, version = ? WHERE key = ? AND version = ? RETURNING key').bind(JSON.stringify(state),state.version,key,row.version).first();if(saved)return state;}
 }
 const error=new Error('Room is busy. Please try again.');error.status=409;throw error;
}
