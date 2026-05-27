import assert from "node:assert/strict";
import { test } from "node:test";

import { meaningfulLines, validateSslMulticert } from "./check-relay-ssl-multicert.mjs";

const gatewayLine = "dest_domain=*.gateway.blockcast.network ssl_cert_name=/opt/trafficserver/etc/trafficserver/gateway.crt ssl_key_name=/opt/trafficserver/etc/trafficserver/gateway.key";

test("meaningfulLines ignores blank lines and comments", () => {
  assert.deepEqual(meaningfulLines(`\n# managed by t3c\n\n${gatewayLine}\n`), [gatewayLine]);
});

test("gateway-only ssl_multicert content passes", () => {
  const result = validateSslMulticert(`# managed by t3c\n${gatewayLine}\n`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("extra non-gateway ssl_multicert line fails", () => {
  const result = validateSslMulticert(`${gatewayLine}\nssl_cert_name=/opt/trafficserver/etc/trafficserver/ds.crt ssl_key_name=/opt/trafficserver/etc/trafficserver/ds.key\n`);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /expected exactly one non-comment line/);
});

test("single line without a key declaration fails", () => {
  const result = validateSslMulticert("dest_domain=*.gateway.blockcast.network ssl_cert_name=/opt/trafficserver/etc/trafficserver/gateway.crt\n");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ssl_cert_name and ssl_key_name/);
});

test("exact expected gateway line can be enforced", () => {
  assert.equal(validateSslMulticert(`${gatewayLine}\n`, { expectedLine: gatewayLine }).ok, true);
  const result = validateSslMulticert(`${gatewayLine} extra=true\n`, { expectedLine: gatewayLine });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not match/);
});
