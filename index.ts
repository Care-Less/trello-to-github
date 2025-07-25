#! /usr/bin/env bun

import * as p from "@clack/prompts";
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
	p.intro(`${chalk.bold.cyanBright("Trello To GitHub")} v0.1.0`);
	const exportFile = Bun.file(args.file);
	const mapFile = Bun.file(args.mapFile);

	const exportedResult = BoardExport.safeParse(await exportFile.json());
	const mapResult = MapFormat.safeParse(TOML.parse(await mapFile.text()));
	if (!exportedResult.success) {
		p.log.warn(`Failed to parse export file (${args.file}):`);
		p.log.error(z.prettifyError(exportedResult.error));
	}
	if (!mapResult.success) {
		p.log.warn(`Failed to parse map file (${args.mapFile}):`);
		p.log.error(z.prettifyError(mapResult.error));
	}
	if (!mapResult.success || !exportedResult.success) {
		process.exitCode = 1;
		p.outro();
		return;
	}

	const octokit = new Octokit({ auth: args.ghKey });

	const githubLabels = await octokit.request(
		"GET /repos/{owner}/{repo}/labels",
		{
			// TODO: fix this hardcoding
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
				github: { name: mapped.github, color: mapped.color },
			});
			continue;
		}
		// the GitHub label where either the ID or the name matches the GitHub mapping
		const githubLabel = githubLabels.data.find(
			(ghLabel) =>
				(Number.isInteger(mapped.github) && ghLabel.id === mapped.github) ||
				ghLabel.name === mapped.github,
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

	p.note(
		chalk.reset(
			mappedLabels
				.map(
					(label) =>
						`${renderTrelloLabel(label)} -> ${renderGithubLabel(label)}`,
				)
				.join("\n"),
		),
		"Mapping labels:",
	);

	const formatter = new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	});
	const ignoredLabels = formatter.format(
		skippedLabels.map((label) => renderTrelloLabel(label)),
	);
	if (skippedLabels.length > 0) {
		p.log.warn(`These labels will not be transferred: ${ignoredLabels}`);
	}

	const unknownLabels = formatter.format(
		missingLabels.map(
			(label) =>
				`${renderTrelloLabel(label)} (${chalk.dim(label.githubLookup)})`,
		),
	);
	if (missingLabels.length > 0) {
		p.log.error(`Could not find labels in GitHub: ${unknownLabels}`);
		process.exitCode = 1;
		p.outro();
		return;
	}

	if (skippedLabels.length > 0) {
		const conf = await p.confirm({ message: "Would you like to continue?" });
		if (p.isCancel(conf) || !conf) {
			p.cancel("Operation cancelled.");
			return;
		}
	}

	p.outro();
}
