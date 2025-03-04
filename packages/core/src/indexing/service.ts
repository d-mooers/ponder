import type { Common } from "@/Ponder.js";
import type { IndexingFunctions } from "@/build/functions/functions.js";
import type {
  FunctionIds,
  TableIds,
} from "@/build/static/getFunctionAndTableIds.js";
import {
  type TableAccess,
  getTableAccessInverse,
  isReadStoreMethod,
  isWriteStoreMethod,
} from "@/build/static/getTableAccess.js";
import type { Network } from "@/config/networks.js";
import {
  type Source,
  sourceIsFactory,
  sourceIsLogFilter,
} from "@/config/sources.js";
import type { DatabaseService, FunctionMetadata } from "@/database/service.js";
import { NonRetryableError } from "@/errors/base.js";
import type { IndexingStore } from "@/indexing-store/store.js";
import type { Schema } from "@/schema/types.js";
import type { SyncGateway } from "@/sync-gateway/service.js";
import type { SyncStore } from "@/sync-store/store.js";
import type { Block, Log, Transaction } from "@/types/eth.js";
import type { StoreMethod } from "@/types/model.js";
import {
  type Checkpoint,
  checkpointMax,
  checkpointMin,
  isCheckpointEqual,
  isCheckpointGreaterThan,
  isCheckpointGreaterThanOrEqualTo,
  zeroCheckpoint,
} from "@/utils/checkpoint.js";
import { Emittery } from "@/utils/emittery.js";
import { formatPercentage } from "@/utils/format.js";
import { prettyPrint } from "@/utils/print.js";
import { type Queue, type Worker, createQueue } from "@/utils/queue.js";
import type { RequestQueue } from "@/utils/requestQueue.js";
import { startClock } from "@/utils/timer.js";
import { wait } from "@/utils/wait.js";
import { dedupe } from "@ponder/common";
import type { AbiEvent } from "abitype";
import { E_CANCELED, Mutex } from "async-mutex";
import { type Hex, decodeEventLog } from "viem";
import {
  type Context,
  buildClient,
  buildContracts,
  buildDb,
  buildNetwork,
} from "./context.js";
import { addUserStackTrace } from "./trace.js";

type IndexingEvents = {
  eventsProcessed: { toCheckpoint: Checkpoint };
  error: { error: Error };
};

type SetupTask = {
  kind: "SETUP";
  data: {
    networkName: string;
    contractName: string;
    checkpoint: Checkpoint;
  };
};
type LogEventTask = {
  kind: "LOG";
  data: {
    networkName: string;
    contractName: string;
    eventName: string;
    event: {
      args: any;
      log: Log;
      block: Block;
      transaction: Transaction;
    };
    checkpoint: Checkpoint;
    endCheckpoint?: Checkpoint;
    eventsProcessed?: number;
  };
};

type IndexingFunctionTask = SetupTask | LogEventTask;
type IndexingFunctionQueue = Queue<IndexingFunctionTask>;

const MAX_BATCH_SIZE = 10_000;

export class IndexingService extends Emittery<IndexingEvents> {
  private common: Common;
  private indexingStore: IndexingStore;
  private database: DatabaseService;
  private syncGatewayService: SyncGateway;
  private sources: Source[];
  private networks: Network[];

  private isPaused = false;

  private indexingFunctions?: IndexingFunctions;
  private schema?: Schema;
  private tableAccess?: TableAccess;
  private tableIds?: TableIds;
  private functionIds?: FunctionIds;

  queue?: IndexingFunctionQueue;

  private flushInterval?: NodeJS.Timeout;
  private isFlushIntervalExec = false;

  private getNetwork: (checkpoint: Checkpoint) => Context["network"] =
    undefined!;
  private getClient: (checkpoint: Checkpoint) => Context["client"] = undefined!;
  private getDB: ReturnType<typeof buildDb> = undefined!;
  private getContracts: (checkpoint: Checkpoint) => Context["contracts"] =
    undefined!;

  private isSetupStarted;

  private setupFunctionStates: Record<
    /* Indexing function key: "{ContractName}:setup */
    string,
    {
      contractName: string;
      isComplete: boolean;
    }
  > = {};

  /* Mutex ensuring tasks are not loaded twice. */
  private loadingMutex: Mutex;

  private indexingFunctionStates: Record<
    /* Indexing function key: "{ContractName}:{EventName}" */
    string,
    {
      contractName: string;
      eventName: string;
      /* Indexing function keys that write to tables that this indexing function key reads from. */
      parents: string[];
      /* True if this key is a parent of itself. */
      isSelfDependent: boolean;
      /* Sources that contribute to this indexing function. */
      sources: Source[];
      abiEvent: AbiEvent;
      eventSelector: Hex;

      /* Checkpoint of max completed task. */
      tasksProcessedToCheckpoint: Checkpoint;
      /* Checkpoint of the least recent task loaded from db. */
      tasksLoadedFromCheckpoint: Checkpoint;
      /* Checkpoint of the most recent task loaded from db. */
      tasksLoadedToCheckpoint: Checkpoint;
      /* Buffer of in memory tasks that haven't been enqueued yet. */
      loadedTasks: LogEventTask[];
      /* Checkpoint of the first loaded event (for metrics). */
      firstEventCheckpoint?: Checkpoint;
      /* Checkpoint of the last loaded event (for metrics). */
      lastEventCheckpoint?: Checkpoint;

      eventCount: number;
    }
  > = {};

