# AGENTS.md - Development Guidelines

This document provides essential information for coding agents operating in the toggl-asana-sync repository.

## Project Overview

**toggl-asana-sync** is a Node.js CLI tool that syncs time tracking data from Toggl to Asana tasks. It supports:
- Fetching time entries from all workspace users (not just current user)
- Detecting duplicate entries in Asana before syncing
- Maintaining sync state to prevent re-syncing already synced entries
- Handling multiple users and projects

## Build, Test & Run Commands

### Running the Sync
```bash
npm run sync
```
Executes the main sync script. Requires environment variables: `TOGGL_API_TOKEN`, `TOGGL_WORKSPACE_ID`, `ASANA_TOKEN`.

### No Testing Infrastructure
This project currently has **no test suite**. When making changes:
- Manually test against live Toggl/Asana APIs or use mock environments
- Verify sync state tracking works correctly
- Check duplicate detection logic
- Review error handling paths

### Environment Setup
Create `.env` file with:
```
TOGGL_API_TOKEN=your_toggl_token
TOGGL_WORKSPACE_ID=your_workspace_id
ASANA_TOKEN=your_asana_token
```

## Code Style Guidelines

### JavaScript/Node.js Standards

**Module System:**
- Use ES modules (`import`/`export`), not CommonJS
- `package.json` declares `"type": "module"`
- Import statements at the top of files

**Formatting & Naming:**
- Use semicolons at statement ends
- 2-space indentation (not tabs)
- camelCase for variables and functions
- UPPER_SNAKE_CASE for constants (e.g., `TOGGL_API_TOKEN`, `SYNC_STATE_FILE`)
- Descriptive names: `syncTogglToAsana` not `sync2`

**Function Organization:**
- Group related functions together
- Place helper functions before main logic
- API request helpers at the top of file sections
- Main function (`syncTogglToAsana`) after helpers

**Comments & Documentation:**
- Use `// Comment` style for single-line comments
- Document API functions with their purpose above the function
- Explain non-obvious logic (e.g., why we filter or group data)
- Use emoji comments in console output for user clarity (📥, ✅, ❌, ⚠️, etc.)

### Error Handling

**API Errors:**
- Check `response.ok` before processing responses
- Throw descriptive errors with status code and response text
- Include context about which API and endpoint failed

Example:
```javascript
if (!response.ok) {
  throw new Error(`Toggl API error: ${response.status} ${await response.text()}`);
}
```

**Graceful Degradation:**
- Try/catch around non-critical operations (e.g., fetching existing entries)
- Log warnings instead of failing completely
- Return sensible defaults (empty arrays) on recoverable errors

Example:
```javascript
async function getAsanaTimeEntries(taskGid) {
  try {
    const response = await asanaRequest(`/tasks/${taskGid}/time_tracking_entries`);
    return response.data || [];
  } catch (error) {
    console.log(`   ⚠️  Could not fetch existing time entries: ${error.message}`);
    return [];
  }
}
```

**Promises & Async:**
- Use async/await for all asynchronous operations
- Always `.catch()` unhandled promise rejections at entry points
- Properly await all async function calls

### Data Structures & Types

**No TypeScript:**
This is a vanilla JavaScript project. Use JSDoc comments for type hints where helpful:
```javascript
// Get synced state from disk
// @returns {Promise<Object>} Map of entry IDs to sync metadata
async function loadSyncState() { ... }
```

**API Response Handling:**
- Handle both old and new API response fields (e.g., `seconds` vs `duration`)
- Destructure nested objects carefully
- Normalize inconsistent data formats

Example:
```javascript
const durationMinutes = Math.round((entry.seconds || entry.duration) / 60);
```

**State Management:**
- Use Objects/Maps to track synced entries
- Store metadata with each tracked entry (timestamp, Asana GID, duration, etc.)
- Use JSON for persistence with proper formatting (`JSON.stringify(state, null, 2)`)

### API Integration Patterns

**Authentication:**
- Use Bearer token for Asana: `Authorization: Bearer ${token}`
- Use Basic auth for Toggl: `Authorization: Basic ${base64EncodedToken}`

**Request Structure:**
```javascript
async function makeRequest(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  
  const response = await fetch(`${API_URL}${endpoint}`, options);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}
```

**Handling Nested/Complex Data:**
- Flatten nested structures explicitly (don't rely on spreads alone)
- Document why flattening is needed (e.g., Toggl Reports API returns grouped data)
- Preserve parent context when flattening child arrays

### Console Output

Use structured emoji-prefixed logging:
- `🔄` Sync operations
- `📥` Fetching data
- `📌` Task processing
- `✅` Success/created
- `⏭️` Skipped
- `⚠️` Warnings
- `❌` Errors
- `💾` Saving state
- `✨` Completion

Indent related output with spaces for clarity:
```javascript
console.log(`📥 Fetching workspace time entries...`);
console.log(`   Found ${count} total entries`);
```

## Project Structure

```
toggl-asana-sync/
├── sync.js              # Main sync script
├── synced-entries.json  # Sync state persistence
├── package.json         # Dependencies and scripts
├── .env                 # Environment variables (gitignored)
└── .gitignore          # Git ignore rules
```

## Dependencies

- `node-fetch@^3.3.2` - HTTP requests (isomorphic fetch)
- `dotenv@^17.2.3` - Environment variable loading
- Node.js built-ins: `fs/promises` (file I/O)

Keep dependencies minimal. Don't add test frameworks, linters, or formatters unless necessary.

## Key Algorithms & Patterns

**Sync State Tracking:**
- Load state from disk at startup
- Track by Toggl entry ID as key
- Store synced_at, asana_task_gid, duration_minutes, entered_on
- Mark already-existing entries (don't duplicate)
- Save state after all syncing completes

**Task Grouping:**
- Group time entries by task_id to minimize API calls
- Detect duplicates in Asana before posting (same date + duration)
- Process all entries for a task together

**Date Handling:**
- Use ISO date format (YYYY-MM-DD): `entry.start.split("T")[0]`
- Calculate date ranges client-side (last 30 days)
- Never assume timezone; use ISO strings

## Common Gotchas

1. **API Response Fields:** Toggl and Asana use different field names; always handle variations
2. **Async Errors:** Ensure `.catch()` is attached to top-level promise chains
3. **Duplicate Prevention:** Check Asana before creating, not after (avoids orphaned entries)
4. **File I/O:** Use `fs/promises` for async file operations
5. **Auth Tokens:** Never log or expose tokens in output
6. **Workspace Context:** This tool processes ALL workspace users, not just authenticated user

## Git Commit Style

Keep commits focused and descriptive:
- Use imperative mood: "Add sync state caching" not "Added sync state caching"
- Reference what changed and why: "Complete Toggl to Asana sync with workspace-wide support"
- Avoid vague messages like "update test" or "update to do more stuff"
