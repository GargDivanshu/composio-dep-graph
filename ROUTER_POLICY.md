# Tool Router Policy

This project builds a dependency graph over Composio tools for GoogleSuper and GitHub.
The graph is meant to support an agentic tool router: before executing a tool, determine which required inputs are missing, then decide whether to ask the user or call precursor tools.

## Core Model

- **Tool**: a Composio action represented as a graph node.
- **Required param**: a field in `inputParameters.required`.
- **Dependency edge**: `A -> B` labeled with `param` means tool `A` is a likely way to obtain the required `param` for tool `B`.

## Edge Inference

Edges are ranked by signal quality:

1. **Explicit parameter hints**
   - Highest confidence.
   - Example pattern: "To retrieve calendar IDs call the calendarList.list method."
   - These produce direct, high-score edges to the hinted method.

2. **Output schema signals**
   - If a tool returns fields such as `id`, `thread_id`, `email`, `repo`, or `issue_number`, it can provide those values to downstream tools.
   - This connects discovery tools like list/search/get to mutation tools like update/delete/reply.

3. **Name and description heuristics**
   - Fallback signal.
   - Required params are matched against provider tool names, descriptions, and derived object tokens.

## Router Execution Policy

Given a user intent and a target tool `T`:

1. Read `inputParameters.required` for `T`.
2. Compute missing required params.
3. For each missing param, look up incoming graph edges labeled with that param.
4. Prefer dependencies in this order:
   - explicit-hint edges,
   - output-schema matches,
   - name/description heuristic matches.
5. Auto-call a dependency when it is safe and primarily reads data, such as list/search/get.
6. Ask the user when the missing value is ambiguous, personal, destructive, or requires a side-effecting tool.
7. Re-check missing params after each dependency call and continue until the target tool is executable.

This maps cleanly to Composio agent behavior: discovery tools fetch IDs and context, then action tools execute once their required inputs are available.

