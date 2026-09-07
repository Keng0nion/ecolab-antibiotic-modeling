const DATABASE_NAME = "ecolab-local";
const DATABASE_VERSION = 2;
const PROJECT_STORE = "projects";
const DATASET_STORE = "datasets";
const ANALYSIS_STORE = "analyses";
const STORE_NAMES = [PROJECT_STORE, DATASET_STORE, ANALYSIS_STORE];
const ANALYSIS_INTERRUPTION_REASON = "Interrupted after application reload.";
export const DEFAULT_PERSISTENCE_PROBE_TIMEOUT_MS = 3_000;

let probeFallbackSequence = 0;

function clone(value) {
  return structuredClone(value);
}

export class ProjectRepositoryError extends Error {
  constructor(code, message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectRepositoryError";
    this.code = code;
  }
}

function revisionConflict(code) {
  return new ProjectRepositoryError(code, code);
}

function repositoryErrorDetails(error, fallbackCode = "PERSISTENCE_ERROR") {
  return {
    name: error?.name ?? "Error",
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error?.message ?? String(error),
  };
}

function normalizeRepositoryError(error) {
  if (error instanceof ProjectRepositoryError) return error;
  if (error?.name === "QuotaExceededError") {
    return new ProjectRepositoryError(
      "PERSISTENCE_QUOTA_EXCEEDED",
      "Browser storage quota was exceeded while saving repository data.",
      error,
    );
  }
  return error;
}

function createStoreIfMissing(database, storeName) {
  if (!database.objectStoreNames.contains(storeName)) {
    database.createObjectStore(storeName, { keyPath: "id" });
  }
}

function migrateV0ToV1CreateProjectsStore(database) {
  createStoreIfMissing(database, PROJECT_STORE);
}

function migrateV1ToV2CreateResearchStores(database) {
  createStoreIfMissing(database, DATASET_STORE);
  createStoreIfMissing(database, ANALYSIS_STORE);
}

function migrateDatabase(database, oldVersion) {
  if (oldVersion < 1) migrateV0ToV1CreateProjectsStore(database);
  if (oldVersion < 2) migrateV1ToV2CreateResearchStores(database);
}

export function createPersistenceProbeId(cryptoObject = globalThis.crypto) {
  if (typeof cryptoObject?.randomUUID === "function") {
    return `__ecolab_probe__:${cryptoObject.randomUUID()}`;
  }
  probeFallbackSequence += 1;
  return `__ecolab_probe__:fallback:${probeFallbackSequence}`;
}

function sortNewestFirst(values) {
  return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function normalizeAnalysis(analysis) {
  const normalized = clone(analysis);
  if (normalized.status === "running") {
    normalized.status = "interrupted";
    normalized.interruptionReason = ANALYSIS_INTERRUPTION_REASON;
  }
  return normalized;
}

function saveMemoryRecord(records, record, conflictCode = null) {
  const current = records.get(record.id);
  if (conflictCode && current && current.revision !== record.revision) {
    throw revisionConflict(conflictCode);
  }
  const saved = { ...clone(record), revision: (record.revision ?? 0) + 1 };
  records.set(saved.id, saved);
  return clone(saved);
}

function loadMemoryRecord(records, id, normalize = clone) {
  const record = records.get(id);
  return record ? normalize(record) : null;
}

function listMemoryRecords(records, normalize = clone) {
  return sortNewestFirst([...records.values()].map(normalize));
}

export class MemoryProjectRepository {
  #storageStatus;

  constructor({ fallbackReason = "PERSISTENCE_UNAVAILABLE", lastError = null } = {}) {
    this.persistent = false;
    this.#storageStatus = {
      backend: "memory",
      persistent: false,
      state: "memory-only",
      fallbackReason,
      lastError: clone(lastError),
    };
    this.projects = new Map();
    this.datasets = new Map();
    this.analyses = new Map();
  }

  getStorageStatus() {
    return clone(this.#storageStatus);
  }

  async saveProject(project) {
    return saveMemoryRecord(this.projects, project, "PROJECT_REVISION_CONFLICT");
  }

  async loadProject(id) {
    return loadMemoryRecord(this.projects, id);
  }

  async listProjects() {
    return listMemoryRecords(this.projects);
  }

  async deleteProject(id) {
    this.projects.delete(id);
  }

  async saveDataset(dataset) {
    return saveMemoryRecord(this.datasets, dataset, "DATASET_REVISION_CONFLICT");
  }

  async loadDataset(id) {
    return loadMemoryRecord(this.datasets, id);
  }

  async listDatasets() {
    return listMemoryRecords(this.datasets);
  }

  async deleteDataset(id) {
    this.datasets.delete(id);
  }

  async saveAnalysis(analysis) {
    return saveMemoryRecord(this.analyses, analysis, "ANALYSIS_REVISION_CONFLICT");
  }

  async loadAnalysis(id) {
    return loadMemoryRecord(this.analyses, id, normalizeAnalysis);
  }

  async listAnalyses() {
    return listMemoryRecords(this.analyses, normalizeAnalysis);
  }

  async deleteAnalysis(id) {
    this.analyses.delete(id);
  }
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", (event) => {
      const error = event.target?.error ?? transaction.error;
      // A request error can bubble before transaction.error is set by the abort.
      if (error) reject(error);
    }, { once: true });
  });
}

