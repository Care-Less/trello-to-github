#! /usr/bin/env bun

import TOML from "smol-toml";
import invariant from "tiny-invariant";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import z from "zod";

import { BoardExport, MapFormat } from "./lib/schemas";

yargs(hideBin(process.argv))
	.command(
		"parse-trello <file> <map-file>",
		"Parse a Trello export file and produce a result ready for import into GitHub",
		(yargs) => {
			return yargs
				.positional("file", {
					describe:
						"A path to the Trello exported file. You can get this by going to `https://trello.com/b/<board-id>.json`.",
					type: "string",
				})
				.positional("map-file", {
					describe:
						"A path to a map file, which maps Trello labels to their GitHub equivalents.",
					type: "string",
				});
		},
		async (argv) => {
			const file = argv.file;
			const mapFile = argv.mapFile;
			invariant(file && mapFile);
			await runParseTrello({ file, mapFile });
		},
	)
	.demandCommand(1, "")
	.parse();

async function runParseTrello(args: { file: string; mapFile: string }) {
	const exportFile = Bun.file(args.file);
	const mapFile = Bun.file(args.mapFile);

	const exportedResult = BoardExport.safeParse(await exportFile.json());
	const mapResult = MapFormat.safeParse(TOML.parse(await mapFile.text()));
	if (!exportedResult.success) {
		console.log(`Error in export file (${args.file}):`);
		console.log(z.prettifyError(exportedResult.error));
	}
	if (!mapResult.success) {
		console.log(`Error in map file (${args.mapFile}):`);
		console.log(z.prettifyError(mapResult.error));
	}
	if (!mapResult.success || !exportedResult.success) {
		process.exitCode = 1;
		return;
	}
}
