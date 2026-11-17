import test from "node:test";
import assert from "node:assert/strict";

import { findAssignedBundle, mediaBaseUrl } from "../src/bundleAccess.js";

const list = {
  projectId: "p1",
  owner: "some_user",
  bundles: [
    { session: "Session_1", name: "my_recording", comment: "", finishedEditing: false },
    { session: "Session_2", name: "my_recording", comment: "", finishedEditing: true },
  ],
};

test("an assigned bundle is found by session and name", () => {
  assert.equal(findAssignedBundle(list, "Session_2", "my_recording").finishedEditing, true);
});

test("the same name in an unassigned session is not assigned", () => {
  assert.equal(findAssignedBundle(list, "Session_3", "my_recording"), null);
});

test("an unassigned name is not assigned", () => {
  assert.equal(findAssignedBundle(list, "Session_1", "other_recording"), null);
});

test("no bundle list means nothing is assigned", () => {
  assert.equal(findAssignedBundle(null, "Session_1", "my_recording"), null);
  assert.equal(findAssignedBundle({ bundles: null }, "Session_1", "my_recording"), null);
});

test("non-string session or name never matches", () => {
  assert.equal(findAssignedBundle(list, { $ne: null }, "my_recording"), null);
  assert.equal(findAssignedBundle(list, "Session_1", ["my_recording"]), null);
  assert.equal(findAssignedBundle(list, undefined, undefined), null);
});

const allowed = ["https://artic.example.org", "https://tratt.example.org"];

test("audio is served from the allowed origin the connection came from", () => {
  assert.equal(
    mediaBaseUrl("https://tratt.example.org", allowed, "https://artic.example.org"),
    "https://tratt.example.org",
  );
  assert.equal(
    mediaBaseUrl("https://artic.example.org", allowed, "https://artic.example.org"),
    "https://artic.example.org",
  );
});

test("an origin outside the allow-list falls back to MEDIA_FILE_BASE_URL", () => {
  assert.equal(
    mediaBaseUrl("https://evil.example.net", allowed, "https://artic.example.org"),
    "https://artic.example.org",
  );
  assert.equal(mediaBaseUrl(undefined, allowed, "https://artic.example.org"), "https://artic.example.org");
});
