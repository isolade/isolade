// Path resolution lives in @isolade/shared/node/xdg so the sandbox sidecar (a
// separate process that owns $MSB_HOME and the buildkit cache) resolves the
// same dirs. Re-exported here so existing `./xdg` imports keep working.
export * from "@isolade/shared/node/xdg";
