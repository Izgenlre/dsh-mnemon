---
"dsh-mnemon": patch
"dsh-mnemon-source-memory-spaces": patch
---

Resolve runtime archive destinations through the selected Memory Spaces Source's write authority, including known spaces activated later and spaces created by the initiating View. Keep empty or foreign scopes restricted, recheck authority before writes, and report retryable destination failures without discarding committed runtime entries. Older Sources retain the narrower pinned namespace fallback.