  private sourceById: { [sourceId: Source["id"]]: Source } = {};

  constructor({
    common,
    database,
    syncStore,
    indexingStore,
    syncGatewayService,
    networks,
    requestQueues,
    sources,
  }: {
    common: Common;
    database: DatabaseService;
    syncStore: SyncStore;
    indexingStore: IndexingStore;
    syncGatewayService: SyncGateway;
    networks: Network[];
    requestQueues: RequestQueue[];
    sources: Source[];
  }) {
    super();
    this.common = common;
    this.database = database;
    this.indexingStore = indexingStore;
    this.syncGatewayService = syncGatewayService;
    this.sources = sources;
    this.networks = networks;

    this.isSetupStarted = false;

    this.buildSourceById();

    this.getNetwork = buildNetwork({ networks });
    this.getClient = buildClient({ networks, requestQueues, syncStore });
    this.getContracts = buildContracts({ sources });

    this.loadingMutex = new Mutex();
  }

  kill = async () => {
    this.isPaused = true;

    clearInterval(this.flushInterval);

    this.queue?.pause();
    this.queue?.clear();
    this.loadingMutex.cancel();
    this.common.logger.debug({
      service: "indexing",
      msg: "Killed indexing service",
    });

    await this.flush();
  };

  onIdle = () => this.queue!.onIdle();

  /**
   * Registers a new set of indexing functions, schema, or table accesss, cancels
   * the database mutexes & event queue, and rebuilds the indexing function map state.
   *
   * Note: Caller should (probably) call processEvents shortly after this method.
   */
  reset = async ({
    indexingFunctions: newIndexingFunctions,
    schema: newSchema,
    tableAccess: newTableAccess,
    tableIds: newTableIds,
    functionIds: newFunctionIds,
  }: {
    indexingFunctions?: IndexingFunctions;
    schema?: Schema;
    tableAccess?: TableAccess;
    tableIds?: TableIds;
    functionIds?: FunctionIds;
  } = {}) => {
    if (newSchema) {
      this.schema = newSchema;

      this.getDB = buildDb({
        common: this.common,
        indexingStore: this.indexingStore,
        schema: this.schema,
      });
    }

    if (newIndexingFunctions) {
      this.indexingFunctions = newIndexingFunctions;
    }

    if (newTableAccess) {
      this.tableAccess = newTableAccess;
    }

    if (newTableIds) {
      this.tableIds = newTableIds;
    }

    if (newFunctionIds) {
      this.functionIds = newFunctionIds;
    }

    if (
      this.indexingFunctions === undefined ||
      this.sources === undefined ||
      this.tableAccess === undefined ||
      this.tableIds === undefined ||
      this.functionIds === undefined
    )
      return;

    this.isPaused = true;
    await this.queue?.onIdle();
    this.isPaused = false;
    await this.flush();

    this.loadingMutex.cancel();

    this.isSetupStarted = false;

    clearInterval(this.flushInterval);

    this.common.metrics.ponder_indexing_completed_events.reset();

    await this.buildIndexingFunctionStates();
    this.createEventQueue();

    this.common.logger.debug({
      service: "indexing",
      msg: "Paused event queue",
    });

    this.isPaused = false;

    this.common.metrics.ponder_indexing_has_error.set(0);
    this.common.metrics.ponder_indexing_total_seconds.reset();
    this.common.metrics.ponder_indexing_completed_seconds.reset();
    this.common.metrics.ponder_indexing_completed_timestamp.set(0);

    this.isFlushIntervalExec = false;
    this.flushInterval = setInterval(async () => {
      if (this.isFlushIntervalExec) return;
      this.isFlushIntervalExec = true;

      this.isPaused = true;
      await this.queue?.onIdle();
      this.isPaused = false;
      await this.flush();

      this.processEvents();
      this.isFlushIntervalExec = false;
    }, 120_000);
  };

  /**
   * Processes all newly available events.
   */
  processEvents = async () => {
    if (
      Object.keys(this.indexingFunctionStates).length === 0 ||
      this.queue === undefined ||
      this.isPaused
    )
      return;

    // Only enqueue setup tasks if no checkpoints have been advanced.
    if (!this.isSetupStarted) {
      this.isSetupStarted = true;
      this.enqueueSetupTasks();
    }

    // Mark setup functions as complete
    for (const setupKey of Object.keys(this.setupFunctionStates)) {
      this.setupFunctionStates[setupKey].isComplete = true;
    }

    this.queue!.start();
    await this.queue.onIdle();

    if (isCheckpointEqual(this.syncGatewayService.checkpoint, zeroCheckpoint)) {
      return;
    }

    await this.loadingMutex.runExclusive(async () => {
      const loadKeys = this.getLoadKeys();

      await Promise.all(
        loadKeys.map((key) => this.loadIndexingFunctionTasks(key)),
      );
    });

    this.enqueueLogEventTasks();

    await this.queue.onIdle();
  };

