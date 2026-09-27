/** Best-effort cleanup for readers from runtimes with incomplete stream APIs. */
export function releaseReaderLock<T>(reader: ReadableStreamDefaultReader<T>): void {
	try {
		const releaseLock = (reader as unknown as { releaseLock?: unknown }).releaseLock;
		if (typeof releaseLock === "function") releaseLock.call(reader);
	} catch {
		// Lock release is cleanup only; never replace a read or parsing error with it.
	}
}
