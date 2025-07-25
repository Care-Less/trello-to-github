#! /usr/bin/env bun

import chalk from "chalk";
import { Octokit } from "octokit";
import TOML from "smol-toml";
import invariant from "tiny-invariant";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import z from "zod";
import { type Label, renderGithubLabel, renderTrelloLabel } from "./lib/label";
import { BoardExport, MapFormat } from "./lib/schemas";

yargs(hideBin(process.argv))
	.command(
		"parse-trello <file> <map-file> --gh-key",
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
				})
				.option("gh-key", {
					string: true,
					describe: "The GitHub API key to use",
				})
				.demandOption("gh-key");
		},
		async (argv) => {
			const file = argv.file;
			const mapFile = argv.mapFile;
			invariant(file && mapFile);
			await runParseTrello({ file, mapFile, ghKey: argv.ghKey });
		},
	)
	.demandCommand(1, "")
	.parse();

async function runParseTrello(args: {
	file: string;
	mapFile: string;
	ghKey: string;
}) {
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

	const octokit = new Octokit({ auth: args.ghKey });

	const githubLabels = await octokit.request(
		"GET /repos/{owner}/{repo}/labels",
		{
			owner: "piemot",
			repo: "sample",
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	const trello = exportedResult.data;
	const map = mapResult.data;

	const labels: Label[] = [];

	for (const trelloLabel of trello.labels) {
		const mapped = map.labels.find(
			(labelMap) => labelMap.trello === trelloLabel.name,
		);
		if (!mapped) {
			labels.push({ type: "skipped", trello: trelloLabel });
			continue;
		}
		if (mapped.create) {
			labels.push({
				type: "toCreate",
				trello: trelloLabel,
				github: { name: mapped.github },
			});
			continue;
		}
		// the GitHub label where either the ID or the name matches the GitHub mapping
		const githubLabel = githubLabels.data.find(
			(ghLabel) =>
				ghLabel.id === mapped.github || ghLabel.name === mapped.github,
		);
		if (!githubLabel) {
			labels.push({
				type: "missing",
				trello: trelloLabel,
				githubLookup: mapped.github,
			});
			continue;
		}
		labels.push({ type: "mapped", trello: trelloLabel, github: githubLabel });
	}

	const mappedLabels = labels.filter(
		(l) => l.type === "toCreate" || l.type === "mapped",
	);
	const missingLabels = labels.filter((l) => l.type === "missing");
	const skippedLabels = labels.filter((l) => l.type === "skipped");

	console.log(`Mapping labels: `);
	console.log(
		mappedLabels
			.map(
				(label) => `${renderTrelloLabel(label)} -> ${renderGithubLabel(label)}`,
			)
			.join("\n"),
	);

	const formatter = new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	});
	const unknownLabels = formatter.format(
		missingLabels.map(
			(label) =>
				`${renderTrelloLabel(label)} (${chalk.dim(label.githubLookup)})`,
		),
	);
	console.warn(`[!!!] Could not find labels in GitHub: ${unknownLabels}`);
	const ignoredLabels = formatter.format(
		skippedLabels.map((label) => renderTrelloLabel(label)),
	);
	console.warn(`[!!!] These labels will not be transferred: ${ignoredLabels}`);
}
