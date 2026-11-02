// Bridge entry point: storage and recovery, game window capture,
// message reception, fixed test replies and LoD pool publication.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AttemptInput, ModelAdapter } from './ai/adapter.js';
import { ClaudeAdapter, resolveClaudePath } from './ai/claude.js';
import { CodexAdapter, resolveCodexPath } from './ai/codex.js';
import { FixedModelAdapter } from './ai/fixed.js';
import { OpenRouterAdapter } from './ai/openrouter.js';
import { checkHosted, stopConfirmed } from './ai/process-host.js';
import { ToolChannelHub } from './app/tool-channel.js';
import { AltsSource } from './sources/alts.js';
import { accountBrief, accountView } from './domain/alts.js';
import { activePlanBrief } from './domain/plan.js';
import { resourcePath } from './paths.js';
import { Bridge } from './app/bridge.js';
import { systemClock } from './clock.js';
import { dataPaths, defaultDataDir, loadConfig } from './config.js';
import { JsonlDiagnostics } from './diagnostics.js';
import { DatasetManager } from './sources/foreverdb/update.js';
import { QuestieDatasetManager } from './sources/questiedb/update.js';
import { Store, StoreError } from './storage/store.js';
import { PowerShellCapture } from './transport/capture.js';
import { DeliveryPublisher, SlotPool } from './transport/delivery.js';
import { FrameReceiver } from './transport/receiver.js';

