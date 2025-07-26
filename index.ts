#! /usr/bin/env bun

import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command, Option } from "commander";
import { Octokit, RequestError } from "octokit";
import TOML from "smol-toml";
import terminalLink from "terminal-link";
import invariant from "tiny-invariant";
import z from "zod";
import { type Label, renderGithubLabel, renderTrelloLabel } from "./lib/label";
import { BoardExport, MapFormat } from "./lib/schemas";

const program = new Command()
	.version("v0.1.0")
	.description("Import a Trello Project into GitHub Issues and Projects.")
	.option("--github-token <token>", "GitHub Personal Access Token")
	.option(
		"--repo, --github-repo <owner/repo>",
		"the owner and repository to export to",
	)
	.option(
		"-m, --map <file.toml>",
		"A path to a file that maps users and labels",
	)
	// TODO
	.option(
		"--dry-run",
		"Preview what will be transferred (no changes will be made)",
	)
	// TODO
	.option("--no-interactive", "error if additional inputs are required")
	.addOption(
		new Option(
			"--trello-export <file.json>",
			`a path to a Trello exported file.\nyou can get this by downloading ${chalk.blue.underline(
				"https://trello.com/b/<board-id>.json",
			)}`,
		).conflicts("trelloUrl"),
	)
	.addOption(
		new Option("--trello-url <url>", "the URL to your Trello board").conflicts(
			"trelloExport",
		),
	);

program.parse();
const opts = program.opts();

p.intro(`${chalk.bold.cyanBright("Trello To GitHub")} v0.1.0`);

function onCancel() {
	p.cancel("Operation cancelled.");
	process.exit(0);
}

function fail(message?: string, exitCode = 1) {
	p.outro(message);
	process.exit(exitCode);
}

const group = await p.group(
	{
		mapIsCreated: async () => {
			if (opts.map && typeof opts.map === "string") {
				return true;
			}

			const confirm = await p.confirm({
				message: `Have you created a ${chalk.green("map.toml")} file?`,
			});
			if (!confirm) {
				// TODO: add `create-map` subcommand to help building a `map.toml` file
				p.cancel("Run $0 create-map to build this file.");
				process.exit(0);
			}
		},
		repo: async () => {
			if (
				opts.githubRepo &&
				typeof opts.githubRepo === "string" &&
				/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(opts.githubRepo)
			) {
				return opts.githubRepo;
			}

			return p.text({
				message: "Which repository are you importing into?",
				placeholder: "owner/repo",
				validate: (val) => {
					if (!val) return "Please enter a path.";
					if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(val))
						return `Please enter an ${chalk.red("owner/repo")} pair.`;
				},
			});
		},
		ghToken: async () => {
			if (opts.githubToken && typeof opts.githubToken === "string") {
				return opts.githubToken;
			}

			return p.password({
				message: `Provide a ${chalk.underline.blue(terminalLink("Personal Access Token", "https://github.com/settings/tokens"))} with at least the \`${chalk.green("repo")}\` scope.`,
			});
		},
		mapFile: async () => {
			if (opts.map && typeof opts.map === "string" && existsSync(opts.map)) {
				return opts.map;
			}

			return p.text({
				message: `Where is your ${chalk.green("map.toml")} file?`,
				placeholder: "./map.toml",
				validate: (val) => {
					if (!val) {
						return "Please enter a path.";
					} else if (!val.endsWith(".toml")) {
						return `The ${chalk.green("map.toml")} file (${chalk.red(val)}) must be a TOML file.`;
					} else if (!existsSync(val)) {
						return `The path ${chalk.red(val)} does not exist.`;
					}
				},
			});
		},
		trelloImportType: async () => {
			if (opts.trelloExport) {
				return "file";
			} else if (opts.trelloUrl) {
				return "url";
			}

			return p.select({
				message: "How would you like to provide your Trello board?",
				options: [
					{
						label: "via URL",
						value: "url",
						hint: "https://trello.com/b/[board-id]",
					},
					{
						label: "via downloaded file",
						value: "file",
						hint: "./export.json",
					},
				],
			});
		},
		trelloImportPath: async ({ results: { trelloImportType } }) => {
			if (opts.trelloExport || opts.trelloUrl) {
				return (opts.trelloExport || opts.trelloUrl) as string;
			}

			if (trelloImportType === "url") {
				return p.text({
					message: "Please enter the URL of your Trello board.",
					placeholder: "https://trello.com/b/[board-id]",
					validate: (val) => {
						const url = URL.parse(val);
						if (!val) {
							return "Please enter a URL.";
						} else if (!url) {
							return "Please enter a valid URL.";
						} else if (url.hostname !== "trello.com") {
							return "Please enter a Trello link.";
						} else if (!/\/b\/\d+/.test(url.pathname)) {
							return "Please enter a Trello board link.";
						}
					},
				});
			} else {
				return p.text({
					message: "Please enter the path to your Trello export file.",
					placeholder: "./export.json",
					validate: (val) => {
						if (!val) {
							return "Please enter a path.";
						} else if (!val.endsWith(".json")) {
							return `The ${chalk.green("export.json")} file (${chalk.red(val)}) must be a JSON file.`;
						} else if (!existsSync(val)) {
							return `The path ${chalk.red(val)} does not exist.`;
						}
					},
				});
			}
		},
	},
	{ onCancel },
);

