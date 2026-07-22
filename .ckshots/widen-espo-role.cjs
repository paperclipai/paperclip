// Widen the `paperclip` EspoCRM API user's role to FULL access on every ACL scope.
// Alan runs this in his own session so the admin credential stays with him:
//   ! ESPO_ADMIN_PW=$(docker exec divino-crm-web printenv ESPOCRM_ADMIN_PASSWORD) \
//       node /home/ckhermes/paperclip/.ckshots/widen-espo-role.cjs
// Idempotent: re-running just re-asserts full access. Reversible: re-scope the role in the Espo UI.
const BASE = "http://127.0.0.1:8085/api/v1";
const PW = process.env.ESPO_ADMIN_PW;
if (!PW) { console.error("Set ESPO_ADMIN_PW (see header)."); process.exit(1); }
const AUTH = { "Espo-Authorization": Buffer.from("admin:" + PW).toString("base64"), "Content-Type": "application/json" };
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: AUTH, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(method + " " + path + " -> " + r.status + " " + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}
(async () => {
  // 1. all ACL-controlled scopes from metadata
  const meta = await api("GET", "/Metadata");
  const scopes = meta.scopes || {};
  const data = {};
  for (const [name, s] of Object.entries(scopes)) {
    if (s && s.acl) data[name] = { create: "yes", read: "all", edit: "yes", delete: "yes", stream: "yes" };
  }
  console.log("ACL scopes to grant full:", Object.keys(data).length);

  // 2. find the paperclip API user + its role
  const u = await api("GET", "/User?where[0][type]=equals&where[0][attribute]=userName&where[0][value]=paperclip&select=id,userName,rolesIds&maxSize=1");
  if (!u.total) throw new Error("API user 'paperclip' not found");
  const user = u.list[0];
  const roleFull = {
    name: "Paperclip Integration (FULL)",
    assignmentPermission: "all", userPermission: "all", portalPermission: "all",
    messagePermission: "all", exportPermission: "yes", massUpdatePermission: "yes",
    dataPrivacyPermission: "yes", followerManagementPermission: "all",
    auditPermission: "all", data,
  };

  let roleId = (user.rolesIds || [])[0];
  if (roleId) {
    await api("PUT", "/Role/" + roleId, roleFull);
    console.log("Updated existing role", roleId, "-> FULL");
  } else {
    const role = await api("POST", "/Role", roleFull);
    await api("PUT", "/User/" + user.id, { rolesIds: [role.id] });
    roleId = role.id;
    console.log("Created role", roleId, "and assigned to paperclip user");
  }
  console.log("DONE. The `paperclip` API key now has full access on", Object.keys(data).length, "scopes (no delete is NOT enforced — full means full, per your call).");
})();
