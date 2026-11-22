import { Worker } from "node:worker_threads";

const JOB_TIMEOUT_MS = 120_000;
let worker = null;
let nextId = 1;
const waiting = new Map();
let chain = Promise.resolve();

function failAll(error) {
  for (const [id, job] of waiting) {
    clearTimeout(job.timer);
    job.reject(error);
    waiting.delete(id);
  }
}

function startWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./learnWorker.js", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  worker.unref();
  worker.on("message", ({ id, ok, result, error }) => {
    const job = waiting.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    waiting.delete(id);
    if (ok) job.resolve(result);
    else job.reject(new Error(error || "Travail échoué."));
  });
  const reset = (error) => {
    worker = null;
    failAll(error instanceof Error ? error : new Error("Travailleur arrêté."));
  };
  worker.on("error", reset);
  worker.on("exit", (code) => {
    if (code !== 0) reset(new Error(`Travailleur arrêté (${code}).`));
    else worker = null;
  });
  return worker;
}

function runNow(op, match) {
  return new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Travail trop long."));
      const stuck = worker;
      worker = null;
      stuck?.terminate().catch(() => {});
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    try {
      startWorker().postMessage({ id, op, match });
    } catch (error) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(error);
    }
  });
}

/** Un seul travail à la fois, dans un fil à part : les matchs ne ralentissent pas. */
export function runLearnJob(op, match) {
  const job = chain.then(() => runNow(op, match));
  chain = job.catch(() => {});
  return job;
}
