import type { AlertInput, AlertResult, PluginHostApi } from "@ave/plugin-contract";

export interface AlertDiagnostic {
  kind: string;
  status: string;
  field?: string;
}

/** Log programmer/configuration errors without exposing an alert key or slot value. */
export async function raiseWithDiagnostics(
  raise: PluginHostApi["raiseAlert"],
  input: AlertInput,
  log: (diagnostic: AlertDiagnostic) => void,
): Promise<AlertResult> {
  const result = await raise(input);
  const status: string = result.status;
  if (status === "invalid" || status === "kind_not_granted" || status === "kind_not_registered") {
    const field = "field" in result && typeof result.field === "string" ? result.field : undefined;
    log({ kind: input.kind, status, ...(field ? { field } : {}) });
  }
  return result;
}
