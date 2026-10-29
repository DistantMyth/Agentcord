import { expect, test } from "bun:test";
import { MODEL_ROLE_IDS } from "../../tui/src/overlays/model-browser";
import { AgentProviderClient } from "../src/models/provider-client";

test("provider failures and missing credentials never become simulated successful executions", async () => {
	const options = { role: "worker" as const, agentName: "Worker", responsibility: "Implement auth" };
	await expect(new AgentProviderClient().generate("custom/model", "", "", options)).rejects.toThrow("No provider");
	await expect(
		new AgentProviderClient(async () => {
			throw new Error("Invalid API key");
		}).generate("custom/model", "", "", options),
	).rejects.toThrow("Invalid API key");
	await expect(new AgentProviderClient(async () => null).generate("custom/model", "", "", options)).rejects.toThrow(
		"no simulated result",
	);
	expect(MODEL_ROLE_IDS).toEqual(expect.arrayContaining(["king", "queen", "worker", "testgen", "tester"]));
});
