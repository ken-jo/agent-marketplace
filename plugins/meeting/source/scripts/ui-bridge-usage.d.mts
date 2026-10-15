export const HOST_BROADCAST_EVENTS: Set<string>;
export function isTsSource(name: string): boolean;
export function isUiScript(name: string): boolean;
export function walkSources(dir: string, isSource: (name: string) => boolean, out?: string[]): string[];
export function stripComments(src: string): string;
export function scanUiBridgeUsage(uiDir: string): Array<{ file: string; callTool: Set<string>; onEvent: Set<string> }>;
export function resolvePluginRoot(argv: string[], defaultRoot: string): { root: string; explicit: boolean };
