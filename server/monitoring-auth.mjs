import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const sessionLifetimeMs = 12 * 60 * 60 * 1000;

export function createMonitoringAuth(configuredHash) {
  const passwordHash = /^[a-f0-9]{64}$/i.test(configuredHash || "") ? configuredHash.toLowerCase() : null;
  const sessions = new Map();

  return {
    verifyPassword(password) {
      if (!passwordHash || typeof password !== "string" || !password.length) return false;
      const supplied = createHash("sha256").update(password).digest();
      const expected = Buffer.from(passwordHash, "hex");
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    createSession(now = Date.now()) {
      const token = randomBytes(32).toString("base64url");
      for (const [current, expiry] of sessions) if (expiry <= now) sessions.delete(current);
      if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
      sessions.set(token, now + sessionLifetimeMs);
      return token;
    },
    hasSession(cookieHeader = "", now = Date.now()) {
      const token = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith("monitoring_session="))?.slice("monitoring_session=".length);
      if (!token) return false;
      const expiresAt = sessions.get(token);
      if (!expiresAt || expiresAt <= now) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    cookie(token) {
      return `monitoring_session=${token}; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}; Secure; HttpOnly; SameSite=Strict`;
    }
  };
}
