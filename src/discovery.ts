import type { ComfyApiClient } from "./comfy-client.ts";
import { ComfyUpstreamError, HttpError } from "./errors.ts";
import { MODEL_GUIDE_VERSION, MODEL_GUIDES } from "./model-guides.ts";

const CACHE_TTL_MS = 15_000;
const MAX_MODEL_FOLDERS = 128;
const LOADER_MODEL_FOLDERS: Record<string, { input: string; folder: string }> = {
	UNETLoader: { input: "unet_name", folder: "diffusion_models" },
	CLIPLoader: { input: "clip_name", folder: "text_encoders" },
	VAELoader: { input: "vae_name", folder: "vae" },
};

type JsonRecord = Record<string, unknown>;
type NodeMap = Record<string, JsonRecord>;

interface Cached<T> {
	value: T;
	expiresAt: number;
}

export interface DiscoveryPageOptions {
	limit: number;
	offset: number;
	query?: string;
}

export class ComfyDiscovery {
	private readonly comfy: ComfyApiClient;
	private nodesCache: Cached<NodeMap> | null = null;
	private nodesPending: Promise<NodeMap> | null = null;
	private foldersCache: Cached<string[]> | null = null;
	private foldersPending: Promise<string[]> | null = null;
	private readonly modelFolderCache = new Map<string, Cached<string[]>>();
	private readonly modelFolderPending = new Map<string, Promise<string[]>>();

	constructor(comfy: ComfyApiClient) {
		this.comfy = comfy;
	}

	async listNodes(options: DiscoveryPageOptions): Promise<Record<string, unknown>> {
		const nodes = await this.getNodes();
		const query = normalizedText(options.query ?? "");
		const matching = Object.entries(nodes)
			.map(([nodeId, schema]) => compactNode(nodeId, schema))
			.filter((node) => !query || normalizedText(`${node.node_id} ${node.display_name} ${node.category} ${node.description}`).includes(query))
			.sort((a, b) => String(a.node_id).localeCompare(String(b.node_id)));
		const page = matching.slice(options.offset, options.offset + options.limit);
		return {
			nodes: page,
			pagination: pagination(options.limit, options.offset, matching.length, page.length),
		};
	}

	async getNode(nodeId: string): Promise<JsonRecord> {
		const schema = (await this.getNodes())[nodeId];
		if (!schema) throw new HttpError(404, "node_not_found", `ComfyUI node ${nodeId} was not found`);
		return schema;
	}

	async listModels(options: DiscoveryPageOptions & { folder?: string }): Promise<Record<string, unknown>> {
		let models: Array<{ folder: string; name: string }>;
		if (options.folder) {
			const folders = await this.getModelFolders();
			if (!folders.includes(options.folder)) {
				throw new HttpError(404, "model_folder_not_found", `ComfyUI model folder ${options.folder} was not found`);
			}
			models = (await this.getModelFolder(options.folder)).map((name) => ({ folder: options.folder!, name }));
		} else {
			models = await this.getAllModels();
		}

		const query = normalizedText(options.query ?? "");
		const matching = models
			.filter((model) => !query || normalizedText(`${model.folder}/${model.name}`).includes(query))
			.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
		const page = matching.slice(options.offset, options.offset + options.limit);
		return {
			models: page,
			pagination: pagination(options.limit, options.offset, matching.length, page.length),
		};
	}

	async getModel(folder: string, name: string): Promise<Record<string, unknown>> {
		const folders = await this.getModelFolders();
		if (!folders.includes(folder)) throw new HttpError(404, "model_folder_not_found", `ComfyUI model folder ${folder} was not found`);
		if (!(await this.getModelFolder(folder)).includes(name)) {
			throw new HttpError(404, "model_not_found", `Installed ComfyUI model ${folder}/${name} was not found`);
		}

		const nodes = await this.getNodes();
		const loaders = findLoaderChoices(nodes, name);
		return { folder, name, installed: true, loaders };
	}

