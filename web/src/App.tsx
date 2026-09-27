import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
	cancelPendingJob,
	getComfyQueue,
	getComfyStatus,
	getHubStatus,
	getJob,
	getModel,
	getNode,
	getQwenGuide,
	getWorkflow,
	isUuid,
	listAssets,
	listAssetPage,
	listJobs,
	listWorkflows,
	newRequestId,
	searchModels,
	searchNodes,
	stageAndCommitWorkflow,
	stageAndPromoteAsset,
	submitJob,
	type AssetRecord,
	type JobRecord,
	type LiveJob,
	type ProgressState,
	type WorkflowMetadata,
} from "./api.ts";

type PageName = "board" | "workflows" | "assets" | "catalog";
type BoardColumn = "queue" | "running" | "completed" | "failed";

interface EventSnapshot {
	type: "snapshot";
	sequence: number;
	state: ProgressState;
	jobs: LiveJob[];
}

const EMPTY_PROGRESS_STATE: ProgressState = { upstream: "connecting", queue_remaining: null, last_reconciled_at: null };
const SELECTED_DETAIL_POLL_MS = 7_500;
const ASSETS_PAGE_REFRESH_MS = 10_000;
const MAX_EMPTY_OUTPUT_CHECKS = 8;
const MAX_PENDING_OUTPUT_CHECKS = 16;

