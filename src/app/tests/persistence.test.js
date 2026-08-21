import test from "node:test";
import assert from "node:assert/strict";
import {
  IndexedDbProjectRepository,
  MemoryProjectRepository,
  ProjectRepositoryError,
  createPersistenceProbeId,
  createProjectRepository,
} from "../persistence.js";

const MEMORY_RECORD_TYPES = [
  {
    name: "projects",
    save: "saveProject",
    load: "loadProject",
    list: "listProjects",
    remove: "deleteProject",
    conflictCode: null,
  },
  {
    name: "datasets",
    save: "saveDataset",
    load: "loadDataset",
    list: "listDatasets",
    remove: "deleteDataset",
    conflictCode: "DATASET_REVISION_CONFLICT",
  },
  {
    name: "analyses",
    save: "saveAnalysis",
    load: "loadAnalysis",
    list: "listAnalyses",
    remove: "deleteAnalysis",
    conflictCode: "ANALYSIS_REVISION_CONFLICT",
  },
];

async function assertMemoryCrud(recordType) {
  const repository = new MemoryProjectRepository();
  const original = {
    id: `${recordType.name}-1`,
    revision: 0,
    updatedAt: "2026-08-20T00:00:00Z",
    nested: { value: 1 },
    status: "complete",
  };

  const firstSaved = await repository[recordType.save](original);
  assert.equal(firstSaved.revision, 1);
  assert.equal(original.revision, 0);

  original.nested.value = 7;
  firstSaved.nested.value = 9;
  const firstLoaded = await repository[recordType.load](original.id);
  assert.equal(firstLoaded.nested.value, 1);

  firstLoaded.nested.value = 11;
  assert.equal((await repository[recordType.load](original.id)).nested.value, 1);

  const updated = await repository[recordType.save]({
    ...firstSaved,
    updatedAt: "2026-08-21T00:00:00Z",
    nested: { value: 2 },
  });
  assert.equal(updated.revision, 2);

  if (recordType.conflictCode) {
    await assert.rejects(
      repository[recordType.save]({ ...firstSaved, nested: { value: 3 } }),
      new RegExp(recordType.conflictCode),
    );
  }

  const newest = await repository[recordType.save]({
    id: `${recordType.name}-2`,
    revision: 0,
    updatedAt: "2026-08-22T00:00:00Z",
    nested: { value: 4 },
    status: "complete",
  });
  const listed = await repository[recordType.list]();
  assert.deepEqual(
    listed.map((record) => record.id),
    [newest.id, updated.id],
  );

  listed[0].nested.value = 99;
  assert.equal((await repository[recordType.load](newest.id)).nested.value, 4);

  await repository[recordType.remove](updated.id);
  assert.equal(await repository[recordType.load](updated.id), null);
}

for (const recordType of MEMORY_RECORD_TYPES) {
  test(`memory repository provides cloned, revision-aware CRUD for ${recordType.name}`, async () => {
    await assertMemoryCrud(recordType);
  });
}

test("memory analyses normalize running work after reload", async () => {
  const repository = new MemoryProjectRepository();
  const input = {
    id: "analysis-running",
    revision: 0,
    updatedAt: "2026-08-21T00:00:00Z",
    status: "running",
    datasetRevision: 4,
    datasetContentHash: "sha256:example",
    result: { partial: true },
  };

  const saved = await repository.saveAnalysis(input);
  assert.equal(saved.status, "running");
  assert.equal(input.status, "running");

  const loaded = await repository.loadAnalysis(input.id);
  assert.equal(loaded.status, "interrupted");
  assert.equal(loaded.interruptionReason, "Interrupted after application reload.");
  assert.equal(loaded.datasetRevision, 4);
  assert.equal(loaded.datasetContentHash, "sha256:example");

  loaded.result.partial = false;
  const reloaded = await repository.loadAnalysis(input.id);
  assert.equal(reloaded.status, "interrupted");
  assert.equal(reloaded.result.partial, true);

  const listed = await repository.listAnalyses();
  assert.equal(listed[0].status, "interrupted");
  assert.equal(listed[0].interruptionReason, "Interrupted after application reload.");
});

