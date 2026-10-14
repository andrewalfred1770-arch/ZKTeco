/**
 * authGate.js — what the Server / Manager login gates should render. Pure, shared by both gates.
 *
 *   'app'        authenticated (or authentication is off / still unknown): render the app only
 *   'login'      authentication is required and there is no token: render ONLY the login screen (app unmounted)
 *   'app+login'  same, but screens hold unsaved edits: keep the app MOUNTED (state preserved in memory) and render the login
 *                screen as a full-screen overlay on top of it
 *
 * Both gates must render `{children}` at the SAME position in every non-'login' branch (a keyed fragment, then the overlay) so React
 * keeps the screens mounted when the overlay appears and disappears.
 */
export function gateView({ authEnabled, token, unsavedCount }) {
  if (authEnabled === true && !token) return unsavedCount > 0 ? 'app+login' : 'login';
  return 'app';
}
