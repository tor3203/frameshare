import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {localBucket} from './local-bucket.mjs';

test('local storage reads complete records during concurrent replacements',async()=>{
 const root=resolve('.local');await mkdir(root,{recursive:true});const directory=await mkdtemp(root+sep+'atomic-test-');
 try{
  const bucket=await localBucket(directory);await bucket.put('state',JSON.stringify({version:0,payload:'x'.repeat(6000)}));
  await Promise.all(Array.from({length:30},async(_,version)=>{await bucket.put('state',JSON.stringify({version,payload:'y'.repeat(6000)}),{customMetadata:{value:'test'}});const value=await (await bucket.get('state')).json();assert.equal(value.payload.length,6000);assert.ok(Number.isInteger(value.version));}));
  const result=await bucket.list({prefix:'state'});assert.equal(result.objects.length,1);assert.equal(result.objects[0].customMetadata.value,'test');
 }finally{assert.ok(resolve(directory).startsWith(root+sep+'atomic-test-'));await rm(directory,{recursive:true,force:true});}
});
