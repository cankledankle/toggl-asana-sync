// sync.js
import fetch from "node-fetch";

// GitHub Actions provides env vars directly
const TOGGL_API_TOKEN = process.env.TOGGL_API_TOKEN;
const TOGGL_WORKSPACE_ID = process.env.TOGGL_WORKSPACE_ID;
const ASANA_TOKEN = process.env.ASANA_TOKEN;

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

// Main sync function
async function syncTogglToAsana(startDate, endDate) {
  console.log(`\n🔄 Syncing Toggl → Asana (${startDate} to ${endDate})\n`);

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

        // Sum up total time for this task
        const totalSeconds = entries.reduce((sum, e) => sum + e.duration, 0);
        const totalMinutes = Math.round(totalSeconds / 60);

        console.log(
          `   Total time: ${totalMinutes} minutes (${(totalMinutes / 60).toFixed(2)} hours)`,
        );

        // Send to Asana
        for (const entry of entries) {
          const durationMinutes = Math.round(entry.duration / 60);
          const enteredOn = entry.start.split("T")[0];

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

          console.log(`   ✅ Synced ${durationMinutes} min on ${enteredOn}`);
        }

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

  console.log(`\n✨ Sync complete!`);
  console.log(`   ${synced} tasks synced`);
  console.log(`   ${skipped} tasks skipped`);
}

// Run the sync
const today = new Date().toISOString().split("T")[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

syncTogglToAsana(yesterday, today).catch(console.error);