export default function App() {
	const [page, setPage] = useState<PageName>("board");
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const [jobsLoading, setJobsLoading] = useState(true);
	const [jobsError, setJobsError] = useState<string | null>(null);
	const [liveJobs, setLiveJobs] = useState<Record<string, LiveJob>>({});
	const [feedState, setFeedState] = useState<ProgressState>(EMPTY_PROGRESS_STATE);
	const [feedConnected, setFeedConnected] = useState(false);
	const [hubStatus, setHubStatus] = useState<{ workflow_count: number; comfy_configured: boolean } | null>(null);
	const [comfyStatus, setComfyStatus] = useState<Record<string, unknown> | null>(null);
	const [queueOverview, setQueueOverview] = useState<Record<string, unknown> | null>(null);
	const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
	const [jobDetail, setJobDetail] = useState<JobRecord | null>(null);
	const [jobAssets, setJobAssets] = useState<AssetRecord[]>([]);
	const [jobWorkflow, setJobWorkflow] = useState<WorkflowMetadata | null>(null);
	const [jobDetailLoading, setJobDetailLoading] = useState(false);
	const [jobDetailError, setJobDetailError] = useState<string | null>(null);
	const [jobOutputsRefreshing, setJobOutputsRefreshing] = useState(false);
	const [jobCancelBusy, setJobCancelBusy] = useState(false);
	const [cancelMessage, setCancelMessage] = useState<string | null>(null);
	const [workflows, setWorkflows] = useState<WorkflowMetadata[]>([]);
	const [workflowCount, setWorkflowCount] = useState(0);
	const [workflowHasMore, setWorkflowHasMore] = useState(false);
	const [workflowLoadingMore, setWorkflowLoadingMore] = useState(false);
	const [submissionKeys, setSubmissionKeys] = useState<Record<string, string>>({});
	const [workflowsLoading, setWorkflowsLoading] = useState(false);
	const [workflowError, setWorkflowError] = useState<string | null>(null);
	const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowMetadata | null>(null);
	const [assetList, setAssetList] = useState<AssetRecord[]>([]);
	const [assetHasMore, setAssetHasMore] = useState(false);
	const [assetLoadingMore, setAssetLoadingMore] = useState(false);
	const [assetsLoading, setAssetsLoading] = useState(false);
	const [assetError, setAssetError] = useState<string | null>(null);
	const [catalogTab, setCatalogTab] = useState<"nodes" | "models">("nodes");
	const [nodeQuery, setNodeQuery] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [nodes, setNodes] = useState<Array<Record<string, unknown>>>([]);
	const [models, setModels] = useState<Array<{ folder: string; name: string }>>([]);
	const [catalogBusy, setCatalogBusy] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogDetailTitle, setCatalogDetailTitle] = useState<string | null>(null);
	const [catalogDetail, setCatalogDetail] = useState<Record<string, unknown> | null>(null);
	const [qwenGuide, setQwenGuide] = useState<Record<string, unknown> | null>(null);
	const [guideBusy, setGuideBusy] = useState(false);
	const [globalError, setGlobalError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [showWorkflowUpload, setShowWorkflowUpload] = useState(false);
	const [showAssetUpload, setShowAssetUpload] = useState(false);
	const lastSequence = useRef(0);
	const selectedJobIdRef = useRef<string | null>(null);
	const selectedDetailRefreshRef = useRef<((id: string, force?: boolean) => void) | null>(null);
	const assetPageRequestRef = useRef<Promise<Awaited<ReturnType<typeof listAssetPage>>> | null>(null);
	selectedJobIdRef.current = selectedJobId;

	const refreshJobs = useCallback(async () => {
		setJobsLoading(true);
		try {
			const nextJobs = await listJobs();
			setJobs(nextJobs);
			setJobsError(null);
		} catch (error) {
			setJobsError(messageOf(error));
			throw error;
		} finally {
			setJobsLoading(false);
		}
	}, []);

	const refreshOverview = useCallback(async () => {
		const [hub, comfy, queue] = await Promise.allSettled([getHubStatus(), getComfyStatus(), getComfyQueue()]);
		if (hub.status === "fulfilled") setHubStatus(hub.value);
		if (comfy.status === "fulfilled") setComfyStatus(comfy.value);
		if (queue.status === "fulfilled") setQueueOverview(queue.value);
	}, []);

	const refreshAssetPage = useCallback(() => {
		if (assetPageRequestRef.current) return assetPageRequestRef.current;
		let request!: Promise<Awaited<ReturnType<typeof listAssetPage>>>;
		request = listAssetPage().then((data) => {
			setAssetList((previous) => {
				const latestIds = new Set(data.items.map((asset) => asset.asset_id));
				return [...data.items, ...previous.filter((asset) => !latestIds.has(asset.asset_id))];
			});
			setAssetHasMore(data.hasMore);
			setAssetError(null);
			return data;
		}).catch((error: unknown) => {
			setAssetError(messageOf(error));
			throw error;
		}).finally(() => {
			if (assetPageRequestRef.current === request) assetPageRequestRef.current = null;
		});
		assetPageRequestRef.current = request;
		return request;
	}, []);

	useEffect(() => {
		let active = true;
		const refresh = () => {
			void refreshJobs().catch(() => undefined);
			void refreshOverview();
		};
		refresh();
		const poll = window.setInterval(() => {
			// REST refresh is deliberate redundancy: it repairs missed events and
			// remains a live fallback while EventSource is reconnecting.
			void refreshJobs().catch((error: unknown) => {
				if (active && !feedConnected) setGlobalError(`REST refresh unavailable: ${messageOf(error)}`);
			});
		}, feedConnected ? 20_000 : 5_000);
		const overviewPoll = window.setInterval(() => void refreshOverview(), 30_000);
		return () => {
			active = false;
			window.clearInterval(poll);
			window.clearInterval(overviewPoll);
		};
	}, [feedConnected, refreshJobs, refreshOverview]);

	useEffect(() => {
		if (typeof window.EventSource === "undefined") return;
		const source = new EventSource("/api/v1/events");
		source.onopen = () => {
			setFeedConnected(true);
			setGlobalError((previous) => previous === "Live events disconnected. Showing periodic REST updates." ? null : previous);
		};
		source.onerror = () => {
			setFeedConnected(false);
			setGlobalError("Live events disconnected. Showing periodic REST updates.");
			void refreshJobs().catch(() => undefined);
		};
		source.addEventListener("snapshot", (event) => {
			const snapshot = parseEvent<EventSnapshot>(event);
			if (!snapshot || !Array.isArray(snapshot.jobs)) return;
			lastSequence.current = snapshot.sequence;
			setLiveJobs(Object.fromEntries(snapshot.jobs.map((job) => [job.job_id, job])));
			if (snapshot.state) setFeedState(snapshot.state);
			setFeedConnected(true);
		});
		source.addEventListener("job", (event) => {
			const value = parseEvent<{ sequence: number; job: LiveJob }>(event);
			if (!value?.job || value.sequence <= lastSequence.current) return;
			lastSequence.current = value.sequence;
			setLiveJobs((previous) => ({ ...previous, [value.job.job_id]: value.job }));
		});
		source.addEventListener("state", (event) => {
			const value = parseEvent<{ sequence: number; state: ProgressState }>(event);
			if (!value?.state || value.sequence <= lastSequence.current) return;
			lastSequence.current = value.sequence;
			setFeedState(value.state);
		});
		return () => source.close();
	}, [refreshJobs]);

	useEffect(() => {
		if (page !== "workflows") return;
		let active = true;
		setWorkflowsLoading(true);
		setWorkflowError(null);
		void listWorkflows().then((data) => {
			if (!active) return;
			setWorkflows(data.items);
			setWorkflowCount(data.total);
			setWorkflowHasMore(data.hasMore);
		}).catch((error: unknown) => {
			if (active) setWorkflowError(messageOf(error));
		}).finally(() => {
			if (active) setWorkflowsLoading(false);
		});
		return () => { active = false; };
	}, [page]);

	useEffect(() => {
		if (page !== "assets") return;
		let active = true;
		setAssetsLoading(true);
		setAssetError(null);
		void refreshAssetPage().catch(() => undefined).finally(() => {
			if (active) setAssetsLoading(false);
		});
		const refreshIfVisible = () => {
			if (active && document.visibilityState === "visible") void refreshAssetPage().catch(() => undefined);
		};
		const interval = window.setInterval(refreshIfVisible, ASSETS_PAGE_REFRESH_MS);
		document.addEventListener("visibilitychange", refreshIfVisible);
		return () => {
			active = false;
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refreshIfVisible);
		};
	}, [page, refreshAssetPage]);

	useEffect(() => {
		if (page !== "catalog") return;
		let active = true;
		setCatalogBusy(true);
		setCatalogError(null);
		const timer = window.setTimeout(() => {
			const load = catalogTab === "nodes" ? searchNodes(nodeQuery) : searchModels(modelQuery);
			void load.then((result) => {
				if (!active) return;
				if (catalogTab === "nodes") setNodes((result as Awaited<ReturnType<typeof searchNodes>>).nodes);
				else setModels((result as Awaited<ReturnType<typeof searchModels>>).models);
			}).catch((error: unknown) => {
				if (active) setCatalogError(messageOf(error));
			}).finally(() => {
				if (active) setCatalogBusy(false);
			});
		}, 180);
		return () => {
			active = false;
			window.clearTimeout(timer);
		};
	}, [page, catalogTab, nodeQuery, modelQuery]);

	const shownJobs = useMemo(() => {
		const byId = new Map(jobs.map((job) => [job.id, job]));
		for (const live of Object.values(liveJobs)) {
			const previous = byId.get(live.job_id);
			byId.set(live.job_id, {
				...(previous ?? {}),
				...live,
				id: live.job_id,
				workflow_id: live.workflow_id ?? previous?.workflow_id,
			} as JobRecord);
		}
		return [...byId.values()].sort((left, right) => numberField(right.create_time) - numberField(left.create_time));
	}, [jobs, liveJobs]);

	const selectedListJob = shownJobs.find((job) => job.id === selectedJobId) ?? null;
	const selectedDetailJob = jobDetail?.id === selectedJobId ? jobDetail : null;
	const selectedLiveStatusValue = selectedJobId ? liveJobs[selectedJobId]?.status : undefined;
	const selectedLiveStatus = typeof selectedLiveStatusValue === "string" ? selectedLiveStatusValue : undefined;
	const selectedSourceStatus = furthestJobStatus(selectedListJob?.status, selectedLiveStatus);
	const selectedStatus = furthestJobStatus(selectedDetailJob?.status, selectedListJob?.status, selectedLiveStatus);
	const selectedDisplayJob = selectedDetailJob ?? selectedListJob;
	const selectedDisplayJobWithStatus = selectedDisplayJob
		? { ...selectedDisplayJob, status: selectedStatus ?? selectedDisplayJob.status }
		: null;
	const selectedObservedStatuses = [selectedDetailJob?.status, selectedListJob?.status, selectedLiveStatus]
		.filter((value): value is string => typeof value === "string");
	const selectedDetailAssets = selectedDetailJob ? jobAssets : [];
	const selectedDetailWorkflow = selectedDetailJob && jobWorkflow?.id === selectedDetailJob.workflow_id ? jobWorkflow : null;
	const selectedCanCancel = Boolean(
		selectedJobId && isUuid(selectedJobId) && selectedDetailJob?.status === "pending"
		&& typeof selectedDetailJob.workflow_id === "string" && selectedStatus === "pending"
		&& selectedObservedStatuses.every((status) => status === "pending"),
	);
	const selectedOutputArchiving = selectedDetailAssets.some((asset) => asset.origin === "output" && asset.status === "pending");
	const selectedStatusRef = useRef(selectedStatus);
	selectedStatusRef.current = selectedStatus;
	const selectedOutputArchivingRef = useRef(selectedOutputArchiving);
	selectedOutputArchivingRef.current = selectedOutputArchiving;

	useEffect(() => {
		if (!selectedJobId) {
			setJobDetail(null);
			setJobAssets([]);
			setJobWorkflow(null);
			setJobDetailError(null);
			setJobDetailLoading(false);
			setJobOutputsRefreshing(false);
			selectedDetailRefreshRef.current = null;
			return;
		}
		let active = true;
		let inFlight = false;
		let refreshAgain = false;
		let workflowRequestedFor: string | null = null;
		let emptyOutputChecks = 0;
		let pendingOutputChecks = 0;
		const id = selectedJobId;
		setJobDetail(null);
		setJobAssets([]);
		setJobWorkflow(null);
		setJobDetailLoading(true);
		setJobDetailError(null);
		setJobOutputsRefreshing(false);
		setCancelMessage(null);

		const refresh = async (force = false) => {
			if (!active || selectedJobIdRef.current !== id) return;
			if (force) {
				emptyOutputChecks = 0;
				pendingOutputChecks = 0;
				setJobOutputsRefreshing(true);
			}
			if (inFlight) {
				refreshAgain = true;
				return;
			}
			inFlight = true;
			try {
				do {
					refreshAgain = false;
					try {
						const job = await getJob(id);
						if (!active || selectedJobIdRef.current !== id) return;
						setJobDetail(job);
						setJobDetailError(null);
						const assets = isUuid(id) ? await listAssets(id) : [];
						if (!active || selectedJobIdRef.current !== id) return;
						setJobAssets(assets);
						const outputAssets = assets.filter((asset) => asset.origin === "output");
						const currentStatus = furthestJobStatus(job.status, selectedStatusRef.current);
						if (isActiveStatus(currentStatus)) {
							emptyOutputChecks = 0;
							pendingOutputChecks = 0;
						} else if (outputAssets.some((asset) => asset.status === "pending")) {
							pendingOutputChecks++;
							emptyOutputChecks = 0;
						} else if (isUuid(id) && isArchiveRetryStatus(currentStatus) && outputAssets.length === 0) {
							emptyOutputChecks++;
							pendingOutputChecks = 0;
						} else {
							emptyOutputChecks = 0;
							pendingOutputChecks = 0;
						}
						if (typeof job.workflow_id === "string" && workflowRequestedFor !== job.workflow_id) {
							workflowRequestedFor = job.workflow_id;
							try {
								const workflow = await getWorkflow(job.workflow_id);
								if (active && selectedJobIdRef.current === id) setJobWorkflow(workflow.metadata);
							} catch {
								if (active && selectedJobIdRef.current === id) setJobWorkflow(null);
							}
						} else if (typeof job.workflow_id !== "string") {
							setJobWorkflow(null);
						}
					} catch (error) {
						if (active && selectedJobIdRef.current === id) setJobDetailError(messageOf(error));
						if (!isActiveStatus(selectedStatusRef.current)) {
							if (selectedOutputArchivingRef.current) pendingOutputChecks++;
							else if (isUuid(id) && isArchiveRetryStatus(selectedStatusRef.current)) emptyOutputChecks++;
						}
					}
				} while (refreshAgain && active && selectedJobIdRef.current === id);
			} finally {
				inFlight = false;
				if (active && selectedJobIdRef.current === id) {
					setJobDetailLoading(false);
					setJobOutputsRefreshing(false);
				}
				if (refreshAgain && active && selectedJobIdRef.current === id) void refresh();
			}
		};
		const refreshForSelection = (requestedId: string, force = false) => {
			if (requestedId === id) void refresh(force);
		};
		selectedDetailRefreshRef.current = refreshForSelection;
		void refresh();
		const interval = window.setInterval(() => {
			if (selectedJobIdRef.current !== id) return;
			if (isActiveStatus(selectedStatusRef.current)) {
				void refresh();
			} else if (selectedOutputArchivingRef.current && pendingOutputChecks < MAX_PENDING_OUTPUT_CHECKS) {
				void refresh();
			} else if (isUuid(id) && isArchiveRetryStatus(selectedStatusRef.current) && emptyOutputChecks < MAX_EMPTY_OUTPUT_CHECKS) {
				void refresh();
			}
		}, SELECTED_DETAIL_POLL_MS);
		return () => {
			active = false;
			window.clearInterval(interval);
			if (selectedDetailRefreshRef.current === refreshForSelection) selectedDetailRefreshRef.current = null;
		};
	}, [selectedJobId]);

	const previousSelectedSource = useRef<{ id: string | null; status: string | undefined }>({ id: null, status: undefined });
	useEffect(() => {
		const previous = previousSelectedSource.current;
		if (selectedJobId && previous.id === selectedJobId && previous.status !== selectedSourceStatus) {
			selectedDetailRefreshRef.current?.(selectedJobId);
		}
		previousSelectedSource.current = { id: selectedJobId, status: selectedSourceStatus };
	}, [selectedJobId, selectedSourceStatus]);

	const counts = useMemo(() => {
		const values = { queue: 0, running: 0, completed: 0, failed: 0 };
		for (const job of shownJobs) values[columnForStatus(job.status)]++;
		return values;
	}, [shownJobs]);

	const openJob = (id: string) => {
		setSelectedJobId(id);
		setPage("board");
	};

	const reloadWorkflows = async () => {
		const data = await listWorkflows();
		setWorkflows(data.items);
		setWorkflowCount(data.total);
		setWorkflowHasMore(data.hasMore);
	};

	const loadMoreWorkflows = async () => {
		setWorkflowLoadingMore(true);
		try {
			const data = await listWorkflows(workflows.length);
			setWorkflows((previous) => [...previous, ...data.items]);
			setWorkflowCount(data.total);
			setWorkflowHasMore(data.hasMore);
		} catch (error) { setWorkflowError(messageOf(error)); } finally { setWorkflowLoadingMore(false); }
	};

	const reloadAssets = async () => {
		await refreshAssetPage();
	};

	const loadMoreAssets = async () => {
		setAssetLoadingMore(true);
		try {
			const data = await listAssetPage(assetList.length);
			setAssetList((previous) => [...previous, ...data.items]);
			setAssetHasMore(data.hasMore);
		} catch (error) { setAssetError(messageOf(error)); } finally { setAssetLoadingMore(false); }
	};

	const handleCancel = async () => {
		if (!selectedCanCancel || !selectedJobId) return;
		setJobCancelBusy(true);
		setCancelMessage(null);
		try {
			const result = await cancelPendingJob(selectedJobId);
			if (result.cancelled === true) setCancelMessage("Removed from the pending queue. Running work is never interrupted.");
			else setCancelMessage(`The job was not removed (current status: ${result.status}). Running work is never interrupted.`);
			await Promise.all([
				refreshJobs(),
				getJob(selectedJobId).then((job) => {
					if (selectedJobIdRef.current === selectedJobId) setJobDetail(job);
				}).catch(() => undefined),
			]);
		} catch (error) {
			setJobDetailError(messageOf(error));
		} finally {
			setJobCancelBusy(false);
		}
	};

	const handleRefreshOutputs = () => {
		if (selectedJobId) selectedDetailRefreshRef.current?.(selectedJobId, true);
	};

	const title = ({ board: "Job board", workflows: "Workflows", assets: "Assets", catalog: "Node & model catalog" } as const)[page];
	const serverLabel = feedConnected ? "Live updates on" : typeof window.EventSource === "undefined" ? "REST refresh" : "Reconnecting";

	return <div className="app-shell">
		<aside className="sidebar" aria-label="Main navigation">
			<a className="brand" href="/" onClick={(event) => { event.preventDefault(); setPage("board"); }} aria-label="Comfy Hub home">
				<span className="brand-mark"><Icon name="spark" /></span><span>comfy<span className="brand-light">hub</span></span>
			</a>
			<div className="workspace-label">SHARED WORKSPACE</div>
			<nav className="nav-list">
				<NavButton active={page === "board"} onClick={() => setPage("board")} icon="board" label="Job board" badge={jobs.length || undefined} />
				<NavButton active={page === "workflows"} onClick={() => setPage("workflows")} icon="workflow" label="Workflows" />
				<NavButton active={page === "assets"} onClick={() => setPage("assets")} icon="asset" label="Assets" />
				<NavButton active={page === "catalog"} onClick={() => setPage("catalog")} icon="search" label="Node & model catalog" />
			</nav>
			<div className="sidebar-bottom">
				<div className="live-card"><span className={`live-dot ${feedConnected ? "is-live" : ""}`} />
					<div><strong>{serverLabel}</strong><span>{feedState.queue_remaining === null ? "Hub connection" : `${feedState.queue_remaining} in ComfyUI queue`}</span></div>
				</div>
				<p>Shared board · read-only workflow catalog</p>
			</div>
		</aside>

		<div className="main-shell">
			<header className="topbar">
				<div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{title}</strong></div>
				<div className="topbar-right"><span className={`connection-pill ${feedConnected ? "connected" : ""}`}><span className="live-dot" />{serverLabel}</span>
					<button className="avatar" aria-label="Shared workspace">S</button></div>
			</header>

			<main className="page-content">
				{globalError && <div className="message-banner" role="status"><Icon name="info" /><span>{globalError}</span><button aria-label="Dismiss message" onClick={() => setGlobalError(null)}>×</button></div>}
				{notice && <div className="message-banner success-banner" role="status"><Icon name="check" /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
				{page === "board" && <BoardPage
					jobs={shownJobs}
					jobsLoading={jobsLoading}
					jobsError={jobsError}
					counts={counts}
					selectedJobId={selectedJobId}
					feedState={feedState}
					hubStatus={hubStatus}
					queueOverview={queueOverview}
					comfyStatus={comfyStatus}
					onSelect={openJob}
					jobDetail={selectedDisplayJobWithStatus}
					canCancelJob={selectedCanCancel}
					jobAssets={selectedDetailAssets}
					jobWorkflow={selectedDetailWorkflow}
					jobOutputsRefreshing={jobOutputsRefreshing}
					onRefreshOutputs={handleRefreshOutputs}
					jobDetailLoading={jobDetailLoading}
					jobDetailError={jobDetailError}
					jobCancelBusy={jobCancelBusy}
					cancelMessage={cancelMessage}
					onCancel={handleCancel}
					onCloseDetail={() => setSelectedJobId(null)}
					onNavigate={(next) => setPage(next)}
				/>}
				{page === "workflows" && <WorkflowsPage
					workflows={workflows} count={workflowCount} loading={workflowsLoading} error={workflowError}
					selected={selectedWorkflow} onSelect={setSelectedWorkflow} onUpload={() => setShowWorkflowUpload(true)}
					requestId={selectedWorkflow ? submissionKeys[selectedWorkflow.id] : undefined}
						onRequestIdChange={(workflowId, value) => {
							setSubmissionKeys((previous) => ({ ...previous, [workflowId]: value }));
							try { window.sessionStorage.setItem(`comfy-hub:request-id:${workflowId}`, value); } catch { /* storage can be disabled by browser policy */ }
						}}
					hasMore={workflowHasMore} loadingMore={workflowLoadingMore} onLoadMore={loadMoreWorkflows}
					onSubmitted={(id) => { void refreshJobs(); setSelectedJobId(id); setPage("board"); setNotice("Job submitted. Its workflow remains unchanged."); }}
					onViewAttempt={(id) => { void refreshJobs(); setSelectedJobId(id); setPage("board"); setNotice("Showing the recorded submission attempt. Retry only with the same request ID."); }}
				/>}
				{page === "assets" && <AssetsPage assets={assetList} loading={assetsLoading} loadingMore={assetLoadingMore} hasMore={assetHasMore} error={assetError} onLoadMore={loadMoreAssets} onUpload={() => setShowAssetUpload(true)} onCopied={() => setNotice("Workflow value copied. Paste it into your local API-format workflow JSON.")} />}
				{page === "catalog" && <CatalogPage
					tab={catalogTab} setTab={setCatalogTab} nodeQuery={nodeQuery} setNodeQuery={setNodeQuery}
					modelQuery={modelQuery} setModelQuery={setModelQuery} nodes={nodes} models={models}
					busy={catalogBusy} error={catalogError} detailTitle={catalogDetailTitle} detail={catalogDetail}
					onNode={async (nodeId) => { setCatalogDetailTitle(nodeId); setCatalogDetail(null); try { setCatalogDetail(await getNode(nodeId)); } catch (error) { setCatalogError(messageOf(error)); } }}
					onModel={async (folder, name) => { setCatalogDetailTitle(`${folder}/${name}`); setCatalogDetail(null); try { setCatalogDetail(await getModel(folder, name)); } catch (error) { setCatalogError(messageOf(error)); } }}
					qwenGuide={qwenGuide} guideBusy={guideBusy} onGuide={async () => { setGuideBusy(true); try { setQwenGuide(await getQwenGuide()); } catch (error) { setCatalogError(messageOf(error)); } finally { setGuideBusy(false); } }}
				/>}
			</main>
			<footer className="footer-line"><span>COMFYUI WORKFLOW HUB</span><span>{hubStatus ? `${hubStatus.workflow_count} saved ${hubStatus.workflow_count === 1 ? "workflow" : "workflows"}` : "Shared workspace"}</span></footer>
		</div>

		{showWorkflowUpload && <WorkflowUploadDialog onClose={() => setShowWorkflowUpload(false)} onUploaded={async (workflow) => { setShowWorkflowUpload(false); await reloadWorkflows(); setSelectedWorkflow(workflow); setNotice("Workflow uploaded and saved unchanged."); }} />}
		{showAssetUpload && <AssetUploadDialog assets={assetList} onClose={() => setShowAssetUpload(false)} onUploaded={async (asset) => { setShowAssetUpload(false); await reloadAssets(); setNotice(asset.status === "ready" ? "Asset uploaded and ready to use." : "Upload recorded; ComfyUI has not confirmed the asset yet."); }} />}
	</div>;
}

