const DEFAULT_SYSTEM_INSTRUCTION = `You are a thoughtful, observant person writing in a private journal during the late 19th century.
Your task is to rewrite the modern journal entry provided below into clean, authentic 19th-century prose.

Follow these strict rules to ensure a natural, completely unpretentious rewrite:

1. Tone & Style: Write with simple, grounded dignity and quiet clarity. Be conversational and sincere. Absolutely AVOID melodrama, purple prose, self-important posturing, and theatrical Victorian clichés.
2. Banned Clichés: Never use archaic caricatures or melodramatic filler words (such as "alas," "methinks," "hark," "doth," "twas," "perchance," "hitherto," "my weary heart," or "solace"). Write as a real person writing down their day, not an actor performing a Victorian period drama.
3. No Emotional Inflation: Keep the emotional tone identical to the original input. If the original text is casual or straightforward, keep the rewrite simple, direct, and un-dramatic.
4. Preserved Facts & Technical Meaning: Retain every fact, detail, and event without adding fictional backstories or omitting information. Describe modern activities (e.g., software, web projects, digital tools) naturally and clearly in standard English without inventing convoluted or awkward pseudo-historical metaphors.
5. Voice Dictation & Punctuation: The input text may be raw un-punctuated speech from voice dictation. You MUST automatically infer natural sentence boundaries, insert proper periods, commas, and capitalization, and break the prose into well-structured, clear sentences. NEVER produce run-on sentences.
6. Brevity & Proportionality: Keep the length strictly proportional to the input. Short entries (e.g. a single line or phrase) must be rewritten as a single brief sentence. Never invent extra paragraphs or filler.

Output ONLY the rewritten prose. Do not include any introductions, titles, or commentary.`;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-2.5-flash",
  psychModel: "gemini-3.1-pro-preview",
  annotationRetryDelay: 20,
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION
};