export class IndexedDbProjectRepository {
  #storageStatus = {
    backend: "indexeddb",
    persistent: true,
    state: "ready",
    fallbackReason: null,
    lastError: null,
  };

  constructor(indexedDb) {
    this.indexedDb = indexedDb;
    this.persistent = true;
    this.databasePromise = null;
  }

  getStorageStatus() {
    return clone(this.#storageStatus);
  }

  async withStorageStatus(operation) {
    try {
      const result = await operation();
      this.#storageStatus.state = "ready";
      this.#storageStatus.lastError = null;
      return result;
    } catch (error) {
      const normalized = normalizeRepositoryError(error);
      this.#storageStatus.state = "error";
      this.#storageStatus.lastError = repositoryErrorDetails(normalized);
      throw normalized;
    }
  }

  async database() {
    if (!this.databasePromise) {
      let settled = false;
      const opening = new Promise((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        const rejectOpening = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        request.addEventListener("upgradeneeded", (event) => {
          const oldVersion = Number.isInteger(event.oldVersion) ? event.oldVersion : 0;
          migrateDatabase(request.result, oldVersion);
        });
        request.addEventListener(
          "success",
          () => {
            const database = request.result;
            if (settled) {
              database.close();
              return;
            }
            settled = true;
            database.addEventListener(
              "versionchange",
              () => {
                database.close();
                if (this.databasePromise === opening) this.databasePromise = null;
              },
              { once: true },
            );
            resolve(database);
          },
          { once: true },
        );
        request.addEventListener(
          "error",
          () => rejectOpening(request.error),
          { once: true },
        );
        request.addEventListener(
          "blocked",
          () => rejectOpening(new ProjectRepositoryError(
            "PERSISTENCE_BLOCKED",
            "Browser storage is blocked by another open Ecolab tab.",
          )),
          { once: true },
        );
      });
      this.databasePromise = opening;
      void opening.catch(() => {
        if (this.databasePromise === opening) this.databasePromise = null;
      });
    }
    return this.databasePromise;
  }

  async saveRecord(storeName, record, conflictCode) {
    return this.withStorageStatus(async () => {
      const database = await this.database();
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const current = await requestPromise(store.get(record.id));
      if (current && current.revision !== record.revision) {
        transaction.abort();
        throw revisionConflict(conflictCode);
      }
      const saved = { ...clone(record), revision: (record.revision ?? 0) + 1 };
      store.put(saved);
      await transactionDone(transaction);
      return clone(saved);
    });
  }

  async loadRecord(storeName, id, normalize = clone) {
    return this.withStorageStatus(async () => {
      const database = await this.database();
      const transaction = database.transaction(storeName, "readonly");
      const value = await requestPromise(transaction.objectStore(storeName).get(id));
      await transactionDone(transaction);
      return value ? normalize(value) : null;
    });
  }

  async listRecords(storeName, normalize = clone) {
    return this.withStorageStatus(async () => {
      const database = await this.database();
      const transaction = database.transaction(storeName, "readonly");
      const values = await requestPromise(transaction.objectStore(storeName).getAll());
      await transactionDone(transaction);
      return sortNewestFirst(values.map(normalize));
    });
  }

  async deleteRecord(storeName, id) {
    return this.withStorageStatus(async () => {
      const database = await this.database();
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(id);
      await transactionDone(transaction);
    });
  }

  async saveProject(project) {
    return this.saveRecord(PROJECT_STORE, project, "PROJECT_REVISION_CONFLICT");
  }

  async loadProject(id) {
    return this.loadRecord(PROJECT_STORE, id);
  }

  async listProjects() {
    return this.listRecords(PROJECT_STORE);
  }

  async deleteProject(id) {
    return this.deleteRecord(PROJECT_STORE, id);
  }

  async saveDataset(dataset) {
    return this.saveRecord(DATASET_STORE, dataset, "DATASET_REVISION_CONFLICT");
  }

  async loadDataset(id) {
    return this.loadRecord(DATASET_STORE, id);
  }

  async listDatasets() {
    return this.listRecords(DATASET_STORE);
  }

  async deleteDataset(id) {
    return this.deleteRecord(DATASET_STORE, id);
  }

  async saveAnalysis(analysis) {
    return this.saveRecord(ANALYSIS_STORE, analysis, "ANALYSIS_REVISION_CONFLICT");
  }

  async loadAnalysis(id) {
    return this.loadRecord(ANALYSIS_STORE, id, normalizeAnalysis);
  }

  async listAnalyses() {
    return this.listRecords(ANALYSIS_STORE, normalizeAnalysis);
  }

  async deleteAnalysis(id) {
    return this.deleteRecord(ANALYSIS_STORE, id);
  }

  async probe() {
    return this.withStorageStatus(async () => {
      const database = await this.database();
      const transaction = database.transaction(STORE_NAMES, "readwrite");
      const probeId = createPersistenceProbeId();
      const probe = { id: probeId, revision: 0, updatedAt: new Date(0).toISOString() };
      for (const storeName of STORE_NAMES) {
        const store = transaction.objectStore(storeName);
        store.add(probe);
        store.delete(probeId);
      }
      await transactionDone(transaction);
    });
  }
}

function withTimeout(promise, timeoutMs, onTimeout = () => {}) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      reject(new ProjectRepositoryError(
        "PERSISTENCE_TIMEOUT",
        `Browser storage did not respond within ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function createProjectRepository(
  indexedDb = globalThis.indexedDB,
  { probeTimeoutMs = DEFAULT_PERSISTENCE_PROBE_TIMEOUT_MS } = {},
) {
  if (!indexedDb) return new MemoryProjectRepository();
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new TypeError("Persistence probe timeout must be a positive integer.");
  }
  try {
    const repository = new IndexedDbProjectRepository(indexedDb);
    await withTimeout(repository.probe(), probeTimeoutMs, () => {
      void repository.database().then((database) => database.close(), () => {});
    });
    return repository;
  } catch (error) {
    const lastError = repositoryErrorDetails(normalizeRepositoryError(error), "PERSISTENCE_UNAVAILABLE");
    return new MemoryProjectRepository({ fallbackReason: lastError.code, lastError });
  }
}
