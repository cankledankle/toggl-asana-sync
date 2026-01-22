import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const TOGGL_API_TOKEN = process.env.TOGGL_API_TOKEN;
const TOGGL_WORKSPACE_ID = process.env.TOGGL_WORKSPACE_ID;
const ASANA_TOKEN = process.env.ASANA_TOKEN;

// Track synced entries
const SYNC_STATE_FILE = "synced-entries.json";

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
  const auth = Buffer.from(`${TOGGL_API_TOKEN}:api_token`).toString("base64");
  const response = await fetch(
    `https://api.track.toggl.com/api/v9${endpoint}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
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

async function getAsanaTimeEntries(taskGid) {
  try {
    const response = await asanaRequest(
      `/tasks/${taskGid}/time_tracking_entries`,
    );
    return response.data || [];
  } catch (error) {
    console.log(
      `   ⚠️  Could not fetch existing time entries: ${error.message}`,
    );
    return [];
  }
}

// Main sync function
async function syncTogglToAsana(startDate, endDate) {
  console.log(`\n🔄 Syncing Toggl → Asana (${startDate} to ${endDate})\n`);

  // Load sync state
  const syncState = await loadSyncState();
  console.log(
    `📋 Loaded sync state: ${Object.keys(syncState).length} entries previously synced\n`,
  );

  // 1. Get time entries from Toggl
  console.log("📥 Fetching Toggl time entries...");
  const timeEntries = await togglRequest(
    `/me/time_entries?start_date=${startDate}&end_date=${endDate}`,
  );

  console.log(`   Found ${timeEntries.length} total entries`);

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

  // 4. Process each task
  let synced = 0;
  let skipped = 0;
  let alreadySynced = 0;

  for (const [taskId, entries] of taskMap) {
    try {
      // Get task details from Toggl
      const togglTask = await togglRequest(
        `/workspaces/${TOGGL_WORKSPACE_ID}/projects/${entries[0].project_id}/tasks/${taskId}`,
      );

      // Check if it's an Asana task
      if (togglTask.integration_provider === "asana") {
        const asanaTaskGid = togglTask.integration_ext_id;

        console.log(`📌 Task: "${togglTask.name}"`);
        console.log(`   Asana GID: ${asanaTaskGid}`);
        console.log(`   ${entries.length} time entries`);

        // Filter out already synced entries
        const entriesToSync = entries.filter((entry) => !syncState[entry.id]);

        if (entriesToSync.length === 0) {
          console.log(`   ⏭️  All entries already synced, skipping\n`);
          alreadySynced++;
          continue;
        }

        console.log(`   ${entriesToSync.length} new entries to sync`);

        // Get existing time entries from Asana
        const existingEntries = await getAsanaTimeEntries(asanaTaskGid);
        console.log(
          `   ${existingEntries.length} existing time entries in Asana`,
        );

        // Calculate total time
        const totalSeconds = entriesToSync.reduce(
          (sum, e) => sum + e.duration,
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
          const durationMinutes = Math.round(entry.duration / 60);
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

// For production: sync last 7 days
const today = new Date().toISOString().split("T")[0];
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

console.log(`📅 Using date range: ${weekAgo} to ${today}\n`);
syncTogglToAsana(weekAgo, today).catch(console.error);