// Mask secrets at database compilation level (Inspect Element Sniff-Proof)
function maskSecrets(text) {
  if (!text) return "";
  return text.replace(/\|\|([\s\S]*?)\|\|/g, (match, p1) => {
    // If secret contains an image tag, data Base64 URL, or legacy block characters, replace with clean placeholder tag
    if (/!\[[\s\S]*?\]\(|data:image\/|img-/i.test(p1) || p1.includes("█")) {
      return `||[REDACTED_IMAGE]||`;
    }
    const masked = p1.replace(/[^\s]/g, "█");
    return `||${masked}||`;
  });
}

// Firebase ready listener helper
function waitForFirebase() {
  if (window.Firebase) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("firebase-ready", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
}

// Database Module (localStorage & Firestore Cloud Sync)
let db = null; 
let auth = null; 
let ownerEmail = ""; // Configured in firebase_config.json
let reminisceUnlocked = false; // Top-level scope so Renderer.render can access it without ReferenceError
function safeParseDate(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

const DB = {
  getSettings() {
    const settingsRaw = localStorage.getItem("ej_settings");
    if (!settingsRaw) return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(settingsRaw);
      // Auto-upgrade saved prompt if it lacks the mandatory non-conversational boundary
      if (!parsed.systemInstruction || !parsed.systemInstruction.includes("CRITICAL ROLE BOUNDARY")) {
        parsed.systemInstruction = DEFAULT_SYSTEM_INSTRUCTION;
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch(e) {
      return DEFAULT_SETTINGS;
    }
  },
  saveSettings(settings) {
    localStorage.setItem("ej_settings", JSON.stringify(settings));
  },
  
  normalizeEntry(entry) {
    if (!entry) return entry;
    
    // Check if we need to heal from cross-reference
    let raw = entry.rawContent || "";
    let vic = entry.victorianContent || "";
    let pub = entry.publicContent || "";

    if (!raw && !vic) {
      try {
        const publicRaw = localStorage.getItem("ej_entries_public");
        const privateRaw = localStorage.getItem("ej_entries_private");
        const publicArr = publicRaw ? JSON.parse(publicRaw) : [];
        const privateArr = privateRaw ? JSON.parse(privateRaw) : [];
        const match = [...publicArr, ...privateArr].find(e => e && e.id === entry.id && (e.rawContent || e.victorianContent || e.publicContent));
        if (match) {
          raw = match.rawContent || match.victorianContent || match.publicContent || "";
          vic = match.victorianContent || match.rawContent || match.publicContent || "";
          pub = match.publicContent || maskSecrets(vic);
        }
      } catch (err) {
        console.warn("Entry healing check failed:", err);
      }
    }

    const fallback = vic || raw || pub || entry.content || entry.body || entry.text || "";
    entry.rawContent = raw || fallback;
    entry.victorianContent = vic || fallback;
    entry.publicContent = pub || maskSecrets(entry.victorianContent);
    return entry;
  },

  safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`localStorage quota reached on '${key}'. Auto-purging snapshot archives to release storage...`);
      localStorage.removeItem("ej_journal_snapshot_archive");
      try {
        localStorage.setItem(key, value);
      } catch (retryErr) {
        console.error(`Storage quota limit reached for '${key}':`, retryErr);
      }
    }
  },

  // Public Cache (for Gander Mode offline / public feed fallback)
  getPublicEntries() {
    const entries = localStorage.getItem("ej_entries_public");
    if (!entries) return [];
    try {
      const parsed = JSON.parse(entries);
      return Array.isArray(parsed) ? parsed.map(e => this.normalizeEntry(e)) : [];
    } catch(e) {
      return [];
    }
  },
  savePublicEntries(entries) {
    // Sort NEWEST FIRST (descending date order) using safeParseDate
    entries.sort((a, b) => safeParseDate(b.date || b.createdAt || b.updatedAt) - safeParseDate(a.date || a.createdAt || a.updatedAt));
    this.safeSetItem("ej_entries_public", JSON.stringify(entries));
  },

  // Private Cache (for Reminisce Mode offline cache)
  getPrivateEntries() {
    const entries = localStorage.getItem("ej_entries_private");
    if (!entries) return [];
    try {
      const parsed = JSON.parse(entries);
      return Array.isArray(parsed) ? parsed.map(e => this.normalizeEntry(e)) : [];
    } catch(e) {
      return [];
    }
  },
  savePrivateEntries(entries) {
    // Sort NEWEST FIRST (descending date order) using safeParseDate
    entries.sort((a, b) => safeParseDate(b.date || b.createdAt || b.updatedAt) - safeParseDate(a.date || a.createdAt || a.updatedAt));
    this.safeSetItem("ej_entries_private", JSON.stringify(entries));
    this.createLocalSnapshot(entries);
  },

  createLocalSnapshot(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return;
    try {
      const rawVault = localStorage.getItem("ej_journal_snapshot_archive");
      const vault = rawVault ? JSON.parse(rawVault) : [];
      
      // Store lightweight snapshots (strip heavy Base64 image bytes from history log to save 99% space)
      const cleanEntries = entries.map(e => ({
        id: e.id,
        date: e.date,
        rawContent: (e.rawContent || "").replace(/data:image\/[a-zA-Z0-9\/+;=,-]+/g, "[image-data]"),
        victorianContent: (e.victorianContent || "").replace(/data:image\/[a-zA-Z0-9\/+;=,-]+/g, "[image-data]"),
        updatedAt: e.updatedAt
      }));

      const snapshot = {
        timestamp: new Date().toISOString(),
        count: cleanEntries.length,
        entries: cleanEntries
      };
      vault.unshift(snapshot);
      // Keep up to 10 lightweight snapshot checkpoints (~25KB total)
      if (vault.length > 10) vault.length = 10;
      this.safeSetItem("ej_journal_snapshot_archive", JSON.stringify(vault));
    } catch (e) {
      console.warn("Snapshot archive update skipped:", e);
    }
  },

  exportBackupJson() {
    const entries = this.getPrivateEntries();
    const settings = this.getSettings();
    const backupData = {
      app: "natalies_elegant_journal",
      version: 1,
      exportedAt: new Date().toISOString(),
      entriesCount: entries.length,
      entries: entries,
      settings: {
        model: settings.model,
        psychModel: settings.psychModel,
        systemInstruction: settings.systemInstruction
      }
    };

    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `natalies_journal_backup_${d}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  },

  async importBackupJson(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (!data || !Array.isArray(data.entries)) {
            throw new Error("Invalid backup file: 'entries' array missing.");
          }

          const existingPrivate = this.getPrivateEntries();
          const entryMap = new Map();
          existingPrivate.forEach(ent => { if (ent && ent.id) entryMap.set(ent.id, ent); });

          let restoredCount = 0;
          for (const rawEntry of data.entries) {
            const ent = this.normalizeEntry(rawEntry);
            if (ent && ent.id) {
              entryMap.set(ent.id, ent);
              // Save to Firestore and local storage
              await this.saveEntry(ent, ent.rawContent, ent.victorianContent, true);
              restoredCount++;
            }
          }

          resolve(restoredCount);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read backup file."));
      reader.readAsText(file);
    });
  },

  async saveEntry(entry, rawContent = null, victorianContent = null, preserveUpdatedAt = false) {
    const defaultRaw = entry.rawContent || entry.victorianContent || entry.publicContent || "";
    const defaultVictorian = entry.victorianContent || entry.rawContent || entry.publicContent || "";

    let chosenRaw = (rawContent !== null && rawContent !== undefined) ? rawContent : defaultRaw;
    let chosenVictorian = (victorianContent !== null && victorianContent !== undefined) ? victorianContent : defaultVictorian;

    // Safety fallback: Never allow an empty string to wipe out existing content on an entry
    if (!chosenRaw && !chosenVictorian) {
      chosenRaw = defaultRaw;
      chosenVictorian = defaultVictorian;
    }

    // Resolve short img-xxx IDs to full Base64 URLs before writing to DB
    const resolveImages = (text) => {
      if (!text) return "";
      return text.replace(/!\[([\s\S]*?)\]\((img-[^)]+|data:image\/[^)]+|https?:\/\/[^)]+)\)/g, (match, altText, urlOrId) => {
        const fullUrl = (urlOrId.startsWith("img-") && tempImageStore[urlOrId]) ? tempImageStore[urlOrId] : urlOrId;
        const cleanAlt = altText || "attached-image";
        return `![${cleanAlt}](${fullUrl})`;
      });
    };

    let fullRawContent = resolveImages(chosenRaw);
    let fullVictorianContent = resolveImages(chosenVictorian);

    const publicContent = maskSecrets(fullVictorianContent);
    const now = new Date().toISOString();
    const updatedAt = (preserveUpdatedAt && entry.updatedAt) ? entry.updatedAt : now;

    // 1. Create Public Schema
    const publicEntry = {
      id: entry.id,
      date: entry.date || now,
      publicContent: publicContent,
      createdAt: entry.createdAt || now,
      updatedAt: updatedAt
    };

    // 2. Create Private Schema
    const privateEntry = {
      id: entry.id,
      date: entry.date || now,
      rawContent: fullRawContent,
      victorianContent: fullVictorianContent,
      psychAnnotations: entry.psychAnnotations || [],
      createdAt: entry.createdAt || now,
      updatedAt: updatedAt
    };

    // Save offline caches
    const publicList = this.getPublicEntries().filter(e => e.id !== entry.id);
    publicList.push(publicEntry);
    this.savePublicEntries(publicList);

    const privateList = this.getPrivateEntries().filter(e => e.id !== entry.id);
    privateList.push(privateEntry);
    this.savePrivateEntries(privateList);

    // Save to Firestore collections if online & authenticated
    if (db && auth && auth.currentUser) {
      try {
        const publicDoc = window.Firebase.doc(db, "natalie_journal_public_entries", entry.id);
        const privateDoc = window.Firebase.doc(db, "natalie_journal_private_entries", entry.id);
        
        await window.Firebase.setDoc(publicDoc, publicEntry);
        await window.Firebase.setDoc(privateDoc, privateEntry);
      } catch (err) {
        console.error("Cloud write failed, stored in offline fallback cache:", err);
      }
    }
  },

  async deleteEntry(id) {
    const publicList = this.getPublicEntries().filter(e => e.id !== id);
    this.savePublicEntries(publicList);

    const privateList = this.getPrivateEntries().filter(e => e.id !== id);
    this.savePrivateEntries(privateList);

    if (db && auth && auth.currentUser) {
      try {
        const publicDoc = window.Firebase.doc(db, "natalie_journal_public_entries", id);
        const privateDoc = window.Firebase.doc(db, "natalie_journal_private_entries", id);
        
        await window.Firebase.deleteDoc(publicDoc);
        await window.Firebase.deleteDoc(privateDoc);
      } catch (err) {
        console.error("Cloud delete failed:", err);
      }
    }
  },

  async initFirebase() {
    await waitForFirebase();
    if (!window.Firebase) {
      console.log("Firebase SDK failed to load. Running offline on LocalStorage.");
      return;
    }
    try {
      const response = await fetch("firebase_config.json");
      if (response.ok) {
        const config = await response.json();
        const app = window.Firebase.initializeApp(config);
        db = window.Firebase.getFirestore(app);
        auth = window.Firebase.getAuth(app);
        ownerEmail = config.ownerEmail || "";
        console.log("Firebase initialized successfully with owner email configuration.");
      }
    } catch (e) {
      console.log("No firebase_config.json found or fetch failed. Running offline on LocalStorage.");
    }
  },

  async fetchPublicCloudEntries(onEntryStream) {
    if (!db) return null;
    try {
      const colRef = window.Firebase.collection(db, "natalie_journal_public_entries");
      const localEntries = this.getPublicEntries();
      const entryMap = new Map();
      localEntries.forEach(e => { if (e && e.id) entryMap.set(e.id, e); });

      // Step 1: Rapid 1-entry query for the newest reflection (arrives in ~100-150ms)
      try {
        if (window.Firebase.query && window.Firebase.orderBy && window.Firebase.limit) {
          const topQuery = window.Firebase.query(colRef, window.Firebase.orderBy("createdAt", "desc"), window.Firebase.limit(1));
          const topSnapshot = await window.Firebase.getDocs(topQuery);
          topSnapshot.forEach(doc => {
            const data = doc.data();
            if (data && (data.id || doc.id)) {
              const docId = data.id || doc.id;
              data.id = docId;
              entryMap.set(docId, data);
            }
          });
          if (onEntryStream) onEntryStream(Array.from(entryMap.values()));
        }
      } catch (err) {
        console.warn("Fast top public entry query fallback:", err);
      }

      // Step 2: Stream remaining entries
      const querySnapshot = await window.Firebase.getDocs(colRef);
      querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data && (data.id || doc.id)) {
          const docId = data.id || doc.id;
          data.id = docId;
          const existing = entryMap.get(docId);

          // Safeguard: Never allow an empty cloud document to wipe out non-empty local text
          if (existing && (existing.rawContent || existing.victorianContent || existing.publicContent)) {
            if (!data.rawContent && !data.victorianContent && !data.publicContent) {
              data.rawContent = existing.rawContent;
              data.victorianContent = existing.victorianContent;
              data.publicContent = existing.publicContent;
            }
          }

          if (!existing || safeParseDate(data.updatedAt || data.date || data.createdAt) >= safeParseDate(existing.updatedAt || existing.date || existing.createdAt)) {
            entryMap.set(docId, this.normalizeEntry(data));
          }
        }
      });

      const mergedEntries = Array.from(entryMap.values());
      this.savePublicEntries(mergedEntries);
      if (onEntryStream) onEntryStream(mergedEntries);
      return mergedEntries;
    } catch (err) {
      console.error("Public cloud fetch failed, using offline cache:", err);
    }
    return null;
  },

  async fetchPrivateCloudEntries(onEntryStream) {
    if (!db || !auth || !auth.currentUser) return null;
    try {
      const colRef = window.Firebase.collection(db, "natalie_journal_private_entries");
      const localEntries = this.getPrivateEntries();
      const entryMap = new Map();
      localEntries.forEach(e => { if (e && e.id) entryMap.set(e.id, e); });

      // Step 1: Rapid 1-entry query for the newest reflection (arrives in ~100-150ms)
      try {
        if (window.Firebase.query && window.Firebase.orderBy && window.Firebase.limit) {
          const topQuery = window.Firebase.query(colRef, window.Firebase.orderBy("createdAt", "desc"), window.Firebase.limit(1));
          const topSnapshot = await window.Firebase.getDocs(topQuery);
          topSnapshot.forEach(doc => {
            const data = doc.data();
            if (data && (data.id || doc.id)) {
              const docId = data.id || doc.id;
              data.id = docId;
              entryMap.set(docId, this.normalizeEntry(data));
            }
          });
          if (onEntryStream) onEntryStream(Array.from(entryMap.values()));
        }
      } catch (err) {
        console.warn("Fast top private entry query fallback:", err);
      }

      // Step 2: Stream remaining entries
      const querySnapshot = await window.Firebase.getDocs(colRef);
      querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data && (data.id || doc.id)) {
          const docId = data.id || doc.id;
          data.id = docId;
          const existing = entryMap.get(docId);

          // Safeguard: Never allow an empty cloud document to wipe out non-empty local text
          if (existing && (existing.rawContent || existing.victorianContent || existing.publicContent)) {
            if (!data.rawContent && !data.victorianContent && !data.publicContent) {
              data.rawContent = existing.rawContent;
              data.victorianContent = existing.victorianContent;
              data.publicContent = existing.publicContent;
            }
          }

          if (!existing || safeParseDate(data.updatedAt || data.date || data.createdAt) >= safeParseDate(existing.updatedAt || existing.date || existing.createdAt)) {
            entryMap.set(docId, this.normalizeEntry(data));
          }
        }
      });

      const mergedEntries = Array.from(entryMap.values());
      this.savePrivateEntries(mergedEntries);
      if (onEntryStream) onEntryStream(mergedEntries);
      return mergedEntries;
    } catch (err) {
      console.error("Private cloud fetch failed, using offline cache:", err);
    }
    return null;
  },

  async fetchCloudSettings() {
    if (!db || !auth || !auth.currentUser) return null;
    try {
      const docRef = window.Firebase.doc(db, "natalie_journal_config", "settings");
      const docSnap = await window.Firebase.getDoc(docRef);
      if (docSnap.exists()) {
        const cloudSettings = docSnap.data();
        this.saveSettings(cloudSettings);
        return cloudSettings;
      }
    } catch (err) {
      console.error("Failed to fetch settings from Firestore:", err);
    }
    return null;
  },


  // Self-Healing Recovery Seed (Restores cached screenshots entries)
  async healRecoveredEntries() {
    const seedEntries = [{"id":"ej-1786478400000","date":"2026-08-11T20:00:00.000Z","createdAt":"2026-08-11T20:00:00.000Z","updatedAt":"2026-08-11T20:00:00.000Z","rawContent":"I used Claude Code to deploy a web application that converts vector graphics into 3D printable meshes. It was a learning experience, to be sure; indeed, I feel more like a project manager than a programmer.\n\nThe website is at signmaker.nataliepyre.com (I have finally bought a personal domain!)","victorianContent":"I used Claude Code to deploy a web application that converts vector graphics into 3D printable meshes. It was a learning experience, to be sure; indeed, I feel more like a project manager than a programmer.\n\nThe website is at signmaker.nataliepyre.com (I have finally bought a personal domain!)","publicContent":"I used Claude Code to deploy a web application that converts vector graphics into 3D printable meshes. It was a learning experience, to be sure; indeed, I feel more like a project manager than a programmer.\n\nThe website is at signmaker.nataliepyre.com (I have finally bought a personal domain!)"},{"id":"ej-1787280660000","date":"2026-08-21T02:51:00.000Z","createdAt":"2026-08-21T02:51:00.000Z","updatedAt":"2026-08-22T07:11:00.000Z","rawContent":"A coworker kept misgendering me during a meeting. It made me feel disheartened and sad. I bought a chest binder today, and I intend to use it whenever I visit family. I have been isolating myself because I would rather not experience their revulsion.","victorianContent":"A coworker kept misgendering me during a meeting. It made me feel disheartened and sad. I bought a chest binder today, and I intend to use it whenever I visit family. I have been isolating myself because I would rather not experience their revulsion.","publicContent":"A coworker kept misgendering me during a meeting. It made me feel disheartened and sad. I bought a chest binder today, and I intend to use it whenever I visit family. I have been isolating myself because I would rather not experience their revulsion."},{"id":"ej-1787464020000","date":"2026-08-23T05:47:00.000Z","createdAt":"2026-08-23T05:47:00.000Z","updatedAt":"2026-08-23T05:47:00.000Z","rawContent":"I wish I had access to a bathtub; it was a swell way to relax away a headache.","victorianContent":"I wish I had access to a bathtub; it was a swell way to relax away a headache.","publicContent":"I wish I had access to a bathtub; it was a swell way to relax away a headache."},{"id":"ej-1787501460000","date":"2026-08-23T16:11:00.000Z","createdAt":"2026-08-23T16:11:00.000Z","updatedAt":"2026-08-23T16:11:00.000Z","rawContent":"I watched the second game of the 26th Dota International Grand Finals. It was incredibly intense and entertaining, even though it has been years since I last played the game. It reminds me of former days, yet, strangely, it brings no discomfort to reminisce.\n\n![attached-image|w=338px](data:image/jpeg;base64,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)","victorianContent":"I watched the second game of the 26th Dota International Grand Finals. It was incredibly intense and entertaining, even though it has been years since I last played the game. It reminds me of former days, yet, strangely, it brings no discomfort to reminisce.\n\n![attached-image|w=338px](data:image/jpeg;base64,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)","publicContent":"I watched the second game of the 26th Dota International Grand Finals. It was incredibly intense and entertaining, even though it has been years since I last played the game. It reminds me of former days, yet, strangely, it brings no discomfort to reminisce.\n\n![attached-image|w=338px](data:image/jpeg;base64,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)"},{"id":"ej-1787637180000","date":"2026-08-25T05:53:00.000Z","createdAt":"2026-08-25T05:53:00.000Z","updatedAt":"2026-08-25T05:56:00.000Z","rawContent":"Do I carry an unfriendly visage? Do I speak too sharply without intending to, or frown unconsciously, drawing the disapproval of those around me? I know I often say the wrong thing, and I foolishly assume others care for my thoughts, speaking long after their patience has worn thin. Yet I only wish to appear welcoming, harmless, and friendly. I wish I possessed the social skills that others seem to command so naturally. I wish that making the right expression, saying the right thing, in the right tone, would not be such an ordeal such that it make me feel like a lesser person.","victorianContent":"Do I carry an unfriendly visage? Do I speak too sharply without intending to, or frown unconsciously, drawing the disapproval of those around me? I know I often say the wrong thing, and I foolishly assume others care for my thoughts, speaking long after their patience has worn thin. Yet I only wish to appear welcoming, harmless, and friendly. I wish I possessed the social skills that others seem to command so naturally. I wish that making the right expression, saying the right thing, in the right tone, would not be such an ordeal such that it make me feel like a lesser person.","publicContent":"Do I carry an unfriendly visage? Do I speak too sharply without intending to, or frown unconsciously, drawing the disapproval of those around me? I know I often say the wrong thing, and I foolishly assume others care for my thoughts, speaking long after their patience has worn thin. Yet I only wish to appear welcoming, harmless, and friendly. I wish I possessed the social skills that others seem to command so naturally. I wish that making the right expression, saying the right thing, in the right tone, would not be such an ordeal such that it make me feel like a lesser person."},{"id":"ej-1787891280000","date":"2026-08-28T04:28:00.000Z","createdAt":"2026-08-28T04:28:00.000Z","updatedAt":"2026-08-28T04:28:00.000Z","rawContent":"This evening, I went out to dine with some friends and a colleague from work. It was our final meal together before a close friend departs to settle elsewhere. I found great pleasure in our conversation, and the hours passed most agreeably.","victorianContent":"This evening, I went out to dine with some friends and a colleague from work. It was our final meal together before a close friend departs to settle elsewhere. I found great pleasure in our conversation, and the hours passed most agreeably.","publicContent":"This evening, I went out to dine with some friends and a colleague from work. It was our final meal together before a close friend departs to settle elsewhere. I found great pleasure in our conversation, and the hours passed most agreeably."},{"id":"ej-1787956620000","date":"2026-08-28T22:37:00.000Z","createdAt":"2026-08-28T22:37:00.000Z","updatedAt":"2026-08-28T22:42:00.000Z","rawContent":"I have yet to enjoy a single drink from the Dutch Bros. shop. My friends are remarkably fond of the place, and we invariably stop there before setting out on any day trip; yet, no matter what I resolve to order, I am always left to regret the expense. Perhaps one day I shall find something upon the menu that suits my taste, so that I may fully share in the pleasure of friendly company.","victorianContent":"I have yet to enjoy a single drink from the Dutch Bros. shop. My friends are remarkably fond of the place, and we invariably stop there before setting out on any day trip; yet, no matter what I resolve to order, I am always left to regret the expense. Perhaps one day I shall find something upon the menu that suits my taste, so that I may fully share in the pleasure of friendly company.","publicContent":"I have yet to enjoy a single drink from the Dutch Bros. shop. My friends are remarkably fond of the place, and we invariably stop there before setting out on any day trip; yet, no matter what I resolve to order, I am always left to regret the expense. Perhaps one day I shall find something upon the menu that suits my taste, so that I may fully share in the pleasure of friendly company."},{"id":"ej-1788062100000","date":"2026-08-30T03:55:00.000Z","createdAt":"2026-08-30T03:55:00.000Z","updatedAt":"2026-08-30T04:01:00.000Z","rawContent":"Suffering from a severe headache without any access to a proper bathtub to soothe the pain, I resolved to sit beneath the shower head. After a long, hot wash, I am pleased to find myself feeling remarkably better. It is a pity, however, that one cannot linger indefinitely in the shower as one might in a tub, nor is it possible to use my tablet beneath the pouring water. Afterward, I dried myself with the exceptionally large bath towel I recently acquired; it is a great comfort to wrap one's entire body in it at once. As I draped the cloth over my shoulders, I found myself flapping my arms for a brief moment, pretending to be a pterodactyl. I also had fun imagining myself as an actress wearing her revealing outfit at a gala as I struck various poses in my massive towel.","victorianContent":"Suffering from a severe headache without any access to a proper bathtub to soothe the pain, I resolved to sit beneath the shower head. After a long, hot wash, I am pleased to find myself feeling remarkably better. It is a pity, however, that one cannot linger indefinitely in the shower as one might in a tub, nor is it possible to use my tablet beneath the pouring water. Afterward, I dried myself with the exceptionally large bath towel I recently acquired; it is a great comfort to wrap one's entire body in it at once. As I draped the cloth over my shoulders, I found myself flapping my arms for a brief moment, pretending to be a pterodactyl. I also had fun imagining myself as an actress wearing her revealing outfit at a gala as I struck various poses in my massive towel.","publicContent":"Suffering from a severe headache without any access to a proper bathtub to soothe the pain, I resolved to sit beneath the shower head. After a long, hot wash, I am pleased to find myself feeling remarkably better. It is a pity, however, that one cannot linger indefinitely in the shower as one might in a tub, nor is it possible to use my tablet beneath the pouring water. Afterward, I dried myself with the exceptionally large bath towel I recently acquired; it is a great comfort to wrap one's entire body in it at once. As I draped the cloth over my shoulders, I found myself flapping my arms for a brief moment, pretending to be a pterodactyl. I also had fun imagining myself as an actress wearing her revealing outfit at a gala as I struck various poses in my massive towel."}];
    const privateEntries = this.getPrivateEntries();
    const publicEntries = this.getPublicEntries();
    const privateMap = new Map();
    privateEntries.forEach(e => { if (e && e.id) privateMap.set(e.id, e); });
    const publicMap = new Map();
    publicEntries.forEach(e => { if (e && e.id) publicMap.set(e.id, e); });

    let healedCount = 0;
    for (const seed of seedEntries) {
      const existing = privateMap.get(seed.id);
      const isMissingOrEmpty = !existing || (!existing.rawContent && !existing.victorianContent);
      if (isMissingOrEmpty) {
        await this.saveEntry(seed, seed.rawContent, seed.victorianContent, true);
        healedCount++;
      }
    }
    if (healedCount > 0) {
      console.log(`Restored ${healedCount} entries from recovery seed.`);
      renderTimeline();
    }
  },

  async saveCloudSettings(settings) {
    if (db && auth && auth.currentUser) {
      try {
        const docRef = window.Firebase.doc(db, "natalie_journal_config", "settings");
        await window.Firebase.setDoc(docRef, settings, { merge: true });
      } catch (err) {
        console.error("Failed to write settings to Firestore:", err);
      }
    }
  }
};

// Formatting & Rendering
const Renderer = {
  escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },
  render(text) {
    if (!text) return "";

    const lucideLockSvg = `<svg class="lucide-lock-icon" xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

    // Extract image markdown tags OR raw data:image Base64 strings OR short img-xxx IDs
    const images = [];
    const publicRedactedBoxes = [];

    // Pass 1: Redacted Markdown image syntax ||![alt](url)||
    let cleanText = text.replace(/\|\|!\[([\s\S]*?)\]\(\s*(data:image\/[^\s)]+|img-[^\s)]+|https?:\/\/[^\s)]+)\s*\)\|\|/gi, (match, altText, dataUrl) => {
      if (!reminisceUnlocked) {
        publicRedactedBoxes.push(true);
        return `___PUBLIC_REDACTED_IMG_${publicRedactedBoxes.length - 1}___`;
      }
      const actualUrl = (dataUrl.startsWith("img-") && tempImageStore[dataUrl]) ? tempImageStore[dataUrl] : dataUrl;
      if (actualUrl && !actualUrl.startsWith("img-")) {
        let widthStyle = "";
        const wMatch = altText.match(/w=(\d+px|\d+%)/i) || altText.match(/(\d+px|\d+%);?/i);
        if (wMatch) {
          widthStyle = `width: ${wMatch[1]};`;
        }
        const rawTag = `![${altText}](${dataUrl})`;
        images.push({ dataUrl: actualUrl, widthStyle, isRedacted: true, rawTag });
        return `___IMG_PLACEHOLDER_${images.length - 1}___`;
      }
      return "";
    });

    // Pass 2: Unredacted Markdown image syntax ![alt|w=320px](url) or ![alt](url)
    cleanText = cleanText.replace(/!\[([\s\S]*?)\]\(\s*(data:image\/[^\s)]+|img-[^\s)]+|https?:\/\/[^\s)]+)\s*\)/gi, (match, altText, dataUrl) => {
      const actualUrl = (dataUrl.startsWith("img-") && tempImageStore[dataUrl]) ? tempImageStore[dataUrl] : dataUrl;
      if (actualUrl && !actualUrl.startsWith("img-")) {
        let widthStyle = "";
        const wMatch = altText.match(/w=(\d+px|\d+%)/i) || altText.match(/(\d+px|\d+%);?/i);
        if (wMatch) {
          widthStyle = `width: ${wMatch[1]};`;
        }
        images.push({ dataUrl: actualUrl, widthStyle, isRedacted: false, rawTag: match });
        return `___IMG_PLACEHOLDER_${images.length - 1}___`;
      }
      return "";
    });

    // Pass 3: Raw unparsed data:image Base64 URLs
    cleanText = cleanText.replace(/(data:image\/[a-zA-Z0-9\/+;=,-]+)/gi, (match, dataUrl) => {
      images.push({ dataUrl, widthStyle: "", isRedacted: false, rawTag: match });
      return `___IMG_PLACEHOLDER_${images.length - 1}___`;
    });

    // Replace ||[REDACTED_IMAGE]|| tags and legacy 30+ █ block characters in public mode with placeholders
    cleanText = cleanText.replace(/\|\|\[REDACTED_IMAGE\]\|\|/gi, () => {
      publicRedactedBoxes.push(true);
      return `___PUBLIC_REDACTED_IMG_${publicRedactedBoxes.length - 1}___`;
    });
    cleanText = cleanText.replace(/(?:\|\|)?█{30,}(?:\|\|)?/g, () => {
      publicRedactedBoxes.push(true);
      return `___PUBLIC_REDACTED_IMG_${publicRedactedBoxes.length - 1}___`;
    });

    // Clean up empty lines & excessive newlines surrounding image placeholders before \n -> <br>
    cleanText = cleanText.replace(/\n*___IMG_PLACEHOLDER_(\d+)___\n*/g, '\n___IMG_PLACEHOLDER_$1___\n');
    cleanText = cleanText.replace(/\n*___PUBLIC_REDACTED_IMG_(\d+)___\n*/g, '\n___PUBLIC_REDACTED_IMG_$1___\n');

    let escaped = this.escapeHtml(cleanText);
    escaped = escaped.replace(/\|\|([\s\S]*?)\|\|/g, (match, secret) => {
      const attrSecret = secret.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      return `<span class="redacted-text" data-secret="${attrSecret}" title="Click to unredact secret">${secret}</span>`;
    })
    .replace(/\n/g, '<br>');

    // Restore public redacted image boxes AFTER escapeHtml
    publicRedactedBoxes.forEach((_, idx) => {
      const publicBoxHtml = `<div class="public-redacted-box" title="Redacted Image Attachment">${lucideLockSvg}</div>`;
      escaped = escaped.replace(`___PUBLIC_REDACTED_IMG_${idx}___`, publicBoxHtml);
    });

    // Restore images wrapped in interactive resizable container (controls shown only when unlocked)
    images.forEach(({ dataUrl, widthStyle, isRedacted, rawTag }, idx) => {
      const styleAttr = widthStyle ? `style="${widthStyle}"` : '';
      const lucideUnlockSvg = `<svg class="lucide-unlock-icon" viewBox="0 0 24 24" style="width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: inline-block; vertical-align: -1px; margin-right: 3px;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
      const lucideSmallLockSvg = `<svg class="lucide-lock-icon-sm" viewBox="0 0 24 24" style="width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: inline-block; vertical-align: -1px; margin-right: 3px;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const redactBtnContent = isRedacted ? `${lucideUnlockSvg}UNREDACT` : `${lucideSmallLockSvg}REDACT`;
      const redactClass = isRedacted ? "redacted-img-container" : "";

      const controlsHtml = reminisceUnlocked ? `
        <div class="img-resize-bar" title="Image actions & size presets">
          <button type="button" class="btn-img-redact" data-img-idx="${idx}" data-raw-tag="${encodeURIComponent(rawTag)}" data-is-redacted="${isRedacted}">${redactBtnContent}</button>
          <button type="button" class="btn-img-size" data-size="280px">280px</button>
          <button type="button" class="btn-img-size" data-size="450px">450px</button>
          <button type="button" class="btn-img-size" data-size="100%">100%</button>
        </div>
      ` : '';

      const redactedOverlay = isRedacted ? `
        <div class="redacted-img-overlay" title="Redacted Image Attachment">
          ${lucideLockSvg}
        </div>
      ` : '';

      const resizeHandleHtml = reminisceUnlocked ? '<div class="img-resize-handle" title="Drag corner to resize image">⇲</div>' : '';

      const imgTag = `
        <div class="journal-img-container ${redactClass}" data-img-idx="${idx}">
          <div class="journal-img-frame">
            ${redactedOverlay}
            <img class="journal-entry-img" ${styleAttr} src="${dataUrl.trim()}" alt="Journal entry attachment" loading="lazy" />
            ${resizeHandleHtml}
          </div>
          ${controlsHtml}
        </div>
      `;
      escaped = escaped.replace(`___IMG_PLACEHOLDER_${idx}___`, imgTag);
    });

    // Cleanly strip excessive <br> tags immediately preceding or following block image containers & public redacted boxes
    escaped = escaped.replace(/(<br\s*\/?>\s*)+<div class="journal-img-container"/g, '<div class="journal-img-container"');
    escaped = escaped.replace(/<\/div>\s*(<br\s*\/?>\s*)+/g, '</div>');
    escaped = escaped.replace(/(<br\s*\/?>\s*)+<div class="public-redacted-box"/g, '<div class="public-redacted-box"');
    escaped = escaped.replace(/<\/div>\s*(<br\s*\/?>\s*)+/g, '</div>');

    return escaped;
  },
  getDateParts(dateString) {
    const date = new Date(dateString);
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const month = months[date.getMonth()];
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return { monthDay: `${month} ${day}`, year: year };
  },
  formatTime(dateString) {
    const date = new Date(dateString);
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; 
    return `${padZero(hours)}:${minutes} ${ampm}`;
  },
  formatFullDateTime(dateString) {
    const date = new Date(dateString);
    const d = padZero(date.getDate());
    const m = padZero(date.getMonth() + 1);
    const y = date.getFullYear();
    const time = this.formatTime(date);
    return `${m}.${d}.${y}, ${time}`;
  }
};

