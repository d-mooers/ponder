import prometheus from "prom-client";

const httpRequestBucketsInMs = [
  0.1, 0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_000, 2_000,
  4_000, 8_000, 16_000, 32_000,
];

const httpRequestSizeInBytes = [
  10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 50_000, 100_000, 250_000,
  500_000, 1_000_000, 5_000_000, 10_000_000,
];

export class MetricsService {
  registry: prometheus.Registry;

  ponder_rpc_request_duration: prometheus.Histogram<"network" | "method">;
  ponder_rpc_request_lag: prometheus.Histogram<"network" | "method">;

  ponder_historical_start_timestamp: prometheus.Gauge<"network">;
  ponder_historical_total_blocks: prometheus.Gauge<"network" | "contract">;
  ponder_historical_cached_blocks: prometheus.Gauge<"network" | "contract">;
  ponder_historical_completed_blocks: prometheus.Gauge<"network" | "contract">;

  ponder_realtime_is_connected: prometheus.Gauge<"network">;
  ponder_realtime_latest_block_number: prometheus.Gauge<"network">;
  ponder_realtime_latest_block_timestamp: prometheus.Gauge<"network">;
  ponder_realtime_reorg_total: prometheus.Counter<"network">;

  ponder_indexing_total_seconds: prometheus.Gauge<"event">;
  ponder_indexing_completed_seconds: prometheus.Gauge<"event">;
  ponder_indexing_completed_events: prometheus.Gauge<"network" | "event">;

  ponder_indexing_completed_timestamp: prometheus.Gauge;
  ponder_indexing_has_error: prometheus.Gauge;

  ponder_indexing_function_duration: prometheus.Histogram<"network" | "event">;
  ponder_indexing_function_error_total: prometheus.Counter<"network" | "event">;

  ponder_server_port: prometheus.Gauge;
  ponder_server_request_size: prometheus.Histogram<
    "method" | "path" | "status"
  >;
  ponder_server_response_size: prometheus.Histogram<
    "method" | "path" | "status"
  >;
  ponder_server_response_duration: prometheus.Histogram<
    "method" | "path" | "status"
  >;

  ponder_database_method_duration: prometheus.Histogram<"service" | "method">;
  ponder_database_method_error_total: prometheus.Counter<"service" | "method">;

  ponder_postgres_pool_connections: prometheus.Gauge<"pool" | "kind"> = null!;
  ponder_postgres_query_queue_size: prometheus.Gauge<"pool"> = null!;
  ponder_postgres_query_total: prometheus.Counter<"pool"> = null!;

  ponder_sqlite_query_total: prometheus.Counter<"database"> = null!;

