import type { Common } from "@/Ponder.js";
import type { FactoryCriteria, LogFilterCriteria } from "@/config/sources.js";
import { NonRetryableError } from "@/errors/base.js";
import type { Block, Log, Transaction } from "@/types/eth.js";
import type { NonNull } from "@/types/utils.js";
import type { Checkpoint } from "@/utils/checkpoint.js";
import {
  buildFactoryFragments,
  buildLogFilterFragments,
} from "@/utils/fragments.js";
import { intervalIntersectionMany, intervalUnion } from "@/utils/interval.js";
import { range } from "@/utils/range.js";
import { startClock } from "@/utils/timer.js";
import {
  type ExpressionBuilder,
  Kysely,
  Migrator,
  PostgresDialect,
  type Transaction as KyselyTransaction,
  WithSchemaPlugin,
  sql,
} from "kysely";
import type { Pool } from "pg";
import {
  type Hex,
  type RpcBlock,
  type RpcLog,
  type RpcTransaction,
  checksumAddress,
} from "viem";
import type { SyncStore } from "../store.js";
import {
  type SyncStoreTables,
  rpcToPostgresBlock,
  rpcToPostgresLog,
  rpcToPostgresTransaction,
} from "./encoding.js";
import { migrationProvider, moveLegacyTables } from "./migrations.js";

export class PostgresSyncStore implements SyncStore {
  kind = "postgres" as const;

  private common: Common;
  private schemaName: string;
  db: Kysely<SyncStoreTables>;

  constructor({
    common,
    pool,
    schemaName,
  }: { common: Common; pool: Pool; schemaName: string }) {
    this.common = common;
    this.schemaName = schemaName;
    this.db = new Kysely<SyncStoreTables>({
      dialect: new PostgresDialect({ pool }),
      log(event) {
        if (event.level === "query") {
          common.metrics.ponder_postgres_query_total.inc({ pool: "sync" });
        }
      },
    }).withPlugin(new WithSchemaPlugin(schemaName));
  }

  migrateUp = async () => {
    return this.wrap({ method: "migrateUp" }, async () => {
      // TODO: Probably remove this at 1.0 to speed up startup time.
      await moveLegacyTables({
        common: this.common,
        db: this.db,
        newSchemaName: this.schemaName,
      });

      const migrator = new Migrator({
        db: this.db,
        provider: migrationProvider,
        migrationTableSchema: this.schemaName,
      });

      const { error } = await migrator.migrateToLatest();
      if (error) throw error;
    });
  };