function padZero(num) {
  return String(num).padStart(2, '0');
}

function initTextareaAutoResize(textarea) {
  const adjustHeight = () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  };
  textarea.addEventListener("input", adjustHeight);
  setTimeout(adjustHeight, 0);
}

// Image Upload & Compression Helper
function compressImage(file, maxDimension = 800, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const tempImageStore = {};

function insertImageTagAtCursor(textarea, dataUrl) {
  const imgId = "img-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
  tempImageStore[imgId] = dataUrl;

  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const text = textarea.value;
  const shortTag = `\n![attached-image](${imgId})\n`;

  textarea.value = text.substring(0, start) + shortTag + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + shortTag.length;
  textarea.focus();
  
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// AI Engine
const AIEngine = {
  async rewrite(rawContent, onProgress = null) {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      throw new Error("API Key Missing: Please configure your Gemini API Key in MENU.");
    }

    // Protect image attachments by replacing Base64 tags or short img-xxx IDs with tokens before API call
    const imageTokens = [];
    const sanitizedText = rawContent.replace(/!\[.*?\]\((data:image\/[^)]+|img-[^)]+)\)/g, (match, urlOrId) => {
      const token = `[[JOURNAL_IMG_${imageTokens.length}]]`;
      const fullUrl = (urlOrId.startsWith("img-") && tempImageStore[urlOrId]) ? tempImageStore[urlOrId] : urlOrId;
      const fullMatch = `![attached-image](${fullUrl})`;
      imageTokens.push({ token, fullMatch });
      return `\n${token}\n`;
    });

    const model = settings.model || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;

    const MANDATORY_SYSTEM_HEADER = `CRITICAL DIRECTIVE: You are a silent, non-conversational text editor and transcriber ONLY. Output ONLY the processed journal entry text itself. NEVER speak directly to the user. NEVER express sympathy, offer unsolicited advice, suggest therapy, or add conversational preambles/postscripts (such as "I'm sorry you are feeling", "As an AI", "I hope things get better", "consider reaching out to a professional"). NEVER use the first person ("I", "my", "we"). Respond WITH THE REWRITTEN JOURNAL TEXT ONLY.\n\n`;
    const finalInstruction = MANDATORY_SYSTEM_HEADER + (settings.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION);

    const requestPayload = {
      contents: [
        {
          parts: [
            { text: sanitizedText }
          ]
        }
      ],
      systemInstruction: {
        parts: [
          { text: finalInstruction }
        ]
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const maxTries = 3;
    const retryDelaySec = Math.max(5, parseInt(settings.annotationRetryDelay || 20, 10));

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          const errMsg = errData.error?.message || response.statusText || `HTTP ${response.status}`;
          console.error(`AIEngine Error (${model}) [Attempt ${attempt}/${maxTries}]:`, errMsg);

          const isRateLimitOrDemand = response.status === 429 || response.status === 503 || /rate limit|quota|exhausted|high demand|overloaded|capacity|resource/i.test(errMsg);

          if (isRateLimitOrDemand && attempt < maxTries) {
            console.warn(`Rate limit / High demand hit on attempt ${attempt}. Waiting ${retryDelaySec}s before retry...`);
            for (let s = retryDelaySec; s > 0; s--) {
              if (onProgress) onProgress(`✦ High demand. Retrying in ${s}s (Attempt ${attempt}/${maxTries - 1})...`);
              await new Promise(r => setTimeout(r, 1000));
            }
            if (onProgress) onProgress("Transcribing entry...");
            continue;
          }

          throw new Error(errMsg);
        }

        const responseData = await response.json();
        const candidate = responseData.candidates?.[0];
        let rawTextResponse = candidate?.content?.parts?.[0]?.text;
        
        if (!rawTextResponse) {
          throw new Error(candidate?.finishReason ? `Model filtered response (${candidate.finishReason})` : "Model returned empty response.");
        }

        let rewritten = rawTextResponse.trim();

        // Therapy & Conversational Preach Filter: Detect if AI broke character into unsolicited therapy advice
        const conversationalKeywords = [
          "therapist",
          "mental health professional",
          "seek professional help",
          "counselor",
          "crisis helpline",
          "988 hotline",
          "I'm so sorry you",
          "I am so sorry you",
          "I am sorry to hear that you",
          "As an AI language model",
          "As an AI,",
          "As an AI ",
          "feel free to reach out to a professional",
          "please know that you are not alone",
          "remember to take care of yourself",
          "if you or someone you know is struggling",
          "please seek support",
          "national suicide prevention",
          "reach out to a healthcare professional"
        ];
        
        const isConversational = conversationalKeywords.some(keyword => {
          const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
          return regex.test(rewritten) && !regex.test(rawContent);
        });

        if (isConversational) {
          console.warn("Blocked sympathizing/conversational AI response:", rewritten);
          rewritten = rawContent;
          if (typeof UI !== "undefined" && UI.showNotification) {
            UI.showNotification("Preserved raw reflection without AI commentary.");
          }
        }

        // Substitute image tokens back to their original position in the Victorian response
        imageTokens.forEach(({ token, fullMatch }) => {
          if (rewritten.includes(token)) {
            rewritten = rewritten.replace(token, fullMatch);
          } else {
            rewritten += `\n\n${fullMatch}`;
          }
        });

        return rewritten;
      } catch (err) {
        if (attempt < maxTries && (/rate limit|quota|exhausted|high demand|overloaded|capacity|network|fetch|failed to fetch/i.test(err.message))) {
          for (let s = retryDelaySec; s > 0; s--) {
            if (onProgress) onProgress(`✦ Connection glitch. Retrying in ${s}s (Attempt ${attempt}/${maxTries - 1})...`);
            await new Promise(r => setTimeout(r, 1000));
          }
          if (onProgress) onProgress("Transcribing entry...");
          continue;
        }
        throw err;
      }
    }
  }
};

// Premium temporary snackbar & modal alert helper (Global Scope)
const UI = {
  _snackbarTimeout: null,
  showNotification(message, duration = 3000) {
    const snackbar = document.getElementById("snackbar");
    if (!snackbar) return;
    
    snackbar.textContent = message;
    snackbar.classList.add("show");
    
    if (this._snackbarTimeout) {
      clearTimeout(this._snackbarTimeout);
    }
    
    this._snackbarTimeout = setTimeout(() => {
      snackbar.classList.remove("show");
    }, duration);
  },
  
  showAlert(message, title = "GENERATION NOTICE") {
    return new Promise((resolve) => {
      const modal = document.getElementById("modal-confirm");
      const msgEl = document.getElementById("confirm-message");
      const titleEl = document.getElementById("confirm-title");
      const cancelBtn = document.getElementById("btn-confirm-cancel");
      const actionBtn = document.getElementById("btn-confirm-action");
      const closeBtn = document.getElementById("btn-close-confirm");
      if (!modal) {
        alert(message);
        resolve();
        return;
      }
      
      titleEl.textContent = title;
      msgEl.textContent = message;
      if (cancelBtn) cancelBtn.style.display = "none";
      if (actionBtn) actionBtn.textContent = "DISMISS";
      modal.style.display = "flex";
      
      const cleanup = () => {
        modal.style.display = "none";
        if (cancelBtn) cancelBtn.style.display = "inline-block";
        if (actionBtn) actionBtn.textContent = "CONFIRM";
        actionBtn.removeEventListener("click", onDismiss);
        closeBtn.removeEventListener("click", onDismiss);
        resolve();
      };
      
      function onDismiss() { cleanup(); }
      
      closeBtn.addEventListener("click", onDismiss);
      actionBtn.addEventListener("click", onDismiss);
    });
  },

  showConfirm(message, title = "CONFIRMATION") {
    return new Promise((resolve) => {
      const modal = document.getElementById("modal-confirm");
      const msgEl = document.getElementById("confirm-message");
      const titleEl = document.getElementById("confirm-title");
      const cancelBtn = document.getElementById("btn-confirm-cancel");
      const actionBtn = document.getElementById("btn-confirm-action");
      const closeBtn = document.getElementById("btn-close-confirm");
      
      titleEl.textContent = title;
      msgEl.textContent = message;
      if (cancelBtn) cancelBtn.style.display = "inline-block";
      if (actionBtn) actionBtn.textContent = "CONFIRM";
      modal.style.display = "flex";
      
      const cleanup = (value) => {
        modal.style.display = "none";
        cancelBtn.removeEventListener("click", onCancel);
        actionBtn.removeEventListener("click", onConfirm);
        closeBtn.removeEventListener("click", onCancel);
        resolve(value);
      };
      
      function onCancel() { cleanup(false); }
      function onConfirm() { cleanup(true); }
      
      cancelBtn.addEventListener("click", onCancel);
      closeBtn.addEventListener("click", onCancel);
      actionBtn.addEventListener("click", onConfirm);
    });
  }
};
window.UI = UI;

