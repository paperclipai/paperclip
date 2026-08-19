// Development and test builds resolve the workspace package here. The server
// build replaces this compiled shim with the package's built distribution so
// published server installs do not need a separate Runner D npm bootstrap.
export * from "@paperclipai/paperclip-runner";