async function main(): Promise<number> {
  const paths = dataPaths(defaultDataDir());
  for (const dir of [paths.dataDir, paths.cache, paths.backups, paths.logs, paths.run, paths.sessions]) mkdirSync(dir, { recursive: true });
  const config = loadConfig(paths.config);
  const diag = new JsonlDiagnostics({ dir: paths.logs, clock: systemClock, echo: true, includeContent: config.logContent });

  let store: Store;
  try {
    store = Store.open({ path: paths.database, clock: systemClock, backupDir: paths.backups });
    if (store.migrationBackup) console.log(`Database schema updated without losing data; backup: ${store.migrationBackup}.`);
  } catch (error) {
    if (error instanceof StoreError && error.code === 'locked') {
      console.error('The bridge is already running: another instance holds the assistant database.');
      return 2;
    }
    console.error(`Could not open the assistant database: ${(error as Error).message}`);
    return 1;
  }

  // Write only to this installation's pool slots (tools/install.ts).
  let publisher: DeliveryPublisher | null = null;
  if (config.addonsPath) {
    const pool = new SlotPool(config.addonsPath);
    const check = pool.check();
    if (check.ok) publisher = new DeliveryPublisher({ store, pool, clock: systemClock, diag });
    else {
      console.error(
        `LoD pool is not ready (missing slots: ${check.missing.length}, foreign slots: ${check.foreign.length}). Run bun run install:addon.`,
      );
    }
  } else {
    console.error('AddOns directory is not configured: run bun run install:addon --addons "<WoW>\\Interface\\AddOns".');
  }

  // ForeverDB: open the last working dataset immediately; update in the background every 24 hours.
  const datasets = new DatasetManager({ store, cacheDir: paths.cache, clock: systemClock, diag });
  datasets.start();
  const questiedb = new QuestieDatasetManager({ store, cacheDir: paths.cache, clock: systemClock, diag });
  questiedb.loadActive();

  // Alts: addon SavedVariables under <WoW>\WTF next to the AddOns directory.
  const alts = new AltsSource(config.addonsPath);
  const channels = new ToolChannelHub({
    store,
    clock: systemClock,
    diag,
    datasets: { sourceFor: (id) => datasets.sourceFor(id) },
    questiedb,
    alts,
    onCommitted: () => publisher?.schedule(),
  });
  const account = (input: AttemptInput) => (alts.configured ? accountBrief(accountView(alts.load().records, input.query, input.request.characterKey)) : null);
  const activePlan = (input: AttemptInput) => activePlanBrief(store, input.query.activePlan);
  const schemaPath = resourcePath('schemas', 'model-reply.schema.json');
  let adapter: ModelAdapter;
  if (config.modelAdapter === 'openrouter') {
    const apiKey = config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? null;
    if (!apiKey) {
      console.error('OpenRouter API key was not found: set openrouterApiKey in config.json or the OPENROUTER_API_KEY environment variable.');
      store.close();
      return 1;
    }
    adapter = new OpenRouterAdapter({
      apiKey,
      model: config.openrouterModel,
      reasoningEffort: config.openrouterReasoningEffort,
      webSearch: config.openrouterWebSearch,
      schemaPath,
      sessionsDir: paths.sessions,
      channels,
      diag,
      account,
      activePlan,
    });
  } else if (config.modelAdapter === 'claude') {
    const claudePath = resolveClaudePath(config.claudePath);
    if (!claudePath) {
      console.error('Claude Code CLI was not found: set claudePath in config.json.');
      store.close();
      return 1;
    }
    adapter = new ClaudeAdapter({
      command: { exe: claudePath, prefixArgs: [] },
      runDir: paths.run,
      schemaPath,
      mcp: { exe: process.execPath, script: fileURLToPath(new URL('./sources/mcp.ts', import.meta.url)) },
      channels,
      diag,
      model: config.claudeModel,
      effort: config.claudeEffort,
      apiKey: config.claudeApiKey,
      account,
      activePlan,
    });
  } else if (config.modelAdapter === 'codex') {
    const codexPath = resolveCodexPath(config.codexPath);
    if (!codexPath) {
      console.error('Codex CLI was not found: set codexPath in config.json.');
      store.close();
      return 1;
    }
    const codex = new CodexAdapter({
      command: { exe: codexPath, prefixArgs: [] },
      runDir: paths.run,
      schemaPath,
      mcp: { exe: process.execPath, script: fileURLToPath(new URL('./sources/mcp.ts', import.meta.url)) },
      channels,
      diag,
      model: config.codexModel,
      account,
      activePlan,
    });
    const profile = await codex.prepare();
    if (profile.missingHard.length > 0) {
      console.error(`Codex ${codexPath} cannot disable required features: ${profile.missingHard.join(', ')}. Startup stopped.`);
      store.close();
      return 1;
    }
    adapter = codex;
  } else {
    adapter = new FixedModelAdapter({ delayMs: config.fixedReplyDelayMs });
  }
  questiedb.start();
  const bridge = new Bridge({
    store,
    clock: systemClock,
    diag,
    adapter,
    onCommitted: () => publisher?.schedule(),
    onPriceResult: (lookupId) => channels.resolvePrice(lookupId),
    datasetId: () => datasets.source?.datasetId ?? null,
    confirmStop: async (attempt) => stopConfirmed(await checkHosted(attempt.jobName, attempt.childPid, attempt.childCreatedAt)),
  });
  const report = await bridge.startWithStopChecks();
  publisher?.publishNow();

  const receiver = new FrameReceiver({ receive: (message) => bridge.receive(message), clock: systemClock, diag });
  const capture = new PowerShellCapture({ processName: config.gameProcessName, diag });
  capture.start({
    frame: (image) => receiver.onImage(image),
    status: (code, detail) => diag.event('capture.status', { code, detail }),
  });
  diag.event('bridge.started', {
    dataDir: paths.dataDir,
    adapter: adapter.name,
    interruptedAttempts: report.interruptedAttempts,
    acceptedRequests: report.acceptedRequests,
    pool: publisher !== null,
    dataset: datasets.source?.datasetId ?? null,
    questiedb: questiedb.source?.datasetId ?? null,
    gameProcess: config.gameProcessName,
  });
  console.log('Bridge started; press Ctrl+C to stop.');

  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(keepAlive);
  await capture.stop();
  await datasets.stop();
  await questiedb.stop();
  publisher?.stop();
  await bridge.shutdown();
  store.close();
  diag.event('bridge.stopped');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