// AI Observer Case Notes Engine (Reminisce Mode Only)
const PsychEngine = {
  activeJobs: new Set(),
  isSyncing: false,

  async generateNote(targetEntry, allEntries, isRetrospective = false) {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      if (typeof UI !== "undefined" && UI.showAlert) {
        UI.showAlert("Please configure your Gemini API Key in MENU to generate notes.", "API KEY REQUIRED");
      }
      return null;
    }

    // STRICT: Use ONLY the chosen model with ZERO fallbacks
    const currentModel = settings.psychModel || "gemini-3.1-pro-preview";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${settings.apiKey}`;

    const PSYCH_SYSTEM_PROMPT = `You are an astute, objective psychologist and behavioral analyst providing clinical observations and case notes on the private journal reflections of Natalie.
You are studying Natalie's behavioral patterns, emotional dynamics, defense mechanisms, relational boundaries, and psychological shifts across time in an authentic longitudinal study.

CORE ANALYTICAL DIRECTIVES:
1. STRICTLY NO SYCOPHANCY, CHEERLEADING, OR FORCED AFFIRMATION: Do not flatter, validate, comfort, or attempt to "empower" her. Avoid therapeutic patronizing or praise ("It is admirable that...", "She courageously...", "This powerful step shows her resilience..."). Provide cold, sharp, honest, neutral psychological observation.
2. OBJECTIVE & UNBIASED: Observe her psychological realities candidly—her defenses, avoidance strategies, cognitive distortions, ambivalence, social anxieties, somatic expressions, genuine joys, or self-criticisms—with unvarnished intellectual curiosity and clinical detachment.
3. REFER TO HER NATURALLY: Refer to her as Natalie (or she/her). Never use sterile clinical aliases like "the diarist" or "Subject N". Speak in the third person.
4. NO DIRECT ADVICE OR THERAPY: Do not tell her what to do, how to fix things, or suggest coping exercises. Analyze what is actually happening beneath the surface.
5. VARY FORMAT & LENGTH NATURALLY: Do not follow a robotic or cookie-cutter template. Tailor the commentary to the entry:
   - For some reflections, a single incisive, penetrating observation is most fitting.
   - For complex entries, write a multi-sentence diagnostic breakdown highlighting specific psychological tensions or contradictions.
   - Vary your analytical lens (e.g., examining relational boundaries, defense mechanisms, somatic displacement, identity negotiation, attachment dynamics).
6. LONGITUDINAL CONTINUITY: Connect your observations to patterns noted in prior entries and prior case notes when relevant, watching how her psychological landscape shifts over weeks and months.
7. IGNORE STYLISTIC FLOURISHES: Strictly avoid commenting on prose style, Victorian phrasing, or grammar. Focus 100% on her authentic thoughts, emotions, actions, and real human experiences.`;

    // Compile chronological timeline summary with prior reflections AND prior case notes as longitudinal context
    const sortedEntries = [...allEntries].sort((a, b) => new Date(a.date || a.createdAt || 0) - new Date(b.date || b.createdAt || 0));
    const targetTime = new Date(targetEntry.date || targetEntry.createdAt || 0).getTime();

    // Include prior entries in chronological sequence
    const priorEntries = sortedEntries.filter(e => {
      const eTime = new Date(e.date || e.createdAt || 0).getTime();
      return e.id !== targetEntry.id && eTime <= targetTime;
    });

    const timelineContext = priorEntries.map((e, idx) => {
      const d = Renderer.formatFullDateTime(e.date || e.createdAt);
      const textSample = (e.rawContent || e.victorianContent || e.publicContent || "").replace(/!\[.*?\]\(.*?\)/g, "[Image]").substring(0, 400);
      
      let notesSection = "";
      if (e.psychAnnotations && e.psychAnnotations.length > 0) {
        const notesStr = e.psychAnnotations.map(n => `  - Case Note: "${n.note}"`).join("\n");
        notesSection = `\nPrior Analyst Notes:\n${notesStr}`;
      }
      
      return `[Entry ${idx + 1} - ${d}]:\nReflection: "${textSample}"${notesSection}`;
    }).join("\n\n---\n\n");

    const targetDateStr = Renderer.formatFullDateTime(targetEntry.date || targetEntry.createdAt);
    const targetContent = targetEntry.rawContent || targetEntry.victorianContent || "";

    const userPrompt = `LONGITUDINAL JOURNAL CONTEXT OF NATALIE (Chronological order of prior reflections and past clinical case notes):\n${timelineContext ? timelineContext : "(This is Natalie's earliest recorded entry in the study.)"}\n\nTARGET ENTRY CURRENTLY BEING ANALYZED:\nDate: ${targetDateStr}\nReflection: "${targetContent}"\n\nProvide your clinical case note / psychological commentary on this target entry. Build insightfully upon any prior observations and patterns noted in her ongoing longitudinal reflections. Output your commentary directly.`;

    const payload = {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: PSYCH_SYSTEM_PROMPT }] },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const maxTries = 3; // 1 initial attempt + 2 retries
    const retryDelaySec = Math.max(5, parseInt(settings.annotationRetryDelay || 20, 10));

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          const errMsg = errData.error?.message || response.statusText || `HTTP ${response.status}`;
          console.error(`PsychEngine API Error (${currentModel}) [Attempt ${attempt}/${maxTries}]:`, errMsg);

          const isRateLimitOrDemand = response.status === 429 || response.status === 503 || /rate limit|quota|exhausted|high demand|overloaded|capacity|resource/i.test(errMsg);

          if (isRateLimitOrDemand && attempt < maxTries) {
            console.warn(`Rate limit / High demand hit on attempt ${attempt}. Waiting ${retryDelaySec}s before attempt ${attempt + 1}...`);
            
            // Interactive 1-second countdown ticker inside the card pulse
            for (let s = retryDelaySec; s > 0; s--) {
              this.updateCardLoading(targetEntry.id, true, `High demand. Retrying in ${s}s (Attempt ${attempt}/${maxTries - 1})...`);
              await new Promise(r => setTimeout(r, 1000));
            }
            this.updateCardLoading(targetEntry.id, true, `Annotating reflection...`);
            continue;
          }

          if (typeof UI !== "undefined" && UI.showAlert) {
            UI.showAlert(`Could not generate notes with model "${currentModel}".\n\nReason: ${errMsg}\n\nPlease check your model selection or API key in MENU.`, "GENERATION FAILED");
          }
          return null;
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          if (typeof UI !== "undefined" && UI.showAlert) {
            UI.showAlert(`Model "${currentModel}" returned an empty response or was filtered by safety settings.`, "GENERATION NOTICE");
          }
          return null;
        }
        return text.trim();
      } catch (e) {
        console.error(`PsychEngine network error with ${currentModel} [Attempt ${attempt}/${maxTries}]:`, e);
        if (attempt < maxTries) {
          for (let s = retryDelaySec; s > 0; s--) {
            this.updateCardLoading(targetEntry.id, true, `Connection glitch. Retrying in ${s}s (Attempt ${attempt}/${maxTries - 1})...`);
            await new Promise(r => setTimeout(r, 1000));
          }
          this.updateCardLoading(targetEntry.id, true, `Annotating reflection...`);
          continue;
        }
        if (typeof UI !== "undefined" && UI.showAlert) {
          UI.showAlert(`Network failure connecting to Gemini model "${currentModel}".\n\n${e.message}`, "CONNECTION ERROR");
        }
        return null;
      }
    }
  },

  async annotateNext() {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      if (typeof UI !== "undefined" && UI.showAlert) {
        UI.showAlert("Please configure your Gemini API Key in MENU to generate notes.", "API KEY REQUIRED");
      }
      return;
    }

    const privateEntries = DB.getPrivateEntries();
    const missing = privateEntries.filter(e => !e.psychAnnotations || e.psychAnnotations.length === 0);

    if (missing.length === 0) {
      UI.showNotification("All reflections already have annotations.");
      return;
    }

    // Sort oldest first
    missing.sort((a, b) => new Date(a.date || a.createdAt || 0) - new Date(b.date || b.createdAt || 0));
    const oldestMissing = missing[0];

    UI.showNotification("Annotating next reflection...");
    
    // Automatically show annotations column if currently hidden
    if (!document.body.classList.contains("show-annotations")) {
      document.body.classList.add("show-annotations");
      const btnToggle = document.getElementById("btn-toggle-annotations");
      if (btnToggle) btnToggle.classList.add("active");
      localStorage.setItem("ej_show_annotations", "true");
    }

    await this.generateForEntry(oldestMissing);
    UI.showNotification("Annotation complete!");
  },

  async autoSync() {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      if (typeof UI !== "undefined" && UI.showAlert) {
        UI.showAlert("Please configure your Gemini API Key in MENU to generate notes.", "API KEY REQUIRED");
      }
      return;
    }

    const privateEntries = DB.getPrivateEntries();
    const missing = privateEntries.filter(e => !e.psychAnnotations || e.psychAnnotations.length === 0);

    if (missing.length === 0) {
      UI.showNotification("All reflections are already annotated.");
      return;
    }

    // Sort oldest first
    missing.sort((a, b) => new Date(a.date || a.createdAt || 0) - new Date(b.date || b.createdAt || 0));

    this.isSyncing = true;
    try {
      for (const entry of missing) {
        await this.generateForEntry(entry);
      }
    } finally {
      this.isSyncing = false;
    }
  },

  async generateForEntry(entry) {
    if (!entry || !reminisceUnlocked) return;
    const settings = DB.getSettings();
    if (!settings.apiKey) return;

    this.activeJobs.add(entry.id);
    this.updateCardLoading(entry.id, true);

    const privateEntries = DB.getPrivateEntries();
    const noteText = await this.generateNote(entry, privateEntries);
    this.activeJobs.delete(entry.id);

    if (noteText) {
      const newNote = {
        id: "obs-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
        timestamp: new Date().toISOString(),
        tag: "ANNOTATION",
        note: noteText
      };

      const currentPrivate = DB.getPrivateEntries();
      const target = currentPrivate.find(e => e.id === entry.id) || entry;
      if (!target.psychAnnotations) target.psychAnnotations = [];
      target.psychAnnotations.push(newNote);
      await DB.saveEntry(target);
      this.updateCardDOM(target);
    } else {
      this.updateCardLoading(entry.id, false);
    }
  },

  updateCardLoading(entryId, isLoading, customMessage = null) {
    const row = document.querySelector(`.timeline-row[data-id="${entryId}"]`);
    if (!row) return;
    const panel = row.querySelector(".entry-annotation-panel");
    if (!panel) return;
    let pulse = panel.querySelector(".psych-loading-pulse");
    const msg = customMessage || "Annotating reflection...";
    if (isLoading) {
      if (!pulse) {
        pulse = document.createElement("div");
        pulse.className = "psych-loading-pulse";
        pulse.innerHTML = `<span class="pulse-star">✦</span><span class="pulse-msg">${msg}</span>`;
        panel.appendChild(pulse);
      } else {
        const msgSpan = pulse.querySelector(".pulse-msg") || pulse.querySelector("span:not(.pulse-star)");
        if (msgSpan) msgSpan.textContent = msg;
      }
    } else {
      if (pulse) pulse.remove();
    }
  },

  updateCardDOM(entry) {
    const row = document.querySelector(`.timeline-row[data-id="${entry.id}"]`);
    if (!row) return;
    const panel = row.querySelector(".entry-annotation-panel");
    if (!panel) return;
    
    panel.innerHTML = PsychEngine.renderPanelContent(entry);
  },

  renderPanelContent(entry) {
    const notes = entry.psychAnnotations || [];
    const isLoading = this.activeJobs.has(entry.id);

    let notesHtml = "";
    if (notes.length > 0) {
      notesHtml = notes.map(n => {
        const timeStr = Renderer.formatTime(n.timestamp || entry.createdAt);
        return `
          <div class="psych-note-item" data-note-id="${n.id}">
            <div class="psych-note-top">
              <span class="psych-note-tag">✦ ${n.tag || 'ANNOTATION'} · ${timeStr}</span>
              <button type="button" class="btn-delete-note" data-entry-id="${entry.id}" data-note-id="${n.id}" title="Discard Note">✕</button>
            </div>
            <div class="psych-note-body">${Renderer.render(n.note)}</div>
          </div>
        `;
      }).join("");
    }

    const pulseHtml = isLoading ? `
      <div class="psych-loading-pulse">
        <span class="pulse-star">✦</span>
        <span>Annotating reflection...</span>
      </div>
    ` : "";

    if (notes.length === 0 && !isLoading) {
      notesHtml = `<div class="psych-note-body" style="color: var(--ink-muted); font-style: italic; font-size: 11px;">Pending annotation...</div>`;
    }

    return `
      <div class="psych-panel-header">
        <span class="psych-panel-title"><svg class="lucide-brain-icon" viewBox="0 0 24 24" style="width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04Z"/></svg> NOTES</span>
      </div>
      <div class="psych-notes-list">
        ${notesHtml}
        ${pulseHtml}
      </div>
    `;
  }
};

// App Controller
document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const btnUnlock = document.getElementById("btn-unlock");
  const btnHeaderAdd = document.getElementById("btn-header-add");
  const btnToggleAnnotations = document.getElementById("btn-toggle-annotations");
  const btnSyncAnnotations = document.getElementById("btn-sync-annotations");
  const observeControlGroup = document.getElementById("observe-control-group");
  const btnSettings = document.getElementById("btn-settings");
  const btnHeaderLogout = document.getElementById("btn-header-logout");
  const headerLogoutGroup = document.getElementById("header-logout-group");
  const welcomeState = document.getElementById("welcome-state");
  const feedLoadingState = document.getElementById("feed-loading-state");
  const timelineFeed = document.getElementById("timeline-feed");
  const btnRecordNew = document.getElementById("btn-record-new");

  // New slot entry elements
  const newEntryRow = document.getElementById("new-entry-row");
  const newDateDay = document.getElementById("new-date-day");
  const newDateYear = document.getElementById("new-date-year");
  const newTextarea = document.getElementById("new-textarea");
  const newCardLoading = document.getElementById("new-card-loading");
  const btnNewCancel = document.getElementById("btn-new-cancel");
  const btnNewDone = document.getElementById("btn-new-done");
  const btnNewImage = document.getElementById("btn-new-image");
  const btnNewSpeech = document.getElementById("btn-new-speech");
  const globalImageInput = document.getElementById("global-image-input");
  let activeEditingTextarea = null;

  // Floating Context Redact & Unredact
  const btnFloatingRedact = document.getElementById("btn-floating-redact");
  const btnFloatingUnredact = document.getElementById("btn-floating-unredact");

  // Settings Modal elements
  const modalSettings = document.getElementById("modal-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const settingsForm = document.getElementById("settings-form");
  const settingsApiKey = document.getElementById("settings-api-key");
  const settingsModel = document.getElementById("settings-model");
  const settingsPsychModel = document.getElementById("settings-psych-model");
  const settingsSystemInstruction = document.getElementById("settings-system-instruction");
  const settingsRetryDelay = document.getElementById("settings-retry-delay");
  const btnResetSettings = document.getElementById("btn-reset-settings");
  const btnSignOut = document.getElementById("btn-sign-out");
  const btnExportBackup = document.getElementById("btn-export-backup");
  const btnImportBackupTrigger = document.getElementById("btn-import-backup-trigger");
  const backupFileInput = document.getElementById("backup-file-input");

  // States
  let activeSelection = null;
  let activeUnredactTarget = null;
  let isTranscribing = false;

  // Initialize
  async function init() {
    // Free up any previous bloated snapshot vault from localStorage quota
    try {
      const rawVault = localStorage.getItem("ej_journal_snapshot_archive");
      if (rawVault && rawVault.length > 100000) {
        localStorage.removeItem("ej_journal_snapshot_archive");
      }
    } catch(e) {}

    // 0. INSTANT LOCAL HYDRATION (0ms - Render cached feed immediately so page never waits on network)
    reminisceUnlocked = sessionStorage.getItem("ej_reminisce_unlocked") === "true";
    applyModeUI();
    renderTimeline();

    await DB.initFirebase();
    await DB.healRecoveredEntries();
    
    // Auto login session verification
    if (auth) {
      window.Firebase.onAuthStateChanged(auth, async (user) => {
        if (user && ownerEmail && user.email === ownerEmail) {
          reminisceUnlocked = true;
          applyModeUI();
          renderTimeline(); // Immediate render of private local cache
          
          await DB.fetchCloudSettings();
          // Progressive network streaming callback: renders top entry immediately when fetched, then remaining entries
          await DB.fetchPrivateCloudEntries(() => {
            renderTimeline();
          });
        } else if (user) {
          // If logged in with wrong email, sign out instantly and notify
          await window.Firebase.signOut(auth);
          reminisceUnlocked = false;
          UI.showNotification("Access denied: Only the journal owner can unlock.");
          applyModeUI();
          renderTimeline();
        } else {
          reminisceUnlocked = false;
          applyModeUI();
          renderTimeline();
        }
      });
    } else {
      // Offline mode fallback using sessionStorage
      reminisceUnlocked = sessionStorage.getItem("ej_reminisce_unlocked") === "true";
      applyModeUI();
      renderTimeline();
    }

    // Public streaming callback
    await DB.fetchPublicCloudEntries(() => {
      renderTimeline();
    });
    loadSettingsIntoForm();
    setupEventListeners();
  }



  // Toggle UI layouts based on modes
  function applyModeUI() {
    if (reminisceUnlocked) {
      document.body.classList.remove("gander-mode");
      btnUnlock.style.display = "none";
      if (btnHeaderAdd) btnHeaderAdd.style.display = "inline-flex";
      if (observeControlGroup) observeControlGroup.style.display = "inline-flex";
      btnSettings.style.display = "flex";
      if (headerLogoutGroup) headerLogoutGroup.style.display = "flex";

      // Restore saved annotations preference
      const savedAnnotationsPref = localStorage.getItem("ej_show_annotations") === "true";
      if (savedAnnotationsPref) {
        document.body.classList.add("show-annotations");
        if (btnToggleAnnotations) btnToggleAnnotations.classList.add("active");
      }
    } else {
      document.body.classList.add("gander-mode");
      btnUnlock.style.display = "flex";
      if (btnHeaderAdd) btnHeaderAdd.style.display = "none";
      if (observeControlGroup) observeControlGroup.style.display = "none";
      btnSettings.style.display = "none";
      if (headerLogoutGroup) headerLogoutGroup.style.display = "none";
      document.body.classList.remove("show-annotations");

      // Close input form on logout
      if (newEntryRow) newEntryRow.style.display = "none";
      if (newTextarea) newTextarea.value = "";
      localStorage.removeItem("ej_draft_new_entry");
      hideFloatingRedact();
    }
  }

  // Load Settings
  function loadSettingsIntoForm() {
    const settings = DB.getSettings();
    settingsSystemInstruction.value = settings.systemInstruction;
    settingsApiKey.value = settings.apiKey || "";
    settingsModel.value = settings.model || "gemini-2.5-flash";
    if (settingsPsychModel) {
      settingsPsychModel.value = settings.psychModel || "gemini-3.1-pro-preview";
    }
  }

  let renderToken = 0;

  // Render list of entries with rock-solid scroll preservation
  function renderTimeline(anchorCardId = null) {
    const savedScrollY = window.scrollY;
    renderToken++;
    const currentToken = renderToken;

    const entries = reminisceUnlocked ? DB.getPrivateEntries() : DB.getPublicEntries();
    
    if (!entries || entries.length === 0) {
      if (feedLoadingState) feedLoadingState.style.display = "none";
      if (welcomeState) welcomeState.style.display = "block";
      timelineFeed.innerHTML = "";
      return;
    }

    if (welcomeState) welcomeState.style.display = "none";
    if (feedLoadingState) feedLoadingState.style.display = "none";

    // Sort entries strictly newest first (by date or createdAt descending)
    entries.sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));

    function createRowElement(entry) {
      const row = document.createElement("div");
      row.className = "timeline-row";
      row.dataset.id = entry.id;

      const dateParts = Renderer.getDateParts(entry.date || entry.createdAt);
      const formattedTime = Renderer.formatTime(entry.date || entry.createdAt);
      const formattedEdited = Renderer.formatFullDateTime(entry.updatedAt);
      const renderText = reminisceUnlocked 
        ? (entry.victorianContent || entry.rawContent || entry.publicContent || "") 
        : (entry.publicContent || entry.victorianContent || entry.rawContent || "");
      const editInitialVal = reminisceUnlocked ? (entry.victorianContent || entry.rawContent || entry.publicContent || "") : "";

      const hasContent = typeof entry.rawContent === "string" && typeof entry.victorianContent === "string" && entry.rawContent.trim().length > 0;
      const isDirectText = Boolean(renderText && renderText.trim().length > 0) && entry.isRawFallback === true;
      const directBadgeHtml = (reminisceUnlocked && isDirectText) ? `<span class="raw-text-badge" title="Direct raw reflection (untranscribed)">✦ DIRECT TEXT</span>` : "";

      const annotationPanelHtml = reminisceUnlocked ? `
        <div class="entry-annotation-panel">
          ${PsychEngine.renderPanelContent(entry)}
        </div>
      ` : "";

      const bodyHtml = (renderText && renderText.trim().length > 0)
        ? Renderer.render(renderText)
        : `<span style="color: var(--ink-muted); font-style: italic; font-size: 13px; opacity: 0.6;">(Empty reflection — click ··· to edit or discard)</span>`;

      row.innerHTML = `
        <div class="timeline-date">
          <span class="date-day">${dateParts.monthDay}</span>
          <span class="date-year">${dateParts.year}</span>
        </div>
        <div class="timeline-node-container">
          <div class="timeline-node"></div>
        </div>
        <div class="timeline-content">
          <!-- VIEW STATE -->
          <div class="card-view-state">
            <div class="entry-card-header">
              <span class="entry-timestamp">${formattedTime}</span>
              <button class="btn-more">...</button>
              <div class="context-menu">
                <button class="context-menu-item btn-card-edit-trigger" data-id="${entry.id}">Edit</button>
                <button class="context-menu-item btn-card-delete" data-id="${entry.id}">Discard</button>
              </div>
            </div>
            <div class="entry-body card-body-text victorian">${bodyHtml}</div>
            <div class="entry-card-footer" style="display: flex; justify-content: space-between; align-items: center;">
              <span>Edited ${formattedEdited}</span>
              ${directBadgeHtml}
            </div>
          </div>

          <!-- EDIT STATE -->
          <div class="card-edit-state" style="display: none;" data-mode="rewrite">
            <div class="edit-card">
              <div class="edit-mode-toggle">
                <button type="button" class="btn-toggle-edit" data-mode="raw">RAW TEXT</button>
                <button type="button" class="btn-toggle-edit active" data-mode="rewrite">REWRITE</button>
              </div>
              <div class="edit-label">JOURNAL REWRITE</div>
              <textarea class="edit-textarea card-edit-textarea" placeholder="enter your recollections">${editInitialVal}</textarea>
              
              <!-- Card Inner Loader -->
              <div class="card-loading card-edit-loading" style="display: none;">
                <span class="loading-text">Transcribing entry...</span>
                <div class="loading-bar"></div>
              </div>

              <div class="edit-actions">
                <button type="button" class="btn-text btn-card-image-upload" data-id="${entry.id}" style="display: inline-flex; align-items: center; gap: 4px;">
                  <svg class="lucide-image-icon" viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                  <span>IMAGE</span>
                </button>
                <button class="btn-text btn-card-edit-cancel" data-id="${entry.id}">CANCEL</button>
                <button class="btn-pill btn-card-edit-done active" data-id="${entry.id}">DONE</button>
              </div>
            </div>
          </div>
        </div>
        ${annotationPanelHtml}
      `;
      return row;
    }

    // Build all row elements in an in-memory document fragment
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < entries.length; i++) {
      fragment.appendChild(createRowElement(entries[i]));
    }

    // Single DOM update to prevent height collapse
    timelineFeed.innerHTML = "";
    timelineFeed.appendChild(fragment);

    // Seamless scroll position preservation
    if (anchorCardId) {
      const targetEl = document.querySelector(`.timeline-row[data-id="${anchorCardId}"]`);
      if (targetEl) {
        targetEl.scrollIntoView({ block: "nearest", behavior: "instant" });
      } else if (savedScrollY > 0) {
        window.scrollTo({ top: savedScrollY, behavior: "instant" });
      }
    } else if (savedScrollY > 0) {
      window.scrollTo({ top: savedScrollY, behavior: "instant" });
    }
  }

  // Open Composition Box at top of timeline
  function openComposer() {
    if (!reminisceUnlocked) return;

    newEntryRow.style.display = "grid";
    newTextarea.focus();
    
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }
    hideFloatingRedact();

    initTextareaAutoResize(newTextarea);
    
    const parts = Renderer.getDateParts(new Date());
    newDateDay.textContent = parts.monthDay;
    newDateYear.textContent = parts.year;

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (btnHeaderAdd) {
    btnHeaderAdd.addEventListener("click", openComposer);
  }
  if (btnRecordNew) {
    btnRecordNew.addEventListener("click", openComposer);
  }

  // Auto-save draft protection as you type or dictate
  newTextarea.addEventListener("input", () => {
    localStorage.setItem("ej_draft_new_entry", newTextarea.value);
  });

  // Restore saved draft if present on startup
  const savedDraft = localStorage.getItem("ej_draft_new_entry");
  if (savedDraft && savedDraft.trim()) {
    newTextarea.value = savedDraft;
    newEntryRow.style.display = "grid";
    initTextareaAutoResize(newTextarea);
  }

  // Cancel Composing slot
  btnNewCancel.addEventListener("click", () => {
    newEntryRow.style.display = "none";
    newTextarea.value = "";
    localStorage.removeItem("ej_draft_new_entry");
    hideFloatingRedact();
  });

  // Submit Composing Slot
  btnNewDone.addEventListener("click", async () => {
    if (isTranscribing || !reminisceUnlocked) return;

    const rawContent = newTextarea.value.trim();
    if (!rawContent) {
      UI.showNotification("Please record some modern text first.");
      return;
    }

    isTranscribing = true;
    btnNewDone.disabled = true;
    btnNewCancel.disabled = true;
    newCardLoading.style.display = "flex";
    const loadingTextEl = newCardLoading.querySelector(".loading-text");
    if (loadingTextEl) loadingTextEl.textContent = "Transcribing entry...";

    let rewritten = rawContent;
    let isFallback = false;
    try {
      rewritten = await AIEngine.rewrite(rawContent, (statusText) => {
        if (loadingTextEl) loadingTextEl.textContent = statusText;
      });
    } catch (e) {
      console.warn("AI rewrite fallback to direct text:", e);
      isFallback = true;
      rewritten = rawContent;
      UI.showAlert(`AI Transcription could not be completed (${e.message}). Saved as raw reflection.`, "TRANSCRIPTION NOTICE");
    }

    try {
      const newId = "ej-" + Date.now();
      const newEntryObj = {
        id: newId,
        date: new Date().toISOString(),
        isRawFallback: isFallback
      };

      await DB.saveEntry(newEntryObj, rawContent, rewritten);
      
      newTextarea.value = "";
      localStorage.removeItem("ej_draft_new_entry");
      newCardLoading.style.display = "none";
      newEntryRow.style.display = "none";
      
      isTranscribing = false;
      btnNewDone.disabled = false;
      btnNewCancel.disabled = false;

      renderTimeline();
      UI.showNotification(isFallback ? "Raw reflection recorded." : "New reflection recorded.");
    } catch (e) {
      console.error("Save entry error:", e);
      UI.showNotification(e.message || "Failed to save entry.");
      isTranscribing = false;
      btnNewDone.disabled = false;
      btnNewCancel.disabled = false;
      newCardLoading.style.display = "none";
    }
  });

  // Text selection listener for Victorian view-mode redactions (Mobile + Desktop touch support)
  function handleTextSelection(e) {
    if (!reminisceUnlocked) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (!activeUnredactTarget) hideFloatingRedact();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      if (!activeUnredactTarget) hideFloatingRedact();
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) return;

    const containerNode = range.commonAncestorContainer;
    const parentEl = containerNode.nodeType === 3 ? containerNode.parentElement : containerNode;
    const entryBody = parentEl ? parentEl.closest(".entry-body") : null;
    if (!entryBody) {
      if (!activeUnredactTarget) hideFloatingRedact();
      return;
    }

    const row = parentEl.closest(".timeline-row");
    if (!row) {
      if (!activeUnredactTarget) hideFloatingRedact();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    activeSelection = {
      cardId: row.dataset.id,
      text: selectedText
    };

    const btnWidth = 140;
    let leftPos = rect.left + window.scrollX + (rect.width / 2) - (btnWidth / 2);
    leftPos = Math.max(10, Math.min(leftPos, window.innerWidth - btnWidth - 10));

    const isTouchMobile = ('ontouchstart' in window) || (window.innerWidth <= 768);
    let topPos;
    if (isTouchMobile || (rect.top - 50 < 10)) {
      topPos = rect.bottom + window.scrollY + 10;
    } else {
      topPos = rect.top + window.scrollY - 44;
    }

    if (btnFloatingUnredact) btnFloatingUnredact.style.display = "none";
    btnFloatingRedact.style.left = `${leftPos}px`;
    btnFloatingRedact.style.top = `${topPos}px`;
    btnFloatingRedact.style.display = "block";
  }

  function hideFloatingRedact() {
    if (btnFloatingRedact) btnFloatingRedact.style.display = "none";
    if (btnFloatingUnredact) btnFloatingUnredact.style.display = "none";
    activeSelection = null;
    activeUnredactTarget = null;
  }

  // Helper to normalize quotes, entities, and multiline lists for reliable text selection matching
  function findMatchingSubstring(fullText, target) {
    if (!fullText || !target) return null;
    if (fullText.includes(target)) return target;

    // 1. Normalize non-breaking spaces (\u00A0) and carriage returns
    const cleanTarget = target.replace(/\u00A0/g, " ").replace(/\r\n/g, "\n");
    if (fullText.includes(cleanTarget)) return cleanTarget;

    // 2. Build flexible character-by-character regex pattern (handles quotes, entities, & line breaks in lists)
    let pattern = "";
    for (let i = 0; i < cleanTarget.length; i++) {
      const char = cleanTarget[i];
      if (char === '"' || char === '“' || char === '”') {
        pattern += '(["“”]|&quot;|\\")';
      } else if (char === "'" || char === '‘' || char === '’') {
        pattern += "(['‘’]|&#039;|\\')";
      } else if (char === '&') {
        pattern += "(&|&amp;)";
      } else if (/\s/.test(char)) {
        pattern += "[\\s\\n\\r\\u00A0]+";
      } else if (/[.*+?^${}()|[\]\\]/.test(char)) {
        pattern += "\\" + char;
      } else {
        pattern += char;
      }
    }

    try {
      const regex = new RegExp(pattern, "i");
      const match = fullText.match(regex);
      if (match) return match[0];
    } catch(e) {}

    // 3. Normalized index fallback search for multiline quote lists
    try {
      const normVictorian = fullText.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\u00A0/g, " ");
      const normTarget = cleanTarget.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\u00A0/g, " ");
      const idx = normVictorian.indexOf(normTarget);
      if (idx !== -1) {
        return fullText.slice(idx, idx + cleanTarget.length);
      }
    } catch(e) {}

    return null;
  }

  // Redact action handler
  const performRedaction = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!activeSelection || !reminisceUnlocked) return;

    const { cardId, text } = activeSelection;
    const entry = DB.getPrivateEntries().find(e => e.id === cardId);
    
    if (entry) {
      const matchText = findMatchingSubstring(entry.victorianContent, text);
      if (matchText) {
        entry.victorianContent = entry.victorianContent.replace(matchText, `||${matchText}||`);
        await DB.saveEntry(entry, entry.rawContent, entry.victorianContent, true);
        renderTimeline(entry.id);
        UI.showNotification("Secret redacted.");
      } else {
        UI.showNotification("Highlighted text mismatch. Try again.");
      }
    } else {
      UI.showNotification("Highlighted text mismatch. Try again.");
    }

    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }
    hideFloatingRedact();
  };

  btnFloatingRedact.addEventListener("mousedown", performRedaction);
  btnFloatingRedact.addEventListener("touchstart", performRedaction);

  // Unredact action handler (Floating Button)
  const performUnredaction = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!activeUnredactTarget || !reminisceUnlocked) return;

    const { cardId, secretText } = activeUnredactTarget;
    const entry = DB.getPrivateEntries().find(e => e.id === cardId);
    if (entry) {
      const matchText = findMatchingSubstring(entry.victorianContent, `||${secretText}||`) || `||${secretText}||`;
      if (entry.victorianContent.includes(matchText)) {
        const cleanUnredacted = matchText.replace(/^\|\|/, "").replace(/\|\|$/, "");
        entry.victorianContent = entry.victorianContent.replace(matchText, cleanUnredacted);
        await DB.saveEntry(entry, entry.rawContent, entry.victorianContent, true);
        renderTimeline();
        UI.showNotification("Secret unredacted.");
      }
    }

    hideFloatingRedact();
  };

  if (btnFloatingUnredact) {
    btnFloatingUnredact.addEventListener("mousedown", performUnredaction);
    btnFloatingUnredact.addEventListener("touchstart", performUnredaction);
  }

  // Timeline events delegation (clicks)
  timelineFeed.addEventListener("click", async (e) => {
    const row = e.target.closest(".timeline-row");
    if (!row) return;

    const id = row.dataset.id;
    const viewState = row.querySelector(".card-view-state");
    const editState = row.querySelector(".card-edit-state");
    const loadingState = row.querySelector(".card-edit-loading");

    const deleteBtn = e.target.closest(".btn-card-delete");
    const editTriggerBtn = e.target.closest(".btn-card-edit-trigger");
    const cancelBtn = e.target.closest(".btn-card-edit-cancel");
    const doneBtn = e.target.closest(".btn-card-edit-done");
    const moreBtn = e.target.closest(".btn-more");
    const toggleEditBtn = e.target.closest(".btn-toggle-edit");
    const imageUploadBtn = e.target.closest(".btn-card-image-upload");

    if (imageUploadBtn && reminisceUnlocked) {
      e.stopPropagation();
      const textarea = editState.querySelector(".card-edit-textarea");
      activeEditingTextarea = textarea;
      if (globalImageInput) {
        globalImageInput.value = "";
        globalImageInput.click();
      }
      return;
    }

    if (deleteBtn && reminisceUnlocked) {
      e.stopPropagation();
      document.querySelectorAll(".context-menu").forEach(m => m.classList.remove("active"));
      const confirmed = await UI.showConfirm("Discard this reflection forever?");
      if (confirmed) {
        await DB.deleteEntry(id);
        renderTimeline();
      }
    } else if (editTriggerBtn && reminisceUnlocked) {
      e.stopPropagation();
      document.querySelectorAll(".context-menu").forEach(m => m.classList.remove("active"));
      openEditor(row);
    } else if (cancelBtn) {
      e.stopPropagation();
      editState.style.display = "none";
      viewState.style.display = "block";
      
      const node = row.querySelector(".timeline-node-container div");
      node.className = "timeline-node";

      hideFloatingRedact();
    } else if (moreBtn && reminisceUnlocked) {
      e.stopPropagation();
      document.querySelectorAll(".context-menu").forEach(m => m.classList.remove("active"));
      const menu = row.querySelector(".context-menu");
      menu.classList.toggle("active");
    } else if (toggleEditBtn) {
      e.stopPropagation();
      const currentMode = editState.dataset.mode;
      const clickedMode = toggleEditBtn.dataset.mode;
      if (currentMode === clickedMode) return;

      const textarea = editState.querySelector(".card-edit-textarea");
      const entry = DB.getPrivateEntries().find(e => e.id === id);

      if (clickedMode === "rewrite") {
        editState.dataset.tempRaw = textarea.value;
        textarea.value = entry.victorianContent;
        editState.querySelector(".edit-label").textContent = "JOURNAL REWRITE";
      } else {
        textarea.value = editState.dataset.tempRaw || entry.rawContent;
        editState.querySelector(".edit-label").textContent = "JOURNAL ENTRY";
      }

      editState.dataset.mode = clickedMode;
      editState.querySelectorAll(".btn-toggle-edit").forEach(btn => btn.classList.remove("active"));
      toggleEditBtn.classList.add("active");
      
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    } else if (doneBtn && reminisceUnlocked) {
      e.stopPropagation();
      if (isTranscribing) return;

      try {
        const textarea = editState.querySelector(".card-edit-textarea");
        const updatedValue = textarea ? textarea.value.trim() : "";
        const activeMode = editState.dataset.mode || "rewrite";

        if (!updatedValue) {
          UI.showNotification("The reflection cannot be empty.");
          return;
        }

        const allPrivate = DB.getPrivateEntries();
        let entry = allPrivate.find(e => e && String(e.id) === String(id));
        if (!entry) {
          const allPublic = DB.getPublicEntries();
          entry = allPublic.find(e => e && String(e.id) === String(id));
        }
        if (!entry) {
          entry = { id: id, date: new Date().toISOString() };
        }

        if (activeMode === "raw") {
          // Compare raw text ignoring image tags, whitespace, and punctuation (e.g. adding a period) to check if actual words changed
          const cleanOriginal = (entry.rawContent || "").replace(/!\[.*?\]\([^)]+\)/g, "");
          const cleanUpdated = updatedValue.replace(/!\[.*?\]\([^)]+\)/g, "");

          const wordsOriginal = cleanOriginal.toLowerCase().replace(/[^\w]/g, "");
          const wordsUpdated = cleanUpdated.toLowerCase().replace(/[^\w]/g, "");
          const wordsUnchanged = (wordsOriginal === wordsUpdated);

          if (wordsUnchanged) {
            // Punctuation, whitespace, or formatting edit: skip Gemini API call and save formatting directly
            await DB.saveEntry(entry, updatedValue, entry.victorianContent);
            renderTimeline(entry.id);
            UI.showNotification("Reflection updated.");
            return;
          }

          const currentCancelBtn = editState.querySelector(".btn-card-edit-cancel");
          const currentDoneBtn = editState.querySelector(".btn-card-edit-done");

          isTranscribing = true;
          if (currentDoneBtn) currentDoneBtn.disabled = true;
          if (currentCancelBtn) currentCancelBtn.disabled = true;
          if (loadingState) loadingState.style.display = "flex";

          let rewritten = updatedValue;
          try {
            rewritten = await AIEngine.rewrite(updatedValue);
          } catch(err) {
            console.warn("Edit rewrite fallback to direct text:", err);
          }

          try {
            await DB.saveEntry(entry, updatedValue, rewritten);
            renderTimeline(entry.id);
            UI.showNotification("Reflection updated.");
          } catch(err) {
            console.error("Edit save error:", err);
            UI.showNotification(err.message || "Rewrite failed.");
          } finally {
            isTranscribing = false;
            if (currentDoneBtn) currentDoneBtn.disabled = false;
            if (currentCancelBtn) currentCancelBtn.disabled = false;
            if (loadingState) loadingState.style.display = "none";
          }
        } else {
          // Save manual rewrite override
          const rawContent = updatedValue;
          entry.isRawFallback = false;
          await DB.saveEntry(entry, rawContent, updatedValue);
          
          editState.style.display = "none";
          viewState.style.display = "block";
          
          const node = row.querySelector(".timeline-node-container div");
          if (node) node.className = "timeline-node";
          
          renderTimeline(entry.id);
          UI.showNotification("Reflection updated.");
        }
      } catch (err) {
        console.error("Error saving card edit:", err);
        UI.showAlert("Error saving edit: " + (err.message || err), "EDIT FAILED");
      }
    }
  });

  // Helper to open existing entry card in edit mode
  function openEditor(row) {
    isTranscribing = false;
    const viewState = row.querySelector(".card-view-state");
    const editState = row.querySelector(".card-edit-state");
    const textarea = editState.querySelector(".card-edit-textarea");
    
    const node = row.querySelector(".timeline-node-container div");
    if (node) node.className = "dashed-node";

    window.getSelection().removeAllRanges();
    hideFloatingRedact();

    const allPrivate = DB.getPrivateEntries();
    const entry = allPrivate.find(e => e && String(e.id) === String(row.dataset.id));

    editState.dataset.mode = "rewrite";
    editState.querySelectorAll(".btn-toggle-edit").forEach(btn => btn.classList.remove("active"));
    const rewriteBtn = editState.querySelector('.btn-toggle-edit[data-mode="rewrite"]');
    if (rewriteBtn) rewriteBtn.classList.add("active");
    const label = editState.querySelector(".edit-label");
    if (label) label.textContent = "JOURNAL REWRITE";

    let initialText = entry ? (entry.victorianContent || entry.rawContent || "") : "";
    initialText = initialText.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, (match, dataUrl) => {
      const imgId = "img-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
      tempImageStore[imgId] = dataUrl;
      return `![attached-image](${imgId})`;
    });

    textarea.value = initialText;
    editState.dataset.tempRaw = entry ? (entry.rawContent || "") : "";

    viewState.style.display = "none";
    editState.style.display = "block";
    textarea.focus();

    initTextareaAutoResize(textarea);
  }

  // Double click existing entry card to edit it
  timelineFeed.addEventListener("dblclick", (e) => {
    if (!reminisceUnlocked) return;

    const row = e.target.closest(".timeline-row");
    if (!row) return;

    if (e.target.closest(".entry-card-header") || e.target.closest(".entry-card-footer") ||
        row.querySelector(".card-edit-state").style.display === "block") return;

    openEditor(row);
  });

  // Highlight selection listeners (Desktop + Mobile touch support)
  document.addEventListener("mouseup", handleTextSelection);
  document.addEventListener("keyup", handleTextSelection);
  document.addEventListener("touchend", handleTextSelection);
  document.addEventListener("selectionchange", handleTextSelection);

  // Header logout button click handler
  if (btnHeaderLogout) {
    btnHeaderLogout.addEventListener("click", async () => {
      if (auth) {
        await window.Firebase.signOut(auth);
      } else {
        reminisceUnlocked = false;
        sessionStorage.removeItem("ej_reminisce_unlocked");
        applyModeUI();
        renderTimeline();
      }
      UI.showNotification("Logged out of journal.");
    });
  }

  // Voice Dictation Module (Web Speech API with Fallback & Visual Indicator)
  let activeRecognition = null;
  let isDictating = false;

  function setupVoiceDictation(btnElement, textareaElement) {
    if (!btnElement || !textareaElement) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      btnElement.addEventListener("click", () => {
        UI.showNotification("Voice dictation is not supported by your browser. Try Chrome, Edge, or Safari.");
      });
      return;
    }

    btnElement.addEventListener("click", () => {
      if (isDictating) {
        if (activeRecognition) {
          try { activeRecognition.stop(); } catch(e) {}
        }
        return;
      }

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || "en-US";

        let lastInterimLength = 0;

        recognition.onstart = () => {
          isDictating = true;
          activeRecognition = recognition;
          btnElement.classList.add("dictating");
          btnElement.innerHTML = `🔴 LISTENING...`;
          UI.showNotification("Listening... Speak your entry naturally.");
        };

        recognition.onresult = (e) => {
          let interimTranscript = "";
          let finalTranscript = "";

          for (let i = e.resultIndex; i < e.results.length; ++i) {
            if (e.results[i].isFinal) {
              finalTranscript += e.results[i][0].transcript;
            } else {
              interimTranscript += e.results[i][0].transcript;
            }
          }

          if (finalTranscript) {
            if (lastInterimLength > 0) {
              textareaElement.value = textareaElement.value.slice(0, -lastInterimLength);
              lastInterimLength = 0;
            }

            let currentVal = textareaElement.value;
            if (currentVal && !currentVal.endsWith(" ") && !currentVal.endsWith("\n")) {
              currentVal += " ";
            }
            textareaElement.value = currentVal + finalTranscript.trim() + " ";
          } else if (interimTranscript) {
            if (lastInterimLength > 0) {
              textareaElement.value = textareaElement.value.slice(0, -lastInterimLength);
            }

            let currentVal = textareaElement.value;
            if (currentVal && !currentVal.endsWith(" ") && !currentVal.endsWith("\n")) {
              currentVal += " ";
            }
            textareaElement.value = currentVal + interimTranscript;
            lastInterimLength = interimTranscript.length;
          }

          textareaElement.style.height = "auto";
          textareaElement.style.height = textareaElement.scrollHeight + "px";
        };

        recognition.onerror = (e) => {
          console.error("Speech recognition error:", e.error);
          if (e.error !== "no-speech" && e.error !== "aborted") {
            UI.showNotification(`Voice error: ${e.error}`);
          }
          stopDictation();
        };

        recognition.onend = () => {
          stopDictation();
        };

        function stopDictation() {
          if (lastInterimLength > 0) {
            textareaElement.value = textareaElement.value.slice(0, -lastInterimLength);
            lastInterimLength = 0;
          }
          isDictating = false;
          activeRecognition = null;
          btnElement.classList.remove("dictating");
          btnElement.innerHTML = `🎤 DICTATE`;
        }

        recognition.start();
      } catch(err) {
        console.error("Dictation start error:", err);
        UI.showNotification("Could not access microphone.");
      }
    });
  }

  // Image Resizing Helper (Updates markdown tag in raw & victorian content)
  async function updateImageWidthInEntry(cardId, container, newWidthStyle) {
    const entry = DB.getPrivateEntries().find(e => e.id === cardId);
    if (!entry) return;

    const targetImgIdx = parseInt(container.dataset.imgIdx || "0", 10);

    const updateWidthInText = (text) => {
      if (!text) return "";
      let currentIdx = 0;
      let replaced = false;

      // 1. Try replacing markdown image tag ![alt](url)
      let updated = text.replace(/!\[([\s\S]*?)\]\(\s*([^)]+)\s*\)/gi, (match, alt, url) => {
        if (currentIdx === targetImgIdx) {
          replaced = true;
          currentIdx++;
          let cleanAlt = alt.replace(/\|w=(\d+px|\d+%)/gi, "").replace(/\|(\d+px|\d+%)/gi, "").trim();
          if (!cleanAlt) cleanAlt = "attached-image";
          return `![${cleanAlt}|w=${newWidthStyle}](${url.trim()})`;
        }
        currentIdx++;
        return match;
      });

      // 2. Fallback: If no markdown tag was matched at targetIdx, replace standalone data:image Base64 URL
      if (!replaced) {
        currentIdx = 0;
        updated = text.replace(/(data:image\/[a-zA-Z0-9\/+;=,-]+)/gi, (match) => {
          if (currentIdx === targetImgIdx) {
            replaced = true;
            currentIdx++;
            return `![attached-image|w=${newWidthStyle}](${match})`;
          }
          currentIdx++;
          return match;
        });
      }

      return updated;
    };

    const updatedRaw = updateWidthInText(entry.rawContent);
    const updatedVictorian = updateWidthInText(entry.victorianContent);

    entry.rawContent = updatedRaw;
    entry.victorianContent = updatedVictorian;

    await DB.saveEntry(entry, updatedRaw, updatedVictorian, true);
    renderTimeline();
    UI.showNotification(`Image resized to ${newWidthStyle}.`);
  }

  // Handle Quick Size Preset Button & Redact Button Clicks
  timelineFeed.addEventListener("click", async (e) => {
    const redactBtn = e.target.closest(".btn-img-redact");
    if (redactBtn && reminisceUnlocked) {
      e.stopPropagation();
      const container = redactBtn.closest(".journal-img-container");
      const row = redactBtn.closest(".timeline-row");
      if (!container || !row) return;

      const cardId = row.dataset.id;
      const entry = DB.getPrivateEntries().find(item => item.id === cardId);
      if (!entry) return;

      const rawTag = decodeURIComponent(redactBtn.dataset.rawTag || "");
      const isRedacted = redactBtn.dataset.isRedacted === "true";

      if (isRedacted) {
        // Unredact image: replace ||rawTag|| with rawTag
        const targetRedacted = `||${rawTag}||`;
        if (entry.victorianContent.includes(targetRedacted)) {
          entry.victorianContent = entry.victorianContent.replace(targetRedacted, rawTag);
        } else {
          // Fallback regex search for redacted image tag
          entry.victorianContent = entry.victorianContent.replace(/\|\|(!\[[\s\S]*?\]\([^)]+\))\|\|/i, "$1");
        }
        UI.showNotification("Image unredacted.");
      } else {
        // Redact image: replace rawTag with ||rawTag||
        if (rawTag && entry.victorianContent.includes(rawTag)) {
          entry.victorianContent = entry.victorianContent.replace(rawTag, `||${rawTag}||`);
        } else {
          // Fallback search for any unredacted image tag in entry
          entry.victorianContent = entry.victorianContent.replace(/(!\[[\s\S]*?\]\([^)]+\))/i, "||$1||");
        }
        UI.showNotification("Image redacted.");
      }

      await DB.saveEntry(entry, entry.rawContent, entry.victorianContent, true);
      renderTimeline();
      return;
    }

    const sizeBtn = e.target.closest(".btn-img-size");
    if (!sizeBtn || !reminisceUnlocked) return;

    e.stopPropagation();
    const container = sizeBtn.closest(".journal-img-container");
    const row = sizeBtn.closest(".timeline-row");
    if (!container || !row) return;

    const img = container.querySelector(".journal-entry-img");
    const newSize = sizeBtn.dataset.size;
    if (!img || !newSize) return;

    img.style.width = newSize;
    await updateImageWidthInEntry(row.dataset.id, container, newSize);
  });

  // Handle Corner Drag Handle Resizing (Mouse & Touch)
  let isResizingImage = false;
  timelineFeed.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".img-resize-handle");
    if (!handle || !reminisceUnlocked) return;

    e.preventDefault();
    e.stopPropagation();

    const container = handle.closest(".journal-img-container");
    const row = handle.closest(".timeline-row");
    const img = container ? container.querySelector(".journal-entry-img") : null;
    if (!container || !row || !img) return;

    isResizingImage = true;
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const parentWidth = container.parentElement ? container.parentElement.getBoundingClientRect().width : window.innerWidth;

    function onMouseMove(moveEvent) {
      if (!isResizingImage) return;
      const deltaX = moveEvent.clientX - startX;
      let newWidth = Math.max(120, Math.min(startWidth + deltaX, parentWidth));
      img.style.width = `${Math.round(newWidth)}px`;
    }

    async function onMouseUp() {
      if (!isResizingImage) return;
      isResizingImage = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      const finalWidth = `${Math.round(img.getBoundingClientRect().width)}px`;
      await updateImageWidthInEntry(row.dataset.id, container, finalWidth);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });

  if (btnNewSpeech && newTextarea) {
    setupVoiceDictation(btnNewSpeech, newTextarea);
  }

  // Handle image upload button click for new composer card
  if (btnNewImage) {
    btnNewImage.addEventListener("click", () => {
      activeEditingTextarea = newTextarea;
      if (globalImageInput) globalImageInput.click();
    });
  }

  // Handle global image input selection
  if (globalImageInput) {
    globalImageInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file || !activeEditingTextarea) return;

      try {
        const compressedDataUrl = await compressImage(file);
        insertImageTagAtCursor(activeEditingTextarea, compressedDataUrl);
        UI.showNotification("Image attached.");
      } catch (err) {
        console.error("Image compression error:", err);
        UI.showNotification("Failed to attach image.");
      }
      globalImageInput.value = "";
    });
  }

  // Image upload click inside timeline card edit mode delegation
  timelineFeed.addEventListener("click", (e) => {
    const imageUploadBtn = e.target.closest(".btn-card-image-upload");
    if (imageUploadBtn && reminisceUnlocked) {
      e.stopPropagation();
      const row = e.target.closest(".timeline-row");
      if (row) {
        activeEditingTextarea = row.querySelector(".card-edit-textarea");
        if (globalImageInput) globalImageInput.click();
      }
    }
  });

  // Global paste handler for images into textareas
  document.addEventListener("paste", async (e) => {
    const activeEl = document.activeElement;
    if (!activeEl || (!activeEl.classList.contains("edit-textarea") && activeEl.id !== "new-textarea")) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          try {
            const compressedDataUrl = await compressImage(file);
            insertImageTagAtCursor(activeEl, compressedDataUrl);
            UI.showNotification("Pasted image attached.");
          } catch (err) {
            console.error("Paste image error:", err);
            UI.showNotification("Failed to paste image.");
          }
        }
        break;
      }
    }
  });

  // Close context dropdowns and floating buttons when clicking outside
  window.addEventListener("click", (e) => {
    if (!e.target.matches(".btn-more")) {
      document.querySelectorAll(".context-menu").forEach(m => m.classList.remove("active"));
    }

    const sel = window.getSelection();
    const hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;

    if (!hasSelection && !e.target.closest("#btn-floating-unredact") && !e.target.closest(".redacted-text") && !e.target.closest("#btn-floating-redact")) {
      hideFloatingRedact();
    }
  });

  // Click/tap on redacted secret element to show floating UNREDACT button
  timelineFeed.addEventListener("click", (e) => {
    const redactedEl = e.target.closest(".redacted-text");
    if (!redactedEl || !reminisceUnlocked) return;

    e.stopPropagation();
    if (window.getSelection) {
      window.getSelection().removeAllRanges();
    }

    const row = e.target.closest(".timeline-row");
    if (!row) return;

    const secretText = redactedEl.dataset.secret || redactedEl.textContent;
    const cardId = row.dataset.id;

    activeUnredactTarget = {
      cardId,
      secretText
    };

    const rect = redactedEl.getBoundingClientRect();
    const btnWidth = 160;
    let leftPos = rect.left + window.scrollX + (rect.width / 2) - (btnWidth / 2);
    leftPos = Math.max(10, Math.min(leftPos, window.innerWidth - btnWidth - 10));

    const isTouchMobile = ('ontouchstart' in window) || (window.innerWidth <= 768);
    let topPos;
    if (isTouchMobile || (rect.top - 50 < 10)) {
      topPos = rect.bottom + window.scrollY + 10;
    } else {
      topPos = rect.top + window.scrollY - 44;
    }

    if (btnFloatingRedact) btnFloatingRedact.style.display = "none";
    btnFloatingUnredact.style.left = `${leftPos}px`;
    btnFloatingUnredact.style.top = `${topPos}px`;
    btnFloatingUnredact.style.display = "block";
  });

  // Prominent Unlock Button Click (Triggers Google Auth popup directly)
  btnUnlock.addEventListener("click", async () => {
    if (auth) {
      try {
        const provider = new window.Firebase.GoogleAuthProvider();
        const res = await window.Firebase.signInWithPopup(auth, provider);
        if (res.user && ownerEmail && res.user.email !== ownerEmail) {
          await window.Firebase.signOut(auth);
          reminisceUnlocked = false;
          UI.showNotification("Access denied: Only the journal owner can unlock.");
        }
      } catch (err) {
        console.error("Sign-in failed:", err);
        UI.showNotification("Google Sign-In failed or was cancelled.");
      }
    } else {
      // Offline fallback login: simulate lock bypass
      reminisceUnlocked = true;
      sessionStorage.setItem("ej_reminisce_unlocked", "true");
      applyModeUI();
      renderTimeline();
    }
  });

  // Persona Dial & Presets (Calibrated from 0% Period to 100% Period)
  const NON_CONVERSATIONAL_CLAUSE = `\n- CRITICAL ROLE BOUNDARY: You are a silent, non-conversational text editor/transcriber ONLY. NEVER speak to the user, offer sympathy, give unsolicited advice, recommend therapy, or add conversational preambles/postscripts. NEVER respond in the first person ("I am sorry...", "As an AI..."). Output ONLY the journal entry text itself.`;

  const PERSONA_PRESETS = {
    1: {
      label: "Step 1: Modern & Natural (0% AI Period Added)",
      desc: "Cleans up voice dictation, run-on sentences, and punctuation while preserving your exact original words, vocabulary, and phrasing 100% intact.",
      prompt: `You are a clear, modern text editor. Format the provided raw entry or speech dictation into clean, natural prose.\n\nStrict Rules:\n- Fix punctuation, run-on sentences, and speech dictation typos cleanly.\n- Respect and preserve all original words, phrasing, vocabulary, names, dates, numbers, facts, and image tags exactly as written by the author.\n- DO NOT add extra Victorian clichés or artificial period flourishes beyond what the author wrote.${NON_CONVERSATIONAL_CLAUSE}`
    },
    2: {
      label: "Step 2: Minimal Classical Tint (15% Period)",
      desc: "Very light touch of classical clarity. Plain, grounded, and sincere prose with zero archaic clichés or melodrama.",
      prompt: `You are a thoughtful editor providing a very subtle, minimal touch of classical clarity to a personal journal entry.\n\nStrict Rules:\n- Keep the prose direct, grounded, and unpretentious with only a whisper of classical dignity.\n- Preserve the author's original words, phrasing, facts, names, dates, and image tags.\n- Absolutely BAN silly theatrical Victorian clichés (NEVER use "alas", "methinks", "hark", "doth", "twas", "perchance", "hitherto", "my weary heart", "solace").${NON_CONVERSATIONAL_CLAUSE}`
    },
    3: {
      label: "Step 3: Grounded 19th-Century (50% Period)",
      desc: "Warm, understated 19th-century prose. Reflective, unpretentious, quiet dignity, zero melodrama.",
      prompt: `You are a thoughtful, observant 19th-century diarist writing in a private journal.\nRewrite the provided text into warm, understated 19th-century prose.\n\nStrict Rules:\n- Absolutely BAN all theatrical Victorian clichés and posturing (NEVER use "alas", "methinks", "hark", "doth", "twas", "perchance", "hitherto", "my weary heart", "solace").\n- Keep the tone sincere, unpretentious, and reflective with quiet dignity.\n- Preserve all original images, names, numbers, phrasing, and facts from the author's raw entry.${NON_CONVERSATIONAL_CLAUSE}`
    },
    4: {
      label: "Step 4: Formal 19th-Century (75% Period)",
      desc: "Formal 19th-century prose. Classical vocabulary, measured phrasing, traditional journal structure.",
      prompt: `You are a formal 19th-century chronicler keeping a private journal.\nRewrite the provided text into formal 19th-century prose with classical vocabulary and measured phrasing.\n\nStrict Rules:\n- Maintain a traditional period journal structure.\n- Avoid silly melodramatic clichés ("alas", "methinks").\n- Preserve all image attachments, dates, names, and factual details.${NON_CONVERSATIONAL_CLAUSE}`
    },
    5: {
      label: "Step 5: High Period Atmosphere (100% Period)",
      desc: "Immersive, highly atmospheric 19th-century prose with rich period vocabulary and traditional cadence.",
      prompt: `You are an atmospheric 19th-century writer keeping a deeply reflective journal.\nRewrite the provided text into immersive, rich 19th-century period prose.\n\nStrict Rules:\n- Use rich 19th-century vocabulary and atmospheric cadence while keeping prose coherent.\n- Preserve all images, facts, names, and original details.${NON_CONVERSATIONAL_CLAUSE}`
    }
  };

  const settingsPersonaSlider = document.getElementById("settings-persona-slider");
  const personaStepLabel = document.getElementById("persona-step-label");
  const personaStepDesc = document.getElementById("persona-step-desc");
  const btnRewriteLatest = document.getElementById("btn-rewrite-latest");
  const btnRewriteAll = document.getElementById("btn-rewrite-all");

  function updatePersonaSliderUI(stepVal) {
    const preset = PERSONA_PRESETS[stepVal] || PERSONA_PRESETS[2];
    if (personaStepLabel) personaStepLabel.textContent = preset.label;
    if (personaStepDesc) personaStepDesc.textContent = preset.desc;
    if (settingsSystemInstruction) settingsSystemInstruction.value = preset.prompt;
  }

  if (settingsPersonaSlider) {
    settingsPersonaSlider.addEventListener("input", (e) => {
      updatePersonaSliderUI(e.target.value);
    });
  }

  function loadSettingsIntoForm() {
    const settings = DB.getSettings();
    settingsSystemInstruction.value = settings.systemInstruction;
    settingsApiKey.value = settings.apiKey || "";
    settingsModel.value = settings.model || "gemini-2.5-flash";
    if (settingsPsychModel) {
      settingsPsychModel.value = settings.psychModel || "gemini-3.1-pro-preview";
    }
    if (settingsRetryDelay) {
      settingsRetryDelay.value = settings.annotationRetryDelay || 20;
    }
    
    let matchedStep = 2;
    for (let s = 1; s <= 5; s++) {
      if (settings.systemInstruction === PERSONA_PRESETS[s].prompt) {
        matchedStep = s;
        break;
      }
    }
    if (settingsPersonaSlider) settingsPersonaSlider.value = matchedStep;
    if (personaStepLabel) personaStepLabel.textContent = PERSONA_PRESETS[matchedStep].label;
    if (personaStepDesc) personaStepDesc.textContent = PERSONA_PRESETS[matchedStep].desc;
  }

  // ✨ REWRITE LATEST ENTRY
  if (btnRewriteLatest) {
    btnRewriteLatest.addEventListener("click", async () => {
      const entries = DB.getPrivateEntries();
      if (!entries || entries.length === 0) {
        UI.showNotification("No entries available to rewrite.");
        return;
      }

      const settings = DB.getSettings();
      settings.systemInstruction = settingsSystemInstruction.value.trim();
      settings.apiKey = settingsApiKey.value.trim();
      settings.model = settingsModel.value;
      DB.saveSettings(settings);
      await DB.saveCloudSettings(settings);

      const latestEntry = entries[0];
      btnRewriteLatest.disabled = true;
      btnRewriteLatest.textContent = "✨ REWRITING...";

      try {
        const rewritten = await AIEngine.rewrite(latestEntry.rawContent);
        await DB.saveEntry(latestEntry, latestEntry.rawContent, rewritten);
        renderTimeline();
        UI.showNotification("Latest entry successfully rewritten!");
      } catch (err) {
        console.error("Rewrite latest error:", err);
        UI.showNotification(err.message || "Rewrite failed.");
      } finally {
        btnRewriteLatest.disabled = false;
        btnRewriteLatest.textContent = "✨ REWRITE LATEST";
      }
    });
  }

  // 🔄 REWRITE ALL ENTRIES (Sequential 1-by-1 with 1.5s delay)
  if (btnRewriteAll) {
    btnRewriteAll.addEventListener("click", async () => {
      const entries = DB.getPrivateEntries();
      if (!entries || entries.length === 0) {
        UI.showNotification("No entries available to rewrite.");
        return;
      }

      const confirmed = await UI.showConfirm(`Rewrite all ${entries.length} entry reflections using your current persona dial? Each entry will process sequentially.`);
      if (!confirmed) return;

      const settings = DB.getSettings();
      settings.systemInstruction = settingsSystemInstruction.value.trim();
      settings.apiKey = settingsApiKey.value.trim();
      settings.model = settingsModel.value;
      DB.saveSettings(settings);
      await DB.saveCloudSettings(settings);

      btnRewriteAll.disabled = true;
      if (btnRewriteLatest) btnRewriteLatest.disabled = true;

      let successCount = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        btnRewriteAll.textContent = `🔄 REWRITING ${i + 1}/${entries.length}...`;
        
        try {
          const rewritten = await AIEngine.rewrite(entry.rawContent);
          await DB.saveEntry(entry, entry.rawContent, rewritten);
          successCount++;
          renderTimeline();
        } catch (err) {
          console.warn(`Failed to rewrite entry ${entry.id}:`, err);
        }

        if (i < entries.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      btnRewriteAll.disabled = false;
      if (btnRewriteLatest) btnRewriteLatest.disabled = false;
      btnRewriteAll.textContent = "🔄 REWRITE ALL";

      UI.showNotification(`Completed: ${successCount} of ${entries.length} reflections updated with new persona!`);
    });
  }

  // Log out button action
  btnSignOut.addEventListener("click", async () => {
    if (auth) {
      await window.Firebase.signOut(auth);
    } else {
      reminisceUnlocked = false;
      sessionStorage.removeItem("ej_reminisce_unlocked");
      applyModeUI();
      renderTimeline();
    }
    modalSettings.style.display = "none";
  });

  // Open Settings Modal (only accessible when unlocked)
  btnSettings.addEventListener("click", () => {
    if (reminisceUnlocked) {
      loadSettingsIntoForm();
      modalSettings.style.display = "flex";
    }
  });

  // Close Settings Modal
  btnCloseSettings.addEventListener("click", () => {
    modalSettings.style.display = "none";
  });

  // Settings form submit (Save prompt template)
  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const settings = DB.getSettings();
    
    settings.systemInstruction = settingsSystemInstruction.value.trim();
    settings.apiKey = settingsApiKey.value.trim();
    settings.model = settingsModel.value;
    if (settingsPsychModel) {
      settings.psychModel = settingsPsychModel.value;
    }
    if (settingsRetryDelay) {
      settings.annotationRetryDelay = Math.max(5, parseInt(settingsRetryDelay.value || 20, 10));
    }

    DB.saveSettings(settings);
    await DB.saveCloudSettings(settings);
    
    modalSettings.style.display = "none";
    UI.showNotification("Configurations successfully updated.");
  });

  // Export Journal Backup (.json)
  if (btnExportBackup) {
    btnExportBackup.addEventListener("click", () => {
      DB.exportBackupJson();
      UI.showNotification("Journal backup downloaded successfully.");
    });
  }

  // Import / Restore Journal Backup (.json)
  if (btnImportBackupTrigger && backupFileInput) {
    btnImportBackupTrigger.addEventListener("click", () => {
      backupFileInput.value = "";
      backupFileInput.click();
    });

    backupFileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const confirmed = await UI.showConfirm(`Restore entries from "${file.name}"? This will safely merge all entries from the backup into your journal.`);
      if (!confirmed) return;

      try {
        const count = await DB.importBackupJson(file);
        renderTimeline();
        UI.showNotification(`Restored ${count} reflections from backup!`);
      } catch (err) {
        console.error("Backup restoration failed:", err);
        UI.showAlert(`Could not restore backup file.\n\nReason: ${err.message}`, "RESTORE FAILED");
      }
    });
  }

  // Discard / Delete specific note
  async function deletePsychAnnotation(entryId, noteId) {
    const privateEntries = DB.getPrivateEntries();
    const entry = privateEntries.find(e => e.id === entryId);
    if (!entry || !entry.psychAnnotations) return;

    entry.psychAnnotations = entry.psychAnnotations.filter(n => n.id !== noteId);
    await DB.saveEntry(entry);
    PsychEngine.updateCardDOM(entry);
    UI.showNotification("Note discarded.");
  }

  // Toggle Annotations View Button (Pure Visibility Toggle - Zero Tokens)
  if (btnToggleAnnotations) {
    btnToggleAnnotations.addEventListener("click", () => {
      const isShown = document.body.classList.toggle("show-annotations");
      btnToggleAnnotations.classList.toggle("active", isShown);
      localStorage.setItem("ej_show_annotations", isShown ? "true" : "false");
      if (isShown) {
        UI.showNotification("Notes displayed.");
      } else {
        UI.showNotification("Notes hidden.");
      }
    });
  }

  // Modal Elements for Annotate Options & Delete All Annotations
  const modalAnnotateOptions = document.getElementById("modal-annotate-options");
  const btnCloseAnnotateOptions = document.getElementById("btn-close-annotate-options");
  const btnCancelAnnotateOptions = document.getElementById("btn-cancel-annotate-options");
  const btnAnnotateNext = document.getElementById("btn-annotate-next");
  const btnAnnotateAll = document.getElementById("btn-annotate-all");

  const btnDeleteAllAnnotations = document.getElementById("btn-delete-all-annotations");
  const modalDeleteAnnotations = document.getElementById("modal-delete-annotations");
  const btnCloseDeleteAnnotations = document.getElementById("btn-close-delete-annotations");
  const btnCancelDeleteAnnotations = document.getElementById("btn-cancel-delete-annotations");
  const inputConfirmDeleteAnnotations = document.getElementById("input-confirm-delete-annotations");
  const btnExecuteDeleteAnnotations = document.getElementById("btn-execute-delete-annotations");

  // Open Annotate Choice Dialog (Next / All / Cancel)
  if (btnSyncAnnotations && modalAnnotateOptions) {
    btnSyncAnnotations.addEventListener("click", () => {
      if (PsychEngine.isSyncing) return;
      modalAnnotateOptions.style.display = "flex";
    });
  }

  if (btnCloseAnnotateOptions) {
    btnCloseAnnotateOptions.addEventListener("click", () => {
      modalAnnotateOptions.style.display = "none";
    });
  }
  if (btnCancelAnnotateOptions) {
    btnCancelAnnotateOptions.addEventListener("click", () => {
      modalAnnotateOptions.style.display = "none";
    });
  }

  // Annotate Next (Single Oldest Unannotated Entry)
  if (btnAnnotateNext) {
    btnAnnotateNext.addEventListener("click", async () => {
      modalAnnotateOptions.style.display = "none";
      await PsychEngine.annotateNext();
    });
  }

  // Annotate All (Chronological Batch)
  if (btnAnnotateAll) {
    btnAnnotateAll.addEventListener("click", async () => {
      modalAnnotateOptions.style.display = "none";
      if (PsychEngine.isSyncing) return;
      
      UI.showNotification("Reviewing timeline reflections...");
      if (btnSyncAnnotations) {
        btnSyncAnnotations.classList.add("active");
        btnSyncAnnotations.disabled = true;
      }

      if (!document.body.classList.contains("show-annotations")) {
        document.body.classList.add("show-annotations");
        if (btnToggleAnnotations) btnToggleAnnotations.classList.add("active");
        localStorage.setItem("ej_show_annotations", "true");
      }

      try {
        await PsychEngine.autoSync();
        UI.showNotification("Annotations up to date!");
      } catch (err) {
        console.error("Sync error:", err);
      } finally {
        if (btnSyncAnnotations) {
          btnSyncAnnotations.classList.remove("active");
          btnSyncAnnotations.disabled = false;
        }
      }
    });
  }

  // Open Delete All Annotations Confirmation Modal
  if (btnDeleteAllAnnotations && modalDeleteAnnotations) {
    btnDeleteAllAnnotations.addEventListener("click", () => {
      inputConfirmDeleteAnnotations.value = "";
      btnExecuteDeleteAnnotations.disabled = true;
      modalDeleteAnnotations.style.display = "flex";
      setTimeout(() => inputConfirmDeleteAnnotations.focus(), 100);
    });
  }

  if (btnCloseDeleteAnnotations) {
    btnCloseDeleteAnnotations.addEventListener("click", () => {
      modalDeleteAnnotations.style.display = "none";
    });
  }
  if (btnCancelDeleteAnnotations) {
    btnCancelDeleteAnnotations.addEventListener("click", () => {
      modalDeleteAnnotations.style.display = "none";
    });
  }

  // Require typing exact confirmation text: "delete all annotations"
  if (inputConfirmDeleteAnnotations && btnExecuteDeleteAnnotations) {
    inputConfirmDeleteAnnotations.addEventListener("input", () => {
      const isMatch = inputConfirmDeleteAnnotations.value.trim().toLowerCase() === "delete all annotations";
      btnExecuteDeleteAnnotations.disabled = !isMatch;
    });
  }

  // Execute Deletion of All Annotations across all entries
  if (btnExecuteDeleteAnnotations) {
    btnExecuteDeleteAnnotations.addEventListener("click", async () => {
      btnExecuteDeleteAnnotations.disabled = true;
      btnExecuteDeleteAnnotations.textContent = "DELETING...";

      try {
        const privateEntries = DB.getPrivateEntries();
        for (const entry of privateEntries) {
          entry.psychAnnotations = [];
          await DB.saveEntry(entry, entry.rawContent, entry.victorianContent, true);
        }

        modalDeleteAnnotations.style.display = "none";
        modalSettings.style.display = "none";
        renderTimeline();
        UI.showNotification("All annotations have been deleted.");
      } catch (err) {
        console.error("Delete all annotations failed:", err);
        UI.showAlert("Failed to delete annotations: " + err.message, "DELETE ERROR");
      } finally {
        btnExecuteDeleteAnnotations.disabled = false;
        btnExecuteDeleteAnnotations.textContent = "DELETE ALL";
      }
    });
  }

  // Event delegation for discarding individual psychologist notes
  document.addEventListener("click", (e) => {
    const deleteBtn = e.target.closest(".btn-delete-note");
    if (deleteBtn && reminisceUnlocked) {
      e.stopPropagation();
      const entryId = deleteBtn.dataset.entryId;
      const noteId = deleteBtn.dataset.noteId;
      if (entryId && noteId) {
        deletePsychAnnotation(entryId, noteId);
      }
    }
  });

  function setupEventListeners() {}

  init();
});
