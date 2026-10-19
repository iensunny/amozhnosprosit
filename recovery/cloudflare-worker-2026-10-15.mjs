var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// cloudflare/worker.mjs
var inviteLifetimeMs = 7 * 24 * 60 * 60 * 1e3;
var maxInitDataLifetimeMs = 60 * 60 * 1e3;
var dailyNotificationHour = 10;
var validId = /* @__PURE__ */ __name((value) => typeof value === "string" && /^[A-Za-z0-9-]{8,100}$/.test(value), "validId");
var validMember = /* @__PURE__ */ __name((value) => value && validId(value.id) && typeof value.name === "string" && value.name.trim().length > 0 && value.name.trim().length <= 40 && ["child", "adult"].includes(value.role), "validMember");
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
}
__name(json, "json");
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(randomToken, "randomToken");
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(digest, "digest");
function timingSafeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function fromHex(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
__name(fromHex, "fromHex");
async function hmac(key, value) {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}
__name(hmac, "hmac");
async function verifyMaxInitData(initData, botToken) {
  if (typeof initData !== "string" || !initData || initData.length > 8192 || typeof botToken !== "string" || !botToken) return null;
  const seen = /* @__PURE__ */ new Set();
  const pairs = [];
  for (const source of initData.split("&")) {
    const divider = source.indexOf("=");
    if (divider < 1) return null;
    const key2 = source.slice(0, divider);
    if (!/^[A-Za-z0-9_]+$/.test(key2) || seen.has(key2)) return null;
    seen.add(key2);
    try {
      pairs.push([key2, decodeURIComponent(source.slice(divider + 1))]);
    } catch {
      return null;
    }
  }
  const hash = pairs.find(([key2]) => key2 === "hash")?.[1];
  const suppliedHash = fromHex(hash);
  if (!hash || !suppliedHash || pairs.filter(([key2]) => key2 === "hash").length !== 1) return null;
  const canonical = pairs.filter(([key2]) => key2 !== "hash").sort(([a], [b]) => a.localeCompare(b)).map(([key2, value]) => `${key2}=${value}`).join("\n");
  const secretKey = await hmac("WebAppData", botToken);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
  if (!timingSafeEqual(expected, suppliedHash)) return null;
  const values = Object.fromEntries(pairs);
  const issuedAt = Number(values.auth_date);
  if (!Number.isInteger(issuedAt) || Math.abs(Date.now() - issuedAt * 1e3) > maxInitDataLifetimeMs) return null;
  try {
    const user = JSON.parse(values.user || "");
    if (!Number.isSafeInteger(user?.id) || user.id <= 0) return null;
    const chat = values.chat ? JSON.parse(values.chat) : null;
    return { userId: String(user.id), chatId: Number.isSafeInteger(chat?.id) ? String(chat.id) : null, user };
  } catch {
    return null;
  }
}
__name(verifyMaxInitData, "verifyMaxInitData");
function maxInitDataFromHeader(value) {
  if (typeof value !== "string" || !value.startsWith("b64:")) return value;
  try {
    const encoded = value.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
__name(maxInitDataFromHeader, "maxInitDataFromHeader");
const parsedBodies = new WeakMap();
async function bodyOf(request) {
  if (parsedBodies.has(request)) return parsedBodies.get(request);
  const parsed = (async () => {
    if (Number(request.headers.get("content-length") || 0) > 32768) throw new Error("Request is too large");
    const raw = await request.text();
    if (raw.length > 32768) throw new Error("Request is too large");
    return raw ? JSON.parse(raw) : {};
  })();
  parsedBodies.set(request, parsed);
  return parsed;
}
async function maxIdentityFromRequest(request, env) {
  let initData = maxInitDataFromHeader(request.headers.get("X-MAX-Init-Data"));
  // Some MAX webviews reject custom request headers before the request is
  // sent. A signed init payload in a POST body is equally verified below and
  // avoids making invitation creation a one-shot dead end for the user.
  if (!initData && request.method !== "GET" && request.method !== "HEAD") {
    const input = await bodyOf(request);
    initData = maxInitDataFromHeader(input?._maxInitData);
  }
  if (!initData) return null;
  const identity = await verifyMaxInitData(initData, env.MAX_BOT_TOKEN);
  if (!identity) throw new Error("MAX authentication failed");
  return identity;
}
__name(maxIdentityFromRequest, "maxIdentityFromRequest");
__name(bodyOf, "bodyOf");
async function pairById(db, id) {
  return db.prepare("SELECT * FROM pairs WHERE id = ?").bind(id).first();
}
__name(pairById, "pairById");
function safeDiagnosticMessage(error) {
  return String(error?.message || "Unknown error")
    .replace(/\s+/g, " ")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\b\d{8,}\b/g, "[redacted]")
    .slice(0, 240);
}
__name(safeDiagnosticMessage, "safeDiagnosticMessage");
async function writeDiagnostic(db, event) {
  try {
    await db.prepare("INSERT INTO diagnostic_events (id, created_at, stage, error_type, error_code, message) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(event.id, event.createdAt, event.stage, event.errorType, event.errorCode, event.message)
      .run();
    return true;
  } catch (error) {
    console.error("Could not persist diagnostic event", {
      diagnosticId: event.id,
      stage: event.stage,
      errorType: error?.name || "Error",
      errorCode: Number.isInteger(error?.code) ? error.code : ""
    });
    return false;
  }
}
__name(writeDiagnostic, "writeDiagnostic");
function insertMember(db, member, pairId, position, tokenHash, maxUserId) {
  if (maxUserId) {
    return db.prepare("INSERT INTO members (id, pair_id, name, role, position, token_hash, max_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(member.id, pairId, member.name.trim(), member.role, position, tokenHash, maxUserId);
  }
  // Use a SQL NULL literal for an unlinked browser participant; MAX identity
  // remains optional.
  return db.prepare("INSERT INTO members (id, pair_id, name, role, position, token_hash, max_user_id) VALUES (?, ?, ?, ?, ?, ?, NULL)")
    .bind(member.id, pairId, member.name.trim(), member.role, position, tokenHash);
}
__name(insertMember, "insertMember");
async function publicPair(db, pair) {
  const [members, marks, questionDays] = await Promise.all([
    db.prepare("SELECT id, name, role, position FROM members WHERE pair_id = ? ORDER BY position").bind(pair.id).all(),
    db.prepare("SELECT day, at, by_member_id FROM marks WHERE pair_id = ? ORDER BY day").bind(pair.id).all(),
    db.prepare("SELECT day, opened_at, replaced, skipped_at FROM question_days WHERE pair_id = ? ORDER BY day").bind(pair.id).all()
  ]);
  return {
    id: pair.id,
    status: pair.status,
    createdAt: pair.created_at,
    startedAt: pair.started_at,
    timeZone: pair.time_zone,
    planVersion: pair.plan_version || 1,
    members: members.results.map(({ id, name, role }) => ({ id, name, role })),
    marks: Object.fromEntries(marks.results.map(({ day, at, by_member_id }) => [`${pair.id}:${day}`, { at, by: by_member_id }])),
    questionDays: Object.fromEntries(questionDays.results.map(({ day, opened_at, replaced, skipped_at }) => [day, { openedAt: opened_at, replaced: Boolean(replaced), skippedAt: skipped_at }]))
  };
}
__name(publicPair, "publicPair");
async function memberFor(request, db, pairId, env) {
  const raw = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") || "")?.[1];
  if (!raw) return null;
  const member = await db.prepare("SELECT id, name, role, position, max_user_id FROM members WHERE pair_id = ? AND token_hash = ?").bind(pairId, await digest(raw)).first();
  if (!member) return null;
  if (!member.max_user_id) return member;
  const identity = await maxIdentityFromRequest(request, env);
  return identity?.userId === member.max_user_id ? member : null;
}
__name(memberFor, "memberFor");
function dayNumber(pair) {
  const ordinal = /* @__PURE__ */ __name((date) => {
    const entries = new Intl.DateTimeFormat("en-US", {
      timeZone: pair.time_zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(entries.map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(values.year, values.month - 1, values.day);
  }, "ordinal");
  return Math.max(1, Math.floor((ordinal(/* @__PURE__ */ new Date()) - ordinal(new Date(pair.started_at))) / 864e5) + 1);
}
__name(dayNumber, "dayNumber");
async function api(request, env, pathname) {
  const db = env.DB;
  let diagnosticStage = "route";
  try {
    if (pathname === "/api/health" && request.method === "GET") return json({ ok: true });
    if (pathname === "/api/max/restore" && request.method === "POST") {
      const identity = await maxIdentityFromRequest(request, env);
      if (!identity) return json({ linked: false });
      const member = await db.prepare("SELECT id, pair_id, name, role FROM members WHERE max_user_id = ?").bind(identity.userId).first();
      if (!member) return json({ linked: false });
      const pair2 = await pairById(db, member.pair_id);
      if (!pair2) return json({ linked: false });
      const memberToken = randomToken();
      await db.prepare("UPDATE members SET token_hash = ? WHERE id = ?").bind(await digest(memberToken), member.id).run();
      return json({ linked: true, member: { id: member.id, name: member.name, role: member.role }, memberToken, pair: await publicPair(db, pair2) });
    }
    if (pathname === "/api/pairs" && request.method === "POST") {
      diagnosticStage = "create_read_request";
      const input = await bodyOf(request);
      diagnosticStage = "create_validate_input";
      if (!validId(input.id) || !validMember(input.member)) return json({ error: "Invalid invitation" }, 400);
      diagnosticStage = "create_verify_max_identity";
      const identity = await maxIdentityFromRequest(request, env);
      diagnosticStage = "create_check_existing_member";
      if (identity && await db.prepare("SELECT id FROM members WHERE max_user_id = ?").bind(identity.userId).first())
        return json({ error: "\u042D\u0442\u043E\u0442 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 MAX \u0443\u0436\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043A \u0434\u0440\u0443\u0433\u043E\u0439 \u043F\u0430\u0440\u0435" }, 409);
      const timeZone = input.timeZone || "Europe/Moscow";
      diagnosticStage = "create_validate_timezone";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format(/* @__PURE__ */ new Date());
      } catch {
        return json({ error: "Invalid time zone" }, 400);
      }
      diagnosticStage = "create_check_existing_pair";
      if (await pairById(db, input.id)) return json({ error: "Invitation exists" }, 409);
      const memberToken = randomToken(), invitationToken = randomToken();
      const now = (/* @__PURE__ */ new Date()).toISOString(), expires = new Date(Date.now() + inviteLifetimeMs).toISOString();
      diagnosticStage = "create_save_invitation";
      await db.batch([
        db.prepare("INSERT INTO pairs (id, status, created_at, started_at, time_zone, plan_version, invite_hash, invite_expires_at) VALUES (?, ?, ?, NULL, ?, 2, ?, ?)").bind(input.id, "pending", now, timeZone, await digest(invitationToken), expires),
        insertMember(db, input.member, input.id, 0, await digest(memberToken), identity?.userId)
      ]);
      diagnosticStage = "create_load_invitation";
      return json({ pair: await publicPair(db, await pairById(db, input.id)), memberToken, invitationToken }, 201);
    }
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "pairs" || !validId(parts[2])) return json({ error: "Not found" }, 404);
    if (parts.length === 4 && parts[3] === "accept" && request.method === "POST") diagnosticStage = "load_pair";
    const pair = await pairById(db, parts[2]);
    if (!pair) return json({ error: "Invitation not found" }, 404);
    if (parts.length === 4 && parts[3] === "accept" && request.method === "POST") {
      diagnosticStage = "read_request";
      const { member, invitationToken } = await bodyOf(request);
      diagnosticStage = "validate_invitation";
      if (!validMember(member) || typeof invitationToken !== "string" || !pair.invite_hash || await digest(invitationToken) !== pair.invite_hash || Date.now() > Date.parse(pair.invite_expires_at || 0))
        return json({ error: "Invitation is invalid or expired" }, 403);
      diagnosticStage = "load_first_member";
      const existing = await db.prepare("SELECT role FROM members WHERE pair_id = ? AND position = 0").bind(pair.id).first();
      if (pair.status !== "pending" || !existing || existing.role === member.role) return json({ error: "Invitation cannot be accepted" }, 409);
      diagnosticStage = "verify_max_identity";
      const identity = await maxIdentityFromRequest(request, env);
      if (identity && await db.prepare("SELECT id FROM members WHERE max_user_id = ?").bind(identity.userId).first())
        return json({ error: "\u042D\u0442\u043E\u0442 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 MAX \u0443\u0436\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043A \u0434\u0440\u0443\u0433\u043E\u0439 \u043F\u0430\u0440\u0435" }, 409);
      const memberToken = randomToken(), now = (/* @__PURE__ */ new Date()).toISOString();
      diagnosticStage = "save_membership";
      await db.batch([
        insertMember(db, member, pair.id, 1, await digest(memberToken), identity?.userId),
        db.prepare("UPDATE pairs SET status = 'active', started_at = ?, invite_hash = NULL, invite_expires_at = NULL WHERE id = ? AND status = 'pending'").bind(now, pair.id)
      ]);
      diagnosticStage = "load_joined_pair";
      return json({ pair: await publicPair(db, await pairById(db, pair.id)), memberToken });
    }
    const actor = await memberFor(request, db, pair.id, env);
    if (!actor) return json({ error: "Authentication required" }, 401);
    if (parts.length === 3 && request.method === "GET") return json(await publicPair(db, pair));
    if (parts.length === 4 && parts[3] === "invite" && request.method === "POST") {
      if (pair.status !== "pending") return json({ error: "Pair is already active" }, 409);
      const invitationToken = randomToken(), expires = new Date(Date.now() + inviteLifetimeMs).toISOString();
      await db.prepare("UPDATE pairs SET invite_hash = ?, invite_expires_at = ? WHERE id = ?").bind(await digest(invitationToken), expires, pair.id).run();
      return json({ pair: await publicPair(db, await pairById(db, pair.id)), invitationToken });
    }
    if (parts.length === 4 && parts[3] === "marks" && request.method === "POST") {
      if (pair.status !== "active") return json({ error: "No active question" }, 409);
      const day = dayNumber(pair);
      if (actor.position !== (day - 1) % 2) return json({ error: "Question belongs to the other participant" }, 403);
      const questionDay = await db.prepare("SELECT opened_at, skipped_at FROM question_days WHERE pair_id = ? AND day = ?").bind(pair.id, day).first();
      if (!questionDay || questionDay.skipped_at) return json({ error: "Question is not available" }, 409);
      if (Date.now() - Date.parse(questionDay.opened_at) < 60 * 60 * 1e3)
        return json({ error: "\u041E\u0442\u043C\u0435\u0442\u043A\u0430 \u0441\u0442\u0430\u043D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0447\u0435\u0440\u0435\u0437 \u0447\u0430\u0441 \u043F\u043E\u0441\u043B\u0435 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F \u0432\u043E\u043F\u0440\u043E\u0441\u0430" }, 409);
      await db.prepare("INSERT OR IGNORE INTO marks (pair_id, day, at, by_member_id) VALUES (?, ?, ?, ?)").bind(pair.id, day, (/* @__PURE__ */ new Date()).toISOString(), actor.id).run();
      return json(await publicPair(db, await pairById(db, pair.id)));
    }
    if (parts.length === 4 && parts[3] === "question" && request.method === "POST") {
      if (pair.status !== "active") return json({ error: "No active question" }, 409);
      const day = dayNumber(pair);
      if (actor.position !== (day - 1) % 2) return json({ error: "Question belongs to the other participant" }, 403);
      const { choice } = await bodyOf(request);
      if (!["open", "replace", "skip"].includes(choice)) return json({ error: "Invalid choice" }, 400);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await db.prepare("INSERT OR IGNORE INTO question_days (pair_id, day, opened_at, replaced, skipped_at) VALUES (?, ?, ?, 0, NULL)").bind(pair.id, day, now).run();
      if (choice !== "open") {
        const marked = await db.prepare("SELECT 1 FROM marks WHERE pair_id = ? AND day = ?").bind(pair.id, day).first();
        if (marked) return json({ error: "\u0420\u0430\u0437\u0433\u043E\u0432\u043E\u0440 \u0443\u0436\u0435 \u043E\u0442\u043C\u0435\u0447\u0435\u043D" }, 409);
        const query = choice === "replace" ? "UPDATE question_days SET replaced = 1 WHERE pair_id = ? AND day = ? AND replaced = 0 AND skipped_at IS NULL" : "UPDATE question_days SET skipped_at = ? WHERE pair_id = ? AND day = ? AND skipped_at IS NULL";
        const result = choice === "replace" ? await db.prepare(query).bind(pair.id, day).run() : await db.prepare(query).bind(now, pair.id, day).run();
        if (!result.meta.changes) return json({ error: "\u0412\u043E\u043F\u0440\u043E\u0441 \u0443\u0436\u0435 \u043D\u0435\u043B\u044C\u0437\u044F \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C" }, 409);
      }
      return json(await publicPair(db, await pairById(db, pair.id)));
    }
    if (parts.length === 5 && parts[3] === "members" && validId(parts[4]) && request.method === "PATCH") {
      if (parts[4] !== actor.id) return json({ error: "Cannot edit another participant" }, 403);
      const { name } = await bodyOf(request);
      if (typeof name !== "string" || !name.trim() || name.trim().length > 40) return json({ error: "Invalid name" }, 400);
      await db.prepare("UPDATE members SET name = ? WHERE id = ? AND pair_id = ?").bind(name.trim(), actor.id, pair.id).run();
      return json(await publicPair(db, await pairById(db, pair.id)));
    }
    if (parts.length === 5 && parts[3] === "members" && validId(parts[4]) && request.method === "DELETE") {
      if (parts[4] !== actor.id) return json({ error: "Cannot delete another participant" }, 403);
      await db.batch([
        db.prepare("DELETE FROM marks WHERE pair_id = ?").bind(pair.id),
        db.prepare("DELETE FROM question_days WHERE pair_id = ?").bind(pair.id),
        db.prepare("DELETE FROM members WHERE id = ? AND pair_id = ?").bind(actor.id, pair.id),
        db.prepare("UPDATE members SET position = 0 WHERE pair_id = ?").bind(pair.id),
        db.prepare("UPDATE pairs SET status = 'pending', started_at = NULL, invite_hash = NULL, invite_expires_at = NULL WHERE id = ?").bind(pair.id)
      ]);
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM members WHERE pair_id = ?").bind(pair.id).first();
      if (!remaining.count) await db.prepare("DELETE FROM pairs WHERE id = ?").bind(pair.id).run();
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const rootCause = error?.cause ?? error;
    const errorType = typeof rootCause?.name === "string" && /^[A-Za-z]+Error$/.test(rootCause.name)
      ? rootCause.name
      : "Error";
    const errorCode = Number.isInteger(rootCause?.code) ? rootCause.code : null;
    console.error("API request failed", {
      stage: diagnosticStage,
      type: errorType,
      code: errorCode,
      message: safeDiagnosticMessage(rootCause)
    });
    if (pathname.endsWith("/accept") || (pathname === "/api/pairs" && request.method === "POST")) {
      const creatingInvite = pathname === "/api/pairs" && request.method === "POST";
      const stages = creatingInvite
        ? ["create_read_request", "create_validate_input", "create_verify_max_identity", "create_check_existing_member", "create_validate_timezone", "create_check_existing_pair", "create_save_invitation", "create_load_invitation"]
        : ["load_pair", "read_request", "validate_invitation", "load_first_member", "verify_max_identity", "save_membership", "load_joined_pair"];
      const stageCode = stages.indexOf(diagnosticStage) + 1;
      const diagnosticId = crypto.randomUUID();
      const diagnosticMessage = safeDiagnosticMessage(rootCause);
      const diagnosticSaved = await writeDiagnostic(db, {
        id: diagnosticId,
        createdAt: new Date().toISOString(),
        stage: diagnosticStage,
        errorType,
        errorCode: errorCode === null ? "" : String(errorCode),
        message: diagnosticMessage
      });
      return json({
        error: `Request failed [${creatingInvite ? "INVITE" : "JOIN"}-${String(stageCode).padStart(2, "0")}]`,
        diagnostic: diagnosticStage,
        diagnosticId,
        diagnosticSaved,
        diagnosticError: { type: errorType, code: errorCode }
      }, 500);
    }
    return json({ error: "Request failed" }, 500);
  }
}
__name(api, "api");
function hourInTimeZone(timeZone, date = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find(({ type }) => type === "hour")?.value);
}
__name(hourInTimeZone, "hourInTimeZone");
async function sendMaxMessage(env, userId, text) {
  if (!env.MAX_BOT_TOKEN) throw new Error("MAX bot token is not configured");
  const response = await fetch(`https://platform-api2.max.ru/messages?user_id=${encodeURIComponent(userId)}`, {
    method: "POST",
    headers: { Authorization: env.MAX_BOT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      notify: true,
      attachments: [{ type: "inline_keyboard", payload: { buttons: [[{
        type: "link",
        text: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \xAB\u0414\u0435\u043B\u0438\u0441\u044C\xBB",
        url: `https://max.ru/${env.MAX_BOT_NAME || "se14681938_bot"}?startapp`
      }]] } }]
    })
  });
  if (!response.ok) throw new Error(`MAX message failed: ${response.status}`);
}
__name(sendMaxMessage, "sendMaxMessage");
async function sendDailyNotifications(env) {
  const pairs = await env.DB.prepare("SELECT id, started_at, time_zone FROM pairs WHERE status = 'active'").all();
  for (const pair of pairs.results) {
    if (hourInTimeZone(pair.time_zone) !== dailyNotificationHour) continue;
    const day = dayNumber(pair);
    const member = await env.DB.prepare("SELECT id, max_user_id FROM members WHERE pair_id = ? AND position = ?").bind(pair.id, (day - 1) % 2).first();
    if (!member?.max_user_id) continue;
    const alreadySent = await env.DB.prepare("SELECT 1 FROM daily_notifications WHERE pair_id = ? AND day = ? AND member_id = ?").bind(pair.id, day, member.id).first();
    if (alreadySent) continue;
    try {
      await sendMaxMessage(env, member.max_user_id, "\u0421\u0435\u0433\u043E\u0434\u043D\u044F \u0432\u0430\u0448 \u0445\u043E\u0434 \u2014 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \xAB\u0414\u0435\u043B\u0438\u0441\u044C\xBB \u0438 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441 \u0431\u043B\u0438\u0437\u043A\u043E\u043C\u0443.");
      await env.DB.prepare("INSERT OR IGNORE INTO daily_notifications (pair_id, day, member_id, sent_at) VALUES (?, ?, ?, ?)").bind(pair.id, day, member.id, (/* @__PURE__ */ new Date()).toISOString()).run();
    } catch (error) {
      console.error("Daily MAX notification failed", { pairId: pair.id, memberId: member.id, message: error?.message });
    }
  }
}
__name(sendDailyNotifications, "sendDailyNotifications");
var worker_default = {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/")) return api(request, env, pathname);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDailyNotifications(env));
  }
};
export {
  worker_default as default,
  verifyMaxInitData
};
//# sourceMappingURL=worker.js.map

