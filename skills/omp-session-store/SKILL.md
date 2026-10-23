---
description: Use when the user asks to find, recall, compare, or browse past OMP sessions, especially completed or archived conversations.
---

# OMP Session Search

Use `session_search` to find past OMP sessions. Do not use it to search the current conversation.

## Choose a mode

- `keyword` for a remembered topic or phrase in user prompts and auto-extracted summaries. It is fast, but does not search assistant replies or tool output.
- `content` when the user refers to assistant wording, tool output, or transcript details; also use it when keyword results do not answer the question. It searches full transcripts and is slower.
- `list` when the user wants to browse sessions without a search phrase. Narrow by project and/or time when specified.

## Scope the search

- Keep the query close to the user's wording; prefer a distinctive technical term or phrase.
- Pass explicit time bounds as `since` and `until`. Accepted formats include dates, ISO datetimes, and relative durations such as `3d` or `6h`.
- Use the `project` filter with `content` or `list` searches.
- Start with the default result limit. Increase it only when the user needs a broader set.
- If a keyword search has no useful match and assistant or tool content may be relevant, retry with `content` using the same query and time bounds.

## Report results

- Use `title`, `time`, `project`, `summary`, and `snippet` to distinguish matches. Do not infer transcript details that the result does not show.
- If several sessions match, present the distinguishing details instead of choosing one without evidence.
- Include the session ID or `resume_hint` when the user needs to revisit a result. Do not resume a session unless the user asks to continue it.
