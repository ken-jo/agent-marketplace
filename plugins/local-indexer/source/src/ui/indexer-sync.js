/** Apply the SDK's merged context, since change notifications contain deltas. */
export function syncHostContext(app, scope, documentRoot) {
  const apply = () => {
    const context = app.getHostContext();
    for (const [key, value] of Object.entries(context?.styles?.variables ?? {})) {
      if (typeof value === "string") documentRoot.style.setProperty(key, value);
    }
    scope.dataset.shell = context?.theme || "light";
    documentRoot.style.colorScheme = context?.theme || "light dark";
  };
  app.onhostcontextchanged = apply;
  apply();
  return () => { app.onhostcontextchanged = undefined; };
}

/** A retry owns its listener until either the timer or abort settles it. */
export function waitForRetry(delayMs, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** One outstanding app wait; snapshot callbacks are the view's actual loaders. */
export async function runIndexerSync({
  callTool, loadSettings, readScanStatus, getScanStatus, loadFolders,
  refreshDocuments, signal, onError,
}) {
  let cursor = "";
  try {
    // Capture before snapshots so changes during initialization replay.
    cursor = (await callTool("index_wait_changes", { cursor, waitMs: 0 })).cursor;
  } catch {
    // A transient cursor failure must not prevent independent snapshots.
  }
  for (const load of [loadSettings, loadFolders, readScanStatus, refreshDocuments]) {
    if (signal.aborted) return;
    try { await load(); }
    catch (error) {
      if (signal.aborted) return;
      onError(error);
      cursor = ""; // Retry missed snapshots through an explicit reset.
    }
  }

  let scanInProgress = getScanStatus() === "running";
  let retryMs = 1000;
  while (!signal.aborted) {
    try {
      const update = await callTool("index_wait_changes", { cursor, waitMs: 10000 });
      if (signal.aborted) return;
      if (update.closed) {
        await waitForRetry(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 10000);
        continue;
      }
      if (!update.reset && !update.changes.length) {
        cursor = update.cursor;
        retryMs = 1000;
        continue;
      }
      scanInProgress ||= getScanStatus() === "running";
      await readScanStatus();
      if (signal.aborted) return;
      const running = getScanStatus() === "running";
      scanInProgress ||= running;
      if (getScanStatus() === "idle") scanInProgress = false;
      const completed = update.changes.some(change => change.kind === "index.scan.completed");
      const canceled = scanInProgress && getScanStatus() === "canceled";
      const documentsChanged = update.changes.some(change => change.kind === "index.document.updated");
      const foldersChanged = update.changes.some(change => change.kind === "index.folders.changed");
      // Counters keep moving, but re-paging the entire index per file is costly.
      // Defer document invalidations until the single completion reload below.
      if (update.reset) {
        await loadSettings();
        if (signal.aborted) return;
      }
      if (update.reset || foldersChanged || completed || canceled || (documentsChanged && !scanInProgress)) {
        await loadFolders();
        if (signal.aborted) return;
        await refreshDocuments();
      }
      if (completed || canceled || update.reset) scanInProgress = running;
      // Commit the cursor only after its snapshots have been applied.
      cursor = update.cursor;
      retryMs = 1000;
    } catch (error) {
      if (signal.aborted) return;
      onError(error);
      await waitForRetry(retryMs, signal);
      retryMs = Math.min(retryMs * 2, 10000);
    }
  }
}
