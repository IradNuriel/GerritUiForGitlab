/**
 * Entry point injected on GitLab Merge Request pages.
 * Mounts the toggleable PolyGerrit overlay without breaking native GitLab.
 */
(() => {
  const ctx = window.GitLabApiClient.detectMrContext();
  if (!ctx) return;

  // Verify this is actually a GitLab page (avoid false triggers on non-GitLab sites)
  const isGitLab =
    !!document.querySelector('meta[content*="GitLab"]') ||
    !!document.querySelector('body[data-page*="merge_requests"]') ||
    !!document.querySelector('.merge-request-details, .detail-page-header, #js-merge-request-app, .navbar-gitlab, .super-sidebar');

  if (!isGitLab) return;

  let overlayEl = null;
  let fabEl = null;
  let app = null;
  let gerritActive = false;

  const defaultSettings = {
    autoEnable: true,
    pat: '',
    theme: 'dark'
  };

  function getSettings() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) return resolve(defaultSettings);
      chrome.storage.sync.get(defaultSettings, (items) => resolve({ ...defaultSettings, ...items }));
    });
  }

  function createFloatingToggle() {
    if (fabEl) return;
    fabEl = document.createElement('button');
    fabEl.id = 'gr-gitlab-fab';
    fabEl.className = 'gr-fab';
    fabEl.title = 'Switch to Gerrit Review Interface (Shift+G)';
    fabEl.innerHTML = `<span class="gr-fab-badge">G</span> Gerrit View`;
    fabEl.addEventListener('click', () => enableGerritView());
    document.body.appendChild(fabEl);
  }

  async function enableGerritView() {
    if (gerritActive) return;
    gerritActive = true;
    const settings = await getSettings();

    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'gr-gerrit-overlay';
      document.body.appendChild(overlayEl);
    }

    overlayEl.style.display = 'block';
    document.documentElement.classList.add('gr-overlay-active');
    if (fabEl) fabEl.style.display = 'none';

    if (!app) {
      const client = new window.GitLabApiClient.Client(ctx, settings.pat);
      app = new window.GerritUIRenderer.GerritApp(overlayEl, client, settings, () => disableGerritView());
      app.init();
    }
  }

  function disableGerritView() {
    gerritActive = false;
    if (overlayEl) overlayEl.style.display = 'none';
    document.documentElement.classList.remove('gr-overlay-active');
    if (fabEl) fabEl.style.display = 'inline-flex';
  }

  // Global Shift+G toggle
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
    if (e.shiftKey && e.key === 'G' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (gerritActive) disableGerritView();
      else enableGerritView();
    }
  });

  // Listen for popup messages (e.g., toggle or reload after PAT change)
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'TOGGLE_GERRIT_VIEW') {
        if (gerritActive) disableGerritView();
        else enableGerritView();
      } else if (msg?.type === 'RELOAD_GERRIT_SETTINGS') {
        if (app) {
          app.destroy();
          app = null;
        }
        if (gerritActive) {
          gerritActive = false;
          enableGerritView();
        }
      }
    });
  }

  // Boot
  createFloatingToggle();
  getSettings().then((settings) => {
    if (settings.autoEnable) {
      enableGerritView();
    }
  });
})();
