/**
 * Who may open which bundle, and where its audio is served from.
 *
 * Project membership (checked by the auth module) is not enough to read or
 * write a bundle: the bundle must be in the user's own bundle list for the
 * project, the list VISP's "Assign annotation tasks" dialog writes. Both
 * clients (Artic and TRATT) only ever open bundles from that list, so this
 * refuses only requests no client of ours makes.
 */

/**
 * The entry for session/name in a `bundlelists` document, or null.
 * Bundles are identified by session and name together: the same bundle name
 * may exist in two sessions.
 */
export function findAssignedBundle(bundleList, session, name) {
  if(typeof session !== "string" || typeof name !== "string") {
    return null;
  }
  const bundles = Array.isArray(bundleList?.bundles) ? bundleList.bundles : [];
  return bundles.find(bundle => bundle?.session === session && bundle?.name === name) ?? null;
}

/**
 * The origin to put in a bundle's audio URL. Each client fetches audio from
 * the host it was loaded from (both apps' vhosts proxy /file here), because
 * TRATT runs under COEP credentialless, which strips cookies from
 * cross-origin requests. The connection's origin passed verifyClient, so it
 * is one of the allowed ones; anything else falls back to the configured
 * MEDIA_FILE_BASE_URL.
 */
export function mediaBaseUrl(connectionOrigin, allowedOrigins, fallbackBaseUrl) {
  if(typeof connectionOrigin === "string" && allowedOrigins.includes(connectionOrigin)) {
    return connectionOrigin;
  }
  return fallbackBaseUrl;
}
