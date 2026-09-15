/**
 * Handshake between the page and the server process it is talking to.
 *
 * Vite hot-reloads the browser from disk but never restarts the Node process, so a session left
 * open across a route change ends up with a new page calling an old server. Express answers the
 * unknown route with an HTML 404, and the failure surfaces as an unreadable parse error at the
 * moment a button is pressed.
 *
 * Both sides import this constant. A stale server reports the old value, the page notices on load,
 * and says what to do — before anything is clicked.
 *
 * Bump it whenever the API surface changes.
 */
export const API_VERSION = "2026-09-14.6";
