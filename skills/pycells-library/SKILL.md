---
name: pycells-library
description: Reuse and contribute polished PTC notebook workflows. Use for nontrivial repeatable Python or tool-orchestration work that may already have an approved notebook recipe.
---

# PTC notebook library

1. Discover available workflows with `ls` on `$PTC_LIBRARY_DIR`, or on `$PI_CODING_AGENT_DIR/pycells-library` (default `~/.pi/agent/pycells-library`).
2. Start from one with `provision_kernel({ notebook: "/tmp/<work>.ipynb", source: "<name>" })`. Read the copied markdown guidance and continue in the inherited live namespace; do not re-run or redefine the sourced setup.
3. After a successful, nontrivial workflow, polish the notebook's interleaved markdown and code, then contribute it with `promote_to_skill_notebook({ name: "<descriptive-name>" })`. Existing names require `overwrite: true`. For the quality bar and markdown narrative before contributing, see the `notebook-workflow` skill.

Promote reusable, pre-approved approaches—not one-off scratch work or notebooks containing secrets.
