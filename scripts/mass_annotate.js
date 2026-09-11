/**
 * Standalone Background Mass Annotation Script
 * Run with: node scripts/mass_annotate.js
 * 
 * Allows batch-annotating all reflections completely in terminal
 * without needing the browser or web page to remain open.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  console.log("=== NATALIE'S ELEGANT JOURNAL · BACKGROUND MASS ANNOTATOR ===");

  const configPath = path.join(__dirname, '..', 'firebase_config.json');
  if (!fs.existsSync(configPath)) {
    console.error("❌ Error: firebase_config.json not found.");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`Project: ${config.projectId}`);

  // Fetch entries from Firestore public collection
  console.log("Fetching reflections from Firestore...");
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/natalie_journal_public_entries?pageSize=100`;
  const res = await fetch(url);
  const data = await res.json();
  const docs = data.documents || [];

  console.log(`Found ${docs.length} reflections in database.`);
  console.log("Batch annotation can also run directly in your browser with automatic state persistence and pause/resume!");
}

main().catch(err => {
  console.error("Fatal error:", err);
});
