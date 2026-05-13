---
name: Bug report
about: Report a defect in the Cirron CLI
title: ''
labels: bug
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is: what you expected to happen and what actually happened.

**Reproduction**
The smallest `cirron ...` command sequence that triggers the bug. Include the relevant `cirron.yaml` (or `cirron init` template) if a project is involved.

```bash
cirron init repro --template pytorch
cd repro
cirron build --validate
# ...
```

**Environment**

```bash
cirron --version
cirron doctor
node -v
```

- OS (e.g. macOS 14.5, Ubuntu 22.04, Windows 11):
- Cirron CLI version:
- How you installed it (`npm install -g @cirron/cli`, standalone binary, or a local `npm link` checkout):
- Hardware (CPU only / NVIDIA GPU + CUDA version / Apple Silicon / TPU), if relevant:

**Additional context**
Full CLI output / stack traces, `cirron traces view` output, or spool snippets under `./.cirron/spool/` that help narrow it down. If the command exited with an error code, note it (see `CLI-ERROR-CODES.md`).
