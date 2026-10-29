#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";
import nativeManifest from "../packages/natives/package.json" with { type: "json" };
import { LEAF_TARGETS } from "../packages/natives/scripts/gen-npm-packages";

/** Reuse the exact published OMP addon instead of requiring a local Rust toolchain. */
async function setup(): Promise<void> {
	const root = path.resolve(import.meta.dir, "..");
	await $`bun install --frozen-lockfile --ignore-scripts`.cwd(root);
	const target = LEAF_TARGETS.find(item => item.os === process.platform && item.cpu === process.arch);
	if (!target)
		throw new Error(
			`No published OMP native addon for ${process.platform}-${process.arch}; use bun setup to build from source`,
		);
	const packageName = `@oh-my-pi/pi-natives-${target.tag}`;
	const metadataResponse = await fetch(`https://registry.npmjs.org/${packageName}/${nativeManifest.version}`);
	if (!metadataResponse.ok)
		throw new Error(`Cannot find ${packageName}@${nativeManifest.version}; use bun setup to build from source`);
	const metadata = (await metadataResponse.json()) as { dist: { tarball: string; integrity: string } };
	if (new URL(metadata.dist.tarball).hostname !== "registry.npmjs.org")
		throw new Error("Unexpected native package registry");
	const response = await fetch(metadata.dist.tarball);
	if (!response.ok) throw new Error(`Native package download failed: ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (metadata.dist.integrity !== `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`)
		throw new Error("Native package integrity verification failed");
	const entries = await new Bun.Archive(bytes).files();
	let installed = 0;
	for (const [file, content] of entries) {
		const filename = path.posix.basename(file);
		if (
			!filename.startsWith(`pi_natives.${target.tag}`) ||
			!filename.endsWith(".node") ||
			!/^pi_natives\.[a-z0-9.-]+\.node$/.test(filename)
		)
			continue;
		await Bun.write(path.join(root, "packages", "natives", "native", filename), content);
		installed++;
	}
	if (!installed) throw new Error("Published native package contains no matching addon");
	await $`bun run gen:tool-views`.cwd(root);
	await $`bun packages/coding-agent/src/cli.ts --version`.cwd(root);
	console.log(`Agentcord ready. OMP native addon ${nativeManifest.version} verified. Run bun run agentcord --help.`);
}

if (import.meta.main) await setup();