  constructor() {
    this.registry = new prometheus.Registry();

    prometheus.collectDefaultMetrics({ register: this.registry });

    this.ponder_rpc_request_duration = new prometheus.Histogram({
      name: "ponder_rpc_request_duration",
      help: "Duration of RPC requests",
      labelNames: ["network", "method"] as const,
      buckets: httpRequestBucketsInMs,
      registers: [this.registry],
    });
    this.ponder_rpc_request_lag = new prometheus.Histogram({
      name: "ponder_rpc_request_lag",
      help: "Time RPC requests spend waiting in the request queue",
      labelNames: ["network", "method"] as const,
      buckets: httpRequestBucketsInMs,
      registers: [this.registry],
    });

    this.ponder_historical_start_timestamp = new prometheus.Gauge({
      name: "ponder_historical_start_timestamp",
      help: "Unix timestamp (ms) when the historical sync service started",
      labelNames: ["network"] as const,
      registers: [this.registry],
    });
    this.ponder_historical_total_blocks = new prometheus.Gauge({
      name: "ponder_historical_total_blocks",
      help: "Number of blocks required for the historical sync",
      labelNames: ["network", "contract"] as const,
      registers: [this.registry],
    });
    this.ponder_historical_cached_blocks = new prometheus.Gauge({
      name: "ponder_historical_cached_blocks",
      help: "Number of blocks that were found in the cache for the historical sync",
      labelNames: ["network", "contract"] as const,
      registers: [this.registry],
    });
    this.ponder_historical_completed_blocks = new prometheus.Gauge({
      name: "ponder_historical_completed_blocks",
      help: "Number of blocks that have been processed for the historical sync",
      labelNames: ["network", "contract"] as const,
      registers: [this.registry],
    });

    this.ponder_realtime_is_connected = new prometheus.Gauge({
      name: "ponder_realtime_is_connected",
      help: "Boolean (0 or 1) indicating if the historical sync service is connected",
      labelNames: ["network"] as const,
      registers: [this.registry],
    });
    this.ponder_realtime_latest_block_number = new prometheus.Gauge({
      name: "ponder_realtime_latest_block_number",
      help: "Block number of the latest synced block",
      labelNames: ["network"] as const,
      registers: [this.registry],
    });
    this.ponder_realtime_latest_block_timestamp = new prometheus.Gauge({
      name: "ponder_realtime_latest_block_timestamp",
      help: "Block timestamp of the latest synced block",
      labelNames: ["network"] as const,
      registers: [this.registry],
    });
    this.ponder_realtime_reorg_total = new prometheus.Counter({
      name: "ponder_realtime_reorg_total",
      help: "Count of how many re-orgs have occurred.",
      labelNames: ["network"] as const,
      registers: [this.registry],
    });

    this.ponder_indexing_total_seconds = new prometheus.Gauge({
      name: "ponder_indexing_total_seconds",
      help: "Total number of seconds that are required",
      labelNames: ["event"] as const,
      registers: [this.registry],
    });
    this.ponder_indexing_completed_seconds = new prometheus.Gauge({
      name: "ponder_indexing_completed_seconds",
      help: "Number of seconds that have been completed",
      labelNames: ["event"] as const,
      registers: [this.registry],
    });
    this.ponder_indexing_completed_events = new prometheus.Gauge({
      name: "ponder_indexing_completed_events",
      help: "Number of events that have been processed",
      labelNames: ["network", "event"] as const,
      registers: [this.registry],
    });
    this.ponder_indexing_completed_timestamp = new prometheus.Gauge({
      name: "ponder_indexing_completed_timestamp",
      help: "Timestamp through which all events have been completed",
      registers: [this.registry],
    });
    this.ponder_indexing_has_error = new prometheus.Gauge({
      name: "ponder_indexing_has_error",
      help: "Boolean (0 or 1) indicating if an error was encountered while running user code",
      registers: [this.registry],
    });
    this.ponder_indexing_function_duration = new prometheus.Histogram({
      name: "ponder_indexing_function_duration",
      help: "Duration of indexing function execution",
      labelNames: ["network", "event"] as const,
      buckets: httpRequestBucketsInMs,
      registers: [this.registry],
    });
    this.ponder_indexing_function_error_total = new prometheus.Counter({
      name: "ponder_indexing_function_error_total",
      help: "Total number of errors encountered during indexing function execution",
      labelNames: ["network", "event"] as const,
      registers: [this.registry],
    });

    this.ponder_server_port = new prometheus.Gauge({
      name: "ponder_server_port",
      help: "Port that the server is listening on",
      registers: [this.registry],
    });
    this.ponder_server_request_size = new prometheus.Histogram({
      name: "ponder_server_request_size",
      help: "Size of HTTP requests received by the server",
      labelNames: ["method", "path", "status"] as const,
      buckets: httpRequestSizeInBytes,
      registers: [this.registry],
    });
    this.ponder_server_response_size = new prometheus.Histogram({
      name: "ponder_server_response_size",
      help: "Size of HTTP responses served the server",
      labelNames: ["method", "path", "status"] as const,
      buckets: httpRequestSizeInBytes,
      registers: [this.registry],
    });
    this.ponder_server_response_duration = new prometheus.Histogram({
      name: "ponder_server_response_duration",
      help: "Duration of HTTP responses served the server",
      labelNames: ["method", "path", "status"] as const,
      buckets: httpRequestSizeInBytes,
      registers: [this.registry],
    });

    this.ponder_database_method_duration = new prometheus.Histogram({
      name: "ponder_database_method_duration",
      help: "Duration of database operations",
      labelNames: ["service", "method"] as const,
      buckets: httpRequestBucketsInMs,
      registers: [this.registry],
    });
    this.ponder_database_method_error_total = new prometheus.Counter({
      name: "ponder_database_method_error_total",
      help: "Total number of errors encountered during database operations",
      labelNames: ["service", "method"] as const,
      registers: [this.registry],
    });
  }

  /**
   * Get string representation for all metrics.
   * @returns Metrics encoded using Prometheus v0.0.4 format.
   */
  async getMetrics() {
    return await this.registry.metrics();
  }

  resetMetrics() {
    this.registry.resetMetrics();
  }
}
