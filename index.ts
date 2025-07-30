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
import {
	type Label,
	renderGithubFieldOption,
	renderGithubLabel,
	renderTrelloLabel,
} from "./lib/label";
import { BoardExport, MapFormat } from "./lib/schemas";

const program = new Command()
	.version("v0.1.0")
	.description("Import a Trello Project into GitHub Issues and Projects.")
	.option("--github-token <token>", "GitHub Personal Access Token")
	.option(
		"-m, --map <file.toml>",
		"A path to a file that maps users and labels",
	)
	// TODO
	.option(
		"--dry-run",
		"Preview what will be transferred (no changes will be made)",
	)
	.option(
		"--keep-closed",
		"Also transfer cards that have been closed (archived)",
	)
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

function fail(message?: string, exitCode = 1): never {
	p.outro(message);
	process.exit(exitCode);
}

const listConjunction = new Intl.ListFormat("en", {
	style: "long",
	type: "conjunction",
});

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
		ghToken: async () => {
			if (opts.githubToken && typeof opts.githubToken === "string") {
				return opts.githubToken;
			}
			if (typeof Bun.env.PAT === "string" && Bun.env.PAT.length > 1) {
				return Bun.env.PAT;
			}

			return p.password({
				message: `Provide a ${chalk.underline.blue(terminalLink("Personal Access Token", "https://github.com/settings/tokens"))} with at least the \`${chalk.green("repo")}\` scope.`,
				validate: (val) => {
					if (!val) {
						return "Please enter a token.";
					}
				},
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
	fail();
}

const trello = getTrello.result.data;
const map = getMap.result.data;

if (!opts.keepClosed) {
	trello.cards.filter((card) => !card.closed);
}

const octokit = new Octokit({ auth: group.ghToken });

const repoData = {
	owner:
		typeof map.repo.owner === "string" ? map.repo.owner : map.repo.owner.login,
	repo: map.repo.repo,
};
const defaultHeaders = { "X-GitHub-Api-Version": "2022-11-28" };
const baseRequest = { ...repoData, headers: defaultHeaders };

const githubLabels = await octokit.request("GET /repos/{owner}/{repo}/labels", {
	...baseRequest,
});
const githubMilestones = await octokit.request(
	"GET /repos/{owner}/{repo}/milestones",
	{
		...baseRequest,
	},
);

const users = [];
for (const user of map.users) {
	try {
		const githubUser = await octokit.request("GET /users/{username}", {
			username: user.github,
			headers: defaultHeaders,
		});
		users.push({ trelloName: user.trello, github: githubUser });
	} catch (e) {
		if (e instanceof RequestError && e.status === 404) {
			// this member doesn't exist
			users.push({
				trelloName: user.trello,
				githubName: user.github,
				github: null,
			});
		} else {
			throw e;
		}
	}
}

async function getProjectInfo() {
	if (!map.project) {
		return null;
	}
	const queryTarget =
		typeof map.repo.owner === "object" && map.repo.owner.type === "organization"
			? "organization"
			: "user";
	const queryLogin =
		typeof map.repo.owner === "object" ? map.repo.owner.login : map.repo.owner;
	const response = await octokit.graphql(`
		query {
			${queryTarget}(login: "${queryLogin}") {
				projectV2(number: ${map.project}) {
					id
					title
					fields(first: 100) {
						nodes {
							... on ProjectV2FieldCommon {
								id
								name
							}
							... on ProjectV2SingleSelectField {
								options {
									id
									name
									color
								}
							}
						}
					}
				}  
			}
		}
  `);

	// Color is one of: BLUE, GRAY, GREEN, ORANGE, PINK, PURPLE, RED, YELLOW

	// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed, but accessing results mirrors the query.
	const res = response as any;

	const statusField: StatusFieldInfo = res[
		queryTarget
	].projectV2.fields.nodes.find(
		(field: Pick<StatusFieldInfo, "name">) => field.name === "Status",
	);

	invariant(
		statusField,
		"every Project should have a Status field (probably? If this is violated, please file an issue.)",
	);

	return {
		projectId: res[queryTarget].projectV2.id,
		projectName: res[queryTarget].projectV2.title,
		statusFieldId: statusField.id,
		statusFieldOptions: statusField.options,
	};
}

const projectInfo = await getProjectInfo();

const labels: Label[] = [];

const invalidLists = [];

// map of Trello List ID to milestone info
type MilestoneInfo = { id: number; number: number; title: string };
const validMilestones: Map<string, MilestoneInfo> = new Map();
const missingMilestones = [];

type StatusFieldInfo = {
	name: string;
	id: string;
	options: { id: string; name: string; color: string }[];
};
let usedStatusWithoutProject = false;
// map of Trello List ID to status field info
const validStatusFields: Map<string, StatusFieldInfo["options"][number]> =
	new Map();
const missingStatusFields = [];

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

for (const mapping of map.lists) {
	const trelloList = trello.lists.find(
		(list) => list.id === mapping.list || list.name === mapping.list,
	);
	if (!trelloList) {
		invalidLists.push(mapping.list);
		continue;
	}

	if (mapping.label) {
		const githubLabel = githubLabels.data.find(
			(ghLabel) =>
				(Number.isInteger(mapping.label) && ghLabel.id === mapping.label) ||
				ghLabel.name === mapping.label,
		);
		if (!githubLabel) {
			labels.push({
				type: "missingList",
				githubLookup: mapping.label,
				trelloList,
			});
			continue;
		}
		labels.push({ type: "listMapped", github: githubLabel, trelloList });
	}

	if (mapping.milestone) {
		const githubMilestone = githubMilestones.data.find(
			(milestone) =>
				(Number.isInteger(mapping.milestone) &&
					(milestone.id === mapping.milestone ||
						milestone.number === mapping.milestone)) ||
				milestone.title === mapping.milestone,
		);
		if (!githubMilestone) {
			missingMilestones.push(mapping.milestone);
			continue;
		}
		validMilestones.set(trelloList.id, githubMilestone);
	}

	if (projectInfo && mapping.status) {
		if (!projectInfo) {
			usedStatusWithoutProject = true;
			continue;
		}
		const projectStatusField = projectInfo.statusFieldOptions.find(
			(field) => field.id === mapping.status || field.name === mapping.status,
		);
		if (!projectStatusField) {
			missingStatusFields.push(mapping.status);
			continue;
		}
		validStatusFields.set(trelloList.id, projectStatusField);
	}
}

const skippedLists: { id: string; name: string }[] = [];

for (const listKey of map.skip.lists) {
	const trelloList = trello.lists.find(
		(list) => list.id === listKey || list.name === listKey,
	);

	if (trelloList) {
		skippedLists.push(trelloList);
	} else {
		invalidLists.push(listKey);
	}
}

trello.cards.filter(
	(card) => !skippedLists.some((list) => list.id === card.idList),
);

const mappedLabels = labels.filter(
	(l) =>
		l.type === "toCreate" || l.type === "mapped" || l.type === "listMapped",
);
const missingLabels = labels.filter(
	(l) => l.type === "missing" || l.type === "missingList",
);
const skippedLabels = labels.filter((l) => l.type === "skipped");

p.note(
	chalk.reset(
		mappedLabels
			.map((label) => {
				const origin =
					label.type === "listMapped"
						? `From list ${chalk.underline.bold(label.trelloList.name)}`
						: renderTrelloLabel(label);
				return `${origin} -> ${renderGithubLabel(label)}`;
			})
			.join("\n"),
	),
	"Mapping labels:",
);

if (validStatusFields.size > 0) {
	p.note(
		chalk.reset(
			[...validStatusFields.entries()]
				.map(([listId, field]) => {
					return `${chalk.bold(trello.lists.find((list) => list.id === listId)?.name)} -> ${renderGithubFieldOption(field)}`;
				})
				.join("\n"),
		),
		"Mapping columns:",
	);
}

if (skippedLabels.length > 0) {
	const ignoredLabels = listConjunction.format(
		skippedLabels.map((label) => renderTrelloLabel(label)),
	);
	p.log.warn(`These labels will not be transferred: ${ignoredLabels}`);
}

if (missingLabels.length > 0) {
	const unknownLabels = listConjunction.format(
		missingLabels.map((label) =>
			label.type === "missing"
				? `${renderTrelloLabel(label)} (${chalk.dim(label.githubLookup)})`
				: `(From list ${chalk.underline.bold(label.trelloList.name)}) - ${chalk.dim(label.githubLookup)}`,
		),
	);
	p.log.error(`Could not find labels in GitHub: ${unknownLabels}`);
}

if (invalidLists.length > 0) {
	const unknownLists = listConjunction.format(invalidLists);
	p.log.error(
		`These lists (see ${chalk.dim("map.lists[].list")} or ${chalk.dim("map.skip.lists[]")}) do not exist in Trello: ${unknownLists}`,
	);
}

if (missingMilestones.length > 0) {
	const unknownMilestones = listConjunction.format(
		missingMilestones.map((i) => i.toString()),
	);
	p.log.error(
		`These milestones (see ${chalk.dim("map.lists[].milestone")}) do not exist in GitHub: ${unknownMilestones}`,
	);
}

if (missingStatusFields.length > 0) {
	const unknownStatusFields = listConjunction.format(
		missingStatusFields.map((i) => i.toString()),
	);
	p.log.error(
		`These status fields (see ${chalk.dim("map.lists[].status")}) do not exist in the project (${chalk.bold(projectInfo?.projectName)}): ${unknownStatusFields}`,
	);
}

if (usedStatusWithoutProject) {
	p.log.error(
		`The ${chalk.dim("`map.lists[].status`")} option can only be used if ${chalk.dim("`map.project`")} is set.`,
	);
}

const validMembers = users.filter((mem) => mem.github);
const invalidMembers = users.filter((mem) => !mem.github);

if (invalidMembers.length > 0) {
	const missingUsers = listConjunction.format(
		invalidMembers.map(
			(member) =>
				`${chalk.bold(`@${member.trelloName}`)} (${chalk.dim(`@${member.githubName}`)})`,
		),
	);
	p.log.error(
		`The following Trello users are not GitHub Users: ${missingUsers}`,
	);
}

if (
	missingLabels.length > 0 ||
	invalidMembers.length > 0 ||
	invalidLists.length > 0 ||
	missingMilestones.length > 0 ||
	missingStatusFields.length > 0 ||
	usedStatusWithoutProject
) {
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
	const existingLabels = listConjunction.format(
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

type TrelloCard = (typeof trello.cards)[number];

function getDescriptionForCard(card: TrelloCard): string {
	let body = "";
	if (card.desc.length > 0) {
		body += `${card.desc}\n\n---\n\n`;
	}

	const checklistStr = getChecklistContentForCard(card);
	if (checklistStr) {
		body += `\n${checklistStr}\n`;
	}
	body += `\n---\n> Migrated from [Trello Card](${card.url})`;
	body += card.attachments
		.map((attachment) => `- [${attachment.name}](${attachment.url})`)
		.join("\n");

	return body;
}

function getLabelsForCard(card: TrelloCard): string[] {
	const res = [];
	for (const trelloName of card.labels.map((label) => label.name)) {
		const found = mappedLabels.find(
			(label) =>
				label.type !== "listMapped" && label.trello.name === trelloName,
		);
		if (found) {
			res.push(found.github.name);
		}
	}

	const listLabel = mappedLabels.find(
		(label) =>
			label.type === "listMapped" && label.trelloList.id === card.idList,
	);
	if (listLabel) {
		res.push(listLabel.github.name);
	}

	return res;
}

function getChecklistContentForCard(card: TrelloCard): string | null {
	const res = [];
	const checklists = card.idChecklists
		.map((id) => trello.checklists.find((checklist) => checklist.id === id))
		.filter((check) => check !== undefined);

	if (checklists.length < 1) {
		return null;
	}

	res.push("\n## Checklists");
	for (const checklist of checklists) {
		res.push(`### ${checklist.name}`);
		for (const item of checklist.checkItems) {
			if (item.state === "complete") {
				res.push(`- [x] ${item.name}`);
			} else {
				res.push(`- [ ] ${item.name}`);
			}
		}
	}

	return res.join("\n");
}

function getCommentsForCard(card: TrelloCard): string[] {
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

async function addIssueToProject(issueNodeId: string) {
	invariant(
		projectInfo,
		"projectInfo must be set to call `addIssueToProject()`.",
	);
	const res = await octokit.graphql(`
	mutation {
		addProjectV2ItemById(input: {projectId: "${projectInfo.projectId}" contentId: "${issueNodeId}"}) {
			item {
				id
			}
		}
	}`);

	// biome-ignore lint/suspicious/noExplicitAny: The GraphQL API is not typed, but accessing results mirrors the query.
	return (res as any).addProjectV2ItemById.item.id;
}

async function setIssueStatus(itemId: string, statusId: string) {
	invariant(projectInfo, "projectInfo must be set to call `setIssueStatus()`.");
	await octokit.graphql(`
		mutation {
			updateProjectV2ItemFieldValue(
				input: {projectId: "${projectInfo.projectId}", itemId: "${itemId}", fieldId: "${projectInfo.statusFieldId}", value: {singleSelectOptionId: "${statusId}"}}
			) {
				projectV2Item {
					fieldValueByName(name: "Status") {
						... on ProjectV2ItemFieldSingleSelectValue {
							name
						}
					}
				}
			}
		}`);
}

const spin = p.spinner({ indicator: "timer" });
spin.start(`Creating ${chalk.blue(trello.cards.length)} issues`);

for (const [i, card] of trello.cards.entries()) {
	const issue = await octokit.request("POST /repos/{owner}/{repo}/issues", {
		...baseRequest,
		title: card.name,
		body: getDescriptionForCard(card),
		labels: getLabelsForCard(card),
		assignees: mapMemberIds(card.idMembers),
		milestone: validMilestones.get(card.id)?.number,
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

	if (projectInfo) {
		const itemId = await addIssueToProject(issue.data.node_id);
		const status = validStatusFields.get(card.id);
		if (status) {
			await setIssueStatus(itemId, status.id);
		}
	}

	spin.message(
		`Creating ${chalk.blue(trello.cards.length)} issues • issue ${chalk.blue(i + 1)}/${chalk.blue(trello.cards.length)}`,
	);
}

spin.stop(`Created ${chalk.blue(trello.cards.length)} issues`);
p.outro();
