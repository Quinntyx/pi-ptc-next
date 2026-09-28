const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodeExecutionRecoveryPrompt,
  classifyCodeExecutionFailure,
} = require("../dist/recovery-classifier.js");

test("classifyCodeExecutionFailure detects direct missing-await helper failures", () => {
  const code = [
    'path = "package.json"',
    "content = read(path)",
    "return content",
  ].join("\n");
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 2, in user_main',
    '    content = read(path)',
    "TypeError: object of type 'coroutine' has no len()",
  ].join("\n");

  assert.equal(classifyCodeExecutionFailure("TypeError: object of type 'coroutine' has no len()", traceback, code), "missing-await");
});

test("classifyCodeExecutionFailure detects async-wrapper iteration misuse deterministically", () => {
  const code = 'files = sorted(glob("src/**/*.ts"))';
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1, in user_main',
    '    files = sorted(glob("src/**/*.ts"))',
    "TypeError: 'coroutine' object is not iterable",
  ].join("\n");

  assert.equal(classifyCodeExecutionFailure("TypeError: 'coroutine' object is not iterable", traceback, code), "async-wrapper-iterated");
});

test("classifyCodeExecutionFailure returns null for unrelated SyntaxError and NameError inputs", () => {
  assert.equal(
    classifyCodeExecutionFailure(
      "SyntaxError: invalid syntax",
      'Traceback (most recent call last):\n  File "<stdin>", line 1\n    def broken(:\n               ^',
      "def broken(:"
    ),
    null
  );

  assert.equal(
    classifyCodeExecutionFailure(
      "NameError: name 'missing_var' is not defined",
      "Traceback (most recent call last):\n  File \"<stdin>\", line 1, in user_main\n    return missing_var",
      "return missing_var"
    ),
    null
  );
});

test("classifyCodeExecutionFailure does not treat attribute access as a missing-await helper call", () => {
  // open(p).read() and f.find(x) are attribute calls, not unawaited PTC helpers.
  const code = [
    'path = "package.json"',
    "content = open(path).read()",
    "idx = data.find(path)",
    "return content",
  ].join("\n");
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 2, in user_main',
    "    content = open(path).read()",
    "TypeError: object of type 'coroutine' has no len()",
  ].join("\n");

  assert.equal(
    classifyCodeExecutionFailure("TypeError: object of type 'coroutine' has no len()", traceback, code),
    null
  );
});

test("classifyCodeExecutionFailure ignores bare await mentions in diagnostics", () => {
  // A traceback merely echoing an await expression (or 'await' outside function)
  // is not evidence that a PTC helper went unawaited.
  const code = [
    "async def helper():",
    "    return 1",
    "content = read(path)",
  ].join("\n");
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1',
    "    await some_user_fn()",
    "SyntaxError: 'await' outside function",
  ].join("\n");

  assert.equal(
    classifyCodeExecutionFailure("SyntaxError: 'await' outside function", traceback, code),
    null
  );
});

test("classifyCodeExecutionFailure keeps evidence containing # inside string literals", () => {
  // The # in the f-string is not a comment: the read(path) call is real evidence.
  const code = [
    'chunk = f"#section-{read(path)}"',
    "return chunk",
  ].join("\n");
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1, in user_main',
    '    chunk = f"#section-{read(path)}"',
    "TypeError: object of type 'coroutine' has no len()",
  ].join("\n");

  assert.equal(
    classifyCodeExecutionFailure("TypeError: object of type 'coroutine' has no len()", traceback, code),
    "missing-await"
  );
});

test("classifyCodeExecutionFailure recognizes common iterated helper forms", () => {
  const joinCode = 'joined = "\\n".join(read(path))';
  const joinTraceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1, in user_main',
    '    joined = "\\n".join(read(path))',
    "TypeError: 'coroutine' object is not iterable",
  ].join("\n");
  assert.equal(
    classifyCodeExecutionFailure("TypeError: 'coroutine' object is not iterable", joinTraceback, joinCode),
    "async-wrapper-iterated"
  );

  const minCode = "shortest = min(read(p) for p in paths)";
  const minTraceback = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1, in user_main',
    "    shortest = min(read(p) for p in paths)",
    "TypeError: 'coroutine' object is not iterable",
  ].join("\n");
  assert.equal(
    classifyCodeExecutionFailure("TypeError: 'coroutine' object is not iterable", minTraceback, minCode),
    "async-wrapper-iterated"
  );
});

test("buildCodeExecutionRecoveryPrompt returns stable minimal text for each supported failure class", () => {
  assert.equal(
    buildCodeExecutionRecoveryPrompt("missing-await"),
    "PTC recovery: You called an async helper without await. Helpers like read, glob, find, grep, and ls are async wrappers. Await each helper call before using its result."
  );
  assert.equal(
    buildCodeExecutionRecoveryPrompt("async-wrapper-iterated"),
    "PTC recovery: You used an async helper result before awaiting it. Helpers like read, glob, find, grep, and ls are async wrappers. Await the helper call before iterating, sorting, slicing, indexing, or unpacking the result."
  );
});
