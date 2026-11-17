/**
 * @description Authentication module for VISP.
 *
 * Who the user is comes from the PHP session store, the only authority on
 * whether a session is alive: the PHPSESSID is handed to the PHP API's
 * `?f=session` endpoint (the same check session-manager uses), which answers
 * with the session's user, or with "[]" when the session is unknown or gone.
 *
 * This used to match the cookie against `users.phpSessionId` in MongoDB. That
 * field holds only the most recent sign-in of a user, so signing in on a
 * second browser silently locked the first out of Artic and TRATT ("User not
 * identified"), while the Visp dashboard - which asks PHP - kept working.
 *
 * Whether the user may open the project is still read from MongoDB: the
 * user's username in the `members` of the `projects` document. With the
 * access list on (ACCESS_LIST_ENABLED=true), the user must also hold the
 * access grant (`users.loginAllowed`), as everywhere else in Visp: a
 * deactivated user keeps neither Artic nor TRATT through an old membership.
 */

/** A confirmed session is trusted this long before PHP is asked again. */
const SESSION_CACHE_MS = 15 * 1000;

/** How long to wait for the PHP API before giving up. */
const SESSION_CHECK_TIMEOUT_MS = 5 * 1000;

const DEFAULT_SESSION_URL = "http://apache/api/api.php?f=session";

/**
 * The user named by the PHP API's `?f=session` answer, or null when the
 * session is not signed in. The answer is an ApiResponse whose `body` is the
 * JSON of the session's identity fields, or "[]".
 */
export function sessionUserFromResponse(responseText) {
  const response = JSON.parse(responseText);
  const body = typeof response?.body === "string" ? JSON.parse(response.body) : null;
  if (!body || Array.isArray(body) || typeof body.username !== "string" || body.username === "") {
    return null;
  }
  return body;
}

class VispAuth {
  /**
   * @param app the server (its `db` and `addLog` are used)
   * @param options.fetch fetch implementation (tests)
   * @param options.sessionUrl the PHP API's session check
   * @param options.now clock (tests)
   * @param options.accessListEnabled whether users need the access grant (default: ACCESS_LIST_ENABLED)
   */
  constructor(app, options = {}) {
    this.app = app;
    this.name = "VispAuthModule";
    this.fetch = options.fetch ?? ((...args) => fetch(...args));
    this.sessionUrl = options.sessionUrl ?? process.env.SESSION_VALIDATION_URL ?? DEFAULT_SESSION_URL;
    this.now = options.now ?? (() => Date.now());
    this.accessListEnabled = options.accessListEnabled ?? String(process.env.ACCESS_LIST_ENABLED).toLowerCase() === "true";
    /** PHPSESSID -> { username, expires }; only live sessions are cached. */
    this.sessionCache = new Map();
  }

  /**
   * The username of the live PHP session, or null if there is none. Throws
   * when PHP cannot be asked (unreachable, timeout, unreadable answer).
   */
  async sessionUsername(phpSessionId) {
    const cached = this.sessionCache.get(phpSessionId);
    if (cached && cached.expires > this.now()) {
      return cached.username;
    }
    this.sessionCache.delete(phpSessionId);

    const response = await this.fetch(this.sessionUrl, {
      headers: { Cookie: "PHPSESSID=" + phpSessionId },
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("session check answered HTTP " + response.status);
    }
    const sessionUser = sessionUserFromResponse(await response.text());
    if (!sessionUser) {
      return null;
    }
    this.pruneCache();
    this.sessionCache.set(phpSessionId, {
      username: sessionUser.username,
      expires: this.now() + SESSION_CACHE_MS,
    });
    return sessionUser.username;
  }

  pruneCache() {
    const now = this.now();
    for (const [id, entry] of this.sessionCache) {
      if (entry.expires <= now) {
        this.sessionCache.delete(id);
      }
    }
  }

  async authenticateUser(phpSessionId, projectId) {
    if(!projectId) {
      return {
        authenticated: false,
        reason: "No project id provided"
      };
    }
    if(!phpSessionId) {
      return {
        authenticated: false,
        reason: "No PHP session id provided"
      };
    }
    //both end up in mongo filters or a header, which must only ever receive plain values
    if(typeof projectId !== "string" || typeof phpSessionId !== "string" || /[;\r\n]/.test(phpSessionId)) {
      return {
        authenticated: false,
        reason: "Invalid credentials"
      };
    }

    let username;
    try {
      username = await this.sessionUsername(phpSessionId);
    } catch (error) {
      this.app.addLog("Could not check the PHP session: "+error.message, "error");
      // Not "not signed in": the user may well be, and should retry.
      return {
        authenticated: false,
        reason: "Visp could not confirm who you are right now; try again in a moment"
      };
    }
    if(!username) {
      return {
        authenticated: false,
        reason: "User not identified (not signed in to Visp)"
      };
    }

    let mongo = this.app.db;
    let user = await mongo.collection("users").findOne({ username: username });
    if(!user) {
      return {
        authenticated: false,
        reason: "User not identified (not signed in to Visp)"
      };
    }

    //the same rule as session-manager's authorizeWebSocketUser
    if(this.accessListEnabled && user.loginAllowed !== true) {
      return {
        authenticated: false,
        reason: "User is not authorized to use Visp (no access grant)"
      };
    }

    let project = await mongo.collection("projects").findOne({
      id: projectId,
      "members.username": user.username
    });
    if(!project) {
      return {
        authenticated: false,
        reason: "User is not a member of the project with id "+projectId
      };
    }

    this.app.addLog("Authenticated user "+user.eppn+" ("+user.username+")", "debug");

    return {
      authenticated: true,
      user: user
    };
  }
}

export default VispAuth;
