import { postgres } from './postgres.js'
import { mysql } from './mysql.js'
import { redis } from './redis.js'
import { mongodb } from './mongodb.js'

/** Engines the panel can tune from the inside. */
export const DRIVERS = [postgres, mysql, redis, mongodb]

/**
 * Engines it recognises but does not tune. They still get everything that comes
 * from the outside — status, live usage, and editable memory/CPU limits — which
 * is the part that applies to every engine equally.
 */
export const KNOWN_ENGINES = [
  { id: 'clickhouse', label: 'ClickHouse', imagePattern: /(^|\/)clickhouse/i, defaultPort: 9000 },
  { id: 'elasticsearch', label: 'Elasticsearch / OpenSearch', imagePattern: /(^|\/)(elasticsearch|opensearch)/i, defaultPort: 9200 },
  { id: 'cassandra', label: 'Cassandra / ScyllaDB', imagePattern: /(^|\/)(cassandra|scylla)/i, defaultPort: 9042 },
  { id: 'influxdb', label: 'InfluxDB', imagePattern: /(^|\/)influxdb/i, defaultPort: 8086 },
  { id: 'neo4j', label: 'Neo4j', imagePattern: /(^|\/)neo4j/i, defaultPort: 7687 },
  { id: 'couchdb', label: 'CouchDB', imagePattern: /(^|\/)couchdb/i, defaultPort: 5984 },
  { id: 'memcached', label: 'Memcached', imagePattern: /(^|\/)memcached/i, defaultPort: 11211 },
  { id: 'cockroachdb', label: 'CockroachDB', imagePattern: /(^|\/)cockroach/i, defaultPort: 26257 },
  { id: 'surrealdb', label: 'SurrealDB', imagePattern: /(^|\/)surrealdb/i, defaultPort: 8000 },
  { id: 'qdrant', label: 'Qdrant', imagePattern: /(^|\/)qdrant/i, defaultPort: 6333 },
  { id: 'milvus', label: 'Milvus', imagePattern: /(^|\/)milvus/i, defaultPort: 19530 },
  { id: 'weaviate', label: 'Weaviate', imagePattern: /(^|\/)weaviate/i, defaultPort: 8080 },
  { id: 'chroma', label: 'Chroma', imagePattern: /(^|\/)chroma/i, defaultPort: 8000 },
  { id: 'meilisearch', label: 'Meilisearch', imagePattern: /(^|\/)meilisearch/i, defaultPort: 7700 },
  { id: 'typesense', label: 'Typesense', imagePattern: /(^|\/)typesense/i, defaultPort: 8108 },
  { id: 'etcd', label: 'etcd', imagePattern: /(^|\/)etcd/i, defaultPort: 2379 },
  { id: 'rabbitmq', label: 'RabbitMQ', imagePattern: /(^|\/)rabbitmq/i, defaultPort: 5672 },
  { id: 'nats', label: 'NATS', imagePattern: /(^|\/)nats/i, defaultPort: 4222 },
  { id: 'kafka', label: 'Kafka', imagePattern: /(^|\/)(kafka|redpanda)/i, defaultPort: 9092 },
  { id: 'minio', label: 'MinIO', imagePattern: /(^|\/)minio/i, defaultPort: 9000 },
  { id: 'oracle', label: 'Oracle Database', imagePattern: /(^|\/)(oracle|database\/(free|express))/i, defaultPort: 1521 },
  { id: 'mssql', label: 'SQL Server', imagePattern: /(^|\/)(mssql|sqlserver)/i, defaultPort: 1433 },
  { id: 'sqlite', label: 'SQLite', imagePattern: /(^|\/)sqlite/i, defaultPort: null },
]

export function driverForImage(image) {
  return DRIVERS.find((d) => d.imagePattern.test(image)) || null
}

export function engineForImage(image) {
  const driver = driverForImage(image)
  if (driver) return { id: driver.id, label: driver.label, defaultPort: driver.defaultPort, tunable: true }
  const known = KNOWN_ENGINES.find((e) => e.imagePattern.test(image))
  if (known) return { ...known, tunable: false }
  return null
}

export function driverForUnit(unit) {
  return DRIVERS.find((d) => d.unitPattern?.test(unit)) || null
}
