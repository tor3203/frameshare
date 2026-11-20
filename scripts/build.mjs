import {readFile,mkdir,writeFile,copyFile,cp,rm} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
const [layout,styles,app,library,editor,onion,ranges,attachments,sequence,sequenceEditor,sequenceCache]=await Promise.all(['web/studio.html','web/styles.css','web/app.js','web/library.js','web/editor.js','web/onion.js','web/ranges.js','web/attachments.js','web/sequence.js','web/sequence-editor.js','web/sequence-cache.js'].map(path=>readFile(path,'utf8')));
const html=layout.replace('/*APP_STYLES*/',()=>styles).replace('/*APP_SCRIPT*/',()=>app+'\n'+library+'\n'+editor+'\n'+onion+'\n'+ranges+'\n'+attachments+'\n'+sequence+'\n'+sequenceEditor+'\n'+sequenceCache);
await writeFile('dist/server/index.js',`const HTML=${JSON.stringify(html)};\n`+(await readFile('worker/collaboration.js','utf8')).replaceAll('export ','')+'\n'+(await readFile('worker/core.js','utf8')).replace(/^import .*collaboration.js';\r?\n/m,''));
try {
  await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await rm('dist/.openai/hosting.json', {force: true});
}

await cp('drizzle','dist/.openai/drizzle',{recursive:true});
