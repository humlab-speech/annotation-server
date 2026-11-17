import test from "node:test";
import assert from "node:assert/strict";

import {
  annotationVersion,
  annotationProblem,
  canonicalJson,
  levelProblem,
  outsideLevelChange,
  isStrictBase64,
  isSsff,
  logSafe,
} from "../src/saveValidation.js";

const dbConfig = {
  levelDefinitions: [
    { name: "Word", type: "SEGMENT" },
    { name: "Phonetic", type: "SEGMENT" },
    { name: "Transcription", type: "SEGMENT" },
    { name: "Tone", type: "EVENT" },
  ],
  linkDefinitions: [{ type: "ONE_TO_MANY", superlevelName: "Word", sublevelName: "Phonetic" }],
};

function bundle() {
  return {
    name: "B1",
    annotates: "B1.wav",
    sampleRate: 16000,
    levels: [
      { name: "Word", type: "SEGMENT", items: [{ id: 1, sampleStart: 0, sampleDur: 99, labels: [{ name: "Word", value: "a" }] }] },
      { name: "Phonetic", type: "SEGMENT", items: [{ id: 2, sampleStart: 0, sampleDur: 99, labels: [{ name: "Phonetic", value: "a" }] }] },
      { name: "Transcription", type: "SEGMENT", items: [{ id: 3, sampleStart: 0, sampleDur: 99, labels: [{ name: "Transcription", value: "" }] }] },
    ],
    links: [{ fromID: 1, toID: 2 }],
  };
}
const copy = (value) => JSON.parse(JSON.stringify(value));

test("an unchanged or edited annotation with the same levels is accepted", () => {
  const edited = copy(bundle());
  edited.levels[2].items[0].labels[0].value = "hello";
  edited.levels[2].items.push({ id: 4, sampleStart: 100, sampleDur: 50, labels: [{ name: "Transcription", value: "" }] });
  assert.equal(annotationProblem(bundle(), bundle(), "B1", dbConfig), null);
  assert.equal(annotationProblem(edited, bundle(), "B1", dbConfig), null);
});

test("the legacy <bundle>_annot.json name is accepted", () => {
  const legacy = { ...bundle(), name: "B1_annot.json" };
  assert.equal(annotationProblem(legacy, bundle(), "B1", dbConfig), null);
});

test("a document that drops a level is refused", () => {
  const dropped = copy(bundle());
  dropped.levels.pop();
  assert.match(annotationProblem(dropped, bundle(), "B1", dbConfig), /Transcription is missing/);
});

test("a level the database does not define is refused; one it defines may be added", () => {
  const invented = copy(bundle());
  invented.levels.push({ name: "Invented", type: "SEGMENT", items: [] });
  assert.match(annotationProblem(invented, bundle(), "B1", dbConfig), /not part of this database/);

  const withoutTone = bundle();
  const added = copy(withoutTone);
  added.levels.push({ name: "Tone", type: "EVENT", items: [] });
  assert.equal(annotationProblem(added, withoutTone, "B1", dbConfig), null);
});

test("a level may not change type", () => {
  const retyped = copy(bundle());
  retyped.levels[2].type = "EVENT";
  assert.match(annotationProblem(retyped, bundle(), "B1", dbConfig), /changes type/);
});

test("duplicate item ids, also across levels, are refused", () => {
  const dup = copy(bundle());
  dup.levels[2].items[0].id = 1;
  assert.match(annotationProblem(dup, bundle(), "B1", dbConfig), /used twice/);
});

test("a bare {name} document, which would empty the bundle, is refused", () => {
  assert.match(annotationProblem({ name: "B1" }, bundle(), "B1", dbConfig), /changes annotates|no levels/);
  assert.match(annotationProblem({ name: "B1", annotates: "B1.wav", sampleRate: 16000 }, bundle(), "B1", dbConfig), /no levels/);
});

test("another bundle's name, a changed media file or sample rate, and dangling links are refused", () => {
  assert.match(annotationProblem({ ...bundle(), name: "B2" }, bundle(), "B1", dbConfig), /another bundle/);
  assert.match(annotationProblem({ ...bundle(), annotates: "other.wav" }, bundle(), "B1", dbConfig), /annotates/);
  assert.match(annotationProblem({ ...bundle(), sampleRate: 8000 }, bundle(), "B1", dbConfig), /sampleRate/);
  assert.match(annotationProblem({ ...bundle(), links: [{ fromID: 1, toID: 99 }] }, bundle(), "B1", dbConfig), /link/);
  assert.match(annotationProblem([], bundle(), "B1", dbConfig), /not an object/);
});

test("only an unlinked SEGMENT level may be saved on its own (TRATT's rule)", () => {
  assert.equal(levelProblem(dbConfig, "Transcription"), null);
  assert.match(levelProblem(dbConfig, "Word"), /linked/);
  assert.match(levelProblem(dbConfig, "Tone"), /not a SEGMENT level/);
  assert.match(levelProblem(dbConfig, "Nope"), /not a SEGMENT level/);
  assert.match(levelProblem(dbConfig, ""), /no level/);
  assert.match(levelProblem(dbConfig, undefined), /no level/);
});

test("a level-scoped save may change that level and nothing else", () => {
  const ok = copy(bundle());
  ok.levels[2].items[0].labels[0].value = "hello";
  assert.equal(outsideLevelChange(ok, bundle(), "Transcription"), null);
  // key order and the name's spelling do not matter
  const reordered = { links: ok.links, levels: ok.levels, sampleRate: 16000, annotates: "B1.wav", name: "B1_annot.json" };
  assert.equal(outsideLevelChange(reordered, bundle(), "Transcription"), null);

  const other = copy(ok);
  other.levels[0].items[0].labels[0].value = "changed";
  assert.match(outsideLevelChange(other, bundle(), "Transcription"), /more than level Transcription/);
  const relinked = copy(ok);
  relinked.links = [];
  assert.match(outsideLevelChange(relinked, bundle(), "Transcription"), /more than level/);
});

test("the version is the sha256 of the file's bytes", () => {
  assert.equal(annotationVersion(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(annotationVersion(Buffer.from("{}")), annotationVersion(Buffer.from("{ }")));
});

test("canonical JSON ignores key order only", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test("SSFF data must be strict base64 of an SSFF file", () => {
  const ssff = Buffer.from("SSFF -- (c) SHLRC\nMachine IBM-PC\n").toString("base64");
  assert.equal(isStrictBase64(ssff), true);
  assert.equal(isSsff(Buffer.from(ssff, "base64")), true);
  assert.equal(isStrictBase64("not base64!"), false);
  assert.equal(isStrictBase64("abc"), false);
  assert.equal(isStrictBase64(42), false);
  // valid base64, but not an SSFF file
  assert.equal(isSsff(Buffer.from(Buffer.from("garbage").toString("base64"), "base64")), false);
});

test("log text cannot forge lines or send terminal escapes", () => {
  assert.equal(logSafe("SAVEBUNDLE\n2026-01-01 [INFO] forged"), "SAVEBUNDLE\\u000a2026-01-01 [INFO] forged");
  assert.equal(logSafe("\u001b[31mred"), "\\u001b[31mred");
  assert.equal(logSafe("plain text åäö"), "plain text åäö");
});
