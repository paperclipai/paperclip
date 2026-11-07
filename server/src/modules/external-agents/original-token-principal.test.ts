import { describe, expect, it, vi } from "vitest";
import { McpOAuthError, type McpPrincipal, type PublicMcpOAuth } from "../../services/public-mcp/oauth.js";
import { readDotOriginalTokenPrincipal } from "./original-token-principal.js";

const origin="https://dot-principal.example.test",resource=origin+"/mcp/runner",token="original-access-boundary-input";
const expected={accessToken:token,upstreamClientId:"actual-upstream-client",selectingUserId:"actual-user",canonicalVerifiedResource:resource};
function boundary(){
  const principal:McpPrincipal={grant:{id:"actual-grant",companyId:"actual-company",userId:"actual-user",clientId:"actual-upstream-client",resource,purpose:"agent",agentId:null,scopes:["paperclip:agent","offline_access"],revokedAt:null,revocationRevision:0,revocationIndexReceipt:null,createdAt:new Date(0)},actor:{type:"none",source:"mcp_oauth",companyId:"actual-company"},company:{id:"actual-company",name:"Actual authenticated company",issuePrefix:"DOT",status:"active"}};
  const authenticate=vi.fn(async(_token:string)=>principal);
  const oauth:Pick<PublicMcpOAuth,"mode"|"config"|"authenticate">={mode:"openai_dot_agent",config:{origin,resource},authenticate};
  return{principal,oauth,authenticate};
}
describe("Dot original-token principal UNIT boundary; controlled authenticate, no real OAuth or PG",()=>{
  it("authenticates original access once and projects actual unpaired identity without execution or binding authority",async()=>{
    const f=boundary();expect(await readDotOriginalTokenPrincipal(f.oauth,expected)).toEqual({userId:"actual-user",companyId:"actual-company",grantId:"actual-grant",clientId:"actual-upstream-client",resource,purpose:"agent"});
    expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(token);expect(f.principal.actor.type).toBe("none");expect(f.principal.grant.agentId).toBeNull();
  });
  it("requested company is optional restriction against actual grant company, not a replacement",async()=>{
    const f=boundary();await expect(readDotOriginalTokenPrincipal(f.oauth,{...expected,requestedCompanyId:"actual-company"})).resolves.toMatchObject({companyId:"actual-company"});expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(token);
    const mismatch=boundary();await expect(readDotOriginalTokenPrincipal(mismatch.oauth,{...expected,requestedCompanyId:"stack-primary-company"})).rejects.toMatchObject({code:"invalid_grant"});expect(mismatch.authenticate).toHaveBeenCalledExactlyOnceWith(token);
  });
  it.each(["personal","muse_agent"] as const)("rejects %s owner mode before credential authentication",async mode=>{
    const f=boundary();await expect(readDotOriginalTokenPrincipal({...f.oauth,mode},expected)).rejects.toMatchObject({code:"invalid_grant"});expect(f.authenticate).not.toHaveBeenCalled();
  });
  it.each(["https://foreign.example.test/mcp/runner",origin+"/mcp/paperclip",resource+"?resource=other","not-an-origin"])("rejects nonmatching current canonical resource %s",async canonicalVerifiedResource=>{
    const f=boundary();await expect(readDotOriginalTokenPrincipal(f.oauth,{...expected,canonicalVerifiedResource})).rejects.toMatchObject({code:"invalid_grant"});expect(f.authenticate).not.toHaveBeenCalled();
  });
  it.each(["origin","resource"] as const)("rejects configured %s mismatch before authenticating",async field=>{
    const f=boundary();await expect(readDotOriginalTokenPrincipal({...f.oauth,config:{...f.oauth.config,[field]:"https://foreign.example.test"}},expected)).rejects.toMatchObject({code:"invalid_grant"});expect(f.authenticate).not.toHaveBeenCalled();
  });
  it.each(["clientId","userId","companyId","resource","purpose","scope"] as const)("rejects authenticated %s mismatch after exactly one owner call",async field=>{
    const f=boundary();if(field==="purpose")f.principal.grant.purpose="personal";else if(field==="scope")f.principal.grant.scopes=["paperclip:read"];else f.principal.grant[field]="foreign";
    await expect(readDotOriginalTokenPrincipal(f.oauth,expected)).rejects.toMatchObject({code:"invalid_grant"});expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(token);
  });
  it.each(["feature-disabled","expired-access","revoked-grant","removed-membership","operator-denied"])("propagates actual owner rejection unchanged: %s (controlled unit, not real lifecycle proof)",async reason=>{
    const f=boundary(),failure=new McpOAuthError("invalid_grant",reason);f.authenticate.mockRejectedValueOnce(failure);await expect(readDotOriginalTokenPrincipal(f.oauth,expected)).rejects.toBe(failure);expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(token);
  });
});
