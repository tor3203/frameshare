// Interactive test guest. Its room cookie stays in this process's memory only.
import readline from 'node:readline';
const base='https://frameshare-review-studio.observanthymn3.chatgpt.site/api/rooms/92f01209-98cd-4c82-ab53-f7bac16e5a52';
const joined=await fetch(base+'/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Assistant QA'})});
if(!joined.ok)throw Error('Could not join the test room.');
const cookie=joined.headers.getSetCookie().find(value=>value.startsWith('fs_')).split(';')[0];
async function request(path,options={}){const response=await fetch(base+path,{...options,headers:{Cookie:cookie,...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}
const post=event=>request('/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});
await post({type:'presence'});
const heartbeat=setInterval(()=>post({type:'presence'}).catch(()=>{}),15000);
heartbeat.unref();
console.log(JSON.stringify({ready:true,name:'Assistant QA'}));
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{const command=JSON.parse(line),state=await request('/live');
  if(command.action==='state'){
   const notes=await request('/events');
   console.log(JSON.stringify({action:'state',media:state.media?.name,playback:state.playback,people:state.people.map(person=>person.name),annotations:notes.events.filter(event=>!['presence','playhead'].includes(event.type))}));
  }else if(command.action==='comment'){
   const result=await post({type:'comment',asset:state.media.id,time:command.time??state.playback?.time??0,text:command.text,...(command.parent?{parent:command.parent}:{})});console.log(JSON.stringify({posted:true,event:result.event}));
  }else if(command.action==='draw'){
   const result=await post({type:'stroke',asset:state.media.id,time:command.time??state.playback?.time??0,tool:command.tool||'arrow',points:command.points||[[.2,.2],[.45,.4]],color:'#ff7070',width:4});console.log(JSON.stringify({drawn:true,event:result.event}));
  }else if(command.action==='exit'){clearInterval(heartbeat);break;}
  else throw Error('Unknown test command.');
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
clearInterval(heartbeat);
