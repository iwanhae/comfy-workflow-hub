/**
 * Curated model facts. Versioned alongside the repository rather than fetched
 * or inferred at request time. Every model name and workflow parameter below
 * is copied from workflows/t2i.json; live availability is checked separately.
 */
export const MODEL_GUIDE_VERSION = "1.0.0";

export interface ModelGuide {
	id: string;
	title: string;
	aliases: string[];
	source: { kind: "repository_workflow"; path: string };
	model_files: Array<{
		role: string;
		filename: string;
		loader_node: string;
		loader_input: string;
	}>;
	wiring: Array<{ from: string; to: string }>;
	parameters: Record<string, unknown>;
}

export const MODEL_GUIDES: ModelGuide[] = [
	{
		id: "qwen-image-2.1",
		title: "Qwen Image 2.1",
		aliases: [
			"qwen image 2.1",
			"qwen_image_2.1",
			"qwen-image-2.1",
			"qwen_image_2.1_int8_convrot.safetensors",
			"qwen3vl_8b_int8_convrot.safetensors",
			"qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
			"qwen_image_2.1_vae_bf16.safetensors",
		],
		source: { kind: "repository_workflow", path: "workflows/t2i.json" },
		model_files: [
			{
				role: "diffusion model",
				filename: "qwen_image_2.1_int8_convrot.safetensors",
				loader_node: "UNETLoader",
				loader_input: "unet_name",
			},
			{
				role: "Qwen Image text encoder",
				filename: "qwen3vl_8b_int8_convrot.safetensors",
				loader_node: "CLIPLoader",
				loader_input: "clip_name",
			},
			{
				role: "prompt-rewrite text encoder",
				filename: "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
				loader_node: "CLIPLoader",
				loader_input: "clip_name",
			},
			{
				role: "VAE",
				filename: "qwen_image_2.1_vae_bf16.safetensors",
				loader_node: "VAELoader",
				loader_input: "vae_name",
			},
		],
		wiring: [
			{ from: "UNETLoader.MODEL", to: "QwenImage21Cache.model" },
			{ from: "QwenImage21Cache.MODEL", to: "KSampler.model" },
			{ from: "CLIPLoader(type=qwen_image).CLIP", to: "TextEncodeQwenImage21.clip" },
			{ from: "CLIPLoader(type=stable_diffusion).CLIP", to: "TextGenerate.clip" },
			{ from: "TextEncodeQwenImage21.positive", to: "KSampler.positive" },
			{ from: "TextEncodeQwenImage21.negative", to: "KSampler.negative" },
			{ from: "VAELoader.VAE", to: "VAEDecode.vae" },
		],
		parameters: {
			model_loader: { weight_dtype: "default" },
			model_cache: { device: "auto", dtype: "default" },
			text_encoder: { type: "qwen_image", device: "default" },
			prompt_encoder: { type: "stable_diffusion", device: "default" },
			text_encode: { resolution: 1024, negative_prompt: "" },
			resolution_selector: { aspect_ratio: "1:1 (Square)", megapixels: 1, multiple: 8 },
			sampler: {
				seed: 447606998181262,
				steps: 25,
				cfg: 1,
				sampler_name: "euler",
				scheduler: "simple",
				denoise: 1,
			},
			latent_batch_size: 1,
			save: { format: "png", bit_depth: "8-bit", input_color_space: "sRGB" },
		},
	},
];
