const test = require("node:test");
const assert = require("node:assert/strict");
const { generateToolWrappers } = require("../dist/tools/tool-wrapper.js");

test("generateToolWrappers emits concise wrappers with typed result models", () => {
  const code = generateToolWrappers([
    {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path" },
          offset: { type: "integer", description: "Offset" },
        },
        required: ["path"],
      },
      source: "builtin",
      isReadOnly: true,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    },
    {
      name: "glob",
      description: "Find files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob" },
          path: {
            anyOf: [{ type: "string" }, { type: "integer" }],
            description: "Base path or numeric selector",
          },
        },
        required: ["pattern"],
      },
      source: "alias",
      isReadOnly: true,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    },
    {
      name: "bash",
      description: "Run shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command" },
        },
        required: ["command"],
      },
      source: "builtin",
      isReadOnly: false,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    },
  ]);

  assert.match(code, /from typing import Optional, List, Dict, Any, TypedDict, Union/);
  assert.match(code, /class BashResult\(TypedDict\):/);
  assert.match(code, /class GrepMatch\(TypedDict\):/);
  assert.match(code, /class GrepResult\(TypedDict\):/);
  assert.match(code, /matchLimitReached: Optional\[int\]/);
  assert.match(code, /async def read\(/);
  assert.match(code, /path: str/);
  assert.doesNotMatch(code, /file_path/);
  assert.match(code, /async def glob\(/);
  assert.match(code, /path: Optional\[Union\[str, int\]\] = None/);
  assert.match(code, /async def bash\(/);
  assert.match(code, /\) -> BashResult:/);
  assert.doesNotMatch(code, /Args:/);
  assert.match(code, /return await _rpc_call\("glob", params\)/);
});
