import { runBenchmarkCli } from "./benchmark-runner";

void runBenchmarkCli()
  .then((run) => {
    // A comparison with regressions must not look like a green run in CI.
    if (run.comparison && run.comparison.regressions.length > 0) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
