const DEFAULT_SYSTEM_INSTRUCTION = `You are a refined gentlewoman from the late 19th century writing in her private journal.
Your task is to rewrite the modern journal entry provided below in your own voice.

Follow these strict rules to ensure a natural, elegant, and accurate rewrite:
1. Tone & Style: Write with the understated grace, poise, and intelligence of a 19th-century gentlewoman. Avoid "purple prose," forced archaic words, and flowery caricatures. Think of the natural, clear, and dignified style of Jane Austen or George Eliot—not an exaggerated melodrama.
2. No Information Loss: You must preserve all original facts, events, and meanings. Do not invent fluff or omit details.
3. Modern Terminology: When rewriting modern concepts (such as websites, web applications, hosting, coding, or databases), do not invent awkward or misleading literal translations (like "digital system" for a web app). Instead, describe the core action naturally in standard, elegant English (e.g., "publishing my digital work for the world to see," "creating a ledger," or "refining my manuscript scripts") or straight up use the correct modern terminology if the meaning is hard to convey. Keep the meaning clear and grounded.

Output ONLY the rewritten prose. Do not include any introductions, headers, or meta comments.`;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.5-flash",
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION
};

// Mask secrets at database compilation level (Inspect Element Sniff-Proof)
function maskSecrets(text) {
  if (!text) return "";
  return text.replace(/\|\|(.*?)\|\|/g, (match, p1) => {
    return `||${"█".repeat(p1.length)}||`;
  });
}

