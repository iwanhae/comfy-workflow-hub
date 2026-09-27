import { mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Comfy } from "@comfyorg/sdk";

const baseUrl = process.env.COMFY_BASE_URL?.trim() || "https://comfy.iwanhae.kr";
process.env.COMFY_BASE_URL = baseUrl;

const client = new Comfy({ clientInfo: "bun-sdk-smoke" });
const workflowPath = fileURLToPath(new URL("./workflows/t2i.json", import.meta.url));
const workflow = await client.workflows.fromFile(workflowPath);

console.log(`Submitting ${basename(workflowPath)} to ${baseUrl}`);
const job = await client.submit(workflow);
console.log(`Accepted job ${job.id} (status: ${job.status})`);

await job.wait(15 * 60 * 1000);
console.log(`Job ${job.id} finished with status: ${job.status}`);

if (job.status !== "succeeded") {
  console.error("Job did not succeed:", job.error);
  process.exitCode = 1;
} else {
  const outputs = job.getOutputs("461");
  if (outputs.length === 0) {
    throw new Error("Job succeeded but SaveImageAdvanced node 461 returned no outputs");
  }

  const outputDir = fileURLToPath(new URL("./outputs/", import.meta.url));
  await mkdir(outputDir, { recursive: true });
  for (const [index, output] of outputs.entries()) {
    const ext = extname(output.name) || ".png";
    const path = join(outputDir, `t2i-${job.id}-${index + 1}${ext}`);
    await output.toFile(path);
    const { size } = await stat(path);
    if (output.sizeBytes !== size) {
      console.warn(`Server metadata size (${output.sizeBytes} bytes) differs from downloaded file size (${size} bytes).`);
    }
    console.log(`Downloaded ${output.type} output (${size} bytes): ${path}`);
  }
}