function BoardPage(props: {
	jobs: JobRecord[];
	jobsLoading: boolean;
	jobsError: string | null;
	counts: Record<BoardColumn, number>;
	selectedJobId: string | null;
	feedState: ProgressState;
	hubStatus: { workflow_count: number; comfy_configured: boolean } | null;
	queueOverview: Record<string, unknown> | null;
	comfyStatus: Record<string, unknown> | null;
	onSelect: (id: string) => void;
	jobDetail: JobRecord | null;
	canCancelJob: boolean;
	jobAssets: AssetRecord[];
	jobWorkflow: WorkflowMetadata | null;
	jobOutputsRefreshing: boolean;
	onRefreshOutputs: () => void;
	jobDetailLoading: boolean;
	jobDetailError: string | null;
	jobCancelBusy: boolean;
	cancelMessage: string | null;
	onCancel: () => void;
	onCloseDetail: () => void;
	onNavigate: (page: PageName) => void;
}) {
	const columns: Array<{ id: BoardColumn; label: string; description: string }> = [
		{ id: "queue", label: "Queue", description: "Waiting to run" },
		{ id: "running", label: "Running", description: "Live execution" },
		{ id: "completed", label: "Completed", description: "Ready to review" },
		{ id: "failed", label: "Failed", description: "Needs attention" },
	];
	const [filter, setFilter] = useState<"all" | BoardColumn>("all");
	const queueRunning = arrayLength(props.queueOverview?.queue_running);
	const queuePending = arrayLength(props.queueOverview?.queue_pending);
	const machine = machineSummary(props.comfyStatus);
	return <>
		<div className="page-heading board-heading">
			<div><div className="eyebrow">LIVE OVERVIEW <span className="heading-live"><span className={`live-dot ${props.feedState.upstream === "connected" ? "is-live" : ""}`} />{props.feedState.upstream}</span></div>
				<h1>Everyone’s Comfy jobs,<br className="mobile-break" /> in one place.</h1>
				<p>Track every run across the shared ComfyUI server, including work started outside this hub.</p>
			</div>
			<div className="heading-actions"><button className="button button-primary" onClick={() => props.onNavigate("workflows")}><Icon name="plus" />Browse workflows</button></div>
		</div>
		<div className="overview-grid" aria-label="Server and queue overview">
			<OverviewCard label="In queue" value={props.feedState.queue_remaining ?? (queueRunning + queuePending)} meta={`${queuePending} pending · ${queueRunning} running`} icon="queue" tone="peach" />
			<OverviewCard label="Active jobs" value={props.counts.queue + props.counts.running} meta={`${props.counts.queue} pending · ${props.counts.running} running`} icon="pulse" tone="lavender" />
			<OverviewCard label="Saved workflows" value={props.hubStatus?.workflow_count ?? "—"} meta="Immutable versions" icon="workflow" tone="mint" />
			<OverviewCard label="ComfyUI server" value={machine.label} meta={machine.detail} icon="server" tone="blue" />
		</div>

		<div className="section-toolbar">
			<div><h2>Job activity</h2><p>Live status · all connected clients</p></div>
			<div className="filter-tabs" role="group" aria-label="Filter jobs">
				{(["all", "queue", "running", "completed", "failed"] as const).map((value) => <button key={value} className={filter === value ? "filter-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All jobs" : titleCase(value)}{value === "all" ? <span>{props.jobs.length}</span> : <span>{props.counts[value]}</span>}</button>)}
			</div>
		</div>
		{props.jobsLoading && props.jobs.length === 0 ? <LoadingState label="Loading shared jobs…" />
			: props.jobsError && props.jobs.length === 0 ? <ErrorState message={props.jobsError} />
			: <div className={`board-grid ${filter !== "all" ? "board-filtered" : ""}`}>
			{columns.filter((column) => filter === "all" || filter === column.id).map((column) => {
				const items = props.jobs.filter((job) => columnForStatus(job.status) === column.id);
				return <section className={`board-column column-${column.id}`} key={column.id} aria-labelledby={`heading-${column.id}`}>
					<div className="column-heading"><span className={`column-marker marker-${column.id}`} /><div><h3 id={`heading-${column.id}`}>{column.label}</h3><p>{column.description}</p></div><span className="column-count">{items.length}</span></div>
					<div className="job-list">{items.map((job) => <JobCard key={job.id} job={job} selected={props.selectedJobId === job.id} onClick={() => props.onSelect(job.id)} />)}</div>
					{items.length === 0 && <div className="column-empty"><span className="empty-glyph">{column.id === "failed" ? "✓" : "· · ·"}</span><span>{column.id === "failed" ? "Nothing needs attention" : `No ${column.label.toLowerCase()} jobs`}</span></div>}
				</section>;
			})}
			</div>}
		<div className="cancel-policy"><span className="policy-icon"><Icon name="shield" /></span><p><strong>Safe queue controls.</strong> You can remove a job only while it is pending. The Hub never interrupts a running job.</p></div>
		{props.jobs.length === 0 && !props.jobsLoading && !props.jobsError && <div className="empty-workspace"><div className="empty-art"><Icon name="spark" /></div><h3>No jobs yet</h3><p>Upload a saved API-format workflow and submit it to see jobs here.</p><button className="button button-primary" onClick={() => props.onNavigate("workflows")}>Open workflows</button></div>}
		{props.selectedJobId && <JobDetailPanel
			job={props.jobDetail ?? props.jobs.find((job) => job.id === props.selectedJobId) ?? null}
			canCancel={props.canCancelJob}
			assets={props.jobAssets} workflow={props.jobWorkflow} loading={props.jobDetailLoading} error={props.jobDetailError}
			outputsRefreshing={props.jobOutputsRefreshing} onRefreshOutputs={props.onRefreshOutputs}
			cancelBusy={props.jobCancelBusy} cancelMessage={props.cancelMessage} onCancel={props.onCancel} onClose={props.onCloseDetail}
		/>}
	</>;
}

