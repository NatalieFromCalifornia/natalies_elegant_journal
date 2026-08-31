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
    localStorage.setItem("ej_entries_public", JSON.stringify(entries));
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
    localStorage.setItem("ej_entries_private", JSON.stringify(entries));
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

    // Synchronize attached images & custom width tags from raw content to victorian content
    if (fullRawContent) {
      const rawImageMatches = fullRawContent.match(/!\[([\s\S]*?)\]\((data:image\/[^)]+|img-[^)]+|https?:\/\/[^)]+)\)/gi);
      if (rawImageMatches) {
        rawImageMatches.forEach((imgTag) => {
          const urlMatch = imgTag.match(/\(([^)]+)\)/);
          const altMatch = imgTag.match(/!\[([\s\S]*?)\]/);
          const urlOrId = urlMatch ? urlMatch[1].trim() : "";
          const rawAltText = altMatch ? altMatch[1].trim() : "attached-image";
          if (urlOrId) {
            if (fullVictorianContent.includes(urlOrId)) {
              // Safely replace alt text in fullVictorianContent using string index search (NO new RegExp!)
              const targetSub = `(${urlOrId})`;
              const targetIdx = fullVictorianContent.indexOf(targetSub);
              if (targetIdx !== -1) {
                const startIdx = fullVictorianContent.lastIndexOf("![", targetIdx);
                if (startIdx !== -1) {
                  const before = fullVictorianContent.slice(0, startIdx);
                  const after = fullVictorianContent.slice(targetIdx + targetSub.length);
                  fullVictorianContent = `${before}![${rawAltText}]${targetSub}${after}`;
                }
              }
            } else {
              fullVictorianContent = (fullVictorianContent ? fullVictorianContent.trim() + "\n\n" : "") + imgTag;
            }
          }
        });
      }
    }

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
          if (!existing || safeParseDate(data.updatedAt || data.date || data.createdAt) >= safeParseDate(existing.updatedAt || existing.date || existing.createdAt)) {
            entryMap.set(docId, data);
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
              entryMap.set(docId, data);
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
          if (!existing || safeParseDate(data.updatedAt || data.date || data.createdAt) >= safeParseDate(existing.updatedAt || existing.date || existing.createdAt)) {
            entryMap.set(docId, data);
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
  async rewrite(rawContent) {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      throw new Error("API Key Missing: Configure your Gemini API Key in your private Firestore settings.");
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || response.statusText;
      console.warn("Gemini API Error, falling back to raw text:", errMsg);
      return rawContent;
    }

    const responseData = await response.json();
    const candidate = responseData.candidates?.[0];
    let rawTextResponse = candidate?.content?.parts?.[0]?.text;
    
    // If Gemini model refused/blocked transcription (e.g. finishReason SAFETY or empty text), fallback directly to rawContent
    if (!rawTextResponse) {
      console.warn("Gemini candidate response was empty or blocked by safety filter. finishReason:", candidate?.finishReason);
      return rawContent;
    }

    let rewritten = rawTextResponse.trim();

    // Therapy & Conversational Preach Filter: Detect if AI broke character into unsolicited therapy advice or AI meta-commentary
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
      // Fallback cleanly to author's raw content
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

    const PSYCH_SYSTEM_PROMPT = `You are an esteemed documentary psychologist and psychoanalyst providing clinical commentary and case notes on the private journal entries of Natalie.
You are observing Natalie over time as a subject of interest in an engrossing longitudinal study.
Your role is that of a documentary commentator (like Oliver Sacks or a BBC documentary expert) analyzing her internal conflicts, emotional subtext, coping mechanisms, social boundaries, personal ambitions, and behavioral evolution across time.

CRITICAL GUIDELINES:
1. Refer to her naturally as Natalie (or using pronouns she/her). Never use weird clinical aliases like "Subject N", "Subject 01", or "The Diarist".
2. Speak in the third person as an expert analyst ("Natalie demonstrates a fascinating tension...", "Her instinct here reveals...").
3. NEVER give direct advice or therapy ("Natalie should...", "I suggest she talk to..."). Instead, analyze what is happening psychologically.
4. Build upon prior case notes and emotional patterns established in earlier entries, observing how her thoughts, defenses, and relationships evolve chronologically across time.
5. Strictly AVOID mentioning, critiquing, or referencing any Victorian prose style or tonal writing. Focus entirely on her real thoughts, feelings, relationships, and human experiences.
6. Write concise, profound, captivating commentary (2 to 4 sentences).`;

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

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error?.message || response.statusText || `HTTP ${response.status}`;
        console.error(`PsychEngine API Error (${currentModel}):`, errMsg);

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
      console.error(`PsychEngine network error with ${currentModel}:`, e);
      if (typeof UI !== "undefined" && UI.showAlert) {
        UI.showAlert(`Network failure connecting to Gemini model "${currentModel}".\n\n${e.message}`, "CONNECTION ERROR");
      }
      return null;
    }
  },

  async autoSync() {
    if (this.isSyncing || !reminisceUnlocked) return;
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      UI.showNotification("Please set your Gemini API Key in MENU first.");
      return;
    }

    this.isSyncing = true;
    try {
      const privateEntries = DB.getPrivateEntries();
      if (!privateEntries || privateEntries.length === 0) return;

      // Find entries that have no annotations yet
      const missing = privateEntries.filter(e => !e.psychAnnotations || e.psychAnnotations.length === 0);

      // STRICT: Process from OLDEST to NEWEST so longitudinal context builds sequentially
      missing.sort((a, b) => new Date(a.date || a.createdAt || 0) - new Date(b.date || b.createdAt || 0));

      for (const entry of missing) {
        if (!reminisceUnlocked) break;
        this.activeJobs.add(entry.id);
        this.updateCardLoading(entry.id, true);

        // Fetch fresh private entries array on each iteration so previously generated notes are included in context
        const currentPrivateEntries = DB.getPrivateEntries();
        const noteText = await this.generateNote(entry, currentPrivateEntries);
        this.activeJobs.delete(entry.id);

        if (noteText) {
          const newNote = {
            id: "obs-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toISOString(),
            tag: "ANNOTATION",
            note: noteText
          };

          const currentPrivate = DB.getPrivateEntries();
          const target = currentPrivate.find(e => e.id === entry.id);
          if (target) {
            if (!target.psychAnnotations) target.psychAnnotations = [];
            target.psychAnnotations.push(newNote);
            await DB.saveEntry(target);
            this.updateCardDOM(target);
          }
        } else {
          this.updateCardLoading(entry.id, false);
          // Stop batch loop on error so user can address the alert
          break;
        }

        // Pacing delay between entries
        await new Promise(r => setTimeout(r, 1500));
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

  updateCardLoading(entryId, isLoading) {
    const row = document.querySelector(`.timeline-row[data-id="${entryId}"]`);
    if (!row) return;
    const panel = row.querySelector(".entry-annotation-panel");
    if (!panel) return;
    let pulse = panel.querySelector(".psych-loading-pulse");
    if (isLoading) {
      if (!pulse) {
        pulse = document.createElement("div");
        pulse.className = "psych-loading-pulse";
        pulse.innerHTML = `<span class="pulse-star">✦</span><span>Annotating reflection...</span>`;
        panel.appendChild(pulse);
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
  const btnResetSettings = document.getElementById("btn-reset-settings");
  const btnSignOut = document.getElementById("btn-sign-out");

  // States
  let activeSelection = null;
  let activeUnredactTarget = null;
  let isTranscribing = false;

  // Initialize
  async function init() {
    // 0. INSTANT LOCAL HYDRATION (0ms - Render cached feed immediately so page never waits on network)
    reminisceUnlocked = sessionStorage.getItem("ej_reminisce_unlocked") === "true";
    applyModeUI();
    renderTimeline();

    await DB.initFirebase();
    
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

  // Render list of entries progressively (newest first, instant first entry render)
  function renderTimeline() {
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

    // Clear timeline feed
    timelineFeed.innerHTML = "";

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
      const isDirectText = entry.isRawFallback || (hasContent && entry.rawContent.trim() === entry.victorianContent.trim());
      const directBadgeHtml = (reminisceUnlocked && isDirectText) ? `<span class="raw-text-badge" title="Direct raw reflection (untranscribed)">✦ DIRECT TEXT</span>` : "";

      const annotationPanelHtml = reminisceUnlocked ? `
        <div class="entry-annotation-panel">
          ${PsychEngine.renderPanelContent(entry)}
        </div>
      ` : "";

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
            <div class="entry-body card-body-text victorian">${Renderer.render(renderText)}</div>
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

    // Step 0: Render first (newest) entry immediately so user sees content instantly!
    const firstEntry = entries[0];
    timelineFeed.appendChild(createRowElement(firstEntry));

    // Step 1+: Stream remaining entries in non-blocking 16ms micro-batches
    if (entries.length > 1) {
      let index = 1;
      const batchSize = 3;

      function renderNextBatch() {
        if (currentToken !== renderToken) return;
        const end = Math.min(index + batchSize, entries.length);
        const fragment = document.createDocumentFragment();
        for (let i = index; i < end; i++) {
          fragment.appendChild(createRowElement(entries[i]));
        }
        timelineFeed.appendChild(fragment);
        index = end;
        if (index < entries.length) {
          setTimeout(renderNextBatch, 16);
        }
      }
      setTimeout(renderNextBatch, 16);
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

    let rewritten = rawContent;
    try {
      rewritten = await AIEngine.rewrite(rawContent);
    } catch (e) {
      console.warn("AI rewrite fallback to direct text:", e);
    }

    try {
      const newId = "ej-" + Date.now();
      const newEntryObj = {
        id: newId,
        date: new Date().toISOString()
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
      UI.showNotification("New reflection recorded.");
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
        renderTimeline();
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

      const textarea = editState.querySelector(".card-edit-textarea");
      const updatedValue = textarea.value.trim();
      const activeMode = editState.dataset.mode;

      if (!updatedValue) {
        UI.showNotification("The reflection cannot be empty.");
        return;
      }

      const entry = DB.getPrivateEntries().find(e => e.id === id);

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
          renderTimeline();
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
          renderTimeline();
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
        const rawContent = editState.dataset.tempRaw || entry.rawContent;
        await DB.saveEntry(entry, rawContent, updatedValue);
        
        editState.style.display = "none";
        viewState.style.display = "block";
        
        const node = row.querySelector(".timeline-node-container div");
        node.className = "timeline-node";
        
        renderTimeline();
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
    node.className = "dashed-node";

    window.getSelection().removeAllRanges();
    hideFloatingRedact();

    const entry = DB.getPrivateEntries().find(e => e.id === row.dataset.id);

    editState.dataset.mode = "rewrite";
    editState.querySelectorAll(".btn-toggle-edit").forEach(btn => btn.classList.remove("active"));
    editState.querySelector('.btn-toggle-edit[data-mode="rewrite"]').classList.add("active");
    editState.querySelector(".edit-label").textContent = "JOURNAL REWRITE";

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

    DB.saveSettings(settings);
    await DB.saveCloudSettings(settings);
    
    modalSettings.style.display = "none";
    UI.showNotification("Configurations successfully updated.");
  });

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

  // Explicit Sync Button for Annotations (Token-Safe Manual Trigger)
  if (btnSyncAnnotations) {
    btnSyncAnnotations.addEventListener("click", async () => {
      if (PsychEngine.isSyncing) return;
      UI.showNotification("Reviewing timeline reflections...");
      btnSyncAnnotations.classList.add("active");
      btnSyncAnnotations.disabled = true;

      // Automatically show annotations column if currently hidden
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
        btnSyncAnnotations.classList.remove("active");
        btnSyncAnnotations.disabled = false;
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
