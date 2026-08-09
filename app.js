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
  model: "gemini-3.5-flash",
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION
};

// Mask secrets at database compilation level (Inspect Element Sniff-Proof)
function maskSecrets(text) {
  if (!text) return "";
  return text.replace(/\|\|(.*?)\|\|/g, (match, p1) => {
    const masked = p1.replace(/\S/g, "█");
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
      // Auto-upgrade saved prompt if it still uses the old melodramatic gentlewoman version
      if (!parsed.systemInstruction || parsed.systemInstruction.includes("refined gentlewoman") || parsed.systemInstruction.includes("Jane Austen")) {
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
  
  // Public Cache (for Gander Mode offline / public feed fallback)
  getPublicEntries() {
    const entries = localStorage.getItem("ej_entries_public");
    return entries ? JSON.parse(entries) : [];
  },
  savePublicEntries(entries) {
    // Sort NEWEST FIRST (descending date order) using safeParseDate
    entries.sort((a, b) => safeParseDate(b.date || b.createdAt || b.updatedAt) - safeParseDate(a.date || a.createdAt || a.updatedAt));
    localStorage.setItem("ej_entries_public", JSON.stringify(entries));
  },

  // Private Cache (for Reminisce Mode offline cache)
  getPrivateEntries() {
    const entries = localStorage.getItem("ej_entries_private");
    return entries ? JSON.parse(entries) : [];
  },
  savePrivateEntries(entries) {
    // Sort NEWEST FIRST (descending date order) using safeParseDate
    entries.sort((a, b) => safeParseDate(b.date || b.createdAt || b.updatedAt) - safeParseDate(a.date || a.createdAt || a.updatedAt));
    localStorage.setItem("ej_entries_private", JSON.stringify(entries));
  },

  async saveEntry(entry, rawContent, victorianContent, preserveUpdatedAt = false) {
    // Resolve short img-xxx IDs to full Base64 URLs before writing to DB
    const resolveImages = (text) => {
      if (!text) return "";
      return text.replace(/!\[([\s\S]*?)\]\((img-[^)]+|data:image\/[^)]+|https?:\/\/[^)]+)\)/g, (match, altText, urlOrId) => {
        const fullUrl = (urlOrId.startsWith("img-") && tempImageStore[urlOrId]) ? tempImageStore[urlOrId] : urlOrId;
        const cleanAlt = altText || "attached-image";
        return `![${cleanAlt}](${fullUrl})`;
      });
    };

    let fullRawContent = resolveImages(rawContent);
    let fullVictorianContent = resolveImages(victorianContent);

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

  async fetchPublicCloudEntries() {
    if (!db) return null;
    try {
      const collectionsToScan = ["natalie_journal_public_entries", "public_entries"];
      const localEntries = this.getPublicEntries();
      const entryMap = new Map();
      localEntries.forEach(e => { if (e && e.id) entryMap.set(e.id, e); });

      for (const colName of collectionsToScan) {
        try {
          const colRef = window.Firebase.collection(db, colName);
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
        } catch(e) {}
      }

      const mergedEntries = Array.from(entryMap.values());
      this.savePublicEntries(mergedEntries);
      return mergedEntries;
    } catch (err) {
      console.error("Public cloud fetch failed, using offline cache:", err);
    }
    return null;
  },

  async fetchPrivateCloudEntries() {
    if (!db || !auth || !auth.currentUser) return null;
    try {
      const collectionsToScan = [
        "natalie_journal_private_entries",
        "natalies_journal_entries",
        "private_entries",
        "entries"
      ];
      
      const localEntries = this.getPrivateEntries();
      const entryMap = new Map();
      localEntries.forEach(e => { if (e && e.id) entryMap.set(e.id, e); });

      for (const colName of collectionsToScan) {
        try {
          const colRef = window.Firebase.collection(db, colName);
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
        } catch(e) {}
      }

      const mergedEntries = Array.from(entryMap.values());
      this.savePrivateEntries(mergedEntries);
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

    // Extract image markdown tags OR raw data:image Base64 strings OR short img-xxx IDs
    const images = [];

    // Pass 1: Markdown image syntax ![alt|w=320px](url) or ![alt](url)
    let cleanText = text.replace(/!\[([\s\S]*?)\]\(\s*(data:image\/[^\s)]+|img-[^\s)]+|https?:\/\/[^\s)]+)\s*\)/gi, (match, altText, dataUrl) => {
      const actualUrl = (dataUrl.startsWith("img-") && tempImageStore[dataUrl]) ? tempImageStore[dataUrl] : dataUrl;
      if (actualUrl && !actualUrl.startsWith("img-")) {
        let widthStyle = "";
        const wMatch = altText.match(/w=(\d+px|\d+%)/i) || altText.match(/(\d+px|\d+%);?/i);
        if (wMatch) {
          widthStyle = `width: ${wMatch[1]};`;
        }
        images.push({ dataUrl: actualUrl, widthStyle });
        return `___IMG_PLACEHOLDER_${images.length - 1}___`;
      }
      return "";
    });

    // Pass 2: Raw unparsed data:image Base64 URLs
    cleanText = cleanText.replace(/(data:image\/[a-zA-Z0-9\/+;=,-]+)/gi, (match, dataUrl) => {
      images.push({ dataUrl, widthStyle: "" });
      return `___IMG_PLACEHOLDER_${images.length - 1}___`;
    });

    let escaped = this.escapeHtml(cleanText);
    escaped = escaped.replace(/\|\|(.*?)\|\|/g, (match, secret) => {
      const attrSecret = secret.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      return `<span class="redacted-text" data-secret="${attrSecret}" title="Click to unredact secret">${secret}</span>`;
    })
    .replace(/\n/g, '<br>');

    // Restore images wrapped in interactive resizable container (controls shown only when unlocked)
    images.forEach(({ dataUrl, widthStyle }, idx) => {
      const styleAttr = widthStyle ? `style="${widthStyle}"` : '';
      const controlsHtml = reminisceUnlocked ? `
        <div class="img-resize-bar" title="Quick size presets">
          <button type="button" class="btn-img-size" data-size="280px">280px</button>
          <button type="button" class="btn-img-size" data-size="450px">450px</button>
          <button type="button" class="btn-img-size" data-size="100%">100%</button>
        </div>
        <div class="img-resize-handle" title="Drag corner to resize image">⇲</div>
      ` : '';

      const imgTag = `<div class="journal-img-container" data-img-idx="${idx}">${controlsHtml}<img class="journal-entry-img" ${styleAttr} src="${dataUrl.trim()}" alt="Journal entry attachment" loading="lazy" /></div>`;
      escaped = escaped.replace(`___IMG_PLACEHOLDER_${idx}___`, imgTag);
    });

    // Strip adjacent <br> tags surrounding block image containers
    escaped = escaped.replace(/(<br>\s*)+<div class="journal-img-container"/g, '<div class="journal-img-container"');
    escaped = escaped.replace(/<div class="journal-img-container"([^>]*)\/>(\s*<br>)+/g, '<div class="journal-img-container"$1/>');

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

    const model = settings.model || "gemini-3.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;

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
          { text: settings.systemInstruction }
        ]
      }
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
      throw new Error(`Gemini API Error: ${errMsg}`);
    }

    const responseData = await response.json();
    let rawTextResponse = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawTextResponse) {
      throw new Error("Empty response received from Gemini.");
    }

    let rewritten = rawTextResponse.trim();

    // Substitute image tokens back to their original position in the Victorian response
    imageTokens.forEach(({ token, fullMatch }) => {
      if (rewritten.includes(token)) {
        rewritten = rewritten.replace(token, fullMatch);
      } else {
        // Fallback safety: append image if token was omitted by model
        rewritten += `\n\n${fullMatch}`;
      }
    });

    return rewritten;
  }
};

