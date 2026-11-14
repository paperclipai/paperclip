// Browser-safe names shared by the local board's server and its pages.
/** Header the board's own pages send; only that origin can read the token. */
export const LOCAL_OPERATOR_HEADER = "x-paperclip-local-operator";
/** Live-events socket query parameter carrying the same token. */
export const LOCAL_OPERATOR_SOCKET_PARAM = "operator";
/** URL fragment the sign-in redirect uses to hand the token to the board page. */
export const LOCAL_OPERATOR_FRAGMENT_KEY = "paperclip-local-operator";
