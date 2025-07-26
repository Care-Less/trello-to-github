import { z } from "zod/v4";

export type Trello = z.infer<typeof BoardExport>;
export const BoardExport = z.object({
	name: z.string(),
	// The lists in the board
	lists: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			closed: z.boolean(),
		}),
	),
	members: z.array(
		z.object({
			id: z.string(),
			fullName: z.string(),
			username: z.string(),
		}),
	),
	actions: z.array(
		z.discriminatedUnion("type", [
			// comment on card
			z.object({
				id: z.string(),
				memberCreator: z.object({
					id: z.string(),
					username: z.string(),
				}),
				data: z.object({
					idCard: z.string(),
					text: z.string(),
				}),
				type: z.literal("commentCard"),
				date: z.date(),
			}),
			// other objects are stripped
			z.object({}),
		]),
	),
	// The cards in the board
	cards: z.array(
		z.object({
			id: z.string(),
			closed: z.boolean(),
			desc: z.string(),
			// The ID of the list it belongs to (see `lists`)
			idList: z.string(),
			// The IDs of members assigned to it
			idMembers: z.array(z.string()),
			labels: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					color: z.string(),
					uses: z.int(),
				}),
			),
			name: z.string(),
		}),
	),
	// The labels in the board
	labels: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			color: z.string(),
			uses: z.int(),
		}),
	),
	// Checklists, which are rendered next to the description of a card (`idCard`).
	checklists: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			idCard: z.string(),
			checkItems: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					state: z.enum(["complete", "incomplete"]),
				}),
			),
		}),
	),
});

export type Map = z.infer<typeof MapFormat>;
export const MapFormat = z.object({
	labels: z.array(
		z.discriminatedUnion("create", [
			// fetch label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// If a string, assumed to be the name of a label. If an int, it's the ID of the label.
				github: z.union([z.string().min(1), z.int()]),
				// Whether to create the label, if it does not exist.
				create: z.literal(false).optional().default(false),
			}),
			// create new label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// The name of the label to create.
				github: z.string().min(1),
				// Whether to create the label, if it does not exist.
				create: z.literal(true),
				// The color to create the GitHub label with.
				color: z
					.string()
					.regex(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i)
					.optional(),
			}),
		]),
	),
	// maps assignees
	members: z.array(
		z.object({
			// The name of the member in Trello.
			trello: z
				.string()
				.min(1)
				.refine((arg) => arg.replace(/^@/, "")),
			// The username of the member in GitHub.
			github: z
				.string()
				.min(1)
				.refine((arg) => arg.replace(/^@/, "")),
		}),
	),
});
