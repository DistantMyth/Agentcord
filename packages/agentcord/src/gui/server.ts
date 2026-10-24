import * as path from "node:path";
import type { AgentcordRelayServer } from "../network";

export function getPublicGuiDir(): string {
	return path.resolve(import.meta.dir, "public");
}

export * from "../network/relay-server";