async function getTrelloData(): Promise<{
	result: ReturnType<typeof BoardExport.safeParse>;
	source: string;
}> {
	let sourceType: "url" | "file";
	let source: string;

	if (opts.trelloUrl) {
		sourceType = "url";
		source = opts.trelloUrl;
	} else if (opts.trelloExport) {
		sourceType = "file";
		source = opts.trelloExport;
	} else {
		sourceType = group.trelloImportType;
		source = group.trelloImportPath as string;
	}

	let trelloVal: unknown;
	if (sourceType === "url") {
		const resp = await fetch(source);
		if (!resp.ok) {
			p.note(
				await resp.body?.text(),
				`HTTP error fetching Trello source [${chalk.red(resp.status)}]`,
			);
			p.cancel(
				`Failed to fetch trello source from ${chalk.underline.cyan(source)}.`,
			);
			process.exit(1);
		}
		trelloVal = await resp.json();
	} else {
		trelloVal = await Bun.file(source).json();
	}

	return { result: BoardExport.safeParse(trelloVal), source };
}

async function getMapData(): Promise<{
	result: ReturnType<typeof MapFormat.safeParse>;
	source: string;
}> {
	const source = group.mapFile;
	const mapVal: unknown = TOML.parse(await Bun.file(source).text());

	return { result: MapFormat.safeParse(mapVal), source };
}

const getTrello = await getTrelloData();
const getMap = await getMapData();

if (!getTrello.result.success) {
	p.log.warn(`Failed to parse export file (${getTrello.source}):`);
	p.log.error(z.prettifyError(getTrello.result.error));
}
if (!getMap.result.success) {
	p.log.warn(`Failed to parse map file (${getMap.source}):`);
	p.log.error(z.prettifyError(getMap.result.error));
}

if (!getTrello.result.success || !getMap.result.success) {
	p.outro();
	process.exit(1);
}

const trello = getTrello.result.data;
const map = getMap.result.data;

const octokit = new Octokit({ auth: group.ghToken });

// TODO: fix this hardcoding
const repoData = { owner: "piemot", repo: "sample" };
const defaultHeaders = { "X-GitHub-Api-Version": "2022-11-28" };
const baseRequest = { ...repoData, headers: defaultHeaders };

const githubLabels = await octokit.request("GET /repos/{owner}/{repo}/labels", {
	...baseRequest,
});

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
			// this member doesn't exist
			members.push({
				trelloName: member.trello,
				githubName: member.github,
				github: null,
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
				(label) => `${renderTrelloLabel(label)} -> ${renderGithubLabel(label)}`,
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
	fail();
}

if (skippedLabels.length > 0) {
	const conf = await p.confirm({ message: "Would you like to continue?" });
	if (p.isCancel(conf) || !conf) {
		onCancel();
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
		onCancel();
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

function mapMemberId(trelloMemberId: string): string | null {
	const trelloMember = trello.members.find((mem) => mem.id === trelloMemberId);
	if (!trelloMember) return null;

	// Trello members can be searched by ID, username, or full name
	const member = validMembers.find((mem) =>
		[trelloMember.id, trelloMember.username, trelloMember.fullName].includes(
			mem.trelloName,
		),
	);
	if (!member?.github) return null;
	return member.github.data.login;
}

function mapMemberIds(trelloMemberIds: string[]): string[] {
	return trelloMemberIds.map(mapMemberId).filter((m) => m !== null);
}

function getDescription(card: (typeof trello.cards)[number]): string {
	// TODO: if has checklist, add to description
	return card.desc;
}

function getCommentsForCard(card: (typeof trello.cards)[number]): string[] {
	const res = [];
	const commentActions = trello.actions.filter(
		(action) => action.type === "commentCard" && action.data.idCard === card.id,
	);
	commentActions.sort((a, b) => a.date.getTime() - b.date.getTime());

	for (const action of commentActions) {
		const member = mapMemberId(action.memberCreator.id);
		const memberString = member
			? `@${member}`
			: `\`@${action.memberCreator.username}\``;

		const header = `## ${memberString} • ${action.date.toLocaleDateString()}`;
		res.push(`${header}\n${action.data.text}`);
	}

	return res;
}

for (const card of trello.cards) {
	const issue = await octokit.request("POST /repos/{owner}/{repo}/issues", {
		...baseRequest,
		title: card.name,
		body: getDescription(card),
		labels: mapLabels(card.labels.map((l) => l.name)),
		assignees: mapMemberIds(card.idMembers),
		// milestone: 1,
	});

	const comments = getCommentsForCard(card);
	for (const comment of comments) {
		await octokit.request(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			{
				...baseRequest,
				issue_number: issue.data.number,
				body: comment,
			},
		);
	}
}

p.outro();