// App Controller
document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const btnUnlock = document.getElementById("btn-unlock");
  const btnHeaderAdd = document.getElementById("btn-header-add");
  const btnSettings = document.getElementById("btn-settings");
  const btnHeaderLogout = document.getElementById("btn-header-logout");
  const headerLogoutGroup = document.getElementById("header-logout-group");
  const welcomeState = document.getElementById("welcome-state");
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
  const settingsSystemInstruction = document.getElementById("settings-system-instruction");
  const btnResetSettings = document.getElementById("btn-reset-settings");
  const btnSignOut = document.getElementById("btn-sign-out");

  // States
  let activeSelection = null;
  let activeUnredactTarget = null;
  let isTranscribing = false;
  let reminisceUnlocked = false;

  // Premium temporary snackbar helper
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

  // Initialize
  async function init() {
    await DB.initFirebase();
    
    // Auto login session verification
    if (auth) {
      window.Firebase.onAuthStateChanged(auth, async (user) => {
        if (user && ownerEmail && user.email === ownerEmail) {
          reminisceUnlocked = true;
          await DB.fetchCloudSettings();
          await DB.fetchPrivateCloudEntries();
        } else if (user) {
          // If logged in with wrong email, sign out instantly and notify
          await window.Firebase.signOut(auth);
          reminisceUnlocked = false;
          UI.showNotification("Access denied: Only the journal owner can unlock.");
        } else {
          reminisceUnlocked = false;
        }
        applyModeUI();
        renderTimeline();
      });
    } else {
      // Offline mode fallback using sessionStorage
      reminisceUnlocked = sessionStorage.getItem("ej_reminisce_unlocked") === "true";
      applyModeUI();
      renderTimeline();
    }

    await DB.fetchPublicCloudEntries();
    loadSettingsIntoForm();
    renderTimeline();
    setupEventListeners();
  }



  // Toggle UI layouts based on modes
  function applyModeUI() {
    if (reminisceUnlocked) {
      document.body.classList.remove("gander-mode");
      btnUnlock.style.display = "none";
      if (btnHeaderAdd) btnHeaderAdd.style.display = "inline-flex";
      btnSettings.style.display = "flex";
      if (headerLogoutGroup) headerLogoutGroup.style.display = "flex";
    } else {
      document.body.classList.add("gander-mode");
      btnUnlock.style.display = "flex";
      if (btnHeaderAdd) btnHeaderAdd.style.display = "none";
      btnSettings.style.display = "none";
      if (headerLogoutGroup) headerLogoutGroup.style.display = "none";
    }
  }

  // Load Settings
  function loadSettingsIntoForm() {
    const settings = DB.getSettings();
    settingsSystemInstruction.value = settings.systemInstruction;
    settingsApiKey.value = settings.apiKey || "";
    settingsModel.value = settings.model || "gemini-3.5-flash";
  }

  // Render list of entries
  function renderTimeline() {
    const entries = reminisceUnlocked ? DB.getPrivateEntries() : DB.getPublicEntries();
    
    if (entries.length === 0) {
      welcomeState.style.display = "block";
      timelineFeed.innerHTML = "";
    } else {
      welcomeState.style.display = "none";
      timelineFeed.innerHTML = "";

      entries.forEach((entry) => {
        const row = document.createElement("div");
        row.className = "timeline-row";
        row.dataset.id = entry.id;

        const dateParts = Renderer.getDateParts(entry.date || entry.createdAt);
        const formattedTime = Renderer.formatTime(entry.date || entry.createdAt);
        const formattedEdited = Renderer.formatFullDateTime(entry.updatedAt);

        const renderText = reminisceUnlocked ? entry.victorianContent : entry.publicContent;
        const editRawVal = reminisceUnlocked ? (entry.rawContent || "") : "";
        
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
              <div class="entry-card-footer">
                <span>Edited ${formattedEdited}</span>
              </div>
            </div>

            <!-- EDIT STATE -->
            <div class="card-edit-state" style="display: none;" data-mode="raw">
              <div class="edit-card">
                <div class="edit-mode-toggle">
                  <button type="button" class="btn-toggle-edit active" data-mode="raw">RAW TEXT</button>
                  <button type="button" class="btn-toggle-edit" data-mode="rewrite">REWRITE</button>
                </div>
                <div class="edit-label">JOURNAL ENTRY</div>
                <textarea class="edit-textarea card-edit-textarea" placeholder="enter your recollections">${editRawVal}</textarea>
                
                <!-- Card Inner Loader -->
                <div class="card-loading card-edit-loading" style="display: none;">
                  <span class="loading-text">Transcribing entry...</span>
                  <div class="loading-bar"></div>
                </div>

                <div class="edit-actions">
                  <button type="button" class="btn-text btn-card-image-upload" data-id="${entry.id}">🖼️ IMAGE</button>
                  <button class="btn-text btn-card-edit-cancel" data-id="${entry.id}">CANCEL</button>
                  <button class="btn-pill btn-card-edit-done active" data-id="${entry.id}">DONE</button>
                </div>
              </div>
            </div>
          </div>
        `;
        
        timelineFeed.appendChild(row);
      });
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

  // Redact action handler
  const performRedaction = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!activeSelection || !reminisceUnlocked) return;

    const { cardId, text } = activeSelection;
    const entry = DB.getPrivateEntries().find(e => e.id === cardId);
    
    if (entry && entry.victorianContent.includes(text)) {
      entry.victorianContent = entry.victorianContent.replace(text, `||${text}||`);
      await DB.saveEntry(entry, entry.rawContent, entry.victorianContent, true);
      renderTimeline();
      UI.showNotification("Secret redacted.");
    } else {
      UI.showNotification("Highlighted text mismatch. Try again.");
    }

    window.getSelection().removeAllRanges();
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
      const targetPattern = `||${secretText}||`;
      if (entry.victorianContent.includes(targetPattern)) {
        entry.victorianContent = entry.victorianContent.replace(targetPattern, secretText);
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

    editState.dataset.mode = "raw";
    editState.querySelectorAll(".btn-toggle-edit").forEach(btn => btn.classList.remove("active"));
    editState.querySelector('.btn-toggle-edit[data-mode="raw"]').classList.add("active");
    editState.querySelector(".edit-label").textContent = "JOURNAL ENTRY";

    let initialText = entry ? entry.rawContent : "";
    initialText = initialText.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, (match, dataUrl) => {
      const imgId = "img-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
      tempImageStore[imgId] = dataUrl;
      return `![attached-image](${imgId})`;
    });

    textarea.value = initialText;
    delete editState.dataset.tempRaw;

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

  // Handle Quick Size Preset Button Clicks
  timelineFeed.addEventListener("click", async (e) => {
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

    DB.saveSettings(settings);
    await DB.saveCloudSettings(settings);
    
    modalSettings.style.display = "none";
    UI.showNotification("Configurations successfully updated.");
  });

  btnResetSettings.addEventListener("click", async () => {
    const confirmed = await UI.showConfirm("Reset instructions template to default?");
    if (confirmed) {
      settingsSystemInstruction.value = DEFAULT_SYSTEM_INSTRUCTION;
    }
  });

  function setupEventListeners() {}

  init();
});