  /**
   * This method is triggered by the realtime sync service detecting a reorg,
   * which can happen at any time. The event queue and the indexing store can be
   * in one of several different states that we need to keep in mind:
   *
   * 1) No events have been added to the queue yet.
   * 2) No unsafe events have been processed (checkpoint <= safeCheckpoint).
   * 3) Unsafe events may have been processed (checkpoint > safeCheckpoint).
   * 4) The queue has encountered a user error and is waiting for a reload.
   *
   * Note: It's crucial that we acquire all mutex locks while handling the reorg.
   * This will only ever run while the queue is idle, so we can be confident
   * that checkpoint matches the current state of the indexing store,
   * and that no unsafe events will get processed after handling the reorg.
   *
   * Note: Caller should (probably) immediately call processEvents after this method.
   */
  handleReorg = async (safeCheckpoint: Checkpoint) => {
    await this.loadingMutex.runExclusive(async () => {
      try {
        const hasProcessedInvalidEvents = Object.values(
          this.indexingFunctionStates,
        ).some((state) =>
          isCheckpointGreaterThan(
            state.tasksProcessedToCheckpoint,
            safeCheckpoint,
          ),
        );

        if (!hasProcessedInvalidEvents) {
          // No unsafe events have been processed, so no need to revert (case 1 & case 2).
          this.common.logger.debug({
            service: "indexing",
            msg: "No unsafe events were detected while reconciling a reorg, no-op",
          });
          return;
        }

        // Unsafe events have been processed, must revert the indexing store and update
        // eventsProcessedToTimestamp accordingly (case 3).
        await this.indexingStore.revert({ checkpoint: safeCheckpoint });

        this.common.metrics.ponder_indexing_completed_timestamp.set(
          safeCheckpoint.blockTimestamp,
        );

        // Note: There's currently no way to know how many events are "thrown out"
        // during the reorg reconciliation, so the event count metrics
        // (e.g. ponder_indexing_processed_events) will be slightly inflated.

        this.common.logger.debug({
          service: "indexing",
          msg: `Reverted indexing store to safe timestamp ${safeCheckpoint.blockTimestamp}`,
        });

        for (const state of Object.values(this.indexingFunctionStates)) {
          if (
            isCheckpointGreaterThan(
              state.tasksProcessedToCheckpoint,
              safeCheckpoint,
            )
          ) {
            state.tasksProcessedToCheckpoint = safeCheckpoint;
          }
          if (
            isCheckpointGreaterThan(
              state.tasksLoadedFromCheckpoint,
              safeCheckpoint,
            )
          ) {
            state.tasksLoadedFromCheckpoint = safeCheckpoint;
          }
          if (
            isCheckpointGreaterThan(
              state.tasksLoadedToCheckpoint,
              safeCheckpoint,
            )
          ) {
            state.tasksLoadedToCheckpoint = safeCheckpoint;
          }
        }
      } catch (error) {
        // Pending locks get cancelled in reset(). This is expected, so it's safe to
        // ignore the error that is thrown when a pending lock is cancelled.
        if (error !== E_CANCELED) throw error;
      }
    });
  };

  /**
   * Adds "setup" tasks to the queue for all chains if the indexing function is defined.
   */
  enqueueSetupTasks = () => {
    for (const contractName of Object.keys(this.indexingFunctions!)) {
      if (this.indexingFunctions![contractName].setup === undefined) continue;

      if (this.setupFunctionStates[`${contractName}:setup`].isComplete)
        continue;

      for (const network of this.networks) {
        const source = this.sources.find(
          (s) =>
            s.contractName === contractName && s.chainId === network.chainId,
        )!;

        // The "setup" event uses the contract start block number for contract calls.
        // TODO: Consider implications of this "synthetic" checkpoint on record versioning.
        const checkpoint = {
          ...zeroCheckpoint,
          chainId: network.chainId,
          blockNumber: source.startBlock,
        };

        this.queue!.addTask({
          kind: "SETUP",
          data: {
            networkName: network.name,
            contractName,
            checkpoint,
          },
        });
      }
    }
  };

