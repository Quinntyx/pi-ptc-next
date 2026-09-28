const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collapseOutputPreview,
  estimateTokensFromChars,
  loadSettingsFromEnv,
  parseSectionedOutput,
  pythonErrorHelpHint,
  sectionize,
  shouldAutoRoutePromptToCodeExecution,
  sliceCellOutput,
  validateUserCode,
} = require("../dist/utils.js");

test("estimateTokensFromChars uses simple 4-char heuristic", () => {
  assert.equal(estimateTokensFromChars(1), 1);
  assert.equal(estimateTokensFromChars(4), 1);
  assert.equal(estimateTokensFromChars(5), 2);
});

test("collapseOutputPreview passes under-limit output through untouched", () => {
  const output = "alpha\nbeta\ngamma";
  assert.equal(collapseOutputPreview(output, output.length + 1, 3), output);
  assert.equal(collapseOutputPreview(output, output.length, 3), output);
});

test("collapseOutputPreview keeps a 70/30 head/tail split at line boundaries with one exact marker", () => {
  const output = Array.from({ length: 30 }, (_, index) =>
    `line-${String(index + 1).padStart(2, "0")}-${"x".repeat(15)}`
  ).join("\n");
  const result = collapseOutputPreview(output, 300, 7);

  assert.ok(result.length <= 300);
  assert.match(result, /^line-01-/);
  assert.match(result, /line-30-/);
  assert.equal((result.match(/lines hidden/g) || []).length, 1);
  assert.match(
    result,
    /\.\.\. 22 lines hidden \(529 of 719 chars\) — full output: read_cell_output\(cellIdx=7\) \.\.\./
  );
  const [head, tail] = result.split(/\n\.\.\. .*? \.\.\.\n/);
  assert.ok(head.length > tail.length * 1.5, "head should receive approximately 70% of visible content");
});

test("sliceCellOutput uses 1-based offset/limit and truncates one overlong line", () => {
  assert.equal(
    sliceCellOutput("one\ntwo\nthree\nfour", { cellIdx: 2, offset: 2, limit: 2 }),
    "two\nthree\n\n[1 more lines in cell output. Use offset=4 to continue.]"
  );
  const overlong = sliceCellOutput("x".repeat(60_000), { cellIdx: 2 });
  assert.match(overlong, /^x{100}/);
  assert.match(overlong, /\.\.\. \[truncated\]$/);
  assert.ok(overlong.length < 60_000);
});

test("pythonErrorHelpHint maps supported Python failures deterministically", () => {
  assert.equal(
    pythonErrorHelpHint("ModuleNotFoundError: No module named 'pandas.io.extra'"),
    "help: install it with provision_dependency('pandas') then re-run"
  );
  assert.equal(
    pythonErrorHelpHint("NameError: name 'x' is not defined"),
    "help: name is undefined — define it, or inspect_kernel to see live names (the kernel may have restarted)"
  );
  assert.equal(pythonErrorHelpHint("SyntaxError: invalid syntax"), "help: fix the syntax error at the reported line");
  assert.equal(
    pythonErrorHelpHint("FileNotFoundError: missing.txt"),
    "help: verify the path exists (read/ls the parent dir)"
  );
  assert.equal(
    pythonErrorHelpHint("AttributeError: module 'x' has no attribute 'y'"),
    "help: inspect_kernel to discover the real attribute/API"
  );
  assert.equal(pythonErrorHelpHint("ValueError: nope"), undefined);
});

test("validateUserCode rejects asyncio.run", () => {
  assert.throws(() => validateUserCode("import asyncio\nasyncio.run(main())"), /Top-level await is already available/);
});

test("validateUserCode rejects direct _rpc_call usage", () => {
  assert.throws(() => validateUserCode("result = await _rpc_call('read', {'path': 'x'})"), /Use the generated helper functions/);
});

test("shouldAutoRoutePromptToCodeExecution triggers on current PTC tool names", () => {
  assert.equal(shouldAutoRoutePromptToCodeExecution("Use exec_cell to analyze the logs"), true);
  assert.equal(shouldAutoRoutePromptToCodeExecution("Run the provision_kernel tool now"), true);
  assert.equal(shouldAutoRoutePromptToCodeExecution("Call inspect_kernel to check state"), true);
  assert.equal(shouldAutoRoutePromptToCodeExecution("Use code_execution for this task"), true);
  assert.equal(shouldAutoRoutePromptToCodeExecution("invoke list_kernels please"), true);
  assert.equal(shouldAutoRoutePromptToCodeExecution("run provision_dependency for numpy"), true);
});

// The pre-rename tool name must no longer be a routing trigger (C1).
test("shouldAutoRoutePromptToCodeExecution ignores the stale python_exec trigger", () => {
  assert.equal(shouldAutoRoutePromptToCodeExecution("Use python_exec to read the file"), false);
});