// Database Module (localStorage & Firestore Cloud Sync)
let db = null; 
let auth = null; 
let ownerEmail = ""; // Configured in firebase_config.json
const DB = {
  getSettings() {
    const settingsRaw = localStorage.getItem("ej_settings");
    return settingsRaw ? { ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw) } : DEFAULT_SETTINGS;
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
    entries.sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));
    localStorage.setItem("ej_entries_public", JSON.stringify(entries));
  },

  // Private Cache (for Reminisce Mode offline cache)
  getPrivateEntries() {
    const entries = localStorage.getItem("ej_entries_private");
    return entries ? JSON.parse(entries) : [];
  },
  savePrivateEntries(entries) {
    entries.sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));
    localStorage.setItem("ej_entries_private", JSON.stringify(entries));
  },

  async saveEntry(entry, rawContent, victorianContent) {
    const publicContent = maskSecrets(victorianContent);
    const now = new Date().toISOString();

    // 1. Create Public Schema
    const publicEntry = {
      id: entry.id,
      date: entry.date || now,
      publicContent: publicContent,
      createdAt: entry.createdAt || now,
      updatedAt: now
    };

    // 2. Create Private Schema
    const privateEntry = {
      id: entry.id,
      date: entry.date || now,
      rawContent: rawContent,
      victorianContent: victorianContent,
      createdAt: entry.createdAt || now,
      updatedAt: now
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
      const colRef = window.Firebase.collection(db, "natalie_journal_public_entries");
      const querySnapshot = await window.Firebase.getDocs(colRef);
      const cloudEntries = [];
      querySnapshot.forEach(doc => {
        cloudEntries.push(doc.data());
      });
      if (cloudEntries.length > 0) {
        this.savePublicEntries(cloudEntries);
        return cloudEntries;
      }
    } catch (err) {
      console.error("Public cloud fetch failed, using offline cache:", err);
    }
    return null;
  },

  async fetchPrivateCloudEntries() {
    if (!db || !auth || !auth.currentUser) return null;
    try {
      const colRef = window.Firebase.collection(db, "natalie_journal_private_entries");
      const querySnapshot = await window.Firebase.getDocs(colRef);
      const cloudEntries = [];
      querySnapshot.forEach(doc => {
        cloudEntries.push(doc.data());
      });
      if (cloudEntries.length > 0) {
        this.savePrivateEntries(cloudEntries);
        return cloudEntries;
      }
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
    const escaped = this.escapeHtml(text);
    return escaped.replace(/\|\|(.*?)\|\|/g, '<span class="redacted-text" title="Hover to reveal secret">$1</span>')
                  .replace(/\n/g, '<br>');
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

// AI Engine
const AIEngine = {
  async rewrite(rawContent) {
    const settings = DB.getSettings();
    if (!settings.apiKey) {
      throw new Error("API Key Missing: Configure your Gemini API Key in your private Firestore settings.");
    }

    const model = settings.model || "gemini-3.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;

    const requestPayload = {
      contents: [
        {
          parts: [
            { text: rawContent }
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
    const rawTextResponse = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawTextResponse) {
      throw new Error("Empty response received from Gemini.");
    }

    return rawTextResponse.trim();
  }
};

// App Controller
document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const btnUnlock = document.getElementById("btn-unlock");
  const btnSettings = document.getElementById("btn-settings");
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

  // Floating Context Redact
  const btnFloatingRedact = document.getElementById("btn-floating-redact");

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
          // If logged in with wrong email, sign out instantly
          await window.Firebase.signOut(auth);
          reminisceUnlocked = false;
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
      btnSettings.style.display = "flex";
    } else {
      document.body.classList.add("gander-mode");
      btnUnlock.style.display = "flex";
      btnSettings.style.display = "none";
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

  // Open Composition Box
  btnRecordNew.addEventListener("click", () => {
    if (!reminisceUnlocked) return;

    newEntryRow.style.display = "grid";
    newTextarea.value = "";
    newTextarea.focus();
    
    window.getSelection().removeAllRanges();
    hideFloatingRedact();

    initTextareaAutoResize(newTextarea);
    
    const parts = Renderer.getDateParts(new Date());
    newDateDay.textContent = parts.monthDay;
    newDateYear.textContent = parts.year;

    newEntryRow.scrollIntoView({ behavior: "smooth" });
  });

  // Cancel Composing slot
  btnNewCancel.addEventListener("click", () => {
    newEntryRow.style.display = "none";
    newTextarea.value = "";
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

    try {
      const rewritten = await AIEngine.rewrite(rawContent);
      const newId = "ej-" + Date.now();
      
      const newEntryObj = {
        id: newId,
        date: new Date().toISOString()
      };

      await DB.saveEntry(newEntryObj, rawContent, rewritten);
      
      newTextarea.value = "";
      newCardLoading.style.display = "none";
      newEntryRow.style.display = "none";
      
      isTranscribing = false;
      btnNewDone.disabled = false;
      btnNewCancel.disabled = false;

      renderTimeline();
    } catch (e) {
      UI.showNotification(e.message || "Transcription failed.");
      isTranscribing = false;
      btnNewDone.disabled = false;
      btnNewCancel.disabled = false;
      newCardLoading.style.display = "none";
    }
  });

  // Text selection listener for Victorian view-mode redactions
  function handleTextSelection(e) {
    if (!reminisceUnlocked) return;

    const selection = window.getSelection();
    const selectedText = selection.toString().trim();

    if (!selectedText) {
      hideFloatingRedact();
      return;
    }

    const victorianBody = e.target.closest(".card-body-text.victorian");
    if (!victorianBody) {
      hideFloatingRedact();
      return;
    }

    const row = e.target.closest(".timeline-row");
    if (!row) {
      hideFloatingRedact();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    activeSelection = {
      cardId: row.dataset.id,
      text: selectedText
    };

    btnFloatingRedact.style.left = `${rect.left + window.scrollX + (rect.width / 2) - 60}px`;
    btnFloatingRedact.style.top = `${rect.top + window.scrollY - 35}px`;
    btnFloatingRedact.style.display = "block";
  }

  function hideFloatingRedact() {
    btnFloatingRedact.style.display = "none";
    activeSelection = null;
  }

  // Redact mousedown
  btnFloatingRedact.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!activeSelection || !reminisceUnlocked) return;

    const { cardId, text } = activeSelection;
    const entry = DB.getPrivateEntries().find(e => e.id === cardId);
    
    if (entry && entry.victorianContent.includes(text)) {
      entry.victorianContent = entry.victorianContent.replace(text, `||${text}||`);
      await DB.saveEntry(entry, entry.rawContent, entry.victorianContent);
      renderTimeline();
    } else {
      UI.showNotification("Highlighted text mismatch. Try again.");
    }

    window.getSelection().removeAllRanges();
    hideFloatingRedact();
  });

  // Timeline events delegation (clicks)
  timelineFeed.addEventListener("click", async (e) => {
    const row = e.target.closest(".timeline-row");
    if (!row) return;

    const id = row.dataset.id;
    const viewState = row.querySelector(".card-view-state");
    const editState = row.querySelector(".card-edit-state");
    const loadingState = row.querySelector(".card-edit-loading");

    const deleteBtn = e.target.closest(".btn-card-delete");
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
        isTranscribing = true;
        doneBtn.disabled = true;
        cancelBtn.disabled = true;
        loadingState.style.display = "flex";

        try {
          const rewritten = await AIEngine.rewrite(updatedValue);
          await DB.saveEntry(entry, updatedValue, rewritten);
          
          isTranscribing = false;
          loadingState.style.display = "none";
          renderTimeline();
        } catch(err) {
          UI.showNotification(err.message || "Rewrite failed.");
          isTranscribing = false;
          doneBtn.disabled = false;
          cancelBtn.disabled = false;
          loadingState.style.display = "none";
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

  // Double click existing entry card to edit it
  timelineFeed.addEventListener("dblclick", (e) => {
    if (!reminisceUnlocked) return;

    const row = e.target.closest(".timeline-row");
    if (!row) return;

    if (e.target.closest(".entry-card-header") || e.target.closest(".entry-card-footer") ||
        row.querySelector(".card-edit-state").style.display === "block") return;

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
    textarea.value = entry ? entry.rawContent : "";
    delete editState.dataset.tempRaw;

    viewState.style.display = "none";
    editState.style.display = "block";
    textarea.focus();

    initTextareaAutoResize(textarea);
  });

  // Highlight selection listeners
  document.addEventListener("mouseup", handleTextSelection);
  document.addEventListener("keyup", handleTextSelection);

  // Close context dropdowns when clicking outside
  window.addEventListener("click", (e) => {
    if (!e.target.matches(".btn-more")) {
      document.querySelectorAll(".context-menu").forEach(m => m.classList.remove("active"));
    }
  });

  // Prominent Unlock Button Click (Triggers Google Auth popup directly)
  btnUnlock.addEventListener("click", async () => {
    if (auth) {
      try {
        const provider = new window.Firebase.GoogleAuthProvider();
        await window.Firebase.signInWithPopup(auth, provider);
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