function OverviewCard({ label, value, meta, icon, tone }: { label: string; value: string | number; meta: string; icon: string; tone: string }) {
	return <div className="overview-card"><div className={`overview-icon ${tone}`}><Icon name={icon} /></div><div className="overview-copy"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div></div>;
}

function JobCard({ job, selected, onClick }: { job: JobRecord; selected: boolean; onClick: () => void }) {
	const status = job.status ?? "unknown";
	const liveProgress = progressFor(job);
	const local = typeof job.workflow_id === "string";
	return <button className={`job-card ${selected ? "job-selected" : ""}`} onClick={onClick} aria-label={`${jobLabel(job)} · ${status}`} aria-pressed={selected}>
		<div className="job-card-top"><span className={`status-dot status-${statusTone(status)}`} /><span className="job-card-state">{displayStatus(status)}</span><span className="job-created">{relativeTime(job.create_time)}</span></div>
		<h4>{jobLabel(job)}</h4>
		<div className="job-card-meta"><span className={`origin-tag ${local ? "origin-hub" : ""}`}>{local ? "Hub workflow" : "External job"}</span><span className="job-id">{shortId(job.id)}</span></div>
		{liveProgress && status === "in_progress" && <div className="job-progress-wrap"><div className="progress-track"><span style={{ width: `${liveProgress.percent}%` }} /></div><span>{liveProgress.label}</span></div>}
		{status === "pending" && <div className="job-queue-note"><Icon name="queue" /> Waiting in queue</div>}
	</button>;
}