  /**
   * Implements the core concurrency engine, responsible for ordering tasks.
   * There are several cases to consider and optimize:
   *
   * 1) A task is only dependent on itself, should be run serially.
   * 2) A task is not dependent, can be run entirely concurrently.
   * 3) A task is dependent on a combination of parents and itself,
   *    should be run serially.
   * 4) A task is dependent on parents, and should onlybe run when
   *    all previous dependent tasks are complete.
   */
  enqueueLogEventTasks = () => {
    if (this.isPaused) return;

    for (const key of Object.keys(this.indexingFunctionStates)) {
      const state = this.indexingFunctionStates[key];
      const tasks = state.loadedTasks;

      if (tasks.length === 0) continue;

      if (
        state.parents.length === 0 &&
        state.isSelfDependent &&
        isCheckpointGreaterThanOrEqualTo(
          state.tasksLoadedFromCheckpoint,
          tasks[0].data.checkpoint,
        )
      ) {
        // Case 1
        const taskToEnqueue = tasks.shift()!;
        this.queue!.addTask(taskToEnqueue);
      } else if (state.parents.length === 0 && !state.isSelfDependent) {
        // Case 2
        for (const task of tasks) {
          this.queue!.addTask(task);
        }
        state.loadedTasks = [];
      } else if (state.parents.length !== 0) {
        const parentLoadedFromCheckpoints = state.parents.map(
          (p) => this.indexingFunctionStates[p].tasksLoadedFromCheckpoint,
        );

        if (
          state.isSelfDependent &&
          isCheckpointGreaterThanOrEqualTo(
            checkpointMin(
              ...parentLoadedFromCheckpoints,
              state.tasksLoadedFromCheckpoint,
            ),
            tasks[0].data.checkpoint,
          )
        ) {
          // Case 3
          const taskToEnqueue = tasks.shift()!;
          this.queue!.addTask(taskToEnqueue);
        } else if (!state.isSelfDependent) {
          // Case 4
          // Determine limiting factor and enqueue tasks up to that limit.
          const minParentCheckpoint = checkpointMin(
            ...parentLoadedFromCheckpoints,
          );

          // Maximum checkpoint that is less than `minParentCheckpoint`.
          const maxCheckpointIndex = tasks.findIndex((task) =>
            isCheckpointGreaterThan(task.data.checkpoint, minParentCheckpoint),
          );

          if (maxCheckpointIndex === -1) {
            for (const task of tasks) {
              this.queue!.addTask(task);
            }
            state.loadedTasks = [];
          } else {
            const tasksToEnqueue = tasks.splice(0, maxCheckpointIndex);
            for (const task of tasksToEnqueue) {
              this.queue!.addTask(task);
            }
          }
        }
      }
    }
  };

  private executeSetupTask = async (task: SetupTask) => {
    if (this.isPaused) return;

    const data = task.data;

    const fullEventName = `${data.contractName}:setup`;
    const metricLabels = { network: data.networkName, event: fullEventName };

    const indexingFunction = this.indexingFunctions![data.contractName].setup;

    for (let i = 0; i < 4; i++) {
      try {
        this.common.logger.trace({
          service: "indexing",
          msg: `Started indexing function (event="${fullEventName}", block=${data.checkpoint.blockNumber})`,
        });

        const endClock = startClock();

        // Running user code here!
        await indexingFunction({
          context: {
            network: this.getNetwork(data.checkpoint),
            client: this.getClient(data.checkpoint),
            db: this.getDB({
              checkpoint: data.checkpoint,
              onTableAccess: this.onTableAccess(fullEventName),
            }),
            contracts: this.getContracts(data.checkpoint),
          },
        });

        this.common.metrics.ponder_indexing_function_duration.observe(
          metricLabels,
          endClock(),
        );

        this.common.logger.trace({
          service: "indexing",
          msg: `Completed indexing function (event="${fullEventName}", block=${data.checkpoint.blockNumber})`,
        });

        this.common.metrics.ponder_indexing_completed_events.inc(metricLabels);

        break;
      } catch (error_) {
        const error = error_ as Error & { meta: string };

        this.common.metrics.ponder_indexing_function_error_total.inc(
          metricLabels,
        );

        if (error_ instanceof NonRetryableError) i = 3;

        if (i === 3) {
          this.isPaused = true;
          this.queue!.pause();
          this.queue!.clear();

          addUserStackTrace(error, this.common.options);

          this.common.logger.error({
            service: "indexing",
            msg: `Error while processing "setup" event: ${error.message}`,
            error,
          });

          this.common.metrics.ponder_indexing_has_error.set(1);
          this.emit("error", { error });
        } else {
          this.common.logger.warn({
            service: "indexing",
            msg: `Indexing function failed, retrying... (event=${fullEventName}, error=${error.name}: ${error.message})`,
          });
          await this.indexingStore.revert({
            checkpoint: data.checkpoint,
          });
        }
      }
    }
  };

