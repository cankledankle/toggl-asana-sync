import fs from "fs/promises";
import "dotenv/config";

const TOGGL_API_TOKEN = process.env.TOGGL_API_TOKEN;
const TOGGL_WORKSPACE_ID = process.env.TOGGL_WORKSPACE_ID;
const ASANA_TOKEN = process.env.ASANA_TOKEN;

// Validate required environment variables
if (!TOGGL_API_TOKEN || !TOGGL_WORKSPACE_ID || !ASANA_TOKEN) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

// Track synced entries
const SYNC_STATE_FILE = "synced-entries.json";

// Pre-compute auth tokens to avoid Base64 encoding on every request
const TOGGL_AUTH = Buffer.from(`${TOGGL_API_TOKEN}:api_token`).toString("base64");

// Load sync state
async function loadSyncState() {
  try {
    const data = await fs.readFile(SYNC_STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist yet, return empty object
    return {};
  }
}

// Save sync state
async function saveSyncState(state) {
  await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

// Toggl API helpers
async function togglRequest(endpoint) {
  const response = await fetch(
    `https://api.track.toggl.com/api/v9${endpoint}`,
    {
      headers: {
        Authorization: `Basic ${TOGGL_AUTH}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Toggl API error: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

// Get detailed time entries (not grouped summary)
async function getWorkspaceTimeEntries(startDate, endDate) {
  const response = await fetch(
    `https://api.track.toggl.com/reports/api/v3/workspace/${TOGGL_WORKSPACE_ID}/search/time_entries`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${TOGGL_AUTH}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
        grouped: false,
        include_time_entry_ids: true,
        order_by: "date",
        order_dir: "DESC",
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Toggl Reports API error: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();

  // Flatten the nested structure
  const flatEntries = [];
  for (const group of data) {
    if (group.time_entries) {
      for (const entry of group.time_entries) {
        flatEntries.push({
          ...entry,
          task_id: group.task_id,
          project_id: group.project_id,
          user_id: group.user_id,
          description: group.description,
          billable: group.billable,
        });
      }
    }
  }

  return flatEntries;
}

// Asana API helpers
async function asanaRequest(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${ASANA_TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(
    `https://app.asana.com/api/1.0${endpoint}`,
    options,
  );

  if (!response.ok) {
    throw new Error(
      `Asana API error: ${response.status} ${await response.text()}`,
    );
  }

  return response.json();
}

// Get existing time entries from Asana task (with caching to avoid repeated calls)
async function getAsanaTimeEntries(taskGid, cache) {
  // Check cache first
  if (cache.has(taskGid)) {
    return cache.get(taskGid);
  }

  try {
    const response = await asanaRequest(
      `/tasks/${taskGid}/time_tracking_entries`,
    );
    const entries = response.data || [];
    // Store in cache for this sync session
    cache.set(taskGid, entries);
    return entries;
  } catch (error) {
    console.log(
      `   ⚠️  Could not fetch existing time entries: ${error.message}`,
    );
    // Cache empty result to avoid retrying failed requests
    cache.set(taskGid, []);
    return [];
  }
}

// Main sync function
async function syncTogglToAsana(startDate, endDate) {
  console.log(`\n🔄 Syncing Toggl → Asana (${startDate} to ${endDate})`);
  console.log(`   Syncing time entries from ALL workspace users\n`);

  // Load sync state
  const syncState = await loadSyncState();
  console.log(
    `📋 Loaded sync state: ${Object.keys(syncState).length} entries previously synced\n`,
  );

  // Initialize session caches to minimize API calls
  const togglTaskCache = new Map(); // Cache Toggl task lookups
  const asanaTaskCache = new Map(); // Cache Asana existing entries per task

  // 1. Get ALL workspace time entries (not just current user)
  console.log("📥 Fetching workspace time entries...");
  const timeEntries = await getWorkspaceTimeEntries(startDate, endDate);

  console.log(`   Found ${timeEntries.length} total entries across all users`);

  // 2. Filter entries with task_id
  const entriesWithTasks = timeEntries.filter((entry) => entry.task_id);
  console.log(`   ${entriesWithTasks.length} entries have tasks assigned\n`);

  // 3. Group by task to avoid duplicate API calls
  const taskMap = new Map();

  for (const entry of entriesWithTasks) {
    if (!taskMap.has(entry.task_id)) {
      taskMap.set(entry.task_id, []);
    }
    taskMap.get(entry.task_id).push(entry);
  }

  console.log(`📊 Processing ${taskMap.size} unique tasks...\n`);

  // 4. Process each task
  let synced = 0;
  let skipped = 0;
  let alreadySynced = 0;

  for (const [taskId, entries] of taskMap) {
    try {
      // Check cache first before fetching from Toggl
      let togglTask;
      if (togglTaskCache.has(taskId)) {
        togglTask = togglTaskCache.get(taskId);
      } else {
        // Fetch from Toggl and cache result
        togglTask = await togglRequest(
          `/workspaces/${TOGGL_WORKSPACE_ID}/projects/${entries[0].project_id}/tasks/${taskId}`,
        );
        togglTaskCache.set(taskId, togglTask);
      }

      // Check if it's an Asana task
      if (togglTask.integration_provider === "asana") {
        const asanaTaskGid = togglTask.integration_ext_id;

        console.log(`📌 Task: "${togglTask.name}"`);
        console.log(`   Asana GID: ${asanaTaskGid}`);
        console.log(
          `   ${entries.length} time entries from ${new Set(entries.map((e) => e.user_id)).size} user(s)`,
        );

        // Filter out already synced entries
        const entriesToSync = entries.filter((entry) => !syncState[entry.id]);

        if (entriesToSync.length === 0) {
          console.log(`   ⏭️  All entries already synced, skipping\n`);
          alreadySynced++;
          continue;
        }

        console.log(`   ${entriesToSync.length} new entries to sync`);

        // Get existing time entries from Asana (uses session cache to avoid repeated calls)
        const existingEntries = await getAsanaTimeEntries(asanaTaskGid, asanaTaskCache);
        console.log(
          `   ${existingEntries.length} existing time entries in Asana`,
        );

        // Calculate total time (handle both 'seconds' and 'duration' fields)
        const totalSeconds = entriesToSync.reduce(
          (sum, e) => sum + (e.seconds || e.duration || 0),
          0,
        );
        const totalMinutes = Math.round(totalSeconds / 60);

        console.log(
          `   Total new time: ${totalMinutes} minutes (${(totalMinutes / 60).toFixed(2)} hours)`,
        );

        let created = 0;
        let duplicates = 0;

        // Send to Asana
        for (const entry of entriesToSync) {
          // Handle both Reports API (seconds) and regular API (duration)
          const durationMinutes = Math.round(
            (entry.seconds || entry.duration) / 60,
          );
          const enteredOn = entry.start.split("T")[0];

          // Check if an entry with same date and duration already exists
          const alreadyExists = existingEntries.some(
            (existing) =>
              existing.entered_on === enteredOn &&
              existing.duration_minutes === durationMinutes,
          );

          if (alreadyExists) {
            console.log(
              `   ⏭️  Already exists in Asana: ${durationMinutes} min on ${enteredOn}`,
            );
            duplicates++;

            // Mark as synced without creating
            syncState[entry.id] = {
              synced_at: new Date().toISOString(),
              asana_task_gid: asanaTaskGid,
              duration_minutes: durationMinutes,
              entered_on: enteredOn,
              already_existed: true,
            };
            continue;
          }

          // Create new entry
          await asanaRequest(
            `/tasks/${asanaTaskGid}/time_tracking_entries`,
            "POST",
            {
              data: {
                duration_minutes: durationMinutes,
                entered_on: enteredOn,
              },
            },
          );

          created++;

          // Mark as synced
          syncState[entry.id] = {
            synced_at: new Date().toISOString(),
            asana_task_gid: asanaTaskGid,
            duration_minutes: durationMinutes,
            entered_on: enteredOn,
            user_id: entry.user_id,
          };

          console.log(`   ✅ Created ${durationMinutes} min on ${enteredOn}`);
        }

        console.log(
          `   📊 ${created} created, ${duplicates} duplicates skipped`,
        );

        synced++;
      } else {
        console.log(`⏭️  Skipping non-Asana task: "${togglTask.name}"`);
        skipped++;
      }

      console.log("");
    } catch (error) {
      console.error(`❌ Error processing task ${taskId}:`, error.message);
    }
  }

  // Save sync state
  await saveSyncState(syncState);
  console.log(
    `💾 Saved sync state: ${Object.keys(syncState).length} total entries tracked\n`,
  );

  console.log(`✨ Sync complete!`);
  console.log(`   ${synced} tasks synced`);
  console.log(`   ${alreadySynced} tasks already synced (skipped)`);
  console.log(`   ${skipped} non-Asana tasks skipped`);
}

// Sync from Jan 23, 2026 to today to prevent duplicate entries
const today = new Date().toISOString().split("T")[0];
const syncStartDate = "2026-01-23";

console.log(`📅 Using date range: ${syncStartDate} to ${today}\n`);
syncTogglToAsana(syncStartDate, today).catch(console.error);
