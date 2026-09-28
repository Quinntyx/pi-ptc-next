const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeToolResult } = require("../dist/tool-adapters.js");

test("normalizeToolResult converts find empty sentinel to empty array", () => {
  const result = normalizeToolResult("find", {
    content: [{ type: "text", text: "No files found matching pattern" }],
  });

  assert.deepEqual(result.value, []);
  assert.equal(result.estimatedChars, 2);
});

test("normalizeToolResult filters pi's actual truncation notices from find output", () => {
  const result = normalizeToolResult("find", {
    content: [
      {
        type: "text",
        text: "a.js\nb.js\n[8 results limit reached. Use limit=16 for more, or refine pattern. 50KB limit reached]",
      },
    ],
  });

  assert.deepEqual(result.value, ["a.js", "b.js"]);
});

test("normalizeToolResult filters ls entry-limit notices", () => {
  const result = normalizeToolResult("ls", {
    content: [{ type: "text", text: "dir/\nfile.txt\n[10 entries limit reached. Use limit=20 for more]" }],
  });

  assert.deepEqual(result.value, ["dir/", "file.txt"]);
});

test("normalizeToolResult prefers structured details.truncation over scraped notices", () => {
  const result = normalizeToolResult("find", {
    content: [{ type: "text", text: "a.js\nb.js\n[8 results limit reached. 50KB limit reached]" }],
    details: { truncation: { truncated: true, truncatedBy: "bytes", content: "a.js\nb.js\nc.js" } },
  });

  assert.deepEqual(result.value, ["a.js", "b.js", "c.js"]);
});

test("normalizeToolResult uses structured find/ls limits before notice scraping", () => {
  const findResult = normalizeToolResult("find", {
    content: [{ type: "text", text: "a.js\n[host-specific result cap wording]" }],
    details: { resultLimitReached: 1 },
  });
  const lsResult = normalizeToolResult("ls", {
    content: [{ type: "text", text: "dir/\n[host-specific entry cap wording]" }],
    details: { entryLimitReached: 1 },
  });

  assert.deepEqual(findResult.value, ["a.js"]);
  assert.deepEqual(lsResult.value, ["dir/"]);
});

test("normalizeToolResult parses grep output into structured matches", () => {
  const result = normalizeToolResult("grep", {
    content: [
      {
        type: "text",
        text: "src/index.ts:12: const value = 1\nsrc/index.ts-13- const context = 2",
      },
    ],
  });

  assert.deepEqual(result.value, {
    matches: [
      { path: "src/index.ts", line: 12, text: "const value = 1", kind: "match" },
      { path: "src/index.ts", line: 13, text: "const context = 2", kind: "context" },
    ],
    matchLimitReached: null,
  });
});

test("normalizeToolResult keeps hyphen-digit paths intact in grep output", () => {
  const result = normalizeToolResult("grep", {
    content: [
      {
        type: "text",
        text: "docs/v2-2024-report.md:12: alpha\ndocs/v2-2024-report.md-13- beta\ndocs/v2-2024-report.md:14: gamma",
      },
    ],
  });

  assert.deepEqual(result.value.matches, [
    { path: "docs/v2-2024-report.md", line: 12, text: "alpha", kind: "match" },
    { path: "docs/v2-2024-report.md", line: 13, text: "beta", kind: "context" },
    { path: "docs/v2-2024-report.md", line: 14, text: "gamma", kind: "match" },
  ]);
});

test("normalizeToolResult parses context-first grep blocks", () => {
  const result = normalizeToolResult("grep", {
    content: [
      {
        type: "text",
        text: "docs/v2-2024-report.md-10- before\ndocs/v2-2024-report.md:12: hit",
      },
    ],
  });

  assert.deepEqual(result.value.matches, [
    { path: "docs/v2-2024-report.md", line: 10, text: "before", kind: "context" },
    { path: "docs/v2-2024-report.md", line: 12, text: "hit", kind: "match" },
  ]);
});

test("normalizeToolResult surfaces details.matchLimitReached for grep", () => {
  const result = normalizeToolResult("grep", {
    content: [{ type: "text", text: "src/a.ts:1: x\n[8 matches limit reached. Use limit=16 for more, or refine pattern]" }],
    details: { matchLimitReached: 8 },
  });

  assert.equal(result.value.matches.length, 1);
  assert.equal(result.value.matchLimitReached, 8);
});

test("normalizeToolResult returns details.ptcValue when present", () => {
  const value = { rows: [{ id: 1 }], rowCount: 1 };
  const result = normalizeToolResult("query_db", {
    content: [{ type: "text", text: "Returned 1 rows" }],
    details: { ptcValue: value },
  });

  assert.deepEqual(result.value, value);
});

test("normalizeToolResult keeps custom tool fallback on text only", () => {
  const result = normalizeToolResult("query_db", {
    content: [{ type: "text", text: "Returned 1 rows" }],
    details: { internal: true },
  });

  assert.equal(result.value, "Returned 1 rows");
});