  private executeLogEventTask = async (task: LogEventTask) => {
    const data = task.data;

    const fullEventName = `${data.contractName}:${data.eventName}`;
    const metricLabels = { network: data.networkName, event: fullEventName };

    const indexingFunction =
      this.indexingFunctions![data.contractName][data.eventName];

    for (let i = 0; i < 4; i++) {
      try {
        this.common.logger.trace({
          service: "indexing",
          msg: `Started indexing function (event="${fullEventName}", block=${data.checkpoint.blockNumber})`,
        });

        const endClock = startClock();

        // Running user code here!
        await indexingFunction({
          event: {
            name: data.eventName,
            ...data.event,
          },
          context: {
            network: this.getNetwork(data.checkpoint),
            client: this.getClient(data.checkpoint),
            db: this.getDB({
              checkpoint: data.checkpoint,
              onTableAccess: this.onTableAccess(fullEventName),
            }),
            contracts: this.getContracts(data.checkpoint),
          },
        });

        this.common.metrics.ponder_indexing_function_duration.observe(
          metricLabels,
          endClock(),
        );

        const state = this.indexingFunctionStates[fullEventName];

        // Update tasksProcessedToCheckpoint
        state.tasksProcessedToCheckpoint = checkpointMax(
          state.tasksProcessedToCheckpoint,
          data.checkpoint,
        );

        // Update tasksLoadedFromCheckpoint
        if (state.loadedTasks.length > 0) {
          state.tasksLoadedFromCheckpoint =
            state.loadedTasks[0].data.checkpoint;
        } else {
          state.tasksLoadedFromCheckpoint = state.tasksLoadedToCheckpoint;
        }

        // Emit log if this is the end of a batch of logs
        if (data.eventsProcessed) {
          this.emitCheckpoint();

          const num = data.eventsProcessed;
          this.common.logger.info({
            service: "indexing",
            msg: `Indexed ${
              num === 1
                ? `1 ${fullEventName} event`
                : `${num} ${fullEventName} events`
            } (chainId=${data.checkpoint.chainId} block=${
              data.checkpoint.blockNumber
            } logIndex=${data.checkpoint.logIndex})`,
          });
        }

        this.common.logger.trace({
          service: "indexing",
          msg: `Completed indexing function (event="${fullEventName}", block=${data.checkpoint.blockNumber})`,
        });

        this.updateCompletedSeconds(fullEventName);

        this.common.metrics.ponder_indexing_completed_events.inc(metricLabels);

        state.eventCount++;

        break;
      } catch (error_) {
        const error = error_ as Error & { meta?: string };

        this.common.metrics.ponder_indexing_function_error_total.inc(
          metricLabels,
        );

        if (error_ instanceof NonRetryableError) i = 3;

        if (i === 3) {
          this.isPaused = true;
          this.queue!.pause();
          this.queue!.clear();

          addUserStackTrace(error, this.common.options);

          if (error.meta) {
            error.meta += `\nEvent args:\n${prettyPrint(data.event.args)}`;
          } else {
            error.meta = `Event args:\n${prettyPrint(data.event.args)}`;
          }

          this.common.logger.error({
            service: "indexing",
            msg: `Error while processing "${fullEventName}" event at block ${data.checkpoint.blockNumber}:`,
            error,
          });

          this.common.metrics.ponder_indexing_has_error.set(1);
          this.emit("error", { error });
        } else {
          this.common.logger.warn({
            service: "indexing",
            msg: `Indexing function failed, retrying... (event=${fullEventName}, block=${
              data.checkpoint.blockNumber
            }, error=${`${error.name}: ${error.message}`})`,
          });
          await this.indexingStore.revert({
            checkpoint: data.checkpoint,
          });
        }
      }
    }

    await this.loadingMutex.runExclusive(async () => {
      const loadKeys = this.getLoadKeys();

      await Promise.all(
        loadKeys.map((key) => this.loadIndexingFunctionTasks(key)),
      );
    });

    this.enqueueLogEventTasks();
  };

  private createEventQueue = () => {
    const indexingFunctionWorker: Worker<IndexingFunctionTask> = async ({
      task,
    }) => {
      // This is a hack to ensure that the eventsProcessed method is called and updates
      // the UI when using SQLite. It also allows the process to GC and handle SIGINT events.
      // It does, however, slow down event processing a bit. Too frequent waits cause massive performance loses.
      if (Math.floor(Math.random() * 100) === 69) await wait(0);

      switch (task.kind) {
        case "SETUP": {
          await this.executeSetupTask(task);
          break;
        }
        case "LOG": {
          await this.executeLogEventTask(task);
          break;
        }
      }
    };

    this.queue = createQueue({
      worker: indexingFunctionWorker,
      options: {
        concurrency: 10,
        autoStart: false,
      },
    });
  };