function createUpgradeHarness({ oldVersion = 0, existingStoreNames = [] } = {}) {
  const storeNames = new Set(existingStoreNames);
  const createdStores = [];
  const database = new EventTarget();
  database.objectStoreNames = {
    contains(storeName) {
      return storeNames.has(storeName);
    },
  };
  database.createObjectStore = (storeName, options) => {
    storeNames.add(storeName);
    createdStores.push({ storeName, options });
  };
  database.closeCalls = 0;
  database.close = () => {
    database.closeCalls += 1;
  };

  const openCalls = [];
  const indexedDb = {
    open(name, version) {
      openCalls.push({ name, version });
      const request = new EventTarget();
      request.result = database;
      request.error = null;
      queueMicrotask(() => {
        const upgradeEvent = new Event("upgradeneeded");
        Object.defineProperty(upgradeEvent, "oldVersion", { value: oldVersion });
        request.dispatchEvent(upgradeEvent);
        request.dispatchEvent(new Event("success"));
      });
      return request;
    },
  };

  return { indexedDb, database, storeNames, createdStores, openCalls };
}

test("IndexedDB oldVersion 0 creates the complete v2 schema in migration order", async () => {
  const harness = createUpgradeHarness({ oldVersion: 0 });
  const repository = new IndexedDbProjectRepository(harness.indexedDb);

  const database = await repository.database();
  assert.equal(database, harness.database);
  assert.deepEqual(harness.openCalls, [{ name: "ecolab-local", version: 2 }]);
  assert.deepEqual(harness.createdStores, [
    { storeName: "projects", options: { keyPath: "id" } },
    { storeName: "datasets", options: { keyPath: "id" } },
    { storeName: "analyses", options: { keyPath: "id" } },
  ]);
  assert.deepEqual([...harness.storeNames], ["projects", "datasets", "analyses"]);

  database.dispatchEvent(new Event("versionchange"));
  assert.equal(database.closeCalls, 1);
  assert.equal(repository.databasePromise, null);
});

test("IndexedDB oldVersion 1 preserves projects and creates only v2 research stores", async () => {
  const harness = createUpgradeHarness({ oldVersion: 1, existingStoreNames: ["projects"] });
  const repository = new IndexedDbProjectRepository(harness.indexedDb);

  await repository.database();
  assert.deepEqual(harness.createdStores, [
    { storeName: "datasets", options: { keyPath: "id" } },
    { storeName: "analyses", options: { keyPath: "id" } },
  ]);
  assert.deepEqual([...harness.storeNames], ["projects", "datasets", "analyses"]);
});

test("IndexedDB store migrations are idempotent when stores already exist", async () => {
  const harness = createUpgradeHarness({
    oldVersion: 0,
    existingStoreNames: ["projects", "datasets", "analyses"],
  });
  const repository = new IndexedDbProjectRepository(harness.indexedDb);

  const first = await repository.database();
  const second = await repository.database();
  assert.equal(first, second);
  assert.deepEqual(harness.createdStores, []);
  assert.equal(harness.openCalls.length, 1);
});

function createProbeDatabase() {
  const stores = new Map([
    ["projects", new Map([["__ecolab_probe__", { id: "__ecolab_probe__", userData: true }]])],
    ["datasets", new Map([["dataset-existing", { id: "dataset-existing", userData: true }]])],
    ["analyses", new Map([["analysis-existing", { id: "analysis-existing", userData: true }]])],
  ]);
  const transactions = [];

  return {
    stores,
    transactions,
    transaction(storeNames, mode) {
      const transaction = new EventTarget();
      transaction.error = null;
      transaction.storeNames = [...storeNames];
      transaction.mode = mode;
      transaction.objectStore = (storeName) => ({
        add(record) {
          assert.equal(stores.get(storeName).has(record.id), false);
          stores.get(storeName).set(record.id, structuredClone(record));
        },
        delete(id) {
          stores.get(storeName).delete(id);
        },
      });
      transactions.push(transaction);
      queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
      return transaction;
    },
  };
}

