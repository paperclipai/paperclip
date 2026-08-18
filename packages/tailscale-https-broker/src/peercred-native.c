#define _GNU_SOURCE
#include <errno.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

static napi_value throw_last_error(napi_env env, const char *operation) {
  char message[256];
  (void)snprintf(message, sizeof(message), "%s failed: %s", operation, strerror(errno));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value get_peer_credentials(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "getPeerCredentials requires a non-negative file descriptor");
    return NULL;
  }

  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
    return throw_last_error(env, "getsockopt(SO_PEERCRED)");
  }
  if (length != sizeof(credentials) || credentials.pid < 0) {
    napi_throw_error(env, NULL, "getsockopt(SO_PEERCRED) returned invalid credentials");
    return NULL;
  }

  napi_value result;
  napi_value pid;
  napi_value uid;
  napi_value gid;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_int32(env, credentials.pid, &pid) != napi_ok ||
      napi_create_uint32(env, credentials.uid, &uid) != napi_ok ||
      napi_create_uint32(env, credentials.gid, &gid) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid) != napi_ok ||
      napi_set_named_property(env, result, "uid", uid) != napi_ok ||
      napi_set_named_property(env, result, "gid", gid) != napi_ok) {
    napi_throw_error(env, NULL, "failed to create SO_PEERCRED result");
    return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "getPeerCredentials", NAPI_AUTO_LENGTH,
                           get_peer_credentials, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getPeerCredentials", function) != napi_ok) {
    napi_throw_error(env, NULL, "failed to initialize peercred native binding");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
