#! /usr/bin/env bun

import * as p from "@clack/prompts";
import chalk from "chalk";
import { Octokit, RequestError } from "octokit";
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

	const trello = exportedResult.data;
	const map = mapResult.data;

	const octokit = new Octokit({ auth: args.ghKey });

	// TODO: fix this hardcoding
	const repoData = { owner: "piemot", repo: "sample" };
	const defaultHeaders = { "X-GitHub-Api-Version": "2022-11-28" };
	const baseRequest = { ...repoData, headers: defaultHeaders };

	const githubLabels = await octokit.request(
		"GET /repos/{owner}/{repo}/labels",
		{ ...baseRequest },
	);
	const members = [];
	for (const member of map.members) {
		try {
			const githubMember = await octokit.request("GET /users/{username}", {
				username: member.github,
				headers: defaultHeaders,
			});
			members.push({ trelloName: member.trello, github: githubMember });
		} catch (e) {
			if (e instanceof RequestError && e.status === 404) {
				members.push({
					trelloName: member.trello,
					github: null,
					githubName: member.github,
				});
			} else {
				throw e;
			}
		}
	}

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
	if (skippedLabels.length > 0) {
		const ignoredLabels = formatter.format(
			skippedLabels.map((label) => renderTrelloLabel(label)),
		);
		p.log.warn(`These labels will not be transferred: ${ignoredLabels}`);
	}

	if (missingLabels.length > 0) {
		const unknownLabels = formatter.format(
			missingLabels.map(
				(label) =>
					`${renderTrelloLabel(label)} (${chalk.dim(label.githubLookup)})`,
			),
		);
		p.log.error(`Could not find labels in GitHub: ${unknownLabels}`);
	}

	const validMembers = members.filter((mem) => mem.github);
	const invalidMembers = members.filter((mem) => !mem.github);

	if (invalidMembers.length > 0) {
		const missingUsers = formatter.format(
			invalidMembers.map(
				(member) =>
					`${chalk.bold(`@${member.trelloName}`)} (${chalk.dim(`@${member.githubName}`)})`,
			),
		);
		p.log.error(
			`The following Trello users are not GitHub Users: ${missingUsers}`,
		);
	}

	if (missingLabels.length > 0 || invalidMembers.length > 0) {
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

	const labelsToCreate = labels.filter((l) => l.type === "toCreate");
	const existingLabelsToCreate = labelsToCreate.filter((label) =>
		githubLabels.data.some((ghLabel) => ghLabel.name === label.github.name),
	);

	if (existingLabelsToCreate.length > 0) {
		const existingLabels = formatter.format(
			existingLabelsToCreate.map((label) => renderGithubLabel(label)),
		);
		p.log.warn(`These labels already exist in GitHub: ${existingLabels}`);
		const conf = await p.confirm({
			message: "Are you sure you would like to continue creating them?",
		});
		if (p.isCancel(conf) || !conf) {
			p.cancel("Operation cancelled.");
			return;
		}
	}

	if (labelsToCreate.length > 0) {
		const spin = p.spinner({ indicator: "timer" });
		spin.start(`Creating labels [0/${labelsToCreate.length}]`);
		for (const [count, label] of labelsToCreate.entries()) {
			await octokit.request("POST /repos/{owner}/{repo}/labels", {
				...baseRequest,
				name: label.github.name,
				color: label.github.color?.trim().replace(/^#/, ""),
			});
			spin.message(`Creating labels [${count + 1}/${labelsToCreate.length}]`);
		}
		spin.stop(`Created ${labelsToCreate.length} labels.`);
	}

	function mapLabels(trelloLabels: string[]): string[] {
		const res = [];
		for (const trelloName of trelloLabels) {
			const found = labels.find((label) => label.trello.name === trelloName);
			invariant(
				found,
				"There should not exist a Trello label that is not in `labels`.",
			);
			if (found.type === "mapped" || found.type === "toCreate") {
				res.push(found.github.name);
			}
		}
		return res;
	}

	function mapMemberIds(trelloMemberIds: string[]): string[] {
		return trelloMemberIds
			.map((trelloId) => {
				const trelloMember = trello.members.find((mem) => mem.id === trelloId);
				if (!trelloMember) return null;

				// Trello members can be searched by ID, username, or full name
				const member = validMembers.find((mem) =>
					[
						trelloMember.id,
						trelloMember.username,
						trelloMember.fullName,
					].includes(mem.trelloName),
				);
				if (!member?.github) return null;
				return member.github.data.login;
			})
			.filter((m) => m !== null);
	}

	function getDescription(card: (typeof trello.cards)[number]): string {
		// TODO: if has checklist, add to description
		return card.desc;
	}

	for (const card of trello.cards) {
		await octokit.request("POST /repos/{owner}/{repo}/issues", {
			...baseRequest,
			title: card.name,
			body: getDescription(card),
			labels: mapLabels(card.labels.map((l) => l.name)),
			assignees: mapMemberIds(card.idMembers),
			// milestone: 1,
		});
	}

	p.outro();
}
