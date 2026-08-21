const DATABASE_NAME = "ecolab-local";
const DATABASE_VERSION = 2;
const PROJECT_STORE = "projects";
const DATASET_STORE = "datasets";
const ANALYSIS_STORE = "analyses";
const STORE_NAMES = [PROJECT_STORE, DATASET_STORE, ANALYSIS_STORE];
const ANALYSIS_INTERRUPTION_REASON = "Interrupted after application reload.";

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
  return new Error(code);
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
  constructor() {
    this.persistent = false;
    this.projects = new Map();
    this.datasets = new Map();
    this.analyses = new Map();
  }

  async saveProject(project) {
    return saveMemoryRecord(this.projects, project);
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
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

export class IndexedDbProjectRepository {
  constructor(indexedDb) {
    this.indexedDb = indexedDb;
    this.persistent = true;
    this.databasePromise = null;
  }

  async database() {
    if (!this.databasePromise) {
      const opening = new Promise((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener("upgradeneeded", (event) => {
          const oldVersion = Number.isInteger(event.oldVersion) ? event.oldVersion : 0;
          migrateDatabase(request.result, oldVersion);
        });
        request.addEventListener(
          "success",
          () => {
            const database = request.result;
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
          () => {
            if (this.databasePromise === opening) this.databasePromise = null;
            reject(request.error);
          },
          { once: true },
        );
      });
      this.databasePromise = opening;
    }
    return this.databasePromise;
  }

  async saveRecord(storeName, record, conflictCode) {
    try {
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
    } catch (error) {
      throw normalizeRepositoryError(error);
    }
  }

  async loadRecord(storeName, id, normalize = clone) {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readonly");
    const value = await requestPromise(transaction.objectStore(storeName).get(id));
    await transactionDone(transaction);
    return value ? normalize(value) : null;
  }

  async listRecords(storeName, normalize = clone) {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readonly");
    const values = await requestPromise(transaction.objectStore(storeName).getAll());
    await transactionDone(transaction);
    return sortNewestFirst(values.map(normalize));
  }

  async deleteRecord(storeName, id) {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    await transactionDone(transaction);
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
  }
}

export async function createProjectRepository(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) return new MemoryProjectRepository();
  try {
    const repository = new IndexedDbProjectRepository(indexedDb);
    await repository.probe();
    return repository;
  } catch {
    return new MemoryProjectRepository();
  }
}
