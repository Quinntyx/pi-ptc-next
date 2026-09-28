# Custom tools

## What it does

pi-ptc-next lets you extend both the model and the Python runtime with your own tools by dropping plain JavaScript files into the extension's `tools/` directory. Each file defines one tool that pi registers as a normal model-callable tool; by adding a small `ptc` metadata block you can also expose the tool to Python cells running in `exec_cell`, where it appears as an automatically generated `async` helper function. The extension watches the directory while the session runs, so new, edited, renamed, and deleted tool files are picked up without restarting.

## How it works

- **Loading.** On session start, `CustomToolManager` scans `tools/` (inside the installed extension root) and loads every `*.js` file (sorted, no recursion). Each file must export a tool object — either `export default { ... }` or as the module itself — with `name`, `parameters` (a JSON Schema object), and an `execute` function. `label` and `description` are optional and default to the tool name.
- **Reserved names.** A custom tool may not use a builtin pi tool name or one of the extension's own tool names (`provision_kernel`, `exec_cell`, `list_kernels`, `inspect_kernel`, `provision_dependency`), and two files may not declare the same tool name. Rejections are logged as warnings at startup; valid tools still load.
- **Activation.** Registered tools are added to the session's active tool set unless an explicit `ptc.callers` array excludes `"direct"`. A `callers: ["code_execution"]` tool is registered and exposed to Python but is *not* activated as a direct model tool. An explicit array — including an empty one — is authoritative; an omitted `callers` means defaults apply (`direct`).
- **Python exposure.** Custom tools are **not** callable from Python by default. With `ptc: { enabled: true, readOnly: true }` the tool is included in the callable tool set, and the `exec_cell` / `inspect_kernel` descriptions are rebuilt (via `buildToolDescription`) so the model sees the new Python helper signature. Python wrappers are generated from the tool's `parameters` schema; `ptc.pythonName` overrides the generated function name.
- **Return values.** If a tool returns `details.ptcValue` (a JSON-compatible value), that value is passed to Python as-is. Otherwise the tool's text output is normalized into a string for Python.
- **Caller context.** When a Python cell calls the tool, `ctx.caller` carries `{ type: "code_execution", parentToolCallId?, nestedCallId }`, so the tool can distinguish nested calls from direct model calls.
- **Hot reload.** A `fs.watch` watcher (300 ms debounce per file) reloads changed files with a cache-busted ESM import. If a file is deleted or becomes invalid, its previous tool is deactivated and removed; if a file's tool name changes, the old name is retired. Reconciles per file are serialized, and a broken watcher is automatically re-established after 1 second.
- **Lifecycle.** The manager starts once per session and is closed on session shutdown, which stops the watcher and cancels pending reconciles.

## Usage

Create `tools/get_weather.js` (the repo ships `tools/get_weather.js.example`; copy it to activate):

```js
export default {
  name: "get_weather",
  label: "Get Weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "e.g. 'San Francisco'" },
    },
    required: ["location"],
  },
  ptc: {
    enabled: true,      // callable from Python cells
    readOnly: true,     // read-only metadata (auto-routing); mutations are not gated
  },
  execute: async (toolCallId, { location }, signal, onUpdate, ctx) => {
    if (signal?.aborted) throw new Error("Weather request was cancelled");
    return {
      content: [{ type: "text", text: `Weather in ${location}: sunny and 21 C` }],
    };
  },
};
```

`execute` has the signature `async (toolCallId, params, signal, onUpdate, ctx) => result` and returns a pi tool result (`content` array, optional `details`).

To return structured data to Python instead of text, add `details.ptcValue`:

```js
async execute(toolCallId, params) {
  const rows = await query(params.sql);
  return {
    content: [{ type: "text", text: `Returned ${rows.length} rows` }],
    details: { ptcValue: { rows, rowCount: rows.length } },
  };
}
```

After saving the file (hot reload registers it within ~300 ms), the model can call `get_weather` directly, and a Python cell can call the generated helper:

```python
forecast = await get_weather(location="London")
return {"summary": forecast}
```

## Options

### `ptc` metadata on the tool's default export

| Field | Type | Effect |
|---|---|---|
| `enabled` | boolean | Allow calls from `code_execution` (Python). Without it, the tool is direct-only. |
| `readOnly` | boolean | Read-only metadata; informs auto-routing and future policy layers (mutations are not gated in yolo mode). |
| `pythonName` | string | Override the Python wrapper function name. Duplicates and reserved helper names are rejected. |
| `callers` | `("direct" \| "code_execution")[]` | Explicit caller allowlist. Authoritative including the empty array (`[]` = usable by no one). Omit it to use defaults. |

### Environment variables

- `PTC_CALLABLE_TOOLS=read,glob,find,grep,ls` — explicit allowlist override for the whole callable tool set (builtins listed by default; custom tools need naming here too when this is set).
- `PTC_BLOCKED_TOOLS=bash,write` — explicit denylist override.
- Custom tools with `ptc.enabled: true` are callable from Python regardless of `readOnly` — mutation gating was removed under the yolo-mode policy (the Python process can edit files natively anyway).
- `PTC_DEBUG=1` — verbose logging, including custom tool registration/reload debug lines.

There is no settings-file configuration for custom tools; everything is driven by the tool files themselves plus these environment variables.

## Standalone setup notes

- **The `tools/` directory lives inside the installed extension, and its path is not configurable.** `CustomToolManager` computes it as `<extensionRoot>/tools`, where `extensionRoot` is the directory of the built extension code (a trailing `/dist` is stripped). For an npm install that means something like `node_modules/<package>/tools`; package upgrades can wipe files you add there. Workarounds: keep your tool sources elsewhere and symlink each file into `tools/` (the watcher follows the directory entries), or maintain a patched local checkout of the extension and install pi from that path.
- **The example is inactive until copied.** `tools/get_weather.js.example` is not loaded (only `*.js` files are). Run `cp get_weather.js.example get_weather.js` inside the extension's `tools/` directory to activate it.
- **The example simulates a 10-second delay.** `get_weather.js.example` sleeps 10 seconds before answering (with an abort check). Expect slow direct calls and slow Python helpers until you edit the delay down.
- **File format assumptions.** Only CommonJS/ESM `.js` files that Node can `import` work — no `.mjs`, `.cjs`, `.ts`, or TypeScript sources, no nested directories. Files using `export default` work as documented because the loader bypasses the CommonJS `require()` rewrite with a native dynamic import; every reload uses a fresh URL so edits take effect.
- **Name collisions fail individually, not wholesale.** A file whose tool name collides with a builtin/PTC tool name or another file's tool is skipped with a warning; the rest of your tools keep working. Check session logs for `Skipping custom tool ...` / `Custom tool reload failed ...` if a tool doesn't appear.
- **No remote/private resources are involved.** Unlike some other pi-ptc features (e.g. the subagent provisioner), custom tools have no default private URLs, profiles, or author-machine paths — everything is local file loading plus whatever your own `execute` does.
