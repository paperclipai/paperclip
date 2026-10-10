import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {remoteProgram} from './remote-program.js';
const roots:string[]=[];
function fixture(){const temp=realpathSync(mkdtempSync(join(tmpdir(),'computer-files-')));roots.push(temp);const root=join(temp,'home');const call=(input:Record<string,unknown>)=>{const result=spawnSync('python3',['-c',remoteProgram.replaceAll('/home/user/paperclip/',`${temp}/`)],{input:JSON.stringify({...input,root}),encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return JSON.parse(result.stdout);};return {root,temp,call};}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('confined computer files',()=>{
 it('seeds absent home only and preserves existing content',()=>{const f=fixture();expect(f.call({action:'seed',files:{'nested/one':Buffer.from('first').toString('base64')}})).toEqual({seeded:true});expect(f.call({action:'seed',files:{'nested/one':Buffer.from('overwrite').toString('base64')}})).toEqual({seeded:false});expect(Buffer.from(f.call({action:'read',path:'nested/one'}).base64,'base64').toString()).toBe('first');});
 it('rejects traversal, symlink escapes, and oversized reads',()=>{const f=fixture();f.call({action:'seed',files:{'ok':Buffer.from('12345').toString('base64')}});mkdirSync(join(f.temp,'outside'));writeFileSync(join(f.temp,'outside','secret'),'private');symlinkSync(join(f.temp,'outside'),join(f.root,'escape'));expect(f.call({action:'read',path:'../outside/secret'})).toEqual({error:'invalid'});expect(f.call({action:'read',path:'escape/secret'})).toEqual({error:'invalid'});expect(f.call({action:'read',path:'ok',maxBytes:4})).toEqual({error:'invalid'});});
 it('rejects stale edits and uses no-clobber move semantics',()=>{const f=fixture();f.call({action:'seed',files:{}});const first=f.call({action:'write',path:'file',expectedSha256:null,base64:Buffer.from('one').toString('base64')});const second=f.call({action:'write',path:'file',expectedSha256:first.sha256,base64:Buffer.from('two').toString('base64')});expect(f.call({action:'write',path:'file',expectedSha256:first.sha256,base64:''})).toEqual({error:'conflict'});expect(f.call({action:'move',path:'file',to:'other',expectedSha256:second.sha256})).toEqual({sha256:second.sha256});expect(f.call({action:'list'}).map((e:any)=>e.name)).toEqual(['other']);expect(f.call({action:'remove',path:'other',expectedSha256:first.sha256})).toEqual({error:'conflict'});});
 it('roundtrips binary bytes without interpreting text',()=>{const f=fixture();const bytes=Buffer.from([0,255,254,13,10,128]);f.call({action:'seed',files:{binary:bytes.toString('base64')}});expect(Buffer.from(f.call({action:'read',path:'binary'}).base64,'base64')).toEqual(bytes);});
});
