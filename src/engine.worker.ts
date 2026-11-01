import {
  optimizePolicy,
  runDeterministic,
  runMonteCarlo,
} from "./model";

import type { WorkerRequest, WorkerResponse } from "./model";

const send = (message: WorkerResponse) => postMessage(message);

onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { job, settings } = event.data;

  const progress = (done: number, total: number) =>
    send({ type: "progress", done, total });

  try {
    switch (job) {
      case "deterministic":
        send({
          type: job,
          result: runDeterministic(settings),
        });
        break;

      case "monte-carlo":
        send({
          type: job,
          result: runMonteCarlo(settings, progress),
        });
        break;

      case "optimization":
        send({
          type: job,
          result: optimizePolicy(settings, progress),
        });
        break;

      default:
        throw new Error("Unknown worker job.");
    }
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

