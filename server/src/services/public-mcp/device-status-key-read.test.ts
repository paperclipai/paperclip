import {describe,it,expect} from "vitest";
import {mkdtempSync,chmodSync,writeFileSync,statSync,readdirSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {deriveLocalEncryptedInstanceSecret} from "../../secrets/local-encrypted-provider.js";

function fixture(){const directory=mkdtempSync(path.join(os.tmpdir(),"mcp-status-readonly-key-")),file=path.join(directory,"master.key");return{directory,file,env:{PAPERCLIP_SECRETS_MASTER_KEY_FILE:file},cleanup:()=>rmSync(directory,{recursive:true,force:true})};}
describe("device status inspection key access",()=>{
  it("missing key is refused without creation even if allowCreate is also supplied",()=>{
    const f=fixture();try{expect(()=>deriveLocalEncryptedInstanceSecret("mcp-device-status:v1:instance",f.env,{readOnly:true,allowCreate:true})).toThrow("missing");expect(readdirSync(f.directory)).toEqual([]);}finally{f.cleanup();}
  });
  it("unsafe file permissions are refused without chmod",()=>{
    const f=fixture();try{writeFileSync(f.file,Buffer.alloc(32,7).toString("base64"));chmodSync(f.file,0o644);expect(()=>deriveLocalEncryptedInstanceSecret("mcp-device-status:v1:instance",f.env,{readOnly:true})).toThrow("permissions are unsafe");expect(statSync(f.file).mode&0o777).toBe(0o644);}finally{f.cleanup();}
  });
  it("safe key reads and environment keys are pure",()=>{
    const f=fixture();try{writeFileSync(f.file,Buffer.alloc(32,7).toString("base64"));chmodSync(f.file,0o600);const before=statSync(f.file);expect(deriveLocalEncryptedInstanceSecret("mcp-device-status:v1:instance",f.env,{readOnly:true})).toHaveLength(43);const after=statSync(f.file);expect(after.mode).toBe(before.mode);expect(after.mtimeMs).toBe(before.mtimeMs);
      const missing=path.join(f.directory,"missing.key");expect(deriveLocalEncryptedInstanceSecret("mcp-device-status:v1:instance",{PAPERCLIP_SECRETS_MASTER_KEY:Buffer.alloc(32,8).toString("base64"),PAPERCLIP_SECRETS_MASTER_KEY_FILE:missing},{readOnly:true})).toHaveLength(43);expect(readdirSync(f.directory)).toEqual(["master.key"]);
    }finally{f.cleanup();}
  });
  it("ordinary read/derive still repairs unsafe permissions",()=>{
    const f=fixture();try{writeFileSync(f.file,Buffer.alloc(32,7).toString("base64"));chmodSync(f.file,0o644);expect(deriveLocalEncryptedInstanceSecret("ordinary-owner",f.env,{allowCreate:false})).toHaveLength(43);expect(statSync(f.file).mode&0o777).toBe(0o600);}finally{f.cleanup();}
  });
});