test("shouldAutoRoutePromptToCodeExecution detects multi-file aggregation prompts", () => {
  assert.equal(
    shouldAutoRoutePromptToCodeExecution(
      "Analyze the first 8 test/**/*.test.ts files and return compact JSON only"
    ),
    true
  );
  assert.equal(
    shouldAutoRoutePromptToCodeExecution(
      "Count imports across src/**/*.ts and show the top 10 packages"
    ),
    true
  );
});

test("shouldAutoRoutePromptToCodeExecution ignores simple or mutating prompts", () => {
  assert.equal(shouldAutoRoutePromptToCodeExecution("Read src/index.ts"), false);
  assert.equal(shouldAutoRoutePromptToCodeExecution("Fix the failing tests in src/index.ts"), false);
});

test("loadSettingsFromEnv parses preview/spool settings and accepts the old output env as an alias", () => {
  const previousPreview = process.env.PTC_OUTPUT_PREVIEW_CHARS;
  const previousLegacy = process.env.PTC_MAX_OUTPUT_CHARS;
  const previousSpool = process.env.PTC_MAX_SPOOL_CHARS;
  try {
    delete process.env.PTC_OUTPUT_PREVIEW_CHARS;
    delete process.env.PTC_MAX_OUTPUT_CHARS;
    delete process.env.PTC_MAX_SPOOL_CHARS;
    assert.equal(loadSettingsFromEnv().outputPreviewChars, 12_000);
    assert.equal(loadSettingsFromEnv().maxSpoolChars, 10_000_000);

    process.env.PTC_MAX_OUTPUT_CHARS = "9000";
    assert.equal(loadSettingsFromEnv().outputPreviewChars, 9_000);
    process.env.PTC_OUTPUT_PREVIEW_CHARS = "7000";
    process.env.PTC_MAX_SPOOL_CHARS = "123456";
    assert.equal(loadSettingsFromEnv().outputPreviewChars, 7_000);
    assert.equal(loadSettingsFromEnv().maxSpoolChars, 123_456);
  } finally {
    if (previousPreview === undefined) delete process.env.PTC_OUTPUT_PREVIEW_CHARS;
    else process.env.PTC_OUTPUT_PREVIEW_CHARS = previousPreview;
    if (previousLegacy === undefined) delete process.env.PTC_MAX_OUTPUT_CHARS;
    else process.env.PTC_MAX_OUTPUT_CHARS = previousLegacy;
    if (previousSpool === undefined) delete process.env.PTC_MAX_SPOOL_CHARS;
    else process.env.PTC_MAX_SPOOL_CHARS = previousSpool;
  }
});

test("loadSettingsFromEnv clamps automatic recovery attempts to the supported range", () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  const previousMaxAttempts = process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS;

  try {
    process.env.PTC_AUTO_RECOVER = "true";
    process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS = "1";
    assert.equal(loadSettingsFromEnv().autoRecover, true);
    assert.equal(loadSettingsFromEnv().autoRecoverMaxAttempts, 1);

    // Multi-attempt recovery is now supported; values clamp to [0, 4].
    process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS = "3";
    assert.equal(loadSettingsFromEnv().autoRecoverMaxAttempts, 3);

    process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS = "99";
    assert.equal(loadSettingsFromEnv().autoRecoverMaxAttempts, 4);

    process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS = "-3";
    assert.equal(loadSettingsFromEnv().autoRecoverMaxAttempts, 0);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }

    if (previousMaxAttempts === undefined) {
      delete process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS;
    } else {
      process.env.PTC_AUTO_RECOVER_MAX_ATTEMPTS = previousMaxAttempts;
    }
  }
});

test("sectionize indents cell content under a column-0 host marker", () => {
  assert.equal(
    sectionize("output", "line1\n\nline2\n"),
    "output:\n  line1\n\n  line2"
  );
  assert.equal(sectionize("kernel", "cell 3 · 1 def"), "kernel:\n  cell 3 · 1 def");
});

test("parseSectionedOutput round-trips sections and rejects legacy blobs", () => {
  const composed = [
    sectionize("output", "printed\n  kept indent"),
    sectionize("return (Out[2])", "[1, 2]"),
    sectionize("kernel", "cell 2 · 1 def"),
    sectionize("subagents", "✓ pool: 1/1 done"),
  ].join("\n");
  const sections = parseSectionedOutput(composed);
  assert.deepEqual(
    sections?.map((s) => s.name),
    ["output", "return", "kernel", "subagents"]
  );
  assert.equal(sections?.find((s) => s.name === "output")?.body, "printed\n  kept indent");
  assert.equal(sections?.find((s) => s.name === "return")?.body, "[1, 2]");
  // A cell printing "kernel:" at column 0 inside stdout stays inside its section.
  const spoofed = sectionize("output", "kernel:\n  not a real section");
  const parsed = parseSectionedOutput(spoofed);
  assert.deepEqual(parsed?.map((s) => s.name), ["output"]);
  assert.equal(parsed?.[0].body, "kernel:\n  not a real section");
  assert.equal(parseSectionedOutput("plain legacy text\nno markers"), null);
});
