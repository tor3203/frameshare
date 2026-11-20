import {localDatabase} from './local-db.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {localBucket} from './local-bucket.mjs';
import worker from '../worker/index.js';
// A file-backed R2 adapter for local development. Hosted sessions use Cloudflare R2.
async function loadHTML(){const [layout,styles,app,library,editor,onion,ranges,attachments,sequence,sequenceEditor,sequenceCache]=await Promise.all(['web/studio.html','web/styles.css','web/app.js','web/library.js','web/editor.js','web/onion.js','web/ranges.js','web/attachments.js','web/sequence.js','web/sequence-editor.js','web/sequence-cache.js'].map(path=>readFile(path,'utf8')));return layout.replace('/*APP_STYLES*/',()=>styles).replace('/*APP_SCRIPT*/',()=>app+'\n'+library+'\n'+editor+'\n'+onion+'\n'+ranges+'\n'+attachments+'\n'+sequence+'\n'+sequenceEditor+'\n'+sequenceCache)}
globalThis.HTML=await loadHTML();
const bucket=await localBucket('.local/objects'),db=localDatabase('.local/collaboration.sqlite');
http.createServer(async(req,res)=>{try{globalThis.HTML=await loadHTML();const abort=new AbortController();res.on('close',()=>abort.abort());const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,signal:abort.signal,...(['GET','HEAD'].includes(req.method)?{}:{body:req,duplex:'half'})});const response=await worker.fetch(request,{BUCKET:bucket,DB:db});res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body){const reader=response.body.getReader();try{while(!abort.signal.aborted){const {done,value}=await reader.read();if(done)break;res.write(value);}}finally{await reader.cancel();}}res.end()}catch(e){res.writeHead(500);res.end(e.message)}}).listen(4173,'127.0.0.1',()=>console.log('Local: http://localhost:4173'));