  /**
   * Load a batch of indexing function tasks from the sync store into memory.
   */
  loadIndexingFunctionTasks = async (key: string) => {
    const state = this.indexingFunctionStates[key];
    const tasks = state.loadedTasks;

    // TODO: Deep copy these.
    const fromCheckpoint = state.tasksLoadedToCheckpoint;
    const toCheckpoint = this.syncGatewayService.checkpoint;

    if (
      isCheckpointGreaterThanOrEqualTo(fromCheckpoint, toCheckpoint) &&
      state.lastEventCheckpoint !== undefined
    ) {
      return;
    }

    const taskBatchSize = this.calculateTaskBatchSize(key);

    const sourcesHasFactory = state.sources.some(sourceIsFactory);

    const result = await this.syncGatewayService.getEvents({
      fromCheckpoint,
      toCheckpoint,
      limit: taskBatchSize,
      ...(sourcesHasFactory
        ? {
            factories: state.sources.filter(sourceIsFactory).map((factory) => ({
              id: factory.id,
              chainId: factory.chainId,
              criteria: factory.criteria,
              fromBlock: factory.startBlock,
              toBlock: factory.endBlock,
              eventSelector: state.eventSelector,
            })),
          }
        : {
            logFilters: state.sources
              .filter(sourceIsLogFilter)
              .map((logFilter) => ({
                id: logFilter.id,
                chainId: logFilter.chainId,
                criteria: logFilter.criteria,
                fromBlock: logFilter.startBlock,
                toBlock: logFilter.endBlock,
                eventSelector: state.eventSelector,
              })),
          }),
    });

    const { events, hasNextPage, lastCheckpointInPage, lastCheckpoint } =
      result;

    const previousLength = tasks.length;

    for (const event of events) {
      try {
        const decodedLog = decodeEventLog({
          abi: [state.abiEvent],
          data: event.log.data,
          topics: event.log.topics,
        });

        tasks.push({
          kind: "LOG",
          data: {
            networkName: "mainnet",
            contractName: state.contractName,
            eventName: state.eventName,
            event: {
              args: decodedLog.args ?? {},
              log: event.log,
              block: event.block,
              transaction: event.transaction,
            },
            checkpoint: {
              blockNumber: Number(event.block.number),
              blockTimestamp: Number(event.block.timestamp),
              chainId: event.chainId,
              logIndex: event.log.logIndex,
            },
          },
        });
      } catch (err) {
        // Sometimes, logs match a selector but cannot be decoded using the provided ABI.
        // This happens often when using custom event filters, because the indexed-ness
        // of an event parameter is not taken into account when generating the selector.
        this.common.logger.debug({
          service: "app",
          msg: `Unable to decode log, skipping it. id: ${event.log.id}, data: ${event.log.data}, topics: ${event.log.topics}`,
        });
      }
    }

    // Update tasksLoadedToCheckpoint
    state.tasksLoadedToCheckpoint = hasNextPage
      ? lastCheckpointInPage
      : toCheckpoint;

    // Update tasksLoadedFromCheckpoint
    if (tasks.length > 0) {
      if (previousLength === 0) {
        state.tasksLoadedFromCheckpoint = tasks[0].data.checkpoint;
      }

      // Add a flag to emit logs and checkpoints
      tasks[tasks.length - 1].data.eventsProcessed = events.length;

      // Update firstEventCheckpoint
      if (state.firstEventCheckpoint === undefined) {
        state.firstEventCheckpoint = tasks[0].data.checkpoint;
      }
    } else {
      state.tasksLoadedFromCheckpoint = state.tasksLoadedToCheckpoint;

      this.emitCheckpoint();
    }

    // Update lastEventCheckpoint
    if (
      lastCheckpoint === undefined &&
      state.lastEventCheckpoint === undefined
    ) {
      // Fully cached path, first load
      state.lastEventCheckpoint = toCheckpoint;

      this.logCachedProgress(key);
      this.updateTotalSeconds(key);
      this.updateCompletedSeconds(key);
    } else if (
      lastCheckpoint !== undefined &&
      state.lastEventCheckpoint === undefined
    ) {
      // Partially cached path, first load
      state.lastEventCheckpoint = lastCheckpoint;

      this.logCachedProgress(key);
      this.updateTotalSeconds(key);
      this.updateCompletedSeconds(key);
    } else if (
      lastCheckpoint !== undefined &&
      state.lastEventCheckpoint !== undefined
    ) {
      // Subsequent loads
      state.lastEventCheckpoint = checkpointMax(
        lastCheckpoint,
        state.lastEventCheckpoint,
      );

      this.updateTotalSeconds(key);
      this.updateCompletedSeconds(key);
    }
  };

  private emitCheckpoint = () => {
    const checkpoint = checkpointMin(
      ...Object.keys(this.indexingFunctionStates).map((key) => {
        return this.getStateCheckpoint(key);
      }),
    );

    this.emit("eventsProcessed", { toCheckpoint: checkpoint });
    this.common.metrics.ponder_indexing_completed_timestamp.set(
      checkpoint.blockTimestamp,
    );
  };

  private flush = async () => {
    const indexingFunctionMetadata = Object.entries(this.indexingFunctionStates)
      .map(([indexingFunctionKey, state]) => {
        const stateCheckpoint = this.getStateCheckpoint(indexingFunctionKey);

        const toCheckpoint = checkpointMin(
          stateCheckpoint,
          this.syncGatewayService.finalityCheckpoint,
        );

        return {
          functionId: this.functionIds![indexingFunctionKey],
          functionName: indexingFunctionKey,
          fromCheckpoint: state.firstEventCheckpoint ?? null,
          toCheckpoint,
          eventCount: state.eventCount,
        };
      })
      .filter(
        ({ toCheckpoint }) => !isCheckpointEqual(toCheckpoint, zeroCheckpoint),
      );

    const setupFunctionMetadata = Object.entries(this.setupFunctionStates)
      .map(([setupFunctionKey, state]) =>
        state.isComplete
          ? {
              functionId: this.functionIds![setupFunctionKey],
              functionName: setupFunctionKey,
              fromCheckpoint: null,
              toCheckpoint: zeroCheckpoint,
              eventCount: 0,
            }
          : null,
      )
      .filter((m) => m !== null) as FunctionMetadata[];

    await this.database.flush(
      indexingFunctionMetadata.concat(setupFunctionMetadata),
    );
  };