  insertLogFilterInterval = async ({
    chainId,
    logFilter,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
    interval,
  }: {
    chainId: number;
    logFilter: LogFilterCriteria;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    return this.wrap({ method: "insertLogFilterInterval" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto("blocks")
          .values({ ...rpcToPostgresBlock(rpcBlock), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();

        if (rpcTransactions.length > 0) {
          await tx
            .insertInto("transactions")
            .values(
              rpcTransactions.map((transaction) => ({
                ...rpcToPostgresTransaction(transaction),
                chainId,
              })),
            )
            .onConflict((oc) => oc.column("hash").doNothing())
            .execute();
        }

        if (rpcLogs.length > 0) {
          await tx
            .insertInto("logs")
            .values(
              rpcLogs.map((log) => ({
                ...rpcToPostgresLog(log),
                chainId,
              })),
            )
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }

        await this._insertLogFilterInterval({
          tx,
          chainId,
          logFilters: [logFilter],
          interval,
        });
      });
    });
  };

  getLogFilterIntervals = async ({
    chainId,
    logFilter,
  }: {
    chainId: number;
    logFilter: LogFilterCriteria;
  }) => {
    return this.wrap({ method: "getLogFilterIntervals" }, async () => {
      const fragments = buildLogFilterFragments({ ...logFilter, chainId });

      // First, attempt to merge overlapping and adjacent intervals.
      await Promise.all(
        fragments.map(async (fragment) => {
          return await this.db.transaction().execute(async (tx) => {
            const { id: logFilterId } = await tx
              .insertInto("logFilters")
              .values(fragment)
              .onConflict((oc) => oc.column("id").doUpdateSet(fragment))
              .returningAll()
              .executeTakeFirstOrThrow();

            const existingIntervalRows = await tx
              .deleteFrom("logFilterIntervals")
              .where("logFilterId", "=", logFilterId)
              .returningAll()
              .execute();

            const mergedIntervals = intervalUnion(
              existingIntervalRows.map((i) => [
                Number(i.startBlock),
                Number(i.endBlock),
              ]),
            );

            const mergedIntervalRows = mergedIntervals.map(
              ([startBlock, endBlock]) => ({
                logFilterId,
                startBlock: BigInt(startBlock),
                endBlock: BigInt(endBlock),
              }),
            );

            if (mergedIntervalRows.length > 0) {
              await tx
                .insertInto("logFilterIntervals")
                .values(mergedIntervalRows)
                .execute();
            }

            return mergedIntervals;
          });
        }),
      );

      const intervals = await this.db
        .with(
          "logFilterFragments(fragmentId, fragmentAddress, fragmentTopic0, fragmentTopic1, fragmentTopic2, fragmentTopic3)",
          () =>
            sql`( values ${sql.join(
              fragments.map(
                (f) =>
                  sql`( ${sql.val(f.id)}, ${sql.val(f.address)}, ${sql.val(
                    f.topic0,
                  )}, ${sql.val(f.topic1)}, ${sql.val(f.topic2)}, ${sql.val(
                    f.topic3,
                  )} )`,
              ),
            )} )`,
        )
        .selectFrom("logFilterIntervals")
        .leftJoin("logFilters", "logFilterId", "logFilters.id")
        .innerJoin("logFilterFragments", (join) => {
          let baseJoin = join.on(({ or, cmpr }) =>
            or([
              cmpr("address", "is", null),
              cmpr("fragmentAddress", "=", sql.ref("address")),
            ]),
          );
          for (const idx_ of range(0, 4)) {
            baseJoin = baseJoin.on(({ or, cmpr }) => {
              const idx = idx_ as 0 | 1 | 2 | 3;
              return or([
                cmpr(`topic${idx}`, "is", null),
                cmpr(`fragmentTopic${idx}`, "=", sql.ref(`topic${idx}`)),
              ]);
            });
          }

          return baseJoin;
        })
        .select(["fragmentId", "startBlock", "endBlock"])
        .where("chainId", "=", chainId)
        .execute();

      const intervalsByFragmentId = intervals.reduce(
        (acc, cur) => {
          const { fragmentId, startBlock, endBlock } = cur;
          (acc[fragmentId] ||= []).push([Number(startBlock), Number(endBlock)]);
          return acc;
        },
        {} as Record<string, [number, number][]>,
      );

      const intervalsForEachFragment = fragments.map((f) =>
        intervalUnion(intervalsByFragmentId[f.id] ?? []),
      );
      return intervalIntersectionMany(intervalsForEachFragment);
    });
  };

  insertFactoryChildAddressLogs = async ({
    chainId,
    logs: rpcLogs,
  }: {
    chainId: number;
    logs: RpcLog[];
  }) => {
    return this.wrap({ method: "insertFactoryChildAddressLogs" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        if (rpcLogs.length > 0) {
          await tx
            .insertInto("logs")
            .values(
              rpcLogs.map((log) => ({
                ...rpcToPostgresLog(log),
                chainId,
              })),
            )
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }
      });
    });
  };

  async *getFactoryChildAddresses({
    chainId,
    upToBlockNumber,
    factory,
    pageSize = 500,
  }: {
    chainId: number;
    upToBlockNumber: bigint;
    factory: FactoryCriteria;
    pageSize?: number;
  }) {
    const { address, eventSelector, childAddressLocation } = factory;
    const selectChildAddressExpression =
      buildFactoryChildAddressSelectExpression({ childAddressLocation });

    const baseQuery = this.db
      .selectFrom("logs")
      .select([selectChildAddressExpression.as("childAddress"), "blockNumber"])
      .where("chainId", "=", chainId)
      .where("address", "=", address)
      .where("topic0", "=", eventSelector)
      .where("blockNumber", "<=", upToBlockNumber)
      .limit(pageSize);

    let cursor: bigint | undefined = undefined;

    while (true) {
      let query = baseQuery;

      if (cursor) {
        query = query.where("blockNumber", ">", cursor);
      }

      const batch = await this.wrap(
        { method: "getFactoryChildAddresses" },
        () => query.execute(),
      );

      const lastRow = batch[batch.length - 1];
      if (lastRow) {
        cursor = lastRow.blockNumber;
      }

      if (batch.length > 0) {
        yield batch.map((a) => a.childAddress);
      }

      if (batch.length < pageSize) break;
    }
  }

  insertFactoryLogFilterInterval = async ({
    chainId,
    factory,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
    interval,
  }: {
    chainId: number;
    factory: FactoryCriteria;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    return this.wrap({ method: "insertFactoryLogFilterInterval" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto("blocks")
          .values({ ...rpcToPostgresBlock(rpcBlock), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();

        for (const rpcTransaction of rpcTransactions) {
          await tx
            .insertInto("transactions")
            .values({ ...rpcToPostgresTransaction(rpcTransaction), chainId })
            .onConflict((oc) => oc.column("hash").doNothing())
            .execute();
        }

        for (const rpcLog of rpcLogs) {
          await tx
            .insertInto("logs")
            .values({ ...rpcToPostgresLog(rpcLog), chainId })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }

        await this._insertFactoryLogFilterInterval({
          tx,
          chainId,
          factories: [factory],
          interval,
        });
      });
    });
  };

  getFactoryLogFilterIntervals = async ({
    chainId,
    factory,
  }: {
    chainId: number;
    factory: FactoryCriteria;
  }) => {
    return this.wrap({ method: "getFactoryLogFilterIntervals" }, async () => {
      const fragments = buildFactoryFragments({
        ...factory,
        chainId,
      });

      await Promise.all(
        fragments.map(async (fragment) => {
          await this.db.transaction().execute(async (tx) => {
            const { id: factoryId } = await tx
              .insertInto("factories")
              .values(fragment)
              .onConflict((oc) => oc.column("id").doUpdateSet(fragment))
              .returningAll()
              .executeTakeFirstOrThrow();

            const existingIntervals = await tx
              .deleteFrom("factoryLogFilterIntervals")
              .where("factoryId", "=", factoryId)
              .returningAll()
              .execute();

            const mergedIntervals = intervalUnion(
              existingIntervals.map((i) => [
                Number(i.startBlock),
                Number(i.endBlock),
              ]),
            );

            const mergedIntervalRows = mergedIntervals.map(
              ([startBlock, endBlock]) => ({
                factoryId,
                startBlock: BigInt(startBlock),
                endBlock: BigInt(endBlock),
              }),
            );

            if (mergedIntervalRows.length > 0) {
              await tx
                .insertInto("factoryLogFilterIntervals")
                .values(mergedIntervalRows)
                .execute();
            }

            return mergedIntervals;
          });
        }),
      );

      const intervals = await this.db
        .with(
          "factoryFilterFragments(fragmentId, fragmentAddress, fragmentEventSelector, fragmentChildAddressLocation, fragmentTopic0, fragmentTopic1, fragmentTopic2, fragmentTopic3)",
          () =>
            sql`( values ${sql.join(
              fragments.map(
                (f) =>
                  sql`( ${sql.val(f.id)}, ${sql.val(f.address)}, ${sql.val(
                    f.eventSelector,
                  )}, ${sql.val(f.childAddressLocation)}, ${sql.val(
                    f.topic0,
                  )}, ${sql.val(f.topic1)}, ${sql.val(f.topic2)}, ${sql.val(
                    f.topic3,
                  )} )`,
              ),
            )} )`,
        )
        .selectFrom("factoryLogFilterIntervals")
        .leftJoin("factories", "factoryId", "factories.id")
        .innerJoin("factoryFilterFragments", (join) => {
          let baseJoin = join.on(({ and, cmpr }) =>
            and([
              cmpr("fragmentAddress", "=", sql.ref("address")),
              cmpr("fragmentEventSelector", "=", sql.ref("eventSelector")),
              cmpr(
                "fragmentChildAddressLocation",
                "=",
                sql.ref("childAddressLocation"),
              ),
            ]),
          );
          for (const idx_ of range(0, 4)) {
            baseJoin = baseJoin.on(({ or, cmpr }) => {
              const idx = idx_ as 0 | 1 | 2 | 3;
              return or([
                cmpr(`topic${idx}`, "is", null),
                cmpr(`fragmentTopic${idx}`, "=", sql.ref(`topic${idx}`)),
              ]);
            });
          }

          return baseJoin;
        })
        .select(["fragmentId", "startBlock", "endBlock"])
        .where("chainId", "=", chainId)
        .execute();

      const intervalsByFragmentId = intervals.reduce(
        (acc, cur) => {
          const { fragmentId, startBlock, endBlock } = cur;
          (acc[fragmentId] ||= []).push([Number(startBlock), Number(endBlock)]);
          return acc;
        },
        {} as Record<string, [number, number][]>,
      );

      const intervalsForEachFragment = fragments.map((f) =>
        intervalUnion(intervalsByFragmentId[f.id] ?? []),
      );
      return intervalIntersectionMany(intervalsForEachFragment);
    });
  };

  insertRealtimeBlock = async ({
    chainId,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
  }: {
    chainId: number;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
  }) => {
    return this.wrap({ method: "insertRealtimeBlock" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto("blocks")
          .values({ ...rpcToPostgresBlock(rpcBlock), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();

        for (const rpcTransaction of rpcTransactions) {
          await tx
            .insertInto("transactions")
            .values({ ...rpcToPostgresTransaction(rpcTransaction), chainId })
            .onConflict((oc) => oc.column("hash").doNothing())
            .execute();
        }

        for (const rpcLog of rpcLogs) {
          await tx
            .insertInto("logs")
            .values({ ...rpcToPostgresLog(rpcLog), chainId })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }
      });
    });
  };

  insertRealtimeInterval = async ({
    chainId,
    logFilters,
    factories,
    interval,
  }: {
    chainId: number;
    logFilters: LogFilterCriteria[];
    factories: FactoryCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    return this.wrap({ method: "insertRealtimeInterval" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        await this._insertLogFilterInterval({
          tx,
          chainId,
          logFilters: [
            ...logFilters,
            ...factories.map((f) => ({
              address: f.address,
              topics: [f.eventSelector],
            })),
          ],
          interval,
        });

        await this._insertFactoryLogFilterInterval({
          tx,
          chainId,
          factories,
          interval,
        });
      });
    });
  };

  deleteRealtimeData = async ({
    chainId,
    fromBlock,
  }: {
    chainId: number;
    fromBlock: bigint;
  }) => {
    return this.wrap({ method: "deleteRealtimeData" }, async () => {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .deleteFrom("blocks")
          .where("chainId", "=", chainId)
          .where("number", ">", fromBlock)
          .execute();
        await tx
          .deleteFrom("transactions")
          .where("chainId", "=", chainId)
          .where("blockNumber", ">", fromBlock)
          .execute();
        await tx
          .deleteFrom("logs")
          .where("chainId", "=", chainId)
          .where("blockNumber", ">", fromBlock)
          .execute();
        await tx
          .deleteFrom("rpcRequestResults")
          .where("chainId", "=", chainId)
          .where("blockNumber", ">", fromBlock)
          .execute();

        // Delete all intervals with a startBlock greater than fromBlock.
        // Then, if any intervals have an endBlock greater than fromBlock,
        // update their endBlock to equal fromBlock.
        await tx
          .deleteFrom("logFilterIntervals")
          .where(
            (qb) =>
              qb
                .selectFrom("logFilters")
                .select("logFilters.chainId")
                .whereRef(
                  "logFilters.id",
                  "=",
                  "logFilterIntervals.logFilterId",
                )
                .limit(1),
            "=",
            chainId,
          )
          .where("startBlock", ">", fromBlock)
          .execute();
        await tx
          .updateTable("logFilterIntervals")
          .set({ endBlock: fromBlock })
          .where(
            (qb) =>
              qb
                .selectFrom("logFilters")
                .select("logFilters.chainId")
                .whereRef(
                  "logFilters.id",
                  "=",
                  "logFilterIntervals.logFilterId",
                )
                .limit(1),
            "=",
            chainId,
          )
          .where("endBlock", ">", fromBlock)
          .execute();

        await tx
          .deleteFrom("factoryLogFilterIntervals")
          .where(
            (qb) =>
              qb
                .selectFrom("factories")
                .select("factories.chainId")
                .whereRef(
                  "factories.id",
                  "=",
                  "factoryLogFilterIntervals.factoryId",
                )
                .limit(1),
            "=",
            chainId,
          )
          .where("startBlock", ">", fromBlock)
          .execute();
        await tx
          .updateTable("factoryLogFilterIntervals")
          .set({ endBlock: fromBlock })
          .where(
            (qb) =>
              qb
                .selectFrom("factories")
                .select("factories.chainId")
                .whereRef(
                  "factories.id",
                  "=",
                  "factoryLogFilterIntervals.factoryId",
                )
                .limit(1),
            "=",
            chainId,
          )
          .where("endBlock", ">", fromBlock)
          .execute();
      });
    });
  };

  /** SYNC HELPER METHODS */

  private _insertLogFilterInterval = async ({
    tx,
    chainId,
    logFilters,
    interval: { startBlock, endBlock },
  }: {
    tx: KyselyTransaction<SyncStoreTables>;
    chainId: number;
    logFilters: LogFilterCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    const logFilterFragments = logFilters.flatMap((logFilter) =>
      buildLogFilterFragments({ ...logFilter, chainId }),
    );

    await Promise.all(
      logFilterFragments.map(async (logFilterFragment) => {
        const { id: logFilterId } = await tx
          .insertInto("logFilters")
          .values(logFilterFragment)
          .onConflict((oc) => oc.column("id").doUpdateSet(logFilterFragment))
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto("logFilterIntervals")
          .values({ logFilterId, startBlock, endBlock })
          .execute();
      }),
    );
  };

  private _insertFactoryLogFilterInterval = async ({
    tx,
    chainId,
    factories,
    interval: { startBlock, endBlock },
  }: {
    tx: KyselyTransaction<SyncStoreTables>;
    chainId: number;
    factories: FactoryCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    const factoryFragments = factories.flatMap((factory) =>
      buildFactoryFragments({ ...factory, chainId }),
    );

    await Promise.all(
      factoryFragments.map(async (fragment) => {
        const { id: factoryId } = await tx
          .insertInto("factories")
          .values(fragment)
          .onConflict((oc) => oc.column("id").doUpdateSet(fragment))
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto("factoryLogFilterIntervals")
          .values({ factoryId, startBlock, endBlock })
          .execute();
      }),
    );
  };

  insertRpcRequestResult = async ({
    request,
    blockNumber,
    chainId,
    result,
  }: {
    request: string;
    blockNumber: bigint;
    chainId: number;
    result: string;
  }) => {
    return this.wrap({ method: "insertRpcRequestResult" }, async () => {
      await this.db
        .insertInto("rpcRequestResults")
        .values({ request, blockNumber, chainId, result })
        .onConflict((oc) =>
          oc.constraint("rpcRequestResultPrimaryKey").doUpdateSet({ result }),
        )
        .execute();
    });
  };

  getRpcRequestResult = async ({
    request,
    blockNumber,
    chainId,
  }: {
    request: string;
    blockNumber: bigint;
    chainId: number;
  }) => {
    return this.wrap({ method: "getRpcRequestResult" }, async () => {
      const contractReadResult = await this.db
        .selectFrom("rpcRequestResults")
        .selectAll()
        .where("request", "=", request)
        .where("blockNumber", "=", blockNumber)
        .where("chainId", "=", chainId)
        .executeTakeFirst();

      return contractReadResult ?? null;
    });
  };

  async getLogEvents({
    fromCheckpoint,
    toCheckpoint,
    limit,
    logFilters = undefined,
    factories = undefined,
  }: {
    fromCheckpoint: Checkpoint;
    toCheckpoint: Checkpoint;
    limit: number;
  } & (
    | {
        logFilters: {
          id: string;
          chainId: number;
          criteria: LogFilterCriteria;
          fromBlock?: number;
          toBlock?: number;
          eventSelector: Hex;
        }[];
        factories: undefined;
      }
    | {
        logFilters: undefined;
        factories: {
          id: string;
          chainId: number;
          criteria: FactoryCriteria;
          fromBlock?: number;
          toBlock?: number;
          eventSelector: Hex;
        }[];
      }
  )) {
    return this.wrap({ method: "getLogEvents" }, async () => {
      // Get full log objects, including the eventSelector clause.
      const [requestedLogs, lastCheckpointRows] = await Promise.all([
        this.db
          .selectFrom("logs")
          .leftJoin("blocks", "blocks.hash", "logs.blockHash")
          .leftJoin("transactions", "transactions.hash", "logs.transactionHash")
          .where((eb) => {
            const logFilterCmprs =
              logFilters?.map((logFilter) => {
                const exprs = this.buildLogFilterCmprs({ eb, logFilter });

                exprs.push(eb("logs.topic0", "=", logFilter.eventSelector));

                return eb.and(exprs);
              }) ?? [];

            const factoryCmprs =
              factories?.map((factory) => {
                const exprs = this.buildFactoryCmprs({ eb, factory });

                exprs.push(eb("logs.topic0", "=", factory.eventSelector));

                return eb.and(exprs);
              }) ?? [];

            return eb.or([...logFilterCmprs, ...factoryCmprs]);
          })
          .select([
            "logs.address as log_address",
            "logs.blockHash as log_blockHash",
            "logs.blockNumber as log_blockNumber",
            "logs.chainId as log_chainId",
            "logs.data as log_data",
            "logs.id as log_id",
            "logs.logIndex as log_logIndex",
            "logs.topic0 as log_topic0",
            "logs.topic1 as log_topic1",
            "logs.topic2 as log_topic2",
            "logs.topic3 as log_topic3",
            "logs.transactionHash as log_transactionHash",
            "logs.transactionIndex as log_transactionIndex",

            "blocks.baseFeePerGas as block_baseFeePerGas",
            "blocks.difficulty as block_difficulty",
            "blocks.extraData as block_extraData",
            "blocks.gasLimit as block_gasLimit",
            "blocks.gasUsed as block_gasUsed",
            "blocks.hash as block_hash",
            "blocks.logsBloom as block_logsBloom",
            "blocks.miner as block_miner",
            "blocks.mixHash as block_mixHash",
            "blocks.nonce as block_nonce",
            "blocks.number as block_number",
            "blocks.parentHash as block_parentHash",
            "blocks.receiptsRoot as block_receiptsRoot",
            "blocks.sha3Uncles as block_sha3Uncles",
            "blocks.size as block_size",
            "blocks.stateRoot as block_stateRoot",
            "blocks.timestamp as block_timestamp",
            "blocks.totalDifficulty as block_totalDifficulty",
            "blocks.transactionsRoot as block_transactionsRoot",

            "transactions.accessList as tx_accessList",
            "transactions.blockHash as tx_blockHash",
            "transactions.blockNumber as tx_blockNumber",
            "transactions.from as tx_from",
            "transactions.gas as tx_gas",
            "transactions.gasPrice as tx_gasPrice",
            "transactions.hash as tx_hash",
            "transactions.input as tx_input",
            "transactions.maxFeePerGas as tx_maxFeePerGas",
            "transactions.maxPriorityFeePerGas as tx_maxPriorityFeePerGas",
            "transactions.nonce as tx_nonce",
            "transactions.r as tx_r",
            "transactions.s as tx_s",
            "transactions.to as tx_to",
            "transactions.transactionIndex as tx_transactionIndex",
            "transactions.type as tx_type",
            "transactions.value as tx_value",
            "transactions.v as tx_v",
          ])
          .where((eb) => this.buildCheckpointCmprs(eb, ">", fromCheckpoint))
          .where((eb) => this.buildCheckpointCmprs(eb, "<=", toCheckpoint))
          .orderBy("blocks.timestamp", "asc")
          .orderBy("logs.chainId", "asc")
          .orderBy("blocks.number", "asc")
          .orderBy("logs.logIndex", "asc")
          .limit(limit + 1)
          .execute(),

        this.db
          .selectFrom("logs")
          .leftJoin("blocks", "blocks.hash", "logs.blockHash")
          .where((eb) => {
            const logFilterCmprs =
              logFilters?.map((logFilter) => {
                const exprs = this.buildLogFilterCmprs({ eb, logFilter });

                exprs.push(eb("logs.topic0", "=", logFilter.eventSelector));

                return eb.and(exprs);
              }) ?? [];

            const factoryCmprs =
              factories?.map((factory) => {
                const exprs = this.buildFactoryCmprs({ eb, factory });
                exprs.push(eb("logs.topic0", "=", factory.eventSelector));

                return eb.and(exprs);
              }) ?? [];

            return eb.or([...logFilterCmprs, ...factoryCmprs]);
          })
          .select([
            "blocks.timestamp as block_timestamp",
            "logs.chainId as log_chainId",
            "blocks.number as block_number",
            "logs.logIndex as log_logIndex",
          ])
          .where((eb) => this.buildCheckpointCmprs(eb, ">", fromCheckpoint))
          .where((eb) => this.buildCheckpointCmprs(eb, "<=", toCheckpoint))
          .orderBy("blocks.timestamp", "desc")
          .orderBy("logs.chainId", "desc")
          .orderBy("blocks.number", "desc")
          .orderBy("logs.logIndex", "desc")
          .limit(1)
          .execute(),
      ]);

      const events = requestedLogs.map((_row) => {
        // Without this cast, the block_ and tx_ fields are all nullable
        // which makes this very annoying. Should probably add a runtime check
        // that those fields are indeed present before continuing here.
        const row = _row as NonNull<(typeof requestedLogs)[number]>;

        return {
          chainId: row.log_chainId,
          log: {
            address: checksumAddress(row.log_address),
            blockHash: row.log_blockHash,
            blockNumber: row.log_blockNumber,
            data: row.log_data,
            id: row.log_id as Log["id"],
            logIndex: Number(row.log_logIndex),
            removed: false,
            topics: [
              row.log_topic0,
              row.log_topic1,
              row.log_topic2,
              row.log_topic3,
            ].filter((t): t is Hex => t !== null) as [Hex, ...Hex[]] | [],
            transactionHash: row.log_transactionHash,
            transactionIndex: Number(row.log_transactionIndex),
          },
          block: {
            baseFeePerGas: row.block_baseFeePerGas,
            difficulty: row.block_difficulty,
            extraData: row.block_extraData,
            gasLimit: row.block_gasLimit,
            gasUsed: row.block_gasUsed,
            hash: row.block_hash,
            logsBloom: row.block_logsBloom,
            miner: checksumAddress(row.block_miner),
            mixHash: row.block_mixHash,
            nonce: row.block_nonce,
            number: row.block_number,
            parentHash: row.block_parentHash,
            receiptsRoot: row.block_receiptsRoot,
            sha3Uncles: row.block_sha3Uncles,
            size: row.block_size,
            stateRoot: row.block_stateRoot,
            timestamp: row.block_timestamp,
            totalDifficulty: row.block_totalDifficulty,
            transactionsRoot: row.block_transactionsRoot,
          },
          transaction: {
            blockHash: row.tx_blockHash,
            blockNumber: row.tx_blockNumber,
            from: checksumAddress(row.tx_from),
            gas: row.tx_gas,
            hash: row.tx_hash,
            input: row.tx_input,
            nonce: Number(row.tx_nonce),
            r: row.tx_r,
            s: row.tx_s,
            to: row.tx_to ? checksumAddress(row.tx_to) : row.tx_to,
            transactionIndex: Number(row.tx_transactionIndex),
            value: row.tx_value,
            v: row.tx_v,
            ...(row.tx_type === "0x0"
              ? { type: "legacy", gasPrice: row.tx_gasPrice }
              : row.tx_type === "0x1"
                ? {
                    type: "eip2930",
                    gasPrice: row.tx_gasPrice,
                    accessList: JSON.parse(row.tx_accessList),
                  }
                : row.tx_type === "0x2"
                  ? {
                      type: "eip1559",
                      maxFeePerGas: row.tx_maxFeePerGas,
                      maxPriorityFeePerGas: row.tx_maxPriorityFeePerGas,
                    }
                  : row.tx_type === "0x7e"
                    ? {
                        type: "deposit",
                        maxFeePerGas: row.tx_maxFeePerGas ?? undefined,
                        maxPriorityFeePerGas:
                          row.tx_maxPriorityFeePerGas ?? undefined,
                      }
                    : { type: row.tx_type }),
          },
        } satisfies {
          chainId: number;
          log: Log;
          block: Block;
          transaction: Transaction;
        };
      });

      const lastCheckpointRow = lastCheckpointRows[0];
      const lastCheckpoint =
        lastCheckpointRow !== undefined
          ? ({
              blockTimestamp: Number(lastCheckpointRow.block_timestamp!),
              blockNumber: Number(lastCheckpointRow.block_number!),
              chainId: lastCheckpointRow.log_chainId,
              logIndex: lastCheckpointRow.log_logIndex,
            } satisfies Checkpoint)
          : undefined;

      if (events.length === limit + 1) {
        events.pop();

        const lastEventInPage = events[events.length - 1];
        const lastCheckpointInPage = {
          blockTimestamp: Number(lastEventInPage.block.timestamp),
          chainId: lastEventInPage.chainId,
          blockNumber: Number(lastEventInPage.block.number),
          logIndex: lastEventInPage.log.logIndex,
        } satisfies Checkpoint;

        return {
          events,
          hasNextPage: true,
          lastCheckpointInPage,
          lastCheckpoint,
        } as const;
      } else {
        return {
          events,
          hasNextPage: false,
          lastCheckpointInPage: undefined,
          lastCheckpoint,
        } as const;
      }
    });
  }

  /**
   * Builds an expression that filters for events that are greater or
   * less than the provided checkpoint. If the log index is not specific,
   * the expression will use a block-level granularity.
   */
  private buildCheckpointCmprs = (
    eb: ExpressionBuilder<any, any>,
    op: ">" | ">=" | "<" | "<=",
    checkpoint: Checkpoint,
  ) => {
    const { and, or } = eb;

    const { blockTimestamp, chainId, blockNumber, logIndex } = checkpoint;

    const operand = op.startsWith(">") ? (">" as const) : ("<" as const);
    const operandOrEquals = `${operand}=` as const;
    const isInclusive = op.endsWith("=");

    // If the execution index is not defined, the checkpoint is at block granularity.
    // Include (or exclude) all events in the block.
    if (logIndex === undefined) {
      return and([
        eb("blocks.timestamp", operandOrEquals, BigInt(blockTimestamp)),
        or([
          eb("blocks.timestamp", operand, BigInt(blockTimestamp)),
          and([
            eb("logs.chainId", operandOrEquals, chainId),
            or([
              eb("logs.chainId", operand, chainId),
              eb(
                "blocks.number",
                isInclusive ? operandOrEquals : operand,
                BigInt(blockNumber),
              ),
            ]),
          ]),
        ]),
      ]);
    }

    // Otherwise, apply the filter down to the log index.
    return and([
      eb("blocks.timestamp", operandOrEquals, BigInt(blockTimestamp)),
      or([
        eb("blocks.timestamp", operand, BigInt(blockTimestamp)),
        and([
          eb("logs.chainId", operandOrEquals, chainId),
          or([
            eb("logs.chainId", operand, chainId),
            and([
              eb("blocks.number", operandOrEquals, BigInt(blockNumber)),
              or([
                eb("blocks.number", operand, BigInt(blockNumber)),
                eb(
                  "logs.logIndex",
                  isInclusive ? operandOrEquals : operand,
                  logIndex,
                ),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]);
  };

  private buildLogFilterCmprs = ({
    eb,
    logFilter,
  }: {
    eb: ExpressionBuilder<any, any>;
    logFilter: {
      id: string;
      chainId: number;
      criteria: LogFilterCriteria;
      fromBlock?: number;
      toBlock?: number;
    };
  }) => {
    const exprs = [];

    exprs.push(
      eb(
        "logs.chainId",
        "=",
        sql`cast (${sql.val(logFilter.chainId)} as numeric(16, 0))`,
      ),
    );

    if (logFilter.criteria.address) {
      // If it's an array of length 1, collapse it.
      const address =
        Array.isArray(logFilter.criteria.address) &&
        logFilter.criteria.address.length === 1
          ? logFilter.criteria.address[0]
          : logFilter.criteria.address;
      if (Array.isArray(address)) {
        exprs.push(eb.or(address.map((a) => eb("logs.address", "=", a))));
      } else {
        exprs.push(eb("logs.address", "=", address));
      }
    }

    if (logFilter.criteria.topics) {
      for (const idx_ of range(0, 4)) {
        const idx = idx_ as 0 | 1 | 2 | 3;
        // If it's an array of length 1, collapse it.
        const raw = logFilter.criteria.topics[idx] ?? null;
        if (raw === null) continue;
        const topic = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
        if (Array.isArray(topic)) {
          exprs.push(eb.or(topic.map((a) => eb(`logs.topic${idx}`, "=", a))));
        } else {
          exprs.push(eb(`logs.topic${idx}`, "=", topic));
        }
      }
    }

    if (logFilter.fromBlock)
      exprs.push(eb("blocks.number", ">=", BigInt(logFilter.fromBlock)));
    if (logFilter.toBlock)
      exprs.push(eb("blocks.number", "<=", BigInt(logFilter.toBlock)));

    return exprs;
  };

  private buildFactoryCmprs = ({
    eb,
    factory,
  }: {
    eb: ExpressionBuilder<any, any>;
    factory: {
      id: string;
      chainId: number;
      criteria: FactoryCriteria;
      fromBlock?: number;
      toBlock?: number;
    };
  }) => {
    const exprs = [];

    exprs.push(
      eb(
        "logs.chainId",
        "=",
        sql`cast (${sql.val(factory.chainId)} as numeric(16, 0))`,
      ),
    );

    const selectChildAddressExpression =
      buildFactoryChildAddressSelectExpression({
        childAddressLocation: factory.criteria.childAddressLocation,
      });

    exprs.push(
      eb(
        "logs.address",
        "in",
        eb
          .selectFrom("logs")
          .select(selectChildAddressExpression.as("childAddress"))
          .where("chainId", "=", factory.chainId)
          .where("address", "=", factory.criteria.address)
          .where("topic0", "=", factory.criteria.eventSelector),
      ),
    );

    if (factory.fromBlock)
      exprs.push(eb("blocks.number", ">=", BigInt(factory.fromBlock)));
    if (factory.toBlock)
      exprs.push(eb("blocks.number", "<=", BigInt(factory.toBlock)));

    return exprs;
  };

  private wrap = async <T>(
    options: { method: string },
    fn: () => Promise<T>,
  ) => {
    const endClock = startClock();
    const RETRY_COUNT = 3;
    const BASE_DURATION = 100;

    let error: any;
    let hasError = false;

    for (let i = 0; i < RETRY_COUNT + 1; i++) {
      try {
        const result = await fn();
        this.common.metrics.ponder_database_method_duration.observe(
          { service: "sync", method: options.method },
          endClock(),
        );
        return result;
      } catch (_error) {
        if (_error instanceof NonRetryableError) {
          throw _error;
        }

        if (!hasError) {
          hasError = true;
          error = _error;
        }

        if (i < RETRY_COUNT) {
          const duration = BASE_DURATION * 2 ** i;
          this.common.logger.warn({
            service: "database",
            msg: `Database error while running ${options.method}, retrying after ${duration} milliseconds. Error: ${error.message}`,
          });
          await new Promise((_resolve) => {
            setTimeout(_resolve, duration);
          });
        }
      }
    }

    this.common.metrics.ponder_database_method_error_total.inc({
      service: "sync",
      method: options.method,
    });

    throw error;
  };
}

function buildFactoryChildAddressSelectExpression({
  childAddressLocation,
}: {
  childAddressLocation: FactoryCriteria["childAddressLocation"];
}) {
  if (childAddressLocation.startsWith("offset")) {
    const childAddressOffset = Number(childAddressLocation.substring(6));
    const start = 2 + 12 * 2 + childAddressOffset * 2 + 1;
    const length = 20 * 2;
    return sql<Hex>`'0x' || substring(data from ${start}::int for ${length}::int)`;
  } else {
    const start = 2 + 12 * 2 + 1;
    const length = 20 * 2;
    return sql<Hex>`'0x' || substring(${sql.ref(
      childAddressLocation,
    )} from ${start}::integer for ${length}::integer)`;
  }
}