function JobDetailPanel(props: {
	job: JobRecord | null;
	canCancel: boolean;
	assets: AssetRecord[];
	workflow: WorkflowMetadata | null;
	loading: boolean;
	error: string | null;
	outputsRefreshing: boolean;
	onRefreshOutputs: () => void;
	cancelBusy: boolean;
	cancelMessage: string | null;
	onCancel: () => void;
	onClose: () => void;
}) {
	const job = props.job;
	const readyAssets = props.assets.filter((asset) => asset.origin === "output" && asset.status === "ready").length;
	const pendingAssets = props.assets.filter((asset) => asset.origin === "output" && asset.status === "pending").length;
	const rejectedAssets = props.assets.filter((asset) => asset.origin === "output" && asset.status === "rejected").length;
	const archiveLabel = props.assets.length === 0 ? "No archived outputs found" : pendingAssets > 0 ? `${pendingAssets} output${pendingAssets === 1 ? "" : "s"} archiving` : rejectedAssets > 0 ? "Archive needs attention" : `${readyAssets} output${readyAssets === 1 ? "" : "s"} ready`;
	return <section className="detail-panel" aria-labelledby="job-detail-title">
		<div className="detail-header"><div><div className="eyebrow">JOB DETAILS</div><h2 id="job-detail-title">{job ? jobLabel(job) : "Loading job…"}</h2></div><button className="icon-button" onClick={props.onClose} aria-label="Close job details">×</button></div>
		{props.loading && <div className="inline-loading" role="status"><span className="spinner" />Loading full job, outputs and workflow…</div>}
		{props.error && <div className="inline-error" role="alert">{props.error}</div>}
		{job && <>
			<div className="detail-meta-row"><StatusBadge status={job.status ?? "unknown"} /><span>{typeof job.workflow_id === "string" ? "Submitted through this Hub" : "External ComfyUI job"}</span><span>{formatDate(job.create_time)}</span></div>
			{job.status === "pending" && props.canCancel ? <div className="pending-action"><div><strong>Queued job</strong><span>This removes it only if it is still pending. Running work is never interrupted.</span></div><button className="button button-danger" onClick={props.onCancel} disabled={props.cancelBusy}>{props.cancelBusy ? "Removing…" : "Cancel queued job"}</button></div> : job.status === "pending" && typeof job.workflow_id !== "string" ? <p className="running-policy">External ComfyUI jobs are read-only in the Hub.</p> : job.status === "pending" ? <p className="running-policy">The Hub can cancel only a job confirmed as pending. Running work is never interrupted.</p> : job.status === "submission_unknown" ? <p className="running-policy">Submission outcome is unknown. Return to this workflow to retry or inspect with the same saved request ID; the Hub will not duplicate it.</p> : <p className="running-policy">{isActiveStatus(job.status) ? "Running jobs cannot be cancelled from the Hub." : "This job is no longer pending; the Hub never interrupts running work."}</p>}
			{props.cancelMessage && <div className="inline-note" role="status">{props.cancelMessage}</div>}
			<div className="detail-sections">
				<section className="detail-section"><div className="detail-section-title"><h3>Saved workflow</h3>{job.workflow_id && <span className="muted-tag">{shortId(job.workflow_id)}</span>}</div>
					{props.workflow ? <div className="linked-workflow"><span className="workflow-file-icon"><Icon name="workflow" /></span><div><strong>{props.workflow.name || props.workflow.filename || "Untitled workflow"}</strong><span>{formatBytes(props.workflow.bytes)} · saved {formatDate(props.workflow.createdAt)}</span></div><a className="text-link" href={`/api/v1/workflows/${encodeURIComponent(props.workflow.id)}/content`} download={props.workflow.filename || `${props.workflow.id}.json`}>Original JSON <Icon name="download" /></a></div>
						: job.workflow_id ? <p className="subtle-copy">Workflow metadata unavailable for this job.</p> : <p className="subtle-copy">No saved Hub workflow is associated; this job was submitted outside the Hub.</p>}
				</section>
				<section className="detail-section"><div className="detail-section-title"><h3>Outputs</h3><span className={`archive-state ${pendingAssets ? "archive-pending" : readyAssets ? "archive-ready" : ""}`}><span className={`status-dot status-${readyAssets ? "complete" : pendingAssets ? "running" : "neutral"}`} />{archiveLabel}</span>{isUuid(job.id) && <button type="button" className="button button-secondary output-refresh" aria-label="Refresh outputs" aria-busy={props.outputsRefreshing} disabled={props.outputsRefreshing} onClick={props.onRefreshOutputs}>{props.outputsRefreshing ? "Refreshing…" : "Refresh outputs"}</button>}</div>
					{props.assets.length ? <div className="asset-grid detail-assets">{props.assets.map((asset) => <AssetCard key={asset.asset_id} asset={asset} onCopied={() => undefined} />)}</div> : <div className="subtle-copy output-empty">{isArchiveRetryStatus(job.status) ? "No output assets are recorded yet. Automatic discovery retries are bounded; refresh outputs to check again." : "No output files are available yet."}</div>}
					{job.outputs !== undefined && <details className="raw-details"><summary>ComfyUI output references</summary><pre>{safeJson(job.outputs)}</pre></details>}
				</section>
				{(job.execution_error !== undefined || job.submission_error !== undefined) && <section className="detail-section error-section"><div className="detail-section-title"><h3>{job.submission_error !== undefined ? "Submission error" : "Execution error"}</h3><span className="error-label">FAILED</span></div><pre className="error-payload">{safeJson(job.submission_error ?? job.execution_error)}</pre></section>}
			</div>
		</>}
	</section>;
}

function WorkflowsPage(props: {
	workflows: WorkflowMetadata[];
	count: number;
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	loading: boolean;
	error: string | null;
	selected: WorkflowMetadata | null;
	requestId: string | undefined;
	onSelect: (workflow: WorkflowMetadata | null) => void;
	onUpload: () => void;
	onRequestIdChange: (workflowId: string, value: string) => void;
	onSubmitted: (id: string) => void;
	onViewAttempt: (id: string) => void;
}) {
	return <>
		<div className="page-heading">
			<div><div className="eyebrow">WORKFLOW LIBRARY</div><h1>Saved, shared,<br className="mobile-break" /> never overwritten.</h1><p>Each upload becomes an immutable API-format version identified by its exact SHA-256.</p></div>
			<button className="button button-primary" onClick={props.onUpload}><Icon name="upload" />Upload workflow</button>
		</div>
		<div className="section-toolbar library-toolbar"><div><h2>Workflow versions <span className="count-inline">{props.count}</span></h2><p>Upload the JSON exported in ComfyUI API format.</p></div><span className="immutable-label"><Icon name="lock" />Immutable</span></div>
		{props.loading && <LoadingState label="Loading saved workflows…" />}
		{props.error && <ErrorState message={props.error} />}
		{!props.loading && !props.error && props.workflows.length === 0 && <EmptyState icon="workflow" title="No saved workflows yet" text="Start with an API-format workflow JSON file from your computer. The Hub stores the original bytes unchanged." action={<button className="button button-primary" onClick={props.onUpload}><Icon name="upload" />Choose a workflow file</button>} />}
		{props.workflows.length > 0 && <div className="workflow-layout">
			<div className="workflow-list" aria-label="Saved workflow versions">
				{props.workflows.map((workflow) => <button key={workflow.id} className={`workflow-row ${props.selected?.id === workflow.id ? "workflow-row-selected" : ""}`} onClick={() => props.onSelect(workflow)}>
					<span className="workflow-file-icon"><Icon name="workflow" /></span><span className="workflow-row-copy"><strong>{workflow.name || workflow.filename || "Untitled workflow"}</strong><span>{workflow.description || workflow.filename || "No description"}</span></span>
					<span className="workflow-row-size">{formatBytes(workflow.bytes)}<small>{formatDate(workflow.createdAt)}</small></span><Icon name="chevron" />
				</button>)}
			</div>
			{props.selected ? <WorkflowDetail key={props.selected.id} workflow={props.selected} requestId={props.requestId} onRequestIdChange={(value) => props.onRequestIdChange(props.selected!.id, value)} onSubmit={props.onSubmitted} onViewAttempt={props.onViewAttempt} /> : <div className="workflow-side-placeholder"><div className="workflow-side-mark"><Icon name="workflow" /></div><h3>Pick a workflow</h3><p>View its content address and submit the saved version to ComfyUI.</p><span className="immutable-label"><Icon name="lock" />No edits in the Hub</span></div>}
		</div>}
		{props.hasMore && <button className="button button-secondary load-more" onClick={props.onLoadMore} disabled={props.loadingMore}>{props.loadingMore ? "Loading…" : "Load more workflows"}</button>}
	</>;
}