  private buildSourceById = () => {
    for (const source of this.sources) {
      this.sourceById[source.id] = source;
    }
  };

  private buildIndexingFunctionStates = async () => {
    if (
      this.indexingFunctions === undefined ||
      this.sources === undefined ||
      this.tableAccess === undefined ||
      this.tableIds === undefined ||
      this.functionIds === undefined
    )
      return;

    // clear in case of reloads
    this.indexingFunctionStates = {};
    this.setupFunctionStates = {};

    const checkpoints: {
      [functionId: string]: Omit<
        FunctionMetadata,
        "functionId" | "functionName"
      >;
    } = {};
    const metadata = this.database.functionMetadata;

    for (const m of metadata) {
      checkpoints[m.functionId] = {
        fromCheckpoint: m.fromCheckpoint,
        toCheckpoint: m.toCheckpoint,
        eventCount: m.eventCount,
      };
    }

    for (const contractName of Object.keys(this.indexingFunctions)) {
      // Not sure why this is necessary
      // @ts-ignore
      for (const eventName of Object.keys(
        this.indexingFunctions[contractName],
      )) {
        const indexingFunctionKey = `${contractName}:${eventName}`;

        if (eventName === "setup") {
          const indexingFunctionKey = `${contractName}:${eventName}`;

          const checkpoint =
            checkpoints[this.functionIds[indexingFunctionKey]]!;

          this.setupFunctionStates[indexingFunctionKey] = {
            contractName,
            isComplete: checkpoint ? true : false,
          };

          continue;
        }

        // All tables that this indexing function key reads
        const tableReads = this.tableAccess[indexingFunctionKey]?.access
          ?.filter((t) => isReadStoreMethod(t.storeMethod))
          .map((t) => t.tableName);

        // All indexing function keys that write to a table in `tableReads`
        // except for itself.
        const parents: string[] = [];
        const inverseTableAccess = getTableAccessInverse(this.tableAccess);
        for (const tableName of tableReads) {
          for (const {
            indexingFunctionKey: parentIndexingFunctionKey,
            storeMethod,
          } of inverseTableAccess[tableName]) {
            if (
              !parentIndexingFunctionKey.includes(":setup") &&
              isWriteStoreMethod(storeMethod) &&
              parentIndexingFunctionKey !== indexingFunctionKey
            )
              parents.push(parentIndexingFunctionKey);
          }
        }

        const isSelfDependent = this.tableAccess[
          indexingFunctionKey
        ]?.access?.some(
          (t) =>
            isWriteStoreMethod(t.storeMethod) &&
            tableReads.includes(t.tableName),
        );

        const keySources = this.sources.filter(
          (s) => s.contractName === contractName,
        );

        // Note: Assumption is that all sources with the same contract name have the same abi.
        const i = this.sources.findIndex(
          (s) =>
            s.contractName === contractName &&
            s.abiEvents.bySafeName[eventName] !== undefined,
        );

        const abiEvent = this.sources[i].abiEvents.bySafeName[eventName]!.item;
        const eventSelector =
          this.sources[i].abiEvents.bySafeName[eventName]!.selector;

        this.common.logger.debug({
          service: "indexing",
          msg: `Registered indexing function "${indexingFunctionKey}" with table access [${
            this.tableAccess[indexingFunctionKey]?.access
              ?.map(
                ({ storeMethod, tableName }) => `${tableName}.${storeMethod}()`,
              )
              ?.join(", ") ?? ""
          }]`,
        });

        const checkpoint = checkpoints[this.functionIds[indexingFunctionKey]]!;

        this.indexingFunctionStates[indexingFunctionKey] = {
          eventName,
          contractName,
          parents: dedupe(parents),
          isSelfDependent,
          sources: keySources,
          abiEvent,
          eventSelector,

          tasksProcessedToCheckpoint:
            checkpoint?.toCheckpoint ?? zeroCheckpoint,
          tasksLoadedFromCheckpoint: checkpoint?.toCheckpoint ?? zeroCheckpoint,
          tasksLoadedToCheckpoint: checkpoint?.toCheckpoint ?? zeroCheckpoint,
          firstEventCheckpoint: checkpoint?.fromCheckpoint ?? undefined,
          loadedTasks: [],
          eventCount: checkpoint?.eventCount ?? 0,
        };

        if (checkpoint?.eventCount) {
          const labels = {
            network: "",
            event: indexingFunctionKey,
          };
          this.common.metrics.ponder_indexing_completed_events.set(
            labels,
            checkpoint.eventCount,
          );
        }
      }
    }
  };

  private updateCompletedSeconds = (key: string) => {
    const state = this.indexingFunctionStates[key];
    if (
      state.firstEventCheckpoint === undefined ||
      state.lastEventCheckpoint === undefined
    )
      return;

    this.common.metrics.ponder_indexing_completed_seconds.set(
      { event: `${state.contractName}:${state.eventName}` },
      Math.min(
        state.tasksLoadedFromCheckpoint.blockTimestamp,
        state.lastEventCheckpoint.blockTimestamp,
      ) - state.firstEventCheckpoint.blockTimestamp,
    );
  };

