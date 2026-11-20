import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
async function view(options){const source=await readFile('web/app.js','utf8'),start=source.indexOf('function reviewControlView('),end=source.indexOf('function renderReviewControls()',start),c=vm.createContext({options:{own:false,following:true,presenter:null,pending:false,sameGuest:false,busy:false,available:true,...options}});vm.runInContext(source.slice(start,end),c);return JSON.parse(vm.runInContext('JSON.stringify(reviewControlView(options))',c));}
test('a presenter has exactly one mode and no follow action even if the internal follow preference is set',async()=>{const v=await view({own:true,following:true,presenter:{name:'Host'}});assert.equal(v.status,'You’re presenting');assert.equal(v.lead,'Stop presenting');assert.equal(v.follow,null);assert.equal(v.mode,'presenting');});
test('following, local exploration and pending requests expose explicit distinct actions',async()=>{
 let v=await view({presenter:{name:'Alex'}});assert.equal(v.status,'Following Alex');assert.equal(v.lead,'Request control');assert.equal(v.follow,'Explore locally');
 v=await view({following:false,presenter:{name:'Alex'}});assert.equal(v.status,'Exploring locally');assert.equal(v.follow,'Resume following');
 v=await view({pending:true,presenter:{name:'Alex'}});assert.equal(v.status,'Control requested');assert.equal(v.disabled,true);
});
test('refresh and an expired previous session never claim presenter control in the UI',async()=>{
 let v=await view({sameGuest:true,presenter:{name:'Me'}});assert.equal(v.status,'Following your other session');assert.match(v.detail,/previous page/);assert.equal(v.lead,'Request control');
 v=await view({pending:true,presenter:null});assert.equal(v.status,'No presenter');assert.equal(v.lead,'Lead review');assert.equal(v.disabled,false,'an expired presenter cannot leave a pending request disabling Lead review');
 v=await view({following:false,presenter:null});assert.equal(v.follow,'Return to shared review');
});