function WorkflowDetail({ workflow, requestId: savedRequestId, onRequestIdChange, onSubmit, onViewAttempt }: { workflow: WorkflowMetadata; requestId: string | undefined; onRequestIdChange: (value: string) => void; onSubmit: (id: string) => void; onViewAttempt: (id: string) => void }) {
	const [requestId, setRequestId] = useState(() => savedRequestId ?? readSavedRequestId(workflow.id) ?? newRequestId());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [ambiguousJobId, setAmbiguousJobId] = useState<string | null>(null);
	const [storedGraph, setStoredGraph] = useState<Record<string, unknown> | null>(null);
	const [graphError, setGraphError] = useState<string | null>(null);
	useEffect(() => {
		if (savedRequestId === undefined) onRequestIdChange(requestId);
	}, [savedRequestId, requestId, onRequestIdChange]);
	useEffect(() => {
		let active = true;
		void getWorkflow(workflow.id).then((record) => {
			if (active) setStoredGraph(record.workflow);
		}).catch((reason: unknown) => {
			if (active) setGraphError(messageOf(reason));
		});
		return () => { active = false; };
	}, [workflow.id]);
	const nodeTypes = storedGraph ? Object.values(storedGraph).filter(isRecord).map((node) => node.class_type).filter((type): type is string => typeof type === "string") : [];
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const response = await submitJob(workflow.id, requestId.trim() || null);
			if (response.status === "submission_unknown") {
				setAmbiguousJobId(response.job_id);
				setResult(`Submission outcome is unknown · ${shortId(response.job_id)}. Keep this request ID; the Hub will not submit it twice.`);
				return;
			}
			setAmbiguousJobId(null);
			setResult(`${response.reused ? "Safe retry reused the existing submission" : "Submitted"} · ${response.status} · ${shortId(response.job_id)}`);
			onSubmit(response.job_id);
		} catch (reason) {
			setError(requestId.trim()
				? `${messageOf(reason)} Keep the same request ID if retrying; the Hub will not submit a duplicate for that key.`
				: `${messageOf(reason)} No retry key was sent, so repeating this request could create another job.`);
		} finally {
			setBusy(false);
		}
	};
	return <aside className="workflow-detail">
		<div className="detail-header"><div><div className="eyebrow">IMMUTABLE VERSION</div><h2>{workflow.name || workflow.filename || "Untitled workflow"}</h2></div><span className="immutable-badge"><Icon name="lock" />Saved</span></div>
		{workflow.description && <p className="workflow-description">{workflow.description}</p>}
		<div className="workflow-facts"><Fact label="Original file" value={workflow.filename || "Filename not recorded"} /><Fact label="Size" value={formatBytes(workflow.bytes)} /><Fact label="Saved" value={formatDate(workflow.createdAt)} /></div>
		<div className="stored-graph-summary"><div><strong>Stored graph</strong><span>{storedGraph ? `${nodeTypes.length} nodes · fetched from the saved workflow detail` : graphError ? `Could not read workflow detail: ${graphError}` : "Loading saved workflow detail…"}</span></div>{storedGraph && nodeTypes.length > 0 && <details><summary>Read-only node types</summary><p>{[...new Set(nodeTypes)].join(" · ")}</p></details>}</div>
		<div className="digest-card"><span>SHA-256 workflow ID</span><code>{workflow.id}</code><a href={`/api/v1/workflows/${encodeURIComponent(workflow.id)}/content`} download={workflow.filename || `${workflow.id}.json`} className="text-link">Download exact JSON <Icon name="download" /></a></div>
		<form className="submit-workflow" onSubmit={submit}>
			<div className="submit-heading"><div><h3>Run this version</h3><p>The Hub submits the stored graph without changing it.</p></div><span className="submit-icon"><Icon name="play" /></span></div>
			<label htmlFor="client-request-id">Retry-safe request ID <span className="optional">· optional</span></label>
			<div className="request-key-row"><input id="client-request-id" value={requestId} maxLength={256} onChange={(event) => { setRequestId(event.currentTarget.value); onRequestIdChange(event.currentTarget.value); }} /><button type="button" className="icon-button" aria-label="Generate a new request ID" title="Start a separate submission" onClick={() => { const next = newRequestId(); setRequestId(next); onRequestIdChange(next); setResult(null); setAmbiguousJobId(null); }}>↻</button></div>
			<p className="field-hint">{requestId.trim() ? "Reuse this same ID after a timeout to safely check the original submission. A new ID creates a new job." : "Request IDs are optional, but without one a retry could create a duplicate job."}</p>
			{error && <div className="inline-error" role="alert">{error}</div>}{result && <div className="inline-note" role="status">{result}{ambiguousJobId && <button type="button" className="inline-action" onClick={() => onViewAttempt(ambiguousJobId)}>View attempt on job board</button>}</div>}
			<button className="button button-primary button-wide" disabled={busy}>{busy ? "Submitting…" : "Submit job"}<Icon name="arrow" /></button>
		</form>
	</aside>;
}

function WorkflowUploadDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: (workflow: WorkflowMetadata) => Promise<void> }) {
	const [file, setFile] = useState<File | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [step, setStep] = useState("Choose the API-format JSON file saved on this device.");
	const upload = async (event: FormEvent) => {
		event.preventDefault();
		if (!file) { setError("Choose a workflow JSON file first."); return; }
		setBusy(true);
		setError(null);
		try {
			setStep("Staging the original file…");
			const saved = await stageAndCommitWorkflow(file, name, description);
			setStep("Saved. Original workflow bytes were not modified.");
			await onUploaded(saved);
		} catch (reason) {
			setError(messageOf(reason));
		} finally {
			setBusy(false);
		}
	};
	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
		<section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="upload-workflow-title">
			<div className="modal-header"><div><span className="eyebrow">ADD TO THE LIBRARY</span><h2 id="upload-workflow-title">Upload a workflow</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close upload dialog">×</button></div>
			<form onSubmit={upload}>
				<label className="file-drop" htmlFor="workflow-file"><span className="file-drop-icon"><Icon name="upload" /></span><strong>{file?.name || "Choose an API-format JSON file"}</strong><span>{file ? `${formatBytes(file.size)} · selected from this device` : "API format only · JSON · up to the Hub upload limit"}</span><input id="workflow-file" aria-label="Workflow JSON file" type="file" accept=".json,application/json" onChange={(event) => { setFile(event.currentTarget.files?.[0] ?? null); setError(null); }} /></label>
				<p className="field-hint">The Hub does not have access to remote clients’ local paths. Select the file in your browser.</p>
				<label htmlFor="workflow-name">Display name <span className="optional">· optional</span></label><input id="workflow-name" value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} placeholder={file?.name.replace(/\.json$/i, "") || "e.g. Portrait studio"} />
				<label htmlFor="workflow-description">Notes <span className="optional">· optional</span></label><textarea id="workflow-description" value={description} maxLength={2000} rows={3} onChange={(event) => setDescription(event.currentTarget.value)} placeholder="What does this workflow make?" />
				<div className="immutable-callout"><Icon name="lock" /><span><strong>Immutable once saved.</strong> The Hub stores exact uploaded bytes as a version. To make a change, edit locally and upload a new version.</span></div>
				{step && <p className="field-hint upload-step" role="status">{step}</p>}{error && <div className="inline-error" role="alert">{error}</div>}
				<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy || !file}>{busy ? "Uploading…" : "Upload & save"}<Icon name="arrow" /></button></div>
			</form>
		</section>
	</div>;
}

function AssetsPage({ assets, loading, loadingMore, hasMore, error, onLoadMore, onUpload, onCopied }: { assets: AssetRecord[]; loading: boolean; loadingMore: boolean; hasMore: boolean; error: string | null; onLoadMore: () => void; onUpload: () => void; onCopied: () => void }) {
	const inputAssets = assets.filter((asset) => asset.origin === "input");
	const outputAssets = assets.filter((asset) => asset.origin === "output");
	return <>
		<div className="page-heading"><div><div className="eyebrow">SHARED FILES</div><h1>Assets in and out.</h1><p>Original inputs and archived outputs, with previews and copy-ready ComfyUI references.</p></div><button className="button button-primary" onClick={onUpload}><Icon name="upload" />Upload image or mask</button></div>
		<div className="asset-tip"><span className="tip-icon"><Icon name="info" /></span><p><strong>Keep workflows untouched.</strong> Copy the shown workflow value into your local API-format JSON. This shared Hub never edits a saved workflow.</p></div>
		{loading && <LoadingState label="Loading shared assets…" />}{error && <ErrorState message={error} />}
		{!loading && !error && assets.length === 0 && <EmptyState icon="asset" title="No assets yet" text="Upload an image or mask to make it available to workflows. Completed job outputs appear here after archiving." action={<button className="button button-primary" onClick={onUpload}><Icon name="upload" />Upload an asset</button>} />}
		{inputAssets.length > 0 && <AssetSection title="Input assets" count={inputAssets.length} text="Originals stored by this Hub and staged to ComfyUI." assets={inputAssets} onCopied={onCopied} />}
		{outputAssets.length > 0 && <AssetSection title="Job outputs" count={outputAssets.length} text="Archived copies with the original download reference." assets={outputAssets} onCopied={onCopied} />}
		{hasMore && <button className="button button-secondary load-more" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more assets"}</button>}
	</>;
}

function AssetUploadDialog({ assets, onClose, onUploaded }: { assets: AssetRecord[]; onClose: () => void; onUploaded: (asset: AssetRecord) => Promise<void> }) {
	const [kind, setKind] = useState<"image" | "mask">("image");
	const [originalId, setOriginalId] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const originals = assets.filter((asset) => asset.origin === "input" && asset.kind === "image" && asset.status === "ready");
	const upload = async (event: FormEvent) => {
		event.preventDefault();
		if (!file) { setError("Choose an image file first."); return; }
		if (kind === "mask" && !originalId) { setError("Select the original image for this mask."); return; }
		setBusy(true);
		setError(null);
		try {
			const uploaded = await stageAndPromoteAsset(file, kind, kind === "mask" ? originalId : undefined);
			await onUploaded(uploaded);
		} catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
	};
	return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
		<section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="upload-asset-title">
			<div className="modal-header"><div><span className="eyebrow">UPLOAD SOURCE FILE</span><h2 id="upload-asset-title">Add an image or mask</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close asset upload dialog">×</button></div>
			<form onSubmit={upload}>
				<label htmlFor="asset-kind">Asset type</label><select id="asset-kind" value={kind} onChange={(event) => { setKind(event.currentTarget.value as "image" | "mask"); setError(null); }}><option value="image">Image</option><option value="mask">Mask</option></select>
				{kind === "mask" && <><label htmlFor="mask-original">Original input image</label><select id="mask-original" value={originalId} onChange={(event) => setOriginalId(event.currentTarget.value)}><option value="">Select an image…</option>{originals.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.original_filename || asset.asset_id} · {shortId(asset.asset_id)}</option>)}</select>{originals.length === 0 && <p className="field-hint">Upload a ready image first; masks are paired to an original image.</p>}</>}
				<label className="file-drop asset-drop" htmlFor="asset-file"><span className="file-drop-icon"><Icon name="upload" /></span><strong>{file?.name || "Choose an image file"}</strong><span>{file ? `${formatBytes(file.size)} · selected from this device` : "PNG, JPEG, WebP, GIF, BMP or TIFF"}</span><input id="asset-file" aria-label="Image file" type="file" accept="image/*" onChange={(event) => { setFile(event.currentTarget.files?.[0] ?? null); setError(null); }} /></label>
				<p className="field-hint">The selected file is uploaded to this Hub and ComfyUI. No local file path is sent as a remote tool argument.</p>
				{error && <div className="inline-error" role="alert">{error}</div>}
				<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy || !file || (kind === "mask" && !originalId)}>{busy ? "Uploading…" : "Upload asset"}<Icon name="arrow" /></button></div>
			</form>
		</section>
	</div>;
}

