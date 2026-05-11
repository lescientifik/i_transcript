import { updateRecorderUI } from './audio.js';
import { state } from './state.js';
import { refreshCostStrip, refreshPromptRowVisibility, refreshSelectedLabel } from './transcription.js';
import { dom, openDrawer, refreshShortcutsUI, renderResultsLayout } from './ui.js';

/* ============================================================ *
 * INIT
 * ============================================================ */
function init() {
  // Apply state to UI
  dom.langSelect.value = state.lang;
  dom.promptText.value = state.defaultPrompt;
  refreshSelectedLabel();
  refreshPromptRowVisibility();
  refreshCostStrip();
  renderResultsLayout();
  refreshShortcutsUI();
  updateRecorderUI();

  // Open settings on first run if no API keys
  if (!state.apiKeys.openrouter && !state.apiKeys.mistral) {
    setTimeout(openDrawer, 300);
  }
}
init();