	async modelGuide(model: string): Promise<Record<string, unknown>> {
		const normalized = normalizedText(model).replace(/[^a-z0-9]+/g, "");
		const guide = MODEL_GUIDES.find((candidate) =>
			[candidate.id, candidate.title, ...candidate.aliases]
				.some((alias) => normalizedText(alias).replace(/[^a-z0-9]+/g, "") === normalized),
		);
		if (!guide) {
			return {
				guide_version: MODEL_GUIDE_VERSION,
				status: "not_available",
				model,
				message: "No curated guide is available for this model. No recommendations were inferred.",
			};
		}

		const [installedModels, nodes] = await Promise.all([this.getAllModels(), this.getNodes()]);
		const modelFiles = guide.model_files.map((file) => {
			const expectedFolder = expectedModelFolder(file.loader_node, file.loader_input);
			const folderMatch = expectedFolder === null
				? undefined
				: installedModels.find((modelFile) => modelFile.folder === expectedFolder && modelFile.name === file.filename);
			const loaderEvidence = loaderChoiceEvidence(nodes, file.loader_node, file.loader_input, file.filename);
			const otherFolders = installedModels
				.filter((modelFile) => modelFile.name === file.filename && modelFile.folder !== expectedFolder)
				.map((modelFile) => modelFile.folder);
			const installed = expectedFolder !== null
				&& loaderEvidence.schemaAvailable
				&& folderMatch !== undefined
				&& loaderEvidence.choiceMatches !== false;
			return {
				...file,
				expected_folder: expectedFolder,
				loader_schema_available: loaderEvidence.schemaAvailable,
				loader_choice_match: loaderEvidence.choiceMatches,
				folder_match: folderMatch !== undefined,
				installed,
				installed_folder: folderMatch?.folder ?? null,
				found_in_other_folders: otherFolders,
			};
		});
		return {
			guide_version: MODEL_GUIDE_VERSION,
			status: "available",
			installation_status: modelFiles.every((file) => file.installed) ? "all_files_installed" : "some_files_not_verified_installed",
			...guide,
			model_files: modelFiles,
		};
	}

	async getNodesSnapshot(): Promise<NodeMap> {
		return this.getNodes();
	}

	private async getNodes(): Promise<NodeMap> {
		if (this.nodesCache && this.nodesCache.expiresAt > Date.now()) return this.nodesCache.value;
		if (this.nodesPending) return this.nodesPending;
		this.nodesPending = this.comfy.getNodes().then((value) => {
			if (!isRecord(value)) throw new ComfyUpstreamError(502, "ComfyUI returned an invalid object_info node catalog");
			const nodes: NodeMap = {};
			for (const [nodeId, schema] of Object.entries(value)) {
				if (isRecord(schema)) nodes[nodeId] = schema;
			}
			this.nodesCache = { value: nodes, expiresAt: Date.now() + CACHE_TTL_MS };
			return nodes;
		}).finally(() => {
			this.nodesPending = null;
		});
		return this.nodesPending;
	}

	private async getModelFolders(): Promise<string[]> {
		if (this.foldersCache && this.foldersCache.expiresAt > Date.now()) return this.foldersCache.value;
		if (this.foldersPending) return this.foldersPending;
		this.foldersPending = this.comfy.getModels().then((value) => {
			const folders = modelFolderNames(value).slice(0, MAX_MODEL_FOLDERS);
			this.foldersCache = { value: folders, expiresAt: Date.now() + CACHE_TTL_MS };
			return folders;
		}).finally(() => {
			this.foldersPending = null;
		});
		return this.foldersPending;
	}

	private async getModelFolder(folder: string): Promise<string[]> {
		const cached = this.modelFolderCache.get(folder);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const pending = this.modelFolderPending.get(folder);
		if (pending) return pending;
		const request = this.comfy.getModelFolder(folder).then((value) => {
			const names = modelFileNames(value);
			this.modelFolderCache.set(folder, { value: names, expiresAt: Date.now() + CACHE_TTL_MS });
			return names;
		}).finally(() => {
			this.modelFolderPending.delete(folder);
		});
		this.modelFolderPending.set(folder, request);
		return request;
	}