function AssetSection({ title, count, text, assets, onCopied }: { title: string; count: number; text: string; assets: AssetRecord[]; onCopied: () => void }) {
	return <section className="asset-section"><div className="section-toolbar"><div><h2>{title} <span className="count-inline">{count}</span></h2><p>{text}</p></div></div><div className="asset-grid">{assets.map((asset) => <AssetCard key={asset.asset_id} asset={asset} onCopied={onCopied} />)}</div></section>;
}

function AssetCard({ asset, onCopied }: { asset: AssetRecord; onCopied: () => void }) {
	const url = safeAssetUrl(asset.download_url);
	const contentType = asset.content_type?.toLowerCase() ?? "";
	const previewableImage = contentType.startsWith("image/") && !contentType.includes("svg");
	const ready = asset.status === "ready" && url !== null;
	const label = asset.original_filename || asset.filename || `${asset.kind} ${shortId(asset.asset_id)}`;
	const copyValue = async () => {
		if (!asset.workflow_value) return;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(asset.workflow_value);
			} else {
				const field = document.createElement("textarea");
				field.value = asset.workflow_value;
				field.setAttribute("readonly", "");
				field.style.position = "fixed";
				field.style.left = "-9999px";
				document.body.append(field);
				field.select();
				const copied = document.execCommand("copy");
				field.remove();
				if (!copied) return;
			}
			onCopied();
		} catch { /* clipboard permissions vary by browser */ }
	};
	return <article className="asset-card">
		<div className="asset-preview">
			{ready && previewableImage && <img src={url!} alt={label} loading="lazy" />}
			{ready && contentType.startsWith("video/") && <video src={url!} controls preload="metadata" aria-label={`Preview ${label}`} />}
			{ready && contentType.startsWith("audio/") && <div className="audio-preview"><span className="audio-disc"><Icon name="audio" /></span><audio src={url!} controls preload="metadata" aria-label={`Preview ${label}`} /></div>}
			{(!ready || (!previewableImage && !contentType.startsWith("video/") && !contentType.startsWith("audio/"))) && <span className="asset-fallback"><Icon name={asset.kind === "audio" ? "audio" : asset.kind === "video" ? "video" : "file"} /><span>{ready ? asset.kind.toUpperCase() : asset.status === "pending" ? "Archiving…" : asset.status}</span></span>}
		</div>
		<div className="asset-card-body"><div className="asset-card-title"><div><strong title={label}>{label}</strong><span>{asset.kind} · {formatBytes(asset.bytes)}</span></div><StatusBadge status={asset.status} compact /></div>
			<div className="asset-card-meta"><span>{asset.origin === "input" ? "Input original" : `Job ${shortId(asset.job_id || "")}`}</span><span>{formatDate(asset.created_at)}</span></div>
			{asset.origin === "output" && asset.job_id && <span className="asset-source">Node {asset.node_id || "—"} · {asset.output_key || "output"}</span>}
			{asset.workflow_value && <div className="workflow-value"><span>COMFYUI WORKFLOW VALUE</span><code title={asset.workflow_value}>{asset.workflow_value}</code><button type="button" className="copy-button" onClick={copyValue} aria-label={`Copy workflow value ${asset.workflow_value}`}><Icon name="copy" />Copy</button></div>}
			{ready && <a className="asset-download" href={url!} download={downloadName(asset)}><Icon name="download" />Download original <span>{formatBytes(asset.bytes)}</span></a>}
		</div>
	</article>;
}

function CatalogPage(props: {
	tab: "nodes" | "models";
	setTab: (tab: "nodes" | "models") => void;
	nodeQuery: string;
	setNodeQuery: (value: string) => void;
	modelQuery: string;
	setModelQuery: (value: string) => void;
	nodes: Array<Record<string, unknown>>;
	models: Array<{ folder: string; name: string }>;
	busy: boolean;
	error: string | null;
	detailTitle: string | null;
	detail: Record<string, unknown> | null;
	onNode: (nodeId: string) => void;
	onModel: (folder: string, name: string) => void;
	qwenGuide: Record<string, unknown> | null;
	guideBusy: boolean;
	onGuide: () => void;
}) {
	return <>
		<div className="page-heading"><div><div className="eyebrow">READ-ONLY DISCOVERY</div><h1>Know what’s installed.</h1><p>Explore live node schemas and model files from the connected ComfyUI server.</p></div></div>
		<div className="catalog-notice"><Icon name="eye" /><p>Catalog data is read-only. This workspace has no canvas editor, installation controls, or account sign-in.</p></div>
		<div className="catalog-layout">
			<section className="catalog-browser">
				<div className="catalog-tabs" role="tablist" aria-label="Catalog type"><button role="tab" aria-selected={props.tab === "nodes"} className={props.tab === "nodes" ? "tab-active" : ""} onClick={() => props.setTab("nodes")}>Nodes</button><button role="tab" aria-selected={props.tab === "models"} className={props.tab === "models" ? "tab-active" : ""} onClick={() => props.setTab("models")}>Models</button></div>
				<label className="search-box"><Icon name="search" /><span className="sr-only">Search {props.tab}</span><input value={props.tab === "nodes" ? props.nodeQuery : props.modelQuery} onChange={(event) => props.tab === "nodes" ? props.setNodeQuery(event.currentTarget.value) : props.setModelQuery(event.currentTarget.value)} placeholder={props.tab === "nodes" ? "Search node names, categories…" : "Search model folders and files…"} /><kbd>⌕</kbd></label>
				<div className="catalog-list" aria-live="polite">
					{props.busy && <LoadingState label={`Searching ${props.tab}…`} />}{props.error && <ErrorState message={props.error} />}
					{!props.busy && !props.error && props.tab === "nodes" && props.nodes.length === 0 && <div className="catalog-empty">No matching nodes were returned.</div>}
					{!props.busy && !props.error && props.tab === "nodes" && props.nodes.map((node) => <button className={`catalog-row ${props.detailTitle === node.node_id ? "catalog-row-selected" : ""}`} key={String(node.node_id)} onClick={() => props.onNode(String(node.node_id))}><span className="catalog-row-icon"><Icon name="node" /></span><span><strong>{String(node.display_name || node.node_id)}</strong><small>{String(node.category || "Uncategorized")}</small></span><span className="catalog-row-end"><small>{typeof node.inputs_count === "number" ? `${node.inputs_count} inputs` : "Node"}</small><Icon name="chevron" /></span></button>)}
					{!props.busy && !props.error && props.tab === "models" && props.models.length === 0 && <div className="catalog-empty">No matching model files were returned.</div>}
					{!props.busy && !props.error && props.tab === "models" && props.models.map((model) => <button className={`catalog-row ${props.detailTitle === `${model.folder}/${model.name}` ? "catalog-row-selected" : ""}`} key={`${model.folder}/${model.name}`} onClick={() => props.onModel(model.folder, model.name)}><span className="catalog-row-icon model-icon"><Icon name="file" /></span><span><strong>{model.name}</strong><small>{model.folder}</small></span><span className="catalog-row-end"><Icon name="chevron" /></span></button>)}
				</div>
			</section>
			<aside className="catalog-detail">
				<div className="catalog-detail-header"><div><div className="eyebrow">DETAILS</div><h2>{props.detailTitle || "Select a result"}</h2></div><span className="read-only-pill"><Icon name="eye" />READ ONLY</span></div>
				{props.detailTitle && !props.detail && !props.busy && <LoadingState label="Loading full detail…" />}
				{props.detail && <><p className="catalog-detail-description">{typeof props.detail.description === "string" ? props.detail.description : props.tab === "models" ? "Installed model file and loader choices." : "Full live node schema from ComfyUI object_info."}</p><pre className="schema-view">{safeJson(props.detail)}</pre></>}
				{!props.detailTitle && !props.qwenGuide && <div className="guide-promo"><div className="guide-icon">Q</div><span className="eyebrow">CURATED FIELD GUIDE</span><h3>Qwen Image 2.1</h3><p>Model files, loader wiring, and settings checked against the shared workflow reference.</p><button className="button button-secondary" onClick={props.onGuide} disabled={props.guideBusy}>{props.guideBusy ? "Loading guide…" : "Open model guide"}<Icon name="arrow" /></button></div>}
				{props.qwenGuide && <QwenGuide guide={props.qwenGuide} />}
			</aside>
		</div>
	</>;
}

