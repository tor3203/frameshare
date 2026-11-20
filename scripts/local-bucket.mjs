import {readFile,writeFile,mkdir,readdir,rename,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Atomic object replacement mirrors R2: readers see a complete old or new value.
// Metadata is embedded with small JSON objects, keeping live-state writes coherent.
export async function localBucket(root){
 await mkdir(root,{recursive:true});
 const path=key=>root+'/'+encodeURIComponent(key);
 const locks=new Map();
 async function locked(key,action){const previous=locks.get(key)||Promise.resolve();const current=previous.catch(()=>{}).then(action);locks.set(key,current);try{return await current}finally{if(locks.get(key)===current)locks.delete(key)}}
 async function readObject(key){try{
  const file=await readFile(path(key));
  if(file.subarray(0,5).toString()==='FSR2\n'){
   const end=file.indexOf(10,5),meta=JSON.parse(file.subarray(5,end).toString());
   return {bytes:file.subarray(end+1),...meta};
  }
  // Preserve objects written by the original development adapter.
  let httpMetadata={};try{httpMetadata=JSON.parse(await readFile(path(key)+'.metadata','utf8'))}catch{}
  return {bytes:file,httpMetadata,customMetadata:{},uploaded:(await stat(path(key))).mtime.toISOString()};
 }catch(error){if(error.code==='ENOENT')return null;throw error}}
 const object=key=>locked(key,()=>readObject(key));
 const metadata=item=>({etag:item.etag||String(item.uploaded),size:item.bytes.length,uploaded:new Date(item.uploaded),customMetadata:item.customMetadata,writeHttpMetadata(headers){for(const [key,value] of Object.entries(item.httpMetadata||{})){if(key==='contentType')headers.set('Content-Type',value);else if(key==='cacheControl')headers.set('Cache-Control',value)}}});
 return {
  async put(key,body,options={}){return locked(key,async()=>{
   const bytes=Buffer.from(await new Response(body).arrayBuffer());
   const old=await readObject(key),condition=options.onlyIf;
   if(condition?.etagMatches && condition.etagMatches!==(old?.etag||String(old?.uploaded)))return null;
   if(condition?.get?.('If-None-Match')==='*' && old)return null;
   const meta={etag:randomUUID(),httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{},uploaded:new Date().toISOString()};
   const temp=path(key)+'.tmp-'+randomUUID();
   await writeFile(temp,Buffer.concat([Buffer.from('FSR2\n'+JSON.stringify(meta)+'\n'),bytes]));
   await rename(temp,path(key));
   return {key,...metadata({bytes,...meta})};});
  },
  async head(key){const item=await object(key);return item?{key,...metadata(item)}:null},
  async get(key,options={}){
   const item=await object(key);if(!item)return null;
   let body=item.bytes,range;
   if(options.range&&Number.isInteger(options.range.offset)){
    range={offset:options.range.offset,length:Math.min(options.range.length??item.bytes.length,item.bytes.length-options.range.offset)};
    body=body.subarray(range.offset,range.offset+range.length);
   }
   return {key,body,range,...metadata(item),json:async()=>JSON.parse(item.bytes)};
  },
  async list({prefix='',limit=500,cursor}){
   const keys=(await readdir(root)).filter(name=>!name.endsWith('.metadata')&&!name.includes('.tmp-')).map(decodeURIComponent).filter(key=>key.startsWith(prefix)).sort();
   const start=Number(cursor)||0,selected=keys.slice(start,start+limit);
   const objects=await Promise.all(selected.map(async key=>({key,...metadata(await object(key))})));
   return {objects,truncated:start+limit<keys.length,cursor:String(start+limit)};
  }
 };
}
