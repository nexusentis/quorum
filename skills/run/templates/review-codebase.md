You are doing a full codebase review. Explore the repository structure, read key files, and analyze the codebase holistically.

## Scope:
{SCOPE}

## What to look for:
- **Architecture**: overall structure, separation of concerns, dependency flow, circular dependencies
- **Bugs**: logic errors, race conditions, null/undefined handling, unhandled edge cases
- **Security**: injection risks, hardcoded secrets, authentication/authorization gaps, input validation
- **Performance**: algorithmic complexity, N+1 queries, blocking operations, memory leaks, unnecessary work
- **Maintainability**: dead code, duplication, unclear naming, tight coupling, missing error handling
- **Dependencies**: outdated or vulnerable packages, unnecessary dependencies, version conflicts

## How to explore:
1. Start by reading the project structure (list top-level files and directories)
2. Read configuration files (package.json, tsconfig.json, etc.) to understand the stack
3. Identify entry points and trace the main code paths
4. Read the most critical files in detail
5. Sample-check supporting files for patterns

## Output format:
For each finding:
```
[SEVERITY: CRITICAL|HIGH|MEDIUM|LOW] [CATEGORY: Architecture|Bug|Security|Performance|Maintainability|Dependencies]
Location: <file:line or description>
Finding: <what the issue is>
Suggestion: <how to fix it>
```

At the end, include:
- Overall health assessment (HEALTHY / NEEDS_WORK / CRITICAL_ISSUES)
- Top 5 most important findings, ranked by impact
- One paragraph summary of the codebase's strengths
