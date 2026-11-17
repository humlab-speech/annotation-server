import crypto from 'crypto';

/**
 * Checks on what SAVEBUNDLE may write. The protocol sends the whole
 * <bundle>_annot.json, so without them any assigned user could write any
 * document: drop or invent levels, duplicate item ids, or empty the bundle.
 * Pure functions, so they are tested without a server (test/saveValidation.test.js).
 */

/** The version of an annotation file: sha256 of its bytes, as GETBUNDLE reports it. */
export function annotationVersion(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON with object keys sorted, so equal documents compare equal whatever their key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (isObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const levelDefinition = (dbConfig, name) => (dbConfig?.levelDefinitions || []).find((def) => def?.name === name);

/**
 * Why `submitted` may not replace `current` (the annotation on disk) for the
 * bundle `bundleName`, or null if it may. The levels must be the file's own,
 * with the same types; the only addition allowed is a level the database
 * config defines but the file does not have yet (TRATT adds its level that way).
 */
export function annotationProblem(submitted, current, bundleName, dbConfig) {
  if (!isObject(submitted)) {
    return 'the annotation is not an object';
  }
  if (submitted.name !== bundleName && submitted.name !== bundleName + '_annot.json') {
    return 'the annotation names another bundle';
  }
  for (const field of ['annotates', 'sampleRate']) {
    if (current && field in current && submitted[field] !== current[field]) {
      return `the annotation changes ${field}`;
    }
  }
  if (!Array.isArray(submitted.levels)) {
    return 'the annotation has no levels';
  }

  const currentLevels = new Map((current?.levels || []).map((level) => [level?.name, level]));
  const seenLevels = new Set();
  const itemIds = new Set();
  for (const level of submitted.levels) {
    if (!isObject(level) || typeof level.name !== 'string' || typeof level.type !== 'string' || !Array.isArray(level.items)) {
      return 'a level is malformed';
    }
    if (seenLevels.has(level.name)) {
      return `level ${level.name} appears twice`;
    }
    seenLevels.add(level.name);
    const before = currentLevels.get(level.name);
    const expectedType = before?.type ?? levelDefinition(dbConfig, level.name)?.type;
    if (!expectedType) {
      return `level ${level.name} is not part of this database`;
    }
    if (level.type !== expectedType) {
      return `level ${level.name} changes type`;
    }
    for (const item of level.items) {
      if (!isObject(item) || !Number.isInteger(item.id)) {
        return `an item of level ${level.name} has no valid id`;
      }
      if (itemIds.has(item.id)) {
        return `item id ${item.id} is used twice`;
      }
      itemIds.add(item.id);
    }
  }
  for (const name of currentLevels.keys()) {
    if (!seenLevels.has(name)) {
      return `level ${name} is missing`;
    }
  }

  const links = submitted.links ?? [];
  if (!Array.isArray(links)) {
    return 'the links are malformed';
  }
  for (const link of links) {
    if (!isObject(link) || !itemIds.has(link.fromID) || !itemIds.has(link.toID)) {
      return 'a link refers to an item that does not exist';
    }
  }
  return null;
}

/**
 * Why `levelName` may not be edited on its own, or null if it may: TRATT's
 * rule (checkEditable in TRATT's emu-annotation-splice.ts), an unlinked
 * SEGMENT level of the database config.
 */
export function levelProblem(dbConfig, levelName) {
  if (typeof levelName !== 'string' || levelName === '') {
    return 'no level named';
  }
  if (levelDefinition(dbConfig, levelName)?.type !== 'SEGMENT') {
    return `${levelName} is not a SEGMENT level`;
  }
  const linked = (dbConfig?.linkDefinitions || []).some(
    (link) => link?.superlevelName === levelName || link?.sublevelName === levelName,
  );
  return linked ? `${levelName} is linked to another level` : null;
}

/**
 * Why `submitted` changes more than level `levelName` of `current`, or null.
 * Used for saves that name their level (TRATT): everything but that level must
 * be exactly as stored.
 */
export function outsideLevelChange(submitted, current, levelName) {
  // `name` may legitimately be either spelling (see annotationProblem).
  const comparable = ({ name, ...annotation }) =>
    canonicalJson({
      ...annotation,
      levels: (annotation.levels || []).filter((level) => level?.name !== levelName),
    });
  return comparable(submitted) === comparable(current) ? null : `the save changes more than level ${levelName}`;
}

/** Strict base64: Buffer.from(…, 'base64') accepts anything, silently skipping what is not. */
export function isStrictBase64(text) {
  return typeof text === 'string' && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/** Whether `bytes` look like an SSFF file (they start with its header line). */
export function isSsff(bytes) {
  return bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'SSFF';
}

/** `text` safe for one log line: control characters (CR, LF, ESC, …) are escaped. */
export function logSafe(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
