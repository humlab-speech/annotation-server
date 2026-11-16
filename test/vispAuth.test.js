import test from "node:test";
import assert from "node:assert/strict";

import VispAuth, { sessionUserFromResponse } from "../src/authModules/visp.module.js";

const users = [{ username: "some_user", eppn: "some_user@example.org" }];
const projects = [{ id: "p1", members: [{ username: "some_user" }] }];

function fakeDb() {
  return {
    collection(name) {
      const docs = name === "users" ? users : projects;
      return {
        async findOne(filter) {
          return docs.find((doc) =>
            Object.entries(filter).every(([key, value]) =>
              key === "members.username"
                ? doc.members.some((m) => m.username === value)
                : doc[key] === value,
            ),
          ) ?? null;
        },
      };
    },
  };
}

/** A PHP API that knows the given live sessions (PHPSESSID -> username). */
function phpApi(sessions) {
  const calls = [];
  const fetch = async (url, init) => {
    const id = /PHPSESSID=([^;]*)/.exec(init.headers.Cookie)[1];
    calls.push(id);
    const username = sessions[id];
    const body = username ? JSON.stringify({ username, eppn: username + "@example.org" }) : "[]";
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, body }) };
  };
  return { fetch, calls };
}

function auth(fetch, now = () => 0) {
  return new VispAuth({ db: fakeDb(), addLog: () => {} }, { fetch, now });
}

test("any live session of a user is accepted, not just the most recent sign-in", async () => {
  // Two browsers, two PHP sessions, one user: both must work.
  const { fetch } = phpApi({ first: "some_user", second: "some_user" });
  const a = auth(fetch);
  assert.equal((await a.authenticateUser("first", "p1")).authenticated, true);
  assert.equal((await a.authenticateUser("second", "p1")).authenticated, true);
});

test("a session PHP does not know is not signed in, with a reason TRATT reads as such", async () => {
  const { fetch } = phpApi({});
  const result = await auth(fetch).authenticateUser("gone", "p1");
  assert.equal(result.authenticated, false);
  assert.match(result.reason, /not signed in/);
});

test("a signed-in user outside the project is refused as a non-member", async () => {
  const { fetch } = phpApi({ s: "some_user" });
  const result = await auth(fetch).authenticateUser("s", "other-project");
  assert.equal(result.authenticated, false);
  assert.match(result.reason, /member/);
});

test("a confirmed session is cached briefly, then asked again", async () => {
  const { fetch, calls } = phpApi({ s: "some_user" });
  let clock = 0;
  const a = auth(fetch, () => clock);
  await a.authenticateUser("s", "p1");
  await a.authenticateUser("s", "p1");
  assert.equal(calls.length, 1);
  clock = 16 * 1000;
  await a.authenticateUser("s", "p1");
  assert.equal(calls.length, 2);
});

test("a dead session is not cached: signing in again works at once", async () => {
  const sessions = {};
  const { fetch, calls } = phpApi(sessions);
  const a = auth(fetch);
  assert.equal((await a.authenticateUser("s", "p1")).authenticated, false);
  sessions.s = "some_user";
  assert.equal((await a.authenticateUser("s", "p1")).authenticated, true);
  assert.equal(calls.length, 2);
});

test("when PHP cannot be asked the user is told to retry, not that they are signed out", async () => {
  const a = auth(async () => { throw new Error("ECONNREFUSED"); });
  const result = await a.authenticateUser("s", "p1");
  assert.equal(result.authenticated, false);
  assert.doesNotMatch(result.reason, /not signed in|session|authenticat/i);
});

test("a session id that could smuggle a second cookie or header is refused", async () => {
  const { fetch, calls } = phpApi({ s: "some_user" });
  const a = auth(fetch);
  for (const id of ["s; PHPSESSID=x", "s\r\nX-Evil: 1"]) {
    assert.equal((await a.authenticateUser(id, "p1")).authenticated, false);
  }
  assert.equal(calls.length, 0);
});

test("the session answer is read strictly", () => {
  assert.equal(sessionUserFromResponse(JSON.stringify({ body: "[]" })), null);
  assert.equal(sessionUserFromResponse(JSON.stringify({ body: JSON.stringify({ eppn: "x" }) })), null);
  assert.equal(sessionUserFromResponse(JSON.stringify({ body: JSON.stringify({ username: "u" }) })).username, "u");
  assert.throws(() => sessionUserFromResponse("<html>"));
});
