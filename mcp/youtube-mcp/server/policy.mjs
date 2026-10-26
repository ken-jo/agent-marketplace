// Copied unchanged into a pinned npm package's directory before its entry loads.
// An unregistered tool is absent from discovery AND cannot be called by name.
export async function installPolicy(policy, env) {
  const { McpServer } = await import(policy.sdk);
  const allowed = new Set(policy.read);
  if (env.AVE_CONNECTOR_ALLOW_WRITES === "true") for (const name of policy.write ?? []) allowed.add(name);
  if (env.AVE_CONNECTOR_ALLOW_LOCAL_WRITES === "true") for (const name of policy.local ?? []) allowed.add(name);
  for (const name of policy.never ?? []) allowed.delete(name);
  let patched = false;
  for (const method of ["registerTool", "tool"]) {
    const original = McpServer.prototype[method];
    if (typeof original !== "function") continue;
    McpServer.prototype[method] = function (name, ...args) {
      if (!allowed.has(name)) return undefined;
      return original.call(this, name, ...args);
    };
    patched = true;
  }
  if (!patched) throw new Error("Pinned MCP SDK has no supported registration API");
}