function QwenGuide({ guide }: { guide: Record<string, unknown> }) {
	const files = Array.isArray(guide.model_files) ? guide.model_files.filter(isRecord) : [];
	return <div className="qwen-guide"><div className="guide-icon">Q</div><span className="eyebrow">VERSIONED MODEL GUIDE</span><h3>{String(guide.title || "Qwen Image 2.1")}</h3><p>Reference values are curated from the repository’s saved API workflow. Live install checks are shown per file.</p><div className="guide-status"><span className={`status-dot status-${guide.installation_status === "all_files_installed" ? "complete" : "running"}`} />{String(guide.installation_status || guide.status || "Guide available")}</div>
		<div className="guide-files">{files.map((file, index) => <div className="guide-file" key={`${String(file.filename)}-${index}`}><span className="guide-file-icon"><Icon name="file" /></span><div><strong>{String(file.filename)}</strong><span>{String(file.role)} · {String(file.expected_folder || "folder not mapped")}</span></div><StatusBadge status={file.installed === true ? "ready" : "not installed"} compact /></div>)}</div>
		{isRecord(guide.parameters) && <details className="raw-details"><summary>Workflow parameters</summary><pre>{safeJson(guide.parameters)}</pre></details>}
	</div>;
}

function NavButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: string; label: string; badge?: number }) {
	return <button className={`nav-button ${active ? "nav-active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}><Icon name={icon} /><span>{label}</span>{badge !== undefined && <small>{badge}</small>}</button>;
}

function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
	return <span className={`status-badge badge-${statusTone(status)} ${compact ? "badge-compact" : ""}`}><span className={`status-dot status-${statusTone(status)}`} />{displayStatus(status)}</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
	return <div className="fact-row"><span>{label}</span><strong>{value}</strong></div>;
}

function LoadingState({ label }: { label: string }) {
	return <div className="loading-state" role="status"><span className="spinner" />{label}</div>;
}

function ErrorState({ message }: { message: string }) {
	return <div className="error-state" role="alert"><Icon name="warning" /><div><strong>Couldn’t load this view.</strong><span>{message}</span></div></div>;
}

function EmptyState({ icon, title, text, action }: { icon: string; title: string; text: string; action?: ReactNode }) {
	return <div className="empty-state"><span className="empty-state-icon"><Icon name={icon} /></span><h2>{title}</h2><p>{text}</p>{action}</div>;
}

function Icon({ name }: { name: string }) {
	const paths: Record<string, ReactNode> = {
		spark: <><path d="m12 3 1.2 5.8L19 11l-5.8 1.2L12 18l-1.2-5.8L5 11l5.8-2.2L12 3Z" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" /></>,
		board: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 8h.01M8 12h.01M12 8h4M12 12h4M8 16h8" /></>,
		workflow: <><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /><path d="M10 7h3a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2M6.5 10v4a2 2 0 0 0 2 2H14" /></>,
		asset: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
		search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
		queue: <><path d="M4 6h16M4 12h12M4 18h9" /><circle cx="19" cy="18" r="2" /></>,
		pulse: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
		server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" /></>,
		plus: <><path d="M12 5v14M5 12h14" /></>,
		upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" /></>,
		info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
		check: <><path d="m5 12 4 4L19 6" /></>,
		shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
		lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
		download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5" /><path d="M5 17v3h14v-3" /></>,
		chevron: <><path d="m9 18 6-6-6-6" /></>,
		play: <><path d="m8 5 12 7-12 7V5Z" /></>,
		arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
		copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
		audio: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
		video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-3v10l-4-3" /></>,
		file: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Z" /><path d="M13 3v7h7M8 14h8M8 17h8" /></>,
		node: <><rect x="8" y="8" width="8" height="8" rx="1" /><path d="M12 3v5M12 16v5M3 12h5M16 12h5" /></>,
		eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
		warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
	};
	return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}

function columnForStatus(status?: string): BoardColumn {
	if (!status || ["unknown", "pending", "submission_unknown", "queued", "created"].includes(status)) return "queue";
	if (["in_progress", "running", "processing"].includes(status)) return "running";
	if (["failed", "error", "submission_rejected", "rejected"].includes(status)) return "failed";
	if (["completed", "complete", "success", "succeeded", "cancelled"].includes(status)) return "completed";
	return "queue";
}

function furthestJobStatus(...statuses: Array<string | undefined>): string | undefined {
	let selected: string | undefined;
	let selectedRank = -1;
	for (const status of statuses) {
		if (typeof status !== "string") continue;
		const rank = jobStatusRank(status);
		if (rank >= selectedRank) {
			selected = status;
			selectedRank = rank;
		}
	}
	return selected;
}

function jobStatusRank(status: string): number {
	if (["pending", "queued", "created"].includes(status)) return 1;
	if (["in_progress", "running", "processing"].includes(status)) return 2;
	if (["completed", "complete", "success", "succeeded", "failed", "error", "submission_rejected", "rejected", "cancelled"].includes(status)) return 3;
	return 0;
}

function isArchiveRetryStatus(status?: string): boolean {
	return ["completed", "complete", "success", "succeeded", "failed"].includes(status ?? "");
}

function statusTone(status: string): string {
	if (["pending", "submission_unknown", "queued", "created", "unknown"].includes(status)) return "pending";
	if (["in_progress", "running", "processing"].includes(status)) return "running";
	if (["completed", "complete", "success", "succeeded", "ready", "cancelled"].includes(status)) return "complete";
	if (["failed", "error", "submission_rejected", "rejected"].includes(status)) return "failed";
	return "neutral";
}

function displayStatus(status: string): string {
	if (["in_progress", "running", "processing"].includes(status)) return "Running";
	if (["pending", "queued", "created"].includes(status)) return "Queued";
	if (status === "submission_unknown") return "Checking submission";
	if (status === "submission_rejected" || status === "rejected") return "Rejected";
	if (["completed", "complete", "success", "succeeded"].includes(status)) return "Completed";
	if (status === "cancelled") return "Cancelled";
	return titleCase(status.replaceAll("_", " "));
}

function jobLabel(job: JobRecord): string {
	if (typeof job.workflow_name === "string" && job.workflow_name) return job.workflow_name;
	if (typeof job.workflow_id === "string") return "Saved workflow run";
	return "External ComfyUI job";
}

function progressFor(job: JobRecord): { percent: number; label: string } | null {
	const live = isRecord(job.progress) ? job.progress : null;
	const state = Array.isArray(job.progress_state) ? job.progress_state.find((entry) => isRecord(entry) && typeof entry.value === "number" && typeof entry.max === "number") : undefined;
	const value = typeof live?.value === "number" ? live.value : isRecord(state) && typeof state.value === "number" ? state.value : null;
	const max = typeof live?.max === "number" ? live.max : isRecord(state) && typeof state.max === "number" ? state.max : null;
	if (value === null || max === null || max <= 0) return null;
	const percent = Math.max(0, Math.min(100, Math.round(value / max * 100)));
	return { percent, label: `${percent}%${job.current_node?.node_id ? ` · node ${job.current_node.node_id}` : ""}` };
}

function machineSummary(value: Record<string, unknown> | null): { label: string; detail: string } {
	if (!value) return { label: "Checking…", detail: "Live ComfyUI stats" };
	const devices = Array.isArray(value.devices) ? value.devices : [];
	const first = isRecord(devices[0]) ? devices[0] : null;
	const system = isRecord(value.system) ? value.system : null;
	const name = typeof first?.name === "string" ? first.name : null;
	const version = typeof system?.comfyui_version === "string" ? system.comfyui_version : null;
	const freeVram = typeof first?.vram_free === "number" ? formatBytes(first.vram_free) : null;
	const details = [freeVram ? `${freeVram} free VRAM` : null, version ? `ComfyUI ${version}` : "ComfyUI connected"].filter(Boolean).join(" · ");
	return name ? { label: name.length > 21 ? `${name.slice(0, 19)}…` : name, detail: details } : { label: "Connected", detail: details || "Live ComfyUI stats" };
}

function arrayLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function relativeTime(value: unknown): string {
	const date = toDate(value);
	if (!date) return "Just now";
	const seconds = Math.round((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "Just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatDate(value: unknown): string {
	const date = toDate(value);
	return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Date unavailable";
}

function toDate(value: unknown): Date | null {
	const raw = typeof value === "number" ? value < 100_000_000_000 ? value * 1000 : value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	const date = new Date(raw);
	return Number.isFinite(date.getTime()) ? date : null;
}

function formatBytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "Size unknown";
	if (value < 1024) return `${value} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let amount = value / 1024;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
	return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function shortId(value: string): string {
	return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function titleCase(value: string): string {
	return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function safeJson(value: unknown): string {
	try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function parseEvent<T>(event: Event): T | null {
	try { return JSON.parse((event as MessageEvent<string>).data) as T; } catch { return null; }
}

function safeAssetUrl(value: string | null): string | null {
	if (!value || typeof window === "undefined") return null;
	try {
		const url = new URL(value, window.location.href);
		return url.origin === window.location.origin && url.pathname.startsWith("/api/v1/assets/") ? url.href : null;
	} catch { return null; }
}

function downloadName(asset: AssetRecord): string {
	return asset.original_filename || asset.filename || `${asset.asset_id}.${asset.kind}`;
}

function readSavedRequestId(workflowId: string): string | null {
	try { return window.sessionStorage.getItem(`comfy-hub:request-id:${workflowId}`); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActiveStatus(status?: string): boolean {
	return status === "in_progress" || status === "pending" || status === "submission_unknown";
}
