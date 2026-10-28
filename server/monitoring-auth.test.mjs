import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMonitoringAuth } from "./monitoring-auth.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

test("monitoring auth rejects missing and wrong passwords and verifies the configured one", () => {
  const auth = createMonitoringAuth(hash("correct horse battery staple"));
  assert.equal(auth.verifyPassword(""), false);
  assert.equal(auth.verifyPassword("wrong"), false);
  assert.equal(auth.verifyPassword("correct horse battery staple"), true);
  assert.equal(createMonitoringAuth(undefined).verifyPassword("anything"), false);
});

test("monitoring sessions are secure cookies, expire after 12 hours, and reject unknown tokens", () => {
  const auth = createMonitoringAuth(hash("password"));
  const now = 1_800_000_000_000;
  const token = auth.createSession(now);
  const cookieHeader = `other=value; monitoring_session=${token}`;
  assert.equal(auth.hasSession(cookieHeader, now + 1), true);
  assert.equal(auth.hasSession("monitoring_session=not-a-session", now + 1), false);
  assert.equal(auth.hasSession(cookieHeader, now + 12 * 60 * 60 * 1000), false);
  assert.match(auth.cookie(token), /; Secure; HttpOnly; SameSite=Strict$/);
});