test("IndexedDB probe checks every store without overwriting or deleting user data", async () => {
  const database = createProbeDatabase();
  const repository = new IndexedDbProjectRepository({});
  repository.database = async () => database;

  await repository.probe();

  assert.equal(database.transactions.length, 1);
  assert.deepEqual(database.transactions[0].storeNames, ["projects", "datasets", "analyses"]);
  assert.equal(database.transactions[0].mode, "readwrite");
  assert.deepEqual([...database.stores.get("projects").values()], [
    { id: "__ecolab_probe__", userData: true },
  ]);
  assert.deepEqual([...database.stores.get("datasets").values()], [
    { id: "dataset-existing", userData: true },
  ]);
  assert.deepEqual([...database.stores.get("analyses").values()], [
    { id: "analysis-existing", userData: true },
  ]);
});

test("persistence probe IDs use randomUUID with a deterministic monotonic fallback", () => {
  assert.equal(
    createPersistenceProbeId({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }),
    "__ecolab_probe__:00000000-0000-4000-8000-000000000001",
  );

  const first = createPersistenceProbeId(null);
  const second = createPersistenceProbeId(null);
  const firstSequence = Number(first.split(":").at(-1));
  const secondSequence = Number(second.split(":").at(-1));
  assert.match(first, /^__ecolab_probe__:fallback:\d+$/);
  assert.equal(secondSequence, firstSequence + 1);
});

test("IndexedDB quota failures expose a stable repository error code", async () => {
  const quotaError = Object.assign(new Error("storage full"), { name: "QuotaExceededError" });
  const database = {
    transaction() {
      const transaction = new EventTarget();
      transaction.error = null;
      transaction.abort = () => {};
      transaction.objectStore = () => ({
        get() {
          const request = new EventTarget();
          request.result = null;
          request.error = null;
          queueMicrotask(() => request.dispatchEvent(new Event("success")));
          return request;
        },
        put() {
          throw quotaError;
        },
      });
      return transaction;
    },
  };
  const repository = new IndexedDbProjectRepository({});
  repository.database = async () => database;

  await assert.rejects(
    repository.saveDataset({ id: "dataset-quota", revision: 0 }),
    (error) => error instanceof ProjectRepositoryError &&
      error.code === "PERSISTENCE_QUOTA_EXCEEDED" &&
      error.cause === quotaError,
  );
});

test("repository falls back to memory when IndexedDB is unavailable", async () => {
  const repository = await createProjectRepository(null);
  assert.equal(repository.persistent, false);
});

test("repository falls back to memory when the IndexedDB probe cannot open", async () => {
  const repository = await createProjectRepository({
    open() {
      throw new Error("IndexedDB unavailable");
    },
  });
  assert.equal(repository.persistent, false);
  assert.equal(typeof repository.saveDataset, "function");
  assert.equal(typeof repository.saveAnalysis, "function");
});

test("repository falls back to memory when an IndexedDB upgrade is blocked", async () => {
  const repository = await createProjectRepository({
    open() {
      const request = new EventTarget();
      request.error = null;
      queueMicrotask(() => request.dispatchEvent(new Event("blocked")));
      return request;
    },
  }, { probeTimeoutMs: 50 });

  assert.equal(repository.persistent, false);
});

test("repository probe timeout prevents a suspended IndexedDB request from blocking startup", async () => {
  const startedAt = Date.now();
  const repository = await createProjectRepository({
    open() {
      const request = new EventTarget();
      request.error = null;
      return request;
    },
  }, { probeTimeoutMs: 20 });

  assert.equal(repository.persistent, false);
  assert.ok(Date.now() - startedAt < 500);
});

test("repository rejects invalid persistence probe timeouts", async () => {
  await assert.rejects(
    createProjectRepository({}, { probeTimeoutMs: 0 }),
    /positive integer/,
  );
});