	private async getAllModels(): Promise<Array<{ folder: string; name: string }>> {
		const folders = await this.getModelFolders();
		const listings = await Promise.all(folders.map(async (folder) =>
			(await this.getModelFolder(folder)).map((name) => ({ folder, name })),
		));
		return listings.flat();
	}
}

function compactNode(nodeId: string, schema: JsonRecord): Record<string, unknown> {
	const input = isRecord(schema.input) ? schema.input : {};
	const required = isRecord(input.required) ? Object.keys(input.required).length : 0;
	const optional = isRecord(input.optional) ? Object.keys(input.optional).length : 0;
	return {
		node_id: nodeId,
		display_name: stringField(schema, "display_name") ?? stringField(schema, "name") ?? nodeId,
		category: stringField(schema, "category") ?? "",
		description: (stringField(schema, "description") ?? "").slice(0, 400),
		inputs_count: required + optional,
		outputs: Array.isArray(schema.output) ? schema.output : [],
	};
}

function findLoaderChoices(nodes: NodeMap, modelName: string): Array<Record<string, unknown>> {
	const matches: Array<Record<string, unknown>> = [];
	for (const [nodeId, schema] of Object.entries(nodes)) {
		const input = isRecord(schema.input) ? schema.input : {};
		for (const section of ["required", "optional"] as const) {
			const sectionInputs = isRecord(input[section]) ? input[section] as JsonRecord : {};
			for (const [inputName, definition] of Object.entries(sectionInputs)) {
				const options = optionList(definition);
				if (!options?.includes(modelName)) continue;
				matches.push({
					node_id: nodeId,
					display_name: stringField(schema, "display_name") ?? stringField(schema, "name") ?? nodeId,
					category: stringField(schema, "category") ?? "",
					input_name: inputName,
					input_section: section,
					choices: options,
					schema: {
						input: { [section]: { [inputName]: definition } },
						output: schema.output ?? [],
						output_name: schema.output_name ?? [],
					},
				});
			}
		}
	}
	return matches;
}

function optionList(definition: unknown): string[] | null {
	if (!Array.isArray(definition) || !Array.isArray(definition[0])) return null;
	return definition[0].filter((value): value is string => typeof value === "string");
}

function expectedModelFolder(loaderNode: string, loaderInput: string): string | null {
	const loader = LOADER_MODEL_FOLDERS[loaderNode];
	return loader?.input === loaderInput ? loader.folder : null;
}

function loaderChoiceEvidence(
	nodes: NodeMap,
	loaderNode: string,
	loaderInput: string,
	modelName: string,
): { schemaAvailable: boolean; choiceMatches: boolean | null } {
	const schema = nodes[loaderNode];
	if (!schema) return { schemaAvailable: false, choiceMatches: null };
	const input = isRecord(schema.input) ? schema.input : {};
	for (const section of ["required", "optional"] as const) {
		const sectionInputs = isRecord(input[section]) ? input[section] as JsonRecord : {};
		if (!(loaderInput in sectionInputs)) continue;
		const choices = optionList(sectionInputs[loaderInput]);
		return { schemaAvailable: true, choiceMatches: choices === null ? null : choices.includes(modelName) };
	}
	return { schemaAvailable: false, choiceMatches: null };
}

function modelFolderNames(value: unknown): string[] {
	const names = Array.isArray(value)
		? value.filter((name): name is string => typeof name === "string")
		: isRecord(value) ? Object.keys(value) : [];
	return [...new Set(names.filter((name) => /^[A-Za-z0-9_-]{1,128}$/.test(name)))].sort();
}

function modelFileNames(value: unknown): string[] {
	if (!Array.isArray(value)) throw new ComfyUpstreamError(502, "ComfyUI returned an invalid model folder listing");
	return [...new Set(value.filter((name): name is string => typeof name === "string"))].sort();
}

function pagination(limit: number, offset: number, total: number, pageLength: number): Record<string, unknown> {
	return { limit, offset, total, has_more: offset + pageLength < total };
}

function normalizedText(value: string): string {
	return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function stringField(record: JsonRecord, key: string): string | null {
	return typeof record[key] === "string" ? record[key] as string : null;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
