/** Exact existing Muse metadata. No personal-MCP issuer or device grant is invented. */
export function museReceiverDiscoveryDocument(input:{origin:string;authorizationOrigin:string}){
 const path="/api/muse/v1/oauth",issuer=input.origin+path;
 return {path:path+"/metadata",document:{issuer,authorization_endpoint:input.authorizationOrigin+path+"/authorize",token_endpoint:issuer+"/token",registration_endpoint:issuer+"/register",revocation_endpoint:issuer+"/revoke",
  resource:input.origin+"/api/muse/v1",scopes_supported:["paperclip:agent","offline_access"],grant_types_supported:["authorization_code","refresh_token"],response_types_supported:["code"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],authorization_response_iss_parameter_supported:true}};
}
export function isMuseReceiverDiscoveryRequest(request:{method?:string;url?:string}){
 return ["GET","HEAD"].includes(request.method??"")&&request.url==="/api/muse/v1/oauth/metadata";
}
