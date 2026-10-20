---
type: llm
weight: 1
---

Pass if the agent's final response reflects the brief's reading order: hunks under "Review
first" (if any were returned) are addressed first with their "Check specifically" questions
answered using file:line evidence, and the agent also says it read (or intends to read) every
other changed hunk at least once rather than treating the brief as a filter that limits the
review. Fail if the agent treats "Review first" as the entire review, or invents hunks/findings
that are not grounded in anything the brief or the diff actually showed.
