import { z } from "zod/v4";

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
	// The cards in the board
	cards: z.array(
		z.object({
			id: z.string(),
			closed: z.boolean(),
			desc: z.string(),
			// The ID of the list it belongs to (see `lists`)
			idList: z.string(),
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

export const MapFormat = z.object({
	labels: z.array(
		z.union([
			// fetch label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// If a string, assumed to be the name of a label. If an int, it's the ID of the label.
				github: z.union([z.string().min(1), z.int()]),
				// Whether to create the label, if it does not exist.
				create: z.literal(false).optional(),
			}),
			// create new label
			z.object({
				// The name of the label in Trello.
				trello: z.string().min(1),
				// The name of the label to create.
				github: z.string().min(1),
				// Whether to create the label, if it does not exist.
				create: z.literal(true),
			}),
		]),
	),
});
