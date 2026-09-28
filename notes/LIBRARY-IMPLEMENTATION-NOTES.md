Implemented PTC-LIBRARY.

### Landed
- `provision_kernel({ notebook: string, source?: string })`
  - Sources `.ipynb` or `.py`.
  - Bare names resolve from the library directory.
  - Notebook sources are copied; markdown ordering survives and code cells execute in order with refreshed outputs.
  - `.py` sources become one prefix cell.
  - Numbering includes all prefix cells: 7 source cells → next `exec_cell` is cell 8.
  - Failures populate `sourceError: { cellIdx, message, traceback? }`, record the failed cell, and leave the kernel usable.
  - Returns `sourcedFrom`.

- New host tool:
  - `promote_to_skill_notebook({ name: string, notebookPath?: string, overwrite?: boolean })`
  - Uses the most recent session notebook by default.
  - Sanitizes names to lowercase hyphenated filenames.
  - Copies complete notebook JSON, including markdown, code, metadata, and outputs.
  - Refuses overwrite unless explicitly enabled.

- Manager API:
  - `promoteToSkillNotebook(options: { name: string; notebookPath?: string; overwrite?: boolean; cwd?: string }): Promise<SkillNotebookPromotionResult>`
  - Legacy `toScript()` remains operational.

- Library location:
  - `$PTC_LIBRARY_DIR`
  - Otherwise `$PI_CODING_AGENT_DIR/ptc-library`
  - Default: `~/.config/pi/ptc-library`
  - Added `PtcSettings.libraryDir?: string`.

- Added `skills/ptc-library/SKILL.md`; existing package configuration already registers `./skills`.
- Updated README provisioning/library documentation.

### Validation
- `npm run build` — passed.
- `timeout 150 node --test test/index.test.ts` — 14 passed.
- Real-kernel `test/python-session-manager.test.ts` — 37 passed.

No requested functionality was deferred. Sourcing stops at the first failed source code cell; prior state remains available.