  private updateTotalSeconds = (key: string) => {
    const state = this.indexingFunctionStates[key];
    if (
      state.firstEventCheckpoint === undefined ||
      state.lastEventCheckpoint === undefined
    )
      return;

    this.common.metrics.ponder_indexing_total_seconds.set(
      { event: `${state.contractName}:${state.eventName}` },
      state.lastEventCheckpoint.blockTimestamp -
        state.firstEventCheckpoint.blockTimestamp,
    );
  };

  /** Determine the task batch size to use accounting for tasks that already finished loading. */
  private calculateTaskBatchSize = (key: string): number => {
    let totalBatchSize = MAX_BATCH_SIZE;
    let unfinishedCount = Object.keys(this.indexingFunctionStates).length;

    for (const [indexingFunctionKey, state] of Object.entries(
      this.indexingFunctionStates,
    )) {
      if (key === indexingFunctionKey) continue;

      if (this.isIndexingFunctionFullLoaded(indexingFunctionKey)) {
        totalBatchSize -= state.loadedTasks.length;
        unfinishedCount -= 1;
      }
    }

    return Math.floor(totalBatchSize / unfinishedCount);
  };

  private logCachedProgress = (key: string) => {
    const state = this.indexingFunctionStates[key];

    const numerator =
      state.firstEventCheckpoint === undefined ||
      state.lastEventCheckpoint === undefined
        ? 0
        : Math.min(
            state.tasksProcessedToCheckpoint.blockTimestamp,
            state.lastEventCheckpoint.blockTimestamp,
          ) - state.firstEventCheckpoint.blockTimestamp;

    const denominator =
      state.firstEventCheckpoint === undefined ||
      state.lastEventCheckpoint === undefined
        ? 1
        : state.lastEventCheckpoint.blockTimestamp -
          state.firstEventCheckpoint.blockTimestamp;

    const cache = formatPercentage(Math.max(numerator / denominator, 0));
    this.common.logger.info({
      service: "indexing",
      msg: `Started indexing ${state.contractName}:${state.eventName} with ${cache} cached.`,
    });
  };

  /** Get keys that need to be loaded. */
  private getLoadKeys = (): string[] => {
    const emptyKey = Object.keys(this.indexingFunctionStates).find((key) => {
      const state = this.indexingFunctionStates[key];

      return (
        state.loadedTasks.length === 0 &&
        !this.isIndexingFunctionFullLoaded(key)
      );
    });

    if (emptyKey === undefined) return [];

    const minBatchSize = this.calculateTaskBatchSize(emptyKey) / 3;

    const loadKeys: string[] = [];

    for (const [indexingFunctionKey, state] of Object.entries(
      this.indexingFunctionStates,
    )) {
      if (!state.lastEventCheckpoint) loadKeys.push(indexingFunctionKey);
      else if (
        !this.isIndexingFunctionFullLoaded(indexingFunctionKey) &&
        state.loadedTasks.length < minBatchSize
      ) {
        loadKeys.push(indexingFunctionKey);
      }
    }

    return loadKeys;
  };

  /**
   * Returns true is all known events have been processed or loaded.
   */
  private isIndexingFunctionFullLoaded = (key: string): boolean => {
    const state = this.indexingFunctionStates[key];

    if (state.lastEventCheckpoint === undefined) return false;
    // Function is loaded when the "loadedToCheckpoint" is greater than
    // the "lastEventCheckpoint" and the "syncGatewayService.checkpoint"
    return (
      isCheckpointGreaterThanOrEqualTo(
        state.tasksLoadedToCheckpoint,
        state.lastEventCheckpoint,
      ) &&
      isCheckpointGreaterThanOrEqualTo(
        state.tasksLoadedToCheckpoint,
        this.syncGatewayService.checkpoint,
      )
    );
  };

  /** Returns the most generous checkpoint possible for an indexing function. */
  private getStateCheckpoint = (key: string): Checkpoint => {
    const state = this.indexingFunctionStates[key];

    return state.loadedTasks.length === 0
      ? state.tasksLoadedToCheckpoint
      : state.tasksProcessedToCheckpoint;
  };

  private onTableAccess =
    (indexingFunctionKey: string) =>
    ({
      storeMethod,
      tableName,
    }: { storeMethod: StoreMethod; tableName: string }) => {
      const matchedAccess = this.tableAccess?.[
        indexingFunctionKey
      ]?.access?.find(
        (t) => t.storeMethod === storeMethod && t.tableName === tableName,
      );

      if (matchedAccess === undefined) {
        this.common.logger.warn({
          service: "indexing",
          msg: `Unexpected table access "${tableName}.${storeMethod}()" in indexing function "${indexingFunctionKey}". This may cause event ordering issues. Please open an issue http://github.com/ponder-sh/ponder/issues.`,
        });
      }
    };
}
